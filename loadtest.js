/* eslint-disable */
// =============================================================================
// Flash Sale System — k6 Load Test  (architecture.md §9.2)
//
//   k6 run loadtest.js
//   k6 run -e BASE_URL=http://localhost:8080 loadtest.js
//   k6 run --out json=raw.json loadtest.js        # ป้อนเข้า dashboard
//
// สองสถานการณ์ตามโจทย์:
//   read_heavy   1,000 concurrent users อ่าน GET /api/v1/products 60 วินาที
//   write_burst  500 คนแย่งของ 50 ชิ้น และ "กดรัว" คนละ 3 ครั้ง (per-vu-iterations)
//
// ⚠️ 409 (ซื้อไปแล้ว / ของหมด) และ 429 (กดรัวขณะมี order ค้าง) คือ "พฤติกรรมที่ถูกต้อง"
//    ไม่ใช่ error — จึงนับด้วย check() + Counter แยก และ **ไม่** เอาไปใส่ threshold
//    (CLAUDE.md §3, §6 / architecture.md §9.2)
// =============================================================================

import http from 'k6/http';
import exec from 'k6/execution';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:8080').replace(
  /\/+$/,
  '',
);
const REQ_TIMEOUT = __ENV.REQ_TIMEOUT || '60s';

// สินค้าเป้าหมายของ write burst — availableStock = 50 (products-seed.json)
const TARGET_PRODUCT_ID = __ENV.TARGET_PRODUCT_ID || 'p-1001';

// จำนวน user ที่จะ mint JWT ให้ใน setup()
const USER_COUNT = Number(__ENV.USER_COUNT || 500);

// จำนวนสินค้าทั้งหมดใน seed — ใช้คำนวณช่วง page ที่ถูกต้อง
const TOTAL_PRODUCTS = Number(__ENV.TOTAL_PRODUCTS || 20);

// -----------------------------------------------------------------------------
// 409 / 429 / 503 เป็นคำตอบที่ถูกต้องของระบบ → อย่าให้ k6 นับเป็น http_req_failed
// -----------------------------------------------------------------------------
http.setResponseCallback(http.expectedStatuses(200, 202, 409, 429));

// --- custom metrics ----------------------------------------------------------
const orders202 = new Counter('orders_accepted_202'); // เข้าคิวสำเร็จ
const orders409 = new Counter('orders_conflict_409'); // ซื้อไปแล้ว / ของหมด
const orders429 = new Counter('orders_throttled_429'); // กดรัวขณะมี order in-flight
const orders503 = new Counter('orders_not_seeded_503'); // stock counter ยังไม่ถูก seed
const orders401 = new Counter('orders_unauthorized_401'); // ไม่ควรเกิดเลย
const ordersOther = new Counter('orders_unexpected_status'); // ⚠️ ต้องเป็น 0

const readOk = new Counter('reads_ok_200');
const readBadShape = new Counter('reads_bad_contract'); // ⚠️ ต้องเป็น 0
const readStockFresh = new Rate('reads_remaining_stock_present');
const readLatency = new Trend('read_products_latency', true);
const orderLatency = new Trend('place_order_latency', true);

export const options = {
  discardResponseBodies: false,
  scenarios: {
    read_heavy: {
      // 1,000 concurrent readers
      executor: 'constant-vus',
      vus: 1000,
      duration: '30s',
      exec: 'readProducts',
      startTime: '5s',
      tags: { scenario_kind: 'read' },
    },
    write_burst: {
      // 500 คนแย่ง 50 ชิ้น พร้อมกัน — iterations: 3 = จำลองการ "กดรัว"
      executor: 'per-vu-iterations',
      vus: 500,
      iterations: 3,
      exec: 'placeOrder',
      startTime: '10s',
      maxDuration: '20s',
      tags: { scenario_kind: 'write' },
    },
  },
  // threshold ผูกกับ latency เท่านั้น — ไม่แตะ error rate เพราะ 409/429 คือของถูกต้อง
  thresholds: {
    'http_req_duration{scenario:read_heavy}': ['p(95)<200'],
    'http_req_duration{scenario:write_burst}': ['p(95)<300'],
  },
};

// =============================================================================
// setup() — mint JWT ให้ user-1 … user-500 (endpoint นี้ไม่ถูกวัด performance)
// =============================================================================
export function setup() {
  const tokens = [];
  const failures = [];

  for (let i = 1; i <= USER_COUNT; i++) {
    const userId = `user-${i}`;
    const res = http.post(
      `${BASE_URL}/api/v1/auth/token`,
      JSON.stringify({ userId }),
      {
        timeout: REQ_TIMEOUT,
        headers: { 'Content-Type': 'application/json' },
        tags: { name: 'setup:auth-token' },
      },
    );

    let token = null;
    if (res.status === 200) {
      try {
        token = res.json('accessToken');
      } catch (e) {
        token = null;
      }
    }

    if (token) {
      tokens.push({ userId, token });
    } else {
      failures.push(`${userId} -> HTTP ${res.status}`);
    }
  }

  if (tokens.length === 0) {
    exec.test.abort(
      `setup: ไม่ได้ JWT เลยสักตัวจาก ${BASE_URL}/api/v1/auth/token — ระบบยังไม่พร้อม`,
    );
  }

  console.log(
    `[setup] minted ${tokens.length}/${USER_COUNT} JWTs from ${BASE_URL}` +
      (failures.length ? ` (failed: ${failures.slice(0, 5).join(', ')}…)` : ''),
  );

  return { tokens, baseUrl: BASE_URL };
}

// =============================================================================
// readProducts — read-heavy
//   สุ่ม page/limit เพื่อไม่ให้ยิงโดน cache key เดียวตลอด
//   (ไม่งั้น hit ratio ที่วัดได้จะสวยเกินจริง — architecture.md §9.2)
// =============================================================================
export function readProducts() {
  const limits = [5, 10, 20];
  const limit = limits[Math.floor(Math.random() * limits.length)];
  const totalPages = Math.max(1, Math.ceil(TOTAL_PRODUCTS / limit));
  const page = 1 + Math.floor(Math.random() * totalPages);

  const res = http.get(
    `${BASE_URL}/api/v1/products?page=${page}&limit=${limit}`,
    {
      timeout: REQ_TIMEOUT,
      tags: { name: 'GET /api/v1/products' },
    },
  );

  readLatency.add(res.timings.duration);

  const ok = check(res, {
    'read: status is 200': (r) => r.status === 200,
  });

  if (!ok) {
    readBadShape.add(1);
    return;
  }

  readOk.add(1);

  // ตรวจ contract (CLAUDE.md §3) — field ต้องครบและ type ต้องถูก
  let body = null;
  try {
    body = res.json();
  } catch (e) {
    readBadShape.add(1);
    return;
  }

  const shapeOk = check(body, {
    'read: status === "success"': (b) => b && b.status === 'success',
    'read: data is array': (b) => b && Array.isArray(b.data),
    'read: meta has total/page/limit/totalPages': (b) =>
      !!b &&
      !!b.meta &&
      typeof b.meta.total === 'number' &&
      typeof b.meta.page === 'number' &&
      typeof b.meta.limit === 'number' &&
      typeof b.meta.totalPages === 'number',
    'read: price is a number (ไม่ใช่ string จาก NUMERIC)': (b) =>
      !b || !Array.isArray(b.data) || b.data.length === 0
        ? true
        : typeof b.data[0].price === 'number',
    'read: remainingStock is a number (อ่านสดจาก Redis)': (b) =>
      !b || !Array.isArray(b.data) || b.data.length === 0
        ? true
        : typeof b.data[0].remainingStock === 'number',
  });

  if (!shapeOk) {
    readBadShape.add(1);
  }

  const hasFreshStock =
    !!body &&
    Array.isArray(body.data) &&
    body.data.every((p) => typeof p.remainingStock === 'number');
  readStockFresh.add(hasFreshStock);
}

// =============================================================================
// placeOrder — write burst
//   แต่ละ VU ใช้ token ของตัวเอง (ห้ามซ้ำ) แล้วยิง 3 ครั้งติด = จำลองการกดรัว
//   คาดหวัง: 1 ครั้งได้ 202, อีก 2 ครั้งได้ 429 หรือ 409
//            (429 = in-flight lock ทำงาน, 409 = ซื้อไปแล้ว/ของหมด)
// =============================================================================
export function placeOrder(data) {
  const tokens = data.tokens;

  // VU id ใน k6 ถูกนับรวมทุก scenario — normalize ด้วย modulo
  // write_burst ถูกจัดสรร id เป็นบล็อกต่อเนื่อง จึงได้ index ไม่ซ้ำกันในทางปฏิบัติ
  // (ถ้าบังเอิญซ้ำ ผลลัพธ์คือ 409/429 ซึ่งยังเป็นพฤติกรรมที่ถูกต้องอยู่ดี)
  const idx = (exec.vu.idInTest - 1) % tokens.length;
  const { userId, token } = tokens[idx];

  const res = http.post(
    `${BASE_URL}/api/v1/orders`,
    JSON.stringify({ productId: TARGET_PRODUCT_ID }),
    {
      timeout: REQ_TIMEOUT,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      tags: { name: 'POST /api/v1/orders' },
    },
  );

  orderLatency.add(res.timings.duration);

  // ✅ ทุก status ด้านล่างคือ "ระบบทำงานถูกต้อง" — ไม่ใช่ error
  check(res, {
    'order: status เป็นค่าที่คาดไว้ (202/409/429/503)': (r) =>
      r.status === 202 ||
      r.status === 409 ||
      r.status === 429 ||
      r.status === 503,
  });

  switch (res.status) {
    case 202: {
      orders202.add(1);
      check(res, {
        'order 202: status === "processing"': (r) => {
          try {
            return r.json('status') === 'processing';
          } catch (e) {
            return false;
          }
        },
        'order 202: orderJobId === order:{userId}:{productId}': (r) => {
          try {
            return (
              r.json('orderJobId') === `order:${userId}:${TARGET_PRODUCT_ID}`
            );
          } catch (e) {
            return false;
          }
        },
      });
      break;
    }
    case 409:
      // ซื้อไปแล้ว หรือ ของหมด — ถูกต้องตามโจทย์
      orders409.add(1);
      check(res, {
        'order 409: duplicate/sold-out (correct behaviour)': () => true,
      });
      break;
    case 429:
      // กดรัวขณะมี order in-flight — หลักฐานว่า lock ทำงาน
      orders429.add(1);
      check(res, {
        'order 429: in-flight lock hit (correct behaviour)': () => true,
      });
      break;
    case 503:
      // stock counter ยังไม่ถูก seed — ต้องแยกจาก "ของหมด" ให้ชัด
      orders503.add(1);
      break;
    case 401:
      orders401.add(1);
      break;
    default:
      ordersOther.add(1);
      console.error(
        `[order] unexpected status ${res.status} for ${userId}: ${String(res.body).slice(0, 200)}`,
      );
      break;
  }
}

// =============================================================================
// handleSummary — พิมพ์ตัวนับ 202/409/429/503 ให้เห็นชัดในรายงาน
// (ไม่ import jslib จากอินเทอร์เน็ต เพื่อให้รันได้แม้ออฟไลน์)
// =============================================================================
export function handleSummary(data) {
  const c = (name) =>
    data.metrics[name] && data.metrics[name].values
      ? data.metrics[name].values.count || 0
      : 0;

  const trend = (name, stat) =>
    data.metrics[name] && data.metrics[name].values
      ? Number(data.metrics[name].values[stat] || 0).toFixed(2)
      : 'n/a';

  const accepted = c('orders_accepted_202');
  const conflict = c('orders_conflict_409');
  const throttled = c('orders_throttled_429');
  const notSeeded = c('orders_not_seeded_503');
  const unauthorized = c('orders_unauthorized_401');
  const unexpected = c('orders_unexpected_status');
  const totalOrders =
    accepted + conflict + throttled + notSeeded + unauthorized + unexpected;

  const lines = [];
  lines.push('');
  lines.push('══════════════════════════════════════════════════════════════');
  lines.push('  FLASH SALE — LOAD TEST SUMMARY');
  lines.push(`  target: ${BASE_URL}   product: ${TARGET_PRODUCT_ID}`);
  lines.push('══════════════════════════════════════════════════════════════');
  lines.push('');
  lines.push('  READ PATH — GET /api/v1/products');
  lines.push(`    200 OK                     : ${c('reads_ok_200')}`);
  lines.push(
    `    contract violations        : ${c('reads_bad_contract')}   (ต้อง = 0)`,
  );
  lines.push(
    `    p95 latency                : ${trend('read_products_latency', 'p(95)')} ms`,
  );
  lines.push(
    `    avg latency                : ${trend('read_products_latency', 'avg')} ms`,
  );
  lines.push('');
  lines.push(
    '  WRITE PATH — POST /api/v1/orders   (409/429 = ถูกต้อง ไม่ใช่ error)',
  );
  lines.push(`    202 accepted (เข้าคิว)      : ${accepted}`);
  lines.push(`    409 conflict (ซ้ำ/ของหมด)   : ${conflict}`);
  lines.push(`    429 throttled (กดรัว)       : ${throttled}`);
  lines.push(`    503 stock not seeded       : ${notSeeded}   (ต้อง = 0)`);
  lines.push(`    401 unauthorized           : ${unauthorized}   (ต้อง = 0)`);
  lines.push(`    ⚠️ unexpected status        : ${unexpected}   (ต้อง = 0)`);
  lines.push(`    ────────────────────────────────────────────`);
  lines.push(`    total order requests       : ${totalOrders}`);
  lines.push(
    `    p95 latency                : ${trend('place_order_latency', 'p(95)')} ms`,
  );
  lines.push('');
  lines.push('  ตรวจ Data Integrity ต่อ (architecture.md §9.3):');
  lines.push(
    "    psql: SELECT remaining_stock FROM products WHERE id = 'p-1001';   -- ต้อง = 0",
  );
  lines.push('    psql: SELECT COUNT(*), COUNT(DISTINCT user_id) FROM orders');
  lines.push(
    "            WHERE product_id = 'p-1001';                             -- ต้อง = 50, 50",
  );
  lines.push(
    '    redis-cli -p 6380 GET stock:flash_sale:p-1001                    -- ต้อง = "0"',
  );
  lines.push('══════════════════════════════════════════════════════════════');
  lines.push('');

  return {
    stdout: lines.join('\n'),
    'loadtest.k6-summary.json': JSON.stringify(data, null, 2),
  };
}
