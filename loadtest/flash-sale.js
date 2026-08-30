/**
 * k6 Load Test — Flash Sale System (Comprehensive Coverage)
 *
 * Run with:
 *   k6 run --env BASE_URL=http://localhost loadtest/flash-sale.js
 *
 * Phases (per spec):
 *   1. Setup   — fetch 500 unique JWTs (user-1 .. user-500)
 *   2. Read    — 1000 concurrent users, 30s, GET /api/v1/products
 *                Distributed limit range [5,10,15,20,25,50] + 5% overflow mix
 *   3. Write   — 500 concurrent users, 30s, POST /api/v1/orders for p-1001 only
 *                2-3 iterations per VU (double/triple click simulation)
 *
 * Cache keys generated (expected):
 *   - Normal: products:list:page:{1-4}:limit:{5,10,15,20,25,50}  (~11-14 keys)
 *   - Overflow: products:list:page:{5-34}:limit:*  +  limit:{51-100}  (~50 keys)
 *
 * Tags:
 *   - scenario: read_load | write_load
 *   - name: products | orders
 *   - expected_response: true (for 202/409 expected responses)
 *   - page / limit: query params used (for per-key analysis)
 */

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import exec from 'k6/execution';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.3/index.js';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const TOTAL_USERS = 500;
const USER_PREFIX = __ENV.USER_PREFIX || 'user-';
const TARGET_PRODUCT = 'p-1001';
const TOTAL_PRODUCTS = 20;
const OVERFLOW_RATE = 0.05;
const REQ_TIMEOUT = '10s';
const REQ_PARAMS = { timeout: REQ_TIMEOUT, tags: { expected_response: 'true' } };

const orderAccepted = new Counter('order_accepted_total');
const orderConflicted = new Counter('order_conflicted_total');
const orderThrottled = new Counter('orders_throttled_429');
const httpFailures = new Rate('http_infra_failures');

function isInfraFailure(res) {
  if (res.status === 0) return true;
  if (res.status >= 500) return true;
  if (res.status >= 400 && res.status !== 409 && res.status !== 429) return true;
  return false;
}

// 429 is the documented in-flight-lock response, not an infrastructure failure.
http.setResponseCallback(http.expectedStatuses(200, 202, 409, 429));

const LIMIT_OPTIONS = [5, 10, 15, 20, 25, 50];

function pickLimit() {
  return LIMIT_OPTIONS[Math.floor(Math.random() * LIMIT_OPTIONS.length)];
}

function pickValidPage(limit) {
  const maxPage = Math.ceil(TOTAL_PRODUCTS / limit);
  return Math.floor(Math.random() * maxPage) + 1;
}

function pickOverflowQuery() {
  if (Math.random() < 0.5) {
    const limit = pickLimit();
    const page = Math.floor(Math.random() * 30) + 5;
    return { page, limit };
  }
  return { page: 1, limit: Math.floor(Math.random() * 50) + 51 };
}

export const options = {
  scenarios: {
    read_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 500 },
        { duration: '5s', target: 1000 },
        { duration: '30s', target: 1000 },
        { duration: '5s', target: 0 },
      ],
      exec: 'readScenario',
      gracefulRampDown: '5s',
    },
    write_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 250 },
        { duration: '5s', target: 500 },
        { duration: '30s', target: 500 },
        { duration: '5s', target: 0 },
      ],
      startTime: '50s',
      exec: 'writeScenario',
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],
    'http_req_duration{scenario:read_load}': ['p(95)<500'],
    'http_req_duration{scenario:write_load}': ['p(95)<500'],
    http_infra_failures: ['rate<0.01'],
    'http_infra_failures{scenario:read_load}': ['rate<0.01'],
    'http_infra_failures{scenario:write_load}': ['rate<0.01'],
    checks: ['rate>0.99'],
    'checks{scenario:read_load}': ['rate>0.99'],
    'checks{scenario:write_load}': ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const tokens = [];
  for (let i = 1; i <= TOTAL_USERS; i++) {
    const res = http.post(
      `${BASE_URL}/api/v1/auth/token`,
      JSON.stringify({ userId: `${USER_PREFIX}${i}` }),
      { headers: { 'Content-Type': 'application/json' } },
    );
    if (res.status !== 200) {
      throw new Error(`Setup failed: cannot fetch JWT for ${USER_PREFIX}${i} (status=${res.status})`);
    }
    const body = res.json();
    if (!body.accessToken) {
      throw new Error(`Setup failed: no accessToken in response for ${USER_PREFIX}${i}`);
    }
    tokens.push(body.accessToken);
  }
  console.log(`Setup complete: fetched ${tokens.length} JWTs`);
  return { tokens };
}

export function readScenario() {
  let page;
  let limit;

  if (Math.random() < OVERFLOW_RATE) {
    const o = pickOverflowQuery();
    page = o.page;
    limit = o.limit;
  } else {
    limit = pickLimit();
    page = pickValidPage(limit);
  }

  const res = http.get(
    `${BASE_URL}/api/v1/products?page=${page}&limit=${limit}`,
    {
      ...REQ_PARAMS,
      tags: {
        ...REQ_PARAMS.tags,
        name: 'products',
        page: String(page),
        limit: String(limit),
      },
    },
  );

  check(res, {
    'status is 200': (r) => r.status === 200,
    'has meta object': (r) => {
      try {
        const j = r.json();
        return j && typeof j.meta === 'object';
      } catch {
        return false;
      }
    },
  });
  httpFailures.add(isInfraFailure(res));
}

export function writeScenario(data) {
  const vuId = (exec.vu.idInTest - 1) % TOTAL_USERS;
  const token = data.tokens[vuId];

  const iterations = Math.random() < 0.5 ? 2 : 3;

  for (let i = 0; i < iterations; i++) {
    const res = http.post(
      `${BASE_URL}/api/v1/orders`,
      JSON.stringify({ productId: TARGET_PRODUCT }),
      {
        ...REQ_PARAMS,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        tags: {
          ...REQ_PARAMS.tags,
          name: 'orders',
        },
      },
    );
    const ok = check(res, {
      'status is 202, 409, or 429': (r) =>
        r.status === 202 || r.status === 409 || r.status === 429,
    });
    httpFailures.add(isInfraFailure(res));
    if (!ok) continue;
    if (res.status === 202) orderAccepted.add(1);
    else if (res.status === 409) orderConflicted.add(1);
    else if (res.status === 429) orderThrottled.add(1);
  }
}

export function handleSummary(data) {
  const accepted = data.metrics.order_accepted_total?.values?.count ?? 0;
  const conflicted = data.metrics.order_conflicted_total?.values?.count ?? 0;
  const throttled = data.metrics.orders_throttled_429?.values?.count ?? 0;
  const infraRate = data.metrics.http_infra_failures?.values?.rate ?? 0;

  const banner = [
    '',
    '============================================================',
    '  FLASH SALE LOAD TEST — BUSINESS SUMMARY',
    '============================================================',
  `  orders accepted (HTTP 202) .........: ${accepted}`,
  `  orders conflicted (HTTP 409) .......: ${conflicted}`,
  `  orders throttled (HTTP 429) ........: ${throttled}`,
    `  infra failure rate (5xx/timeout/4xx): ${(infraRate * 100).toFixed(2)}%`,
    '============================================================',
    '',
  ].join('\n');

  return {
    stdout: banner + '\n' + textSummary(data, { indent: ' ', enableColors: true }),
  };
}
