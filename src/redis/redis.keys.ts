/**
 * Key builder รวมศูนย์ (CLAUDE.md §5 ข้อ 6)
 * ห้ามต่อ string key เองที่อื่นเด็ดขาด — ไม่งั้น read path กับ write path
 * จะอ้างคนละ key แล้ว remainingStock จะเพี้ยนแบบเงียบๆ
 */
export const RedisKeys = {
  /** redis-data · counter ของจริงที่ทั้ง read path และ worker ใช้ร่วมกัน (ไม่มี TTL) */
  stock: (productId: string): string => `stock:flash_sale:${productId}`,

  /** redis-data · in-flight mutex กันกดรัว (มี TTL = ORDER_LOCK_TTL_MS) */
  orderLock: (userId: string, productId: string): string =>
    `lock:order:${userId}:${productId}`,

  /** redis-data · flag ว่าซื้อสำเร็จแล้ว (Tier 1 ใช้ตอบ 409) */
  bought: (productId: string, userId: string): string =>
    `bought:${productId}:${userId}`,

  /**
   * redis-data · guard ให้ compensation เป็น idempotent ข้าม retry (CLAUDE.md §4 ข้อ 8)
   *
   * ขอบเขตคือ "retry chain ของคำขอเดียว" — ไม่ใช่ทั้งคู่ (user, product)
   * เพราะ `jobId` เป็น deterministic (`order:{userId}:{productId}`) ถ้า key มีแค่ jobId
   * คำขอ *รอบถัดไป* ของคนเดิมจะชน guard ของรอบก่อนแล้วไม่คืนสต็อก = สต็อกหายถาวร
   * (BullMQ retry อ่าน `job.data` เดิม → `requestToken` เดิม guard จึงยังคุม retry ได้เหมือนเดิม)
   */
  compensated: (jobId: string, requestToken: string): string =>
    `compensated:${jobId}:${requestToken}`,

  /** redis-cache · metadata ของ catalog หนึ่งหน้า (TTL + jitter เสมอ) */
  catalogPage: (page: number, limit: number): string =>
    `catalog:page:${page}:limit:${limit}`,

  /** redis-cache · SET ของ catalog key ที่ยังมีชีวิต -> invalidate ได้โดยไม่ต้องใช้ KEYS */
  catalogIndex: (): string => `catalog:index`,

  /** redis-cache · distributed throttle key สำหรับ invalidation ข้าม instance */
  catalogFlushThrottle: (): string => `catalog:flush_throttle`,

  /**
   * redis-data · hash ของตัวนับ observability (field = ชื่อ metric, value = จำนวนสะสม)
   *
   * อยู่บน redis-data เพราะ 6 instance ต้องบวกลงถังใบเดียวกัน ถ้าเก็บใน RAM ของ process
   * หน้าแดชบอร์ดจะเห็นแค่ 1 ใน 6 ของทราฟฟิก (ผิดกฎ stateless — CLAUDE.md §6 DON'T)
   * และถ้าไปไว้บน redis-cache ที่เป็น allkeys-lru ตัวนับจะโดน evict หายเงียบๆ
   */
  metricsCounters: (): string => `metrics:counters`,

  /** redis-data · hash ของสถานะราย instance (field = INSTANCE_ID, value = JSON snapshot) */
  metricsInstances: (): string => `metrics:instances`,
} as const;
