# Handoff — Architecture Rationale + DB Schema (2026-08-26)

**วันที่:** 2026-08-26 · **ผู้บันทึก:** NuiGates (ร่วมกับ Claude Code / Opus 5) · **สถานะ:** กำลังทำ — รอการตัดสินใจ 3 ข้อ
**ขอบเขต:** เอกสารสถาปัตยกรรมของ Flash Sale System (mini-project mobile backend) — **ยังไม่มีโค้ดใน `src/` เลย** ทั้งเซสชันนี้เป็นงานเอกสารล้วน
**ต่อจาก:** commit `fa0f695 "Updates"` (ผู้ใช้ commit เองกลางเซสชัน)

---

## 1. ตอนนี้อยู่ตรงไหน

- เอกสารสถาปัตยกรรมครบชุด 4 ไฟล์ใน `docs/Architecture/`: `architecture.md` (สเปก 762 บรรทัด) · `architecture-primer.md` · `diagrams.md` · `architecture-rationale.md` (ใหม่)
- **ยังไม่ commit อะไรเลยในรอบนี้** — งานทั้งหมดอยู่ใน working tree (`git status`: M ×4, ?? ×1, AM ×1)
- **มี blocker 2 ข้อที่รู้แล้วแต่ยังไม่แก้** อยู่ใน `architecture.md` §6.2 และ §6.3 (รายละเอียด §5 ของไฟล์นี้)
- คนมารับช่วงต่อจะเจอ: เอกสารที่อ่านจบแล้วเขียนโค้ดได้ทันที แต่ถ้าเขียนตามโค้ดอ้างอิงใน §6.2/§6.3 แบบเป๊ะๆ **จะได้ระบบที่สต็อกรั่ว**

---

## 2. รอบนี้ทำอะไรไป ได้ผลอะไร

1. **Scrutinize `architecture.md` ฉบับเดิม (267 บรรทัด)** → เจอ 5 blocker + 5 major + 5 nit ที่หนักสุดคือ **ไม่มี JWT เลยแม้แต่คำเดียว** (grep ได้ 0 hit) ทั้งที่โจทย์บังคับ → เขียนใหม่เป็น 598 บรรทัด
2. **สร้าง `CLAUDE.md` (250 บรรทัด)** + เขียน `AGENTS.md` ใหม่ — ของเดิม 168 บรรทัดเป็นเนื้อหา **ผิดโปรเจกต์ทั้งไฟล์** (บรรยาย Assignment 06 เรื่อง students/courses/pessimistic-lock)
3. **เก็บฉบับเก่าเป็น `old_architecture.md`** — กู้ body จาก git object `eea5647` แล้วเติม banner ARCHIVED 25 บรรทัด
4. **สร้าง `diagrams.md`** — DFD Level 0/1/2, Data Dictionary, CFD, CSPEC, State Machine, Concurrency Control Map, Sequence (สัญกรณ์ Ward–Mellor)
5. **สร้าง `architecture-rationale.md` (454 บรรทัด)** — ADR 7 ข้อ + ข้อดี/ข้อเสีย + บันทึกการถกเถียง
6. **รัน design review ด้วย 4 agent** (Performance / Correctness / Simplicity + 1 ตัวขุดข้อเท็จจริงจาก PDF+seed+errata) แล้ว **cross-examine รอบสอง** โดยส่งคำถามของแต่ละคนไปให้อีกสองคนตอบ → เจอ blocker จริง 2 ข้อในโค้ดอ้างอิง
7. **เพิ่ม §3.1 Database Schema** เข้า `architecture.md` (601 → 762 บรรทัด)

### ตรวจสอบด้วยอะไร (ค่าที่ได้จริง)

| ตรวจอะไร | เครื่องมือ | ผล |
| :--- | :--- | :--- |
| mermaid ทุกรูป parse ได้ | `mermaid.parse()` v11 ผ่าน jsdom | **20/20 OK** |
| internal link ทุกไฟล์ | สคริปต์ python เดินทั้ง repo | **97 ลิงก์ / broken 0** |
| DDL ใน §3.1.1 ถูก syntax | `sqlglot` dialect=postgres | **4 statement parse ผ่าน** |
| `old_architecture.md` body ตรงต้นฉบับ | `tail -n 267 \| git hash-object --stdin` | **byte-identical** |
| literal `\n` ใน mermaid | grep | 14 → **0** |

---

## 3. ตัดสินใจอะไรไปบ้าง เพราะอะไร

| # | ทางเลือก | เลือก | เหตุผล | ใครตัดสิน |
| :-- | :--- | :--- | :--- | :--- |
| 1 | วาง DB schema เป็น §4 ใหม่ (ต้อง renumber §4–§10) **vs** เป็น §3.1 | **§3.1** | renumber จะต้องไล่แก้ `§n` ใน 6 ไฟล์ แต่ **`§4` ใน `CLAUDE.md` หมายถึง Concurrency Invariants ของตัวเอง ไม่ใช่ §4 ของ architecture.md** และ `diagrams.md` ก็มี §ของตัวเอง → regex แบบเหมารวมจะทำพัง | Claude (user อนุมัติด้วย "ทำเลย") |
| 2 | เก็บ `idx_products_flash_sale` **vs** ลบ | **ลบ** | read path ไม่ได้ filter ตาม `is_flash_sale_active` เลย (แสดงทุกตัว `meta.total=20`) + ตาราง 20 แถว planner เลือก seq scan อยู่ดี — **เขียนกำกับไว้ชัดว่าตัดโดยตั้งใจ** | Claude |
| 3 | `price` เป็น `float` **vs** `NUMERIC(10,2)` + transformer | **NUMERIC + transformer** | เงินห้าม float แต่ node-postgres คืน `numeric` เป็น **string** → response จะเป็น `"2990.00"` ผิด contract §3 → **k6 ของกลุ่มอื่นยิงเราไม่ผ่าน** | Claude |
| 4 | เพิ่ม `CHECK (remaining_stock <= available_stock)` | **เพิ่ม** | ถูกและถูกมาก **แต่เขียนกำกับตรงๆ ว่าจับ drift ระหว่าง Redis↔DB ไม่ได้** เพราะ compensation เกิดฝั่ง Redis ล้วน | Claude |
| 5 | แก้ blocker 2 ข้อเลย **vs** บันทึกไว้ก่อน | **บันทึกไว้ก่อน** | แตะ invariant `CLAUDE.md` §4 ข้อ 6 และ 8 ซึ่ง §8 บังคับให้ถามก่อน — **ยังไม่ได้รับอนุมัติ** | Claude (รอ user) |
| 6 | เพิ่ม `GET /api/v1/orders/:jobId` | **ยังไม่เพิ่ม** | เป็น additive ไม่ทำ k6 กลุ่มอื่นพัง แต่ยังต้องถามตาม §8 | รอ user |
| 7 | ใช้ agent กี่ตัว | **4** (3 reviewer + 1 fact-finder) | user สั่งให้ใช้ ≤3 ตัว scrutinize + ให้เพิ่มอีก 1 ตัวไว้ search เพื่อประหยัด token | user |

---

## 4. ลองแล้วไม่เวิร์ก (ทางตัน)

- **`git mv docs/Current_architecture.md ...` ล้มเหลว** เพราะไฟล์ยัง untracked → fallback `mv` ทำงานแทน ผลคือเนื้อหา untracked ตัวเดิม**ถูกทับและกู้จากดิสก์ไม่ได้** โชคดีที่ตรวจแล้วมันเหมือน `HEAD:docs/architecture.md` ทุกประการ (ตรวจด้วย landmark grep ก่อนกู้)
  → **บทเรียน: ตรวจ `git ls-files <path>` ก่อนใช้ `git mv` เสมอ**
- **`global.navigator = dom.window.navigator` ใน validator** → `TypeError: Cannot set property navigator of #<Object> which has only a getter` → ต้องใช้ `Object.defineProperty(globalThis, 'navigator', {...})`
- **`pip3 install sqlglot` ถูกบล็อกด้วย PEP 668** (externally-managed-environment) → ต้องสร้าง venv ใน scratchpad
- **รัน DDL จริงไม่ได้** — เครื่องนี้ **ไม่มี podman และ docker runtime ไม่ทำงาน** และไม่มี PostgreSQL ที่ `:5432` → ทำได้แค่ parse syntax

### 4.1 แบบที่ถูกตีตก

- **Renumber section ทั้งไฟล์เพื่อให้ DB schema เป็น §4** — ตีตกเพราะเหตุผลในตาราง §3 ข้อ 1 (ประเมินแล้วไม่ได้ลองทำ)
- **แคชทั้ง product object รวม `remainingStock` แล้ว invalidate ทุกครั้งที่ขาย** — ตีตกเพราะช่วง flash sale คือช่วงที่ขายรัวที่สุด = cache ถูกล้างรัวที่สุด **cache ใช้ไม่ได้พอดีตอนที่ต้องการมันที่สุด**
- **L1 in-memory LRU cache** — ตีตกเพราะ 3 instance จะตอบ `remainingStock` ไม่ตรงกัน ผิด "เงื่อนไขสำคัญ" ของโจทย์ + ผิดกฎ stateless
- **XFetch / probabilistic early expiration** — เขียนอธิบายไว้ในเอกสารแต่**ไม่ implement** เพราะที่ TTL 60s กับ k6 run ~60s มันแทบไม่ทำงานและพิสูจน์ในรายงานไม่ได้
- **Redis ตัวเดียว** — ตีตกเพราะ `maxmemory-policy` เป็นค่าระดับเซิร์ฟเวอร์ ไม่ใช่ระดับ key → `allkeys-lru` จะ evict `stock:*` และ BullMQ job ได้

---

## 5. ยังไม่ชัวร์ / สมมติฐานที่ยังไม่พิสูจน์

### ✅ ยืนยันแล้ว (รันจริง / อ่านไฟล์จริง)
- mermaid 20/20, links 97/0 broken, DDL syntax ผ่าน sqlglot, old_architecture byte-identical — ทั้งหมดรันจริง มีเอาต์พุต
- **blocker (a)**: `architecture.md` §6.3 เรียก `compensateOnce()` แล้ว `throw err` เพื่อ retry → deadlock `40P01` ที่ attempt 1 จะคืนสต็อกใน Redis แล้ว attempt 2 สำเร็จ → **Redis สูงกว่า DB ถาวร 1 หน่วย** — อ่านยืนยันกับตัวไฟล์แล้ว
- **blocker (b)**: §6.2 พึ่ง `try/catch` รอบ `queue.add()` เป็นทางชดเชยเดียว แต่ BullMQ เจอ `jobId` ซ้ำแล้ว**คืน job เดิมเงียบๆ ไม่ throw** → catch ไม่มีวันทำงาน — อ่านยืนยันกับตัวไฟล์แล้ว

### ❓ ยังไม่ตรวจ / เป็นการอ้างอิงไม่ใช่การทดสอบ
- **DDL ยังไม่เคยรันบน PostgreSQL 16 จริง** — ยืนยันได้แค่ syntax
- **`gen_random_uuid()` เป็น built-in ตั้งแต่ PG 13** — อ้างจากเอกสาร ไม่ได้ทดสอบ
- **FK ขอ `KEY SHARE` ไม่ชนกับ `FOR NO KEY UPDATE`** (§3.1.6) — อ้างจากความรู้เรื่อง PG lock mode ไม่ได้ทดสอบ
- **ตัวเลข performance ทุกตัวในเอกสาร** (p95 < 200ms, hit ratio ≥ 90%, "450 คนจบใน ~1ms") — **ยังไม่เคยวัดเลยสักตัว** เพราะยังไม่มี `src/`
- **"ตัด Lua แล้ว p95 ตก 300ms–1s"** — เป็น**การประมาณของ agent** ไม่ใช่ผลการวัด
- **BullMQ คืน job เดิมโดยไม่ throw เมื่อ jobId ซ้ำ** — เป็นพฤติกรรมที่ agent ระบุและสอดคล้องกับเอกสาร BullMQ **แต่ยังไม่ได้ทดสอบด้วยโค้ดจริง** ⚠️ ควรเขียน integration test ยืนยันก่อนแก้

---

## 6. ก้าวถัดไป (เรียงลำดับ)

1. **ตัดสินใจว่าจะแก้ blocker (b) ไหม** — เช็คค่าที่ `queue.add()` คืนมา แทนการพึ่ง `catch` · *รอ: user อนุมัติตาม `CLAUDE.md` §8*
2. **ตัดสินใจว่าจะแก้ blocker (a) ไหม** — compensate เฉพาะเมื่อ `job.attemptsMade + 1 >= job.opts.attempts` · *รอ: user อนุมัติ*
3. **ตัดสินใจเรื่อง PostgreSQL replica** — reviewer 2 ใน 3 เสียงให้ตัด (ได้ 0 คะแนนตาม traceability + สร้างกับดัก read-write split เอง) · *รอ: user ตัดสิน*
4. **ตัดสินใจเรื่อง `GET /api/v1/orders/:jobId`** — ถ้าไม่มี grader จะพิสูจน์ไม่ได้ว่า order สำเร็จ · *รอ: user ตัดสิน*
5. **commit งานเอกสารทั้งหมด** (ตอนนี้ยังไม่ commit เลย)
6. **เริ่มเขียน `src/`** ตามโครง §3 + entity ตาม §3.1
7. **ย้าย `seed:redis` เข้า bootstrap** — ลืมเมื่อไหร่ = 503 ทั้งระบบ และผิดข้อ "1-click start" ของ deliverable
8. **เขียน `loadtest.js`** แล้ววัดตัวเลขจริงมาแทนที่ตัวเลขประมาณการในเอกสาร

---

## 7. ข้อควรระวัง

- ⚠️ **`docs/Architecture/old_architecture.md` ห้ามแก้ body** — เป็นสำเนา byte-identical ของฉบับเดิมไว้เทียบ ถ้าจะแก้ให้แก้แค่ banner
- ⚠️ **API contract ใน `CLAUDE.md` §3 ห้ามเปลี่ยน** — path / field / status code กลุ่มอื่นเอา k6 มายิงระบบเรา เปลี่ยนเมื่อไหร่ยิงข้ามกลุ่มไม่ได้
- ⚠️ **`CLAUDE.md` §8 บังคับให้หยุดถามก่อน** ในเรื่อง: กระทบข้อมูล DB · เพิ่ม/ลบ dependency · เปลี่ยน API contract · แก้ cache/concurrency policy · ละเมิด invariant §4 · แก้ config หลัก
- ⚠️ **ผู้ใช้ย้ายโครง `docs/` เองกลางเซสชัน** (เป็น `Architecture/` + `Requirement/`) ทำให้ลิงก์พัง **25 จุด** — ถ้าย้ายไฟล์อีก **ต้องรัน link checker ซ้ำทุกครั้ง**
- ⚠️ **เครื่องนี้ไม่มี container runtime** (podman ไม่มี, docker daemon ไม่ทำงาน) — วางแผนได้ว่าการทดสอบจริงต้องไปทำที่เครื่องอื่น
- ⚠️ **สคริปต์ตรวจ (`check.mjs`, venv ของ sqlglot) อยู่ใน scratchpad ของเซสชัน จะหายเมื่อจบเซสชัน** — ถ้าจะใช้ต่อควรย้ายเข้า repo เป็น `scripts/`
- ⚠️ **ตัวเลข performance ในเอกสารยังเป็นค่าประมาณทั้งหมด** — อย่าเอาไปใส่รายงานว่าเป็นผลการวัด

---

## 8. อ้างอิง

| อะไร | ที่ไหน |
| :--- | :--- |
| สเปกหลัก (DB schema อยู่ §3.1) | `docs/Architecture/architecture.md` |
| เหตุผลการออกแบบ + บันทึกการถกเถียง + **blocker 2 ข้อพร้อมโค้ดแก้** | `docs/Architecture/architecture-rationale.md` §7 |
| ไดอะแกรมสำหรับรายงาน | `docs/Architecture/diagrams.md` |
| ฉบับปูพื้นฐาน | `docs/Architecture/architecture-primer.md` |
| ฉบับเก่า (ห้ามใช้เป็นสเปก) | `docs/Architecture/old_architecture.md` |
| กติกา AI agent + invariant 11 ข้อ + deliverables | `CLAUDE.md` |
| โจทย์ต้นฉบับ | `docs/Requirement/Flash Sale System.pdf` |
| ข้อมูลตั้งต้น (20 สินค้า, p-1001 stock 50) | `docs/Requirement/products-seed.json` |
| slide-errata (โค้ดในสไลด์ที่ผิด ห้ามลอก) | `docs/Summary_Best_Practice/agent/INDEX.md` |
| commit ก่อนหน้า | `fa0f695 "Updates"` · `1efd420` (docs path update) |

**คนที่ต้องถาม:** เจ้าของโปรเจกต์ (NuiGates) สำหรับข้อ 1–4 ใน §6 — ทั้งหมดเป็นการตัดสินใจที่ `CLAUDE.md` §8 บังคับให้ถามก่อน
