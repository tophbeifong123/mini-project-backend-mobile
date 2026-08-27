# 🔁 Handoff — ยิง k6 จริงครั้งแรก: เจอสต็อกรั่ว 8 ชิ้น แล้วปิดรู

**วันที่**: 2026-08-27
**ขอบเขต**: รัน `docker compose up -d` และยิง k6 เป็นครั้งแรกของโปรเจกต์ · แก้ข้อบกพร่อง 3 ชั้นที่บังหน้ากันอยู่
**ไฟล์ที่แตะ**: `Dockerfile` · `nginx.conf` · `src/orders/orders.service.ts` · `src/orders/orders.service.spec.ts` · `src/redis/redis.service.ts` · `src/redis/lua/compensate-if-reserved.lua` (ใหม่) · `CLAUDE.md`

---

## 1. ตอนนี้อยู่ตรงไหน

สแตกขึ้นได้จริงบน **`docker compose`** (ไม่ใช่ podman — เครื่องที่ใช้ไม่มี podman) ทั้ง 8 container healthy
ยิง k6 ไป 3 รอบ รอบล่าสุด (run 003) **§9.3 ผ่านครบทั้ง 4 ข้อเป็นครั้งแรกของโปรเจกต์**

| ตรวจ (architecture.md §9.3) | run 002 | run 003 |
| :--- | :--- | :--- |
| `products.remaining_stock` ของ `p-1001` | 8 ❌ | **0** ✅ |
| `orders` count / distinct user | 42 / 42 ❌ | **50 / 50** ✅ |
| Redis `stock:flash_sale:p-1001` | 0 ✅ | 0 ✅ |
| มีใครได้เกิน 1 ชิ้น | ไม่มี ✅ | ไม่มี ✅ |

`build` / `lint` / `test` ผ่านหมด — unit test **35 ข้อ** (เดิม 32)
**ยังไม่ได้ commit ณ เวลาที่เขียนบันทึกนี้** (commit ทันทีหลังเขียนเสร็จ)

---

## 2. รอบนี้ทำอะไรไป ได้ผลอะไร

ข้อบกพร่อง 3 ชั้น **แต่ละชั้นบังไม่ให้เห็นชั้นถัดไป** ต้องแก้เรียงตามลำดับ

### ชั้นที่ 1 — ทั้งสแตกไม่ขึ้นเลย (`Dockerfile`)

`docker compose up -d` จบด้วย `dependency failed to start: container fs-app-1 is unhealthy`

```
EACCES: permission denied, open '/app/docs/Requirement/products-seed.json'
    at loadSeedFile (/app/dist/seed/seed.js:23:58)
```

ไฟล์ `docs/Requirement/products-seed.json` บนโฮสต์มีโหมด `-rwx------` (SynologyDrive ตัดสิทธิ์ group/other ทิ้ง)
`COPY` ของ Docker **คงโหมดของไฟล์ต้นทางไว้** ในอิมเมจจึงเป็น `root:root 0700` แต่คอนเทนเนอร์รันด้วย `USER node` (uid 1000)
→ seed ล้ม → app-1 restart วน → nginx ไม่ถูกสร้างขึ้นมาเลย

**แก้**: เพิ่ม `RUN chmod 0644 ./docs/Requirement/products-seed.json` ต่อจาก `COPY` ใน `Dockerfile`

### ชั้นที่ 2 — nginx แปลง "ช้า" ให้กลายเป็น "ล่ม" (`nginx.conf`)

รอบแรกที่ยิงได้ ผลคือ 502 จำนวน **115,005 ครั้ง** และ **write path ไม่เคยถูกทดสอบเลยสักคำขอ**
(`write_burst` จบใน 2.3 วินาที ได้ 502 ครบ 1,500)

สองอย่างซ้อนกัน:
1. `proxy_next_upstream` ไม่ได้ตั้งไว้ → ใช้ default `error timeout` → คำขอที่ timeout ถูกยิงซ้ำไป upstream ตัวถัดไปเอง
   **1 คำขอกิน backend ครบ 3 ตัว ตัวละ 5 วินาที** พอดีจังหวะที่ระบบกำลังจะเอาไม่อยู่
2. `max_fails=3 fail_timeout=10s` เหมือนกันทั้ง 3 ตัว → backend ช้าพร้อมกันหมด → nginx ตัดออกครบ → `no live upstreams` → 502 ทันทีรัวๆ

หลักฐานจาก log ของ nginx:
```
"upstreamStatus":"504, 504, 504"    194 ครั้ง
"upstreamStatus":"504, 504, 502"    875 ครั้ง
"upstreamTime":"8.097, 3.948"                ← 12 วินาที จากคำขอเดียว
```

**แก้** (ผู้ใช้เลือกจาก 4 ตัวเลือก): `proxy_next_upstream error;` + `max_fails=0` ทั้ง 3 upstream
เหตุผลที่ `max_fails=0` ถูก: backend 3 ตัวเหมือนกันทุกอย่าง เวลาพีคมันช้าพร้อมกัน passive health check จึงตัดทิ้งหมดเสมอ
การจับ instance ตายเป็นหน้าที่ของ `healthcheck` ใน `docker-compose.yml` ไม่ใช่ของ nginx free

### ชั้นที่ 3 — `commandTimeout` ทำให้สต็อกรั่ว (`orders.service.ts`)

พอชั้นที่ 2 ถูกปิด write path จึงทำงานจริงครั้งแรก → ได้ 202=42, 409=457, 429=101 แต่ **ของหาย 8 ชิ้น**

ตามรอย: Redis counter 50 → 0 (DECR ครบ 50 ครั้ง) แต่ `orders` มีแค่ 42 และ `bull:orders:completed` มี 43 (เกินมา 1 คือ job จากรอบก่อน)
→ มี 8 คำขอที่หักสต็อกแล้ว **ไม่เคยกลายเป็น job เลย** และไม่มี `bull:orders:failed` ด้วย

`app-3` มี `unhandled exception` **8 ครั้ง** และ `POST /api/v1/orders -> 500` **8 ครั้ง** — ตรงกับจำนวนที่หายพอดี

```
Error: Command timed out
    at Timeout.<anonymous> (ioredis/built/Command.js:195:33)
  req: POST /api/v1/orders
```

`COMPENSATION FAILED` เกิด **0 ครั้ง** → ไม่เคยมีการพยายามคืนสต็อกเลย

**สาเหตุ**: `gatekeeper()` ที่ `orders.service.ts` ไม่มี `try/catch` ครอบ · `commandTimeout: 1_000` ของ ioredis
**ยกเลิกแค่การรอฝั่ง client** มันไม่มีทางยกเลิกคำสั่งที่ Redis รับไปรันแล้ว
ตอนโหลดพีคจน Redis ตอบช้ากว่า 1 วินาที → Lua **DECR ไปเรียบร้อยแล้ว** แต่แอปได้ error → ตีความว่า "gatekeeper ไม่สำเร็จ" → ไม่ชดเชย

**แก้**: `src/redis/lua/compensate-if-reserved.lua` (ใหม่) + `try/catch` รอบ `gatekeeper()` ตอบ 503 แทน 500

---

## 3. ตัดสินใจอะไรไปบ้าง เพราะอะไร

| ตัดสินใจ | เหตุผล |
| :--- | :--- |
| **ไม่ใช้ `compensate.lua` เดิมในเคส timeout** | มัน `INCR` โดยไม่มีเงื่อนไข ถ้า Lua ไม่เคยรันจริงจะกลายเป็นเติมสต็อกลอยๆ → Redis สูงกว่า DB → ปล่อยคนที่ 51 เข้ามา ซึ่ง**แย่กว่าปัญหาเดิม** |
| **ใช้ค่าใน `lock:order:*` เป็นหลักฐานแทนการเดา** | `gatekeeper.lua` ทำ `DECR` กับ `SET lock` แบบ atomic คู่กัน lock ที่ถือ `requestToken` ของเราจึงพิสูจน์ได้ว่า DECR เกิดขึ้นแล้วแน่นอน → ปลอดภัยทั้งสองทาง (ไม่ได้จอง = no-op) |
| **ตอบ 503 ไม่ใช่ 500** | ไม่ได้เปลี่ยน API contract §3 — เส้นทาง `Queue unavailable` ก็ตอบ 503 อยู่แล้ว |
| **`max_fails=0` แทนการดัน `proxy_read_timeout`** | ดัน timeout แค่ซ่อนอาการและขัดกับ `architecture.md` §2 · ปิด passive health check แก้ที่กลไกที่ผิดจริง |
| **ไม่แตะ `commandTimeout: 1_000`** | `CLAUDE.md` §6 สั่งห้ามลบ และเหตุผลเดิมยังถูก — ถ้าไม่มีมัน คำสั่งจะค้างจน `catch` ไม่ทำงานเลย ปัญหาอยู่ที่การ**ตีความ** timeout ไม่ใช่ตัว timeout |
| **ไม่ commit `.DS_Store`** | มันถูก track อยู่แล้วจาก commit เก่า (3 ไฟล์) แต่ไม่ใช่งานของรอบนี้ จึงไม่ stage การเปลี่ยนแปลงของมัน |

---

## 4. ลองแล้วไม่เวิร์ก (ทางตัน)

- **`redis-cli DEBUG SLEEP`** ใช้ไม่ได้ — อิมเมจ `redis:7-alpine` ปิดไว้
  `ERR DEBUG command not allowed. If the enable-debug-command option is set to "local"...`
  → เปลี่ยนไปใช้ Lua busy-loop แทน (Redis เป็น single-thread จึงบล็อกทั้งเซิร์ฟเวอร์ได้):
  `EVAL "local t=tonumber(redis.call('TIME')[1])+3 while tonumber(redis.call('TIME')[1])<t do end return 1" 0`
- **ยิงบล็อกครั้งแรกจังหวะไม่ทัน** — `docker compose exec` มี overhead ~0.5–1 วินาที คำสั่งบล็อกเริ่มหลัง `curl` ไปแล้ว
  ทำให้ order ผ่านปกติ (202) ต้องหน่วง 1.6 วินาทีก่อนยิงถึงจะตรงจังหวะ · **ผลข้างเคียง: สร้าง order จริงไป 2 รายการ** บน `p-1002` กับ `p-1003` (`leak-probe-1`, `leak-probe-2`)
- **สมมติฐานแรกว่า logging เป็นคอขวด ผิด** — app-1 ผลิต log แค่ 5,835 บรรทัดตลอดการรัน (จาก 121k requests) เพราะ nginx ตอบ 502 โดยไม่แตะ backend เลย

---

## 5. ยังไม่ชัวร์ / สมมติฐานที่ยังไม่พิสูจน์

### ✅ ยืนยันแล้วด้วยการรันจริง

- §9.3 ทั้ง 4 ข้อ ผ่านใน run 003
- โค้ดใหม่ทำงานจริง — บังคับให้ `gatekeeper` timeout แล้วได้: HTTP **503**, `stock:flash_sale:p-1004` **10 → 10** (ไม่รั่ว), lock ไม่ค้าง, ไม่มี order ผี
- เพดาน throughput ~**1,500 rps** — ที่ 400 VUs: 1,561 rps, p95 237 ms, error **0** · ที่ 1,000 VUs: 1,374 rps (ลดลง = congestion collapse), p95 1,084 ms, max 15,322 ms

### ❓ ยังไม่ตรวจ / ยังไม่รู้

- **run 003 ไม่มี gatekeeper timeout เกิดขึ้นเลย** (`unhandled = 0`) → 50/50 ที่ได้มาไม่ได้พิสูจน์โค้ดใหม่ ต้องดูจากการทดลองบังคับแยกต่างหาก
- ในการทดลองบังคับ log ขึ้น `COMPENSATION FAILED … stock may have leaked by 1` เพราะ**คำสั่งชดเชยเองก็โดน timeout ด้วย** แต่ฝั่งเซิร์ฟเวอร์รันจนจบจริง สต็อกกลับมาครบ — **ยังไม่รู้ว่าถ้า Redis ค้างนานกว่า `ORDER_LOCK_TTL_MS` (30 วิ) จะเกิดอะไร** (lock หมดอายุก่อนชดเชย = คืนไม่ได้)
- **ไม่เคยยิงข้ามกลุ่ม** และไม่เคยยิงที่โหลดต่ำกว่าเพดาน (ตัวเลข latency ที่มีมาจากการยิงเกินกำลังราว 2 เท่า)
- **ไม่รู้ว่าทำไม run 003 มี 504 มากกว่า run 002** (1,391 vs 892) ทั้งที่โค้ดที่แก้ไม่แตะ read path — น่าจะเป็นความผันผวนของเครื่อง แต่ยังไม่ได้ยืนยัน
- `podman compose` ยังไม่เคยรัน — ทุกอย่างในบันทึกนี้มาจาก `docker compose` (Docker Desktop, 8 CPU / 7.65 GiB)

---

## 6. ก้าวถัดไป (เรียงลำดับ)

1. **ยิงที่ 400 VUs** เพื่อให้ได้ตัวเลข latency ที่ใช้เทียบกับกลุ่มเพื่อนได้จริง (ตอนนี้มีแต่ตัวเลขตอนระบบล่ม)
2. **เก็บภาพประกอบรายงาน** — Bull-Board (`localhost:8080/admin/queues`, `admin`/`admin`) และ `./scripts/cache-stats.sh`
   ⚠️ ตอนนี้ Completed = **52** ไม่ใช่ 50 (50 จาก `p-1001` + 2 จากการทดลองบังคับ timeout) ถ้าอยากได้ภาพที่เป็น 50 เป๊ะต้อง reset แล้วยิงใหม่
3. **ผนวกการล้าง BullMQ job เข้า `reset.ts`** — ดู §7
4. **ตัดสินใจเรื่อง reconciliation Redis ↔ DB** — รูสต็อกรั่วปิดแล้ว แต่ยังไม่มีตัวจับ drift เลย รอบนี้กว่าจะรู้ว่าของหายต้องนั่ง query เอง
5. **อัปเดต `architecture.md` §6.2 และ `architecture-rationale.md` §7** — ยังบรรยายเส้นทางเดิมที่ไม่มี `try/catch`
6. **ยิงข้ามกลุ่ม** (deliverable ตรงๆ) และทำรายงาน PDF

---

## 7. ข้อควรระวัง

- **`reset` ไม่ล้าง BullMQ job** และ `jobId` เป็น deterministic (`order:{userId}:{productId}`) → job เก่าชนกับรอบใหม่ได้
  รอบนี้ต้องล้างเองก่อนยิง run 003:
  ```bash
  docker compose exec -T redis-data redis-cli --scan --pattern 'bull:orders:*' \
    | tr -d '\r' | xargs -r docker compose exec -T redis-data redis-cli DEL
  ```
- **ต้อง `git add` ไฟล์ untracked ให้ครบ** — cloud review จับได้ว่าถ้า commit เฉพาะไฟล์ที่ tracked อยู่
  `registerLuaScripts()` จะ `throw` ตอน `onModuleInit()` เพราะหา `compensate-if-reserved.lua` ไม่เจอ
  → **ทุก container boot ไม่ขึ้นเลย** ไฟล์ที่ต้อง add: `src/redis/lua/compensate-if-reserved.lua`, `docs/Meta/`, `handoff_log/handoff_26_08_2026_primer-template.md`
- **ข้อความ `COMPENSATION FAILED … stock may have leaked by 1` เป็น false alarm ได้** — ถ้าคำสั่งชดเชยโดน timeout แต่เซิร์ฟเวอร์รันจนจบ สต็อกจะกลับมาจริง คำว่า *may* ตั้งใจใช้ **อย่าเห็นข้อความนี้แล้วสรุปว่าของหายทันที ให้ไปเช็ค counter จริง**
- `.DS_Store` 3 ไฟล์ถูก track อยู่ในรีโปตั้งแต่ commit เก่า — ควรถอดออกในรอบเก็บกวาด แต่ไม่ได้ทำในรอบนี้
- ตัวเลข latency ทุกตัวในบันทึกนี้เป็นค่าของระบบที่ **ถูกยิงเกินเพดานราว 2 เท่า** ห้ามเอาไปใส่รายงานว่าเป็น "ประสิทธิภาพของระบบ"

---

## 8. อ้างอิง

- `docs/Architecture/architecture.md` §9.2 (สถานการณ์ load test) · §9.3 (เกณฑ์ Data Integrity) · §6.1–6.2 (Tier 1–2)
- `CLAUDE.md` §0.1 (ตารางสิ่งที่ยังไม่ได้ทำ — อัปเดตแล้วในรอบนี้) · §4 ข้อ 5–6 (Lua atomic + ทุก path ที่หักสต็อกต้องชดเชย) · §8 (ต้องถามก่อนแก้ `nginx.conf` / concurrency policy)
- `src/redis/lua/gatekeeper.lua` — ที่มาของ `DECR` + `SET lock` แบบ atomic ซึ่งเป็นฐานของ `compensate-if-reserved.lua`
- `handoff_log/handoff_26_08_2026_design-review-round2.md` — รอบที่เคยเตือนเรื่อง undersell ไว้ล่วงหน้า
- ผลรัน k6 ดิบ: `loadtest.k6-summary.json` (ถูก `.gitignore` — ไม่ได้ commit)
