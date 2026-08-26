# 🗣️ Design Review Q&A — reviewer 3 คนถกกันเรื่องอะไร

> **วันที่**: 2026-08-26 · **วิธีทำ**: reviewer 3 ตัวอ่านโจทย์ PDF + `Summary_Best_Practice` + เอกสาร Architecture + โค้ดจริง
> แยกกันทำรอบแรกโดยไม่เห็นงานกัน แล้วรอบสองเอาคำถามของแต่ละคนไปให้อีกสองคนตอบ
>
> **นี่คือบทสนทนาจริง ไม่ใช่บทที่แต่งขึ้น** — ตรงไหนมีคนยอมถอย จะเขียนไว้ว่ายอมถอย

| ผู้ร่วมวง | มุมที่ถือ |
| :--- | :--- |
| 🏎️ **PERF** | เร็วพอไหมภายใต้ 1,000 reader + 500 writer |
| 🔒 **CORRECT** | oversell ได้ไหม สต็อกรั่วตรงไหน |
| ✂️ **SIMPLE** | ของชิ้นไหนไม่คุ้มที่จะมี |

---

## 1. Blocker b ที่คิดว่าปิดแล้ว ยังเปิดอยู่

**🔒 CORRECT:** `orders.service.ts:144-146` ถามว่า "BullMQ คืน job เดิมมาหรือเปล่า" โดยเทียบ `job.data.requestToken` — แต่ **BullMQ ไม่เคยอ่าน `data` กลับจาก Redis** `Job.create()` เขียนกลับแค่ `job.id` (`bullmq/classes/job.js:124-135`) และฝั่ง Lua ตอนเจอ jobId ซ้ำก็แค่ `return jobId` ทิ้ง payload ใหม่ (`addStandardJob-9.js:445`) → `isPreexistingJob` **เป็น false เสมอ** เป็น dead code

**🏎️ PERF:** ผมได้ข้อสรุปเดียวกันโดยไม่ได้คุยกัน

**✂️ SIMPLE:** ผมเจอปัญหาคนละมุมแต่มันคือเรื่องเดียวกัน — `if (isPreexistingJob || state === 'completed')` ตัว `||` ทำให้ **job ที่เราเพิ่งสร้างเองแล้ว worker ทำเสร็จภายใน RTT ของ `getState()`** ถูกคืนสต็อกทั้งที่ขายจริง แล้วคนที่ได้ของกลับได้ 409

**🔒 CORRECT:** *(ยอมรับ)* race ของ SIMPLE จริง และผมมองข้ามไป มันแย่กว่าที่เขาบอกด้วย เพราะมันทำให้ Redis สูงกว่า DB ซึ่งไปป้อน attractor ในข้อ 4 — แต่ทางแก้ที่เขาเสนอ ("เชื่อ `isPreexistingJob` อย่างเดียว") เป็นไปไม่ได้ตามที่เพิ่งพิสูจน์

**✂️ SIMPLE:** *(ยอมรับ)* ผมผิด และพอรู้ว่ามันตาย สถานการณ์แย่กว่าที่ผมเขียน — **ทั้ง race ของผมจริง และรูเดิมที่ blocker (b) ตั้งใจปิดก็ยังเปิดอยู่** เพราะสาขาเดียวที่จะจับได้ไม่เคยเป็นจริง

### ✅ ข้อสรุปที่ทั้งสามคนเห็นตรงกัน

ใช้ `queue.getJob(jobId)` แทน `getState()` — CORRECT ตรวจแล้วว่ามันอ่าน `data` กลับจาก Redis จริง (`Job.fromId` → `HGETALL`)

| กรณี | token ที่เก็บอยู่ | ทำอะไร |
| :--- | :--- | :--- |
| job เดิมยัง `waiting`/`active` (รูเดิมของ blocker b) | ของ request เก่า | ไม่ตรง → คืนสต็อก ✅ |
| job ของเราเองที่เสร็จไปแล้ว (race ของ SIMPLE) | ของเรา | ตรง → **ไม่คืน** ✅ |
| job เดิมที่ `completed`/`failed` | ของ request เก่า | ไม่ตรง → คืนสต็อก ✅ |

round trip เท่าเดิม (`EVALSHA` → `HGETALL`) ปิดได้ 2 รูด้วยการเช็คเดียว
ถ้า `getJob` คืน `null` → **ห้ามคืนสต็อก** ให้ log ดังๆ แล้วตอบ 202 (คืนผิดแย่กว่าไม่คืน)

> ⚠️ `orders.service.spec.ts:222-238` ต้องเขียนใหม่ด้วย — มันปลอม return ของ `add()` เป็นรูปที่ BullMQ ทำไม่ได้
> **CORRECT เรียกมันว่า "artifact ที่อันตรายที่สุดใน repo" เพราะเทสต์เขียวจะทำให้คนถัดไปไม่มาดูตรงนี้อีก**

---

## 2. คอขวดอยู่ตรงไหนกันแน่

**🏎️ PERF:** เอกสารเขียนว่าคอขวดคือ `redis-data` — **ผิดลำดับแบบห่างมาก** write burst ทั้งชุดสร้างภาระให้ `redis-data` แค่ ~2,050 ops ส่วน read path `MGET` คือ 99% ที่เหลือ และรวมกันแล้ว Redis ยังอยู่ที่ **5–10% ของ 1 core**

คอขวดจริงคือ **event loop ของ Node** เพราะ k6 เป็น closed loop ไม่มี `sleep()` → Little's Law บังคับว่า 1,500 VUs ที่ p95 200ms = ต้องได้ ~10,000 rps = **3,300 rps ต่อ process** สำหรับ handler ที่มี 2 Redis hop + JSON parse/stringify + log 2 บรรทัด

**🔒 CORRECT:** ตัวเลขนั้นทำให้ความเสี่ยงของผม **มีโอกาสมากขึ้น ไม่ใช่น้อยลง** — BullMQ ต่ออายุ lock ด้วย `setTimeout` ทุก 15 วิ **บน event loop เดียวกับ API** ถ้า event loop ตัน job จะ stall และ `maxStalledCount: 1` แปลว่า stall ครั้งที่สอง job จะ fail **โดยไม่เรียก handler** → `compensateOnce` ไม่ทำงาน → สต็อกหาย 1 ชิ้น

**🏎️ PERF:** ซึ่งแปลว่าเราอยากได้การเปลี่ยนแปลงเดียวกันด้วยเหตุผลคนละอย่าง

**🔒 CORRECT:** ใช่ — และถ้า Redis อยู่แค่ 5–10% การขยับ `lockDuration` หรือแยก worker ออกไปคนละ process แทบไม่มีต้นทุนในทรัพยากรที่ขาดจริง **นี่คือความเห็นตรงกันแบบที่หนักแน่นที่สุดที่ review นี้จะให้ได้**

**พิสูจน์ได้ด้วยคำสั่งเดียว** ระหว่าง t=20–50s:
```bash
podman stats --no-stream --format 'table {{.Name}} {{.CPUPerc}}'
```
PERF ทำนาย: app แต่ละตัว ≥85% ของ core, redis ทั้งสอง ≤25% — **ถ้า `redis-data` กินมากกว่า app แปลว่า PERF ผิด**

---

## 3. Read path ควร 503 หรือ ตอบเลขเก่า

**🏎️ PERF:** `products.service.ts:114-123` โยน 503 เมื่อ `MGET` ล้ม ทั้งที่ `fallbackRemainingStock` นั่งอยู่ในแคชแล้ว — พอ `redis-data` สะดุด reader 1,000 คนจะค้างจนชน `proxy_read_timeout 5s` แล้วได้ **504** ซึ่งไม่อยู่ใน `expectedStatuses` ด้วยซ้ำ เลขเก่านิดหน่อยแย่กว่าอ่านไม่ได้ทั้งระบบจริงเหรอ

**🔒 CORRECT:** *(ยอมรับ)* **PERF ถูก ผมยอม** ผมปกป้อง invariant ที่ไม่มีอยู่จริง — ไม่มีใครซื้อของจาก response ของ `GET` ตัวตัดสินคือ `gatekeeper.lua` การอ่านเลขเก่าไม่ทำให้ oversell, ไม่ทำให้ซื้อซ้ำ, ไม่ทำให้ Redis กับ DB เพี้ยน **read path ไม่ใช่พื้นผิวของความถูกต้อง**

แต่ fallback ก็ไม่ได้สะอาด — `fallbackRemainingStock` คือค่า DB ตอนเติมแคช ระหว่าง burst มันอาจบอก 47 ทั้งที่จริงเป็น 0 **ให้ fallback แต่ทำให้เห็นได้** นับ metric + log ระดับ error เพื่อให้รายงานบอกได้ว่าเสิร์ฟแบบ degraded ไปกี่ใบ

**สิ่งที่ห้ามยุบ**: `gatekeeper.lua:13` ที่แยก "ไม่มี key" ออกจาก "เป็น 0" — อันนั้น load-bearing

---

## 4. `compensated:{jobId}` ทำให้ระบบไม่ self-heal

**🔒 CORRECT:** guard ตัวนี้ทำให้ compensation idempotent ด้วยการทำให้มัน **ย้อนกลับไม่ได้** — พอคืนไปแล้วก็คืนตลอดกาลแม้ job จะสำเร็จทีหลัง ผลคือ Redis สูงกว่า DB → gatekeeper ปล่อยคนที่ 51 → job ตาย sold-out → คืนอีก → **`stock:flash_sale:p-1001` ลู่เข้าหา 1 ไม่มีวันถึง 0** ตกเกณฑ์ §9.3 ข้อ 4 ตรงๆ ควรใส่เพดานใน `compensate-once.lua` ไหม

**🏎️ PERF:** เพดานฟรีอยู่แล้ว สคริปต์ถือ key อยู่ในมือ เพิ่ม 2 op ใส่ไปเถอะ — **แต่มันไม่แก้ loop ที่คุณอธิบาย** เพราะ attractor นั่งอยู่ที่ **1** ส่วนเพดานคือ 50 มันไม่มีวันทำงาน

เครื่องยนต์ของ loop คือ `err instanceof SoldOutError` ที่ `orders.processor.ts:101` — `SoldOutError` เกิดตอน Tier 1 บอกผ่านแต่ DB บอกไม่ผ่าน **นั่นคือสัญญาณว่าเพี้ยนอยู่แล้ว** การคืนตรงนั้นคือการง้างกับดักใหม่ทุกครั้ง **ถ้าไม่คืนตอน `SoldOutError` loop จะกลายเป็นการลู่เข้า** — แต่ละใบยังกิน user ไป 1 คน (ได้ 202 แล้วไม่มีของ) แต่มันดัน Redis ลงหา DB แล้วจบ

**✂️ SIMPLE:** ผมรับ attractor ได้ และ **ไม่เอาเพดานใน Lua** เพราะ Lua ไม่รู้ `available_stock` ต้อง seed key `stock:cap:*` เพิ่ม ซึ่งโปรเจกต์นี้แพ้เรื่อง seed ค้างมาแล้ว และ `SET NX` จะการันตีว่า cap ที่ผิดไม่มีวันถูกแก้ แถม **การ clamp เงียบๆ เปลี่ยน drift ที่ตรวจเจอให้กลายเป็น drift ที่มองไม่เห็น** — ให้ดังแทน: assert `redis GET == DB remaining_stock` ในสคริปต์ verify แล้ว fail ทั้ง run ไปเลย

**✂️ SIMPLE:** *(ยอมรับ)* และข้อนี้ค้านตัวผมเอง — การยุบ `compensate` เข้า `compensateOnce` ตามที่ผมเสนอ ทำให้ทุก path เข้ามาอยู่ใต้ guard = ขยายพื้นที่ของ attractor ผมยังแลก แต่จะไม่แกล้งทำเป็นว่าไม่มีต้นทุน

**เงื่อนไขจริงที่จะจุดชนวน**: ต้องมีคนกด **Retry ใน Bull-Board** — ซึ่งเป็น dashboard ที่โจทย์บังคับให้มี และปุ่มอยู่ตรงนั้นพอดี → **ระหว่างเก็บผล ห้ามกด**

---

## 5. Cache invalidation 50 ครั้งใน 1 วินาที

**✂️ SIMPLE:** ADR-4 เขียนว่าได้ hit ratio ≥90% *"โดยไม่ต้อง invalidate ตอนขายเลยแม้แต่ครั้งเดียว"* แต่ `orders.processor.ts:129` ล้าง **ทุกหน้า** ทุกครั้งที่ขายได้ PERF ทำนาย hit ratio เท่าไหร่ นี่เป็นตัวเลขที่ต้องขึ้น dashboard

**🏎️ PERF:** *(ยอมถอย)* คำถามนี้ทำให้ผมกลับไปคำนวณใหม่ **แล้วผลออกมาอ่อนกว่าที่ผมจัดอันดับไว้** k6 สร้าง cache key แค่ 7 ตัว, 50 wipe เกิดใน window ~300 ms → miss ~900–1,500 ใบ จาก ~180,000 ใบ = **hit ratio ~98%** คำสัญญา ≥90% รอดสบาย **ผมขอลด finding นี้จาก p95 ลงไปเป็น p99 blip**

สองอย่างที่ยังไม่ยอม: (1) ตัวเลขถูกแต่ **ประโยคบรรยายโค้ดที่ไม่มีอยู่จริง** — แก้ประโยคหรือแก้โค้ด อย่าตีพิมพ์ทั้งคู่ (2) เลขจาก `INFO stats` รวม `SMEMBERS` ด้วย ให้เรียกมันว่า "metadata cache GET hit ratio" ไม่ใช่ "cache hit ratio"

**✂️ SIMPLE:** ให้ debounce ≤1 ครั้ง/วินาที แล้วเขียนในรายงานตรงๆ — โจทย์ข้อ 4 ต้องการให้ "GET แสดงสต็อกล่าสุดที่ถูกต้อง" ซึ่ง **overlay ให้ผลนั้นตลอดเวลาโดยไม่มีเงื่อนไข ซึ่งแรงกว่าการ invalidate ด้วยซ้ำ** debounce ยังนับว่า invalidate เกิดขึ้นจริงและถูกกระตุ้นด้วย DB update สำเร็จ

แต่อย่าเดาใจกรรมการ — **ยิงทั้งสองแบบแล้วเอาเลข hit ratio วางคู่กัน** "เรา debounce เพราะ overlay ทำให้ per-sale ไม่จำเป็น นี่คือต้นทุนที่วัดได้ของการทำ per-sale" เป็นสไลด์ที่ดีกว่าเลขเดี่ยวๆ

> เหตุผลที่ต้องล้างทั้งหมด ไม่ใช่เฉพาะสินค้านั้น: แคช key ตาม **หน้า** ไม่ใช่ตามสินค้า
> จะ scope ต่อสินค้าได้ต้องเปลี่ยน key ทั้งระบบ — เขียนไว้ในรายงานสัก 1 ประโยคว่าเป็นต้นทุนที่รู้ตัวของการแคชแบบ page-keyed

---

## 6. Worker กับ API แย่ง connection pool กันจริงไหม

**🏎️ PERF:** `architecture.md` §8 กับ ADR-6 บอกว่า "API กับ worker แย่ง pool 10 ตัวเดียวกัน นั่นคือเหตุผลที่ concurrency ต้องเป็น 5" — **โค้ดไม่ได้ทำแบบนั้น** `replication` + `defaultMode:'slave'` สร้าง pool **แยกต่อ master และต่อ slave** (`PostgresDriver.js:1380`) API อ่าน catalog ไปที่ slave pool ส่วน worker ขอ `createQueryRunner('master')` **ไม่เคยชนกัน** concurrency จะเป็น 10 ก็ยังปลอดภัย

และสูตร `instances × (1+replicas) × poolSize ≤ 80% ของ max_connections` **มิติผิด** — บวก connection ที่ไปคนละ server แล้วเทียบกับ limit ของ server เดียว ค่าที่ถูกคือ 30 บน primary และ 30 บน replica แยกกัน

เพดานจริงของ write ไม่ใช่ pool ด้วยซ้ำ — 50 update ยิงแถวเดียวกัน มัน serialize ที่ row lock ไม่ว่า concurrency จะเป็น 5 หรือ 50

**พิสูจน์**: `SELECT count(*) FROM pg_stat_activity` ทั้งพอร์ต 5432 และ 5433 ระหว่าง read burst — ถ้า primary ขยับตามโหลดอ่าน แปลว่า PERF ผิด

---

## 7. ตัด PostgreSQL replica ไหม

**✂️ SIMPLE:** ไม่มีในโจทย์เลย (§1.3 พูดถึง connection pooling ไม่ได้พูดถึง replication) read path เป็น cache-first + single-flight → replica รับไม่ถึง 1% ของ read reviewer 2 ใน 3 ในรอบก่อนก็โหวตให้ตัดแล้ว

**🏎️ PERF:** ผลกระทบที่วัดได้จริงคือ **CPU และ fsync แย่งกันบนเครื่องทดสอบเครื่องเดียว** — replica เป็น Postgres เต็มตัวที่มี WAL receiver fsync ตลอดเวลา บนเครื่องที่ต้องปั่น ~6,700 rps ให้ได้ ลองปิดแล้วชี้ `DB_REPLICA_HOST=postgres-primary` แล้ววัดใหม่

อีกอย่างที่คนมองข้าม: `hot_standby_feedback=on` ทำให้ replica ดัน xmin กลับไป **หน่วง vacuum บน primary** — "read replica" จึงไม่ใช่ของที่เพิ่มเข้ามาแบบ read-only มันคือ coupling ในทิศที่ไม่มีใครคาด

**แต่มีกับดัก**: ตัดแล้ว master กับ slave ยุบเป็น pool เดียว → **สร้าง** การแย่ง pool ที่เอกสารอ้าง (ผิด) ว่ามีอยู่แล้ว ต้อง re-derive `WORKER_CONCURRENCY` ก่อน อย่าตัดแล้วปล่อยตัวเลขเดิม

**✂️ SIMPLE:** กับดักจริง และแก้ด้วยบรรทัดเดียว — `DB_POOL_SIZE=20` แล้ว `3 × 20 = 60` เท่าเดิม headroom เท่าเดิม `WORKER_CONCURRENCY=5` ยังอยู่ในของตัวเองจริงๆ **การตัดจึงทำให้เหตุผลของ ADR-6 กลายเป็นเรื่องจริงแทนที่จะเป็นความหวัง — เป็นของแถม ไม่ใช่ต้นทุน**

**🔒 CORRECT:** จากมุมความถูกต้องผม**ไม่คัดค้าน** ขอแค่ `orders.processor.ts:56` ยังเป็น `createQueryRunner('master')` เพื่อให้ invariant รอดจากการ refactor ไม่ใช่กลายเป็นจริงโดยบังเอิญ

---

## 8. in-flight lock จำเป็นไหม ในเมื่อมี UNIQUE อยู่แล้ว

**🔒 CORRECT:** *(ถาม SIMPLE)* ถ้าตัด lock อะไรกัน `stock:flash_sale:p-1001` ไม่ให้รั่วทีละหน่วยเวลาคนกดรัว

**✂️ SIMPLE:** ผมไม่เคยเสนอให้ตัด — ผมจัดมันเป็น "เก็บ" ตั้งแต่รอบแรก แต่กรอบของคุณดีกว่าของผม ขอรับไปใช้: **`UNIQUE` ปกป้อง *order* ส่วน lock ปกป้อง *counter*** กดรัวโดยไม่มี lock = `DECR` สองครั้ง order ใบเดียว ตัวที่สองไม่มีใครกิน และ**ไม่มี path ชดเชยเพราะไม่มีอะไรล้มเหลว** นั่นคือ undersell ซึ่งทั้งสามคนเห็นตรงกันแล้วว่าเป็นความเสี่ยงตัวจริง

มันยังทำให้ข้อสังเกตของผมคมขึ้นด้วย — คุณค่าทั้งหมดของ lock อยู่ในช่องว่างระหว่าง `markBought` กับ `releaseInFlightLock` (`orders.processor.ts:126-128`) **และไม่มีอะไรในโค้ดบอกว่า 2 บรรทัดนั้นห้ามสลับ**

---

## 9. lock token ที่ไม่ unique ทำให้ compare-and-delete เป็นของประดับ

**🔒 CORRECT:** `release-lock.lua` ทำ compare-and-delete ถูกต้องตามหลัก **แต่ token ไม่ unique ต่อการถือครอง** — ค่าใน lock คือ `jobId` = `order:{u}:{p}` ซึ่งเหมือนกันทุกครั้งที่ user คนนี้ขอสินค้าตัวนี้ CAS จึงไม่มีวันปฏิเสธตัวที่ผิดได้

ซ้ำร้าย `compensate.lua:9` ทำ `DEL` แบบไม่มีเงื่อนไข ซึ่งผิดกฎ `CLAUDE.md` §6 ตรงๆ → request B ที่ถูกปฏิเสธจะไปลบ lock ที่กำลังคุ้มครอง job A อยู่ → request C ผ่าน gatekeeper ได้ → รั่วอีกหน่วย **ขยายผลตัวเอง**

`requestToken` ที่สร้างไว้แล้วที่ `orders.service.ts:111` **คือ nonce ที่ต้องการพอดี — แค่ถูกส่งผิดที่** (ไปอยู่ใน job payload แทนที่จะเป็นค่าของ lock)

---

## 10. ไม่มีทาง reset — ปัญหาที่จะเจอก่อนทุกข้อข้างบน

**✂️ SIMPLE:** ยิง k6 จบรอบแรก: `stock:*` = 0, `bought:` 50 key **ไม่มี TTL** ค้างใน AOF, DB `remaining_stock` = 0
`seed.ts` ใช้ `ON CONFLICT DO UPDATE` ที่ไม่แตะ `remaining_stock` · `seed-redis.ts` ใช้ `SET … NX`
→ **restart แล้ว re-seed ไม่เปลี่ยนอะไรเลย รอบสองได้ 409 ล้วน**
ทางเดียวคือ `podman compose down -v` ซึ่ง `CLAUDE.md` §8 บังคับให้ขออนุญาต และลบ volume Postgres ไปด้วย → replica ต้อง basebackup ใหม่ทั้งก้อน

**🔒 CORRECT:** และ deliverable บังคับให้ยิงข้ามกลุ่ม — กลุ่มเพื่อนยิงด้วย `user-1..user-500` **ซึ่งเป็น ID ชุดเดียวกับที่ `loadtest.js` ของเราใช้** ถ้าไม่ล้าง `bought:` ก่อน run ของเขาจะได้ 409 ทั้งหมด

**สคริปต์ `pnpm run reset` ~15 บรรทัด** (`UPDATE products SET remaining_stock = available_stock`, `DELETE FROM orders`, `DEL stock:* bought:* compensated:*`, แล้ว re-seed) — SIMPLE เรียกมันว่า **ของที่ขาดหายซึ่งมีค่าที่สุดใน repo นี้**

---

## 📋 สรุป

### เห็นตรงกันทั้ง 3 คน
| # | ประเด็น |
| :-- | :--- |
| 1 | `isPreexistingJob` เป็น dead code · blocker (b) ยังเปิดอยู่ · แก้ด้วย `queue.getJob()` |
| 2 | เทสต์ `orders.service.spec.ts:222-238` ปลอมพฤติกรรมที่ BullMQ ทำไม่ได้ ต้องเขียนใหม่ |
| 3 | ไม่มีทาง reset = ปัญหาที่จะเจอก่อนเพื่อน |
| 4 | Stock Overlay เป็นไอเดียที่ดีที่สุดในดีไซน์นี้ ไม่มีใครแตะ |
| 5 | atomic `UPDATE … WHERE remaining_stock > 0` + `UNIQUE` คือที่มาเดียวของการกัน oversell |

### มีคนยอมถอย
| ใคร | เรื่องอะไร |
| :--- | :--- |
| 🔒 CORRECT | ยอมว่า read path ควร fallback ไม่ควร 503 · ยอมว่า race ของ SIMPLE จริง |
| ✂️ SIMPLE | ยอมว่าทางแก้ที่เสนอเป็นไปไม่ได้ · ยอมว่า compensation machinery เป็นของที่ต้องมี |
| 🏎️ PERF | ยอมว่า cache hit ratio จะได้ ~98% ไม่ใช่ต่ำกว่า 90% ลด finding ตัวเองลงเป็น p99 |

### ยังเห็นต่าง
| ประเด็น | 🏎️ PERF | 🔒 CORRECT | ✂️ SIMPLE |
| :--- | :--- | :--- | :--- |
| เพดานใน `compensate-once.lua` | เอา (ฟรี) แต่ไม่แก้ loop | เอา | **ไม่เอา** — clamp เงียบๆ ซ่อน drift |
| ตัด PG replica | ตัด | ไม่คัดค้าน | ตัด |
| invalidate ต่อ order | debounce | — | debounce แต่วัดทั้งสองแบบ |

### สิ่งที่เอกสารเขียนไว้แล้วโค้ดไม่ตรง
1. `architecture.md` §8 — สูตร connection **มิติผิด** และ "API แย่ง pool กับ worker" **ไม่จริง**
2. `architecture-rationale.md` ADR-4 — "ไม่ต้อง invalidate ตอนขายเลย" **ขัดกับ `orders.processor.ts:129`**
3. `architecture-rationale.md` Q3 — "คอขวดคือ `redis-data`" **ผิดลำดับ** คอขวดคือ event loop
4. `CLAUDE.md` §6 — "Redis คือ optimization ไม่ใช่ dependency" **ไม่จริงตอน runtime** เพราะ `maxRetriesPerRequest: null` ไม่มี `commandTimeout` → คำสั่งค้าง ไม่ reject → `catch` ไม่ทำงาน ได้ 504 แทน fallback

### ที่ต้องตัดสินใจ (ยังไม่ได้แก้)
| # | เรื่อง | ใครหนุน |
| :-- | :--- | :--- |
| 1 | เปลี่ยน `getState()` → `getJob()` + เทียบ token ที่เก็บอยู่ | ทั้ง 3 |
| 2 | เขียน `orders.service.spec.ts` เคส duplicate ใหม่ | ทั้ง 3 |
| 3 | เพิ่ม `pnpm run reset` | ทั้ง 3 |
| 4 | read path fallback แทน 503 + นับ metric | PERF, CORRECT |
| 5 | ไม่คืนสต็อกตอน `SoldOutError` | PERF |
| 6 | debounce `invalidateCatalogCache()` | PERF, SIMPLE |
| 7 | ใส่ `commandTimeout` ให้ ioredis | PERF |
| 8 | `compensated:` TTL 86400 → 300 วิ | PERF |
| 9 | ย้าย `requestToken` ไปเป็นค่าของ lock (ให้ CAS ทำงานจริง) | CORRECT |
| 10 | ตัด PG replica + `DB_POOL_SIZE=20` | SIMPLE, PERF |
| 11 | แก้เอกสาร 4 จุดที่ไม่ตรงโค้ด | ทั้ง 3 |

> ⚠️ ทุกข้อในตารางนี้แตะ `CLAUDE.md` §8 (นโยบาย cache/concurrency, config หลัก, invariant §4) — **ต้องขออนุมัติก่อนแก้**

---

## 📎 อ่านต่อ
- [`01-codebase-primer.md`](01-codebase-primer.md) — โค้ดไฟล์ไหนเรียกไฟล์ไหน
- [`architecture-rationale.md`](../../Architecture/architecture-rationale.md) — บันทึก design review รอบก่อน
- [`CLAUDE.md`](../../../CLAUDE.md) §0.1 — สิ่งที่ยังไม่ได้ทำ
