/* eslint-disable */
// =============================================================================
// ทำไมต่างจาก loadtest.js เดิม:
//   - เดิมใช้ per-vu-iterations (VU ยิง -> รอ response -> ยิงใหม่) = เรียงคิว
//     ไม่ใช่ "พร้อมกันจริง" ระบบที่ lock แบบขี้เกียจก็รอดได้
//   - สคริปต์นี้ใช้ http.batch() ยิงหลาย request จาก "เธรดเดียวกัน" ออกไปพร้อมกัน
//     แบบ millisecond เดียวกันจริง ๆ → เป็นการจำลอง "ดับเบิลคลิก" / "เปิดหลายแท็บ
//     กดพร้อมกัน" ตามที่โจทย์ต้องการ (ข้อ 2.3.2)
//   - เดิมสมมติ response ต้องเป็น 202/409/429/503 ตามสเปค (ใช้ได้กับระบบตัวเอง
//     ที่ควบคุมได้) — สคริปต์นี้ไม่ล็อกสมมติฐานนั้น เพราะต้องเอาไปยิงระบบ
//     "กลุ่มเพื่อน" ที่อาจตอบ 200/201/400/500 ก็ได้ ใช้การนับ "ใครสำเร็จบ้าง"
//     + เทียบ stock ก่อน-หลังผ่าน GET API แทนการเช็ค DB โดยตรง (ซึ่งยิงข้ามทีม
//     ไม่มีสิทธิ์เข้าถึงอยู่แล้ว)
// =============================================================================

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const TARGET_PRODUCT_ID = __ENV.TARGET_PRODUCT_ID || 'p-1001';
const REQ_TIMEOUT = __ENV.REQ_TIMEOUT || '30s';

// จำนวน stock ที่ "รู้อยู่แล้ว" ว่าเซ็ตไว้เท่าไหร่ (จาก seed) ใช้เป็น baseline
// เทียบผล ถ้าไม่รู้ (เช่นยิงข้ามทีม) ปล่อย 0 แล้วสคริปต์จะอ่านจาก GET ก่อนเริ่มเอง
const KNOWN_STOCK = Number(__ENV.KNOWN_STOCK || 0);

// จำนวน "คนดูสินค้า" (read load) ที่ยิง GET /products พร้อมกันระหว่างทดสอบ
// ปรับได้ผ่าน -e VIEW_USERS=1000 (ตั้งเป็น 0 เพื่อปิด scenario นี้)
const VIEW_USERS = Number(__ENV.VIEW_USERS || 1000);

// ระยะเวลาที่ให้ "คนดูสินค้า" ยิงต่อเนื่อง
const VIEW_DURATION = __ENV.VIEW_DURATION || '40s';

// จำนวน "คนสั่งซื้อ" ที่แย่งสินค้าพร้อมกันในสถานการณ์ overselling stampede
// (ชื่อเดิม STAMPEDE_USERS) ควรมากกว่า stock จริงหลายเท่า เพื่อบีบให้ระบบ
// ต้อง "ปฏิเสธ" คนส่วนใหญ่จริง ๆ — ปรับได้ผ่าน -e ORDER_USERS=500
const ORDER_USERS = Number(__ENV.ORDER_USERS || 500);

// จำนวนครั้งที่ user แต่ละคนดับเบิลคลิกพร้อมกัน (BUG-1 test)
const DOUBLE_CLICK_N = Number(__ENV.DOUBLE_CLICK_N || 5);

// จำนวน "user คนละคนกัน" ที่ทดสอบ same_user_race (BUG-1)
// ปรับได้ผ่าน ENV เช่น -e SAME_USER_RACE_USERS=1000
// ใช้ตัวแปรนี้ตัวเดียวทั้งไฟล์ (options.scenarios, setup, stampede offset)
// เพื่อไม่ต้อง hardcode เลข 30 ซ้ำหลายที่แบบเดิม
const SAME_USER_RACE_USERS = Number(__ENV.SAME_USER_RACE_USERS || 30);

// treat เป็น "รับออเดอร์สำเร็จ" ถ้า status อยู่ในช่วงนี้ (ยืดหยุ่นข้ามทีม)
const SUCCESS_STATUSES = new Set([200, 201, 202]);

http.setResponseCallback(
  http.expectedStatuses(200, 201, 202, 400, 401, 403, 404, 409, 422, 429, 500, 503),
);

// --- metrics -----------------------------------------------------------------
const doubleClickBugHits = new Counter('bug1_same_user_double_success'); // ต้อง = 0
const stampedeSuccessCount = new Counter('bug2_stampede_success_total');
const stampedeUnexpectedErrors = new Counter('bug3_stampede_5xx_or_unknown');

export const options = {
  scenarios: {
    // -------------------------------------------------------------------
    // "คนดูสินค้า" — read load ล้วน ๆ ไม่เกี่ยวกับ bug hunter โดยตรง
    // แต่ยิงคู่ขนานไปด้วย เพื่อจำลองสภาพจริงตอน flash sale ว่ามีทั้งคนดู
    // และคนแย่งซื้อพร้อมกัน (เผื่อระบบ cache invalidation พังตอนโหลดหนัก)
    // ปรับจำนวนคนดูได้ผ่าน -e VIEW_USERS=1000, ปิดได้ด้วย -e VIEW_USERS=0
    // -------------------------------------------------------------------
    ...(VIEW_USERS > 0
      ? {
          view_products: {
            executor: 'constant-vus',
            vus: VIEW_USERS,
            duration: VIEW_DURATION,
            exec: 'viewProducts',
            startTime: '0s',
            tags: { scenario_kind: 'read_view_products' },
          },
        }
      : {}),
    // -------------------------------------------------------------------
    // BUG-1: same-user double-click — ยิง DOUBLE_CLICK_N ครั้งพร้อมกันจริง
    // ต่อ user โดยใช้ VU = SAME_USER_RACE_USERS ตัว (คนละ user) แต่ทุก
    // iteration ใช้ http.batch เพื่อยิงพร้อมกันจริงในระดับ user เดียว
    // ปรับจำนวน user ได้ผ่าน -e SAME_USER_RACE_USERS=1000
    // -------------------------------------------------------------------
    same_user_race: {
      executor: 'per-vu-iterations',
      vus: SAME_USER_RACE_USERS,
      iterations: 1,
      exec: 'doubleClickAttack',
      startTime: '2s',
      maxDuration: '30s',
      tags: { scenario_kind: 'bug1_double_click' },
    },
    // -------------------------------------------------------------------
    // BUG-2/3: overselling stampede — ยิงพร้อมกันจริงจาก "หลาย user"
    // ด้วย http.batch แบ่งเป็นชุด ๆ ละ 50 requests ต่อ 1 batch call เดียว
    // (แทนที่จะกระจายผ่าน VU ramp-up ซึ่งจะมี jitter หลาย ms จนไม่ชนกันจริง)
    // -------------------------------------------------------------------
    stampede: {
      executor: 'shared-iterations',
      vus: 1, // ตั้งใจใช้ VU เดียวคุม batch ทั้งหมด เพื่อควบคุมความพร้อมกัน
      iterations: 1,
      exec: 'stampedeAttack',
      startTime: '35s',
      maxDuration: '60s',
      tags: { scenario_kind: 'bug2_stampede' },
    },
  },
  thresholds: {
    // เกณฑ์ "ผ่าน/ไม่ผ่าน" ของบั๊กฮันเตอร์ ไม่ใช่เกณฑ์ performance
    bug1_same_user_double_success: ['count==0'],
    bug3_stampede_5xx_or_unknown: ['count==0'],
  },
};

// =============================================================================
// setup() — mint token ให้ user ที่ต้องใช้ทั้งสอง scenario
// และอ่าน stock ตั้งต้นจาก GET /products (ไม่พึ่ง DB)
// =============================================================================
export function setup() {
  // scenario1 (same_user_race) ใช้ user-1..SAME_USER_RACE_USERS
  // scenario2 (stampede) ใช้ user ต่อจากนั้นไปอีก ORDER_USERS คน (คนสั่งซื้อ)
  const totalUsersNeeded = SAME_USER_RACE_USERS + ORDER_USERS;
  const tokens = {};

  for (let i = 1; i <= totalUsersNeeded; i++) {
    const userId = `race-user-${i}`;
    const res = http.post(
      `${BASE_URL}/api/v1/auth/token`,
      JSON.stringify({ userId }),
      { timeout: REQ_TIMEOUT, headers: { 'Content-Type': 'application/json' } },
    );
    if (res.status === 200) {
      try {
        tokens[userId] = res.json('accessToken');
      } catch (e) {
        /* skip */
      }
    }
  }

  const mintedCount = Object.keys(tokens).length;
  if (mintedCount < SAME_USER_RACE_USERS + 1) {
    throw new Error(
      `setup: mint token ได้แค่ ${mintedCount}/${totalUsersNeeded} ตัว — ระบบ auth มีปัญหา หยุดเทส`,
    );
  }

  // อ่าน stock ก่อนเริ่ม เพื่อไว้เทียบตอนจบ (วิธีเดียวที่ยิงข้ามทีมได้โดยไม่ต้อง DB)
  const stockBefore = readRemainingStock();

  console.log(
    `[setup] minted ${mintedCount}/${totalUsersNeeded} tokens | ` +
      `stock('${TARGET_PRODUCT_ID}') ก่อนเริ่ม = ${stockBefore === null ? 'อ่านไม่ได้' : stockBefore}` +
      (KNOWN_STOCK ? ` | KNOWN_STOCK=${KNOWN_STOCK}` : ''),
  );

  return { tokens, stockBefore };
}

// --- helper: อ่าน remainingStock ของ TARGET_PRODUCT_ID ผ่าน public GET API ---
function readRemainingStock() {
  // วน page จนกว่าจะเจอ (รองรับ pagination โดยไม่ต้องรู้ page ล่วงหน้า)
  for (let page = 1; page <= 10; page++) {
    const res = http.get(`${BASE_URL}/api/v1/products?page=${page}&limit=20`, {
      timeout: REQ_TIMEOUT,
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
// SCENARIO 0 — "คนดูสินค้า" (read load)
// วนอ่าน GET /products หน้าสุ่ม ๆ ต่อเนื่องตลอด VIEW_DURATION
// ไม่ต้องใช้ token (สมมติว่าดูสินค้าได้โดยไม่ต้อง login) — ถ้า API ของทีมไหน
// บังคับ auth ตอน GET ด้วย ให้ปรับเพิ่ม header เองตรงนี้
// =============================================================================
export function viewProducts() {
  const limits = [5, 10, 20];
  const limit = limits[Math.floor(Math.random() * limits.length)];
  const page = 1 + Math.floor(Math.random() * 3);

  const res = http.get(`${BASE_URL}/api/v1/products?page=${page}&limit=${limit}`, {
    timeout: REQ_TIMEOUT,
    tags: { name: 'GET /api/v1/products (view)' },
  });

  check(res, {
    'view: status is 200': (r) => r.status === 200,
  });
}

// =============================================================================
// SCENARIO 1 — BUG-1: same_user_race
// 1 user ยิง DOUBLE_CLICK_N requests "พร้อมกันจริง" ผ่าน http.batch
// คำตอบที่ถูกต้อง: สำเร็จได้แค่ 1 ครั้ง ที่เหลือต้องถูกปฏิเสธทั้งหมด
// ถ้าสำเร็จ >= 2 ครั้ง = ยืนยันว่า concurrency lock ระดับ user พัง (Redis SETNX
// หรือ unique constraint ไม่ทำงาน)
// =============================================================================
export function doubleClickAttack(data) {
  const userId = `race-user-${__VU}`;
  const token = data.tokens[userId];
  if (!token) return;

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
    },
  ];

  // ยิง DOUBLE_CLICK_N requests ออกไป "พร้อมกัน" จริง ๆ ในเรียกเดียว
  const batchReqs = Array.from({ length: DOUBLE_CLICK_N }, () => req);
  const responses = http.batch(batchReqs);

  const successCount = responses.filter((r) => SUCCESS_STATUSES.has(r.status)).length;

  const passed = check(successCount, {
    [`[BUG-1] user ${userId}: สำเร็จได้แค่ 1 จาก ${DOUBLE_CLICK_N} ครั้งที่ยิงพร้อมกัน`]:
      (n) => n <= 1,
  });

  if (!passed) {
    doubleClickBugHits.add(1);
    console.error(
      `🔴 [BUG-1 FOUND] ${userId} ได้ order สำเร็จ ${successCount}/${DOUBLE_CLICK_N} ครั้ง ` +
        `จากการยิงพร้อมกัน — race condition ระดับ user ไม่ถูกป้องกัน! ` +
        `statuses=[${responses.map((r) => r.status).join(',')}]`,
    );
  }
}

// =============================================================================
// SCENARIO 2 — BUG-2/3: stampede
// ORDER_USERS คน (คนละ user จริง = "คนสั่งซื้อ") ยิงแย่ง TARGET_PRODUCT_ID "พร้อมกัน"
// แบ่งเป็นชุด ๆ ละ 50 requests ต่อ http.batch เรียกเดียว เพื่อบีบให้ระบบ
// เจอ concurrent write จริงในระดับ database/redis ไม่ใช่แค่ระดับ user เดียว
//
// หลังยิงจบ: poll GET /products จนกว่า stock จะนิ่ง (worker/queue ประมวลผลเสร็จ)
// แล้วเทียบ:
//   expectedSold      = stockBefore - stockAfter   (ต้องไม่เกิน stockBefore เดิม)
//   observedSuccess   = จำนวน response ที่ "สำเร็จ" ที่นับได้จาก stampede
// ถ้า stockAfter < 0  → BUG-2 ยืนยันชัดเจน (overselling ระดับ database)
// ถ้า observedSuccess > stockBefore → BUG-2/3 ยืนยันผ่านชั้น API/queue เอง
// =============================================================================
export function stampedeAttack(data) {
  const batchSize = 50;
  const stampedeUserIds = Array.from(
    { length: ORDER_USERS },
    (_, i) => `race-user-${SAME_USER_RACE_USERS + 1 + i}`,
  ).filter((uid) => !!data.tokens[uid]);

  let totalSuccess = 0;
  let totalUnexpected = 0;
  const statusTally = {};

  for (let start = 0; start < stampedeUserIds.length; start += batchSize) {
    const chunk = stampedeUserIds.slice(start, start + batchSize);
    const batchReqs = chunk.map((uid) => [
      'POST',
      `${BASE_URL}/api/v1/orders`,
      JSON.stringify({ productId: TARGET_PRODUCT_ID }),
      {
        timeout: REQ_TIMEOUT,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${data.tokens[uid]}`,
        },
      },
    ]);

    const responses = http.batch(batchReqs);
    for (const r of responses) {
      statusTally[r.status] = (statusTally[r.status] || 0) + 1;
      if (SUCCESS_STATUSES.has(r.status)) {
        totalSuccess++;
      } else if (r.status >= 500 || r.status === 0) {
        totalUnexpected++;
      }
    }
    // ไม่ sleep ระหว่าง chunk — ตั้งใจให้ chunk ถัดไปยิงติดกันแทบจะทันที
  }

  stampedeSuccessCount.add(totalSuccess);
  stampedeUnexpectedErrors.add(totalUnexpected);

  console.log(
    `[stampede] ยิงทั้งหมด ${stampedeUserIds.length} users, ` +
      `success(200/201/202)=${totalSuccess}, statusTally=${JSON.stringify(statusTally)}`,
  );

  // รอให้ queue/worker (BullMQ) ประมวลผลตัดสต็อกให้เสร็จก่อนอ่านค่าจริง
  sleep(5);

  let stockAfter = readRemainingStock();
  // poll ซ้ำอีกสูงสุด 3 ครั้งถ้ายังไม่นิ่ง (เผื่อ worker ช้า)
  for (let attempt = 0; attempt < 3 && stockAfter === null; attempt++) {
    sleep(3);
    stockAfter = readRemainingStock();
  }

  const stockBefore = KNOWN_STOCK || data.stockBefore;

  check(stockAfter, {
    '[BUG-2] remainingStock ต้องไม่ติดลบ (ห้ามน้อยกว่า 0)': (v) => v === null || v >= 0,
  });

  if (stockBefore !== null && stockBefore !== undefined) {
    check(totalSuccess, {
      [`[BUG-2/3] จำนวนออเดอร์ที่ "สำเร็จ" (${totalSuccess}) ต้องไม่เกิน stock ตั้งต้น (${stockBefore})`]:
        (n) => n <= stockBefore,
    });
  }

  if (stockAfter !== null && stockBefore !== null && stockBefore !== undefined) {
    const actuallySold = stockBefore - stockAfter;
    console.log(
      `[stampede] stockBefore=${stockBefore} stockAfter=${stockAfter} ` +
        `actuallySold(ตาม GET)=${actuallySold} observedSuccess(ตาม API response)=${totalSuccess}`,
    );

    if (stockAfter < 0) {
      console.error(
        `🔴 [BUG-2 CONFIRMED] remainingStock ติดลบ = ${stockAfter} → OVERSELLING จริงในชั้น database/redis`,
      );
    }
    if (totalSuccess > stockBefore) {
      console.error(
        `🔴 [BUG-2/3 CONFIRMED] มี ${totalSuccess} orders ที่ระบบตอบว่า "สำเร็จ" แต่ stock มีแค่ ${stockBefore} ` +
          `→ ระบบเช็ค stock ตอนรับเข้าคิว ไม่ใช่ตอนตัดจริง (fake-atomic queue)`,
      );
    }
    if (totalSuccess === Math.min(stockBefore, stampedeUserIds.length) && stockAfter === 0) {
      console.log(`🟢 ดูเหมือนป้องกัน overselling ได้ถูกต้อง (สำเร็จพอดี ${totalSuccess}, stock เหลือ 0)`);
    }
  }
}

// =============================================================================
// handleSummary
// =============================================================================
export function handleSummary(data) {
  const c = (name) =>
    data.metrics[name] && data.metrics[name].values ? data.metrics[name].values.count || 0 : 0;

  const bug1 = c('bug1_same_user_double_success');
  const stampedeSuccess = c('bug2_stampede_success_total');
  const unexpected5xx = c('bug3_stampede_5xx_or_unknown');

  const lines = [
    '',
    '══════════════════════════════════════════════════════════',
    '  RACE CONDITION & OVERSELLING — BUG HUNTER REPORT',
    `  target: ${BASE_URL}  product: ${TARGET_PRODUCT_ID}`,
    '══════════════════════════════════════════════════════════',
    '',
    `  [BUG-1] Same-user double-buy หลุด (ครั้ง)   : ${bug1}   (ต้อง = 0)`,
    `  [BUG-2/3] จำนวน order ที่ตอบ "สำเร็จ" รวม    : ${stampedeSuccess}`,
    `  [BUG-3] 5xx/unknown ระหว่าง stampede         : ${unexpected5xx}   (ต้อง = 0)`,
    '',
    '  ดูรายละเอียด "🔴 [BUG-x CONFIRMED]" ใน stdout ด้านบนประกอบ',
    '  เพื่อดูตัวเลข stockBefore/stockAfter/actuallySold ที่ยืนยันด้วย GET API จริง',
    '══════════════════════════════════════════════════════════',
    '',
  ];

  return {
    stdout: lines.join('\n'),
    'race-hunter-summary.json': JSON.stringify(data, null, 2),
  };
}