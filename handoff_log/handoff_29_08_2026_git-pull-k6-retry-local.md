# 🔁 Handoff — git pull + ยิง k6 ซ้ำบนเครื่อง local (เจอ resource contention ไม่ใช่บั๊กใหม่)

**วันที่**: 2026-08-29
**ขอบเขต**: `git pull` แล้ว merge เข้ากับงานเอกสารที่ค้างอยู่ในเครื่อง + รัน `docker compose up` + reset + ยิง k6 ซ้ำบนเครื่อง local (Mac ของ `chav_sir`, ผ่าน Docker Desktop ไม่ใช่ podman)
**ไฟล์ที่แตะ**: `.gitignore` (เพิ่ม `docker-compose.override.yml`), `.env` (สร้างใหม่จาก `.env.example`, ไม่ commit), `docker-compose.override.yml` (ใหม่ — **local-only, git-ignored**), `handoff_log/INDEX.md`
**หมายเหตุ**: งานนี้ถูกตัดจบกลางคันตามคำขอผู้ใช้ ("l don't test it now OK back to normal") — เขียนบันทึกนี้เพื่อไม่ให้ผลที่เจอไปแล้วหายไปเปล่าๆ

---

## 1. git pull

`origin/main` มี commit ใหม่ 1 ตัว (`e0fdc9e feat: performance tuning and architectural review fixes with load test verification`, 2026-08-28) ที่ยังไม่ได้อยู่ในเครื่องนี้ ในขณะที่เครื่องนี้เองก็มีการแก้เอกสาร (`CLAUDE.md`, `AGENTS.md`, `docs/Architecture/*`, `docs/Codebase/*`, `src/config/database.config.ts`) ที่ยังไม่ได้ commit ค้างอยู่ก่อนแล้ว

**วิธีจัดการ**: `git stash push -u` → `git pull --ff-only` (fast-forward สำเร็จ) → `git stash pop` → conflict เกิดแค่จุดเดียวคือ `handoff_log/INDEX.md` (ทั้งสองฝั่งเพิ่มบรรทัดบนสุดคนละบรรทัด) แก้ด้วยมือให้เก็บทั้งสองรายการ (เรียงตามวันที่) ส่วน `docker-compose.yml` auto-merge สำเร็จเอง (รวม `mem_limit`/`cpus`/logging จาก commit ใหม่ เข้ากับ 6-instance/keepalive 128 ที่แก้ไว้ก่อนหน้า)

**ของแถมที่เจอระหว่างทาง**: ไฟล์ 16 ไฟล์ที่ git บอกว่า "modified" มีแค่ mode bit เปลี่ยน (`100644` → `100755`) เนื้อหาไม่ต่างเลยสักบรรทัด — เกิดจาก SynologyDrive sync แก้ permission ของไฟล์ในเครื่อง (เจอปัญหาแบบเดียวกับที่ `handoff_27_08_2026_load-test-first-run.md` เคยบันทึกไว้เรื่อง seed file mode `0700`) แก้ด้วย `chmod 644` เฉยๆ ไม่ใช่บั๊กจริง

**พบว่ามี `stash@{1}: teammate WIP synced via SynologyDrive 2026-08-28` ค้างอยู่ในเครื่องนี้อยู่ก่อนแล้ว** — ไม่ใช่ของที่ session นี้สร้าง **ไม่ได้แตะ/ไม่ได้ drop stash นั้น** เผื่อเป็นงานที่เพื่อนร่วมทีมยังไม่ได้เอากลับคืน (เครื่อง Mac นี้ดูเหมือนจะเป็น shared/synced folder ที่มีมากกว่า 1 คนใช้งานสลับกัน)

## 2. ปัญหาที่เจอตอนเปิดสแตกบนเครื่องนี้ (แก้แล้วด้วย local-only workaround)

`docker compose up -d` ขึ้นครบ 10/11 container แต่ **`fs-nginx` วนล่มตลอด**:

```
nginx: [crit] pread() "/etc/nginx/nginx.conf" failed (35: Resource deadlock would occur)
```

`lsof nginx.conf` เจอว่ามี process ของ SynologyDrive client ถือ fd เปิดค้างไว้บนไฟล์นี้อยู่ — ชน lock กับตอนที่ Docker Desktop (virtiofs) พยายาม bind-mount ไฟล์เดียวกันเข้า container เป็น `:ro` เป็นปัญหา environment เฉพาะเครื่องที่รันจากโฟลเดอร์ที่ sync ด้วย SynologyDrive ตรงๆ ไม่เกี่ยวกับตัว `nginx.conf` เอง

**แก้แบบ local-only** (ถามผู้ใช้ก่อนแล้วเลือก "Local override file"):
- copy `nginx.conf` ไปไว้นอกโฟลเดอร์ sync (scratchpad ของ session)
- สร้าง `docker-compose.override.yml` ที่ root repo ชี้ volume ของ `nginx` ไปที่ copy นั้นแทน (Compose รวม override ไฟล์นี้ให้อัตโนมัติ)
- เพิ่ม `docker-compose.override.yml` ใน `.gitignore` — **ห้าม commit เด็ดขาด** เพราะมี absolute path เฉพาะเครื่องนี้อยู่ข้างใน เครื่องอื่นใช้ไม่ได้

หลังทำแบบนี้ nginx ขึ้น healthy ปกติ ครบ 11/11 container

## 3. `pnpm run reset` ช้าผิดปกติบนเครื่องนี้ (I/O ไม่ใช่ hang)

รันครั้งแรกด้วย `RESET_CONFIRM=yes pnpm run reset` แล้วไม่มี output อะไรเลยนานเกิน 3 นาที `lsof` บน process พบว่ากำลังอ่านไฟล์ `.d.ts` ใน `node_modules` ทีละไฟล์ (CPU ใช้ <1%) — คือ `ts-node` (มี type-check เต็มรูปแบบ) กำลังไล่อ่าน declaration file ทั้ง dependency tree ผ่าน SynologyDrive filesystem ซึ่งช้ามากเมื่อเทียบกับ local disk (เจอ pattern เดียวกับปัญหา nginx.conf ข้างบน แต่ตัวการคราวนี้คือ "อ่านไฟล์เยอะมาก" ไม่ใช่ lock)

ลอง `TS_NODE_TRANSPILE_ONLY=true` ช่วยตัด type-check ทิ้ง แต่ยังช้าอยู่ (require() ของ transitive deps ยังต้องอ่านไฟล์ `.js` เป็นพันไฟล์ผ่าน filesystem เดียวกัน) — **สรุป**: รอบที่สองที่รันด้วย `TS_NODE_TRANSPILE_ONLY=true` สุดท้าย**ก็สำเร็จเอง** (แค่ใช้เวลาประมาณ 4-5 นาที ไม่ใช่ hang จริง) — ได้ผล:

```
[reset] orders ลบไป 52 แถว · remaining_stock = available_stock แล้ว
[reset] redis-data ลบ stock=20 bought=52 lock=0 compensated=0
[seed] upserted 20 products (remaining_stock untouched on existing rows)
[seed:redis] 20 products processed — 20 counters created, 0 already existed (left untouched by NX)
```

**ข้อแนะนำสำหรับคนถัดไปที่รันจากเครื่องนี้ (หรือเครื่องอื่นที่ repo อยู่ใน cloud-sync folder)**: ใช้ `TS_NODE_TRANSPILE_ONLY=true` ไปเลยกับทุกคำสั่งที่ผ่าน `ts-node` (`reset`, `seed`, `seed:redis`) เพื่อตัดเวลาที่ไม่จำเป็นออก หรือดีที่สุดคือ clone repo ไปไว้ใน local disk ปกติ (ไม่ sync) แล้วรันจากตรงนั้น — `.env` ชี้ `localhost` ports อยู่แล้วใช้ได้ทันทีไม่ต้องแก้อะไร

## 4. ผลยิง k6 (`loadtest.js`) รอบนี้ — ผ่าน invariant แต่ performance แย่กว่ารอบ 2026-08-28 มาก

รันหลัง reset เสร็จ ที่ `http://localhost:8080` (default ของสคริปต์) สแตกทั้ง 11 container healthy ก่อนยิง

### ตัวเลขที่ได้

| | ผล |
| :--- | :--- |
| READ 200 OK | 39,662 |
| READ contract violations | **988** (ต้อง = 0) ❌ |
| READ p95 latency | **1,221 ms** (แย่กว่ารอบ 08-28 ที่ได้ 469ms มาก) |
| WRITE 202 accepted | **50** (ครบพอดี ✅) |
| WRITE 409 conflict | 87 |
| WRITE 429 throttled | 67 |
| WRITE unexpected status | **887** (ส่วนใหญ่คือ 504) ❌ |
| WRITE p95 latency | **10,428 ms** ❌ (แย่กว่ารอบ 08-28 ที่ได้ 317ms มาก) |
| k6 threshold | **crossed** (`http_req_duration` ทั้ง 2 scenario) |

### แต่ Data Integrity (§9.3) ผ่านครบ — ตรวจแล้วจริงหลังยิงจบ

```
SELECT remaining_stock FROM products WHERE id = 'p-1001';         → 0
SELECT COUNT(*), COUNT(DISTINCT user_id) FROM orders WHERE ...;   → 50 | 50
redis-cli GET stock:flash_sale:p-1001                             → "0"
```

**ไม่มี oversell ไม่มีใครซื้อซ้ำ แม้ตัวเลข latency จะแย่** — invariant หลักของระบบยังถูกต้อง 100%

### วิเคราะห์: นี่คือ resource contention ของเครื่องนี้ ไม่ใช่บั๊กใหม่ในโค้ด

ตรวจ nginx access log พบว่า 504 ทุกตัวเกิดที่ `responseTime` ~10.00–10.01 วินาที **พอดีกับ `proxy_read_timeout` 10s ที่ตั้งไว้** — ตรงกับรูที่บันทึกไว้แล้วใน `CLAUDE.md` §0.1 ("`proxy_read_timeout` ดันขึ้นเป็น 10s แล้ว... แต่อาการต้นเดิมยังอยู่: ถ้า upstream ช้าเกิน 10 วิก็ยังเป็น 504 เหมือนเดิม") — **นี่คือรูเดิมที่รู้จักแล้ว ไม่ใช่การถดถอยใหม่**

ต้นเหตุที่ทำให้ upstream ช้าเกิน 10s รอบนี้ (ต่างจากรอบ 08-28 ที่ทำได้ 2,548 rps): เครื่องนี้ (`chav_sir` MacBook) มี **8 physical core เท่ากับที่ Docker Desktop VM จองไปทั้งหมด** (`docker info` → `CPUs: 8`) ส่วน `docker-compose.yml` (หลัง merge จาก commit 08-28) ตั้ง `cpus:` รวมกันของทุก service **พอดี 8.0 cores** อยู่แล้ว — บวกกับ `k6` ที่รันอยู่บนเครื่อง host (นอก Docker VM) ก็แย่งซีพียูตัวเดียวกันด้วย ทำให้ทั้งสแตกไม่มี headroom เหลือเลยตอนโหลดพีค → app instance บางตัวช้าเกิน 10s → 504

**ยังไม่ได้ยืนยัน 100%** ว่านี่คือสาเหตุเดียว (ไม่ได้เก็บ `docker stats` ระหว่างยิงไว้) แต่สอดคล้องกับตัวเลขและ pattern ที่เห็น — งานนี้ถูกตัดจบก่อนจะเก็บหลักฐานเพิ่มเติม

## 5. สถานะ ณ ตอนตัดจบ

- สแตก docker ยังรันอยู่ (11/11 container, ยังไม่ได้ `down`) — ถามผู้ใช้ก่อนถ้าจะปิด
- `docker-compose.override.yml` (local-only, ไม่ commit) ยังอยู่ที่ root repo — ถ้าจะรันสแตกครั้งหน้าบนเครื่องนี้ยังต้องใช้ไฟล์นี้อยู่ (หรือย้าย repo ไป local disk แทน)
- `.env` ถูกสร้างใหม่ (ไม่ commit ตาม `.gitignore` เดิม)
- **ยังไม่ได้ query ผล `docker stats` เพื่อยืนยันสมมติฐาน CPU contention**
- **ยังไม่ได้ลองยิงซ้ำหลังเพิ่ม CPU/RAM ให้ Docker Desktop หรือยิงจากเครื่องแยก** — ก้าวถัดไปที่แนะนำถ้าจะสืบเรื่องนี้ต่อ

## 6. ก้าวถัดไปที่แนะนำ (ยังไม่ได้ทำ)

1. เก็บ `docker stats` ระหว่างยิง k6 รอบหน้าเพื่อยืนยัน/ปัดตกสมมติฐาน CPU contention
2. ลองยิง k6 จากเครื่องอื่น (ไม่ใช่เครื่องที่รัน container) หรือเพิ่ม CPU ให้ Docker Desktop แล้วปล่อยว่างไม่ให้ k6 แย่งกับ container
3. ถ้ายืนยันว่าเป็นข้อจำกัดของเครื่องนี้จริง — ตัวเลข performance ที่ใช้อ้างอิงเปรียบเทียบกับกลุ่มอื่นควรใช้ผลจาก `handoff_28_08_2026_performance-tuning-and-review-fixes.md` (2,548 rps) หรือผลจาก Cloud VM แทน ไม่ใช่ผลจากเครื่องนี้
