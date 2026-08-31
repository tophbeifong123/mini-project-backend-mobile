/**
 * k6 Load Test — Flash Sale System (comprehensive)
 *
 * Run:
 *   k6 run --env BASE_URL=http://localhost loadtest/flash-sale.js
 *   k6 run --env BASE_URL=http://localhost \
 *          --out json=loadtest/results/summary.json \
 *          loadtest/flash-sale.js
 *
 * Scenarios (run in parallel; warmup leads, then read+write in lock-step):
 *   - read_warmup :  200 VUs ×  5s  (cache priming, excluded from thresholds)
 *   - read_load   : 1000 VUs × 30s  (spec read)
 *   - write_load  :  500 VUs × 30s  (spec write, p-1001, 2-4 iters/VU)
 *
 * Response taxonomy (single source of truth — see STATUS below):
 *   200         read success
 *   202         order accepted by queue
 *   409         conflict  (split: sold_out | already_purchased | locked | other)
 *   429         too many requests (Lua DECR rolled back)
 *   5xx / 0 / - timeout / connection refused → infra failure
 *
 * Business verdict printed at the end of the summary:
 *   PASS  ↔  accepted == 50  &&  infra rate < 1%  &&  p95 < 500ms (per scenario)
 *   FAIL  ↔  otherwise (reasons listed)
 */

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.3/index.js';

// ============================================================================
// CONFIG
// ============================================================================

const BASE_URL        = __ENV.BASE_URL || 'http://localhost';
const TOTAL_USERS     = 500;                    // spec: user-1..user-500
const TOTAL_PRODUCTS  = 20;                     // from products-seed.json
const TARGET_PRODUCT  = 'p-1001';
const TARGET_STOCK    = 50;                     // expected SUCCESS count

const WARMUP_DURATION = '5s';
const LOAD_DURATION   = '30s';
const WARMUP_VUS      = 200;
const READ_VUS        = 1000;                   // spec
const WRITE_VUS       = 500;                    // spec
const BATCH_SIZE      = 50;                     // JWT fetch parallelism in setup

const REQ_TIMEOUT     = '60s';
const OVERFLOW_RATE   = 0.05;                   // 5% read overflow mix (edge cases)
const LIMIT_OPTIONS   = [5, 10, 15, 20, 25, 50];

// Limits for the verdict (mirrors the threshold declarations below)
const P95_LIMIT_MS    = 500;
const INFRA_LIMIT     = 0.01;

// ============================================================================
// STATUS TAXONOMY
// ============================================================================

const STATUS = Object.freeze({
  OK:           200,
  ACCEPTED:     202,
  CONFLICT:     409,
  RATE_LIMITED: 429,
});

// ============================================================================
// METRICS
// ============================================================================

// Write-side counters — each 409 reason gets its own bucket so the report
// can show WHY requests were rejected (sold_out vs already_purchased vs locked).
const orderAccepted         = new Counter('order_accepted_total');
const orderSoldOut          = new Counter('order_sold_out_total');
const orderAlreadyPurchased = new Counter('order_already_purchased_total');
const orderLocked           = new Counter('order_locked_total');
const orderOtherConflict    = new Counter('order_other_conflict_total');
const orderRateLimited      = new Counter('order_rate_limited_total');

// Read-side counters
const readTotal = new Counter('read_total');
const readOk    = new Counter('read_ok_total');

// Infra failures: anything that isn't an expected business status
// (5xx, timeouts, connection refused, unexpected 4xx). 429 and 409 are EXCLUDED.
const httpInfraFailures = new Rate('http_infra_failures');

// ============================================================================
// HELPERS
// ============================================================================

/** Pick uniformly at random from a non-empty array. */
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** A read response is "expected" iff 200. Anything else is infra. */
function isExpectedRead(res) {
  return res.status === STATUS.OK;
}

/** A write response is "expected" iff 202, 409, or 429. Anything else is infra. */
function isExpectedWrite(res) {
  return res.status === STATUS.ACCEPTED
      || res.status === STATUS.CONFLICT
      || res.status === STATUS.RATE_LIMITED;
}

/**
 * Classify a 409 by parsing the backend's `message` field.
 * Backend message → reason (see flash-sale-backend/src/orders/orders.service.ts):
 *   'Product is sold out'                   → sold_out
 *   'You have already purchased…'           → already_purchased
 *   'You already have an order being…'      → locked
 *   anything else (or unparsable body)      → other
 */
function classifyConflict(res) {
  try {
    const msg = String(res.json('message') || '').toLowerCase();
    if (msg.includes('sold out'))              return 'sold_out';
    if (msg.includes('already purchased'))     return 'already_purchased';
    if (msg.includes('already have an order')) return 'locked';
  } catch (_) { /* non-JSON body → other */ }
  return 'other';
}

/**
 * Decide (page, limit) for one read iteration.
 * 95% of the time: a VALID page for the chosen limit (exercises cache hits).
 * 5% of the time: an OVERFLOW query that still returns 200 but with no/sparse data.
 */
function pickProductQuery() {
  if (Math.random() < OVERFLOW_RATE) {
    if (Math.random() < 0.5) {
      return { page: Math.floor(Math.random() * 30) + 5, limit: pickRandom(LIMIT_OPTIONS) };
    }
    return { page: 1, limit: Math.floor(Math.random() * 50) + 51 }; // 51..100
  }
  const limit  = pickRandom(LIMIT_OPTIONS);
  const maxPg  = Math.ceil(TOTAL_PRODUCTS / limit);
  return { page: Math.floor(Math.random() * maxPg) + 1, limit };
}

/**
 * Build the k6 `params` object with a consistent timeout + tag schema.
 * `expected_response: 'true'` is a k6 convention that lets you opt these
 * requests OUT of the built-in `http_req_failed` metric if you ever want to.
 * `scenario` is omitted here — k6 adds it automatically from the executor.
 */
function buildParams(extra) {
  return {
    timeout: REQ_TIMEOUT,
    tags: { expected_response: 'true', ...(extra || {}) },
  };
}

/**
 * How many POST /api/v1/orders iterations this VU should fire.
 * 35% → 2 iters, 50% → 3 iters, 15% → 4 iters.
 * The 4-iter branch is intentionally aggressive so the same-user cooldown
 * lock path gets exercised more often in reports.
 */
function pickWriteIterations() {
  const r = Math.random();
  if (r < 0.35) return 2;
  if (r < 0.85) return 3;
  return 4;
}

/**
 * Pick a stable user index for this VU. Random-per-VU is intentional:
 * - Within a VU, all iterations use the SAME user → real "double/triple click"
 * - Across VUs, ~37% birthday-collision rate is acceptable: collisions just
 *   surface as extra "already_purchased" conflicts, which is realistic and
 *   does not break the 50-stock invariant.
 *
 * Note: we deliberately do NOT use `exec.vu.idInTest % TOTAL_USERS` because
 * with 3 concurrent scenarios the modulo can map two different scenarios'
 * VUs to the same user, which is harder to reason about.
 */
function pickStableUserIndex() {
  return Math.floor(Math.random() * TOTAL_USERS);
}

/**
 * Snapshot Redis cache stats via the backend's admin endpoint.
 * Returns null if the call fails (we never want a stats probe to fail the run).
 */
function fetchCacheStats() {
  try {
    const res = http.get(`${BASE_URL}/api/v1/products/admin/cache-stats`, {
      timeout: '5s',
      tags: { name: 'admin_cache_stats', expected_response: 'true' },
    });
    if (res.status !== STATUS.OK) return null;
    const j = res.json();
    return {
      hits:     Number(j.hits     ?? 0),
      misses:   Number(j.misses   ?? 0),
      total:    Number(j.total    ?? 0),
      hitRatio: Number(j.hitRatio ?? 0),
    };
  } catch (_) {
    return null;
  }
}

// ============================================================================
// OPTIONS — scenarios + thresholds
// ============================================================================

export const options = {
  scenarios: {
    read_warmup: {
      executor: 'constant-vus',
      vus: WARMUP_VUS,
      duration: WARMUP_DURATION,
      exec: 'readScenario',
      gracefulStop: '5s',
    },
    read_load: {
      executor: 'constant-vus',
      vus: READ_VUS,
      duration: LOAD_DURATION,
      startTime: WARMUP_DURATION,
      exec: 'readScenario',
      gracefulStop: '5s',
    },
    write_load: {
      executor: 'constant-vus',
      vus: WRITE_VUS,
      duration: LOAD_DURATION,
      startTime: WARMUP_DURATION,
      exec: 'writeScenario',
      gracefulStop: '5s',
    },
  },
  thresholds: {
    // Per-scenario latency — warmup is intentionally loose
    'http_req_duration{scenario:read_warmup}':  ['p(95)<800'],
    'http_req_duration{scenario:read_load}':    [`p(95)<${P95_LIMIT_MS}`],
    'http_req_duration{scenario:write_load}':   [`p(95)<${P95_LIMIT_MS}`],

    // Infra failure rate (excludes 409 / 429 by construction)
    'http_infra_failures':                       [`rate<${INFRA_LIMIT}`],
    'http_infra_failures{scenario:read_load}':   [`rate<${INFRA_LIMIT}`],
    'http_infra_failures{scenario:write_load}':  [`rate<${INFRA_LIMIT}`],

    // All check() assertions must pass
    'checks{scenario:read_load}':                ['rate>0.99'],
    'checks{scenario:write_load}':               ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  // We don't set noConnectionReuse / noVUConnectionReuse — keep defaults.
};

// ============================================================================
// SETUP — runs ONCE before any VU starts
// ============================================================================

export function setup() {
  console.log(`[setup] fetching ${TOTAL_USERS} JWTs in batches of ${BATCH_SIZE}…`);
  const tokens = new Array(TOTAL_USERS);

  for (let start = 0; start < TOTAL_USERS; start += BATCH_SIZE) {
    const batch = [];
    for (let i = start; i < Math.min(start + BATCH_SIZE, TOTAL_USERS); i++) {
      batch.push({
        method: 'POST',
        url:    `${BASE_URL}/api/v1/auth/token`,
        body:   JSON.stringify({ userId: `user-${i + 1}` }),
        params: {
          headers: { 'Content-Type': 'application/json' },
          tags:    { name: 'auth_token_setup', expected_response: 'true' },
        },
      });
    }
    const responses = http.batch(batch);
    for (let j = 0; j < responses.length; j++) {
      const i  = start + j;
      const r  = responses[j];
      const ok = r.status === STATUS.OK && r.body && r.json().accessToken;
      if (!ok) {
        throw new Error(`[setup] failed to fetch JWT for user-${i + 1}: status=${r.status}`);
      }
      tokens[i] = r.json().accessToken;
    }
  }

  // Cache priming: hit every (page, limit) combination once so the first
  // seconds of `read_load` aren't dominated by cold-cache misses.
  let primed = 0;
  const seen = new Set();
  for (const limit of LIMIT_OPTIONS) {
    const maxPage = Math.ceil(TOTAL_PRODUCTS / limit);
    for (let page = 1; page <= maxPage; page++) {
      const key = `${page}:${limit}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const r = http.get(`${BASE_URL}/api/v1/products?page=${page}&limit=${limit}`, {
        tags: { name: 'cache_priming', expected_response: 'true' },
      });
      if (r.status === STATUS.OK) primed++;
    }
  }

  const baseline = fetchCacheStats();
  console.log(`[setup] tokens=${tokens.length} primed=${primed} baseline=${JSON.stringify(baseline)}`);

  // `tokens` and `baseline` are passed to every scenario fn + teardown + handleSummary.
  return { tokens, baseline };
}

// ============================================================================
// READ SCENARIO — used by both read_warmup and read_load
// ============================================================================

export function readScenario() {
  const { page, limit } = pickProductQuery();
  const res = http.get(
    `${BASE_URL}/api/v1/products?page=${page}&limit=${limit}`,
    buildParams({
      name:  'products',
      page:  String(page),
      limit: String(limit),
    }),
  );

  readTotal.add(1);
  if (isExpectedRead(res)) readOk.add(1);

  check(res, {
    'read: status 200':              (r) => r.status === STATUS.OK,
    'read: has data array':          (r) => Array.isArray(r.json('data')),
    'read: meta.totalPages is num':  (r) => typeof r.json('meta.totalPages') === 'number',
  });

  httpInfraFailures.add(!isExpectedRead(res));
}

// ============================================================================
// WRITE SCENARIO — used by write_load
// ============================================================================

export function writeScenario(data) {
  const userIdIdx = pickStableUserIndex();
  const token     = data.tokens[userIdIdx];
  const userId    = `user-${userIdIdx + 1}`;

  const iterations = pickWriteIterations();

  for (let i = 0; i < iterations; i++) {
    const params = buildParams({
      name:      'orders',
      user_id:   userId,
      iteration: String(i + 1),
    });
    params.headers = {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    };

    const res = http.post(
      `${BASE_URL}/api/v1/orders`,
      JSON.stringify({ productId: TARGET_PRODUCT }),
      params,
    );

    const expected = isExpectedWrite(res);
    httpInfraFailures.add(!expected);

    const ok = check(res, {
      'write: status in {202, 409, 429}': (r) => r.status === STATUS.ACCEPTED
                                              || r.status === STATUS.CONFLICT
                                              || r.status === STATUS.RATE_LIMITED,
    });
    if (!ok) continue;

    if (res.status === STATUS.ACCEPTED) {
      orderAccepted.add(1);
    } else if (res.status === STATUS.RATE_LIMITED) {
      orderRateLimited.add(1);
    } else if (res.status === STATUS.CONFLICT) {
      const reason = classifyConflict(res);
      if      (reason === 'sold_out')          orderSoldOut.add(1);
      else if (reason === 'already_purchased') orderAlreadyPurchased.add(1);
      else if (reason === 'locked')            orderLocked.add(1);
      else                                     orderOtherConflict.add(1);
    }
  }
}

// ============================================================================
// TEARDOWN — runs ONCE after all scenarios finish
// ============================================================================

export function teardown(data) {
  // Final cache snapshot for the report (one extra HTTP call, does not affect thresholds).
  const finalCacheStats = fetchCacheStats();
  console.log(`[teardown] finalCache=${JSON.stringify(finalCacheStats)}`);
  return { finalCacheStats };
}

// ============================================================================
// HANDLE SUMMARY — verdict + business counters + standard k6 table
// ============================================================================

/** Pull a value out of a k6 metric blob with a default. */
function metricValue(metric, path, fallback) {
  try {
    const v = metric && metric.values && metric.values[path];
    return (v === undefined || v === null) ? fallback : v;
  } catch (_) {
    return fallback;
  }
}

/** Pick the value of a sub-metric like `http_req_duration{scenario:read_load}`. */
function subMetric(metrics, expr, path, fallback) {
  const m = metrics[expr];
  return metricValue(m, path, fallback);
}

function computeVerdict(data) {
  const accepted  = metricValue(data.metrics.order_accepted_total, 'count', 0);
  const infraRate = metricValue(data.metrics.http_infra_failures,   'rate',  0);
  const p95Read   = subMetric(data.metrics, 'http_req_duration{scenario:read_load}',  'p(95)', Infinity);
  const p95Write  = subMetric(data.metrics, 'http_req_duration{scenario:write_load}', 'p(95)', Infinity);
  const p95Warmup = subMetric(data.metrics, 'http_req_duration{scenario:read_warmup}', 'p(95)', Infinity);

  const reasons = [];
  if (accepted !== TARGET_STOCK) reasons.push(`accepted=${accepted} (expected ${TARGET_STOCK})`);
  if (infraRate > INFRA_LIMIT)   reasons.push(`infra=${(infraRate * 100).toFixed(2)}% (limit ${(INFRA_LIMIT * 100).toFixed(0)}%)`);
  if (p95Read  > P95_LIMIT_MS)   reasons.push(`read p95=${p95Read.toFixed(0)}ms (limit ${P95_LIMIT_MS}ms)`);
  if (p95Write > P95_LIMIT_MS)   reasons.push(`write p95=${p95Write.toFixed(0)}ms (limit ${P95_LIMIT_MS}ms)`);

  return {
    pass:     reasons.length === 0,
    reasons,
    metrics:  { accepted, infraRate, p95Read, p95Write, p95Warmup },
  };
}

function pad(s, n) { return String(s).padEnd(n); }
function padL(s, n) { return String(s).padStart(n); }

function buildBusinessBanner(data) {
  const v = computeVerdict(data);
  const m = data.metrics;

  const c = (k) => metricValue(m[k], 'count', 0);
  const accepted  = c('order_accepted_total');
  const soldOut   = c('order_sold_out_total');
  const purchased = c('order_already_purchased_total');
  const locked    = c('order_locked_total');
  const rateLim   = c('order_rate_limited_total');
  const other     = c('order_other_conflict_total');
  const infra     = metricValue(m.http_infra_failures, 'rate', 0);

  const writeTotal = accepted + soldOut + purchased + locked + rateLim + other;
  const verdictIcon = v.pass ? '✅ PASS' : '❌ FAIL';

  const lines = [];
  lines.push('');
  lines.push('============================================================');
  lines.push('  FLASH SALE LOAD TEST — BUSINESS VERDICT');
  lines.push('============================================================');
  lines.push(`  orders accepted         (HTTP 202) : ${padL(accepted,  5)}    [expect ${TARGET_STOCK}]`);
  lines.push(`  orders sold_out         (HTTP 409) : ${padL(soldOut,   5)}`);
  lines.push(`  orders already_purchased (HTTP 409): ${padL(purchased, 5)}`);
  lines.push(`  orders locked           (HTTP 409) : ${padL(locked,    5)}`);
  lines.push(`  orders rate_limited     (HTTP 429) : ${padL(rateLim,   5)}`);
  lines.push(`  orders other_conflict   (HTTP 409) : ${padL(other,     5)}`);
  lines.push(`  -------------------------------------------`);
  lines.push(`  write total                      : ${padL(writeTotal, 5)}`);
  lines.push(`  read requests (200)              : ${padL(c('read_ok_total'), 5)}`);
  lines.push(`  infra failure rate               : ${(infra * 100).toFixed(2).padStart(5)}%    [limit ${(INFRA_LIMIT * 100).toFixed(0)}%]`);
  lines.push(`  ---------------------------------------------------------------`);
  lines.push(`  read_load  p95                   : ${padL(v.metrics.p95Read.toFixed(0) + 'ms',  8)}    [limit ${P95_LIMIT_MS}ms]`);
  lines.push(`  write_load p95                   : ${padL(v.metrics.p95Write.toFixed(0) + 'ms', 8)}    [limit ${P95_LIMIT_MS}ms]`);
  lines.push(`  read_warmup p95 (excluded)       : ${padL(v.metrics.p95Warmup.toFixed(0) + 'ms', 8)}`);
  lines.push('============================================================');
  lines.push(`  VERDICT: ${verdictIcon}`);
  if (!v.pass) {
    for (const r of v.reasons) lines.push(`    - ${r}`);
  }
  lines.push('============================================================');
  return lines.join('\n');
}

export function handleSummary(data) {
  const banner = buildBusinessBanner(data);

  // Compact text-only version — useful for screenshotting into the report PDF.
  const businessTxt = [
    'FLASH SALE LOAD TEST — BUSINESS SUMMARY',
    '========================================',
    buildBusinessBanner(data)
      .split('\n')
      .filter((l) => !l.startsWith('==='))
      .join('\n'),
  ].join('\n');

  return {
    stdout: '\n' + banner + '\n\n' + textSummary(data, { indent: ' ', enableColors: true }),
    'loadtest/results/summary.json':   JSON.stringify(data, null, 2),
    'loadtest/results/business.txt':   businessTxt,
  };
}