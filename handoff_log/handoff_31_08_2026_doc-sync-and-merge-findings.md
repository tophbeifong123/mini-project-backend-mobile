# 🔀 Handoff — sync เอกสารตาม config ที่รวมงาน 2 คน + ของที่หายตอน merge

**วันที่**: 2026-08-31 (ฉบับที่ 3 ของวัน)
**ขอบเขต**: เอกสารล้วน — sync `.md` 8 ไฟล์ให้ตรงกับ `docker-compose.yml`/`nginx.conf` ที่ตอนนี้เป็นผลรวมของงาน 2 คน · **ไม่แตะ `src/`, `docker-compose.yml`, `nginx.conf` เลย**
**อ่านคู่กับ**: [`handoff_31_08_2026_right-size-to-4core-vm.md`](handoff_31_08_2026_right-size-to-4core-vm.md) · [`handoff_31_08_2026_bind-datastore-loopback.md`](handoff_31_08_2026_bind-datastore-loopback.md)

---

## 1. TL;DR

- วันนี้มีคนแก้ config **2 คนพร้อมกัน** แล้ว merge กัน — เอกสารตามไม่ทันทั้งสองฝั่ง
- sync เอกสาร 8 ไฟล์: `WORKER_CONCURRENCY` **5 → 1** (รวมคลัสเตอร์ 30 → **6**), app `cpus` **0.75 → 1.0**, `keepalive` **128 → 768**
- 🔴 **เจอของหายตอน merge**: `LOG_LEVEL: warn` ที่เพื่อนใส่ไว้ทั้ง 6 service **หายหมดใน merge commit `e16476d`** (มีใน `4b77a22` → หลัง merge เหลือ 0)
- 🔴 **และวิเคราะห์แล้วว่า `LOG_LEVEL: warn` ไม่ได้ทำในสิ่งที่ comment ของมันบอก** — จึง **จงใจไม่ใส่กลับ** (เหตุผลเต็ม §3)
- **ยังไม่มีใครยิง k6 บน config ชุดรวมนี้เลยสักครั้ง** — ตัวเลขทุกตัวใน repo ยังมาจาก dev Mac

---

## 2. config ตอนนี้เป็นผลรวมของใครบ้าง

| ค่า | ปัจจุบัน | มาจาก |
| :--- | :--- | :--- |
| จำนวน instance | **6** (`app-1`…`app-6`) | commit `81b787b` |
| app `cpus` | **1.0** (จาก 0.75) | commit `4b77a22` — เหตุผลใน comment: 1 Node process ใช้ได้เต็ม 1 vCPU ตอนงานเยอะ · `0.75` throttle ทุก instance ระหว่าง burst 1,000 reader ทั้งที่ host ยังมี core ว่าง |
| app `mem_limit` | 512m · heap 384 | `81b787b` |
| `WORKER_CONCURRENCY` | **1** (จาก 5) | `4b77a22` — เหตุผลใน comment: 5 × 6 = 30 concurrent transaction ชนกับ primary ที่มี 1 vCPU แล้วแย่ง CPU กับ HTTP event loop ตอน write burst |
| nginx `cpus`/`mem` | 1.0 / 128m · `worker_processes 2` · `keepalive 768` | `81b787b` |
| `proxy_buffering on` + buffers 32×16k | เพิ่มใหม่ | `4b77a22` |
| http-level `keepalive_timeout 65s` | เพิ่มใหม่ | `4b77a22` |
| postgres 768m/640m · redis-cache 320m | | `81b787b` |
| `redis-data` cpus 1.0 / 512m | **ไม่แตะโดยเจตนา** | §8.2 ข้อ 2 = คอขวดอันดับ 2 |
| datastore ports ผูก `127.0.0.1` | ครบ 4 | `be555f3` |
| **รวม** | **`cpus` 10.0 · `mem_limit` 5,440 MB** | VM เป้าหมาย 4 core / 6,144 MB |

> merge commit `e16476d` ทำโดย Thummeena ไม่ใช่ตัว agent — ตอนแก้ conflict เลือกฝั่ง `81b787b` สำหรับบล็อก `environment:` จึงทำ `LOG_LEVEL` ของตัวเองหลุดไป

---

## 3. 🔴 `LOG_LEVEL: warn` — หายตอน merge และ **ไม่ควรใส่กลับตรงๆ**

### หลักฐานว่าหาย
```bash
git show 4b77a22:docker-compose.yml | grep -c LOG_LEVEL   # 6
git show e16476d:docker-compose.yml | grep -c LOG_LEVEL   # 0
```

### ทำไมถึงไม่ใส่กลับ — มันไม่ได้ทำในสิ่งที่ comment บอก

comment ที่เพื่อนเขียนไว้:
> *"Keep warnings/errors for diagnosis without serializing and writing one JSON log line for every successful read on the benchmark hot path."*

แต่ `logging.interceptor.ts:65-66` **sample read ไว้ 1/100 อยู่แล้ว**:
```ts
// GET = read path เท่านั้นที่ถูกสุ่ม · write path log ครบทุกใบเสมอ
const sampled = method !== 'GET' || this.readCount++ % READ_LOG_SAMPLE_RATE === 0;
```

`LOG_LEVEL=warn` ปิดเฉพาะ `logger.info()` (`logger.module.ts:40` = `process.env.LOG_LEVEL ?? 'info'`) ผลจริงคือ:

| | ก่อน | หลังตั้ง `warn` |
| :--- | :--- | :--- |
| GET สำเร็จ | 1/100 → ≈50 บรรทัด/วิ ที่ 5,000 rps | 0 — **ประหยัดได้แค่นี้** |
| **POST 202 สำเร็จ** | 100% (`:71-87`) | **0 — เสีย traceability ของ write path** ซึ่ง `CLAUDE.md` §5 ข้อ 5 ต้องการ |
| **409/429/503/5xx** | 100% ไม่ sample (`logger.warn` `:88-107`) | **100% เหมือนเดิม — ไม่ลดเลย** |

**ตัวที่กิน CPU จริงคือ error branch** — รอบที่วัดได้มี **226,618 × 409** ทุกใบเรียก `logger.warn()` โดยไม่ sample และ `LOG_LEVEL=warn` **ไม่แตะมันเลยแม้แต่นิดเดียว**

สรุป: มันตัดของที่เล็กที่สุดทิ้ง เสีย log ที่สเปกต้องการ และไม่แตะของที่ใหญ่ที่สุด

### ถ้าอยากได้ผลตามเจตนาจริง ต้องแก้ตรงไหน

sample **error branch เฉพาะ 409/429** (ซึ่ง `CLAUDE.md` §3 ระบุเองว่า "เป็นพฤติกรรมที่ถูกต้อง ไม่ใช่ error") โดยคง 100% ไว้กับ 401/503/5xx
⚠️ เป็นการแก้ **logging policy** → ติด §8 ต้องขออนุญาต **และควรคุยกับคนที่เขียน `4b77a22` ก่อน**

---

## 4. เอกสารที่ sync (commit `c7d0770`)

| ไฟล์ | แก้อะไร |
| :--- | :--- |
| `docs/Architecture/architecture.md` | mermaid worker node · §3.1.6 · Failure Matrix · §8 ตาราง capacity (worker concurrency + nginx keepalive) · §8.1 callout `cpus` · §8.2 row-lock · ย่อหน้า pool contention |
| `docs/Architecture/architecture-rationale.md` | ADR-6 + ตาราง trade-off — **เก็บเหตุผลเดิมไว้ เพิ่มหมายเหตุค่า deploy ปัจจุบัน** |
| `docs/Architecture/architecture-primer.md` | T3 diagram + ตัวอย่าง `keepalive` 2 จุด |
| `docs/Architecture/diagrams.md:528` | `concurrency 5/node (×6=30)` → `1/node (×6=6)` |
| `docs/Codebase/{All_in_one,Separate}/*` | ตาราง magic number + mermaid `keepalive` (2 ไฟล์นี้เป็น mirror กัน) |
| `docs/Report/Report_flash-sale-report.md` | diagram + ตาราง component — `keepalive 128 → 768` |
| `CLAUDE.md` §0.1 | บันทึกว่า commit หลังของวันเดียวกันดัน `cpus` กลับเป็น 1.0 / รวม 10.0 และ `WORKER_CONCURRENCY` เป็น 1 |

### หลักการที่ใช้ (สำคัญ อย่าทำผิดในรอบหน้า)

**ตรงไหนที่เอกสารอธิบายว่า *ทำไม* ถึงเลือกค่านั้น → เก็บเหตุผลเดิมไว้ แล้วเพิ่มหมายเหตุ ไม่ทับทิ้ง**
เหตุผลของ ADR-6 ("ทำไม 5 ไม่ใช่ 50") ยังถูกอยู่ ส่วนเหตุผลที่ลดเหลือ 1 เป็นคนละเรื่องกันโดยสิ้นเชิง (worker แย่ง CPU กับ HTTP event loop บน primary 1 vCPU **ไม่ใช่** แย่ง pool ตามที่ ADR-6 พูดถึง)

### เอกสารที่ **จงใจไม่แตะ**

| ไฟล์ | เหตุผล |
| :--- | :--- |
| `docs/LOADTEST_AND_SCALING_REPORT.md` | บันทึกผลรันวันที่ 2026-08-27 — `keepalive 128` **ถูกต้อง ณ วันนั้น** ห้ามแก้ประวัติศาสตร์ |
| `handoff_log/handoff_29_08` · `handoff_30_08_2026_report-sync-*` | เหตุผลเดียวกัน |
| `docs/Codebase/Separate/02-design-review-qa.md` + §6 Q6 ใน `codebase-guide.md` | เลข 5/30 ที่นั่นเป็นส่วนหนึ่งของการ**ถกเถียงเหตุผลของ ADR-6** ไม่ใช่การอ้างสถานะปัจจุบัน — แก้แล้วตรรกะของบทถกจะพัง |
| `docs/Summary_Best_Practice/**` | เป็นบทเรียนทั่วไปเรื่อง pm2 ไม่ใช่ config ของระบบนี้ |
| `docs/plans/right-size-vm-4core.draft.html` | เป็น `.html` และเป็นแผนฉบับร่าง ณ เวลานั้น (ยังเขียน `cpus 0.75`) |

---

## 5. ✅ ตรวจแล้ว vs ❌ ยังไม่ได้พิสูจน์

### ✅ ตรวจแล้ว
- `build` / `lint` / `test` (**49 tests**) ผ่าน · container **11/11 healthy**
- `docker compose down && up` → healthy ครบใน **18.7 วิ** (1-click start ตาม §9)
- API contract §3 ตรวจมือทีละข้อ: `price` เป็น number · ไม่มี token = 401 · `quantity` เกินถูกตัดเงียบ (202 ไม่ใช่ 400) · `/health/live` + `/health/ready` = 200
- Load balance กระจายครบ **6/6 instance** · ไม่มี ghost `app-7`/`app-8` ใน `metrics:instances`
- **§9.3 ผ่านครบ 4 ข้อ** หลังยิง `k6 run loadtest.js` เต็มรอบ: `remaining_stock=0` · `50,50` · Redis `"0"` · ไม่มีใครได้เกิน 1 ชิ้น — **ผ่านทั้งที่รอบนั้นเจอ 5xx 2,730 ครั้ง** แปลว่า compensation ทุกเส้นทางทำงานถูกต้องภายใต้ความกดดันจริง
- datastore ปิดจาก LAN ครบ 4 port · nginx :8080 ยังเปิด

### ❌ ยังไม่ได้พิสูจน์
| อะไร | สถานะ |
| :--- | :--- |
| **ยังไม่เคย deploy ขึ้น VM 4 core เลยสักครั้ง** | โค้ดอยู่แค่บน GitHub + รันบน dev Mac |
| **ยังไม่มีใครยิง k6 บน config ชุดรวมนี้** | `cpus 1.0` + `WORKER_CONCURRENCY 1` + `proxy_buffering` เป็นการรวมงาน 2 คนที่ยังไม่เคยวัดทับ |
| **6 vs 8 vs 4 instance อันไหนดีกว่า** | ไม่มีใครรู้ · dev Mac วัดไม่ได้ (7 รอบ 200 VUs เดียวกันได้ 700–5,406 rps ต่างกัน **7.7 เท่า** ที่ host load 35–56) |
| **`WORKER_CONCURRENCY: 1` ดีกว่า 5 จริงไหม** | เหตุผลใน comment ฟังขึ้น แต่ยังไม่มีตัวเลขยืนยัน |

---

## 6. คนต่อไปต้องทำอะไร (เรียงตามความสำคัญต่อคะแนน)

1. **เอาขึ้น VM 4 core แล้ววัดที่นั่น** — ที่เดียวที่ตัวเลขมีความหมาย · ยิง k6 **จากเครื่องอื่น** ไม่ใช่จาก VM
2. **ทำรายงาน PDF (§9)** — ยังไม่มีเลย และเป็น deliverable ตรงๆ
3. **ยิงข้ามกลุ่ม** — ยังไม่เคยเกิดขึ้น
4. **คุยกับคนเขียน `4b77a22` เรื่อง `LOG_LEVEL`** (§3) — ตัดสินใจร่วมกันว่าจะ sample error branch หรือปล่อยไว้
5. 🟠 **ปิด Bull-Board `admin`/`admin`** — รูสุดท้ายที่เหลือ · เปิดผ่าน `:8080` ที่จำเป็นต้องเปิดสู่ LAN · แก้ `.env` ไม่มีผล ต้องแก้ที่ `docker-compose.yml`

### เลขที่ใช้ในรายงานได้จริง (วัดบน dev Mac 8-core — ต้องระบุ caveat เสมอ)

- idle: `GET /products` **5–10 ms** · `POST /orders` (409) **7–8 ms** · body 1,447 bytes
- cache hit rate **99.2%** (881,620 hit / 6,960 miss)
- VU sweep (config เก่า 8-instance): 50 VUs → 6,194 rps p95 16 ms · **100 VUs → 7,733 rps p95 28 ms (พีค)** · 200 → 5,006 rps p95 95 ms · 400 → 2,402 rps p95 469 ms · 800 → ~1,100 rps p95 1.78–17.5 s + 502
- **throughput ยุบตัวหลัง ~100 VUs** = congestion collapse ซึ่งอธิบายได้และวัดซ้ำได้ — **ดีกว่ารายงาน p95 5 วินาทีโดยไม่บอกว่าทำไม**
- `/health/live` 10,213 rps เทียบ `/products` 4,190 rps ที่ 200 VUs เท่ากัน → ~58% ของต้นทุน read อยู่ที่ handler ไม่ใช่ framework
