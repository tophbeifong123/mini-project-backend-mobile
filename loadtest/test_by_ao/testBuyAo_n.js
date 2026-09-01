/* eslint-disable */
// =============================================================================
// Flash Sale System — k6 Load Test  (architecture.md §9.2)
//
//   k6 run loadtest.js
//   k6 run -e BASE_URL=http://localhost:8080 loadtest.js
//   k6 run --out json=raw.json loadtest.js        # ป้อนเข้า dashboard
//
// สองสถานการณ์ตามโจทย์:
//   read_heavy   1,000 concurrent users อ่าน GET /api/v1/products 30 วินาที
//   write_burst  500 คนแย่งของ 50 ชิ้น และ "กดรัว" คนละ 3 ครั้ง (per-vu-iterations)
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

const READ_VUS = integerEnv('READ_VUS', 1_000, 1, 10_000);
const READ_DURATION = __ENV.READ_DURATION || '30s';
const WRITE_VUS = integerEnv('WRITE_VUS', 500, 1, 5_000);
const WRITE_ITERATIONS = integerEnv('WRITE_ITERATIONS', 3, 1, 100);
const WRITE_START_TIME = __ENV.WRITE_START_TIME || '10s';
const WRITE_MAX_DURATION = __ENV.WRITE_MAX_DURATION || '20s';

// k6 จอง VU IDs ร่วมกันระหว่าง scenarios และ IDs ของ write scenario
// อาจมีช่องว่าง จึง mint token ครอบคลุม VU ID domain ทั้งสอง scenarios
// แล้ว map idInTest โดยตรง ห้าม modulo เพราะทำให้สอง write VUs ใช้ user ซ้ำได้
const VU_ID_DOMAIN = READ_VUS + WRITE_VUS;
const USER_COUNT = integerEnv('USER_COUNT', VU_ID_DOMAIN, VU_ID_DOMAIN, 15_000);

// จำนวนสินค้าทั้งหมดใน seed — ใช้คำนวณช่วง page ที่ถูกต้อง
const TOTAL_PRODUCTS = integerEnv('TOTAL_PRODUCTS', 20, 1, 100_000);

// -----------------------------------------------------------------------------
// 200/202/409 เป็น healthy HTTP outcomes ของ workload นี้
// 503 อยู่ใน API contract แต่ยังเป็น availability failure จึงต้องคงเป็น
// http_req_failed และมี custom infrastructure metric แยกต่างหาก
// -----------------------------------------------------------------------------
http.setResponseCallback(http.expectedStatuses(200, 202, 409));

// --- custom metrics ----------------------------------------------------------
const authSetupCount = new Counter('auth_setup_count');
const authSetupFailures = new Counter('auth_setup_failures');
const authSetupRequestDuration = new Trend('auth_setup_request_duration', true);
const authSetupWallDuration = new Trend('auth_setup_wall_duration', true);

const orderRequests = new Counter('orders_requests');
const orders202 = new Counter('orders_202'); // เข้าคิวสำเร็จ
const orders409 = new Counter('orders_409'); // admission race ที่ contract อนุญาต
const orders503 = new Counter('orders_503'); // contract-valid แต่ availability fail
const orders5xx = new Counter('orders_5xx');
const orders401 = new Counter('orders_unauthorized_401'); // ไม่ควรเกิดเลย
const ordersOther = new Counter('orders_unexpected'); // ⚠️ ต้องเป็น 0
const orderContractValid = new Rate('orders_contract_valid');
const orderSuccessfulAdmission = new Rate('orders_successful_admission');
const orderInfrastructureError = new Rate('orders_infrastructure_error');

const readOk = new Counter('reads_ok_200');
const readBadShape = new Counter('reads_bad_contract'); // ⚠️ ต้องเป็น 0
const readStockFresh = new Rate('reads_remaining_stock_present');
const readLatency = new Trend('read_products_latency', true);
const orderLatency = new Trend('place_order_latency', true);

function integerEnv(name, fallback, minimum, maximum) {
  const raw = __ENV[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function contractOrderStatus(status) {
  return [202, 400, 401, 404, 409, 422, 500, 503].includes(status);
}

function infrastructureFailure(status) {
  return status === 0 || status >= 500;
}

export const options = {
  discardResponseBodies: false,
  scenarios: {
    read_heavy: {
      // 1,000 concurrent readers
      executor: 'constant-vus',
      vus: READ_VUS,
      duration: READ_DURATION,
      exec: 'readProducts',
      startTime: '5s',
      tags: { scenario_kind: 'read' },
    },
    write_burst: {
      // 500 คนแย่ง 50 ชิ้น พร้อมกัน — iterations: 3 = จำลองการ "กดรัว"
      executor: 'per-vu-iterations',
      vus: WRITE_VUS,
      iterations: WRITE_ITERATIONS,
      exec: 'placeOrder',
      startTime: WRITE_START_TIME,
      maxDuration: WRITE_MAX_DURATION,
      tags: { scenario_kind: 'write' },
    },
  },
  // คง threshold เดิมเพื่อให้ default workload reproduce พฤติกรรมเดิมได้
  thresholds: {
    'http_req_duration{scenario:read_heavy}': ['p(95)<200'],
    'http_req_duration{scenario:write_burst}': ['p(95)<300'],
  },
};

// =============================================================================
// setup() — mint JWT ครอบคลุม VU ID domain (endpoint นี้ไม่ถูกวัด performance)
// =============================================================================
export function setup() {
  const setupStartedAt = Date.now();
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

    authSetupCount.add(1);
    authSetupRequestDuration.add(res.timings.duration);

    let token = null;
    if (res.status === 200) {
      try {
        token = res.json('accessToken');
      } catch (e) {
        token = null;
      }
    }

    if (token) {
      tokens[i - 1] = { userId, token };
    } else {
      authSetupFailures.add(1);
      tokens[i - 1] = null;
      failures.push(`${userId} -> HTTP ${res.status}`);
    }
  }

  authSetupWallDuration.add(Date.now() - setupStartedAt);

  if (failures.length > 0) {
    exec.test.abort(
      `setup: minted ${tokens.length - failures.length}/${USER_COUNT} JWTs; ` +
        `refusing a partial identity set (${failures.slice(0, 5).join(', ')})`,
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
//   คาดหวังหลัก: 202 ที่ยืนยัน enqueue; 409 ใช้เฉพาะ claim visibility race
// =============================================================================
export function placeOrder(data) {
  const tokens = data.tokens;

  // VU id ถูกนับรวมทุก scenario; direct mapping รักษาหลัก
  // one write VU = one unique user และทำให้ iterations ถัดไปของ VU เดิมใช้ user เดิม
  const idx = exec.vu.idInTest - 1;
  if (idx < 0 || idx >= tokens.length) {
    exec.test.abort(
      `write VU id ${exec.vu.idInTest} exceeds prepared token domain ${tokens.length}`,
    );
  }
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
  orderRequests.add(1);

  const isContractStatus = contractOrderStatus(res.status);
  const isInfrastructureFailure = infrastructureFailure(res.status);
  orderContractValid.add(isContractStatus);
  orderSuccessfulAdmission.add(res.status === 202);
  orderInfrastructureError.add(isInfrastructureFailure);
  if (res.status >= 500) {
    orders5xx.add(1);
  }

  check(res, {
    'order: status exists in frozen API contract': () => isContractStatus,
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
        'order 202: orderJobId matches ord-<sha256>': (r) => {
          try {
            return /^ord-[a-f0-9]{64}$/.test(r.json('orderJobId'));
          } catch (e) {
            return false;
          }
        },
      });
      break;
    }
    case 409:
      // Claim มีอยู่แต่ยังยืนยันว่า BullMQ Job ถูกสร้างแล้วไม่ได้
      orders409.add(1);
      check(res, {
        'order 409: admission-in-progress contract response': () => true,
      });
      break;
    case 503:
      // Contract-valid QUEUE_UNAVAILABLE แต่เป็น availability failure ของ benchmark
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
// handleSummary — แยก contract validity ออกจาก availability health
// (ไม่ import jslib จากอินเทอร์เน็ต เพื่อให้รันได้แม้ออฟไลน์)
// =============================================================================
export function handleSummary(data) {
  const summaryPath = __ENV.SUMMARY_PATH || 'loadtest.k6-summary.json';
  const c = (name) =>
    data.metrics[name] && data.metrics[name].values
      ? data.metrics[name].values.count || 0
      : 0;

  const trend = (name, stat) =>
    data.metrics[name] && data.metrics[name].values
      ? Number(data.metrics[name].values[stat] || 0).toFixed(2)
      : 'n/a';

  const rate = (name) =>
    data.metrics[name] && data.metrics[name].values
      ? `${(Number(data.metrics[name].values.rate || 0) * 100).toFixed(2)}%`
      : 'n/a';

  const accepted = c('orders_202');
  const conflict = c('orders_409');
  const unavailable = c('orders_503');
  const serverErrors = c('orders_5xx');
  const unauthorized = c('orders_unauthorized_401');
  const unexpected = c('orders_unexpected');
  const totalOrders = c('orders_requests');

  const lines = [];
  lines.push('');
  lines.push('══════════════════════════════════════════════════════════════');
  lines.push('  FLASH SALE — LOAD TEST SUMMARY');
  lines.push(`  target: ${BASE_URL}   product: ${TARGET_PRODUCT_ID}`);
  lines.push('══════════════════════════════════════════════════════════════');
  lines.push('');
  lines.push('  AUTH SETUP');
  lines.push(`    requests                    : ${c('auth_setup_count')}`);
  lines.push(
    `    failures                    : ${c('auth_setup_failures')}   (ต้อง = 0)`,
  );
  lines.push(
    `    request p95                : ${trend('auth_setup_request_duration', 'p(95)')} ms`,
  );
  lines.push(
    `    total wall duration        : ${trend('auth_setup_wall_duration', 'max')} ms`,
  );
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
  lines.push('  WRITE PATH — POST /api/v1/orders');
  lines.push(`    202 accepted (เข้าคิว)      : ${accepted}`);
  lines.push(`    409 admission in progress  : ${conflict}`);
  lines.push(
    `    503 queue unavailable      : ${unavailable}   (availability fail)`,
  );
  lines.push(`    all 5xx                    : ${serverErrors}   (ต้อง = 0)`);
  lines.push(`    401 unauthorized           : ${unauthorized}   (ต้อง = 0)`);
  lines.push(`    ⚠️ unexpected status        : ${unexpected}   (ต้อง = 0)`);
  lines.push(`    ────────────────────────────────────────────`);
  lines.push(`    total order requests       : ${totalOrders}`);
  lines.push(
    `    contract-valid rate        : ${rate('orders_contract_valid')}`,
  );
  lines.push(
    `    successful-admission rate  : ${rate('orders_successful_admission')}`,
  );
  lines.push(
    `    infrastructure-error rate  : ${rate('orders_infrastructure_error')}`,
  );
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

  const sanitized = { ...data };
  delete sanitized.setup_data;

  return {
    stdout: lines.join('\n'),
    [summaryPath]: JSON.stringify(sanitized, null, 2),
  };
}
