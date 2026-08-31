#!/usr/bin/env node
/**
 * Repeatable all-in-one k6 runner for the Flash Sale System.
 *
 * Each profile gets an isolated run directory containing its k6 summary,
 * console log, post-drain integrity snapshot, and a normalized result row.
 * The runner collects every profile by default so a benchmark produces one
 * comparable matrix. Set LOADTEST_FAIL_FAST=yes while diagnosing a broken
 * environment and you want to stop at the first failed gate.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const baseUrl = (process.argv[2] || process.env.BASE_URL || 'http://localhost:8080')
  .replace(/\/+$/, '');
const resultsRoot = path.join(__dirname, 'results');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.join(resultsRoot, runId);
const lockPath = path.join(resultsRoot, '.run.lock');
const appContainer = process.env.LOADTEST_APP_CONTAINER || 'fs-app-1';
const k6Binary = process.env.K6_BIN || 'k6';
const adminUser = process.env.LOADTEST_ADMIN_USER || 'admin';
const adminPassword = process.env.LOADTEST_ADMIN_PASSWORD || 'admin';
const failFast = process.env.LOADTEST_FAIL_FAST === 'yes';
const readyTimeoutMs = Number(process.env.LOADTEST_READY_TIMEOUT_MS || 30_000);
const drainTimeoutMs = Number(process.env.LOADTEST_DRAIN_TIMEOUT_MS || 60_000);

const tests = [
  {
    id: '01-main-deliverable',
    name: 'Main Deliverable',
    file: 'loadtest.js',
    description: 'Read 1,000 VUs (60s) + Write 500 VUs (3 iterations)',
  },
  {
    id: '02-comprehensive-cache',
    name: 'Comprehensive Cache',
    file: path.join('loadtest', 'flash-sale.js'),
    description: 'Distributed page/limit cache coverage + Write 500 VUs',
  },
  {
    id: '03-normal-workload',
    name: 'Normal Workload',
    file: path.join('loadtest', 'test_by_ao', 'testBuyAo_n.js'),
    description: 'Read 1,000 VUs (30s) + Write 500 VUs (3 iterations)',
  },
  {
    id: '04-max-ramping',
    name: 'Max Ramping',
    file: path.join('loadtest', 'test_by_ao', 'testBuyAo_f.js'),
    description: 'Ramp to 1,500 Read VUs + Write 500 VUs',
  },
];

fs.mkdirSync(runDir, { recursive: true });

let ownsRunLock = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function activeK6Pids() {
  if (process.platform === 'win32') {
    const result = spawnSync('tasklist', ['/FI', 'IMAGENAME eq k6.exe', '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
    });
    if (result.status !== 0) return [];
    return result.stdout
      .split(/\r?\n/)
      .filter((line) => /^"k6\.exe"/i.test(line))
      .map((line) => Number(line.split('","')[1]))
      .filter((pid) => Number.isInteger(pid));
  }

  const result = spawnSync('pgrep', ['-x', 'k6'], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((value) => Number(value.trim()))
    .filter((pid) => Number.isInteger(pid));
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireRunLock() {
  if (activeK6Pids().length > 0) {
    throw new Error(
      'A k6 process is already running. Stop it or wait for it to finish before starting a clean comparison.',
    );
  }

  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, runId, startedAt: new Date().toISOString() }));
    fs.closeSync(fd);
    ownsRunLock = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let existing = {};
    try {
      existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch {
      // A malformed lock cannot identify a live runner; replace it safely.
    }
    if (Number.isInteger(existing.pid) && processIsAlive(existing.pid)) {
      throw new Error(
        `Another load-test runner is active (pid ${existing.pid}, started ${existing.startedAt ?? 'unknown'}).`,
      );
    }
    fs.rmSync(lockPath, { force: true });
    acquireRunLock();
  }
}

function releaseRunLock() {
  if (!ownsRunLock) return;
  fs.rmSync(lockPath, { force: true });
  ownsRunLock = false;
}

process.once('exit', releaseRunLock);

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: rootDir,
    encoding: 'utf8',
    ...options,
  });
  if (result.error) {
    throw new Error(`${binary} could not start: ${result.error.message}`);
  }
  return result;
}

function detectContainerEngine() {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {}
  if (parsed && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    return 'remote-ssh';
  }
  for (const candidate of ['podman', 'docker']) {
    try {
      const result = command(candidate, ['info'], { stdio: 'ignore' });
      if (result.status === 0) return candidate;
    } catch {
      // Try the other supported engine.
    }
  }
  throw new Error('Neither a usable Podman nor Docker engine is available.');
}

function request(url, { method = 'GET', auth = false, timeoutMs = 3_000 } = {}) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      resolve({ status: 0, body: '', error: error.message });
      return;
    }

    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        timeout: timeoutMs,
        headers: auth
          ? { Authorization: `Basic ${Buffer.from(`${adminUser}:${adminPassword}`).toString('base64')}` }
          : undefined,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode || 0, body }));
      },
    );
    req.on('error', (error) => resolve({ status: 0, body: '', error: error.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: '', error: 'request timed out' });
    });
    req.end();
  });
}

async function waitForReady() {
  const deadline = Date.now() + readyTimeoutMs;
  let last = { status: 0, error: 'not requested' };
  while (Date.now() < deadline) {
    last = await request(`${baseUrl}/health/ready`);
    if (last.status === 200) return;
    await sleep(1_000);
  }
  throw new Error(
    `Readiness probe did not return 200 within ${readyTimeoutMs / 1_000}s ` +
      `(last status=${last.status}${last.error ? `, ${last.error}` : ''}).`,
  );
}

async function resetMetrics() {
  const response = await request(`${baseUrl}/admin/metrics/reset`, {
    method: 'POST',
    auth: true,
  });
  if (response.status !== 200 && response.status !== 404) {
    throw new Error(
      `Could not reset observability metrics (status=${response.status}${
        response.error ? `, ${response.error}` : ''
      }).`,
    );
  }
}

function resetBusinessData(engine) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {}
  if (parsed && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    const remoteCmd = `ssh cloud@${parsed.hostname} "docker exec -i -e RESET_CONFIRM=yes ${appContainer} node dist/database/reset.js && docker exec -i fs-redis-cache redis-cli FLUSHDB"`;
    const result = spawnSync(remoteCmd, { shell: true, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(
        `Reset failed on remote host via SSH: ${result.stderr || result.stdout || `exit ${result.status}`}`,
      );
    }
    return;
  }
  const result = command(engine, [
    'exec',
    '-e',
    'RESET_CONFIRM=yes',
    appContainer,
    'node',
    'dist/database/reset.js',
  ]);
  if (result.status !== 0) {
    throw new Error(
      `Reset failed in ${appContainer}: ${result.stderr || result.stdout || `exit ${result.status}`}`,
    );
  }
}

function parseInsights(body) {
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`Insights endpoint returned invalid JSON: ${error.message}`);
  }
}

async function waitForQueueDrain() {
  const deadline = Date.now() + drainTimeoutMs;
  let lastError = 'not requested';
  while (Date.now() < deadline) {
    const response = await request(`${baseUrl}/admin/insights.json`, { auth: true });
    if (response.status === 200) {
      const snapshot = parseInsights(response.body);
      if (snapshot.integrity?.queueDrained === true) return snapshot;
      lastError = 'queue still has waiting, active, or delayed jobs';
    } else {
      lastError = `insights status=${response.status}${response.error ? `, ${response.error}` : ''}`;
    }
    await sleep(1_000);
  }
  throw new Error(`Queue did not drain within ${drainTimeoutMs / 1_000}s (${lastError}).`);
}

function metricValues(summary, names) {
  for (const name of names) {
    const metric = summary?.metrics?.[name];
    if (metric?.values) return metric.values; // k6 v0.x / v1 summary export
    if (metric && typeof metric === 'object') return metric; // k6 v2 summary export
  }
  return null;
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function counterOrZero(metric) {
  return numberOrNull(metric?.count) ?? 0;
}

function percentOrNull(rate) {
  const value = numberOrNull(rate);
  return value === null ? null : Math.round(value * 10_000) / 100;
}

function rateValue(metric) {
  // k6 v0.x/v1 expose rates as `rate`; k6 v2 exports them as `value`.
  return metric?.rate ?? metric?.value;
}

function summarizeK6(summary) {
  const requests = metricValues(summary, ['http_reqs']);
  const duration = metricValues(summary, ['http_req_duration']);
  const failed = metricValues(summary, ['http_req_failed']);
  const checks = metricValues(summary, ['checks']);
  const infra = metricValues(summary, [
    'http_infra_failures',
    'infra_failures',
    'orders_infrastructure_error',
  ]);
  const accepted = metricValues(summary, [
    'orders_accepted_202',
    'order_accepted_total',
    'orders_202',
    'orders_accepted',
  ]);
  const conflict = metricValues(summary, [
    'orders_conflict_409',
    'order_conflicted_total',
    'orders_409',
    'orders_soldout',
  ]);
  const throttled = metricValues(summary, ['orders_throttled_429']);

  return {
    requests: numberOrNull(requests?.count),
    rps: numberOrNull(requests?.rate),
    latencyMs: {
      average: numberOrNull(duration?.avg),
      p95: numberOrNull(duration?.['p(95)']),
      p99: numberOrNull(duration?.['p(99)']),
      max: numberOrNull(duration?.max),
    },
    httpFailedPercent: percentOrNull(rateValue(failed)),
    infrastructureFailurePercent: percentOrNull(rateValue(infra)),
    checksPercent: percentOrNull(rateValue(checks)),
    ordersAccepted: counterOrZero(accepted),
    ordersConflict409: counterOrZero(conflict),
    ordersThrottled429: counterOrZero(throttled),
  };
}

function verifyIntegrity(snapshot) {
  const report = snapshot?.integrity;
  const product = report?.products?.find((row) => row.productId === 'p-1001');
  const reasons = [];

  if (!report?.queueDrained) reasons.push('BullMQ queue is not drained');
  if (report?.verdict !== 'ok') reasons.push(`integrity verdict is ${report?.verdict ?? 'missing'}`);
  if (!product) {
    reasons.push('p-1001 is absent from integrity report');
  } else {
    if (product.dbRemaining !== 0) reasons.push(`DB remaining_stock is ${product.dbRemaining}, expected 0`);
    if (product.redisRemaining !== 0)
      reasons.push(`Redis stock counter is ${product.redisRemaining}, expected 0`);
    if (product.orders !== 50) reasons.push(`orders is ${product.orders}, expected 50`);
    if (product.buyers !== 50) reasons.push(`unique buyers is ${product.buyers}, expected 50`);
  }

  return { passed: reasons.length === 0, reasons };
}

function writeReports(report) {
  writeJson(path.join(runDir, 'run-report.json'), report);

  const rows = report.profiles
    .map(
      (profile) =>
        `| ${profile.name} | ${profile.k6?.rps?.toFixed?.(2) ?? 'n/a'} | ${
          profile.k6?.latencyMs?.p95?.toFixed?.(2) ?? 'n/a'
        } | ${profile.k6?.infrastructureFailurePercent ?? 'n/a'}% | ${
          profile.k6?.checksPercent ?? 'n/a'
        }% | ${profile.integrity?.passed ? 'PASS' : 'FAIL'} | ${profile.status} |`,
    )
    .join('\n');
  fs.writeFileSync(
    path.join(runDir, 'comparison.md'),
    `# Load-test comparison\n\n` +
      `- Target: ${baseUrl}\n` +
      `- Started: ${report.startedAt}\n` +
      `- Container engine: ${report.engine}\n` +
      `- Final status: ${report.status}\n\n` +
      `| Profile | RPS | p95 (ms) | Infra failure | Checks | Integrity | Runner |\n` +
      `| :-- | --: | --: | --: | --: | :-- | :-- |\n${rows}\n`,
  );
}

function runK6(test, profileDir, userPrefix) {
  const summaryPath = path.join(profileDir, 'k6-summary.json');
  const handleSummaryPath = path.join(profileDir, 'k6-handle-summary.json');
  const logPath = path.join(profileDir, 'k6.log');
  const logFd = fs.openSync(logPath, 'w');
  const result = spawnSync(
    k6Binary,
    [
      'run',
      '--env',
      `BASE_URL=${baseUrl}`,
      '--env',
      `SUMMARY_PATH=${handleSummaryPath}`,
      '--env',
      `USER_PREFIX=${userPrefix}`,
      '--summary-export',
      summaryPath,
      test.file,
    ],
    { cwd: rootDir, stdio: ['ignore', logFd, logFd] },
  );
  fs.closeSync(logFd);
  if (result.error) throw new Error(`k6 could not start: ${result.error.message}`);
  if (!fs.existsSync(summaryPath)) {
    throw new Error(`k6 did not produce ${path.basename(summaryPath)} (exit ${result.status}).`);
  }
  return {
    exitCode: result.status,
    summaryPath: path.basename(summaryPath),
    logPath: path.basename(logPath),
    summary: JSON.parse(fs.readFileSync(summaryPath, 'utf8')),
  };
}

async function run() {
  const engine = detectContainerEngine();
  acquireRunLock();
  const report = {
    startedAt: new Date().toISOString(),
    target: baseUrl,
    engine,
    profiles: [],
    status: 'RUNNING',
  };

  console.log(`Run directory: ${runDir}`);
  console.log(`Target: ${baseUrl} · Engine: ${engine}`);
  console.log(`Mode: ${failFast ? 'fail fast' : 'collect all profiles'}`);

  await waitForReady();

  for (const [index, test] of tests.entries()) {
    const profileDir = path.join(runDir, test.id);
    fs.mkdirSync(profileDir, { recursive: true });
    const profile = {
      index: index + 1,
      name: test.name,
      file: test.file,
      description: test.description,
      // Reset intentionally preserves BullMQ history. A unique identity domain
      // prevents deterministic order jobIds from colliding with prior profiles.
      userPrefix: `lt-${runId.replace(/[^a-zA-Z0-9]/g, '')}-${String(index + 1).padStart(2, '0')}-`,
      startedAt: new Date().toISOString(),
      status: 'RUNNING',
    };
    report.profiles.push(profile);
    writeReports(report);

    console.log(`\n[${profile.index}/${tests.length}] ${test.name}`);
    try {
      console.log('  1. Resetting orders and stock...');
      resetBusinessData(engine);
      await waitForReady();

      console.log('  2. Resetting observability metrics...');
      await resetMetrics();

      console.log(`  3. Running k6; log: ${path.join(test.id, 'k6.log')}`);
      const k6 = runK6(test, profileDir, profile.userPrefix);
      profile.k6 = { exitCode: k6.exitCode, ...summarizeK6(k6.summary) };
      profile.artifacts = {
        k6Summary: path.join(test.id, k6.summaryPath),
        k6Log: path.join(test.id, k6.logPath),
      };

      console.log('  4. Waiting for BullMQ to drain, then verifying integrity...');
      const snapshot = await waitForQueueDrain();
      writeJson(path.join(profileDir, 'integrity.json'), snapshot);
      profile.integrity = verifyIntegrity(snapshot);
      profile.artifacts.integrity = path.join(test.id, 'integrity.json');

      const k6Passed = k6.exitCode === 0;
      profile.status = k6Passed && profile.integrity.passed ? 'PASSED' : 'FAILED';
      if (!k6Passed) profile.error = `k6 thresholds failed (exit ${k6.exitCode})`;
      if (!profile.integrity.passed) {
        profile.error = [profile.error, ...profile.integrity.reasons].filter(Boolean).join('; ');
      }
      console.log(`  Result: ${profile.status}`);
    } catch (error) {
      profile.status = 'FAILED';
      profile.error = error instanceof Error ? error.message : String(error);
      console.error(`  Result: FAILED — ${profile.error}`);
    }

    profile.finishedAt = new Date().toISOString();
    writeReports(report);
    if (profile.status === 'FAILED' && failFast) break;
  }

  report.status = report.profiles.every((profile) => profile.status === 'PASSED')
    ? 'PASSED'
    : 'FAILED';
  report.finishedAt = new Date().toISOString();
  writeReports(report);
  console.log(`\nFinal result: ${report.status}`);
  console.log(`Artifacts: ${runDir}`);
  process.exitCode = report.status === 'PASSED' ? 0 : 1;
}

run().catch((error) => {
  console.error(`Fatal runner error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
