# 🚀 Flash Sale System — Mini Project Backend (Mobile)

High-throughput, low-latency backend สำหรับสถานการณ์ **Flash Sale** — รองรับ **1,000 concurrent readers** และ **write burst 500 คนแย่งสินค้า 50 ชิ้น** โดยการันตี **Zero Overselling** และ **1 ชิ้นต่อ 1 ผู้ใช้**

> **สถานะปัจจุบัน**: 🛠️ **Implemented** — `src/` ครบทุก module, `docker-compose.yml` 1-click start, `loadtest.js` พร้อมยิง
> `pnpm run build` / `pnpm run lint` / `pnpm run test` ผ่านทั้งหมด (32 tests) · **ยังไม่เคยรันบน container จริงและยังไม่เคยยิง k6** (ดู [handoff ล่าสุด](handoff_log/INDEX.md))

---

## 📚 เอกสาร

| เอกสาร | คำอธิบาย |
| :--- | :--- |
| 🎓 [**Architecture Primer (เริ่มที่นี่)**](docs/Architecture/architecture-primer.md) | **ปูพื้นฐานตั้งแต่ศูนย์** — ทำไมต้องมีของเยอะขนาดนี้, ตัวละคร 7 ตัว, race condition, glossary, คำถามทดสอบตัวเอง |
| 🏛️ [**System Architecture & Concurrency Blueprint**](docs/Architecture/architecture.md) | สเปกหลักของระบบ — **§3.1 DB schema/entity/migration**, read path, write path 4-tier, failure matrix, pooling, load test |
| 🤖 [**CLAUDE.md**](CLAUDE.md) | กติกาสำหรับ AI agent และผู้พัฒนา — stack, คำสั่ง, API contract, DO/DON'T |
| 🧭 [**Codebase Primer + Design Review Q&A**](docs/Codebase/README.md) | **โค้ดจริงทำงานยังไง** — เดิน request ทีละ hop, module graph, connection topology + บันทึกที่ reviewer 3 มุมถกกัน |
| 📊 [**Dataflow & Control Flow Diagrams**](docs/Architecture/diagrams.md) | DFD Level 0–2, Control Flow, CSPEC, State Machine, Sequence — สำหรับใส่ในรายงาน |
| 🧭 [**Architecture Rationale**](docs/Architecture/architecture-rationale.md) | **ทำไมถึงเลือกแบบนี้** — Decision Record, ข้อดี/ข้อเสีย, บันทึกการถกเถียงของ reviewer 3 มุมมอง |
| 📄 [**โจทย์ต้นฉบับ**](docs/Requirement/Flash%20Sale%20System.pdf) | Mobile Backend Architecture & Performance Testing |
| 🌱 [**products-seed.json**](docs/Requirement/products-seed.json) | ข้อมูลสินค้าตั้งต้น (`p-1001` มีสต็อก 50 ชิ้น = ตัวที่ใช้ทดสอบ) |
| 📖 [**สรุปบทเรียน (ฉบับอ่าน)**](docs/Summary_Best_Practice/For_human/) | Backend01–06 ภาษาไทยแบบละเอียด |
| ⚙️ [**สรุปบทเรียน (ฉบับ agent)**](docs/Summary_Best_Practice/For_agent/INDEX.md) | กฎแบบย่อ + **slide-errata** (โค้ดในสไลด์ที่ผิด ห้ามลอก) |
| 🗝️ [**Primer Template**](docs/Meta/primer-template.md) | แม่แบบ prompt สำหรับเขียนเอกสารปูพื้นฐาน — ถอดโครงมาจาก Architecture Primer ใช้กับวิชาอื่นได้ |
| 📒 [**Handoff Log**](handoff_log/INDEX.md) | บันทึกส่งต่องานแต่ละรอบ — ตัดสินใจอะไรเพราะอะไร, ทางตันที่ลองแล้ว, อะไรยังไม่ชัวร์ |

---

## 🏗️ ภาพรวมสถาปัตยกรรม

```
k6 (1,000 read VUs + 500 write VUs)
        │
        ▼
  Nginx :8080  ── least_conn + keepalive
        │
        ├──► app-1 ─┐
        ├──► app-2 ─┤
        ├──► app-3 ─┼── NestJS (API + BullMQ worker)  ◄── JWT HS256 (stateless)
        ├──► app-4 ─┤
        ├──► app-5 ─┤
        └──► app-6 ─┘
                     │
        ┌────────────┴─────────────┐
        ▼                          ▼
  redis-cache :6379          redis-data :6380
  (allkeys-lru)              (noeviction + AOF)
  catalog metadata           stock counter · lock
                             BullMQ + Bull-Board
                                    │
                                    ▼
                          PostgreSQL Primary :5432
                          UNIQUE(user_id, product_id)
                          CHECK(remaining_stock >= 0)
                                    │ streaming replication
                                    ▼
                          PostgreSQL Replica :5433
                          (catalog reads)
```

**หลักคิดสำคัญ**: แคช *metadata สินค้า* ไว้นาน แต่ `remainingStock` อ่านสดจาก Redis counter ทุก request แล้ว merge ตอนตอบกลับ — ทำให้แคชไม่ต้องถูก invalidate ทุกครั้งที่มีคนซื้อ แต่สต็อกยังถูกต้องเสมอ ([รายละเอียด](docs/Architecture/architecture.md#5-%EF%B8%8F-read-path-1000-concurrent-users))

---

## 🔌 API Endpoints

| Method | Path | คำอธิบาย |
| :--- | :--- | :--- |
| `POST` | `/api/v1/auth/token` | จำลอง login → รับ JWT |
| `GET` | `/api/v1/products?page=1&limit=10` | รายการสินค้า (read-heavy, cached + stock overlay) |
| `POST` | `/api/v1/orders` | สั่งซื้อ → **202 Accepted** (async ผ่าน BullMQ) |
| `GET` | `/health/live` · `/health/ready` | Liveness / Readiness probe |
| `GET` | `/admin/queues` | Bull-Board dashboard (ต้องมี auth) |

สเปก request/response แบบเต็มอยู่ใน [`CLAUDE.md` §3](CLAUDE.md#3--api-contract--ห้ามเปลี่ยนโดยพลการ) — **ห้ามเปลี่ยนโดยพลการ** เพราะกลุ่มอื่นจะใช้ k6 script ยิงระบบเรา

---

## ⚡ เริ่มต้นใช้งาน

### แบบ 1-click (ที่ใช้ตอนส่งงาน)

```bash
podman compose up -d          # Nginx + app ×6 + PG primary/replica + redis ×2
podman compose ps             # รอจน healthy ครบ (~40-60 วิ ครั้งแรกเพราะต้อง build image)
```

**ไม่ต้องรัน migration / seed เอง** — `scripts/app-entrypoint.sh` ทำให้แล้วใน `app-1`
(migration → seed DB → seed Redis counter) ส่วน `app-2`-`app-6` จะรอจนกว่าทั้งสองอย่างเสร็จค่อยรับ traffic
และ nginx จะรอจน app ทั้งหกตัวตอบ `/health/live` ได้ก่อน

```bash
# ตรวจว่าระบบพร้อมจริง
curl -s localhost:8080/health/ready
curl -s 'localhost:8080/api/v1/products?page=1&limit=10' | head -c 400

# ยิง load test
RESET_CONFIRM=yes pnpm run reset   # ⚠️ ต้องรันก่อนยิง "ทุกรอบ" ไม่ใช่แค่รอบแรก
./scripts/cache-stats.sh reset     # ล้างสถิติแคช
k6 run loadtest.js
./scripts/cache-stats.sh           # อ่าน Cache Hit/Miss Ratio ไปใส่รายงาน
```

> ⚠️ **ไม่ `reset` = ยิงรอบสองได้ 409 ทั้งหมด** — `seed` ใช้ `ON CONFLICT` ที่ไม่แตะ `remaining_stock`,
> `seed:redis` ใช้ `SET … NX`, และ `bought:*` ไม่มี TTL จึงแก้ตัวเองไม่ได้
> เรื่องนี้สำคัญตอนยิงข้ามกลุ่มด้วย เพราะกลุ่มเพื่อนใช้ `user-1..user-500` ชุดเดียวกับ `loadtest.js` ของเรา

Bull-Board (Queue dashboard): <http://localhost:8080/admin/queues> — user/pass จาก `BULL_BOARD_USER` / `BULL_BOARD_PASSWORD`

### แบบ dev บนเครื่องตัวเอง

`.env.example` ตั้งค่า host เป็นชื่อ container (`postgres-primary`, `redis-data`) ซึ่ง**ใช้จากเครื่องตัวเองไม่ได้**
ถ้าจะรัน `pnpm run start:dev` นอก container ต้องชี้กลับมาที่ localhost ก่อน:

```bash
cp .env.example .env
# แก้ใน .env: DB_HOST=127.0.0.1  DB_REPLICA_HOST=127.0.0.1  DB_REPLICA_PORT=5433
#             REDIS_CACHE_HOST=127.0.0.1  REDIS_DATA_HOST=127.0.0.1  REDIS_DATA_PORT=6380
podman compose up -d postgres-primary postgres-replica redis-cache redis-data
pnpm install
pnpm run migration:run
pnpm run seed && pnpm run seed:redis   # ลำดับนี้สลับไม่ได้
pnpm run start:dev
```

> ⚠️ ต้องใช้ **pnpm** เท่านั้น (`corepack enable` ถ้ายังไม่มี) — ห้าม `npm` / `yarn`

---

## ✅ เกณฑ์พิสูจน์ความถูกต้อง

หลังยิง load test 500 VUs ใส่สินค้า `p-1001` (สต็อก 50):

```sql
SELECT remaining_stock FROM products WHERE id = 'p-1001';
-- ต้องได้ 0 พอดี ไม่ติดลบ

SELECT COUNT(*), COUNT(DISTINCT user_id) FROM orders WHERE product_id = 'p-1001';
-- ต้องได้ 50, 50  (ไม่มีใครได้เกิน 1 ชิ้น)
```

---

## 📦 Deliverables

- [x] Source code + `docker-compose.yml` (1-click start)
- [x] `loadtest.js` (k6)
- [ ] Report (PDF): diagram · cache invalidation strategy · การกันสั่งซื้อซ้ำ · ผล load test · ตารางเทียบกับกลุ่มเพื่อน · การแบ่งงานในทีม
