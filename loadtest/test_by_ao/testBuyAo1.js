import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const REQ_TIMEOUT = __ENV.REQ_TIMEOUT || '30s';

// สินค้าเป้าหมาย — stock จำกัด 50 ชิ้นตามโจทย์
const TARGET_PRODUCT_ID = __ENV.TARGET_PRODUCT_ID || 'p-1001';

// จำนวนสินค้าทั้งหมดใน seed (ใช้คำนวณ page ของ read load แบบสุ่ม)
const TOTAL_PRODUCTS = Number(__ENV.TOTAL_PRODUCTS || 20);

// --- ข้อ 1: Preparation Phase --------------------------------------------
// จำนวนผู้ใช้ไม่ซ้ำที่ต้อง mint JWT (user-1 ถึง user-TOTAL_USERS)
const TOTAL_USERS = Number(__ENV.TOTAL_USERS || 500);

// --- ข้อ 2: Read Load ------------------------------------------------------
const READ_CONCURRENT_USERS = Number(__ENV.READ_CONCURRENT_USERS || 1000);
const READ_DURATION = __ENV.READ_DURATION || '30s';

// --- ข้อ 3: Write Load -----------------------------------------------------
const WRITE_CONCURRENT_REQUESTS = Number(__ENV.WRITE_CONCURRENT_REQUESTS || 500);

// สัดส่วน user ที่ "ยิงเบิ้ล" พร้อมกัน (ทดสอบกันสิทธิ์ซ้ำซ้อน) เช่น 0.1 = 10%
// ของ WRITE_CONCURRENT_REQUESTS คน จะยิงมากกว่า 1 request ในจังหวะเดียวกัน
const DOUBLE_SUBMIT_RATE = Number(__ENV.DOUBLE_SUBMIT_RATE || 0.1);

// user ที่โดนสุ่มเป็น "ตัวเบิ้ล" จะยิงกี่ครั้งพร้อมกัน (โจทย์ระบุ 2-3 ครั้ง)
const DOUBLE_SUBMIT_MIN = 2;
const DOUBLE_SUBMIT_MAX = 3;

// --- ชื่อ response header ที่ backend ใช้บอกสถานะ cache (ปรับตามที่ทีมใช้จริง) ---
const CACHE_HEADER_NAME = (__ENV.CACHE_HEADER_NAME || 'x-cache-status').toLowerCase();
const CACHE_HIT_VALUE = (__ENV.CACHE_HIT_VALUE || 'HIT').toUpperCase();
const CACHE_MISS_VALUE = (__ENV.CACHE_MISS_VALUE || 'MISS').toUpperCase();

http.setResponseCallback(
  http.expectedStatuses(200, 201, 202, 400, 401, 403, 404, 409, 422, 429, 500, 503),
);

// =============================================================================
// custom metrics
// =============================================================================
// --- Read / Cache ---
const readOk = new Counter('read_ok_200');
const readFailed = new Counter('read_failed');
const readLatency = new Trend('read_products_latency', true);
const cacheHit = new Counter('cache_hit');
const cacheMiss = new Counter('cache_miss');
const cacheUnknown = new Counter('cache_status_unknown'); // header ไม่มี/อ่านไม่ได้

// --- Write / "Queue" (ประมาณจาก HTTP status ที่ backend ตอบกลับ) ---
const ordersAccepted = new Counter('orders_accepted');       // นับเป็น "เข้าคิวสำเร็จ / Completed candidate"
const ordersConflict = new Counter('orders_conflict_409');   // ของหมด / ซื้อไปแล้ว → "Failed (คาดหวัง)"
const ordersThrottled = new Counter('orders_throttled_429'); // กันสิทธิ์ซ้ำซ้อนตอน race
const ordersUnauthorized = new Counter('orders_unauthorized_401');
const ordersServerError = new Counter('orders_server_error_5xx'); // "Failed (ไม่คาดหวัง)"
const ordersOther = new Counter('orders_unexpected_status');
const orderLatency = new Trend('place_order_latency', true);

// --- ตรวจกันสิทธิ์ซ้ำซ้อน: user เดียวกันไม่ควรสำเร็จเกิน 1 ครั้ง ---
const duplicateGuardBroken = new Counter('duplicate_purchase_guard_broken'); // ต้อง = 0

export const options = {
  discardResponseBodies: false,
  scenarios: {
    // ข้อ 2: Read Load — 1,000 concurrent users ยิง GET /products
    read_load: {
      executor: 'constant-vus',
      vus: READ_CONCURRENT_USERS,
      duration: READ_DURATION,
      exec: 'readProducts',
      startTime: '5s',
      tags: { scenario_kind: 'read' },
    },
    // ข้อ 3: Write Load — 500 concurrent requests แย่งซื้อ p-1001
    write_load: {
      executor: 'per-vu-iterations',
      vus: WRITE_CONCURRENT_REQUESTS,
      iterations: 1,
      exec: 'placeOrder',
      startTime: '10s',
      maxDuration: '30s',
      tags: { scenario_kind: 'write' },
    },
  },
  thresholds: {
    'http_req_duration{scenario:read_load}': ['p(95)<200'],
    'http_req_duration{scenario:write_load}': ['p(95)<300'],
    duplicate_purchase_guard_broken: ['count==0'], // ต้องไม่มี user ได้ของซ้ำ
  },
};

// =============================================================================
// setup() — ข้อ 1: Preparation Phase
// วนลูปขอ JWT จาก /api/v1/auth/token สำหรับผู้ใช้ไม่ซ้ำกัน user-1..user-TOTAL_USERS
// =============================================================================
export function setup() {
  const tokens = [];
  const failures = [];

  for (let i = 1; i <= TOTAL_USERS; i++) {
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

  if (tokens.length < WRITE_CONCURRENT_REQUESTS) {
    console.warn(
      `[setup] ⚠️ mint token ได้ ${tokens.length} ตัว แต่ WRITE_CONCURRENT_REQUESTS ตั้งไว้ ${WRITE_CONCURRENT_REQUESTS} ` +
        `— write load จะทำได้จริงแค่ ${tokens.length} concurrent requests`,
    );
  }

  // สุ่มเลือกว่า "ใครบ้าง" ในกลุ่ม user ที่จะยิงเบิ้ล 2-3 ครั้งพร้อมกัน (ข้อ 3)
  const doubleSubmitCount = Math.round(tokens.length * DOUBLE_SUBMIT_RATE);
  const doubleSubmitUserIndexes = new Set();
  while (doubleSubmitUserIndexes.size < doubleSubmitCount) {
    doubleSubmitUserIndexes.add(Math.floor(Math.random() * tokens.length));
  }

  console.log(
    `[setup] minted ${tokens.length}/${TOTAL_USERS} JWTs from ${BASE_URL} | ` +
      `double-submit users = ${doubleSubmitCount} (${(DOUBLE_SUBMIT_RATE * 100).toFixed(0)}%)` +
      (failures.length ? ` | failed: ${failures.slice(0, 5).join(', ')}…` : ''),
  );

  return {
    tokens,
    doubleSubmitUserIndexes: Array.from(doubleSubmitUserIndexes),
  };
}

// =============================================================================
// ข้อ 2: readProducts — Read Load (1,000 concurrent users)
// สุ่ม page/limit ทุกครั้งเพื่อไม่ให้ยิงโดน cache key เดียวตลอด (ไม่งั้น hit ratio
// ที่วัดได้จะสวยเกินจริง) และเก็บสถานะ cache hit/miss จาก response header
// =============================================================================
export function readProducts() {
  const limits = [5, 10, 20];
  const limit = limits[Math.floor(Math.random() * limits.length)];
  const totalPages = Math.max(1, Math.ceil(TOTAL_PRODUCTS / limit));
  const page = 1 + Math.floor(Math.random() * totalPages);

  const res = http.get(`${BASE_URL}/api/v1/products?page=${page}&limit=${limit}`, {
    timeout: REQ_TIMEOUT,
    tags: { name: 'GET /api/v1/products' },
  });

  readLatency.add(res.timings.duration);

  const ok = check(res, { 'read: status is 200': (r) => r.status === 200 });
  if (ok) {
    readOk.add(1);
  } else {
    readFailed.add(1);
  }

  // อ่านสถานะ cache จาก response header — ปรับ CACHE_HEADER_NAME ให้ตรงกับที่ backend ใช้จริง
  const rawHeaderVal = res.headers[CACHE_HEADER_NAME] || res.headers[Object.keys(res.headers).find(
    (k) => k.toLowerCase() === CACHE_HEADER_NAME,
  )];
  const headerVal = rawHeaderVal ? String(rawHeaderVal).toUpperCase() : null;

  if (headerVal === CACHE_HIT_VALUE) {
    cacheHit.add(1);
  } else if (headerVal === CACHE_MISS_VALUE) {
    cacheMiss.add(1);
  } else {
    cacheUnknown.add(1);
  }
}

// =============================================================================
// ข้อ 3: placeOrder — Write Load (500 concurrent requests)
// user ปกติ → ยิง 1 request
// user ที่ถูกสุ่มเป็น "ตัวเบิ้ล" → ยิง 2-3 requests "พร้อมกันจริง" ผ่าน http.batch
// (จำลองการดับเบิลคลิก/เปิดหลายแท็บกดพร้อมกันตามที่โจทย์ระบุ)
// =============================================================================
export function placeOrder(data) {
  const tokens = data.tokens;
  const idx = (exec.vu.idInTest - 1) % tokens.length;
  const { userId, token } = tokens[idx];

  const isDoubleSubmitter = data.doubleSubmitUserIndexes.includes(idx);
  const submitCount = isDoubleSubmitter
    ? DOUBLE_SUBMIT_MIN + Math.floor(Math.random() * (DOUBLE_SUBMIT_MAX - DOUBLE_SUBMIT_MIN + 1))
    : 1;

  const req = [
    'POST',
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
  ];

  const responses =
    submitCount === 1 ? [http.post(...req.slice(1))] : http.batch(Array.from({ length: submitCount }, () => req));

  let successCountThisUser = 0;

  for (const res of responses) {
    orderLatency.add(res.timings.duration);

    switch (res.status) {
      case 200:
      case 201:
      case 202:
        ordersAccepted.add(1);
        successCountThisUser++;
        break;
      case 409:
        ordersConflict.add(1);
        break;
      case 429:
        ordersThrottled.add(1);
        break;
      case 401:
        ordersUnauthorized.add(1);
        break;
      default:
        if (res.status >= 500) {
          ordersServerError.add(1);
        } else {
          ordersOther.add(1);
        }
        break;
    }
  }

  // ถ้ายิงเบิ้ลแล้วสำเร็จมากกว่า 1 ครั้ง = ระบบกันสิทธิ์ซ้ำซ้อนพัง (ข้อ 3 ปลาย)
  if (submitCount > 1) {
    const guardOk = check(successCountThisUser, {
      [`[double-submit] ${userId} ยิง ${submitCount} ครั้งพร้อมกัน ต้องสำเร็จได้แค่ 1`]:
        (n) => n <= 1,
    });
    if (!guardOk) {
      duplicateGuardBroken.add(1);
      console.error(
        `🔴 [DUPLICATE GUARD BROKEN] ${userId} ยิง ${submitCount} ครั้งพร้อมกัน แต่สำเร็จ ${successCountThisUser} ครั้ง ` +
          `statuses=[${responses.map((r) => r.status).join(',')}]`,
      );
    }
  }
}

// =============================================================================
// handleSummary — สรุปตรงตาม 3 หัวข้อที่โจทย์ต้องการใน Report
// =============================================================================
export function handleSummary(data) {
  const c = (name) =>
    data.metrics[name] && data.metrics[name].values ? data.metrics[name].values.count || 0 : 0;

  const trend = (name, stat) =>
    data.metrics[name] && data.metrics[name].values
      ? Number(data.metrics[name].values[stat] || 0).toFixed(2)
      : 'n/a';

  // --- 1. Cache Performance ---
  const hit = c('cache_hit');
  const miss = c('cache_miss');
  const unknown = c('cache_status_unknown');
  const totalCacheReads = hit + miss;
  const hitRatio = totalCacheReads > 0 ? ((hit / totalCacheReads) * 100).toFixed(1) : 'n/a';

  // --- 2. Queue Monitoring (ประมาณจาก HTTP status) ---
  const accepted = c('orders_accepted');
  const conflict = c('orders_conflict_409');
  const throttled = c('orders_throttled_429');
  const unauthorized = c('orders_unauthorized_401');
  const serverErr = c('orders_server_error_5xx');
  const unexpected = c('orders_unexpected_status');
  const guardBroken = c('duplicate_purchase_guard_broken');
  const totalOrders = accepted + conflict + throttled + unauthorized + serverErr + unexpected;

  // --- 3. Throughput & Latency ---
  const totalReqs = data.metrics.http_reqs ? data.metrics.http_reqs.values.count : 0;
  const testDurationSec = data.state ? data.state.testRunDurationMs / 1000 : null;
  const reqPerSec = testDurationSec ? (totalReqs / testDurationSec).toFixed(2) : 'n/a';
  const p95Overall = trend('http_req_duration', 'p(95)');
  const errorRate =
    data.metrics.http_req_failed && data.metrics.http_req_failed.values
      ? (data.metrics.http_req_failed.values.rate * 100).toFixed(2)
      : 'n/a';

  const lines = [];
  lines.push('');
  lines.push('══════════════════════════════════════════════════════════════');
  lines.push('  FLASH SALE — LOAD TEST REPORT');
  lines.push(`  target: ${BASE_URL}   product: ${TARGET_PRODUCT_ID}`);
  lines.push(`  users minted: TOTAL_USERS=${TOTAL_USERS}  read VUs=${READ_CONCURRENT_USERS}  write reqs=${WRITE_CONCURRENT_REQUESTS}`);
  lines.push('══════════════════════════════════════════════════════════════');
  lines.push('');
  lines.push('  [1] CACHE PERFORMANCE');
  lines.push(`      Cache Hit         : ${hit}`);
  lines.push(`      Cache Miss        : ${miss}`);
  lines.push(`      Hit Ratio         : ${hitRatio}%`);
  if (unknown > 0) {
    lines.push(
      `      ⚠️ อ่านสถานะ cache ไม่ได้ ${unknown} ครั้ง — เช็คว่า backend ส่ง header ` +
        `"${CACHE_HEADER_NAME}" กลับมาไหม (ปรับชื่อผ่าน -e CACHE_HEADER_NAME=... ได้)`,
    );
  }
  lines.push('');
  lines.push('  [2] QUEUE MONITORING (ประมาณจาก HTTP response — ของจริงดูที่ Bull-Board)');
  lines.push(`      Accepted (เข้าคิว/Completed candidate) : ${accepted}`);
  lines.push(`      Conflict 409 (ของหมด/ซื้อซ้ำ = Failed ที่คาดหวัง) : ${conflict}`);
  lines.push(`      Throttled 429 (กันสิทธิ์ซ้ำซ้อนตอน race)         : ${throttled}`);
  lines.push(`      Unauthorized 401                                : ${unauthorized}   (ควร = 0)`);
  lines.push(`      Server Error 5xx (Failed ที่ไม่คาดหวัง)          : ${serverErr}   (ควร = 0)`);
  lines.push(`      Unexpected status                               : ${unexpected}   (ควร = 0)`);
  lines.push(`      ────────────────────────────────────────`);
  lines.push(`      Total order requests                            : ${totalOrders}`);
  lines.push(
    `      Duplicate-purchase guard broken                 : ${guardBroken}   (ต้อง = 0)`,
  );
  lines.push('');
  lines.push('  [3] THROUGHPUT & LATENCY');
  lines.push(`      Total HTTP requests : ${totalReqs}`);
  lines.push(`      Requests/sec        : ${reqPerSec}`);
  lines.push(`      p95 Latency (all)   : ${p95Overall} ms`);
  lines.push(`      p95 Latency (read)  : ${trend('read_products_latency', 'p(95)')} ms`);
  lines.push(`      p95 Latency (write) : ${trend('place_order_latency', 'p(95)')} ms`);
  lines.push(`      Error Rate          : ${errorRate}%`);
  lines.push('');
  lines.push('  ตรวจ Data Integrity เพิ่มเติมด้วยตนเอง (query DB โดยตรง):');
  lines.push(
    `    SELECT remaining_stock FROM products WHERE id = '${TARGET_PRODUCT_ID}';  -- ต้อง = 0 พอดี`,
  );
  lines.push(
    `    SELECT COUNT(*), COUNT(DISTINCT user_id) FROM orders WHERE product_id = '${TARGET_PRODUCT_ID}';`,
  );
  lines.push('    -- ทั้งสองค่าต้องเท่ากับ 50 พอดี (ไม่มีใครได้เกิน 1 ชิ้น, ไม่มี oversell)');
  lines.push('══════════════════════════════════════════════════════════════');
  lines.push('');

  return {
    stdout: lines.join('\n'),
    'loadtest-summary.json': JSON.stringify(data, null, 2),
  };
}