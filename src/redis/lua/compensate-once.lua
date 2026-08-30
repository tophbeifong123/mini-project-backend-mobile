-- compensate-once.lua — compensation ที่ idempotent (CLAUDE.md §4 ข้อ 8)
-- BullMQ retry ได้หลายครั้ง ถ้าคืนสต็อกทุกครั้ง = คืนเกินจริง -> oversell
-- guard ด้วย compensated:{jobId}:{requestToken} (SET NX + TTL) ให้คืนได้ครั้งเดียวต่อหนึ่งคำขอ
--
-- KEYS[1] compensated:{jobId}:{requestToken}  guard key (ขอบเขต = retry chain ของคำขอเดียว)
-- KEYS[2] stock:flash_sale:{productId}
-- KEYS[3] lock:order:{userId}:{productId}
-- ARGV[1] guard_ttl_seconds
-- ARGV[2] requestToken — token ของการถือครอง lock (compare-and-delete)
--
-- return 1 = คืนสต็อกให้แล้วรอบนี้ | 0 = เคยคืนไปแล้ว (no-op)

if redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1]) == false then
    return 0
end

redis.call('INCR', KEYS[2])

-- ⚠️ compare-and-delete เหมือน compensate.lua — ห้าม DEL ตรงๆ
if redis.call('GET', KEYS[3]) == ARGV[2] then
    redis.call('DEL', KEYS[3])
end

return 1
