/**
 * Injection tokens สำหรับ ioredis สอง instance (architecture.md §1 / ADR-3)
 *  - redis-cache : allkeys-lru  -> metadata cache เท่านั้น (หายได้ ไม่กระทบความถูกต้อง)
 *  - redis-data  : noeviction + AOF -> stock counter / lock / BullMQ (หายไม่ได้)
 */
export const REDIS_CACHE_CLIENT = 'REDIS_CACHE_CLIENT';
export const REDIS_DATA_CLIENT = 'REDIS_DATA_CLIENT';
