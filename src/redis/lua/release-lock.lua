-- release-lock.lua — compare-and-delete (CLAUDE.md §6 DO: ห้าม DEL lock ตรงๆ)
-- ลบ lock ได้เฉพาะเมื่อค่าใน key ตรงกับ token ของเจ้าของเท่านั้น
-- ไม่งั้นจะไปลบ lock ของ request รอบใหม่ที่ตั้งขึ้นหลัง TTL หมด
--
-- KEYS[1] lock:order:{userId}:{productId}
-- ARGV[1] token (= requestToken ที่ gatekeeper เขียนลงไป — สุ่มใหม่ทุกคำขอ)
--
-- return 1 = ลบแล้ว | 0 = ไม่ใช่เจ้าของ / lock หมดอายุไปแล้ว

if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end
return 0
