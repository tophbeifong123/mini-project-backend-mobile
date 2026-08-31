# 📚 Codebase — เอกสารว่าโค้ดทำงานยังไง

เอกสารชุดนี้ต่างจาก `docs/Architecture/` ตรงที่ **อ้างอิงโค้ดจริงที่มีอยู่** (ระดับ `file:line`)
ส่วน `Architecture/` เป็นสเปกและแนวคิด ซึ่งบางจุดเขียนไว้ตั้งแต่ยังไม่มีโค้ด

| ต้องการอะไร | อ่านอันไหน |
| :--- | :--- |
| เพิ่งเข้ามาใหม่ อยากรู้ว่าโค้ดเชื่อมกันยังไง | [`Separate/01-codebase-primer.md`](Separate/01-codebase-primer.md) |
| อยากรู้ว่าดีไซน์ยังมีจุดอ่อนตรงไหน ใครเถียงอะไรกัน | [`Separate/02-design-review-qa.md`](Separate/02-design-review-qa.md) |

---

## สรุปสั้นที่สุด

**Primer** ตอบว่า request หนึ่งใบเดินผ่านอะไรบ้าง — 5 เส้นทาง (`auth/token`, `products`, `orders`, worker
และ `/admin/*` observability) พร้อม mermaid, ตารางว่าใครคุยกับ datastore ไหน, connection topology,
ลำดับตอน boot และค่าคงที่ทั้งหมด

**Q&A** เป็นบันทึกจริงของ reviewer 3 มุม (performance / correctness / simplicity) ที่อ่านแยกกันแล้วมาถกกัน
ของที่ออกมาหนักที่สุด: **blocker (b) ที่คิดว่าปิดไปแล้ว ยังเปิดอยู่** เพราะ `job.data.requestToken`
ไม่มีทางเป็นของ job เดิมได้ — BullMQ ไม่เคยอ่าน `data` กลับจาก Redis

✅ **แก้ไปแล้ว 10 จาก 11 ข้อ** (2026-08-26) — เหลือข้อ 10 "ตัด PG replica" ที่ตัดสินใจว่าไม่ทำ
เพราะกระทบ requirement โดยตรง (read-write split เป็นหัวข้อที่ต้องมีในรายงาน)

> 🔄 **ตรวจ `file:line` ทั้งชุดใหม่ 2026-08-30** พร้อมเพิ่ม `src/observability/` (Primer §9)
> และภาคผนวกท้าย Q&A · เทสต์ปัจจุบัน **43 ข้อ / 4 suites** (เอกสารรุ่นก่อนเขียน 32 หรือ 35 — ผิดทั้งคู่)
