-- compensate.lua — คืนสิทธิ์แบบ atomic (INCR stock + ปล่อย lock ในสเต็ปเดียว)
-- ใช้จาก API path (orders.service.ts) เมื่อ enqueue ไม่สำเร็จ หลังจาก DECR ไปแล้ว
-- CLAUDE.md §4 ข้อ 5 (Redis stock mutation ต้องอยู่ใน Lua) + ข้อ 6 (ทุก path ที่หักสต็อกต้องมีทางชดเชย)
--
-- KEYS[1] stock:flash_sale:{productId}
-- KEYS[2] lock:order:{userId}:{productId}
-- ARGV[1] requestToken — token ของ "การถือครอง lock ครั้งนี้"
--
-- ⚠️ ต้อง compare-and-delete เท่านั้น (CLAUDE.md §6 DO)
--    ถ้า DEL ตรงๆ จะไปลบ lock ของ request รอบใหม่ที่ตั้งขึ้นหลัง TTL หมด
--    → request ถัดไปผ่าน gatekeeper ได้ → DECR อีกหน่วยที่ไม่มี job มากิน = รั่วต่อเนื่อง

redis.call('INCR', KEYS[1])

if redis.call('GET', KEYS[2]) == ARGV[1] then
    redis.call('DEL', KEYS[2])
end

return 1
