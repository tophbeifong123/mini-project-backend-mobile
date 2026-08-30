# 🤖 CLAUDE.md — กติกาสำหรับ AI Agent และผู้พัฒนา

> **โปรเจกต์**: Flash Sale System — Mobile Backend Architecture & Performance Testing
> **โจทย์ต้นทาง**: [`docs/Requirement/Flash Sale System.pdf`](docs/Requirement/Flash%20Sale%20System.pdf)
> **สถาปัตยกรรม (source of truth)**: [`docs/Architecture/architecture.md`](docs/Architecture/architecture.md)
> **สถานะ**: 🛠️ implemented — `src/` ครบทุก module · `docker-compose.yml` 1-click start · `loadtest.js` พร้อม
> `build` / `lint` / `test` (49 tests) ผ่านหมด · รันบน container จริงและยิง k6 มาแล้วหลายรอบ (§9.3 ผ่านครบ)
> **ที่ยังไม่เคยเกิดขึ้น: ยิงข้ามกลุ่ม · e2e test · รายงาน PDF** (ดู §0.1)

---

## 0. ⚠️ อ่านก่อนเริ่มทุกครั้ง

repo นี้มีทั้ง **เอกสารออกแบบ** และ **โค้ดจริง** แล้ว (`src/`, `package.json`, `docker-compose.yml`, `loadtest.js`)
container ขึ้นจริงและยิง k6 มาแล้ว — ตัวเลข performance ที่บันทึกไว้เป็นของจริง ไม่ใช่ค่าประมาณอีกต่อไป
สิ่งที่ **ยังไม่เคยเกิดขึ้นเลย** คือ **ยิงข้ามกลุ่ม · e2e test · รายงาน PDF** (ดู §0.1)
เพราะฉะนั้น:

- **ห้ามเดาว่าไฟล์มีอยู่แล้ว** — ตรวจสอบก่อนเสมอ (`ls`, `cat`) แล้วค่อยแก้
- เมื่อเริ่มเขียนโค้ด ให้ยึด [`docs/Architecture/architecture.md`](docs/Architecture/architecture.md) เป็นสเปก ถ้าโค้ดกับเอกสารขัดกัน **ถือว่าเอกสารถูก** จนกว่าจะตกลงกันใหม่ (แล้วต้องแก้เอกสารด้วย)
- โจทย์บังคับ **API contract แบบเป๊ะๆ** เพราะกลุ่มอื่นจะเอา k6 script มายิงระบบเรา — เปลี่ยน path / field / status code เมื่อไหร่ = ยิงข้ามกลุ่มไม่ได้ (ดู §3)

---

## 0.1 🚧 สิ่งที่ **ยังไม่ได้ทำ** (อัปเดตหลังยิง k6 จริงครั้งแรก — 2026-08-27)

> อ่านตารางนี้ก่อนจะพูดว่าอะไร "เสร็จแล้ว" — ของที่อยู่ในนี้คือของที่ **ยังไม่มีใครพิสูจน์**
> รายละเอียดเต็มอยู่ใน [`handoff_log/handoff_26_08_2026_backend-implementation.md`](handoff_log/handoff_26_08_2026_backend-implementation.md) §5

### ❌ ยังไม่เคยเกิดขึ้นเลย

| อะไร | ทำไมถึงสำคัญ |
| :--- | :--- |
| **ไม่เคยยิงข้ามกลุ่ม** | เป็น deliverable ตรงๆ (§9 ตารางเทียบกับกลุ่มเพื่อน) |
| **ไม่มี e2e test** | `pnpm run test:e2e` exit non-zero ("no tests found") — มีแต่ unit test 49 ข้อ |
| **ยังไม่ได้ทำรายงาน PDF** | diagram มีวัตถุดิบอยู่แล้วใน [`diagrams.md`](docs/Architecture/diagrams.md) แต่ยังไม่มีตัวรายงาน |
| **ยังไม่ได้เก็บ dashboard** | Cache Hit/Miss (ใช้ `./scripts/cache-stats.sh`) และภาพ Bull-Board ตอน Completed = 50 |
| **ยังไม่เคยยิงที่โหลดต่ำกว่าเพดาน** | ตัวเลข latency ที่มีตอนนี้มาจากการยิงเกินเพดานราว 2 เท่า ใช้เทียบกับกลุ่มเพื่อนตรงๆ ไม่ได้ — เพดานที่วัดได้คือ ~1,500 rps (ที่ 400 VUs: p95 237ms, error 0) — ⚠️ **วัดตอน 3 instance ยังไม่ได้วัดซ้ำหลังขยายเป็น 6** |

### ⚠️ ถ้าจะรันด้วย podman ต้องเช็คก่อน (บน `docker compose` ผ่านมาแล้ว)

```bash
podman run --rm postgres:16-alpine bash -c 'echo ok'   # ถ้าไม่มี bash → replica ไม่ขึ้น → ทั้งระบบไม่ขึ้น
podman compose version                                  # podman-compose (python) ไม่เคารพ condition: service_healthy
```

### 🕳️ รูที่ **รู้ตัวแล้วแต่จงใจยังไม่ปิด**

อย่า "แก้ให้ถูกหลัก" โดยไม่อ่านเหตุผลก่อน — บางข้อการแก้ผิดทางทำให้แย่ลง

| รู | สภาพตอนนี้ |
| :--- | :--- |
| `23505` ไม่คืนสต็อกใน Redis | ถูกต้องสำหรับเคสที่ตั้งใจ (retry ของ job ที่ commit แล้ว) แต่ถ้า `bought:` key หายและ job record เดิมถูก evict → Redis ต่ำกว่า DB ถาวร · **reviewer ทั้ง 3 เห็นตรงกันว่าปล่อยไว้ถูกแล้ว** — การคืนตรงนี้จะทำให้ retry ปกติคืนซ้ำ |
| ไม่มี reconciliation Redis ↔ DB | **มีตัวตรวจแล้ว (2026-08-30)** — `/admin/insights` เทียบ Redis counter กับ DB และ `/admin/metrics` เปิด gauge `flash_sale_stock_drift` · ⚠️ **`IntegrityService` ไม่มี timer ฝั่ง server** `check()` รันตอนมีคนขอ endpoint เท่านั้น (`observability.controller.ts:44,59`) เลข 3 วิคือ `setInterval` ใน**เบราว์เซอร์** (`insights.page.ts:418`) → **ปิดแท็บ = ไม่มีใครตรวจ ไม่มี alert** · และยัง **ไม่มีตัวซ่อมอัตโนมัติ** โดยเจตนา (INCR ลอยๆ = ปล่อยคนที่ 51 เข้ามา) |
| `compensate()` แบบไม่มีเงื่อนไขตอน `queue.add` ล้ม (`orders.service.ts`) | **จงใจปล่อยไว้ — อย่าแก้** (ตรวจซ้ำ 2026-08-30) · ถ้า `add()` timeout แต่ job ถูกสร้างจริง การคืนจะทำให้ Redis สูงกว่า DB — **ซึ่งซ่อมตัวเองได้** เพราะคนถัดไปจะเจอ `affected = 0` → `SoldOutError` → จงใจไม่คืน → counter ลู่ลงจนถึง 0 พอดี · ส่วน **Redis ต่ำกว่า DB ไม่มีวันซ่อม** (ค้างที่ `remaining_stock = 1`, orders 49/50) การไม่คืนจึงเป็นการเดิมพันฝั่งที่แย่กว่า · ⚠️ `compensate-if-reserved.lua` **ใช้ตรงนี้ไม่ได้** — ณ จุดนั้น lock ยังถือ token ของเราอยู่เสมอ สคริปต์จึงกลายเป็น `compensate.lua` เป๊ะๆ (no-op) |
| `WORKER_CONCURRENCY` อ่านตอน decorate class | เห็นเฉพาะ env จริงของ container ปรับจาก `.env` แล้วไม่มีผล |
| `proxy_read_timeout` ใน nginx | **ดันขึ้นเป็น 10s แล้ว (2026-08-27)** พร้อม 6 instance · แต่อาการต้นเดิมยังอยู่: ถ้า upstream ช้าเกิน 10 วิก็ยังเป็น 504 เหมือนเดิม — การดันค่าขึ้นซ่อนอาการ ไม่ได้แก้เหตุ |
| `reset` ไม่ล้าง BullMQ job | `jobId` เป็น deterministic (`order:{userId}:{productId}`) job เก่าจึงชนกับรอบใหม่ได้ · ต้องล้างเองด้วย `redis-cli --scan --pattern 'bull:orders:*' \| xargs redis-cli DEL` |
| job stall เกิน `maxStalledCount` | BullMQ ทิ้ง job ไป `failed` **โดยไม่เรียก handler** → `compensateOnce` ไม่ทำงาน → สต็อกหาย 1 ชิ้น · เกิดได้เมื่อ event loop ตันเกิน 30 วิ |
| ไม่มี e2e test | ทางเดียวที่จะพิสูจน์ทั้ง 4 เส้นทางคือยิงจริง |
| 🔴 **`connect()`/`startTransaction()` อยู่นอก `try`** (`orders.processor.ts:63-64`) | **เจอ 2026-08-30 · ยังไม่แก้ · นี่คือ path เดียวที่หักสต็อกแล้วไม่มีทางชดเชยเลย (ละเมิด §4 ข้อ 6)** · `try` เริ่มบรรทัด 67 ทั้ง `finally` ที่คืน runner และบล็อก `isFinalAttempt → compensateOnce` (125-133) จึงไม่ครอบ · primary สะดุด = สต็อกที่ `gatekeeper.lua` จองไว้หายถาวร → counter ค้างที่ 1, ออเดอร์ 49/50, **ตก §9.3 ข้อ 4** · แก้ = ย้าย 2 บรรทัดเข้าไปใน `try` (`safeRollback` เช็ค `isTransactionActive` อยู่แล้ว · `release()` บน runner ที่ยังไม่ connect เป็น no-op) · **ยังไม่แก้เพราะเป็น write path → §7 ข้อ 5 ต้องยิง k6 ก่อน** |
| `STOCK_COMPENSATION_FAILURES` ฝั่ง worker ไม่เคยถูกยิง (`orders.processor.ts:126`) | **เจอ 2026-08-30** · `metrics.inc(STOCK_COMPENSATED)` บวก**ก่อน** `await compensateOnce(...)` และ `await` นั้นไม่มี `try/catch` · metric ตัวล้มเหลวถูกยิงจาก `orders.service.ts:261,280` เท่านั้น → **ชดเชยฝั่ง worker ล้มเหลว = ถูกนับเป็นสำเร็จ ตัวนับ leak ยังเป็นศูนย์** · แปลว่า **ค่าศูนย์ของ `stock_compensation_failures_total` เชื่อไม่ได้** ตัวจับจริงคือ `drift` ใน `/admin/insights` + §9.3 |
| debounce ซ้อน 3 ชั้นทำให้ flush หลุด (`redis.service.ts:322-368`) | **เจอ 2026-08-30 · ความซับซ้อนเป็นตัว *สร้าง* บั๊ก** — leading branch + distributed throttle + trailing timer · ใช้กลไกเดียวไม่มีทางทิ้งงาน แต่ซ้อนกันแล้ว: บรรทัด 327 ใช้โควตา local → 328 ขอ throttle ไม่ได้ → 332 `return` **โดยไม่จอง trailing** = การล้างหายไปเฉย ๆ · เหลือ trailing timer อย่างเดียว −40 บรรทัดและบั๊กเกิดไม่ได้ · **ต้องขออนุญาตตาม §8 (นโยบาย cache) ก่อนแก้** · ผลกระทบจริงยังจำกัด (ไม่มี endpoint แก้ข้อมูลสินค้า · `remainingStock` ไม่ได้ถูกแคช) |
| `MetricsService.flush()` กลืน error รายคำสั่ง (`metrics.service.ts:143-172`) | **เจอ 2026-08-30** · ioredis `pipeline.exec()` **resolve ไม่ reject** ตอน command error (loop เช็ค error เป็น cluster-only — `ioredis/built/pipeline.js:182`) · redis-data เต็มที่ 512mb `noeviction` → `HINCRBY` คืน OOM ทุกตัว → `catch` ไม่ทำงาน, buffer ถูกล้างไปแล้ว, `consecutiveFlushErrors` ยังเป็น 0 → **ตัวนับค้างเงียบในจังหวะที่ต้องการมันที่สุด** |
| 🟠 **datastore เปิดทุก interface ไม่มีรหัสผ่าน** | **เจอ 2026-08-30 · สำคัญวันยิงข้ามกลุ่ม** · `docker-compose.yml:46,102,145,171` publish PG 5432/5433 + Redis ทั้งคู่โดยไม่ผูก interface · `redis-data.conf:10` = `protected-mode no` ไม่มี `requirepass` · ใครบน LAN ก็ `SET stock:flash_sale:p-1001 9999` **ข้ามการป้องกันทั้ง 4 ชั้นที่ source of truth** · แก้: ผูกกับ `127.0.0.1` (คำสั่ง §9.3 + `seed:redis` ยังทำงานจากโฮสต์ได้) — **§8 ต้องขออนุญาตก่อนแก้ `docker-compose.yml`** |
| 🟠 **Bull-Board รหัส `admin`/`admin` hardcode** | **เจอ 2026-08-30** · ทั้ง 6 services เป็นสตริงตรง ๆ ไม่ใช่ `${VAR}` · `env.validation.ts:133,137` ตั้ง default `'admin'` ทำให้ `getOrThrow()` **ไม่มีวัน throw** · **แก้ `.env` ไม่มีผลกับ container ต้องแก้ที่ `docker-compose.yml`** · ✅ ตัว mount `/admin` เองแน่น — ทดสอบ URL หลบ middleware 11 แบบกับ Express 5.2.1 จริง ไม่มีแบบไหนเล็ดลอด |
| `loadtest.js` threshold มีแค่ latency (`:81-84`) | **เจอ 2026-08-30** · ไม่มี threshold คุม `reads_bad_contract` / `orders_unexpected_status` / `orders_unauthorized_401` → backend ตอบ `price` เป็น string หรือ 500 สัก 30% ก็ยัง **exit 0 "thresholds passed"** · เป็น deliverable ที่กลุ่มอื่นจะเอาไปรัน ควรล้มเสียงดัง |

### ✅ ปิดไปแล้ว (2026-08-27 — ยิง k6 จริงครั้งแรก)

> ทั้ง 3 ข้อเจอจากการรันจริง ไม่ใช่จากการอ่านโค้ด · ตัวเลขทั้งหมดใน
> [`handoff_log/handoff_27_08_2026_load-test-first-run.md`](handoff_log/handoff_27_08_2026_load-test-first-run.md)

| เดิม | แก้เป็นอะไร |
| :--- | :--- |
| ไฟล์ seed มีโหมด `-rwx------` บนโฮสต์ (SynologyDrive) · `COPY` คงโหมดไว้ → ในอิมเมจเป็น `root:root 0700` แต่รันด้วย `USER node` → `EACCES` → app-1 restart วน → **ทั้งสแตกไม่ขึ้น** | `Dockerfile` เพิ่ม `RUN chmod 0644` หลัง `COPY` |
| `proxy_next_upstream` ใช้ default (`error timeout`) + `max_fails=3` → 1 คำขอที่ timeout กิน backend ครบ 3 ตัว แล้ว nginx ตัด backend ออกหมด → **502 จำนวน 115,005 ครั้ง และ write path ไม่ถูกทดสอบเลย** | `nginx.conf`: `proxy_next_upstream error;` + `max_fails=0` ทั้ง 6 upstream |
| `gatekeeper()` ไม่มี `try/catch` · `commandTimeout` ยกเลิกแค่ฝั่ง client → Lua `DECR` ไปแล้วแต่แอปไม่รู้ → ไม่ชดเชย → **สต็อกหาย 8 ชิ้นจาก 50** | `compensate-if-reserved.lua` (ใหม่) ใช้ค่าใน `lock:order:*` เป็นหลักฐานแทนการเดา · ตอบ 503 แทน 500 · unit test เพิ่ม 3 ข้อ |

**ผลหลังแก้ (k6 run 003):** §9.3 ผ่านครบ 4 ข้อ — `remaining_stock = 0` · `orders = 50/50` · Redis counter `"0"` · ไม่มีใครได้เกิน 1 ชิ้น · `202 accepted = 50` พอดี · `500 unhandled = 0`

### ✅ ปิดไปแล้ว (2026-08-26 — design review รอบ 2)

| เดิม | แก้เป็นอะไร |
| :--- | :--- |
| `job.data.requestToken` จาก `queue.add()` — **เป็น dead code** BullMQ ไม่เคยอ่าน `data` กลับจาก Redis | อ่าน job กลับด้วย `queue.getJob(jobId)` แล้วเทียบ token ที่เก็บอยู่จริง (round trip เท่าเดิม) |
| `SoldOutError` คืนสต็อก → ระบบไม่ self-heal (202 → job ตาย → คืน → วนใหม่) | **ไม่คืน** — ปล่อยให้ counter ลู่ลงเข้าหา DB แล้วหยุดเอง |
| lock เก็บ `jobId` ซึ่งซ้ำทุกครั้ง → compare-and-delete แยกการถือครองไม่ออก | lock เก็บ `requestToken` สุ่มใหม่ทุกคำขอ · `compensate*.lua` เปลี่ยนจาก `DEL` เปล่าเป็น compare-and-delete |
| read path โยน 503 เมื่อ `MGET` ล้ม → reader 1,000 คนอ่านไม่ได้เลย | degrade เป็น `fallbackRemainingStock` + นับ + log |
| `invalidateCatalogCache()` 50 ครั้งใน ~300 ms | debounce ≤ 1 ครั้ง/วินาที (trailing ไม่ทิ้งงาน) |
| ioredis ไม่มี `commandTimeout` → คำสั่งค้าง `catch` ไม่ทำงาน | `commandTimeout: 1000` |
| `compensated:` TTL 86,400 วิ | 300 วิ |
| ไม่มีทาง reset → ยิงรอบสองได้ 409 ล้วน | `RESET_CONFIRM=yes pnpm run reset` |
| เอกสาร 4 จุดบรรยายโค้ดที่ไม่มีอยู่จริง | แก้แล้วทั้ง §8, ADR-4, Q3, §6 |

---

## 1. 🛠️ Tech Stack

| ชั้น | เทคโนโลยี | หมายเหตุ |
| :--- | :--- | :--- |
| Runtime | Node.js `>= 20.x` (แนะนำ `v22.x`) | |
| Package Manager | **`pnpm` เท่านั้น** | ห้าม `npm` / `yarn` เด็ดขาด |
| Framework | NestJS `^11` (Express platform) | โครงสร้างแบบ **modular by domain** |
| Load Balancer | Nginx alpine | `least_conn` + keepalive 128 → ≥ 3 instances (รันจริง **6**) |
| Database | PostgreSQL 16 (Primary `:5432` / Replica `:5433`) | TypeORM replication (read-write split) |
| Cache | Redis 7 — **`redis-cache`** `allkeys-lru` | metadata cache เท่านั้น |
| Stock + Queue | Redis 7 — **`redis-data`** `noeviction` + AOF | stock counter, lock, BullMQ |
| Queue | BullMQ + `@nestjs/bullmq` | ⚠️ **ห้ามใช้ `bull` / `@nestjs/bull`** |
| Auth | `@nestjs/jwt` + `passport-jwt` (HS256) | stateless, ห้ามมี session ใน memory |
| Validation | `class-validator` + `class-transformer` | global `ValidationPipe` |
| Testing | Jest `^30`, Supertest `^7` | |
| Load Test | k6 → `loadtest.js` | เป็น deliverable |
| Container | Podman (`podman compose`) ใช้กับ `docker-compose.yml` | ไฟล์ต้องชื่อ `docker-compose.yml` ตามโจทย์ |

---

## 2. ⚡ คำสั่งที่ใช้บ่อย

> ⚠️ ใช้ `pnpm` เสมอ

```bash
# --- Infrastructure ---
podman compose up -d              # Nginx + 6 app + PG primary/replica + redis x2
podman compose ps                 # ดูสถานะ + healthcheck
podman compose logs -f app-1
podman compose down -v            # ⚠️ -v ลบ volume (ข้อมูล DB หายหมด) — ถามก่อนใช้

# --- Dependencies & Build ---
pnpm install
pnpm add <pkg>                    # ใช้ -w ต่อเมื่อ repo เป็น workspace จริงเท่านั้น
pnpm run build

# --- Dev / Prod ---
pnpm run start:dev
pnpm run start:prod

# --- Quality ---
pnpm run lint
pnpm run format

# --- Tests ---
pnpm run test
pnpm run test:cov
pnpm run test:e2e

# --- Migrations (TypeORM) ---
pnpm run migration:generate -- src/database/migrations/<Name>
pnpm run migration:run
pnpm run migration:show
pnpm run migration:revert         # ⚠️ ต้องขออนุญาตก่อน (§7)

# --- Seed & Reset ก่อนทดสอบทุกครั้ง ---
pnpm run seed                     # โหลด docs/Requirement/products-seed.json เข้า DB
pnpm run seed:redis               # SET stock:flash_sale:* จาก DB (NX) — ขาดไม่ได้

# --- Reset ก่อนยิงรอบใหม่ (ขาดไม่ได้ถ้าจะยิงมากกว่า 1 รอบ) ---
RESET_CONFIRM=yes pnpm run reset   # ⚠️ ลบ orders ทั้งตาราง + stock/bought/lock ใน redis-data แล้ว seed ใหม่
                                   # ไม่รัน = ยิงรอบสองได้ 409 ทั้งหมด (seed ใช้ NX + ON CONFLICT จึงแก้เองไม่ได้)

# --- Load Test ---
k6 run loadtest.js

# --- Observability (อยู่ใต้ Basic Auth เดียวกับ Bull-Board) ---
# http://localhost:8080/admin/queues    -> Bull-Board (Waiting/Active/Completed/Failed + กราฟ metrics)
# http://localhost:8080/admin/insights  -> integrity + ตัวนับ + event loop lag + replication lag (refresh 3 วิ)
# http://localhost:8080/admin/metrics   -> Prometheus exposition format (ยังไม่มี Prometheus ในสแตก)
curl -u admin:admin -X POST http://localhost:8080/admin/metrics/reset   # ล้างตัวนับก่อนยิงรอบใหม่
```

---

## 3. 📋 API Contract — ห้ามเปลี่ยนโดยพลการ

โจทย์บังคับสเปกนี้เพื่อให้ยิง load test ข้ามกลุ่มได้ **การเปลี่ยนใดๆ ต้องถามผู้ใช้ก่อน**

### `POST /api/v1/auth/token` — จำลอง login (ไม่ถูกวัด performance)
```jsonc
// req
{ "userId": "user-999" }
// res 200
{ "status": "success", "accessToken": "eyJhbGciOiJIUzI1NiIs..." }
```

### `GET /api/v1/products?page=1&limit=10` — read-heavy
```jsonc
{
  "status": "success",
  "data": [{
    "productId": "p-1001",
    "name": "Limited Edition Sneaker",
    "price": 2990,
    "availableStock": 50,      // คงที่ มาจาก seed
    "remainingStock": 30,      // ⚠️ ต้องสดเสมอ อ่านจาก Redis counter
    "isFlashSaleActive": true
  }],
  "meta": { "total": 20, "page": 1, "limit": 10, "totalPages": 2 }
}
```

### `POST /api/v1/orders` — write-heavy (ต้องมี `Authorization: Bearer <JWT>`)
```jsonc
// req  (ไม่มี quantity — บังคับ 1 ชิ้น)
{ "productId": "p-1001" }
// res 202
{ "status": "processing", "orderJobId": "order:user-999:p-1001",
  "message": "Your order is in the queue." }
```

> **field เกินถูกตัดทิ้งเงียบๆ ไม่ตอบ 400** — `{"productId":"p-1001","quantity":1}` ได้ **202** ปกติ
> เป็นเจตนา (`whitelist: true` ที่ `main.ts`) เพื่อให้ k6 ของกลุ่มอื่นที่ส่ง `quantity` มายิงระบบเราได้
> `userId` ใน body ก็ถูกตัดทิ้งเช่นกัน — สวมสิทธิ์ไม่ได้ (invariant §4 ข้อ 2)
> ⚠️ **ห้ามใส่ `forbidNonWhitelisted: true` ที่ไหนก็ตาม** (เคยมีที่ `orders.controller.ts` — ถอดออกแล้ว 2026-08-29)

| สถานการณ์ | Status | หมายเหตุ |
| :--- | :--- | :--- |
| รับเข้าคิวสำเร็จ | **202** | ห้ามเป็น 200/201 |
| ไม่มี/JWT ไม่ถูกต้อง | 401 | |
| เคยซื้อสินค้านี้แล้ว | 409 | |
| ของหมด | 409 | |
| กดรัวขณะมี order in-flight | 429 | **นับเป็นพฤติกรรมถูกต้อง ไม่ใช่ error** |
| stock counter ยังไม่ถูก seed | 503 | ต้องแยกจาก "ของหมด" ให้ชัด |
| `productId` หาย / ว่าง / ยาวเกิน 32 | 400 | body ผิดรูปจริงๆ เท่านั้น — **ไม่ใช่**เพราะส่ง field เกินมา |

> `{"productId": 123}` (ตัวเลข) ได้ **503 ไม่ใช่ 400** — `enableImplicitConversion` แปลงเป็น `"123"` ผ่าน `@IsString()` แล้วไปตกที่ "ไม่มี stock counter ของ `123`"

---

## 4. 🚨 Concurrency Invariants — กฎที่ห้ามละเมิด

นี่คือหัวใจของโจทย์ (Zero oversell + 1 ชิ้น/คน) รายละเอียดเต็มอยู่ใน [`docs/Architecture/architecture.md`](docs/Architecture/architecture.md) §6

1. **ห้าม synchronous DB write ใน controller** — controller ต้องตอบ 202 หลัง enqueue ทันที
2. **`userId` มาจาก JWT claim `sub` เท่านั้น** ห้ามรับจาก request body (ไม่งั้นสวมสิทธิ์ได้ + dedup พังทั้งระบบ)
3. **Worker ต้องเขียนผ่าน `dataSource.createQueryRunner('master')` เท่านั้น** — `repository.findOne()` วิ่งไป replica ที่มี lag → race condition
4. **ตัดสต็อกด้วย atomic SQL** `WHERE id = $1 AND remaining_stock > 0` แล้วเช็ค `affected === 0` — **ห้าม** `SELECT` มาเช็คใน JS ก่อน (TOCTOU)
5. **หัก/คืน stock ใน Redis ต้องอยู่ใน Lua script** ห้ามทำเป็นหลายคำสั่งแยกกัน
6. **ทุก path ที่หักสต็อกแล้วต้องมีทางชดเชย** — ถ้า `queue.add()` ล้มหลัง `DECR` ต้อง `INCR` คืนใน `catch`
7. **Side effect หลัง `commitTransaction()` ต้องอยู่นอก try/catch ของ transaction** ไม่งั้นจะคืนสต็อกทั้งที่ขายไปแล้ว → oversell
8. **Compensation ต้อง idempotent** guard ด้วย `compensated:{jobId}:{requestToken}` (BullMQ retry ได้หลายครั้ง)
   ⚠️ **ต้องมี `requestToken` ด้วย ห้ามใช้ `jobId` เดี่ยวๆ** — `jobId` เป็น deterministic (ข้อ 9) guard จะคุมข้าม *คำขอ* ไม่ใช่แค่ข้าม retry → คนเดิมสั่งใหม่ใน TTL แล้วไม่ได้คืนสต็อก = หายถาวร (แก้ 2026-08-30) · retry ยังถูกคุมอยู่เพราะ BullMQ อ่าน `job.data` ชุดเดิม จึงได้ token เดิม
9. **`jobId` ต้องเป็น `order:{userId}:{productId}`** (deterministic) เพื่อให้ BullMQ ปฏิเสธ job ซ้ำเอง
10. **Permanent failure ต้อง `return` ไม่ใช่ `throw`** (ของหมด / unique violation `23505`) — retry ไม่มีทางสำเร็จ
11. **`redis-data` ต้อง `noeviction`** ถ้า LRU evict `stock:*` หรือ BullMQ job = ระบบพังเงียบๆ

---

## 5. 📐 Core Patterns

1. **Stateless Backend** — ไม่มี session/counter/cache ผูกกับ RAM ของ process. ข้อยกเว้นเดียวคือ *single-flight promise memoization* ซึ่งเก็บ in-flight request ไม่ใช่ผลลัพธ์ข้ามคำขอ
2. **Cache-Aside + Stock Overlay** — metadata แคชนาน (TTL 30–60s **+ jitter**), `remainingStock` อ่านสดจาก `MGET stock:*` แล้ว merge ตอน serialize. **นี่คือคำตอบของ "เงื่อนไขสำคัญ" ในโจทย์**
3. **4-Tier Defense** — JWT guard → Redis Lua gatekeeper → BullMQ → atomic SQL → DB constraints
4. **Health Checks แยก 2 ตัว** — `/health/live` ห้ามเช็ค DB (DB สะดุดแล้วจะ restart ทุก container พร้อมกัน), `/health/ready` เช็ค DB + Redis แล้วตอบ 503
5. **Structured JSON Logging** — single-line JSON + `X-Correlation-ID` ส่งต่อเข้า job payload ให้ trace ข้ามไปถึง worker ได้ + redact password/token/secret
6. **Key Builder รวมศูนย์** — Redis key ทุกตัวสร้างจาก `src/redis/redis.keys.ts` ห้ามต่อ string เอง
7. **Metrics เป็น write-behind** — `MetricsService.inc()` เป็น synchronous ล้วน (บวกใน Map) แล้ว flush ลง hash `metrics:counters` บน **redis-data** ทุก 1 วินาที
   เก็บบน Redis เพราะ 6 instance ต้องบวกลงถังใบเดียวกัน · **ห้ามเปลี่ยนไป `HINCRBY` ตรงๆ ในเส้นทางร้อน** — ที่ 1,500 rps จะเพิ่มภาระ redis-data อีก 1,500 ops/s บน connection เดียวกับ gatekeeper

---

## 6. ✅ DO / ❌ DON'T

### ✅ DO
- **Strict typing** — เลี่ยง `any`; mock ในเทสต์ใช้ `jest.Mocked<Repository<T>>` ไม่ใช่ `any`
- **TTL ทุก key ใน `redis-cache`** พร้อม jitter (key ที่ไม่มี TTL = memory leak)
- **ปล่อย Redis lock ผ่าน Lua compare-and-delete** (เทียบ token ก่อนลบ)
- **`try/catch` รอบทุกการเรียก cache พร้อม fallback ไป DB** — Redis คือ optimization ไม่ใช่ dependency ที่ขาดไม่ได้
  ⚠️ กฎนี้จะเป็นจริงได้**ก็ต่อเมื่อ ioredis มี `commandTimeout`** (`redis.module.ts`) — `maxRetriesPerRequest: null` เพียวๆ แปลว่า "ไม่ยอมแพ้"
  คำสั่งจะ**ค้าง**ไม่ reject ตอน Redis สะดุด → `catch` ไม่มีวันทำงาน → request ค้างจนชน `proxy_read_timeout` ของ nginx กลายเป็น 504 **ห้ามลบบรรทัดนั้น**
- **stock counter (`redis-data`) อ่านไม่ได้ ให้ degrade ไม่ใช่ล้ม** — read path ไม่ใช่พื้นผิวของความถูกต้อง (ตัวตัดสินคือ `gatekeeper.lua` ฝั่ง write)
  ตอบ `fallbackRemainingStock` จากแคช + นับ + log ระดับ error ไว้รายงาน **ห้ามเงียบ**
- **ใช้ NestJS exceptions มาตรฐาน** (`ConflictException`, `ServiceUnavailableException`, ...)
- **Migration สำหรับทุกการเปลี่ยน schema** และอ่านไฟล์ที่ generate มาก่อน commit เสมอ
- **`price` ต้องมี `transformer` แปลง `NUMERIC` → `number`** — driver คืน `numeric` เป็น **string** ถ้าไม่แปลง response จะเป็น `"2990.00"` = **ผิด contract §3** (ดู `docs/Architecture/architecture.md` §3.1)
- **`products.id` เป็น `@PrimaryColumn` varchar (`p-1001`)** ห้าม `@PrimaryGeneratedColumn` — ไม่งั้น seed เข้าไม่ได้
- **ไม่มีตาราง `users` และ `orders.user_id` ไม่มี FK โดยเจตนา** — `/auth/token` ออก token โดยไม่แตะ DB
- **Graceful shutdown** (`app.enableShutdownHooks()`) ไม่งั้น deploy ทีไรเกิด stalled job ทุกที
- **Bull-Board ต้องมี auth คลุม** — มันเปิดดู payload และกด retry/remove job ได้

### ❌ DON'T
- ❌ ใช้ `npm` / `yarn` — **`pnpm` เท่านั้น**
- ❌ เก็บ state ที่ต้องแชร์ไว้ใน memory ของ Node.js (รวมถึง **L1 LRU cache ที่มี `remainingStock`** — 6 instance จะตอบไม่ตรงกัน)
- ❌ เปิด `synchronize: true` (DROP column ได้ = ข้อมูลหายถาวร)
- ❌ อ่านข้อมูลที่ต้อง lock จาก Replica
- ❌ `redis.keys(pattern)` — O(N) และบล็อก Redis ทั้งตัว ใช้ `SCAN` หรือ key ที่คำนวณตรงได้
- ❌ ลบ Redis lock ด้วย `DEL` ตรงๆ โดยไม่เทียบ token เจ้าของ
- ❌ เรียก external API ใน DB transaction — ให้ enqueue แทน
- ❌ ใช้ `job.progress()` / `queue.on('completed')` / job option `timeout` — พวกนี้เป็น **Bull ไม่ใช่ BullMQ** (ใช้ `job.updateProgress()`, `QueueEvents` / `@OnWorkerEvent()`, `Promise.race`)
- ❌ Hardcode secret — ใช้ `ConfigService` / `.env` เสมอ
- ❌ Commit `.env` หรือแก้ `pnpm-lock.yaml` ด้วยมือ
- ❌ นับ 409/429 เป็น error ใน k6 threshold — มันคือพฤติกรรมที่ถูกต้อง

---

## 7. 🧪 Verification Checklist

ก่อนสรุปว่างานเสร็จ **ต้องรันและผ่านครบ**:

```bash
pnpm run build     # 1. ไม่มี TypeScript error
pnpm run lint      # 2. ผ่าน ESLint
pnpm run test      # 3. unit tests ผ่านหมด
```
> เทสต์ตก = แก้ที่ต้นเหตุ **ห้ามลบ assertion ทิ้ง**

4. **API contract ไม่เปลี่ยน** — path, field, status code ตรงกับ §3
5. **ถ้าแตะ write path** ต้องรัน load test แล้วพิสูจน์ Data Integrity ([`docs/Architecture/architecture.md`](docs/Architecture/architecture.md) §9.3):
   ```sql
   SELECT remaining_stock FROM products WHERE id = 'p-1001';       -- ต้อง = 0
   SELECT COUNT(*), COUNT(DISTINCT user_id) FROM orders
     WHERE product_id = 'p-1001';                                  -- ต้อง = 50, 50
   ```
   ```bash
   redis-cli -p 6380 GET stock:flash_sale:p-1001                   # ต้อง = "0"
   ```
6. **ถ้าแก้ `docs/Architecture/architecture.md`** ต้องเช็คว่า §0 Requirement Traceability ยังชี้ถูกที่

---

## 8. ❓ ต้องหยุดถามผู้ใช้ก่อน

- ⚠️ **กระทบข้อมูลใน DB** — `migration:revert`, `podman compose down -v`, ลบตาราง/คอลัมน์, raw SQL ที่ลบข้อมูล
- ⚠️ **เพิ่ม/ลบ/อัปเกรด dependency**
- ⚠️ **เปลี่ยน API contract** (§3) — path, method, field, status code
- ⚠️ **แก้นโยบาย cache หรือ concurrency** — TTL, ปิด lock, ลด tier, แก้ Lua script
- ⚠️ **ละเมิด invariant ใน §4** ข้อใดข้อหนึ่ง
- ⚠️ **แก้ config หลัก** — `.env.example`, `docker-compose.yml`, `nginx.conf`, `maxmemory-policy`

---

## 9. 📦 Deliverables (เกณฑ์ส่งงาน)

- [ ] **Source code** บน GitHub + `docker-compose.yml` ที่ **1-click start** ได้จริง
- [ ] **`loadtest.js`** (k6) วางใน repo เดียวกัน
- [ ] **Report (PDF)** ประกอบด้วย:
  - [ ] Diagram สถาปัตยกรรม
  - [ ] อธิบายกลยุทธ์ **Cache Invalidation** และการกัน **สั่งซื้อซ้ำซ้อน**
  - [ ] ผลจาก Load Test Dashboard (แคปหน้าจอ + คำอธิบาย)
  - [ ] **ตารางเทียบผลยิงระบบกลุ่มตัวเอง vs กลุ่มเพื่อน** + วิเคราะห์คอขวด
  - [ ] รายชื่อสมาชิกและการแบ่งงาน
  - [ ] อธิบายว่า **จัดการ `remainingStock` อย่างไร** (อาจารย์ระบุไว้ในโจทย์)

---

## 📚 เอกสารอ้างอิงในโปรเจกต์

| ไฟล์ | ใช้เมื่อไหร่ |
| :--- | :--- |
| [`docs/Architecture/architecture.md`](docs/Architecture/architecture.md) | **สเปกหลัก** — อ่านก่อนเขียนโค้ดทุกครั้ง (**§3.1 = DB schema / entity / migration**) |
| [`docs/Codebase/`](docs/Codebase/README.md) | **โค้ดไฟล์ไหนเรียกไฟล์ไหน** — primer เดินโค้ดจากศูนย์ + บันทึก design review Q&A (อ้าง `file:line` ของโค้ดจริง) |
| [`docs/Architecture/diagrams.md`](docs/Architecture/diagrams.md) | DFD / Control Flow / CSPEC / State Machine — ใช้ประกอบรายงานและตรวจ invariant |
| [`docs/Architecture/architecture-rationale.md`](docs/Architecture/architecture-rationale.md) | **เหตุผลการออกแบบ + ข้อดีข้อเสีย + บันทึก design review** — อ่านก่อนจะแก้ดีไซน์ (§7 มี blocker ที่ยังไม่แก้ 2 ข้อ) |
| [`docs/Requirement/Flash Sale System.pdf`](docs/Requirement/Flash%20Sale%20System.pdf) | โจทย์ต้นฉบับ |
| [`docs/Requirement/products-seed.json`](docs/Requirement/products-seed.json) | ข้อมูลตั้งต้น |
| [`docs/Summary_Best_Practice/For_agent/INDEX.md`](docs/Summary_Best_Practice/For_agent/INDEX.md) | กฎสรุปจากบทเรียน + **slide-errata** (โค้ดในสไลด์ที่ผิด ห้ามลอก) |
| [`docs/Summary_Best_Practice/For_human/`](docs/Summary_Best_Practice/For_human/) | ฉบับอ่านยาว ภาษาไทย |
| [`docs/Meta/primer-template.md`](docs/Meta/primer-template.md) | แม่แบบ prompt สำหรับเขียนเอกสารปูพื้นฐาน — **ไม่ใช่สเปกของระบบนี้** เป็นเครื่องมือเขียนเอกสาร |
| [`handoff_log/INDEX.md`](handoff_log/INDEX.md) | **บันทึกส่งต่องาน** — อ่านตัวล่าสุดก่อนเริ่มงานต่อ (มีของที่ไม่ได้อยู่ในโค้ด: เหตุผล, ทางตัน, สิ่งที่ยังไม่พิสูจน์) |
| [`AGENTS.md`](AGENTS.md) | pointer มาที่ไฟล์นี้ (สำหรับ AI tool อื่น) |
