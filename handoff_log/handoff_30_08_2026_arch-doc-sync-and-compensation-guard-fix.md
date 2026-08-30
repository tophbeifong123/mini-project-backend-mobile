# 🔧 Sync เอกสาร Architecture กับ observability layer + แก้ compensation guard

> **วันที่**: 2026-08-30 (ต่อจาก [`handoff_30_08_2026_karpathy-review-and-submission-todo.md`](handoff_30_08_2026_karpathy-review-and-submission-todo.md))
> **แตะ `src/` ไหม**: ✅ แตะ 7 ไฟล์ — `build` / `lint` / `test` ผ่านหมด (**5 suites / 49 tests**)
> **ยิง k6 ไหม**: ❌ **ยังไม่ได้ยิง** — ดู §5 ข้อควรระวัง

---

## 1. 📚 เอกสาร Architecture ตามโค้ดไม่ทัน (แก้แล้ว)

### ปัญหาที่เจอ

`architecture.md` แก้ล่าสุดที่ commit `00ca608` (2026-08-29) หลังจากนั้น `src/` โต **+1,729 บรรทัด / 20 ไฟล์** จาก 3 commit (`test`, `fix_bullmq_dash`, `dashbord`) ซึ่งเป็น **observability layer ทั้งชุดที่เพื่อน push มา**

วัดง่ายๆ: `grep -c "observability|insights|integrity" architecture.md` = **0**

### แก้ด้วย 3 agent แบ่งไฟล์ไม่ให้ชนกัน

| agent | ไฟล์ | ผล |
| :--- | :--- | :--- |
| 1 | `architecture.md` | +91 บรรทัด · §9.4 ชั้น Observability (endpoints + auth, เหตุผล write-behind, กติกา `IntegrityService`, ข้อจำกัด) · เพิ่ม key ใหม่ 2 ตัวใน §5.1 · เพิ่มแถว failure matrix §7 · re-point §0 traceability |
| 2 | `diagrams.md` + `architecture-rationale.md` | +184 / +101 บรรทัด · §10 DFD Level 2 + `P7` + store `D8` · ADR-8 (write-behind) · ADR-9 (ไม่ซ่อมอัตโนมัติ) · รีเช็ค §7 blocker |
| 3 | `architecture-primer.md` + `docs/Codebase/` | เส้นทางที่ 5 (Observability) + caller table ของ `MetricsService.inc()` |

### ของแถมที่มีค่าที่สุด: `file:line` เพี้ยน 17 จาก 24 จุด

agent 3 ไล่ตรวจ citation เดิมทั้งหมด เจอผิด 17 จุด เพี้ยนหนักสุดคือ `redis.service.ts:213/236-242/257-261` → `269-279/294-300/371-384` (**~56 บรรทัด และเพี้ยนมาก่อนงานรอบนี้แล้ว**)

พร้อมแก้คำตอบ Q&A ที่โค้ดหักล้างไปแล้ว 2 ข้อ:
- primer §6 เขียนว่า `redis-data` ล่มแล้ว "โยน 503 ไม่ยอมตอบเลข" — **ผิดมาตั้งแต่ 2026-08-26** ของจริง degrade เป็น `fallbackRemainingStock`
- primer §14 "ไม่มีอะไรใน runtime จับ drift อัตโนมัติ" — เป็นเท็จหลัง observability เข้ามา

---

## 2. 🐛 `IntegrityService` **ไม่ได้รันเองทุก 3 วิ** (ความเข้าใจผิดที่แพร่ไปแล้ว)

`CLAUDE.md` §0.1 เคยเขียนว่า *"เทียบ Redis counter กับ DB สดๆ ทุก 3 วิ"* — **ไม่จริง** และผมเองก็เอาไปบรีฟ agent ผิดด้วย

ยืนยันจากโค้ด:
- ไม่มี `@Cron` / `@Interval` / `setInterval` ฝั่ง server ใน `src/observability/` เลย — timer ตัวเดียวคือ `metrics.service.ts:69` ซึ่งเป็น flush ของ write-behind **คนละเรื่อง**
- `integrity.check()` ถูกเรียกจาก `observability.controller.ts:44,59` เท่านั้น = **รันตอนมีคนขอ endpoint**
- เลข 3 วิคือ `setInterval` ใน**เบราว์เซอร์** ที่ `insights.page.ts:431`

**ผลจริง: ปิดแท็บ = ไม่มีใครตรวจ drift และไม่มี alert** — แก้ข้อความใน CLAUDE.md §0.1 แล้ว

---

## 3. ✅ แก้บั๊ก 2 ข้อ (ผ่าน scrutinize ก่อนลงมือ)

### 3.1 guard key ผูกกับคำขอ — `compensated:{jobId}` → `compensated:{jobId}:{requestToken}`

**บั๊ก**: `jobId` เป็น deterministic (`order:{userId}:{productId}`) guard จึง idempotent ข้าม **คำขอ** ไม่ใช่แค่ข้าม retry ตามที่ §4 ข้อ 8 ตั้งใจ
→ ถ้า job record ถูก trim แล้วคนเดิมสั่งใหม่ใน 300 วิ: DECR รอบใหม่เกิดจริง แต่ `compensateOnce` คืน 0 → **หายถาวร 1 ชิ้น** → จบที่ `remaining_stock = 1`, orders 49/50 (**§9.3 ตก 2 ข้อ**)

**ความปลอดภัยที่ตรวจแล้ว** (สำคัญ — ถ้าผิดจะกลายเป็นคืนซ้ำ = oversell): BullMQ retry อ่าน `job.data` ชุดเดิม `job.data` เขียนครั้งเดียวตอน `Job.create` และแก้ได้ทางเดียวคือ `updateData` ซึ่ง **ไม่ถูกเรียกที่ไหนเลยใน `src/`**

**แตะ**: `redis.keys.ts` · `redis.service.ts:228` · `compensate-once.lua` (**คอมเมนต์เท่านั้น body ไม่แตะ**) · `reset.ts:79` → `compensated:*:*` (glob `*` ครอบ `:` จึงกวาด key เก่าได้ด้วย)

### 3.2 read path รู้ตัวเมื่อ stock key หาย

**บั๊ก**: `MGET` คืน `null` แล้วเสิร์ฟ `fallbackRemainingStock` **เงียบๆ** ไม่ log ไม่นับ · `redis-data` เป็น `noeviction` → `null` แปลว่า "ไม่เคย seed" ซึ่งฝั่ง write ตอบ **503** กับเงื่อนไขเดียวกัน → หน้าเว็บโชว์ `remainingStock: 50` ได้ทั้งที่ขายหมด โดยไม่มีใครรู้

**แก้**: metric ใหม่ `CATALOG_MISSING_STOCK_KEY` (**แยกจาก** `CATALOG_DEGRADED_READS` เพราะ "redis ล่ม" กับ "ไม่เคย seed" คนละเหตุการณ์) + log error **ไม่เกิน 1 ครั้ง/instance/10 วิ** พร้อมยอดสะสม + ยังเสิร์ฟ fallback ต่อ (ตาม §6 ที่บอกให้ degrade ไม่ใช่ล้ม)

> ⚠️ **ทำไมต้อง throttle**: endpoint นี้โดนยิง 1,000 VUs ถ้า key หายจริงจะเข้ากิ่งนี้ทุก request · `logger.module.ts` **ไม่มี rotation ของตัวเอง** (pino → stdout) rotation อยู่ที่ Docker `json-file` `max-size:10m`/`max-file:3` → log ทุกใบจาก 6 instance จะ**ล้าง ring 30MB ทิ้งในไม่กี่วินาที = ทำลายหลักฐานที่อยากได้เอง**

**หมายเหตุการออกแบบ**: `readStocks` เปลี่ยนเป็นคืน `{ stocks, degraded }` เพราะตอน Redis ล่มจริง **ทุก slot เป็น `null` หมด** ถ้านับ null ตรงๆ จะเอา 2 เหตุการณ์มารวมกัน — จึงนับ null เฉพาะตอน `MGET` สำเร็จจริง

---

## 4. ⏹️ สิ่งที่ **ตรวจแล้วตัดสินใจไม่แก้** (อ่านก่อนจะไป "แก้ให้ถูกหลัก")

### `compensate()` แบบไม่มีเงื่อนไขตอน `queue.add` ล้ม — **ถูกแล้ว อย่าแก้**

เดิมคิดว่าเป็นบั๊ก (ถ้า `add()` timeout แต่ job ถูกสร้างจริง → คืนผิด → Redis สูงกว่า DB) · ส่ง agent `/scrutinize` ไปตรวจแล้ว **ค้านกลับพร้อมหลักฐาน**:

| ทิศทาง | ซ่อมตัวเองได้ไหม |
| :--- | :--- |
| **Redis สูงกว่า DB** | ✅ คนถัดไปผ่าน gatekeeper → worker เจอ `affected = 0` → `SoldOutError` → **จงใจไม่คืน** → counter ลู่ลงจนถึง 0 พอดี · oversell เป็นไปไม่ได้เพราะ atomic UPDATE กันอยู่ (§4 ข้อ 4) |
| **Redis ต่ำกว่า DB** | ❌ ไม่มีวันซ่อม — ค้างที่ `remaining_stock = 1`, orders 49/50 ถาวร |

→ **การไม่คืนคือการเดิมพันฝั่งที่แย่กว่า** การคืนแบบไม่มีเงื่อนไขจึงถูกแล้ว

อีก 2 จุดที่ scrutinize จับได้:
- **`compensate-if-reserved.lua` ใช้ตรงนั้นไม่ได้** — ณ จุดนั้น lock ยังถือ token ของเราอยู่เสมอ (`gatekeeper.lua:36` ตั้ง และไม่มีอะไรลบจนกว่า worker จะ release หรือ TTL 30 วิ) สคริปต์จึงกลายเป็น `compensate.lua` เป๊ะๆ = **no-op**
- **"ความไม่สอดคล้อง" ที่คิดว่าเจอ ไม่ใช่ความไม่สอดคล้อง** — บรรทัดล่างคือ `add()` *สำเร็จ* (job น่าจะมี → ไม่คืน) ส่วนใน catch คือ `add()` *ล้มเหลว* (job น่าจะไม่มี → คืน) **ต่าง prior กัน ตรรกะเดียวกัน**

บันทึกลง `CLAUDE.md` §0.1 แล้วเพื่อกันคนมา "แก้" ซ้ำ

### JWT `sub` หาย → token ผ่านได้ — **ยังไม่แก้ (ผู้ใช้สั่งข้าม)**

`jwt.strategy.ts:34` คืน `{ userId: payload.sub }` ถ้าไม่มี `sub` จะได้ `{ userId: undefined }` ซึ่งเป็น **object = truthy** → passport ยอมรับ
⚠️ แต่รูที่ใหญ่กว่าคือ `JWT_SECRET` เป็น placeholder `flash-sale-dev-secret-change-me` commit อยู่ใน `docker-compose.yml` **6 ที่** และ `env.validation.ts:47` บังคับแค่ `MinLength(8)` → **ใครอ่าน repo ก็ปลอม token เป็น `sub` อะไรก็ได้** · แก้ secret ก่อน ค่อยแก้ `sub`

---

## 5. ⚠️ ข้อควรระวังก่อนส่ง

1. **ยังไม่ได้ยิง k6 หลังแก้** — `CLAUDE.md` §7 ข้อ 5 บอกว่าแตะ write path ต้องพิสูจน์ §9.3 · ยังไม่ได้ทำ ต้องยิงก่อนส่ง
2. หลังยิงให้เช็คเพิ่ม: `redis-cli -p 6380 --scan --pattern 'compensated:*'` ต้องว่างหลัง `reset`
3. ทดสอบ fix 3.2 ด้วยมือ: `DEL stock:flash_sale:p-1001` แล้วเรียก `GET /api/v1/products` ต้องได้ **200 + fallback** พร้อม log 1 บรรทัดต่อ instance ต่อช่วง และ counter ใหม่ขึ้น
4. `getDegradedReadCount()` **ไม่มีคนเรียกนอก spec** — dashboard อ่าน `catalog_degraded_reads_total` จาก metrics hash แทน · ปล่อยไว้ตามเดิม ไม่ได้ลบ

---

## 6. ⏭️ งานที่ยังค้าง

ดู [`handoff_30_08_2026_karpathy-review-and-submission-todo.md`](handoff_30_08_2026_karpathy-review-and-submission-todo.md) — deliverable ที่ยังขาด (PDF, screenshot 4 ภาพ, ยิงข้ามกลุ่ม, รายชื่อสมาชิก, render diagram) และ finding ที่ยังเปิดอยู่ **6 ข้อ** (1, 3, 5, 7, 8, 10)
