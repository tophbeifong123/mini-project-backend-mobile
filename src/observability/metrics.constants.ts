/**
 * ชื่อ metric ทั้งหมดรวมศูนย์ที่เดียว (เหตุผลเดียวกับ `redis.keys.ts`)
 * ห้ามพิมพ์ชื่อ metric เป็น string ลอยๆ ที่จุดเรียกใช้ — สะกดผิดแล้วตัวนับจะแตกเป็นสองใบเงียบๆ
 *
 * ชื่อใช้ convention ของ Prometheus (`snake_case` + `_total` สำหรับ counter)
 * เพราะ `/admin/metrics` เสิร์ฟเป็น exposition format ให้ Prometheus มาดูดได้ทีหลัง
 */
export const Metric = {
  // ── write path (orders.service.ts) ────────────────────────────────
  ORDERS_REQUESTS: 'orders_requests_total',
  ORDERS_ACCEPTED: 'orders_accepted_total',
  ORDERS_REJECTED_DUPLICATE: 'orders_rejected_duplicate_total',
  ORDERS_REJECTED_SOLD_OUT: 'orders_rejected_sold_out_total',
  ORDERS_REJECTED_IN_FLIGHT: 'orders_rejected_in_flight_total',
  ORDERS_REJECTED_NO_COUNTER: 'orders_rejected_no_counter_total',
  ORDERS_GATEKEEPER_ERRORS: 'orders_gatekeeper_errors_total',
  ORDERS_ENQUEUE_FAILURES: 'orders_enqueue_failures_total',
  ORDERS_DEDUPED: 'orders_deduped_total',
  ORDERS_JOB_UNVERIFIED: 'orders_job_unverified_total',

  // ── การชดเชยสต็อก (invariant §4 ข้อ 6/8) ─────────────────────────
  STOCK_COMPENSATED: 'stock_compensated_total',
  STOCK_COMPENSATION_RESTORED: 'stock_compensation_restored_total',
  STOCK_COMPENSATION_FAILURES: 'stock_compensation_failures_total',

  // ── worker (orders.processor.ts) ─────────────────────────────────
  WORKER_CONFIRMED: 'worker_jobs_confirmed_total',
  WORKER_ALREADY_CONFIRMED: 'worker_jobs_already_confirmed_total',
  WORKER_SOLD_OUT: 'worker_jobs_sold_out_total',
  WORKER_TRANSIENT_FAILURES: 'worker_jobs_transient_failures_total',
  WORKER_POST_COMMIT_FAILURES: 'worker_post_commit_failures_total',
  WORKER_DURATION_MS_SUM: 'worker_job_duration_ms_sum',
  WORKER_DURATION_COUNT: 'worker_job_duration_count',

  // ── read path (products.service.ts) ──────────────────────────────
  CATALOG_CACHE_HITS: 'catalog_cache_hits_total',
  CATALOG_CACHE_MISSES: 'catalog_cache_misses_total',
  CATALOG_DEGRADED_READS: 'catalog_degraded_reads_total',
  CATALOG_MISSING_STOCK_KEY: 'catalog_missing_stock_key_total',
} as const;

export type MetricName = (typeof Metric)[keyof typeof Metric];

/** คำอธิบายไทยสำหรับหน้าแดชบอร์ด — ไม่ได้ใช้ในเส้นทาง hot */
export const METRIC_LABELS: Record<string, string> = {
  [Metric.ORDERS_REQUESTS]: 'คำขอสั่งซื้อทั้งหมด',
  [Metric.ORDERS_ACCEPTED]: 'รับเข้าคิว (202)',
  [Metric.ORDERS_REJECTED_DUPLICATE]: 'ซื้อซ้ำ (409)',
  [Metric.ORDERS_REJECTED_SOLD_OUT]: 'ของหมด (409)',
  [Metric.ORDERS_REJECTED_IN_FLIGHT]: 'กดรัวขณะมี order ค้าง (429)',
  [Metric.ORDERS_REJECTED_NO_COUNTER]: 'ยังไม่ seed counter (503)',
  [Metric.ORDERS_GATEKEEPER_ERRORS]: 'gatekeeper ล้ม/timeout (503)',
  [Metric.ORDERS_ENQUEUE_FAILURES]: 'enqueue ล้ม (503)',
  [Metric.ORDERS_DEDUPED]: 'โดน BullMQ dedup (409)',
  [Metric.ORDERS_JOB_UNVERIFIED]: 'ยืนยัน job ไม่ได้ — ไม่คืนสต็อก',
  [Metric.STOCK_COMPENSATED]: 'สั่งชดเชยสต็อก',
  [Metric.STOCK_COMPENSATION_RESTORED]: 'ชดเชยแล้วคืนได้จริง',
  [Metric.STOCK_COMPENSATION_FAILURES]: '⚠️ ชดเชยล้มเหลว (สต็อกรั่ว)',
  [Metric.WORKER_CONFIRMED]: 'order สำเร็จ',
  [Metric.WORKER_ALREADY_CONFIRMED]: 'ซ้ำ 23505 (idempotent)',
  [Metric.WORKER_SOLD_OUT]: 'worker เจอของหมด',
  [Metric.WORKER_TRANSIENT_FAILURES]: 'job ล้มชั่วคราว (retry)',
  [Metric.WORKER_POST_COMMIT_FAILURES]: 'side effect หลัง commit ล้ม',
  [Metric.CATALOG_CACHE_HITS]: 'cache hit',
  [Metric.CATALOG_CACHE_MISSES]: 'cache miss',
  [Metric.CATALOG_DEGRADED_READS]: 'อ่าน stock ไม่ได้ ใช้ค่าจากแคช',
  [Metric.CATALOG_MISSING_STOCK_KEY]: '⚠️ ไม่มี stock counter (ยังไม่ได้ seed)',
};
