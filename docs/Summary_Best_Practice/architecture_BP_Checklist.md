# ✅ Architecture Best-Practice Checklist — Backend01–06 → โค้ดจริง

> **เอกสารนี้ตอบคำถามเดียว**: บทเรียน Backend01–06 สอนกฎอะไรบ้าง และ **โค้ดในรีโปนี้ใช้ข้อไหนจริง ที่บรรทัดไหน**
> ทุกแถวที่เขียนว่า APPLIED = **มีคนเปิดไฟล์นั้นดูจริง** และอ้าง `file:line` ได้ ไม่ใช่การเดาจากชื่อไฟล์
>
> **ที่มา**: [`For_agent/Backend01–06.md`](For_agent/INDEX.md) (กฎฉบับย่อ + slide-errata) · [`For_human/Backend01–06.md`](For_human/) (ฉบับยาวภาษาไทย)
> **วิธีตรวจ**: agent 7 ตัวอ่านแยกกัน (2 ตัว map กฎ→โค้ด · 5 ตัวตรวจเอกสารกับโค้ด) แล้ว spot-verify ซ้ำด้วยมือ
> **วันที่ตรวจ**: 2026-08-31 · **สถานะ build/lint/test**: `npx jest` → **49 passed / 5 suites** ✅

---

## 0. 🔢 ตัวเลขที่ยืนยันแล้ว (ใช้อ้างในรายงานได้)

| อะไร | ค่า | ยืนยันจาก |
| :--- | :--- | :--- |
| Unit tests | **49 ข้อ / 5 suites** | `npx jest --silent` (2026-08-31) — เอกสารเก่าเขียน 32/35/43 **ผิดทั้งหมด** |
| e2e tests | **0** | `test/` มีแต่ `jest-e2e.json` ไม่มี `*.e2e-spec.ts` สักไฟล์ |
| ไฟล์ใน `src/` | **59** (54 `.ts` + 5 `.lua`) | `find src -name '*.ts' \| wc -l` |
| App instances | **6** (`app-1`…`app-6`) | `docker-compose.yml` + `nginx.conf:64-69` ตรงกัน |
| `cpus` รวมทั้งสแตก | **10.0** | 1.0 (pg-primary) + 0.5 (pg-replica) + 0.5 (redis-cache) + 1.0 (redis-data) + 6×1.0 (app) + 1.0 (nginx) |
| `mem_limit` รวม | **5,440 MB** = 88.5% ของ VM 6,144 MB | 768 + 640 + 320 + 512 + 6×512 + 128 |
| `WORKER_CONCURRENCY` | **1** ต่อ instance (รวม 6) | `docker-compose.yml:243,307,370,433,496,559` |
| `DB_POOL_SIZE` | **8** → 6×8 = **48/100** ต่อเซิร์ฟเวอร์ (48%) | ต่ำกว่าเพดาน 80% ที่ B06 กำหนด |

---

## 1. 🏆 สรุปคะแนน — ใช้ไปกี่ข้อ

| บทเรียน | รวมกฎ | ✅ APPLIED | 🟡 PARTIAL | ❌ NOT-USED | ⚪ N/A |
| :--- | ---: | ---: | ---: | ---: | ---: |
| **B01** Architecture & Containerization | 22 | 14 | 3 | 2 | 3 |
| **B02** NestJS & Testability | 24 | 16 | 1 | 2 | 5 |
| **B03** Database Engineering | 34 | 14 | 4 | 3 | 13 |
| **B04** Redis: Caching & Atomic Ops | 32 | 24 | 3 | 1 | 4 |
| **B05** Async Communication (BullMQ) | 22 | 11 | 2 | 4 | 5 |
| **B06** Scaling, LB & Observability | 28 | 23 | 1 | 3 | 1 |
| **รวม** | **162** | **102** | **14** | **15** | **31** |

> **อ่านตัวเลขนี้ยังไง**: ⚪ N/A = บทเรียนสอนไว้แต่ระบบนี้**ไม่มีเคสให้ใช้จริง** (เช่น rate limiter สำหรับ SendGrid ในเมื่อเราไม่เรียก external API เลย) — ไม่ใช่ข้อบกพร่อง
> ตัดข้อ N/A ออก เหลือกฎที่ **ใช้ได้จริง 131 ข้อ** → **APPLIED 102 ข้อ = 77.9%** · นับ PARTIAL เป็นครึ่งข้อ = **83.2%**
> (ตัวเลขนับด้วยสคริปต์จากตาราง §3 โดยตรง ไม่ได้นับมือ)
>
> ⚠️ **ตัวเลขนี้วัด "ทำตามบทเรียนหรือไม่" ไม่ได้วัด "ระบบดีหรือไม่"** — บางข้อที่เป็น ❌ เป็นการ**จงใจเลือกทางที่ดีกว่า** (ดู §3 B03-62/63)
> และบางข้อที่เป็น ✅ ก็ยัง**มีบั๊กที่รู้ตัวแล้ว**อยู่ข้างใน (ดู §5)

---

## 2. 🎯 5 ข้อที่เป็น "หัวใจ" ของโปรเจกต์นี้

ถ้าจะเล่าให้อาจารย์ฟังใน 2 นาที เล่า 5 ข้อนี้ — ทั้งหมดมาจากบทเรียนตรงๆ และเป็นตัวที่ทำให้ผ่านโจทย์

| # | กฎจากบทเรียน | เราทำที่ไหน | ทำไมมันคือคำตอบของโจทย์ |
| :--- | :--- | :--- | :--- |
| 1 | **B04** — แยก data ตามอัตราการเปลี่ยนแปลง · cache-aside + TTL jitter | `products.service.ts:86-96` · `redis.service.ts:289-291` | metadata แคชได้เป็นนาที แต่ **`remainingStock` ไม่เคยอยู่ในแคชเลย** อ่านสดด้วย `MGET` แล้ว merge ตอน serialize → ตอบโจทย์ "เงื่อนไขสำคัญ" ที่อาจารย์ถามตรงๆ |
| 2 | **B04** — `INCR`/`DECR` atomic · lock ต้อง `SET NX EX` + token + Lua compare-and-del | `src/redis/lua/gatekeeper.lua` | เช็คสต็อก + เช็คซื้อซ้ำ + จองสิทธิ์ **ใน Lua ก้อนเดียว** = ไม่มีช่อง TOCTOU ระหว่าง 500 คนที่ยิงพร้อมกัน |
| 3 | **B03** — conditional update + เช็ค `affected===0` (ห้าม SELECT มาเช็คใน JS) | `orders.processor.ts:69-76` | `UPDATE … WHERE remaining_stock > 0` แล้วเช็ค `affected` — **นี่คือ pattern ที่ slide-errata B03#1 บอกว่าเป็นวิธีที่ถูก** (ตัวอย่างในสไลด์เองผิด) |
| 4 | **B05** — at-least-once ⇒ handler ต้อง idempotent | `order.entity.ts:9` `@Unique(['userId','productId'])` · `compensate-once.lua` | BullMQ retry ได้หลายครั้ง → กัน 2 ชั้น: `UNIQUE` ที่ DB + guard key `compensated:{jobId}:{requestToken}` |
| 5 | **B06** — stateless + `/health/live` ห้ามเช็ค DB | `health.controller.ts:38-45` vs `:63-72` | แยก live/ready จริง — **สไลด์เองใช้ `/health` ตัวเดียวซึ่ง errata B06#3 บอกว่าผิด** ถ้าทำตามสไลด์ DB สะดุดทีเดียว container restart พร้อมกันทั้ง 6 ตัว |

---

## 3. 📋 ตารางเต็ม — กฎทุกข้อ → โค้ดจริง

> `⚪` = บทเรียนสอนไว้แต่ระบบนี้ไม่มีเคสให้ใช้ · `❌` = ช่องว่างจริง **หรือ** จงใจเลือกทางอื่นที่ดีกว่า (ดูคอลัมน์หมายเหตุ)

### B01 — Architecture & Containerization

| # | กฎ | สถานะ | หลักฐาน (`file:line`) | หมายเหตุ |
| :--- | :--- | :---: | :--- | :--- |
| 1 | เริ่มด้วย monolith แยกเมื่อวัดเจอคอขวด | ✅ | `src/` เป็น NestJS app เดียว | ถูกต้องตามสเกลของโจทย์ |
| 2 | Modular monolith — จัดตามโดเมน ไม่ใช่ตาม layer | ✅ | `src/orders/`, `src/products/`, `src/auth/` | ไม่มี `services/` `controllers/` รวมกอง |
| 3 | Multi-stage build: builder ทำ install+build · final copy แค่ `dist` + prod deps | ✅ | `Dockerfile:7-24` (builder), `:27-53` (production) | |
| 4 | `COPY package*.json` ก่อน `COPY . .` เพื่อให้ layer cache ไม่พัง | ✅ | `Dockerfile:19` แล้ว `:23` | |
| 5 | ใช้ alpine base | ✅ | `Dockerfile:7,28` `node:22-alpine` · `postgres:16-alpine` · `redis:7-alpine` | |
| 6 | Pin tag เป๊ะ ห้าม `latest` | 🟡 | base image pin ครบ **แต่** `docker-compose.yml` ใช้ `flash-sale-backend:latest` | image ของเราเองยังเป็น `:latest` |
| 7 | Tag image ด้วย commit SHA เพื่อ rollback | ❌ | ไม่มีที่ไหนเลย | ไม่มี CI pipeline |
| 8 | `USER node` (ไม่รันเป็น root) | ✅ | `Dockerfile:60` | |
| 9 | `npm ci --omit=dev` (ไม่ใช่ `--only=production`) | ⚪ | `Dockerfile:39` `pnpm install --prod --ignore-scripts` | ใช้ pnpm ไม่ใช่ npm — ใช้ flag ที่ถูกของ pnpm แล้ว |
| 10 | `.dockerignore` กัน `node_modules` `.git` `.env*` `dist` | ✅ | `.dockerignore:1-19` ครบทุกตัว | กันความลับรั่วเข้า layer |
| 11 | `HEALTHCHECK` + `/health` ที่ ping deps จริง | 🟡 | ไม่มีใน `Dockerfile` · มีที่ compose ทุก service ยิง `/health/live` | ใช้งานได้จริง แต่ไม่ได้ฝังใน image |
| 12 | Secret ส่งตอน runtime ห้าม bake เข้า image | ✅ | ไม่มี secret literal ใน `Dockerfile` | ส่งผ่าน `environment:` ตอน start |
| 13 | `.env` อยู่ใน `.gitignore` | ✅ | `.gitignore:9-11` (`!.env.example`) | |
| 14 | แยก secret dev/prod | ❌ | `flashsale`/`flashsale` · `admin`/`admin` ตัวเดียวกันหมด | บันทึกไว้แล้วใน `CLAUDE.md` §0.1 |
| 15 | Prod secret จาก secrets manager | ⚪ | ไม่มี prod deployment | |
| 16 | `--env-file` ใช้ได้เฉพาะ dev | ⚪ | ไม่ได้ใช้ — compose inline env ตรงๆ | |
| 17 | Validate env ตอน boot แล้ว crash ทันทีถ้าผิด | ✅ | `env.validation.ts:145-169` → `app.module.ts:25` | |
| 18 | ตั้ง `--memory` `--cpus` `--pids-limit` ทุก container | 🟡 | `mem_limit`/`cpus` ครบทุก service | **ไม่มี `pids-limit`** |
| 19 | `NODE_OPTIONS=--max-old-space-size` ให้ตรงกับ `--memory` | ✅ | `NODE_OPTIONS: "--max-old-space-size=384"` vs `mem_limit: 512m` | Node 22 อ่าน cgroup ได้แล้ว ทำเผื่อไว้ |
| 20 | Custom network + service discovery ด้วยชื่อ container | ✅ | ใช้ `postgres-primary`, `redis-data` เป็น host ตรงๆ | |
| 21 | `depends_on` ไม่ได้รอ readiness → ต้อง `condition: service_healthy` | ✅ | ทุก app service ใช้ `condition: service_healthy` + `scripts/app-entrypoint.sh` poll ซ้ำ | กัน 2 ชั้น |
| 22 | `version: '3.8'` เลิกใช้แล้วใน Compose v2 *(errata #4)* | ✅ | ไม่มี key `version:` เลย | หลบ errata สำเร็จ |

### B02 — NestJS & Testability

| # | กฎ | สถานะ | หลักฐาน (`file:line`) | หมายเหตุ |
| :--- | :--- | :---: | :--- | :--- |
| 23 | Module แยกตามโดเมน | ✅ | `src/orders/` `src/products/` `src/auth/` มี controller+service+dto+entity ครบในตัว | |
| 24 | Controller = HTTP อย่างเดียว ห้ามมี business logic / DB | ✅ | `orders.controller.ts:37-59` · `products.controller.ts:22-34` | ดึง `userId` จาก JWT แล้ว delegate |
| 25 | `exports` เฉพาะที่จำเป็น | ✅ | `orders.module.ts:18` export แค่ `OrdersService` | |
| 26 | Shared module สำหรับ cross-cutting | ✅ | `database_config/` `logger/` `redis/` ทั้งหมด `@Global()` | |
| 27 | Global `ValidationPipe` + `whitelist` + `forbidNonWhitelisted` + `transform` | 🟡 | `main.ts:30-40` มี `whitelist:true` + `transform:true` **แต่จงใจไม่ใส่ `forbidNonWhitelisted`** | **เจตนา** — k6 กลุ่มอื่นส่ง `quantity` มาต้องได้ 202 ไม่ใช่ 400 (`CLAUDE.md` §3) |
| 28 | Service โยน HTTP exception มาตรฐาน ไม่ `return null` | ✅ | `orders.service.ts:111,126,130,140,206` | |
| 29 | Constructor injection + class token | ✅ | ทุก service | |
| 30 | Non-class token ใช้ `Symbol`/const ห้ามใช้สตริงเปล่า | ✅ | `redis.constants.ts` → ใช้ที่ `redis.module.ts:60,75` | |
| 31 | `useFactory` + `inject` สำหรับ async resource | ✅ | `database.module.ts:9-13` · `redis.module.ts:59-88` · `bullmq.module.ts:21-39` | ต่อเสร็จก่อนรับ traffic |
| 32 | `useClass` สลับ impl ตาม env | ⚪ | ไม่มีเคสที่ต้องสลับ | |
| 33 | อยู่ที่ DEFAULT scope | ✅ | ไม่มี `Scope.REQUEST`/`TRANSIENT` ที่ไหนเลย | |
| 34 | Singleton คือ **ต่อ app ไม่ใช่ต่อ module** *(errata #1)* | ⚪ | ไม่มีโค้ดไหนพึ่งความเข้าใจผิดนี้ | |
| 35 | REQUEST scope ลามขึ้นทั้งสาย — ใช้ AsyncLocalStorage แทน | ⚪ | ไม่มี REQUEST provider · correlation ID ใช้ middleware + pino `genReqId` | ได้ผลเดียวกันโดยไม่เสี่ยง |
| 36 | ห้ามมี mutable state ต่อผู้ใช้ใน singleton | ✅ | `products.service.ts:69` in-flight map ลบใน `finally` (`:217-219`) | เก็บ promise ที่กำลังบิน ไม่ใช่ผลลัพธ์ข้ามคำขอ |
| 37 | `interface` เป็น DI token ไม่ได้ | ✅ | ทุกตัวที่ inject เป็น class หรือ const token | |
| 38 | Circular dep = ขอบเขต module ผิด อย่าแก้ด้วย `forwardRef()` | ⚪ | ไม่มี `forwardRef(` เลย · module graph เป็น DAG | |
| 39 | ใช้ `Test.createTestingModule` | ❌ | spec สร้าง class ตรงๆ ด้วย `new OrdersService(...)` | ได้ผลเท่ากัน แต่ไม่ใช่วิธีที่บทเรียนสอน |
| 40 | Mock ทุก dep · 1 unit ต่อ 1 เทสต์ · AAA | ✅ | `orders.service.spec.ts:29-72` | |
| 41 | ชื่อเทสต์บรรยายพฤติกรรม | ✅ | `orders.service.spec.ts:75` `'maps -1 (already purchased) to 409'` | |
| 42 | Mock พิมพ์เป็น `jest.Mocked<T>` ห้าม `any` *(errata #2)* | ✅ | `orders.service.spec.ts:14-17` · `products.service.spec.ts:31-37` | หลบ errata สำเร็จ |
| 43 | Controller test เช็คแค่ "เรียกถูก method/param/return" | ⚪ | ไม่มี controller spec | controller บางมากจนเหตุผลของกฎหมดความหมาย |
| 44 | Unit test ตรวจ SQL ไม่ได้ ต้องมี integration test คู่ | ❌ | **ไม่มี e2e เลย** — `test/` มีแต่ config | ช่องว่างจริง ตรงกับ `CLAUDE.md` §0.1 |
| 45 | `jest.spyOn` บน class ที่กำลังเทสต์ = เทสต์ mock *(errata #4)* | ✅ | `products.service.spec.ts:134-136` spy ที่ `Logger.prototype` (ตัว dep) | หลบ errata สำเร็จ |
| 46 | Framework ไม่ใช่คอขวด — แก้ DB/cache ก่อน | ✅ | งาน tuning ทั้งหมดลงที่ pool, Lua, GC | |

### B03 — Database Engineering

| # | กฎ | สถานะ | หลักฐาน (`file:line`) | หมายเหตุ |
| :--- | :--- | :---: | :--- | :--- |
| 47 | `synchronize: false` เสมอ | ✅ | `database.config.ts:59` · `data-source.ts:61` | hardcode `false` ไม่ได้อ่านจาก env → พลิกด้วยความบังเอิญไม่ได้ |
| 48 | เขียนและทดสอบ `down()` | ✅ | `InitSchema:52-56` drop ย้อนลำดับครบ | "ทดสอบ" ยังไม่มี CI ยืนยัน |
| 49 | ห้ามแก้ migration ที่ deploy แล้ว | ⚪ | มี migration เดียว | |
| 50 | 1 migration = 1 การเปลี่ยนแปลงเชิงตรรกะ | ✅ | `InitSchema` สร้าง baseline ทั้งชุดเป็นก้อนเดียว | |
| 51 | อ่าน migration ที่ generate มาก่อน commit | ⚪ | เขียนมือ ไม่ได้ generate | |
| 52 | รัน migration เป็น job แยก ไม่ใช่ตอน boot (race ข้าม N instance) | 🟡 | `app-entrypoint.sh:66-76` ให้เฉพาะ app-1 รัน (`RUN_MIGRATIONS=true`) ตัวอื่น poll รอ | กัน race ได้ แต่ยังรันจากใน container ที่กำลัง boot |
| 53 | ทดสอบ migration บนสำเนาข้อมูลจริง | ⚪ | ข้อมูล seed เล็กมาก ความเสี่ยง lock 50M แถวไม่มีจริง | |
| 54 | `ADD COLUMN NOT NULL DEFAULT` ล็อกตาราง → nullable → backfill → constraint | ⚪ | มีแต่ `CREATE TABLE` ตั้งต้น | |
| 55 | Expand-and-contract สำหรับ breaking change | ⚪ | schema ยังไม่เคยเปลี่ยน | |
| 56 | Transaction ต้องสั้น | ✅ | `orders.processor.ts:67-144` = 1 UPDATE + 1 INSERT | |
| 57 | **ห้ามเรียก external API ใน transaction** → enqueue แทน | ✅ | side effect (`markBought`, invalidate) อยู่ **นอก** ที่ `:146-167` | |
| 58 | ใช้ `manager` ที่ส่งเข้ามา ไม่ใช่ `this.repo` | ✅ | `orders.processor.ts:69-84` ใช้ `queryRunner.manager` ล้วน | ถ้าใช้ `this.repo` จะหลุดออกนอก transaction เงียบๆ |
| 59 | ล็อก resource ตามลำดับเดียวกันทั้งระบบ | ⚪ | ล็อกแถวเดียวต่อ transaction | ไม่มี circular wait ให้เกิด |
| 60 | Retry `40P01` ด้วย exponential backoff **+ jitter** | 🟡 | ตกเข้า transient branch → BullMQ `backoff:{exponential,200}` (`orders.service.ts:153`) | **ไม่มี jitter** — ตรงกับ errata #3 ที่บทเรียนเตือนเอง |
| 61 | READ COMMITTED พอ · SERIALIZABLE เฉพาะงานการเงิน | ✅ | ไม่ override isolation เลย | ความถูกต้องมาจาก atomic update ไม่ใช่ isolation |
| 62 | Pessimistic lock (`SELECT FOR UPDATE`) สำหรับ contention สูง | ❌ | ไม่มีที่ไหนเลย | **จงใจ** — แทนด้วย atomic conditional update ซึ่ง lock-free และเร็วกว่าสำหรับ workload นี้ |
| 63 | Optimistic lock (`@VersionColumn`) | ❌ | ไม่มี | เหตุผลเดียวกับข้อ 62 |
| 64 | **Conditional update + `affected===0`** *(errata #1 บอกว่านี่คือวิธีที่ถูก)* | ✅ | `orders.processor.ts:69-77` | ใช้ `remaining_stock > 0` เป็น guard แทน version column — textbook |
| 65 | `FOR UPDATE` ไม่บล็อก plain SELECT บน PG *(errata #4)* | ⚪ | ไม่ได้ใช้ `FOR UPDATE` | |
| 66 | Index ทุกคอลัมน์ใน WHERE/JOIN/ORDER BY | ✅ | `InitSchema:48` `idx_orders_product` · PK · `uq_user_product_order` | |
| 67 | ใช้ `select:[...]` ดึงเฉพาะคอลัมน์ที่ใช้ | ❌ | `products.service.ts:231-236` ดึงทุกคอลัมน์รวม `description` | ช่องว่างจริง ผลกระทบต่ำ (ตารางแคบ) |
| 68 | Paginate ทุก list endpoint | ✅ | `products.service.ts:231-236` `skip`/`take` · `list-products.dto.ts:5` clamp ที่ 100 | |
| 69 | Keyset/cursor สำหรับ offset ลึก | ⚪ | catalog เล็กมาก | |
| 70 | แก้ N+1 ด้วย `relations:[...]` | ⚪ | entity ไม่มี relation ต่อกัน | |
| 71 | Eager-load ลึกๆ ทำให้ cartesian blowup | ⚪ | ไม่มี relation | |
| 72 | SQL logging ใน dev · `pg_stat_statements` + `EXPLAIN ANALYZE` ใน prod | 🟡 | `database.config.ts:62` `logging:['error']` เท่านั้น | ไม่มี `pg_stat_statements` |
| 73 | `onDelete:'CASCADE'` อันตราย | ⚪ | FK ไม่มี `ON DELETE` และไม่มี delete endpoint | |
| 74 | **Pool: `instances × (1+replicas) × poolSize ≤ 80% max_connections`** | ✅ | `database.config.ts:12-14` (คอมเมนต์ใช้สูตร**ที่ถูก**) · 6×8 = 48/100 | **โค้ดแก้ errata #5 ของสไลด์ไว้ในคอมเมนต์ตัวเอง** |
| 75 | `(cores*2)+spindles` ใช้ size ตัว DB server ไม่ใช่ app pool | ✅ | `database.config.ts` แยกสองเรื่องนี้ชัดเจน | |
| 76 | Map PG error code → HTTP (23505→409 ฯลฯ) | 🟡 | `23505` มี (`orders.processor.ts:94-100`) แต่ map เป็นผลลัพธ์ในคิว ไม่ใช่ HTTP เพราะ confirm เป็น async | `23503/23502/23514` ไม่มี — และ**เข้าไม่ถึงโดยดีไซน์** |
| 77 | `synchronize:true, dropSchema:true` ในเทสต์ = ไม่เคยทดสอบ migration *(errata #5)* | ⚪ | ไม่มี integration test ให้เกิดปัญหานี้ | |
| 78 | TypeORM ไม่มี nested transaction จริง *(errata #6)* | ✅ | ไม่มี nested `dataSource.transaction()` เลย | หลบ errata สำเร็จ |
| 79 | `manager.debit()/credit()` เป็น pseudo-code *(errata #2)* | ⚪ | ไม่ใช่เคส bank transfer | |
| 80 | `findOne({where:{id}})` (0.3) ไม่ใช่ `findOne(id)` (0.2) *(errata #7)* | ✅ | ไม่มี `findOne(id)` เลย · `orders.processor.ts:60` มีคอมเมนต์**เตือน**ไม่ให้ใช้ | หลบ errata สำเร็จ |

### B04 — Redis: Caching & Atomic Ops

> บทนี้คือบทที่เราใช้เยอะที่สุด (24/32 ข้อ) และเป็นแกนของคำตอบเรื่อง `remainingStock`

| # | กฎ | สถานะ | หลักฐาน (`file:line`) | หมายเหตุ |
| :--- | :--- | :---: | :--- | :--- |
| 81 | แคชข้อมูล read-heavy / query แพง / กึ่งคงที่ | ✅ | `products.service.ts:88` · `redis.service.ts:269-279` | แคชเฉพาะ catalog metadata |
| 82 | **ห้ามแคชข้อมูล write-heavy / ต้องการความสดจริง** | ✅ | `products.service.ts:94-96` · `redis.service.ts:257-266` (คอมเมนต์ "ห้ามแคชผลลัพธ์") | `remainingStock` **ไม่เคยอยู่ในแคช** — นี่คือหัวใจของดีไซน์ |
| 83 | Hit ratio > 80% · monitor `keyspace_hits/misses` | ✅ | `scripts/cache-stats.sh:26-32` · `integrity.service.ts:339-356` · `observability.controller.ts:142-146` | เปิดดูได้ 3 ทาง |
| 84 | **TTL ทุก key** (key ไม่มี TTL = memory leak) | ✅ | `redis.service.ts:296` (`setex`), `:299` (`expire` บน index set), `:356-362` (`SET … PX … NX`) | `bought:*` จงใจไม่มี TTL แต่อยู่บน `redis-data` (`noeviction`) ไม่ใช่ LRU cache |
| 85 | ตั้ง TTL ตามความผันผวนของข้อมูล | ✅ | `docker-compose.yml:237-238` `CATALOG_CACHE_TTL_BASE=30` | อยู่ในชั้น "30s–5m volatile" |
| 86 | **TTL jitter กัน cache avalanche** | ✅ | `redis.service.ts:289-291` `ttl = base + random(0..jitter)` | `JITTER=30` |
| 87 | `try/catch` ทุกการเรียก cache + fallback ไป DB | ✅ | `redis.service.ts:269-279` (read), `:293-305` (write), `products.service.ts:148-167` (stock overlay) | Redis คือ optimization ไม่ใช่ SPOF |
| 88 | Key builder รวมศูนย์ + namespace | ✅ | `redis.keys.ts:1-51` | ห้ามต่อสตริงเอง |
| 89 | Invalidate ทั้ง dependency chain ตอน write | ✅ | `orders.processor.ts:160` หลัง commit | |
| 90 | TTL คือ safety net — ห้ามพึ่ง invalidation อย่างเดียว | ✅ | `redis.service.ts:311-317` | |
| 91 | แคชเฉพาะ hot data | ✅ | แคชแค่ catalog page | |
| 92 | ค่า > 1MB ต้องแตก/บีบ | ⚪ | catalog page เป็น JSON เล็ก | |
| 93 | **Cache-aside เป็น default** | ✅ | `products.service.ts:86-92` (read→miss→DB→populate) | |
| 94 | Write-through | ⚪ | ไม่มี path ที่ต้องการ cache สดทันทีหลัง write | |
| 95 | Write-behind เฉพาะ counter/analytics ห้ามใช้กับ payment | ✅ | `metrics.service.ts:83-98` (`inc()` buffer ใน RAM) · `:141-171` (flush ทุก 1 วิ) | ใช้ตรงจุดที่บทเรียนบอกว่าปลอดภัยพอดี |
| 96 | ลำดับ **update DB → แล้วค่อย DEL cache** | ✅ | `orders.processor.ts:86-87` commit → `:160` invalidate | |
| 97 | Delayed double-delete กัน stale read | 🟡 | `redis.service.ts:311-317` | ไม่ได้ทำ — ใช้ TTL สั้น (30–60s) แทน ซึ่งบทเรียนรับรองว่าใช้ได้ |
| 98 | **`INCR`/`DECR` แทน get→+1→set** | ✅ | `gatekeeper.lua` (`DECR`) · `compensate*.lua` (`INCR`) · `metrics.service.ts:148` (`hincrby`) | counter ทุกตัว atomic |
| 99 | Distributed lock `SET key <token> EX ttl NX` | ✅ | `gatekeeper.lua` (`SET KEYS[1] ARGV[2] 'PX' ARGV[1]`) | รวมอยู่ในสคริปต์เดียวกับการเช็คสต็อก |
| 100 | Lock ต้องมี TTL (worker ตายแล้วจะไม่ล็อกค้างตลอดกาล) | ✅ | `docker-compose.yml:239` `ORDER_LOCK_TTL_MS=30000` | |
| 101 | Token ไม่ซ้ำต่อผู้ถือ lock | ✅ | `orders.service.ts:79` `randomUUID()` ทุกคำขอ | |
| 102 | **ปล่อย lock ด้วย Lua compare-and-delete** *(errata #5 บอกว่าสไลด์ทำผิด)* | ✅ | `release-lock.lua` · `compensate.lua` · `compensate-if-reserved.lua` · `compensate-once.lua` — `GET==ARGV` ก่อน `DEL` ทุกตัว | **ไม่มี `DEL` เปล่าบน lock key ที่ไหนเลย** |
| 103 | `try/finally` รอบ critical section | 🟡 | `orders.processor.ts:140-144` (คืน queryRunner ใน `finally`) · การปล่อย lock (`:149-160`) อยู่ใน `try/catch` ที่กลืน error แล้วปล่อยให้ TTL เก็บกวาด | เจตนา (มีคอมเมนต์กำกับ) แต่ไม่ใช่ `finally` ตามตัวอักษร |
| 104 | เช็ค `if (token)` ก่อน release *(errata #6)* | ⚪ | `requestToken` ถูก assign แบบ synchronous เสมอ | failure mode ในสไลด์เกิดไม่ได้ที่นี่ |
| 105 | Long job ต้องมี heartbeat / `extendLock` | ⚪ | job เป็น UPDATE สั้นๆ · lock TTL 30s เกินพอ | |
| 106 | **Lock เป็น best-effort — ความถูกต้องต้องมาจาก idempotency + DB constraint** | ✅ | `orders.processor.ts:69-74` (atomic UPDATE) · `:94-100` (23505) · `order.entity.ts:9` (`@Unique`) · `compensate-once.lua` | ดีไซน์ 4 ชั้นตรงตามที่บทเรียนแนะนำเป๊ะ |
| 107 | **ห้าม `KEYS` — ใช้ `SCAN` หรือ index SET** *(errata #1)* | ✅ | `redis.service.ts:297-298,374-378` (`SADD`/`SMEMBERS`) · `redis/redis-cache.conf:19` **`rename-command KEYS ""`** | บังคับทั้งระดับโค้ดและระดับ server config |
| 108 | ตั้ง `maxmemory` + policy ให้ตรงชนิดข้อมูล | ✅ | `redis-cache.conf:11-12` (256mb, `allkeys-lru`) · `redis-data.conf:13-14` (512mb, `noeviction`) | |
| 109 | **ห้ามเอา queue ไปอยู่ Redis ตัวเดียวกับ cache ที่ LRU evict** | ✅ | แยก 2 container จริง (`redis-cache` / `redis-data`) | ถ้ารวมกัน LRU จะลบ job ทิ้ง |
| 110 | Monitor hit ratio / memory / `evicted_keys` / `SLOWLOG` | 🟡 | 3 ตัวแรกมีครบ (`observability.controller.ts:135-147`) | **ไม่มี `SLOWLOG`** |
| 111 | Reuse connection / pool | ✅ | `redis.module.ts:59-91` singleton client + `enableAutoPipelining: true` | |
| 112 | วางแผน Redis HA (Sentinel/managed) | ❌ | instance เดียวต่อ role | ตัดออกโดยเจตนาตามขอบเขตวิชา · บันทึกใน `CLAUDE.md` §0.1 |

### B05 — Async Communication (BullMQ)

| # | กฎ | สถานะ | หลักฐาน (`file:line`) | หมายเหตุ |
| :--- | :--- | :---: | :--- | :--- |
| 113 | งาน > 1 วิ หรือไม่ต้องการผลทันที → async | ✅ | `orders.controller.ts:34-36` ตอบ 202 ทันที · DB write อยู่ที่ `orders.processor.ts` | |
| 114 | Pub/Sub เฉพาะ broadcast ที่หายได้ | ❌ | `grep publish/subscribe` ใน `src/` = 0 | เราใช้ `SET NX PX` throttle แทน (`redis.service.ts:354-368`) ซึ่ง**เชื่อถือได้กว่า** — แต่แปลว่าไม่มีตัวอย่าง Pub/Sub ให้โชว์ในรายงาน |
| 115 | ห้ามเอา side-effecting logic ไปไว้ใน Pub/Sub handler | ⚪ | ไม่มี Pub/Sub | |
| 116 | **ใช้ BullMQ ไม่ใช่ Bull** *(errata #1)* | ✅ | `bullmq.module.ts:1-2` `@nestjs/bullmq`+`bullmq` ล้วน · `orders.processor.ts:1` `WorkerHost`/`@OnWorkerEvent` | หลบ errata สำเร็จ |
| 117 | **At-least-once ⇒ handler ต้อง idempotent** | ✅ | `orders.processor.ts:94-100` (unique violation ⇒ `already_confirmed`) · `compensate-once.lua` | |
| 118 | Retry + exponential backoff | ✅ | `orders.service.ts:152-153` `attempts:3, backoff:{exponential,200}` | |
| 119 | Backoff ต้องมี **jitter** *(บทเรียนเองบอกว่าสไลด์ลืม)* | ❌ | `orders.service.ts:153` · `bullmq.module.ts:34` | **ไม่มี jitter** — ช่องว่างเดียวกับที่บทเรียนเตือน ความเสี่ยงต่ำเพราะ job มีแค่ ~50 |
| 120 | แยก transient / permanent failure | ✅ | `orders.processor.ts:108-122` (`SoldOutError` ⇒ `return`) · `:94-100` | |
| 121 | `removeOnFail:false` เก็บหลักฐาน | 🟡 | `bullmq.module.ts:35-36` default `false` **แต่** `orders.service.ts:155` override เป็น `{count:5000}` | ขัดกับ default ของตัวเอง แต่ยังเก็บ 5,000 job ล่าสุด |
| 122 | **DLQ + alert ตอน permanent failure** | ❌ | `grep -i DLQ` = 0 | job ล้มไปกองใน `failed` list เฉยๆ ไม่มีใครเตือน · ช่องว่างจริง |
| 123 | Job timeout ด้วย `Promise.race` (BullMQ ไม่มี `timeout` option) *(errata #2)* | ❌ | ไม่มี `Promise.race` ใน processor | พึ่ง `commandTimeout` ของ ioredis + timeout ของ DB driver ทางอ้อม |
| 124 | Graceful worker shutdown | ✅ | `main.ts:56` `enableShutdownHooks()` · `redis.module.ts:99-110` `onModuleDestroy` | ไม่งั้น deploy ทีไรเกิด stalled job |
| 125 | Concurrency ให้ตรงชนิดงาน | ✅ | `orders.processor.ts:39-40` อ่านจาก env (=1) · เหตุผลอยู่ใน `docker-compose.yml:240-243` | ตรงชั้น "CPU/DB-bound: 1-2" |
| 126 | Rate limiter ให้ตรงโควตา provider | ⚪ | ไม่เรียก external provider เลย | |
| 127 | Priority queue | ⚪ | มี job ชนิดเดียว | |
| 128 | Delayed job | ⚪ | ไม่มีเคส trial-expiry/reminder | |
| 129 | แยก queue ต่อชนิดงาน | ⚪ | มีงานชนิดเดียว | |
| 130 | Payload เป็น reference ห้ามใส่ binary | ✅ | `orders.service.ts:20-31` `OrderJobData` มีแต่สตริง | job อยู่ใน RAM |
| 131 | แยก Redis ของ queue กับ cache | ✅ | `bullmq.module.ts:8-9` (คอมเมนต์อธิบายชัด) | ซ้ำกับ B04-109 |
| 132 | เปิด AOF บน Redis ที่เก็บ queue | ✅ | `redis-data.conf:17-19` `appendonly yes` `appendfsync everysec` | |
| 133 | **Bull-Board ต้องมี auth คลุม** *(errata #10)* | ✅ | `main.ts:51-53` · `bull-board.service.ts:90-97` (`basicAuth`) | ⚠️ แต่รหัส hardcode — ดู §5 |
| 134 | Monitor queue depth / lag / stalled count | 🟡 | `integrity.service.ts:283-307` มี waiting/active/completed/failed/delayed | **ไม่มี queue lag (อายุ job เก่าสุด) และ stalled count** |

### B06 — Scaling, Load Balancing & Observability

| # | กฎ | สถานะ | หลักฐาน (`file:line`) | หมายเหตุ |
| :--- | :--- | :---: | :--- | :--- |
| 135 | **ห้ามมี session/cache/counter ใน RAM ของ process** | ✅ | `products.service.ts:66-69` (single-flight เท่านั้น) · `metrics.service.ts:40-44` (buffer ≤1 วิ) | ทั้งสองไม่ใช่ state ที่ต้องแชร์ |
| 136 | JWT สำหรับ stateless auth | ✅ | `jwt.strategy.ts` · `orders.controller.ts:48` อ่าน `request.user.sub` | ไม่มี session ใน Redis |
| 137 | JWT เพิกถอนไม่ได้ ต้องมี TTL สั้น + refresh *(errata #8)* | ⚪ | `JWT_EXPIRES_IN=15m` | รับรู้ข้อจำกัด ไม่ได้แก้ — พอสำหรับขอบเขตวิชา |
| 138 | ทุก instance รันเวอร์ชันเดียวกัน | ✅ | ทั้ง 6 build จาก image เดียว | |
| 139 | Graceful shutdown (หยุดรับ → drain → ปิด) | ✅ | `main.ts:56` | ไม่งั้น deploy ทีไรได้ 502 |
| 140 | **`instances × (1+replicas) × poolSize ≤ 80% max_connections`** *(errata #5 ของสไลด์นับผิด)* | ✅ | `database.config.ts:12-14` ใช้สูตร**ที่ถูก** · 6×8 = 48/100 = 48% | โค้ดแก้ errata ไว้ในคอมเมนต์ตัวเอง |
| 141 | `least_conn` สำหรับ request ที่ยาวไม่เท่ากัน | ✅ | `nginx.conf:63` `least_conn;` | read กับ write latency ต่างกันมาก |
| 142 | เลี่ยง `ip_hash` / sticky session | ✅ | ไม่มี `ip_hash` ใน upstream block | สอดคล้องกับ stateless |
| 143 | ตั้ง `max_fails` + `fail_timeout` | ✅* | `nginx.conf:64-69` `max_fails=0` ทั้ง 6 | **จงใจตั้งเป็น 0** หลังเหตุการณ์ 2026-08-27 ที่ `max_fails=3` ขยายคำขอช้า 1 ใบเป็นการตัด backend ทิ้งทั้งหมด → 502 จำนวน 115,005 ครั้ง |
| 144 | ตั้ง proxy timeout ให้ครบ | ✅ | `nginx.conf:92-94` connect 5s / send 10s / read 10s | |
| 145 | Forward `X-Real-IP` / `X-Forwarded-For` | ✅ | `nginx.conf:83-85` | |
| 146 | Nginx ตัวเดียวเป็น SPOF — ควรมี 2 + VIP *(errata #7)* | ❌ | `docker-compose.yml:582-617` มี nginx ตัวเดียว | รับรู้แล้ว ตัดออกตามขอบเขต — **ควรพูดถึงในหัวข้อวิเคราะห์คอขวดของรายงาน** |
| 147 | Replica รับ read 80-90% | ✅ | `database.config.ts:31-49` `replication:{master,slaves}`, `defaultMode:'slave'` | |
| 148 | **Read-your-writes ต้องยิง primary** | ✅ | `orders.processor.ts:62` `createQueryRunner('master')` | ถ้าอ่าน replica จะเจอ lag → race condition |
| 149 | Monitor replication lag | ✅ | `integrity.service.ts:309-332` (`pg_last_xact_replay_timestamp()`) → `/admin/metrics` | |
| 150 | ซ้อม failover (Patroni/repmgr) | ❌ | ไม่มี | ตัดตามขอบเขต |
| 151 | `wal_level=replica` · `max_wal_senders` · replication slot · role `replicator` เฉพาะ *(errata #9)* | ✅ | `docker-compose.yml:62-71` · `scripts/replica-entrypoint.sh:22` ใช้ `--username="$REPL_USER"` | **หลบความไม่สอดคล้องของสไลด์ที่ใช้ `-U postgres`** |
| 152 | Monitor `pg_replication_slots` กัน WAL ท่วมดิสก์ *(errata #6)* | 🟡 | `docker-compose.yml:71` `max_slot_wal_keep_size=1GB` | มีเพดานกันไว้ แต่ไม่มี monitor/alert |
| 153 | **แยก `/health/live` (ถูก) กับ `/health/ready` (เช็ค deps)** *(errata #3 — สไลด์ใช้ตัวเดียว)* | ✅ | `health.controller.ts:38-45` vs `:63-72` | หลบ errata สำเร็จ |
| 154 | **Liveness ห้ามเช็ค DB** | ✅ | `health.controller.ts:32-37` (คอมเมนต์อธิบายความเสี่ยง cascading restart) | container healthcheck ยิง `/health/live` เท่านั้น |
| 155 | Structured JSON log + correlation id ส่งต่อถึง worker | ✅ | `logger.module.ts` (pino) · `correlation-id.middleware.ts` · `orders.service.ts:22-23` ใส่ใน job payload | trace ข้ามไปถึง worker ได้ |
| 156 | ห้าม log password/token/PII | ✅ | `logger.module.ts:93-108` `redact.paths` ครอบ `authorization`, `password`, `token`, `secret`, `JWT_SECRET` | |
| 157 | Level ขั้นต่ำ `info` ใน prod | ✅ | `logger.module.ts:40` | |
| 158 | Centralized logging (ELK/CloudWatch) | ❌ | มีแต่ stdout + `json-file` driver | รับได้สำหรับ deployment ระดับวิชา |
| 159 | **วัด p50/p95/p99 ไม่ใช่ค่าเฉลี่ย** | ✅ | `loadtest.js:369-372,387` · threshold gate ที่ `p(95)` (`:93-94`) | |
| 160 | Load test ด้วย k6 (ramp → peak → ramp down) | ✅ | `loadtest.js` + ผลรันจริงหลายรอบใน `handoff_log/` | |
| 161 | Metrics ครบ: request rate / error rate / percentile / queue depth / hit ratio / replication lag | ✅ | `observability.controller.ts` (Prometheus) — stock drift, queue counts, replication lag, redis hit ratio, event-loop p99, RSS | |
| 162 | Sample log ใน path ที่ volume สูง | ✅ | `logging.interceptor.ts:29,64-66` `READ_LOG_SAMPLE_RATE=100` (sample เฉพาะ GET ที่สำเร็จ) | |

---

## 4. 🚫 Slide-Errata — โค้ดในสไลด์ที่ผิด และเราหลบได้ครบไหม

> `For_agent/*.md` รวบรวมโค้ดในสไลด์ต้นฉบับที่ **ผิดจริง** ไว้ 43 ข้อ
> ตารางนี้ตอบว่า **เราลอกของผิดมาหรือเปล่า** — คำตอบคือ **ไม่มีสักข้อ** และหลายข้อโค้ดเรา *แก้ให้ถูก* ไว้ในคอมเมนต์ตัวเองด้วย

| errata | สไลด์ผิดยังไง | เราทำถูกที่ไหน |
| :--- | :--- | :--- |
| **B01#1** | builder ไม่มี `npm run build` → multi-stage ไม่ได้อะไรเลย | `Dockerfile:24` มี `RUN pnpm run build` · final copy แค่ `dist` (`:42`) |
| **B01#2** | อ้าง `COPY --from=builder` แต่ไม่ได้นิยาม stage นั้น → build พัง | มี 2 stage ชื่อถูกต้อง อ้างถึงถูก (`Dockerfile:7,28,42`) |
| **B01#3** | `--only=production` deprecated | ใช้ pnpm — `Dockerfile:39` `pnpm install --prod` |
| **B01#4** | `version: '3.8'` obsolete | ไม่มี key `version:` เลย |
| **B01#5** | แนะนำ `--env-file` ขัดกับสไลด์ secrets-manager ของตัวเอง | ไม่ได้ใช้ทั้งสองแบบ |
| **B02#1** | บอกว่า singleton = "1 instance ต่อ module" (ผิด — ต่อ DI container) | ไม่มีโค้ดไหนพึ่งความเข้าใจผิดนี้ |
| **B02#2** | `let mockRepo: any` | `jest.Mocked<…>` ทุกที่ (`orders.service.spec.ts:14-17`) |
| **B02#3** | โชว์ `private cache = new Map()` ใน singleton ว่ารับได้ | in-flight map ลบทิ้งทุกคำขอ · state จริงอยู่บน Redis |
| **B02#4** | `jest.spyOn` บน class ที่กำลังเทสต์ | spy ที่ `Logger.prototype` (dep) — `products.service.spec.ts:134` |
| **B03#1** | optimistic lock เทียบ version ด้วยมือ → ยัง TOCTOU | `orders.processor.ts:69-77` conditional update + `affected===0` |
| **B03#2** | `manager.debit()/credit()` ไม่ใช่ method จริง | ไม่ใช่เคสนี้ |
| **B03#3** | deadlock retry ใช้ `sleep(100)` คงที่ | 🟡 เราใช้ exponential **แต่ยังไม่มี jitter** (ดู §5) |
| **B03#4** | อ้างว่า `pessimistic_write` บล็อก plain SELECT (ผิดบน PG MVCC) | ไม่ได้ใช้ `FOR UPDATE` |
| **B03#5** | เทสต์ใช้ `synchronize:true, dropSchema:true` → ไม่เคยทดสอบ migration | ไม่มี integration test ให้เกิดปัญหา |
| **B03#6** | TypeORM ไม่มี nested transaction จริง | ไม่มี nested transaction |
| **B03#7** | B04 ถอยกลับไปใช้ API 0.2 `findOne(id)` | ไม่มี `findOne(id)` · `orders.processor.ts:60` มีคอมเมนต์เตือน |
| **B04#1** | ตัวอย่าง invalidation เรียก `redis.keys(pattern)` ทั้งที่คอมเมนต์ตัวเองบอกให้ใช้ SCAN | index SET (`SADD`/`SMEMBERS`) + **`rename-command KEYS ""`** ที่ `redis-cache.conf:19` |
| **B04#2** | `cache.set(k,v,{nx:true})` — `@nestjs/cache-manager` ไม่มี `nx` | ใช้ ioredis ดิบ `set(k,v,'PX',ttl,'NX')` (`redis.service.ts:356-362`) |
| **B04#3** | `cache.ttl(key)` ไม่มีจริง | ไม่ได้ทำ early-refresh |
| **B04#4** | แก้ stampede ด้วย recursion ไม่จำกัดชั้น | single-flight promise memoization (`products.service.ts:69,207-223`) ไม่มี recursion |
| **B04#5** | ปล่อย lock ด้วย `cache.del()` ไม่เทียบ token | Lua compare-and-delete ทั้ง 4 สคริปต์ |
| **B04#6** | `finally { release(token) }` ที่ `token` อาจเป็น null | `requestToken` assign แบบ synchronous เสมอ |
| **B04#7** | `cache.set` อยู่ใน try เดียวกับ DB read → cache พังแล้ว query ซ้ำ | `setCatalogPage` มี try/catch ของตัวเอง คืน void |
| **B04#8** | `userRepo.findOne(id)` API 0.2 | ใช้ `createQueryBuilder()` |
| **B04#9** | ไม่พูดถึง Redis HA เลย | ❌ เรามีช่องว่างเดียวกัน — แต่**บันทึกไว้ชัด** ไม่ได้พลาดเงียบๆ |
| **B05#1** | ติดตั้ง `@nestjs/bull bullmq` แต่ `import from 'bull'` | `@nestjs/bullmq` + `bullmq` ล้วน |
| **B05#2** | job option `timeout` ไม่มีใน BullMQ | ไม่ได้ใช้ (แต่ก็ยังไม่มี `Promise.race` — ดู §5) |
| **B05#3** | `job.progress(n)` เป็นของ Bull | ไม่ได้ใช้ |
| **B05#4** | `queue.on('completed')` ใช้ไม่ได้บน BullMQ Queue | ใช้ `@OnWorkerEvent()` |
| **B05#5** | สไลด์เคลมทั้ง at-least-once และ exactly-once ในหน้าติดกัน | โค้ดและคอมเมนต์ยึด at-least-once เสมอ |
| **B05#6** | push DLQ แล้วยัง `throw` ต่อ → DLQ ซ้ำ | ไม่มี DLQ (จึงเกิดไม่ได้ — แต่ก็พิสูจน์วิธีแก้ไม่ได้เช่นกัน) |
| **B05#7** | วาง `limiter` ที่ `registerQueue` (จริงๆ เป็น Worker option) | ไม่ได้ใช้ limiter |
| **B05#8** | เทสต์คาด `success===false` แต่ processor `throw` ทุกกรณี | `orders.processor.ts:108-122,94-100` `return` จริงบน permanent failure |
| **B05#9** | ตัวอย่าง publisher ใช้ Prisma ทั้งที่คอร์สใช้ TypeORM | TypeORM ตลอด |
| **B05#10** | Bull Board mount ที่ `/admin/queues` ไม่มี auth | `main.ts:51-53` Basic Auth ครอบ `/admin` ทั้ง prefix |
| **B06#1** | อ้างว่า "Docker mark unhealthy → Nginx หยุด route" (**เท็จ**) | ไม่ได้พึ่ง — nginx ใช้ passive `max_fails` (ตั้ง 0 โดยเจตนา) ไม่เคยอ่าน Docker health |
| **B06#2** | `HEALTHCHECK` เปลี่ยนแค่สถานะใน `docker ps` | เข้าใจตรงกัน · healthcheck ใช้คู่กับ `condition: service_healthy` ของ compose เท่านั้น |
| **B06#3** | ใช้ `/health` ตัวเดียวทั้ง liveness/readiness | แยกจริง (`health.controller.ts:38-45` vs `:63-72`) |
| **B06#4** | เคลมว่า TypeORM ตรวจ replica ล้มแล้วสลับให้เอง (เกินจริง) | ไม่ได้ออกแบบโดยพึ่งสิ่งนี้ — write path บังคับ `'master'` ตรงๆ |
| **B06#5** | สูตร connection ลืมนับ pool ต่อ replica → นับต่ำกว่าจริงหลายเท่า | `database.config.ts:12-14` ใช้สูตรที่ถูก |
| **B06#6** | ไม่พูดถึง replication slot ทำ WAL ท่วมดิสก์ | `max_slot_wal_keep_size=1GB` (แต่ไม่มี monitor — ดู §5) |
| **B06#7** | ไดอะแกรมมี Nginx ตัวเดียวทั้งที่เคลม "no SPOF" | ❌ เรามีช่องว่างเดียวกัน — **แต่ไม่เคลมว่าไม่มี SPOF** |
| **B06#8** | เสนอ JWT ว่า "zero DB query" โดยไม่พูดข้อจำกัดเรื่องเพิกถอน | รับรู้ · ใช้ TTL 15 นาที |
| **B06#9** | compose replica ใช้ `pg_basebackup -U postgres` ขัดกับ role `replicator` ที่สร้างเอง | `replica-entrypoint.sh:22` ใช้ `--username="$REPL_USER"` |
| **B06#10** | "3 instance = 2.8x RPS" เป็นภาพประกอบ ไม่ใช่การรับประกัน | เราวัดเอง ไม่ได้อ้างตัวเลขของสไลด์ |

**สรุป: 43/43 ไม่ได้ลอกของผิดมาสักข้อ** · 3 ข้อ (B04#9, B06#7, B03#3) เรามีช่องว่าง**เดียวกัน**กับสไลด์ แต่เป็นการรับรู้และบันทึกไว้ ไม่ใช่พลาดเงียบ

---

## 5. ⚠️ ช่องว่างที่ควรพูดถึงในรายงาน (เรียงตามน้ำหนัก)

> อย่าเขียนรายงานว่า "ทำครบทุกข้อ" — ของพวกนี้อาจารย์ถามได้ และการตอบได้เองว่า *รู้ตัวและเลือกแล้ว* ได้คะแนนมากกว่าการไม่รู้

| # | ช่องว่าง | ผลกระทบ | สถานะ |
| :--- | :--- | :--- | :--- |
| 1 | 🔴 **`connect()`/`startTransaction()` อยู่นอก `try`** (`orders.processor.ts:62-64`, `try` เริ่ม `:67`) | **path เดียวในระบบที่หักสต็อกแล้วไม่มีทางชดเชยเลย** — ละเมิด invariant `CLAUDE.md` §4 ข้อ 6 · primary สะดุดตรงนี้ = counter ค้างที่ 1, orders 49/50, **ตก §9.3 ข้อ 4** | ยังไม่แก้ (write path → ต้องยิง k6 ก่อนตาม §7 ข้อ 5) · แก้ = ย้าย 2 บรรทัดเข้าใน `try` |
| 2 | ❌ **ไม่มี e2e test เลย** (B02-44) | ทั้ง 4 เส้นทางพิสูจน์ได้ทางเดียวคือยิงจริง · SQL correctness ไม่มี CI คุม | เปิดอยู่ · เป็น deliverable ที่ยังขาด |
| 3 | 🟠 **Bull-Board รหัส `admin`/`admin` hardcode** ใน `docker-compose.yml` ทั้ง 6 service | แก้ `.env` ไม่มีผล · `env.validation.ts:133,137` ตั้ง default `'admin'` ทำให้ `getOrThrow()` ไม่มีวัน throw · เปิดสู่ LAN ผ่าน `:8080` ที่ต้องเปิดให้กลุ่มอื่นยิง | เปิดอยู่ |
| 4 | ❌ **ไม่มี DLQ + ไม่มี alert** (B05-122) | job ที่ล้มถาวรกองเงียบใน `failed` list | เปิดอยู่ |
| 5 | 🔴 **debounce ซ้อน 3 ชั้นทำให้ flush หลุด** (`redis.service.ts:322-334`) | ผ่านโควตา local แต่แพ้ distributed throttle → `return` โดยไม่จอง trailing = การล้างแคชหายไปเฉยๆ | เปิดอยู่ · ผลกระทบจริงจำกัด (ไม่มี endpoint แก้สินค้า · `remainingStock` ไม่ได้แคช) |
| 6 | 🔴 **`stock_compensation_failures_total` ฝั่ง worker เชื่อไม่ได้** (`orders.processor.ts:126`) | `metrics.inc(STOCK_COMPENSATED)` บวก**ก่อน** `await compensateOnce()` ที่ไม่มี try/catch → ชดเชยล้มเหลวถูกนับเป็นสำเร็จ · **ค่าศูนย์ของ metric นี้ไม่ได้แปลว่าไม่มีปัญหา** | เปิดอยู่ · ตัวจับจริงคือ `drift` ใน `/admin/insights` |
| 7 | 🔴 **`MetricsService.flush()` กลืน error รายคำสั่ง** (`metrics.service.ts:141-172`) | ioredis `pipeline.exec()` **resolve ไม่ reject** ตอน command error → redis-data เต็ม = ตัวนับค้างเงียบในจังหวะที่ต้องการมันที่สุด | เปิดอยู่ |
| 8 | ❌ **ไม่มี jitter บน retry backoff** (B03-60, B05-119) | ตรงกับ errata B03#3/B05#9 ที่บทเรียนเตือนเอง | ความเสี่ยงต่ำ (job ~50 ใบ) |
| 9 | ❌ **Nginx ตัวเดียว = SPOF** (B06-146) | ควรอยู่ในหัวข้อ "วิเคราะห์คอขวด" ของรายงาน | ตัดตามขอบเขต |
| 10 | ❌ **Redis ไม่มี HA** (B04-112) · **ไม่มี centralized logging** (B06-158) · **ไม่มี CI/SHA tag** (B01-7) | ขอบเขตวิชา | ตัดโดยเจตนา |
| 11 | 🟡 **`package-lock.json` ถูก track ใน git** ทั้งที่ `CLAUDE.md` §1/§6 ห้าม npm เด็ดขาด | มีคนรัน `npm install` · lockfile 2 ตัวขัดกันได้ | **ต้องตัดสินใจ** — ดูข้อเสนอท้ายเอกสาร |
| 12 | 🟡 `.env.example:56` ยังเขียน `WORKER_CONCURRENCY=5` และคอมเมนต์ `:35` ยังคิดจาก "3 instances" | ของจริงคือ `1` และ 6 instances | **ต้องตัดสินใจ** (แก้ config ติด `CLAUDE.md` §8) |
| 13 | 🟡 ไม่มี `SLOWLOG` · ไม่มี queue-lag/stalled metric · ไม่มี `pids-limit` · ไม่มี `select:[...]` | จุกจิก ผลกระทบต่ำ | เปิดอยู่ |

---

## 6. 🔧 เอกสารที่แก้ไปแล้วรอบนี้ (2026-08-31)

ตรวจด้วย agent 7 ตัวแล้ว spot-verify ซ้ำด้วยมือ — **แตะแต่ `.md` ไม่แตะ `src/` เลย**

| ไฟล์ | แก้อะไร |
| :--- | :--- |
| `docs/Architecture/architecture.md` | §5.4 เคยเขียนว่า debounce "ไม่มีการล้างที่หายไปเฉยๆ" ซึ่ง**เป็นเท็จ** → แก้พร้อมอธิบายกลไกจริง · §6.3 เพิ่มกล่องเตือน `connect()`/`startTransaction()` นอก `try` (เดิมสเปกบรรยายว่าเป็นดีไซน์ที่ตั้งใจ โดยไม่บอกว่ามันคือบั๊กที่รู้ตัวแล้ว) · `main.ts:47`→`:52` (3 จุด) · `products.service.ts:79,135`→`:89-91,158` |
| `docs/Architecture/diagrams.md` | CSPEC แถว "เชื่อมต่อหลุด" และ **Invariant ของ state machine** เคยยืนยันว่า *ทุกเส้นทางที่ผ่าน `Reserved` จบที่ `Confirmed` หรือ `Compensated`* ซึ่ง**ไม่จริง** → เพิ่มข้อยกเว้นที่เป็นบั๊กจริง |
| `docs/Architecture/architecture-rationale.md` | §7 เพิ่ม **blocker (c)** (`connect()` นอก `try`) ที่หายไปจากบัญชี ทั้งที่ทบทวนสถานะวันเดียวกับที่เจอ · ADR-4 เพิ่มหมายเหตุบั๊ก debounce |
| `docs/Codebase/Separate/01-codebase-primer.md` | แก้ `file:line` **23 จุด** ที่เพี้ยน · จำนวนไฟล์ 58→**59** · เพิ่มแถว `database_config/` ที่หายไปจากแผนที่ · แก้ `metrics.service.ts:20`→`insights.page.ts:309` (แถวนี้ขัดกับข้อความของเอกสารเองที่อยู่เหนือขึ้นไป 14 บรรทัด) |
| `docs/Codebase/README.md` | เทสต์ 43/4 suites → **49/5 suites** |
| `CLAUDE.md` | ✅ ปลดรายการ `loadtest.js` threshold ออกจาก "รูที่ยังไม่ปิด" — **แก้ไปแล้วจริง** (`loadtest.js:92-107` มี threshold ครบ 11 ตัว) แต่ตารางยังค้าง · แก้ตารางอ้างอิงที่บอกว่า rationale §7 มี blocker ค้าง 2 ข้อ (จริงๆ ปิดทั้งคู่ เหลือข้อ e2e) |
| `README.md` | "32 tests · ยังไม่เคยรันบน container จริงและยังไม่เคยยิง k6" → **49 tests + §9.3 ผ่านครบ 4 ข้อ** พร้อมรายการที่ยังไม่เคยเกิดขึ้นจริง |

### 🔎 บทเรียนจากรอบตรวจนี้

**เอกสารที่ผิดอันตรายกว่าเอกสารที่ไม่มี** — ของที่เจอรอบนี้ 3 ชิ้นไม่ใช่แค่ "เลขบรรทัดเพี้ยน" แต่เป็น**ข้อความที่ยืนยันสิ่งที่ไม่จริง**:
`architecture.md` §5.4 บอกว่า flush ไม่มีทางหาย · `diagrams.md` บอกว่าทุกเส้นทางถูกชดเชย · `rationale.md` §7 บอกว่า blocker ปิดหมดแล้ว
ทั้งสามอ่านแล้ว**สบายใจผิดๆ** และทำให้คนที่มาอ่านทีหลังเลิกตรวจตรงจุดที่ควรตรวจที่สุด
ตรงข้ามกับ `CLAUDE.md` §0.1 ที่เขียนรูไว้ตรงๆ — ซึ่งเป็นเหตุผลเดียวที่ agent ตามเจอได้

---

## 7. 📦 เชื่อมกับ Deliverables (`CLAUDE.md` §9)

| สิ่งที่ต้องส่ง | เอาจากไหนในเอกสารนี้ |
| :--- | :--- |
| อธิบาย **Cache Invalidation** | §2 ข้อ 1 · B04-86/89/96/97 · และ **ข้อจำกัดที่รู้ตัว** ใน §5 ข้อ 5 |
| อธิบาย **กันสั่งซื้อซ้ำซ้อน** | §2 ข้อ 2/3/4 — 4 ชั้น: `gatekeeper.lua` → BullMQ deterministic `jobId` → atomic SQL → `UNIQUE (user_id, product_id)` |
| อธิบาย **จัดการ `remainingStock` อย่างไร** *(อาจารย์ถามตรงๆ)* | §2 ข้อ 1 — metadata แคช / `remainingStock` อ่านสดจาก `MGET` แล้ว merge ตอน serialize · **B04-82 คือหลักการเบื้องหลัง** |
| **วิเคราะห์คอขวด** | §5 ทั้งหมด — โดยเฉพาะข้อ 9 (Nginx SPOF), ข้อ 1 (compensation gap), ตัวเลขใน §0 |
| Diagram สถาปัตยกรรม | `docs/Architecture/diagrams.md` (แก้ให้ตรงกับโค้ดแล้วรอบนี้) |
| ⚠️ ก่อนทำ PDF | รัน mermaid ทุกบล็อกใน `diagrams.md` ผ่าน parser จริงสักรอบ (`mmdc` หรือ Mermaid Live Editor) — รอบนี้ตรวจด้วยตาเท่านั้น ยังไม่เคย machine-parse |

---

## 8. ❓ 2 ข้อที่ต้องให้เจ้าของโปรเจกต์ตัดสินใจ

ทั้งคู่แตะไฟล์ที่ `CLAUDE.md` §8 บังคับให้ถามก่อน จึง**ยังไม่ได้ทำ**:

1. **`package-lock.json` ที่ถูก track อยู่** — `CLAUDE.md` §1/§6 เขียนว่า "`pnpm` เท่านั้น ห้าม `npm`/`yarn` เด็ดขาด" แต่ไฟล์นี้ถูก commit เข้ามา (ล่าสุดใน `fix_resource_nginx`)
   *ข้อเสนอ*: `git rm --cached package-lock.json` + เพิ่มใน `.gitignore` + เพิ่ม `"packageManager": "pnpm@10.15.0"` ใน `package.json` ให้ corepack บังคับเอง
2. **`.env.example` ที่ล้าสมัย** — `:56` ยังเป็น `WORKER_CONCURRENCY=5` (จริง = `1`) และคอมเมนต์ `:35` ยังคำนวณจาก "3 instances × (1+1) × 10 = 60" (จริง = 6 instances × 8 = 48)

---

> 📌 เอกสารนี้เป็น **ภาพนิ่ง ณ 2026-08-31** · ถ้าแก้โค้ดแล้วเลข `file:line` เพี้ยน ให้ถือว่าโค้ดถูกและกลับมาแก้ที่นี่
> รูที่ยังเปิดอยู่ให้ดู [`CLAUDE.md`](../../CLAUDE.md) §0.1 เป็นบัญชีหลักเสมอ
