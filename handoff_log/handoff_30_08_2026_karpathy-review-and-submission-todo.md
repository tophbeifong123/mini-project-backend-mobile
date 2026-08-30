# 🎯 Karpathy Review (6 agent) + สิ่งที่ต้องทำก่อนส่ง

> **วันที่**: 2026-08-30
> **ทำอะไร**: อ่านโจทย์ต้นฉบับใหม่ทั้งฉบับ (ได้ข้อความไทยครบครั้งแรก) + รีวิวโค้ดด้วย 6 agent ผ่าน skill `andrej-karpathy-skills:karpathy-guidelines`
> **แตะโค้ดไหม**: ❌ ไม่แตะ `src/` เลย — เอกสารล้วน
> **ทำไมต้องมีไฟล์นี้**: ข้อ 1–4 ข้างล่างคือของที่ต้องทำก่อนส่ง แล้วยังไม่มีใครทำ · เขียนไว้กันลืม

---

## 0. 🔑 วิธีอ่านโจทย์ต้นฉบับให้ได้ภาษาไทย (สำคัญ — เสียเวลาไปรอบนึงแล้ว)

`pdftotext` เปล่าๆ จะ **ทิ้ง glyph ไทยหมด** เหลือแต่คำอังกฤษ ทำให้อ่านโจทย์ได้ไม่ครบ ต้องใส่ `-enc UTF-8`:

```bash
pdftotext -enc UTF-8 -layout "docs/Requirement/Flash Sale System.pdf" -
```

> เครื่องนี้ไม่มี `pdftoppm` / `pdffonts` (มีแต่ `pdftotext.exe` ใน `/mingw64/bin`) → Read tool เปิด PDF เป็นภาพไม่ได้ ต้องใช้คำสั่งข้างบนเท่านั้น

---

## 1. 📸 แคปหน้าจอ 4 ภาพ (ยังไม่มีสักภาพ · ไม่มีโฟลเดอร์ `fig/` ด้วยซ้ำ)

| ภาพ | วางเป็นไฟล์ | TODO ในรายงาน |
| :--- | :--- | :--- |
| k6 summary | `fig/k6-summary.png` | `Report_flash-sale-report.md:390-391` |
| Bull-Board ตอน Completed = 50 | `fig/bullboard.png` | `:399-400` |
| ผล `./scripts/cache-stats.sh` | `fig/cache-stats.png` | `:408-409` |
| **หน้าจอ Database (integrity proof)** | ยังไม่มีช่องในรายงาน — ต้องเพิ่มเอง | — |

### ⚠️ ข้อที่ 4 เพิ่งรู้ตอนอ่านโจทย์ไทยครบ

โจทย์ §3 ข้อ 4 เขียนว่า **"แคปเจอร์หน้าจอ Database เพื่อพิสูจน์ว่า:"**
→ ต้องเป็น **ภาพหน้าจอ DB จริง** ไม่ใช่ paste ผล SQL เป็นข้อความ ต้องเห็น 2 อย่าง:

- `remainingStock` ของสินค้ามีค่าเป็น **0 พอดี ไม่มีการติดลบ**
- ตาราง Orders มี record ของผู้ใช้ **50 คนที่ไม่ซ้ำกันเลย และไม่มีใครได้เกิน 1 ชิ้น**

คำสั่งที่ใช้พิสูจน์อยู่ใน `docs/Architecture/architecture.md` §9.3 (และ `CLAUDE.md` §7 ข้อ 5) — รันแล้วแคปหน้าจอ client (pgAdmin / DBeaver / `psql`) ไม่ใช่ copy text

---

## 2. 🧾 ต้องเขียนอธิบายในรายงานว่า **ทำไม Failed Jobs = 0**

### โจทย์คาดหวังอะไร

โจทย์ §3 "สิ่งที่ต้องแสดงใน Dashboard" ข้อ 2 เขียนว่า:

> Queue Monitoring: แสดงสถานะของ Worker, จำนวน Jobs In Queue, Completed Jobs, และ Failed Jobs
> **(เช่น กรณีของหมดแล้ว หรือ User คนเดิมพยายามซื้อซ้ำ)**

อาจารย์คาดว่า 2 เคสนี้จะไปโผล่ที่ **Failed Jobs**

### แต่ระบบเราไม่เป็นแบบนั้น (โดยเจตนา)

| เคส | ระบบเราทำอะไร | ผลบน Bull-Board |
| :--- | :--- | :--- |
| ของหมด | `gatekeeper.lua` ปฏิเสธ → 409 **ก่อนเข้าคิว** (`src/orders/orders.service.ts:118`) | ไม่มี job เกิดขึ้นเลย |
| ซื้อซ้ำ | `bought:` key ชน → 409 **ก่อนเข้าคิว** (`orders.service.ts:105`) | ไม่มี job เกิดขึ้นเลย |
| กดรัวขณะมี job ค้าง | lock ชน → 429 **ก่อนเข้าคิว** (`orders.service.ts:109-115`) | ไม่มี job เกิดขึ้นเลย |
| permanent failure ใน worker (`23505` / สต็อกหมดตอน UPDATE) | `return` ไม่ `throw` (`orders.processor.ts:92,113`) | นับเป็น **Completed** ไม่ใช่ Failed |

→ **Bull-Board จะโชว์ Failed = 0 และ Completed = 50** ซึ่งถูกต้องตามดีไซน์

### ต้องเขียนอะไร

เพิ่มย่อหน้าใต้ภาพ Bull-Board (`Report_flash-sale-report.md` แถวบรรทัด 399) อธิบายว่า:

1. Failed = 0 **ไม่ได้แปลว่า dashboard พัง** — แปลว่า 4-Tier Defense ทำงานถูก คือกรองทิ้งตั้งแต่ tier 2 (Redis gatekeeper) ไม่ปล่อยให้ขยะไหลเข้าคิว
2. เคส "ของหมด/ซื้อซ้ำ" ไปโผล่เป็น **HTTP 409 ใน k6 summary** แทน — ชี้ไปที่ตัวเลขนั้นให้อาจารย์เห็นว่าเคสถูกทดสอบจริง
3. permanent failure ใช้ `return` เพราะ retry ไม่มีทางสำเร็จ (invariant §4 ข้อ 10) — ถ้า `throw` จะกลายเป็น retry 3 รอบเปล่าๆ แล้วค่อยตกเป็น Failed ซึ่งเปลืองและอ่านผิดความหมาย
4. ระบุว่าถ้าอยากเห็นตัวเลขแยกรายเหตุผล ให้ดู `/admin/insights`

> เขียนเชิงรุกไว้เลยดีกว่ารอให้อาจารย์ถาม — เพราะตัวเลขบนภาพจะไม่ตรงกับที่โจทย์บรรยายไว้

---

## 3. 🔀 ยิงข้ามกลุ่ม + เติมตารางเปรียบเทียบ

โจทย์ §3 บังคับตรงๆ: **"ยิงทดสอบระบบของกลุ่มตนเอง รวมถึงระบบของกลุ่มเพื่อน"**
และ §4 deliverable 3: *"ตารางเปรียบเทียบผลลัพธ์: การยิง Load test ใส่ API กลุ่มตัวเอง เทียบกับผลการยิงใส่ API ของกลุ่มเพื่อน (วิเคราะห์สาเหตุหากเกิดคอขวด)"*

**สถานะ: ยังไม่เคยเกิดขึ้นเลยแม้แต่ครั้งเดียว**

ช่องที่รออยู่ในรายงาน:
- `Report_flash-sale-report.md:498-500` — คอลัมน์ `กลุ่ม ____________` ว่าง
- `:535-539` — ย่อหน้าวิเคราะห์คอขวด เป็นเส้นประ 3 บรรทัด

### ทำได้เลยไม่ต้องรอใคร

k6 script เขียนตาม style ของแต่ละกลุ่มได้ ไม่มีข้อบังคับ → เอา `loadtest.js` ของเราชี้ `BASE_URL` ไปที่ระบบเพื่อนได้ทันที (มันอ่านจาก env)

สิ่งที่ต้องเช็คก่อนยิง: เพื่อน seed `p-1001` ไว้ 50 ชิ้นเหมือนกันไหม ไม่งั้นตัวเลขเทียบกันไม่ได้

---

## 4. 📄 เติมสมาชิก + render diagram + export PDF

### 4.1 รายชื่อสมาชิก — **กลุ่มละ 3 คน** (โจทย์ระบุ "กลุ่มละ 3 คน")

- `Report_flash-sale-report.md:24-30` — TODO (1/4) ช่องชื่อว่าง 2 เส้น
- `:547` — TODO เติมชื่อ–นามสกุล **รหัสนักศึกษา** และหน้าที่
- รายละเอียดหน้าที่ของแต่ละคนอยู่ในหัวข้อ 5 ของรายงานแล้ว แค่ผูกชื่อเข้าไป

### 4.2 Render diagram — มี source ครบ 4 อัน แต่ยังไม่เคย render สักอัน

| source | บรรทัดในรายงาน |
| :--- | :--- |
| `fig/arch.dot` | `:52` |
| `fig/dfd_read.dot` | `:92` |
| `fig/dfd_write.dot` | `:121` |
| `fig/tiers.dot` | `:233` |

คำสั่ง render เขียนไว้แล้วที่ `Report_flash-sale-report.md:4`:

```bash
dot -Tpng -Gdpi=170 fig/arch.dot -o fig/arch.png
```

> ⚠️ **เช็คแล้ว 2026-08-30: เครื่องนี้ยังไม่มี Graphviz (`dot` → not installed) และยังไม่มีโฟลเดอร์ `fig/`**
> ทางเลือก: ติดตั้ง Graphviz (`winget install graphviz` แล้วเปิด shell ใหม่) · หรือ paste `.dot` ลง [dreampuf.github.io/GraphvizOnline](https://dreampuf.github.io/GraphvizOnline/) แล้ว export PNG เอง
> อย่าลืม `mkdir fig` ก่อน ไม่งั้น `-o fig/arch.png` จะ error

### 4.3 Export PDF

โจทย์บังคับ **Report (PDF)** — ตอนนี้มีแต่ Markdown และ **ยังไม่มีขั้นตอน export ใดๆ ใน repo**

(หมายเหตุ: `handoff_29_08_2026_verify-audit-and-report-doc.md` บอกว่ามี Google Doc อยู่แล้ว — ถ้าใช้เส้นทางนั้นก็ export จาก Google Doc ได้ แต่ต้อง sync เนื้อหาให้ตรงกับ `.md` ก่อน)

---

## 5. 📊 ผลรีวิว 6 agent (บันทึกไว้อ้างอิง)

รีวิวด้วย skill `andrej-karpathy-skills:karpathy-guidelines` แบ่ง 6 ส่วน ใช้ rubric 4 แกนเดียวกัน

| ส่วน | คะแนน | แกนที่ต่ำสุด |
| :--- | :--- | :--- |
| Worker + DB | 8/10 | — |
| Write path | 7/10 | Surgical 6 |
| Read path + cache | 7/10 | Goal-Driven 6 |
| Infra + observability | 7/10 | Simplicity 6 / Surgical 6 |
| Auth + contract | 6/10 | **Goal-Driven 3** |
| Verification + deliverables | 5/10 | **Goal-Driven 4** |

**เฉลี่ย 6.7/10** · แพตเทิร์นชัด: **โค้ดแกนกลางแข็ง แต่ Goal-Driven Execution ร่วงทุกส่วนที่ออกจาก core** = ระบบถูก แต่พิสูจน์ไม่ครบ

### ✅ ยืนยันแล้วว่าถูก (ไม่ต้องไปแตะ)

- stock overlay อ่านสดจาก `MGET` ทุก request **รวมตอน cache hit** → ตอบ "เงื่อนไขสำคัญ" ของโจทย์ได้จริง
- invariant §4 ข้อ 3, 4, 7, 10 ครบ · Lua scripts สะอาด compare-and-delete ทุกตัว
- `userId` สวมสิทธิ์ไม่ได้จริง (`CreateOrderDto` ไม่มี field นั้น whitelist ตัดทิ้ง)
- requirement ด้าน infra ผ่านครบ: LB 6 instance · pooling 6×8=48 ≤ 100 · redis policy ถูกทั้ง 2 ตัว · Bull-Board มี auth · dashboard 3 ตัวเก็บได้ครบไม่ต้องเพิ่มเครื่องมือ
- build / lint / test ผ่าน (**43 tests** — ไม่ใช่ 32/35 ตามที่เขียนไว้หลายที่)

### 🔴 finding ที่ยังไม่ได้แก้ (เรียงตามความแรง)

> **อัปเดตท้ายวัน 2026-08-30** — ข้อ **4 กับ 6 แก้แล้ว** · ข้อ **2 ตรวจซ้ำแล้วพบว่าไม่ใช่บั๊ก จงใจปล่อยไว้**
> รายละเอียดใน [`handoff_30_08_2026_arch-doc-sync-and-compensation-guard-fix.md`](handoff_30_08_2026_arch-doc-sync-and-compensation-guard-fix.md)
> ข้อ 1, 3, 5, 7, 8, 10 **ยังเปิดอยู่ทั้งหมด**

| # | ที่ไหน | ปัญหา |
| :--- | :--- | :--- |
| 1 | `bullmq.module.ts:25-31` | ตั้ง `maxRetriesPerRequest: null` **ไม่มี `commandTimeout`** — ซึ่ง `redis.module.ts:26-33` เขียนเตือนเองว่าห้ามทำ → `catch` ที่ `orders.service.ts:158` ยิงไม่ออก ทั้งที่ DECR ไปแล้ว · **ข้อแม้**: ใส่แล้วจะพัง blocking command ของ worker → ที่ผิดคือ**ไม่ได้จดเหตุผลไว้** ไม่ใช่ค่า |
| 2 | `orders.service.ts:158-165` | `queue.add` throw แล้วเรียก `compensate()` แบบไม่มีเงื่อนไข ทั้งที่ไฟล์เดียวกัน `:190-191` เถียงไว้เองว่า "คืนผิดแย่กว่าไม่คืน" → counter จบสูงกว่า DB |
| 3 | `health.controller.ts:49` | docstring อ้างว่า 503 แล้ว nginx ถอด instance ออก — **ไม่มีอะไรทำแบบนั้น** (`nginx.conf:57-62` `max_fails=0`, compose probe แค่ `/health/live`) → instance ที่ DB ตายยังกินทราฟฟิก 1/6 ต่อไป |
| 4 | `redis.keys.ts:19` | guard เป็น `compensated:{jobId}` แต่ `jobId` deterministic → idempotent ข้าม**คำขอ** ไม่ใช่แค่ retry · ถ้า job record ถูก trim แล้วคนเดิมสั่งใหม่ใน 300 วิ = หายถาวร 1 ชิ้น · **รูใหม่ ยังไม่อยู่ใน CLAUDE.md §0.1** |
| 5 | `orders.controller.ts:23,48` | อ่าน `request.user.sub` แต่ `jwt.strategy.ts:34` คืนแค่ `{userId}` → branch แรกตายสนิท · แถม `validate()` คืน `{userId: undefined}` ซึ่ง truthy → **token ไม่มี subject ผ่านได้** |
| 6 | `products.service.ts:89-92` | `MGET` คืน `null` แล้วเสิร์ฟค่าเก่าเงียบๆ ไม่ log ไม่นับ ทั้งที่ฝั่ง write ตอบ 503 กับเคสเดียวกัน |
| 7 | `bullmq.module.ts:113-118` | `defaultJobOptions` **ไม่มีผลเลย** (ถูก override ครบทุก key ที่ `orders.service.ts:141-147`) แต่ comment อ้างว่าเป็นเรื่องความถูกต้องของ dedup — **2 agent เจอตรงกันคนละไฟล์** |
| 8 | `Dockerfile:20,39` | `pnpm install` ไม่มี `--frozen-lockfile` + track ทั้ง `package-lock.json` และ `pnpm-lock.yaml` → เครื่องใหม่อาจได้ dependency คนละเวอร์ชัน = "1-click start" ยังไม่การันตี |
| 9 | หลายที่ | จำนวน test เขียนผิด 3 ที่ (CLAUDE.md header = 32, §0.1 = 35, handoff = 35 · **จริง 43**) · `.env.example:34-36` ยังเขียน 3 instance/pool 10 (จริง 6/8) · `bull-board.service.ts:43` โชว์ backoff 200ms (จริง 500) — **ข้อหลังจะขึ้นภาพที่ส่ง** |
| 10 | `.gitignore:20` | `*.k6-summary.json` ดักไฟล์ที่ `loadtest.js:374` เขียนออกมาพอดี → หลักฐานที่ควรส่งถูก exclude อัตโนมัติ ส่วนไฟล์ที่ commit ไว้เป็นรอบที่ threshold ตก |

---

## 6. ⏭️ ทำต่อจากตรงไหน

เรียงตามผลต่อคะแนน:

1. **ข้อ 3** (ยิงข้ามกลุ่ม) — เป็น deliverable ตรงๆ ที่ยังเป็นศูนย์ และทำได้เลยไม่ต้องรอใคร
2. **ข้อ 1 + 4** (แคป 4 ภาพ + สมาชิก + render + PDF) — งานมือล้วน ไม่ต้องคิด
3. **ข้อ 2** (อธิบาย Failed = 0) — เขียน 1 ย่อหน้า กันอาจารย์เข้าใจผิด
4. finding 5 กับ 4 ในตารางข้างบน — เป็นบั๊กจริง แก้ไม่ยาก
5. finding 9 — เก็บกวาดตัวเลขในเอกสารให้ตรง
