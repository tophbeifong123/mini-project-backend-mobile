# 🤖 AGENTS.md

> **กติกาฉบับเต็มอยู่ที่ [`CLAUDE.md`](CLAUDE.md) — อ่านไฟล์นั้นก่อนเริ่มงานเสมอ**
> ไฟล์นี้เป็น pointer สำหรับ AI tool ที่อ่านเฉพาะ `AGENTS.md` (Codex, Cursor, ฯลฯ)
> เก็บไว้เฉพาะกฎที่ "พลาดแล้วพัง" เพื่อไม่ให้เนื้อหาสองไฟล์แตกกันเอง

**โปรเจกต์**: Flash Sale System — NestJS + Nginx (6 instances) + PostgreSQL replication + Redis ×2 + BullMQ + JWT
**สถานะ**: ✅ implemented + verified — `src/` ครบ · `docker-compose.yml` 1-click start · build/lint/test ผ่าน (59 tests) · รัน container และยิง `loadtest.js` บน VM เป้าหมายแล้ว (2026-09-01)
**ผลล่าสุดต้องอ่านจากหลักฐานการทดสอบจริง** — ดูสถานะและ median ของรอบล่าสุดใน `CLAUDE.md`; ห้ามนำตัวเลขประมาณการเก่ามาอ้างเป็นผล benchmark

## เอกสารที่ต้องอ่าน
| ไฟล์ | คืออะไร |
| :--- | :--- |
| [`CLAUDE.md`](CLAUDE.md) | **กติกาฉบับเต็ม** — stack, คำสั่ง, API contract, DO/DON'T, checklist |
| [`docs/Architecture/architecture.md`](docs/Architecture/architecture.md) | **สเปกสถาปัตยกรรม** — source of truth ถ้าโค้ดขัดกับเอกสาร เอกสารถูก |
| [`docs/Codebase/README.md`](docs/Codebase/README.md) | **โค้ดจริงทำงานยังไง** — เดิน request ทีละ hop อ้าง `file:line` + บันทึก design review |
| [`docs/Architecture/diagrams.md`](docs/Architecture/diagrams.md) | DFD + Control Flow + CSPEC (ตารางตัดสินใจของ gatekeeper และ worker) |
| [`docs/Requirement/Flash Sale System.pdf`](docs/Requirement/Flash%20Sale%20System.pdf) | โจทย์ต้นฉบับ |
| [`docs/Summary_Best_Practice/For_agent/INDEX.md`](docs/Summary_Best_Practice/For_agent/INDEX.md) | กฎสรุปจากบทเรียน + slide-errata (โค้ดผิดในสไลด์ ห้ามลอก) |
| [`docs/Meta/primer-template.md`](docs/Meta/primer-template.md) | แม่แบบ prompt เขียนเอกสารปูพื้นฐาน — ไม่ใช่สเปกของระบบนี้ |

## กฎที่ห้ามละเมิด (สรุป — รายละเอียดใน `CLAUDE.md` §4)
1. **`pnpm` เท่านั้น** ห้าม `npm` / `yarn`
2. **ห้าม synchronous DB write ใน controller** — ต้อง enqueue แล้วตอบ **202** ทันที
3. **`userId` มาจาก JWT claim `sub` เท่านั้น** ห้ามรับจาก request body
4. **Worker เขียน DB ผ่าน `dataSource.createQueryRunner('master')` เท่านั้น** — `repository.findOne()` วิ่งไป replica ที่มี lag
5. **ตัดสต็อกด้วย atomic SQL** `WHERE remaining_stock > 0` แล้วเช็ค `affected === 0` ห้าม `SELECT` มาเช็คใน JS ก่อน
6. **หัก/คืน stock ใน Redis ต้องอยู่ใน Lua script** และทุก path ที่หักแล้วต้องมีทางชดเชยแบบ **idempotent**
7. **Side effect หลัง `commitTransaction()` ต้องอยู่นอก try/catch ของ transaction** ไม่งั้นคืนสต็อกทั้งที่ขายไปแล้ว
8. **`redis-data` (stock + queue) ต้อง `noeviction`**, `redis-cache` เท่านั้นที่เป็น `allkeys-lru`
9. **ใช้ BullMQ ไม่ใช่ Bull** — ห้าม `job.progress()`, `queue.on('completed')`, job option `timeout`
10. **ห้ามเก็บ state ที่ต้องแชร์ใน memory** รวมถึง L1 cache ที่มี `remainingStock`
11. **API contract เปลี่ยนไม่ได้** (`CLAUDE.md` §3) — กลุ่มอื่นจะเอา k6 มายิงระบบเรา

## กับดักที่เคยพลาดมาแล้ว (อย่าทำซ้ำ)
- **ห้ามเทียบ `job.data` ที่ `queue.add()` คืนมา** — BullMQ ไม่เคยอ่าน `data` กลับจาก Redis (เขียนกลับแค่ `job.id`) เทียบยังไงก็ตรงเสมอ = เช็คตาย ต้องใช้ `queue.getJob(jobId)`
- **ห้าม compensate ตอน `affected = 0` (sold out)** — Redis สูงกว่า DB อยู่แล้ว คืนไปจะวนไม่จบ counter ลู่เข้าหา 1 ไม่ถึง 0
- **ห้าม compensate ทุกครั้งที่ catch** — ต้องเช็ค `isFinalAttempt` ก่อน ไม่งั้น retry สำเร็จทีหลัง = Redis สูงกว่า DB ถาวร
- **ห้ามใช้ `jobId` เป็น token ของ lock** — ซ้ำทุกครั้งที่คนเดิมขอของเดิม ทำให้ compare-and-delete แยกการถือครองไม่ออก ใช้ `requestToken` สุ่มต่อคำขอ
- **ห้ามลบ `commandTimeout` ของ ioredis** — `maxRetriesPerRequest: null` เพียวๆ ทำให้คำสั่ง**ค้าง** ไม่ reject → `catch` fallback ไม่ทำงาน → 504
- **ยิง k6 ต้อง `RESET_CONFIRM=yes pnpm run reset` ก่อนทุกรอบ** ไม่งั้นได้ 409 ล้วน

## ก่อนบอกว่าเสร็จ
```bash
pnpm run build && pnpm run lint && pnpm run test
```
ถ้าแก้ไฟล์ใน `docs/Codebase/Separate/` ต้องรัน `node scripts/build-all-in-one.mjs` ด้วย
ถ้าแตะ write path ต้องพิสูจน์ Data Integrity ด้วย (`docs/Architecture/architecture.md` §9.3):
`remaining_stock = 0` · `orders = 50 แถว` · `unique users = 50` · `redis GET stock:flash_sale:p-1001 = "0"`

## ต้องหยุดถามก่อน
เปลี่ยน API contract · แก้นโยบาย cache/lock/Lua · เพิ่ม-ลบ dependency · คำสั่งที่ลบข้อมูล (`migration:revert`, `compose down -v`) · แก้ `docker-compose.yml` / `nginx.conf` / `.env.example`
