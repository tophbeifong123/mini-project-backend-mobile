# Handoff — Backend Implementation (2026-08-26)

**วันที่:** 2026-08-26 · **ผู้บันทึก:** NuiGates (ร่วมกับ Claude Code / Opus 5) · **สถานะ:** โค้ดครบ ผ่าน build/lint/test · merge เข้า `main` แล้ว — **ยังไม่เคยรันบน container และยังไม่เคยยิง k6**
**ขอบเขต:** สร้าง `flash-sale-backend` ทั้งโปรเจกต์จากศูนย์ — NestJS ครบทุก module, docker-compose, nginx, loadtest.js
**ต่อจาก:** [`handoff_architecture-rationale-db-schema_26_08_2026.md`](handoff_architecture-rationale-db-schema_26_08_2026.md) (§6 ข้อ 6 "เริ่มเขียน `src/`")

---

## 1. ตอนนี้อยู่ตรงไหน

- **มีโค้ดจริงแล้ว** — 45 ไฟล์ใน `src/` + config/docker/scripts ที่ root + `loadtest.js`
- `pnpm run build` ✅ · `pnpm run lint` ✅ (0 error 0 warning) · `pnpm run test` ✅ **30 tests / 3 suites**
- **commit + push แล้ว** — 11 commits แตกตามชั้นสถาปัตยกรรม (toolchain → schema → redis → domain → bootstrap → infra → test → docs)
  ทำบน branch `feat/backend-implementation` แล้ว fast-forward เข้า `main` (`9df1f6f..c2d13d4`) จากนั้นลบ branch ทิ้ง
  ตรวจก่อน push: tracked 98 ไฟล์ · `.env` ไม่ติดไป · `6610110189.zip` ไม่ติดไป
- **ยังไม่เคยรัน container และยังไม่เคยยิง k6** — เครื่องนี้ docker daemon ไม่ทำงาน, ไม่มี podman, ไม่มี k6
- คนมารับช่วงต่อจะเจอ: ระบบที่ควรจะ `podman compose up -d` แล้วใช้งานได้เลย **แต่ยังไม่มีใครพิสูจน์**

---

## 2. รอบนี้ทำอะไรไป

1. **อ่าน `6610110189.zip`** (งานเพื่อนวิชาเดียวกัน) เอา *แนวโครง folder* มาใช้ — module folder + `entities/` + `dto/` + `*_config/` แยก + `database/migrations/` — แล้วแมปทับ domain module ของ `architecture.md` §3
2. **แตกงานเป็น 3 agent** ที่ถือไฟล์คนละชุด ไม่ทับกัน โดยเขียน *shared build contract* ให้ทุกตัวอ่านก่อน (module class name, redis key, `RedisService` API, env var, port, dep version) — นี่คือสิ่งที่ทำให้ 3 agent เขียนโค้ดที่ import กันติดโดยไม่ต้องคุยกัน
3. **agent ที่ 4 ตรวจ requirement** เทียบกับ PDF + `CLAUDE.md` §3/§4/§9 แบบ adversarial
4. **แก้ blocker 2 ข้อที่ค้างจากรอบก่อน** (ผู้ใช้อนุมัติ) ทั้งในเอกสารและในโค้ด
5. แก้ของที่ agent ตรวจเจอ + sync เอกสารให้ตรงโค้ด

### ตรวจสอบด้วยอะไร (ค่าที่ได้จริง)

| ตรวจอะไร | คำสั่ง | ผล |
| :--- | :--- | :--- |
| TypeScript | `pnpm run build` | ผ่าน (dist มี `redis/lua/*.lua` ครบ 4 ไฟล์) |
| ESLint | `pnpm run lint` | 0 error 0 warning |
| Unit test | `pnpm run test` | **30 passed / 3 suites** |
| k6 syntax | `node --check loadtest.js` | ผ่าน |
| shell scripts | `sh -n` | ผ่าน |
| `attemptsMade` off-by-one | อ่าน `node_modules/bullmq/dist/cjs/classes/job.js` | BullMQ retry ที่ `attemptsMade + 1 < opts.attempts` → เงื่อนไข final attempt ของเราถูกต้อง |

---

## 3. ตัดสินใจอะไรไปบ้าง เพราะอะไร

| # | ทางเลือก | เลือก | เหตุผล | ใครตัดสิน |
| :-- | :--- | :--- | :--- | :--- |
| 1 | `flash-sale-bacend` (ตามที่พิมพ์) vs `flash-sale-backend` | **flash-sale-backend** | เดาว่าพิมพ์ตก n | user |
| 2 | blocker (a)/(b) แก้เลย vs เขียนตามสเปกเดิม | **แก้เลย** ทั้งโค้ดและ `architecture.md` §6.2/§6.3 | สเปกเดิมทำสต็อกรั่ว | user |
| 3 | เก็บ PG replica vs ตัดทิ้ง | **เก็บ** | ตรงกับเอกสารทั้งชุด + โชว์ในรายงานได้ | user |
| 4 | วางโปรเจกต์ที่ root vs subfolder | **root** | `CLAUDE.md` §9 บังคับ `docker-compose.yml` + `loadtest.js` อยู่ repo เดียวกัน | Claude |
| 5 | `forbidNonWhitelisted: true` vs `whitelist` อย่างเดียว | **whitelist อย่างเดียว** | โจทย์เขียนว่า "ไม่ต้องส่ง quantity" ไม่ใช่ "ห้ามส่ง" — k6 กลุ่มอื่นที่ส่ง `quantity` มาจะโดน 400 ทุก request = **ยิงข้ามกลุ่มไม่ได้** ซึ่งเป็น deliverable ตรงๆ | Claude (จาก finding ของ agent ตรวจ) |
| 6 | `@Max(100)` บน `limit` → 400 vs clamp | **clamp** | โจทย์บอกให้ "ลองเปลี่ยน limit ดู" — `?limit=200` ไม่ควรพัง | Claude |
| 7 | 429 body เป็น string vs object | **object** | 401/409/503 เป็น object หมด มีแต่ 429 ที่เป็น bare string → `r.json('message')` ได้ `undefined` | Claude |
| 8 | migration path `src/migrations/` vs `src/database/migrations/` | **`src/database/migrations/`** | ตามโครง reference project ที่ user สั่งให้ยึด — อัปเดต `CLAUDE.md` §2 และ `architecture.md` §3/§3.1.1 ตามแล้ว | Claude |
| 9 | ปิดรูรั่ว "job เดิมยัง waiting" | **ปิด** ด้วย `requestToken` สุ่มต่อคำขอใน job payload | เป็น exit path เดียวที่หัก stock แล้วไม่คืน = ผิด invariant §4 ข้อ 6 | Claude |
| 10 | k6 นับ 503 เป็น expected status | **เอาออก** | ถ้า stock counter ไม่เคยถูก seed แล้วทุก order ตอบ 503 `http_req_failed` จะยังขึ้น 0% = ตัวเลขในรายงานหลอกตัวเอง | Claude |

---

## 4. ลองแล้วไม่เวิร์ก (ทางตัน)

- **`isolatedModules: true` + `emitDecoratorMetadata`** → `TS1272` ที่ `auth.controller.ts` เพราะ return type เป็น interface
  → **ห้ามแก้ด้วยการ `import type` ทั้งก้อน** — DTO ต้องเป็น value import ไม่งั้น `ValidationPipe` อ่าน `design:paramtypes` ไม่ได้ วิธีที่ถูกคือแยก `import type` เฉพาะ interface
  → และ `isolatedModules` ปิดไม่ได้จริง เพราะ `module: nodenext` บังคับมันกลับมาเอง (ts-jest จะเตือน)
- **`as` cast เพื่อดับ lint** → `eslint --fix` ลบ cast ทิ้งด้วยกฎ `no-unnecessary-type-assertion` **แล้ว error เดิมกลับมา** วนอยู่แบบนั้น
  → เสียเวลาไปพอสมควรกับการคิดว่าไฟล์ถูก Synology Drive sync ทับ **ที่จริงคือ `--fix` ของตัวเอง**
  → วิธีที่ถูก: `dataSource.query<StockRow[]>(...)` (generic) และเทียบ `status >= 500` กับ number ธรรมดา ไม่ใช่ cast enum
- **`await import('../database/data-source')`** ใน `src/seed/*.ts` → `TS2835` เพราะ `moduleResolution: nodenext` บังคับใส่ `.js` → เปลี่ยนเป็น static import แทน
- **รัน container ไม่ได้เลย** — docker daemon ไม่ทำงาน, ไม่มี podman, ไม่มี k6 บนเครื่องนี้
- **`pnpm` ไม่อยู่ใน PATH** — เรียกได้แค่ `corepack pnpm` (ควรรัน `corepack enable` สักครั้ง)

---

## 5. ยังไม่ชัวร์ / สมมติฐานที่ยังไม่พิสูจน์

### ✅ ยืนยันแล้ว (รันจริง)
- build / lint / test 30 ข้อ ผ่าน — มีเอาต์พุตจริง
- `dist/redis/lua/` มีไฟล์ครบ (asset ของ nest-cli ทำงาน)
- เงื่อนไข final attempt ไม่ off-by-one — อ่านโค้ด BullMQ ยืนยัน
- `.env.example` ↔ `docker-compose.yml` ↔ `ConfigService` ชื่อตัวแปรตรงกันหมด (diff แล้ว)

### ❓ ยังไม่ตรวจ — **อ่านตรงนี้ก่อนยิงจริง**
- **ไม่เคย `podman compose up -d`** — ทั้ง replication, healthcheck, entrypoint, seed order ยังเป็นทฤษฎีล้วน
- **`postgres:16-alpine` มี `bash` ไหม** — `replica-entrypoint.sh` และ `primary-init.sh` เป็น `#!/bin/bash` ถ้าไม่มี → replica ไม่ขึ้น → app ทั้ง 3 ตัวค้างที่ `depends_on: service_healthy` → **ทั้งระบบไม่ขึ้นเลย**
  → ตรวจ 5 วินาที: `podman run --rm postgres:16-alpine bash -c 'echo ok'`
- **`podman compose` เคารพ `condition: service_healthy` ไหม** — `podman-compose` (ตัว python) เคยไม่รองรับ ถ้าไม่เคารพ ระบบจะ restart วนอยู่พักหนึ่งแล้วค่อยขึ้นเอง (ไม่ถึงกับพัง แต่**ห้ามใช้ demo สด**)
- **`proxy_read_timeout 5s`** ใน nginx (มาจาก `architecture.md` §2) — ถ้า p99 จริงเกิน 5s จะกลายเป็น 504
- **ตัวเลข performance ทุกตัว** ยังเป็นค่าประมาณเหมือนเดิม — ยังไม่เคยวัด
- **e2e test ไม่มีเลย** — `pnpm run test:e2e` จะ exit non-zero ("no tests found")

### 🕳️ รูที่รู้ตัวและยอมรับ (ไม่ได้ปิด)
- **`23505` ไม่คืนสต็อกใน Redis** — ถูกต้องสำหรับเคสที่ตั้งใจ (retry ของ job ที่ commit ไปแล้ว) แต่ถ้า `bought:` key หายและ job record เดิมถูก evict ไปแล้ว Redis จะต่ำกว่า DB ถาวร
- **`SoldOutError` คืนสต็อก** — ถ้า DB กับ Redis เพี้ยนกันไปแล้ว การคืนตรงนี้ทำให้มัน**ไม่ self-heal** (202 → job ตาย → คืน → วนใหม่)
- **ไม่มี reconciliation ระหว่าง Redis กับ DB** — เหมือนเดิมตั้งแต่รอบที่แล้ว
- **`invalidateCatalogCache()` ล้าง `catalog:page:*` ทั้งหมดทุกครั้งที่มี order สำเร็จ** = 50 ครั้งระหว่าง burst ทำให้ hit ratio ที่วัดได้ต่ำกว่าที่ควรเป็น. ทำตาม `architecture.md` §5.4 ตรงตัว (เอกสารสั่งให้ทำ) แต่เอกสารเองก็บอกว่าจำเป็นเฉพาะตอนข้อมูลสินค้าเปลี่ยนจริง — **ถ้า hit ratio ในรายงานไม่ถึง 90% ให้มาดูตรงนี้ก่อน**
- **`WORKER_CONCURRENCY` อ่านตอน decorate class** จึงไม่เห็นค่าจาก `.env` (เห็นเฉพาะ env จริงของ container) — ปรับจาก `.env` แล้วไม่มีผล

---

## 6. ก้าวถัดไป (เรียงลำดับ)

1. ~~`git add` ทั้งโปรเจกต์แล้ว commit + push~~ ✅ **เสร็จแล้ว** — `main` อยู่ที่ `c2d13d4` (deliverable ข้อ 1 ผ่าน)
2. **หาเครื่องที่มี podman/docker แล้ว `podman compose up -d`** — ตรวจ `bash` ใน `postgres:16-alpine` ก่อนเป็นอย่างแรก
3. **ยิง `k6 run loadtest.js`** แล้วพิสูจน์ Data Integrity ตาม `architecture.md` §9.3 ทั้ง 4 ข้อ (รวมข้อ 4: `GET stock:flash_sale:p-1001` = `"0"`)
4. **เก็บ Cache Hit/Miss** ด้วย `./scripts/cache-stats.sh` (reset ก่อนยิง อ่านหลังยิง)
5. **แคป Bull-Board** ตอน Completed = 50 ไว้ใส่รายงาน
6. **นัดยิงข้ามกลุ่ม** — ให้เขาส่ง k6 ของเขามายิงเรา และเราไปยิงเขา แล้วทำตารางเทียบ
7. **เขียนรายงาน PDF** ตาม `CLAUDE.md` §9 (diagram มีอยู่แล้วใน `diagrams.md`)
8. เก็บงานเสริม: e2e test, ปิดรู `23505`, reconciliation Redis↔DB

---

## 7. ข้อควรระวัง

- ⚠️ **`6610110189.zip` เพิ่มใน `.gitignore` แล้ว** — ห้าม commit (2MB และเป็นงานคนอื่น)
- ⚠️ **`git status` มี `docs/Summary_Best_Practice/agent/` ถูก rename เป็น `For_agent/` แบบ unstaged** — ลิงก์ใน 4 ไฟล์แก้ให้แล้ว แต่การ rename ยังไม่ถูก stage
- ⚠️ **API contract (`CLAUDE.md` §3) ห้ามเปลี่ยน** — ที่แก้รอบนี้เป็นการ**ผ่อนให้ตรง contract มากขึ้น** (เลิก 400 ใส่ field เกิน, 429 เป็น object) ไม่ได้เปลี่ยน path/field/status code
- ⚠️ **ห้ามเปิด `forbidNonWhitelisted` กลับ** — เหตุผลอยู่ในคอมเมนต์ `src/main.ts` แล้ว
- ⚠️ **ห้ามใส่ global prefix ใน `main.ts`** — `/health/*` จะย้ายตามไปด้วยแล้ว healthcheck ของ compose พัง
- ⚠️ **`eslint --fix` จะลบ type assertion ที่มัน "คิดว่าไม่จำเป็น" ทิ้ง** — ถ้าแก้ lint แล้ว error กลับมาเหมือนเดิม อย่าโทษ Synology sync
- ⚠️ **ลำดับ seed สลับไม่ได้**: migration → `seed` → `seed:redis` (Redis คัดลอกค่ามาจาก DB)
- ⚠️ **เครื่องนี้ `pnpm` ต้องเรียกผ่าน `corepack pnpm`** — รัน `corepack enable` สักครั้งจะได้ไม่ต้องพิมพ์

---

## 8. อ้างอิง

| อะไร | ที่ไหน |
| :--- | :--- |
| สเปกหลัก (แก้ §6.2/§6.3 รอบนี้) | `docs/Architecture/architecture.md` |
| บันทึก blocker 2 ข้อ + สถานะ "แก้แล้ว" | `docs/Architecture/architecture-rationale.md` §7 |
| กติกา + invariant 11 ข้อ + deliverables | `CLAUDE.md` |
| วิธีสตาร์ท / วิธี dev นอก container | `README.md` |
| Cache Hit/Miss สำหรับรายงาน | `scripts/cache-stats.sh` |
| k6 | `loadtest.js` |
| handoff รอบก่อน | `handoff_log/handoff_architecture-rationale-db-schema_26_08_2026.md` |
