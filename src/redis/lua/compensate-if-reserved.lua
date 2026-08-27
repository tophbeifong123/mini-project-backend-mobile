-- compensate-if-reserved.lua — คืนสิทธิ์ "เฉพาะเมื่อพิสูจน์ได้ว่า gatekeeper รันไปแล้วจริง"
--
-- ใช้จาก API path (orders.service.ts) เมื่อ `gatekeeper()` **โยน error** ออกมา
-- ไม่ใช่ตอนได้ verdict — เคสนั้นใช้ compensate.lua ซึ่ง INCR โดยไม่มีเงื่อนไข
--
-- KEYS[1] stock:flash_sale:{productId}
-- KEYS[2] lock:order:{userId}:{productId}
-- ARGV[1] requestToken — token สุ่มใหม่ทุกคำขอ (ค่าเดียวกับที่ gatekeeper.lua เขียนลง lock)
--
-- return 1 = gatekeeper รันไปแล้วจริง คืนสต็อกและปล่อย lock เรียบร้อย
--        0 = gatekeeper ไม่ได้รัน (หรือ lock เป็นของคำขออื่น) → ไม่แตะอะไรเลย
--
-- ── ทำไมต้องมีสคริปต์นี้แยกจาก compensate.lua ────────────────────────────────
-- `commandTimeout` ของ ioredis ยกเลิกแค่ "การรอ" ฝั่ง client เท่านั้น
-- มันไม่มีทางยกเลิกคำสั่งที่ Redis รับไปรันแล้ว → ตอน gatekeeper timeout
-- สถานะจริงคือ **"ไม่รู้ว่า DECR เกิดขึ้นหรือยัง"** ไม่ใช่ "ไม่เกิด"
--   เดาว่า "ไม่เกิด"  → ไม่คืน → สต็อกรั่วถาวร (วัดจริงแล้ว: หาย 8 ชิ้นจาก 50)
--   เดาว่า "เกิดแล้ว" → INCR มั่ว → Redis สูงกว่า DB → ปล่อยคนที่ 51 เข้ามา
-- ทางออกคือ **ไม่ต้องเดา**: `lock:order:*` จะมีค่าเป็น requestToken ของคำขอนี้
-- ก็ต่อเมื่อ gatekeeper.lua รันจนถึงบรรทัด SET เท่านั้น (atomic คู่กับ DECR)
-- lock จึงเป็นหลักฐานที่เชื่อถือได้ว่า DECR เกิดขึ้นแล้ว — เช็คมันแทนการเดา
--
-- ⚠️ compare ก่อน INCR เสมอ ห้ามสลับลำดับ (CLAUDE.md §4 ข้อ 5 · §6 DO)

if redis.call('GET', KEYS[2]) == ARGV[1] then
    redis.call('INCR', KEYS[1])
    redis.call('DEL', KEYS[2])
    return 1
end

return 0
