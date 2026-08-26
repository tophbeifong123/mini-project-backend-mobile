-- compensate.lua — คืนสิทธิ์แบบ atomic (INCR stock + DEL lock ในสเต็ปเดียว)
-- ใช้จาก API path (orders.service.ts) เมื่อ enqueue ไม่สำเร็จ หลังจาก DECR ไปแล้ว
-- CLAUDE.md §4 ข้อ 5 (Redis stock mutation ต้องอยู่ใน Lua) + ข้อ 6 (ทุก path ที่หักสต็อกต้องมีทางชดเชย)
--
-- KEYS[1] stock:flash_sale:{productId}
-- KEYS[2] lock:order:{userId}:{productId}

redis.call('INCR', KEYS[1])
redis.call('DEL', KEYS[2])
return 1
