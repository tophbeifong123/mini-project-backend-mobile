# 🔁 Handoff — พิสูจน์ผล audit กับระบบจริง (หักล้างไป 1 ข้อ) + ถอด dead code + สร้าง Google Doc รายงาน

**วันที่**: 2026-08-29 (ช่วงบ่าย — ต่อจาก `handoff_29_08_2026_doc-accuracy-audit.md`)
**ขอบเขต**: ผู้ใช้สั่ง "แก้ problem ก่อนได้เลย **แต่ช่วยยืนยันก่อนว่าเรามีปัญหาพวกนั้นจริงไหม**" → ยิงจริงกับสแตกที่รันอยู่ (11/11 healthy) เพื่อตรวจสอบข้อสรุปของ audit ก่อนแตะโค้ด แล้วจึงแก้ · จากนั้นทำ Google Doc รายงานตามเป้าหมายเดิม
**ไฟล์ที่แตะ**: `src/orders/orders.controller.ts`, `CLAUDE.md`, `docs/Architecture/architecture.md`, `docs/Architecture/diagrams.md`, `handoff_log/*`, `.gitignore`
**สถานะ**: ✅ จบงานครบ — build/lint/test ผ่าน · commit แยก 5 ชุด · push แล้ว

---

## 1. ⚠️ บทเรียนสำคัญที่สุดของ session นี้ — audit ที่อ่านโค้ดอย่างเดียวสรุปผิด

`handoff_29_08_2026_doc-accuracy-audit.md` §1 Agent B สรุปว่า:

> "`POST /api/v1/orders` ตอบ **400** ในเคสที่ไม่ได้บันทึกไว้ — **กระทบการยิงข้ามกลุ่ม**"

**ยิงจริงแล้วพบว่าผิด** — สแตกรันอยู่ 11/11 healthy ยิง 3 เคส:

| body ที่ยิง | ผลจริง |
| :--- | :--- |
| `{"productId":"p-1002"}` | **202** |
| `{"productId":"p-1003","quantity":1}` ← แบบที่กลุ่มอื่นส่ง | **202** (ไม่ใช่ 400) |
| `{"productId":"p-1004","userId":"victim-1"}` | **202** · `userId` ถูกตัดทิ้ง สวมสิทธิ์ไม่ได้ |

**สาเหตุที่ audit พลาด**: NestJS รัน **global pipe ก่อน param pipe เสมอ** → `whitelist: true` ใน `main.ts:30` ตัด field แปลกปลอมทิ้งไปก่อนแล้ว → `forbidNonWhitelisted` ที่ `orders.controller.ts` **ไม่มีวันเห็น field เกิน = เป็น dead code**

> **กฎที่ควรจำ**: อะไรก็ตามที่อ้างว่า "กระทบ API contract / กระทบการยิงข้ามกลุ่ม" **ต้องยิงจริงยืนยันก่อนเสมอ** การอ่านโค้ดอย่างเดียวสรุปลำดับการทำงานของ pipe ผิดได้

## 2. สิ่งที่แก้ไป

### 2.1 `src/orders/orders.controller.ts` — ถอด `forbidNonWhitelisted` ออก

ถึงจะเป็น dead code แต่ยัง**ต้องถอด** เพราะ 3 เหตุผล:
1. **comment โกหก** — เขียนว่า "ปฏิเสธ field แปลกปลอม เช่น quantity / userId" ทั้งที่ไม่ได้ทำ
2. **ขัดกับ `main.ts:28-29` ตรงๆ** ซึ่งเขียนไว้ชัดว่า "⚠️ ห้ามเปิด `forbidNonWhitelisted`" พร้อมเหตุผลเรื่องยิงข้ามกลุ่ม
3. **เป็นกับดัก** — วันไหนมีคนไปแตะ `whitelist` ใน `main.ts` มันจะตื่นขึ้นมาตอบ 400 ให้ทุกกลุ่มที่ส่ง `quantity` ทันที

แทนที่ด้วย comment อธิบายว่าทำไมห้ามใส่กลับ (พร้อมเหตุผลเรื่องลำดับ pipe)

### 2.2 `CLAUDE.md` §3 — บันทึก 400/503 ที่มีอยู่จริงแต่ไม่เคยเขียนไว้

- เพิ่มกล่องบอกว่า **field เกินถูกตัดทิ้งเงียบๆ ได้ 202** (เจตนา เพื่อให้กลุ่มอื่นยิงได้) + **ห้ามใส่ `forbidNonWhitelisted` ที่ไหนก็ตาม**
- เพิ่มแถว **400** = body ผิดรูปจริงๆ เท่านั้น (`productId` หาย/ว่าง/ยาวเกิน 32) — **ไม่ใช่**เพราะส่ง field เกิน
- หมายเหตุ `{"productId":123}` ได้ **503 ไม่ใช่ 400** — `enableImplicitConversion` แปลงเป็น `"123"` ผ่าน `@IsString()` แล้วไปตกที่ "ไม่มี stock counter ของ `123`"

**ไม่ได้เปลี่ยน contract** — ทุก status code ที่บันทึกไว้เดิมทำงานเหมือนเดิมเป๊ะ แค่บันทึกของที่มีอยู่แล้ว

### 2.3 `diagrams.md` §6.2 — ปิดคำถาม `23514` ว่า **unreachable by design**

คำถามที่ audit ทิ้งไว้ ("โค้ดไม่มี case แยกสำหรับ `23514` ควรแก้ไหม") — **ไม่ต้องแก้**:
- CHECK ตัวเดียวที่ write path จะละเมิดได้คือ `chk_positive_stock (remaining_stock >= 0)`
- แต่ UPDATE มี `WHERE remaining_stock > 0` กันไว้ (`orders.processor.ts:67`) → ค่าต่ำสุดที่เป็นไปได้คือ **0 พอดี**
- `chk_stock_ceiling` ก็ละเมิดไม่ได้เพราะ path นี้มีแต่ลด ไม่เพิ่ม
- ถ้าวันหนึ่ง `23514` โผล่จริง = มีคนแก้ `WHERE` clause หรือมี writer ตัวอื่นนอก worker ซึ่งควร alert ด้วยเหตุผลคนละเรื่องกับที่ตารางเดิมคิดไว้

### 2.4 `architecture.md` §6 — แก้ error mapping ที่ผิด (audit มองข้าม)

เดิมเขียนว่า `23505` → 409 · `23514` → 400 ซึ่ง **ผิดโดยสิ้นเชิง** — error พวกนี้เกิดใน BullMQ worker **หลัง**จาก client ได้ 202 ไปตั้งแต่ตอน enqueue แล้ว **ไม่มีทางกลายเป็น HTTP status ให้ client เห็น** แก้เป็นตารางบอกว่า worker ทำอะไรจริง (`already_confirmed` / retry / compensate เฉพาะ attempt สุดท้าย)

## 3. ✅ Verification (CLAUDE.md §7)

```
pnpm run build   ✅ ไม่มี TypeScript error
pnpm run lint    ✅ exit 0
pnpm run test    ✅ 35/35 ผ่าน (3 suites)
```

> ⚠️ `lint` และ `test` **ช้ามาก** บนเครื่องนี้ (lint > 400 วิ, test 551 วิ) เพราะอ่านไฟล์ผ่าน SynologyDrive — ตรงกับที่ `handoff_29_08_2026_git-pull-k6-retry-local.md` §3 บันทึกไว้ ไม่ใช่ค้าง ให้รอ

**ผลข้างเคียงที่จัดการแล้ว**: ระหว่างพิสูจน์ได้สร้าง order ทดสอบ 3 รายการ (`probe-contract-999` บน p-1002/1003/1004) — **ลบ order + คืนสต็อกทั้ง DB และ Redis + ล้าง key ที่เกี่ยวข้องเรียบร้อย** ตรวจแล้ว **ไม่มี drift ทั้ง 20 SKU**

## 4. 📄 Google Doc รายงาน (เป้าหมายเดิมของงานเมื่อวาน — เสร็จแล้ว)

**https://docs.google.com/document/d/15L2ZP-eo2FHBl41XtKwt7qdnLWf9M-HIjEWmtXo2E5o/edit**

ครอบคลุม §9 Deliverables ครบ: สถาปัตยกรรม + DFD (แนบโค้ด Mermaid ให้ render ต่อ) · การจัดการ `remainingStock` · Cache Invalidation · กันซื้อซ้ำ 4 ชั้น (มี Lua เต็ม) · API Contract · ผล Load Test 3 รอบ + Cloud VM · วิเคราะห์คอขวด 7 ข้อที่แก้แล้ว + 4 ข้อที่ยังเหลือ

**ตัวเลขที่ใช้อ้างอิงคือรอบ 28 ส.ค.** (2,548 rps · read p95 469.79ms · write p95 317.34ms · hit ratio 97.63%) ส่วนผลรอบ 29 ส.ค. ที่แย่ผิดปกติใส่ไว้ใน §8.2 พร้อมคำอธิบายว่าเป็นข้อจำกัด CPU ของเครื่องทดสอบ **ไม่ใช่การถดถอยของระบบ** (เพื่อไม่ให้ดูเหมือนซ่อนข้อมูล)

### ⬜ ช่องว่างที่ยังต้องเติมเองในเอกสาร
- **รายชื่อสมาชิก + การแบ่งงาน** (§10)
- **ตารางเทียบผลยิงกับกลุ่มเพื่อน** (§9) — ยังไม่เคยยิงข้ามกลุ่ม
- **Screenshot 3 จุด**: k6 Summary · Bull-Board ตอน Completed = 50 · Cache Hit/Miss จาก `./scripts/cache-stats.sh`
- **ภาพ Diagram ที่ render แล้ว** — โค้ด Mermaid อยู่ในเอกสารครบแล้ว

### ⚠️ ข้อบกพร่องเล็กน้อยของเอกสาร ต้องแก้เอง 10 วินาที
ตัวหนาที่อยู่**ในช่องตาราง** ถูก Google แปลงเป็นตัวอักษร `**` จริงๆ (เห็นเป็น `**0 ชิ้น**`) → เปิดเอกสารกด **Ctrl+H แทนที่ `**` ด้วยค่าว่าง** จะหายหมด ไม่กระทบส่วนอื่นเพราะไม่มี `**` ที่ตั้งใจไว้เลย

> **บทเรียนเรื่อง Google Drive MCP**: อัปโหลดด้วย `contentMimeType: text/markdown` ผลออกมา**แย่** — emoji 4-byte เพี้ยนเป็น mojibake (`📷` → `ð·`, `🟢` → `ð¢`) และ code block แตกเป็นย่อหน้าละบรรทัด
> **ใช้ `text/html` แทน** ได้ผลดีกว่าชัดเจน (code block อยู่เป็นก้อน ไม่มี mojibake) แต่ยังมีข้อจำกัด 2 ข้อ: **ห้ามใช้ emoji 4-byte** (ใช้ HTML entity เช่น `&#9888;` แทน) และ **`<b>` ในช่อง `<td>` จะกลายเป็นตัวอักษร `**`**

## 5. 🚧 ค้างไว้ให้คนถัดไป

| เรื่อง | สถานะ |
| :--- | :--- |
| **`package-lock.json` 11,479 บรรทัดอยู่ใน repo** | มาจาก commit ของเพื่อน (`8a4c53a`/`cd554de`/`79572c0`) — **ขัด CLAUDE.md §1 ที่ระบุ `pnpm` เท่านั้น** ยังไม่ได้คุยกับทีม |
| **ยิงข้ามกลุ่ม** | ยังไม่เคยทำ — เป็น deliverable ตรงๆ · contract พร้อมแล้ว ยืนยันแล้วว่ารับ field เกินได้ |
| **สมมติฐาน CPU contention** | ยังไม่ได้เก็บ `docker stats` ยืนยัน (ดู `handoff_29_08_2026_git-pull-k6-retry-local.md` §6) |
| **PSU passport login บน VM** | ยังไม่ยืนยันว่าสำเร็จ (ดู `handoff_29_08_2026_vm-psu-passport-login.md`) |
| **container ที่รันอยู่ยังใช้ image เก่า** | พฤติกรรมเหมือนกันเป๊ะ (โค้ดที่ถอดออกเป็น dead code) จะ rebuild ตอน deploy รอบหน้าก็ได้ ไม่ต้องรีบ |

### 🕳️ กับดักของเครื่องนี้ที่เจอซ้ำทุก session
**SynologyDrive เปลี่ยน mode bit ของไฟล์เป็น `100755` เองเรื่อยๆ** — session นี้เจอ 2 รอบ (4 ไฟล์ แล้ว 19 ไฟล์) ทั้งหมดเป็น mode-only (0 insertions, 0 deletions) **อย่า commit** ให้เช็คด้วย `git diff --summary` แล้วคืนด้วย:

```bash
git diff --summary | awk '{print $NF}' | xargs chmod 644
```
