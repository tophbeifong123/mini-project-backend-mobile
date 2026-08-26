-- gatekeeper.lua  (architecture.md §6.1 — Tier 1: Atomic Lua Gatekeeper)
-- รวม 3 การตรวจ + 2 การเขียน ไว้ใน 1 roundtrip ที่ atomic
--
-- KEYS[1] lock:order:{userId}:{productId}     in-flight mutex
-- KEYS[2] stock:flash_sale:{productId}        fast stock counter
-- KEYS[3] bought:{productId}:{userId}         committed flag
-- ARGV[1] lock_ttl_ms   (เช่น 30000)
-- ARGV[2] jobId / order token

-- 0) stock counter ต้องมีอยู่จริง ห้ามตีความ nil ว่า 0
--    (nil = ยังไม่ seed หรือถูก evict -> ต้องแยกออกจาก "ของหมด")
local raw = redis.call('GET', KEYS[2])
if raw == false then
    return -4            -- STOCK_NOT_INITIALIZED -> 503 Service Unavailable
end

-- 1) เคยซื้อสำเร็จไปแล้ว
if redis.call('EXISTS', KEYS[3]) == 1 then
    return -1            -- ALREADY_PURCHASED -> 409 Conflict
end

-- 2) มีคำสั่งซื้อกำลังประมวลผลอยู่ (กดรัว)
if redis.call('EXISTS', KEYS[1]) == 1 then
    return -2            -- REQUEST_IN_FLIGHT -> 429 Too Many Requests
end

-- 3) ของหมด
if tonumber(raw) <= 0 then
    return -3            -- SOLD_OUT -> 409 Conflict
end

-- 4) จองสิทธิ์: หักสต็อก + ตั้ง mutex พร้อมกันแบบ atomic
redis.call('DECR', KEYS[2])
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[1])
return 1                 -- ALLOWED
