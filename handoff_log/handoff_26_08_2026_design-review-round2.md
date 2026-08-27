# Handoff — Design Review รอบ 2 + แก้ 10 ข้อ (2026-08-26)

**วันที่:** 2026-08-26 · **ผู้บันทึก:** NuiGates (ร่วมกับ Claude Code / Opus 5) · **สถานะ:** แก้ครบ ผ่าน build/lint/test — **ยังไม่เคยรันบน container**
**ขอบเขต:** เขียนเอกสารปูพื้นโค้ด + review ดีไซน์ด้วย 3 agent + แก้ตามที่ review เจอ 10 ข้อ
**ต่อจาก:** [`handoff_26_08_2026_backend-implementation.md`](handoff_26_08_2026_backend-implementation.md)

---

## 1. ตอนนี้อยู่ตรงไหน

- เพิ่ม `docs/Codebase/` — เอกสารว่าโค้ดทำงานยังไง (primer เดินโค้ดทีละ hop + บันทึก Q&A ของ reviewer)
- review ด้วย 4 agent (fact-finder + performance + correctness + simplicity) แล้ว **cross-examine รอบสอง**
- **แก้ 10 จาก 11 ข้อที่ review เจอ** · ข้อ 10 (ตัด PG replica) ตัดสินใจไม่ทำ
- `pnpm run build` ✅ · `pnpm run lint` ✅ · `pnpm run test` ✅ **32/32** (เดิม 30)
- **ยังไม่เคยรัน container และยังไม่เคยยิง k6** เหมือนเดิม

---

## 2. ของหนักที่สุดที่เจอ — blocker (b) ที่บันทึกว่า "ปิดแล้ว" ยังเปิดอยู่

รอบก่อนแก้ blocker (b) ด้วยการใส่ `requestToken` ลง job payload แล้วเทียบกับ `job.data.requestToken`
ที่ `queue.add()` คืนมา **ซึ่งใช้ไม่ได้เลย**:

- `Job.create()` เขียนกลับแค่ `job.id` ไม่เคยอ่าน `data` จาก Redis
  (`node_modules/bullmq/dist/cjs/classes/job.js:124-135` — อ่านโค้ดจริงยืนยันแล้ว)
- ตอน `jobId` ซ้ำ ฝั่ง Lua แค่ `return jobId` โดยทิ้ง payload ใหม่ (`addStandardJob-9.js:445`)
- → เทียบยังไงก็ตรงเสมอ = **เช็คตาย** และรูเดิมที่ blocker (b) ตั้งใจปิด **เปิดอยู่ตลอด**

**และเทสต์ที่เขียนไว้ก็ปลอม return ของ `add()` เป็นรูปที่ BullMQ ทำไม่ได้** — เทสต์เขียวจึงกลายเป็น
สิ่งที่ทำให้คนถัดไปไม่มาดูตรงนี้อีก reviewer เรียกมันว่า *"artifact ที่อันตรายที่สุดใน repo"* ซึ่งถูก

**ทางแก้**: `queue.getJob(jobId)` (`Job.fromId` → `HGETALL`) อ่าน `data` กลับจาก Redis จริง
แล้วเทียบ token ที่เก็บอยู่ — round trip เท่าเดิมกับ `getState()` ที่ถอดออก และปิดได้ 2 รูพร้อมกัน:

| กรณี | เดิม | ตอนนี้ |
| :--- | :--- | :--- |
| job เดิมยัง `waiting`/`active` | ❌ 202 ไม่คืนสต็อก = รั่ว | ✅ คืน + 409 |
| job ของเราเองที่ worker ทำเสร็จก่อน `getState()` กลับมา | ❌ คืนสต็อกทั้งที่ขายแล้ว + คนได้ของโดน 409 | ✅ ไม่คืน + 202 |
| อ่าน job กลับไม่ได้ | — | ✅ **ไม่คืน** + log ดัง (คืนผิดแย่กว่าไม่คืน) |

---

## 3. แก้อะไรไปบ้าง (10 ข้อ)

| # | เรื่อง | ไฟล์ | ทำไม |
| :-- | :--- | :--- | :--- |
| 1 | `getState()` → `getJob()` + เทียบ token ที่เก็บอยู่ | `orders.service.ts` | §2 ข้างบน |
| 2 | เขียนเทสต์ duplicate ใหม่ + เพิ่ม 3 เทสต์เรื่อง lock token | `orders.service.spec.ts` | mock เดิมปลอมพฤติกรรมที่ BullMQ ทำไม่ได้ |
| 3 | `RESET_CONFIRM=yes pnpm run reset` | `src/database/reset.ts` | ยิงรอบสองได้ 409 ล้วน (§5) |
| 4 | read path degrade แทน 503 | `products.service.ts` | read path ไม่ใช่พื้นผิวของความถูกต้อง — ตัวตัดสินคือ `gatekeeper.lua` |
| 5 | **ไม่คืนสต็อกตอน `SoldOutError`** | `orders.processor.ts` | `affected=0` = Redis สูงกว่า DB อยู่แล้ว คืนไปยิ่งวน ไม่ self-heal |
| 6 | debounce `invalidateCatalogCache()` ≤1/วิ | `redis.service.ts` | 50 ครั้งใน ~300 ms ตอน reader 1,000 คนยิงอยู่ |
| 7 | `commandTimeout: 1000` | `redis.module.ts` | `maxRetriesPerRequest: null` เพียวๆ = คำสั่ง**ค้าง** `catch` ไม่ทำงาน → 504 |
| 8 | `compensated:` TTL 86,400 → 300 วิ | `redis.service.ts` | retry chain จบใน ~2 วิ · guard ที่อยู่นานกว่างานของมัน = บล็อกการคืนที่ถูกต้องในอนาคต |
| 9 | lock เก็บ `requestToken` แทน `jobId` + `compensate*.lua` เป็น compare-and-delete | `gatekeeper.lua`, `compensate*.lua`, `orders.*` | `jobId` ซ้ำทุกครั้ง → CAS แยกการถือครองไม่ออก และ `DEL` เปล่าไปลบ lock ของ job คนอื่น |
| 11 | แก้เอกสาร 4 จุดที่บรรยายโค้ดที่ไม่มีอยู่จริง | `architecture.md`, `architecture-rationale.md`, `CLAUDE.md` | §4 |

**ข้อ 10 ที่ไม่ทำ**: ตัด PG replica — reviewer 2 ใน 3 หนุน แต่**กระทบ requirement** (read-write split
เป็นหัวข้อที่ต้องมีในรายงาน) และขัดกับการตัดสินใจของเจ้าของโปรเจกต์ตอนต้นเซสชัน

---

## 4. เอกสาร 4 จุดที่ผิด และแก้เป็นอะไร

| ที่ | เดิมเขียนว่า | ความจริง |
| :--- | :--- | :--- |
| `architecture.md` §8 | `instances × (1+replicas) × poolSize ≤ 80% ของ max_connections` | **มิติผิด** — บวก connection ที่ไปคนละ server แล้วเทียบกับ limit ของ server เดียว ที่ถูกคือ 30 บน primary / 30 บน replica **แยกกัน** |
| `architecture.md` §8 | "API กับ worker แย่ง pool 10 ตัวเดียวกัน" | **ไม่จริง** — `defaultMode:'slave'` ทำให้ TypeORM สร้าง pool แยก master/slave · API อ่านลง slave, worker ขอ master · `WORKER_CONCURRENCY=5` ไม่ได้มาจากเหตุผลนี้ |
| `rationale` ADR-4 | "hit ratio ≥90% โดยไม่ต้อง invalidate ตอนขายเลยแม้แต่ครั้งเดียว" | **ขัดกับโค้ด** — worker invalidate ทุกครั้งที่ขาย เพราะโจทย์ข้อ 2.3 กฎ 4 บังคับ (ตอนนี้ debounce แล้ว) |
| `rationale` Q3 | "คอขวดคือ `redis-data`" | **ผิดลำดับ** — write burst ทั้งชุด ~2,050 ops · Redis อยู่ที่ ~5–10% ของ 1 core · คอขวดจริงคือ **Node event loop** |

---

## 5. ยังไม่ชัวร์ / ที่ต้องระวัง

### ✅ ยืนยันแล้ว
- BullMQ semantics ทั้ง 3 ข้อ (add ไม่อ่าน data กลับ · duplicate เงียบ · `attemptsMade` ไม่ off-by-one) — อ่าน `node_modules` จริง
- build / lint / test 32 ข้อ · mermaid 34 บล็อก parse ผ่าน · internal link 131 อัน ไม่มีตาย

### ❓ ยังไม่พิสูจน์
- **ทุกอย่างในรอบนี้ยืนยันด้วย unit test กับการอ่านโค้ดเท่านั้น** ยังไม่เคยรัน container
- ข้อ 1 พึ่งพฤติกรรมของ `queue.getJob()` ว่าอ่าน `data` กลับจาก Redis — **ควรมี integration test ยืนยัน**
- ข้อ 6 debounce เป็น per-process (3 instance = ล้างได้สูงสุด 3 ครั้ง/วินาที) ยอมรับได้แต่ยังไม่ได้วัด
- `commandTimeout: 1000` ยังไม่เคยเจอสถานการณ์จริงว่ามันตัดเร็วเกินไปหรือเปล่า

### 🕳️ รูที่ยังเปิดอยู่โดยตั้งใจ
- `23505` ไม่คืนสต็อก — **reviewer ทั้ง 3 เห็นตรงกันว่าถูกแล้ว** การคืนจะทำให้ retry ปกติคืนซ้ำ
- ไม่มี reconciliation Redis ↔ DB
- **job stall เกิน `maxStalledCount`** → BullMQ ทิ้งไป `failed` โดย**ไม่เรียก handler** → `compensateOnce` ไม่ทำงาน → สต็อกหาย 1 ชิ้น (รูใหม่ที่รอบนี้เพิ่งเจอ ยังไม่ปิด)
- `WORKER_CONCURRENCY` อ่านตอน decorate class → `.env` ไม่มีผล

---

## 6. ก้าวถัดไป

1. **หาเครื่องที่มี podman/docker** → `podman compose up -d` (เช็ค `bash` ใน `postgres:16-alpine` ก่อน)
2. **ยิง k6** แล้วพิสูจน์ §9.3 ทั้ง 4 ข้อ — **อย่าลืม `RESET_CONFIRM=yes pnpm run reset` ก่อนยิงทุกรอบ**
3. วัด `podman stats` ระหว่างยิง เพื่อยืนยัน/ล้ม ข้อสรุปใหม่ว่าคอขวดคือ Node event loop
4. เก็บ Cache Hit/Miss (`./scripts/cache-stats.sh`) + แคป Bull-Board — **ห้ามกดปุ่ม Retry ระหว่างเก็บผล**
5. เขียน integration test ยืนยันพฤติกรรม `queue.getJob()` และเคส duplicate jobId
6. นัดยิงข้ามกลุ่ม (ต้อง reset ก่อน ไม่งั้นเขาได้ 409 ล้วน — ใช้ `user-1..user-500` ชุดเดียวกับเรา)
7. เขียนรายงาน PDF

---

## 7. ข้อควรระวัง

- ⚠️ **ห้ามเอา `job.data` จาก `queue.add()` มาเทียบอะไรทั้งนั้น** — มันคือ object ที่เราส่งเข้าไปเอง
- ⚠️ **ห้ามใส่ compensate กลับเข้าไปในสาขา `SoldOutError`** — เหตุผลอยู่ในคอมเมนต์ `orders.processor.ts` แล้ว
- ⚠️ **ห้ามลบ `commandTimeout`** ใน `redis.module.ts` — กฎ "Redis คือ optimization" ใน §6 พึ่งมันอยู่
- ⚠️ ลำดับ 3 บรรทัด post-commit ใน `orders.processor.ts` **สลับไม่ได้** (`markBought` ต้องมาก่อนปล่อย lock)
- ⚠️ `docs/Codebase/All_in_one/` เป็นไฟล์ generate — แก้ที่ `Separate/` แล้วรัน `node scripts/build-all-in-one.mjs`
- ⚠️ Synology Drive จะสลับ file mode 644 ↔ 755 เอง เจอ `git diff` ที่มีแต่ mode change ให้ `chmod 644` กลับ

---

## 8. อ้างอิง

| อะไร | ที่ไหน |
| :--- | :--- |
| โค้ดทำงานยังไง (เดินทีละ hop) | `docs/Codebase/Separate/01-codebase-primer.md` |
| reviewer ถกอะไรกัน + ตารางสถานะ 11 ข้อ | `docs/Codebase/Separate/02-design-review-qa.md` |
| สเปก (sync กับโค้ดแล้ว) | `docs/Architecture/architecture.md` §5.4, §6.1–6.3, §8 |
| ADR + บันทึกการถกเถียง | `docs/Architecture/architecture-rationale.md` ADR-4, Q3 |
| invariant + สิ่งที่ยังไม่ได้ทำ | `CLAUDE.md` §0.1, §4 |
| handoff รอบก่อน | `handoff_log/handoff_26_08_2026_backend-implementation.md` |
