import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { Counter, Gauge, Trend } from 'k6/metrics';

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
const ordersAccepted = new Counter('orders_accepted');       // 202 ที่ผ่าน contract check
const ordersConflict = new Counter('orders_conflict_409');   // ของหมด / ซื้อไปแล้ว → "Failed (คาดหวัง)"
const ordersThrottled = new Counter('orders_throttled_429'); // กันสิทธิ์ซ้ำซ้อนตอน race
const ordersUnauthorized = new Counter('orders_unauthorized_401'); // ต้อง = 0 — เราแนบ JWT ที่ mint เองทุกคำขอ
const ordersServiceUnavailable = new Counter('orders_service_unavailable_503'); // ต้อง = 0 หลัง seed แล้ว
const ordersServerError = new Counter('orders_server_error_5xx'); // "Failed (ไม่คาดหวัง)"
const ordersOther = new Counter('orders_unexpected_status');
const orderLatency = new Trend('place_order_latency', true);

// --- ตรวจกันสิทธิ์ซ้ำซ้อน: user เดียวกันไม่ควรสำเร็จเกิน 1 ครั้ง ---
const duplicateGuardBroken = new Counter('duplicate_purchase_guard_broken'); // ต้อง = 0

// --- เช็ค contract แบบเป๊ะ (CLAUDE.md §3/§4) ไม่ใช่แค่ "success กว้างๆ" ---
const contractWrongSuccessStatus = new Counter('contract_violation_wrong_success_status'); // ต้อง = 0 — ห้าม 200/201
const contractBadJobId = new Counter('contract_violation_bad_jobid'); // ต้อง = 0 — orderJobId ต้อง = order:{userId}:{productId}
const contractInconsistentJobId = new Counter('contract_violation_inconsistent_jobid'); // ต้อง = 0 — double-submit ต้องได้ jobId เดิมทุกครั้ง (deterministic)

// --- stock ก่อน/หลัง อ่านผ่าน public GET API (ไม่พึ่ง DB) ส่งเข้า handleSummary ---
// ใช้ Gauge เพราะ Counter/Gauge อ่านค่ากลับระหว่างรันไม่ได้ใน k6 — ต้องรอ handleSummary
const stockBeforeGauge = new Gauge('stock_before_target');
const stockAfterGauge = new Gauge('stock_after_target');

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
    contract_violation_wrong_success_status: ['count==0'],
    contract_violation_bad_jobid: ['count==0'],
    contract_violation_inconsistent_jobid: ['count==0'],
    orders_unauthorized_401: ['count==0'],
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

  // อ่าน stock ตั้งต้นผ่าน public GET API — baseline สำหรับ reconciliation ตอนจบ
  // (จุดที่ดักบั๊กเพิ่ม: เทียบ stockBefore-stockAfter กับจำนวน 202 จริงแบบเป๊ะ)
  const stockBefore = readRemainingStock();
  stockBeforeGauge.add(stockBefore === null ? -1 : stockBefore);

  console.log(
    `[setup] minted ${tokens.length}/${TOTAL_USERS} JWTs from ${BASE_URL} | ` +
      `double-submit users = ${doubleSubmitCount} (${(DOUBLE_SUBMIT_RATE * 100).toFixed(0)}%) | ` +
      `stock('${TARGET_PRODUCT_ID}') ก่อนเริ่ม = ${stockBefore === null ? 'อ่านไม่ได้' : stockBefore}` +
      (failures.length ? ` | failed: ${failures.slice(0, 5).join(', ')}…` : ''),
  );

  return {
    tokens,
    doubleSubmitUserIndexes: Array.from(doubleSubmitUserIndexes),
    stockBefore,
  };
}

// --- helper: อ่าน remainingStock ของ TARGET_PRODUCT_ID ผ่าน public GET API ---
function readRemainingStock() {
  for (let page = 1; page <= 10; page++) {
    const res = http.get(`${BASE_URL}/api/v1/products?page=${page}&limit=20`, {
      timeout: REQ_TIMEOUT,
      tags: { name: 'GET /api/v1/products (stock-check)' },
    });
    if (res.status !== 200) return null;
    let body;
    try {
      body = res.json();
    } catch (e) {
      return null;
    }
    if (!body || !Array.isArray(body.data)) return null;
    const found = body.data.find((p) => p.productId === TARGET_PRODUCT_ID);
    if (found) return typeof found.remainingStock === 'number' ? found.remainingStock : null;
    if (body.meta && page >= body.meta.totalPages) break;
  }
  return null;
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
  const expectedJobId = `order:${userId}:${TARGET_PRODUCT_ID}`;

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
  const jobIdsSeen = new Set();

  for (const res of responses) {
    orderLatency.add(res.timings.duration);

    switch (res.status) {
      case 202: {
        successCountThisUser++;
        let jobId = null;
        let bodyStatus = null;
        try {
          const j = res.json();
          jobId = j.orderJobId;
          bodyStatus = j.status;
        } catch (e) {
          /* body ไม่ใช่ JSON ที่ parse ได้ */
        }
        if (jobId) jobIdsSeen.add(jobId);

        // จุดที่ดักเพิ่ม: 202 อย่างเดียวไม่พอ ต้องเช็ค body ตรง contract ด้วย
        // (CLAUDE.md §3 — status: "processing", orderJobId deterministic)
        const contractOk = check(res, {
          '[contract] 202 body.status === "processing"': () => bodyStatus === 'processing',
          '[contract] 202 orderJobId ตรง deterministic format': () => jobId === expectedJobId,
        });
        if (contractOk) {
          ordersAccepted.add(1);
        } else {
          contractBadJobId.add(1);
          console.error(
            `🔴 [CONTRACT VIOLATION] ${userId} ได้ orderJobId="${jobId}" (คาดหวัง "${expectedJobId}") ` +
              `status field="${bodyStatus}"`,
          );
        }
        break;
      }
      case 200:
      case 201:
        // จุดที่ดักเพิ่ม: CLAUDE.md §3 ห้าม 200/201 เด็ดขาด ต้องเป็น 202 เท่านั้น
        // (Ao1/Ao2 เดิมนับ 200/201/202 รวมเป็น "success" หมด เพราะออกแบบไว้ยิงข้ามทีม
        // แต่นี่คือระบบของเราเอง ต้องเช็คตาม contract จริง ไม่ใช่ยอมรับกว้างๆ)
        successCountThisUser++;
        contractWrongSuccessStatus.add(1);
        console.error(`🔴 [CONTRACT VIOLATION] ${userId} ได้ HTTP ${res.status} แทน 202 ตามสเปก §3`);
        break;
      case 409:
        ordersConflict.add(1);
        break;
      case 429:
        ordersThrottled.add(1);
        break;
      case 401:
        // จุดที่ดักเพิ่ม: เราแนบ JWT ที่เพิ่ง mint สดๆ ทุกคำขอ 401 จึงไม่ควรเกิดเลย
        // ต่างจาก spec table ที่ 401 หมายถึง "ไม่มี/JWT ผิด" ซึ่งเราไม่ได้จำลองเคสนั้น
        ordersUnauthorized.add(1);
        console.error(`🔴 [AUTH BUG] ${userId} ได้ 401 ทั้งที่แนบ JWT ที่เพิ่ง mint สดๆ`);
        break;
      case 503:
        // จุดที่ดักเพิ่ม: แยก 503 ออกจาก 5xx อื่น — 503 ระหว่างยิงจริง (หลัง seed
        // แล้ว) ไม่ควรเกิดเลย ถ้าเกิดคือ stock counter ยังไม่ seed หรือ Redis มีปัญหา
        ordersServiceUnavailable.add(1);
        console.error(`🔴 [INFRA] ${userId} ได้ 503 ระหว่างยิงจริง (ตรวจว่า seed:redis รันแล้วหรือยัง)`);
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

  // จุดที่ดักเพิ่ม: double-submit ของ user เดียวกันต้องได้ orderJobId เดิมทุกครั้ง
  // (jobId deterministic ตาม CLAUDE.md §4 ข้อ 9) ถ้าต่างกัน = jobId ไม่ deterministic จริง
  if (jobIdsSeen.size > 1) {
    contractInconsistentJobId.add(1);
    console.error(
      `🔴 [JOBID BUG] ${userId} ยิง ${submitCount} ครั้งพร้อมกัน แต่ได้ orderJobId ต่างกัน: ` +
        `[${Array.from(jobIdsSeen).join(', ')}]`,
    );
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
// teardown() — จุดที่ดักเพิ่ม: รอ worker/BullMQ ประมวลผลตัดสต็อกจริงให้เสร็จ
// แล้วอ่าน stock สุดท้ายผ่าน public GET API ส่ง Gauge ให้ handleSummary ทำ
// reconciliation แบบเป๊ะ (ต่างจาก setup/placeOrder ที่ทำงานคนละ VU context กัน
// จึงต้องพักงานนี้ไว้ที่ teardown ซึ่งรันครั้งเดียวหลัง scenario ทั้งหมดจบ)
// =============================================================================
export function teardown(data) {
  sleep(5);
  let stockAfter = readRemainingStock();
  for (let attempt = 0; attempt < 3 && stockAfter === null; attempt++) {
    sleep(3);
    stockAfter = readRemainingStock();
  }
  stockAfterGauge.add(stockAfter === null ? -1 : stockAfter);

  check(stockAfter, {
    '[BUG-2] remainingStock ต้องไม่ติดลบ': (v) => v === null || v >= 0,
  });
  if (stockAfter !== null && stockAfter < 0) {
    console.error(
      `🔴 [BUG-2 CONFIRMED] remainingStock ติดลบ = ${stockAfter} → OVERSELLING จริงในชั้น database/redis`,
    );
  }

  console.log(
    `[teardown] stock('${TARGET_PRODUCT_ID}') ก่อนเริ่ม=${data.stockBefore} หลังจบ=${stockAfter}`,
  );
}

// =============================================================================
// handleSummary — สรุปตรงตาม 3 หัวข้อที่โจทย์ต้องการใน Report
// =============================================================================
export function handleSummary(data) {
  const c = (name) =>
    data.metrics[name] && data.metrics[name].values ? data.metrics[name].values.count || 0 : 0;
  const g = (name) => {
    const v = data.metrics[name] && data.metrics[name].values ? data.metrics[name].values.value : undefined;
    return v === undefined || v === -1 ? null : v;
  };

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
  const serviceUnavailable = c('orders_service_unavailable_503');
  const serverErr = c('orders_server_error_5xx');
  const unexpected = c('orders_unexpected_status');
  const guardBroken = c('duplicate_purchase_guard_broken');
  const wrongStatus = c('contract_violation_wrong_success_status');
  const badJobId = c('contract_violation_bad_jobid');
  const inconsistentJobId = c('contract_violation_inconsistent_jobid');
  const totalOrders = accepted + conflict + throttled + unauthorized + serviceUnavailable + serverErr + unexpected;

  const stockBefore = g('stock_before_target');
  const stockAfter = g('stock_after_target');

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
  lines.push(`      Service unavailable 503                         : ${serviceUnavailable}   (ควร = 0)`);
  lines.push(`      Server Error 5xx (Failed ที่ไม่คาดหวัง)          : ${serverErr}   (ควร = 0)`);
  lines.push(`      Unexpected status                               : ${unexpected}   (ควร = 0)`);
  lines.push(`      ────────────────────────────────────────`);
  lines.push(`      Total order requests                            : ${totalOrders}`);
  lines.push(
    `      Duplicate-purchase guard broken                 : ${guardBroken}   (ต้อง = 0)`,
  );
  lines.push(`      Wrong success status (ต้อง 202 เท่านั้น)         : ${wrongStatus}   (ต้อง = 0)`);
  lines.push(`      orderJobId ผิด format                           : ${badJobId}   (ต้อง = 0)`);
  lines.push(`      orderJobId ไม่ deterministic (เบิ้ลแล้วได้คนละค่า) : ${inconsistentJobId}   (ต้อง = 0)`);
  lines.push('');
  lines.push('  [3] STOCK RECONCILIATION (อ่านจาก public GET API ไม่พึ่ง DB)');
  if (stockBefore !== null && stockAfter !== null) {
    const actuallySold = stockBefore - stockAfter;
    lines.push(
      `      stockBefore=${stockBefore}  stockAfter=${stockAfter}  actuallySold=${actuallySold}  accepted(202)=${accepted}`,
    );
    if (accepted > stockBefore) {
      lines.push(
        `      🔴 BUG-2/3 CONFIRMED: accepted(${accepted}) > stockBefore(${stockBefore}) → เช็ค stock ตอนรับเข้าคิว ไม่ใช่ตอนตัดจริง (fake-atomic queue)`,
      );
    }
    if (actuallySold === accepted) {
      lines.push('      🟢 reconciliation ตรงกันพอดี (actuallySold == accepted)');
    } else if (actuallySold < accepted) {
      lines.push(
        `      🟡 actuallySold(${actuallySold}) < accepted(${accepted}) → มี compensation คืนสต็อกเกิดขึ้น ` +
          `(เทียบกับ serverErr=${serverErr}, serviceUnavailable=${serviceUnavailable} — ถ้าทั้งคู่ = 0 แปลว่า compensation ทำงานผิดจังหวะโดยไม่มี error จริง)`,
      );
    } else {
      lines.push(
        `      🔴 STOCK DRIFT: actuallySold(${actuallySold}) > accepted(${accepted}) → มีคนอื่นซื้อ ${TARGET_PRODUCT_ID} ระหว่างเทส หรือมี double-decrement bug`,
      );
    }
  } else {
    lines.push('      ⚠️ อ่าน stock ก่อน/หลังไม่ได้ครบ — ดูค่าจาก [teardown] log ด้านบนแทน');
  }
  lines.push('');
  lines.push('  [4] THROUGHPUT & LATENCY');
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