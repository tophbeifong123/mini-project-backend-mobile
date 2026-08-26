-- compensate-once.lua — compensation ที่ idempotent (CLAUDE.md §4 ข้อ 8)
-- BullMQ retry ได้หลายครั้ง ถ้าคืนสต็อกทุกครั้ง = คืนเกินจริง -> oversell
-- guard ด้วย compensated:{jobId} (SET NX + TTL) ให้คืนได้ครั้งเดียวต่อ job
--
-- KEYS[1] compensated:{jobId}                 guard key
-- KEYS[2] stock:flash_sale:{productId}
-- KEYS[3] lock:order:{userId}:{productId}
-- ARGV[1] guard_ttl_seconds
--
-- return 1 = คืนสต็อกให้แล้วรอบนี้ | 0 = เคยคืนไปแล้ว (no-op)

if redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1]) == false then
    return 0
end

redis.call('INCR', KEYS[2])
redis.call('DEL', KEYS[3])
return 1
