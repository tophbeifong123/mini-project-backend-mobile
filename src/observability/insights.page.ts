import { BOARD_LOGO } from '../bull_board/bull-board.theme';

/**
 * หน้า `/admin/insights` — HTML ก้อนเดียวจบ
 *
 * ⚠️ ห้ามอ้าง CDN / ฟอนต์ / ไลบรารีจากภายนอกเด็ดขาด
 *    container ตอนสาธิตอาจไม่มีเน็ต และ nginx ก็ไม่ได้เปิดทางออกให้
 *    ทุกอย่างต้อง inline: ไม่มี build step ไม่มี asset route
 *
 * สีของกราฟไม่ได้ใช้ธีมกุหลาบของ Bull-Board:
 *   - แท่งทั้งหมดเป็น "ชุดข้อมูลเดียว" (จำนวนครั้งแยกตามผลลัพธ์) จึงใช้ **สีเดียว**
 *     การไล่สีรุ้งต่อหมวดคือ anti-pattern ที่ทำให้คนอ่านนึกว่าสีมีความหมาย
 *   - สีสถานะ (เขียว/เหลือง/แดง) สงวนไว้บอก "สถานะ" เท่านั้น และมาคู่กับไอคอน+ข้อความเสมอ
 *     เพื่อให้คนตาบอดสีอ่านได้ไม่ต่างกัน
 */
export function renderInsightsPage(params: {
  instanceId: string;
  nodeEnv: string;
  queuesPath: string;
}): string {
  const badge = `${escapeHtml(params.nodeEnv)} · ${escapeHtml(params.instanceId)}`;

  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Flash Sale · Insights</title>
<link rel="icon" href="${BOARD_LOGO}">
<style>
:root {
  color-scheme: light;
  --page: #f5f6f8;
  --surface: #ffffff;
  --surface-2: #f1f5f9;
  --ink: #0f172a;
  --ink-2: #52525b;
  --muted: #7c8798;
  --border: #e2e8f0;
  --accent: #e11d48;
  --bar: #2a78d6;
  --good: #0ca30c;
  --warning: #fab219;
  --critical: #d03b3b;
  --radius: 0.7rem;
  --sidebar: #0f172a;
  --sidebar-ink: #cbd5e1;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --page: #0b1120;
    --surface: #111a2e;
    --surface-2: #172033;
    --ink: #e2e8f0;
    --ink-2: #b8c2d0;
    --muted: #8b96a8;
    --border: #1e293b;
    --accent: #fb7185;
    --bar: #3987e5;
    --sidebar: #070c17;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--page);
  color: var(--ink);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Noto Sans Thai", Roboto, sans-serif;
}
header {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 12px 20px; background: var(--sidebar); color: #f8fafc;
}
header img { width: 26px; height: 26px; display: block; }
header h1 { font-size: 15px; margin: 0; font-weight: 650; letter-spacing: .2px; }
header .spacer { flex: 1; }
header a, header button {
  color: #e2e8f0; background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.14);
  border-radius: 6px; padding: 5px 10px; font: inherit; font-size: 12px; text-decoration: none; cursor: pointer;
}
header a:hover, header button:hover { background: rgba(255,255,255,.16); }
.env {
  background: var(--accent); color: #fff; border-radius: 999px;
  padding: 3px 10px; font-size: 11px; font-weight: 600; letter-spacing: .3px;
}
main { padding: 20px; max-width: 1240px; margin: 0 auto; display: grid; gap: 16px; }
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 16px;
}
.card h2 {
  margin: 0 0 4px; font-size: 13px; font-weight: 650; letter-spacing: .3px;
  text-transform: uppercase; color: var(--muted);
}
.card p.hint { margin: 0 0 14px; color: var(--muted); font-size: 12px; }
.grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); }
.tiles { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.tile { background: var(--surface-2); border-radius: 10px; padding: 12px 14px; }
.tile .label { color: var(--muted); font-size: 12px; }
.tile .value { font-size: 24px; font-weight: 650; margin-top: 2px; }
.tile .sub { color: var(--ink-2); font-size: 12px; margin-top: 2px; }
.hero { display: flex; gap: 14px; align-items: flex-start; }
.hero .dot { width: 14px; height: 14px; border-radius: 50%; margin-top: 5px; flex: none; }
.hero .headline { font-size: 20px; font-weight: 650; }
.hero .detail { color: var(--ink-2); margin-top: 4px; }
.bars { display: flex; flex-direction: column; gap: 2px; }
.bar-row { display: grid; grid-template-columns: minmax(150px, 220px) 1fr auto; gap: 10px; align-items: center; padding: 3px 0; }
.bar-label { color: var(--ink-2); font-size: 13px; }
.bar-track { background: var(--surface-2); border-radius: 4px; height: 16px; position: relative; }
.bar-fill { background: var(--bar); height: 100%; border-radius: 0 4px 4px 0; min-width: 2px; }
.bar-value { font-variant-numeric: tabular-nums; font-weight: 600; min-width: 62px; text-align: right; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { text-align: right; padding: 7px 8px; border-bottom: 1px solid var(--border); font-size: 13px; }
th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .4px; }
th:first-child, td:first-child { text-align: left; }
td.note { text-align: left; color: var(--ink-2); font-size: 12px; }
.pill { display: inline-flex; align-items: center; gap: 5px; border-radius: 999px; padding: 2px 9px; font-size: 12px; font-weight: 600; color: var(--ink); }
.pill .dot, td .dot { width: 8px; height: 8px; border-radius: 50%; }
.scroll { overflow-x: auto; }
.stale { color: var(--muted); }
#tooltip {
  position: fixed; pointer-events: none; z-index: 20; opacity: 0;
  background: var(--sidebar); color: #f8fafc; border-radius: 6px;
  padding: 6px 9px; font-size: 12px; transition: opacity .1s; white-space: nowrap;
}
footer { padding: 0 20px 28px; max-width: 1240px; margin: 0 auto; color: var(--muted); font-size: 12px; }
footer a { color: var(--accent); }
.err { color: var(--critical); font-weight: 600; }
</style>
</head>
<body>
<header>
  <img src="${BOARD_LOGO}" alt="">
  <h1>Flash Sale · Insights</h1>
  <span class="env">${badge}</span>
  <span class="spacer"></span>
  <span id="updated" style="font-size:12px;color:#94a3b8"></span>
  <button id="toggle" type="button">หยุดรีเฟรช</button>
  <a href="${escapeHtml(params.queuesPath)}">← Queues</a>
</header>

<main>
  <section class="card">
    <h2>Data Integrity</h2>
    <p class="hint">เทียบ Redis counter กับ DB สดๆ — แทนการรัน §9.3 ด้วยมือ · อ่านจาก primary เท่านั้น</p>
    <div class="hero">
      <span class="dot" id="verdict-dot"></span>
      <div>
        <div class="headline" id="verdict-headline">กำลังโหลด…</div>
        <div class="detail" id="verdict-detail"></div>
      </div>
    </div>
    <div class="tiles" style="margin-top:16px" id="integrity-tiles"></div>
  </section>

  <section class="card">
    <h2>ผลลัพธ์ของคำขอสั่งซื้อ</h2>
    <p class="hint">นับฝั่ง server ทั้ง 6 instance รวมกัน — 409/429 คือพฤติกรรมที่ถูกต้อง ไม่ใช่ error</p>
    <div class="bars" id="order-bars"></div>
  </section>

  <div class="grid">
    <section class="card">
      <h2>Worker</h2>
      <p class="hint">ผลของ job ที่ประมวลผลไปแล้ว</p>
      <div class="bars" id="worker-bars"></div>
      <div class="sub" id="worker-avg" style="margin-top:12px;color:var(--muted);font-size:12px"></div>
    </section>
    <section class="card">
      <h2>Read path &amp; คิว</h2>
      <p class="hint">แคช catalog และสถานะคิว BullMQ</p>
      <div class="tiles" id="read-tiles"></div>
    </section>
  </div>

  <section class="card">
    <h2>โครงสร้างพื้นฐาน</h2>
    <p class="hint">Redis สองตัว · replication lag ของ replica · pool ของ primary</p>
    <div class="tiles" id="infra-tiles"></div>
  </section>

  <section class="card">
    <h2>สินค้า</h2>
    <p class="hint">drift = Redis − DB · ติดลบระหว่างมี job ค้าง = ปกติ · เป็นบวก = อันตราย</p>
    <div class="scroll"><table id="products"></table></div>
  </section>

  <section class="card">
    <h2>Instances</h2>
    <p class="hint">event loop p99 คือสัญญาณเตือน job stall (เกิน 30 วิ = BullMQ ทิ้ง job โดยไม่ชดเชย)</p>
    <div class="scroll"><table id="instances"></table></div>
  </section>
</main>

<footer>
  ตัวนับสะสมอยู่บน redis-data (<code>metrics:counters</code>) · ดูแบบ Prometheus ได้ที่
  <a href="metrics">/admin/metrics</a> · ล้างตัวนับก่อนยิงรอบใหม่:
  <code>curl -u admin:admin -X POST http://localhost:8080/admin/metrics/reset</code>
</footer>

<div id="tooltip"></div>

<script>
(function () {
  var STATUS = { ok: '#0ca30c', warn: '#fab219', critical: '#d03b3b', unknown: '#7c8798' };
  var ICON = { ok: '✓', warn: '!', critical: '✕', unknown: '?' };
  var WORD = { ok: 'ปกติ', warn: 'ต้องดู', critical: 'วิกฤต', unknown: 'ไม่ทราบ' };
  var paused = false;
  var timer = null;
  var tooltip = document.getElementById('tooltip');

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
  }
  function num(value) {
    return value == null ? '—' : Number(value).toLocaleString('en-US');
  }
  // ตัวอักษรอยู่ในสีหมึกปกติเสมอ สีสถานะอยู่ที่จุดกลมอย่างเดียว
  // (เหลือง #fab219 บนพื้นสว่างได้คอนทราสต์แค่ 1.8:1 — ใช้เป็นสีตัวหนังสือไม่ได้)
  function pill(verdict) {
    return '<span class="pill" style="background:' + STATUS[verdict] + '22">' +
      '<span class="dot" style="background:' + STATUS[verdict] + '"></span>' +
      ICON[verdict] + ' ' + WORD[verdict] + '</span>';
  }
  function tile(label, value, sub) {
    return '<div class="tile"><div class="label">' + esc(label) + '</div>' +
      '<div class="value">' + value + '</div>' +
      '<div class="sub">' + (sub == null ? '' : sub) + '</div></div>';
  }

  // แท่งทั้งชุดเป็นข้อมูลชุดเดียว จึงใช้สีเดียวกันหมดโดยตั้งใจ
  function bars(target, rows) {
    var max = rows.reduce(function (acc, row) { return Math.max(acc, row.value); }, 0);
    var total = rows.reduce(function (acc, row) { return acc + row.value; }, 0);
    target.innerHTML = rows.map(function (row) {
      var width = max > 0 ? (row.value / max) * 100 : 0;
      var share = total > 0 ? ((row.value / total) * 100).toFixed(1) + '%' : '0%';
      return '<div class="bar-row" data-label="' + esc(row.label) + '" data-value="' + row.value +
        '" data-share="' + share + '">' +
        '<div class="bar-label">' + esc(row.label) + '</div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + width.toFixed(2) + '%' +
        (row.status ? ';background:' + STATUS[row.status] : '') + '"></div></div>' +
        '<div class="bar-value">' + num(row.value) + '</div></div>';
    }).join('');
  }

  document.addEventListener('mousemove', function (event) {
    var row = event.target.closest ? event.target.closest('.bar-row') : null;
    if (!row) { tooltip.style.opacity = 0; return; }
    tooltip.innerHTML = esc(row.dataset.label) + ' · ' + num(Number(row.dataset.value)) +
      ' ครั้ง · ' + row.dataset.share;
    tooltip.style.opacity = 1;
    tooltip.style.left = (event.clientX + 14) + 'px';
    tooltip.style.top = (event.clientY + 16) + 'px';
  });

  function renderIntegrity(report) {
    document.getElementById('verdict-dot').style.background = STATUS[report.verdict];
    document.getElementById('verdict-headline').textContent =
      ICON[report.verdict] + ' ' + WORD[report.verdict] + ' — ' + report.headline;
    document.getElementById('verdict-detail').textContent =
      'ตรวจเมื่อ ' + new Date(report.generatedAt).toLocaleTimeString('th-TH') +
      (report.queueDrained ? ' · คิวว่างแล้ว (ตัวเลขนิ่ง)' : ' · ยังมี job ค้างในคิว');

    var sold = report.totals.availableStock - report.totals.dbRemaining;
    var oversell = report.products.filter(function (row) {
      return row.orders > row.availableStock || row.dbRemaining < 0;
    }).length;
    var dupes = report.products.filter(function (row) { return row.orders !== row.buyers; }).length;

    document.getElementById('integrity-tiles').innerHTML =
      tile('ขายไปแล้ว', num(sold) + ' / ' + num(report.totals.availableStock), 'จาก remaining_stock ใน DB') +
      tile('order ในตาราง', num(report.totals.orders), num(report.totals.buyers) + ' ผู้ซื้อไม่ซ้ำ') +
      tile('oversell', oversell === 0 ? '0' : '<span class="err">' + oversell + '</span>', 'สินค้าที่ขายเกินของที่มี') +
      tile('ซื้อซ้ำ', dupes === 0 ? '0' : '<span class="err">' + dupes + '</span>', 'สินค้าที่มีคนได้เกิน 1 ชิ้น');
  }

  function renderProducts(report) {
    var rows = report.products.slice().sort(function (a, b) {
      var rank = { critical: 0, warn: 1, unknown: 2, ok: 3 };
      if (rank[a.verdict] !== rank[b.verdict]) return rank[a.verdict] - rank[b.verdict];
      return a.productId.localeCompare(b.productId);
    });
    document.getElementById('products').innerHTML =
      '<thead><tr><th>สินค้า</th><th>available</th><th>DB remaining</th><th>Redis</th>' +
      '<th>drift</th><th>orders</th><th>buyers</th><th>สถานะ</th><th style="text-align:left">หมายเหตุ</th></tr></thead><tbody>' +
      rows.map(function (row) {
        return '<tr><td>' + esc(row.productId) + '</td>' +
          '<td>' + num(row.availableStock) + '</td>' +
          '<td>' + num(row.dbRemaining) + '</td>' +
          '<td>' + num(row.redisRemaining) + '</td>' +
          '<td>' + (row.drift == null ? '—' : (row.drift > 0 ? '+' : '') + row.drift) + '</td>' +
          '<td>' + num(row.orders) + '</td>' +
          '<td>' + num(row.buyers) + '</td>' +
          '<td>' + pill(row.verdict) + '</td>' +
          '<td class="note">' + esc(row.notes.join(' · ')) + '</td></tr>';
      }).join('') + '</tbody>';
  }

  function renderInstances(instances) {
    document.getElementById('instances').innerHTML =
      '<thead><tr><th>instance</th><th>pid</th><th>uptime</th><th>RSS (MB)</th>' +
      '<th>heap (MB)</th><th>event loop p99 (ms)</th><th>สูงสุด (ms)</th><th>heartbeat</th></tr></thead><tbody>' +
      instances.map(function (row) {
        var age = Math.round((Date.now() - row.updatedAt) / 1000);
        var stale = age > 15;
        var lagVerdict = row.eventLoopP99Ms > 200 ? 'critical' : (row.eventLoopP99Ms > 50 ? 'warn' : 'ok');
        return '<tr' + (stale ? ' class="stale"' : '') + '><td>' + esc(row.instanceId) + '</td>' +
          '<td>' + num(row.pid) + '</td>' +
          '<td>' + num(row.uptimeSeconds) + ' s</td>' +
          '<td>' + row.rssMb + '</td>' +
          '<td>' + row.heapUsedMb + '</td>' +
          '<td style="font-weight:600"><span class="dot" style="display:inline-block;background:' +
          STATUS[lagVerdict] + '"></span> ' + row.eventLoopP99Ms + '</td>' +
          '<td>' + row.eventLoopMaxMs + '</td>' +
          '<td>' + (stale ? 'ไม่ตอบ ' + age + ' วิ' : age + ' วิที่แล้ว') + '</td></tr>';
      }).join('') + '</tbody>';
  }

  function renderInfra(report) {
    var cache = report.redis.filter(function (r) { return r.role === 'cache'; })[0] || {};
    var data = report.redis.filter(function (r) { return r.role === 'data'; })[0] || {};
    var lag = report.replicationLagSeconds;
    var evicted = data.evictedKeys;
    document.getElementById('infra-tiles').innerHTML =
      tile('redis-cache hit ratio',
        cache.hitRatio == null ? '—' : cache.hitRatio + '%',
        num(cache.keyspaceHits) + ' hit / ' + num(cache.keyspaceMisses) + ' miss') +
      tile('redis-cache', num(cache.opsPerSecond) + ' ops/s',
        (cache.usedMemoryMb == null ? '—' : cache.usedMemoryMb + ' MB') + ' · evicted ' + num(cache.evictedKeys)) +
      tile('redis-data', num(data.opsPerSecond) + ' ops/s',
        (data.usedMemoryMb == null ? '—' : data.usedMemoryMb + ' MB') + ' · client ' + num(data.connectedClients)) +
      tile('redis-data evicted',
        evicted === 0 ? '0' : '<span class="err">' + num(evicted) + '</span>',
        evicted === 0 ? 'ต้องเป็น 0 เสมอ (noeviction)' : 'สต็อก/job อาจหายแล้ว') +
      tile('replication lag', lag == null ? '—' : lag + ' s', 'primary → replica') +
      tile('pg pool (primary)',
        report.pool ? report.pool.total + ' conn' : '—',
        report.pool ? ('idle ' + report.pool.idle + ' · waiting ' + report.pool.waiting) : 'อ่านไม่ได้');
  }

  function renderRead(counters, report) {
    var hits = counters.catalog_cache_hits_total || 0;
    var misses = counters.catalog_cache_misses_total || 0;
    var total = hits + misses;
    var queue = report.queue || {};
    document.getElementById('read-tiles').innerHTML =
      tile('catalog cache hit', total > 0 ? ((hits / total) * 100).toFixed(1) + '%' : '—',
        num(hits) + ' hit / ' + num(misses) + ' miss') +
      tile('degraded reads',
        (counters.catalog_degraded_reads_total || 0) === 0 ? '0'
          : '<span class="err">' + num(counters.catalog_degraded_reads_total) + '</span>',
        'อ่าน stock ไม่ได้ ใช้ค่าจากแคช') +
      tile('waiting', num(queue.waiting), 'active ' + num(queue.active)) +
      tile('completed', num(queue.completed), 'failed ' + num(queue.failed));
  }

  function renderOrders(counters) {
    bars(document.getElementById('order-bars'), [
      { label: 'รับเข้าคิว (202)', value: counters.orders_accepted_total || 0 },
      { label: 'ซื้อซ้ำ (409)', value: counters.orders_rejected_duplicate_total || 0 },
      { label: 'ของหมด (409)', value: counters.orders_rejected_sold_out_total || 0 },
      { label: 'กดรัว (429)', value: counters.orders_rejected_in_flight_total || 0 },
      { label: 'โดน dedup (409)', value: counters.orders_deduped_total || 0 },
      { label: 'ยังไม่ seed counter (503)', value: counters.orders_rejected_no_counter_total || 0, status: 'warn' },
      { label: 'gatekeeper ล้ม (503)', value: counters.orders_gatekeeper_errors_total || 0, status: 'critical' },
      { label: 'enqueue ล้ม (503)', value: counters.orders_enqueue_failures_total || 0, status: 'critical' },
      { label: 'ชดเชยล้มเหลว', value: counters.stock_compensation_failures_total || 0, status: 'critical' }
    ]);
  }

  function renderWorker(counters) {
    var sum = counters.worker_job_duration_ms_sum || 0;
    var count = counters.worker_job_duration_count || 0;
    bars(document.getElementById('worker-bars'), [
      { label: 'สำเร็จ', value: counters.worker_jobs_confirmed_total || 0 },
      { label: 'ซ้ำ 23505 (idempotent)', value: counters.worker_jobs_already_confirmed_total || 0 },
      { label: 'ของหมดตอนตัด DB', value: counters.worker_jobs_sold_out_total || 0 },
      { label: 'ล้มชั่วคราว → retry', value: counters.worker_jobs_transient_failures_total || 0, status: 'warn' },
      { label: 'side effect หลัง commit ล้ม', value: counters.worker_post_commit_failures_total || 0, status: 'warn' },
      { label: 'ชดเชยแล้วคืนได้', value: counters.stock_compensation_restored_total || 0 }
    ]);
    var avg = count > 0 ? (sum / count).toFixed(1) + ' ms' : '—';
    document.getElementById('worker-avg').textContent =
      'เวลาเฉลี่ยต่อ job: ' + avg + ' (จาก ' + num(count) + ' job)';
  }

  async function tick() {
    try {
      var res = await fetch('insights.json', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var payload = await res.json();
      renderIntegrity(payload.integrity);
      renderOrders(payload.counters);
      renderWorker(payload.counters);
      renderRead(payload.counters, payload.integrity);
      renderInfra(payload.integrity);
      renderProducts(payload.integrity);
      renderInstances(payload.instances);
      document.getElementById('updated').textContent =
        'อัปเดต ' + new Date().toLocaleTimeString('th-TH');
    } catch (err) {
      document.getElementById('updated').innerHTML =
        '<span style="color:#fca5a5">อ่านข้อมูลไม่ได้: ' + esc(err.message) + '</span>';
    }
  }

  document.getElementById('toggle').addEventListener('click', function () {
    paused = !paused;
    this.textContent = paused ? 'รีเฟรชต่อ' : 'หยุดรีเฟรช';
    if (paused) { clearInterval(timer); } else { timer = setInterval(tick, 3000); tick(); }
  });

  tick();
  timer = setInterval(tick, 3000);
})();
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char,
  );
}
