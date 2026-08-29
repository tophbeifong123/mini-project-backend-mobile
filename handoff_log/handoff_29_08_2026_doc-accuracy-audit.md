# 🔁 Handoff — ตรวจว่าเอกสารตรงกับโค้ดจริงหรือไม่ (3 agent audit) + แก้ไปบางส่วน

**วันที่**: 2026-08-29
**ขอบเขต**: ผู้ใช้ต้องการเอาเอกสารของโปรเจกต์ไปให้ Claude Desktop/claude.ai ช่วยทำ diagram และรายงานใน Google Drive — ก่อนส่งต่อ ต้องมั่นใจก่อนว่าเอกสารตรงกับโค้ดจริง จึงสั่งให้รัน 3 agent ตรวจสอบแบบ read-only คนละมุม (concurrency/Lua, API contract, infra/config) แล้วเอาผลมาแก้เอกสารเท่าที่ทำได้เอง
**ไฟล์ที่แตะ**: `docs/Architecture/architecture.md`, `docs/Architecture/diagrams.md` (แก้แล้ว) — **ยังไม่ได้แตะโค้ด `src/` เลย**
**สถานะ**: งานถูกตัดจบกลางคัน (ผู้ใช้พิมพ์ `/context` แล้วสั่ง "handoff curret") — เขียนบันทึกนี้เพื่อให้คนถัดไป (หรือ session ถัดไปของตัวเอง) ตามงานต่อได้

---

## 🔴 อ่านก่อน — ข้อสรุปของบันทึกนี้ถูกพิสูจน์ว่า **ผิดบางส่วน** แล้ว (2026-08-29 ช่วงบ่าย)

> session ถัดมาไปตรวจกับระบบที่รันจริงก่อนแก้ (11/11 container healthy) แล้วพบว่า **§1 Agent B สรุปผิดในข้อที่บอกว่าสำคัญที่สุด** · ทั้ง 2 คำถามที่ค้างปิดหมดแล้ว ไม่ต้องถามผู้ใช้อีก
>
> | บันทึกนี้เขียนว่า | ผลยิงจริง |
> | :--- | :--- |
> | `POST /orders` ตอบ **400** เมื่อมี field เกิน → **กระทบยิงข้ามกลุ่ม** | ❌ **ผิด** — `{"productId":"p-1003","quantity":1}` ได้ **202** · `{"productId":"p-1004","userId":"victim-1"}` ก็ได้ **202** (userId ถูกตัดทิ้ง สวมสิทธิ์ไม่ได้) · **ไม่กระทบการยิงข้ามกลุ่มเลย** |
> | `forbidNonWhitelisted` ขัดกับ `main.ts` | ✅ **จริง แต่เป็น dead code** — NestJS รัน global pipe ก่อน param pipe เสมอ `whitelist:true` จึงตัด field แปลกปลอมทิ้งไปก่อนที่ pipe ตัวนี้จะเห็น มันจึงไม่มีวันทำงาน |
> | `23514` ควรแยก case แทนที่จะ retry | ✅ ไม่มี branch แยกจริง **แต่ `23514` เข้าไม่ถึงตั้งแต่แรก** — `WHERE remaining_stock > 0` (`orders.processor.ts:67`) ทำให้ค่าต่ำสุดคือ 0 พอดี `chk_positive_stock` จึงละเมิดไม่ได้ → **ไม่ต้องแก้โค้ด** |
>
> **ของจริงที่บันทึกนี้มองข้าม**: 400 มีจริงแต่เกิดกับ body ที่ผิดรูปจริงๆ เท่านั้น (`{}` / `{"productId":""}`) และ `{"productId":123}` ได้ **503 ไม่ใช่ 400** (`enableImplicitConversion` แปลงเป็น `"123"`) — ทั้งสองเคสไม่เคยถูกบันทึกใน CLAUDE.md §3 มาก่อน **ตอนนี้บันทึกแล้ว**
>
> **แก้ไปแล้ว**: ถอด `forbidNonWhitelisted` ออกจาก `orders.controller.ts` (dead code + comment โกหก + กับดัก: ถ้าวันไหน global whitelist ถูกแก้ มันจะตื่นมาตอบ 400 ให้ทุกกลุ่มทันที) · บันทึก 400/503 ลง CLAUDE.md §3 · ปิดคำถาม `23514` ใน `diagrams.md` §6.2 · แก้ error mapping ที่ผิดใน `architecture.md` §6 (เขียนว่า `23505`→409, `23514`→400 ทั้งที่ error พวกนี้เกิดใน worker **หลัง**ตอบ 202 ไปแล้ว ไม่มีทางเป็น HTTP status) · build/lint/test 35 ข้อผ่านครบ
>
> **บทเรียน**: agent audit ที่อ่านโค้ดอย่างเดียวโดยไม่ยิงจริง สรุป "ลำดับการทำงานของ pipe" ผิดได้ — เรื่องที่อ้างว่ากระทบ contract ต้องยิงจริงยืนยันก่อนเสมอ

---

## 1. ผลตรวจ 3 agent

### Agent A — Concurrency/Lua (diagrams.md + architecture.md ฝั่ง lock/compensate)
- **แก้แล้ว**: diagrams.md §3 (DFD) และ §5 (CFD) ไม่มีเส้นทาง "gatekeeper() เรียกล้มเหลว/timeout เอง → compensate" ทั้งที่โค้ดมีจริง (`orders.service.ts:87-101`, แก้ไปตั้งแต่ 2026-08-27) — **เพิ่มเส้น/หมายเหตุแล้ว**
- **แก้แล้ว**: diagrams.md §6.3 (ตารางชดเชย) ไม่มีแถวสำหรับเคสเดียวกัน — **เพิ่มแถวแล้ว**
- **แก้แล้ว**: architecture.md §6.2 code sample เก่าไม่มี try/catch รอบ `gatekeeper()` เลย (ทั้งที่โค้ดจริงมี) — ใครทำตาม sample เดิมจะรื้อบั๊กที่แก้ไปแล้วกลับมา — **แก้ sample ให้ตรงกับ `orders.service.ts` จริงแล้ว**
- **แก้แล้ว**: architecture.md §8.2 ข้อ 3 (log ไม่มี rotation) และ ข้อ 6 (`invalidateCatalogCache` debounce เป็น per-process) เป็นข้อมูลเก่าก่อนแก้ 2026-08-28 — **ทั้งสองข้อถูก patch แล้วจริงในโค้ด** (log rotation + distributed throttle ผ่าน `catalog:flush_throttle`) — **อัปเดตข้อความให้ตรงกับปัจจุบันแล้ว**
- ⚠️ **ยังไม่ได้ตัดสินใจ (แจ้งผู้ใช้แล้ว รอคำตอบ)**: diagrams.md §6.2 แถว PG `23514` (check constraint ติดลบ) — ตารางเดิมบอกว่าต้อง "ไม่ retry ต้อง alert ทันที" แต่โค้ดจริง (`orders.processor.ts`) ไม่มี case แยก ตกไปอยู่ branch เดียวกับ transient error (retry 3 ครั้งก่อน) — **แก้แค่คำอธิบายในตารางให้ตรงกับพฤติกรรมจริงแล้ว แต่ยังไม่ได้ถามว่าจะแก้โค้ดให้ตรงกับเจตนาเดิมไหม**

### Agent B — API Contract (CLAUDE.md §3 vs controllers)
- ทุกอย่าง MATCH ยกเว้น 1 จุดสำคัญ: **`POST /api/v1/orders` ตอบ `400`ได้ในเคสที่ CLAUDE.md §3 ไม่ได้พูดถึงเลย**
  - `main.ts` ตั้งใจให้ global `ValidationPipe` "เงียบๆ ตัด field เกิน" (ไม่ reject) — มี comment อธิบายเหตุผลว่าเพื่อไม่ให้กลุ่มอื่นที่ส่ง field เกิน (เช่น `quantity`) โดน 400
  - แต่ `orders.controller.ts` override ด้วย local `ValidationPipe({ forbidNonWhitelisted: true })` ซึ่ง**ขัดกับเจตนาที่เขียนไว้ใน main.ts ตรงๆ**
  - ⚠️ **ยังไม่ได้ตัดสินใจ (แจ้งผู้ใช้แล้ว รอคำตอบ)**: จะ (ก) เอา `forbidNonWhitelisted: true` ออกจาก orders controller ให้ตรงกับ main.ts หรือ (ข) เก็บไว้แล้วเพิ่ม 400 เข้าไปใน CLAUDE.md §3 — **ยังไม่ได้แก้ทั้งโค้ดและเอกสารข้อนี้เลย**

### Agent C — Infra/Config (docker-compose.yml, nginx.conf vs docs)
- **ทุกอย่าง MATCH ทั้งหมด** ไม่มี mismatch — การ merge จาก `git pull` วันนี้ (ดู `handoff_29_08_2026_git-pull-k6-retry-local.md`) รวม 6-instance กับ mem_limit/cpus/logging ของ commit ใหม่เข้าด้วยกันถูกต้องแล้ว ไม่ต้องแก้อะไรเพิ่ม

---

## 2. สถานะ ณ ตอนตัดจบ — ยังเหลืออะไรบ้าง

### ✅ ทำเสร็จแล้ว
- แก้ `diagrams.md` §3, §5, §6.3 (เพิ่มเส้นทาง/แถวที่หาย)
- แก้ `architecture.md` §6.2 code sample, §8.2 ข้อ 3 และข้อ 6 (อัปเดตให้ตรงปัจจุบัน)
- ยังไม่ได้ commit การแก้เอกสารพวกนี้ — อยู่ใน working tree เฉยๆ

### ⚠️ รอผู้ใช้ตัดสินใจ 2 ข้อ (ถามไปแล้วในแชท ยังไม่ได้คำตอบ)
1. **orders endpoint 400 ที่ไม่ได้บันทึกไว้** — แก้โค้ด (เอา `forbidNonWhitelisted` ออก) หรือแก้เอกสาร (เพิ่ม 400 ใน §3)? **สำคัญเพราะกระทบการยิงข้ามกลุ่ม**
2. **`23514` retry แทนที่จะ alert ทันที** — ปล่อยไว้ตามที่บันทึกแล้ว (โค้ดถูกต้องพอ เพราะเคสนี้แทบไม่เกิดจริง) หรือแก้โค้ดให้แยก case ตามเจตนาเดิม? สำคัญน้อยกว่าข้อ 1

### ❌ ยังไม่ได้เริ่มเลย
- **สร้าง Google Doc สรุปรายงาน** (สถาปัตยกรรม + diagram + cache invalidation/duplicate order strategy + ผล load test + `remainingStock` handling) — นี่คือเป้าหมายเดิมของงานทั้งหมดในวันนี้ ยังไม่ได้ทำเลยเพราะเบี่ยงไปตรวจเอกสารก่อน
- ยังไม่ได้ใช้ `mcp__claude_ai_Google_Drive__create_file` เลยสักครั้ง

## 3. ก้าวถัดไปที่แนะนำ (เรียงลำดับ)

1. ถามผู้ใช้ให้ตัดสินใจ 2 ข้อด้านบนให้จบก่อน (หรือถ้าเวลาจำกัด ข้ามข้อ 2 ไปก่อนได้ เพราะไม่กระทบยิงข้ามกลุ่ม)
2. ถ้าต้องแก้โค้ด (`orders.controller.ts` validation) — ต้องรัน `pnpm run build && pnpm run lint && pnpm run test` ให้ผ่านตาม CLAUDE.md §7 ก่อนเสร็จงาน
3. ประกอบเนื้อหารายงาน (ดึงจาก `docs/Architecture/diagrams.md`, `docs/LOADTEST_AND_SCALING_REPORT.md`, `handoff_log/handoff_28_08_2026_performance-tuning-and-review-fixes.md`) แล้วสร้างเป็น Google Doc ด้วย `mcp__claude_ai_Google_Drive__create_file` (`contentMimeType: text/plain` หรือ markdown แล้วปล่อยให้ระบบ convert เป็น `application/vnd.google-apps.document`)
4. บอก path/ลิงก์ Google Doc ให้ผู้ใช้ เพื่อเอาไปเปิดใน Claude Desktop ต่อสำหรับทำ diagram
