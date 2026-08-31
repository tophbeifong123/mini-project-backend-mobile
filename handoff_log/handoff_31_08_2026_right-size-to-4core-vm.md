# 🔧 Handoff — Right-size `docker-compose.yml` ให้ตรงกับ VM เป้าหมาย 4-core/6GB (ลบ app-7/app-8)

**วันที่**: 2026-08-31
**ขอบเขต**: แก้ resource sizing ใน `docker-compose.yml` + `nginx.conf` ให้กลับไปตรงกับ `docs/Architecture/architecture.md` §8.1 (VM เป้าหมาย 4 core / 6 GB) หลังพบว่า compose แอบดริฟต์ไปใช้ 8 instances โดยไม่มีบันทึกที่ไหนเลย + แก้โค้ด 2 จุดเล็กที่ไม่เกี่ยวกับ sizing แต่ทำพร้อมกัน
**ไฟล์ที่แตะ** (ยังไม่ commit ณ เวลาบันทึกนี้):
- `docker-compose.yml`
- `nginx.conf`
- `src/redis/redis.module.ts`
- `src/products/products.controller.ts`
- `src/main.ts` (ลบบรรทัดว่างซ้ำ 1 บรรทัด — cosmetic ล้วน ไม่กระทบพฤติกรรม)

---

## 1. TL;DR

- `docker-compose.yml` มี **app-7/app-8** (`cpus: 1.5` ต่อ instance) ค้างอยู่แบบไม่มีที่มา — ไม่มี handoff log ไหนบันทึกว่าใครเพิ่ม ไม่มีใน git history (ยัง uncommitted) และ **ขัดกับ `architecture.md` §8.1/§8.2 ที่เขียนไว้แล้วตั้งแต่ 2026-08-28 ว่า VM เป้าหมายมี 4 core และ app tier ควรเป็น 6 instance × `cpus 0.75`**
- แก้กลับให้ compose ตรงกับเอกสาร: ลบ app-7/app-8, `cpus` ของ app-1..6 กลับเป็น `0.75`, ลดสัดส่วน nginx/postgres-replica/redis-cache ตามไปด้วย — **`redis-data` จงใจไม่แตะ** (§8.2 ข้อ 2 ของเอกสารระบุว่าเป็นคอขวดอันดับ 2 ของระบบอยู่แล้ว)
- ผลรวม: **cpus 18.0 → 8.5**, **mem_limit 7,424 MB → 5,440 MB** — VM เป้าหมายมี 4 core / 6,144 MB ดังนั้น **ค่าเดิมเกิน RAM จริงไปแล้ว 121%**, ค่าใหม่อยู่ที่ 88.5%
- `build`/`lint`/`test` (49 tests) ผ่านหมด, ขึ้น container 11 ตัว healthy ครบ, ยิง `k6 run loadtest.js` แล้ว §9.3 ผ่านครบ 4 ข้อ
- **แต่การวัด performance รอบนี้ทำบน dev Mac (8-core) ที่รัน k6 พร้อมกันด้วย ไม่ใช่ VM เป้าหมาย** และเครื่องนี้ noise สูงมากจนวัด 6-vs-8 instance ให้เชื่อได้ไม่ได้เลย (ดู §4) — **ยังไม่มีตัวเลขไหนจากรอบนี้ที่เอาไปอ้างเป็นตัวเลข deliverable ได้**

---

## 2. บริบท — ดริฟต์ที่เจอ

`docker-compose.yml` ก่อนแก้วันนี้มี service block `app-7` และ `app-8` ครบชุด (environment/healthcheck/depends_on เหมือน app-1..6 ทุกอย่าง) พร้อมคอมเมนต์อธิบายเหตุผลไว้ในตัวไฟล์เองว่า:

> "ทำไมถึงเพิ่มจาก 6 เป็น 8: Node รันด้วย thread เดียวต่อ process ... วัดได้: 1 instance ตัน ~800 rps → 6 instance = ~4,700 rps ... ผลจริงหลังเพิ่มเป็น 8: read 253k → 288k req · write p95 5,190ms → 340–1,542ms"

และ `cpus` ของ app-1..6 เองก็ถูกดันจาก `0.75` เป็น `1.5` ไปพร้อมกัน (รวมเป็น `cpus` ทั้งสแตก 18.0 core)

**ปัญหา**: ไม่มี commit ไหนใน git log บันทึกการเปลี่ยนนี้ (`docker-compose.yml` อยู่ในสถานะ `M` uncommitted ทั้งก้อนตอนเริ่ม session นี้) และไม่มี handoff log ไหนพูดถึง app-7/app-8 เลยสักฉบับ ในขณะที่ `docs/Architecture/architecture.md` §8.1/§8.2 **เขียนไว้ตั้งแต่ 2026-08-28 แล้วว่า**:

- VM เป้าหมายมี **4 core / 6 GB** เท่านั้น (§8.1)
- "6 process บน 4 core คือ oversubscribe อยู่แล้ว — เพิ่มเป็น 8–10 จะได้ context switch มากขึ้น ไม่ใช่ throughput" (§8.2 ข้อ 1)
- app-N ควรเป็น `mem_limit 512m`, `cpus 0.75` (§8.1 บรรทัดยืนยัน "แก้แล้ว 2026-08-28")

พูดอีกแบบ: **เอกสารไม่ได้ตามหลังโค้ด — โค้ด (compose) ต่างหากที่ดริฟต์ออกจากเอกสารที่ถูกต้องอยู่แล้ว** งานวันนี้คือการดึง compose กลับมาให้ตรงกับสิ่งที่ `architecture.md` ระบุไว้แต่แรก ไม่ใช่การออกแบบใหม่

---

## 3. การเปลี่ยนแปลงที่ทำ

### 3.1 `docker-compose.yml`

| Service | ก่อน | หลัง |
| :--- | :--- | :--- |
| `app-1` … `app-6` | `cpus: "1.5"` | `cpus: "0.75"` (`mem_limit 512m` และ `NODE_OPTIONS --max-old-space-size=384` **ไม่เปลี่ยน**) |
| `app-7`, `app-8` | มีอยู่ | **ลบทั้ง service block** — กลับไป 6 instance ตรงกับ §8.1 |
| `nginx` | `cpus: "2.0"`, `mem_limit: 256m` | `cpus: "1.0"`, `mem_limit: 128m` |
| `postgres-primary` | `mem_limit: 1024m` (`cpus` ไม่เปลี่ยน 1.0) | `mem_limit: 768m` |
| `postgres-replica` | `mem_limit: 1024m`, `cpus: "1.0"` | `mem_limit: 640m`, `cpus: "0.5"` |
| `redis-cache` | `mem_limit: 512m`, `cpus: "1.0"` | `mem_limit: 320m`, `cpus: "0.5"` |
| `redis-data` | `cpus: "1.0"`, `mem_limit: 512m` | **ไม่แตะ — จงใจ** (§8.2 ข้อ 2: bottleneck อันดับ 2 ของระบบ) |

**รวมทั้งสแตก**: `cpus` 18.0 → **8.5** · `mem_limit` 7,424 MB → **5,440 MB**

VM เป้าหมายตาม §8.1 คือ 4 core / 6,144 MB (6 GB) — **7,424 MB เดิมเกินจริง 121% ของ RAM ที่มี**, **5,440 MB ใหม่อยู่ที่ 88.5%** (ยังมี headroom เหลือให้ host OS)

### 3.2 `nginx.conf`

- `worker_processes 4` → `2` (คอมเมนต์ในไฟล์เองบังคับว่าต้อง "ตั้งให้เท่ากับ `cpus:` ใน docker-compose.yml" — ตอนนี้ nginx `cpus` เหลือ 1.0 จึงต้องเป็น 2 worker ไม่ใช่ 4)
- upstream กลับไปมี 6 servers (`app-1`…`app-6`) ตรงกับ compose
- `keepalive 768` **ไม่เปลี่ยนค่า** แต่เพิ่มคอมเมนต์อธิบายผลกระทบ: keepalive นับ "ต่อ worker" ลด worker จาก 4 เหลือ 2 ทำให้ pool รวมลดจาก 3,072 เหลือ 1,536 — ยังพอสำหรับเพดานที่วัดได้ของ VM นี้ (~2,500–3,500 rps ตามที่เคยวัดไว้ในรอบ 08-28)

### 3.3 โค้ด (ไม่เกี่ยวกับ sizing แต่แก้พร้อมกันใน session นี้)

- **`src/redis/redis.module.ts`**: เพิ่ม `enableAutoPipelining: true` ในตัวเลือก ioredis ที่ใช้ร่วมกัน — เหตุผลตามคอมเมนต์ในไฟล์: read path ยิง 2 คำสั่ง/คำขอ (cache `GET` + data `MGET`) ที่ ~800 rps/instance จึงรวมเป็น pipeline เดียวต่อ event-loop tick แทนที่จะ `write()` แยกทีละคำสั่ง ไม่เปลี่ยน semantic ของคำสั่งใดๆ (`multi/exec` และ Lua ยังทำงานเหมือนเดิม)
- **`src/products/products.controller.ts`**: ลบ `ValidationPipe` ระดับ param ที่ประกาศซ้ำบน `@Query()` ของ `GET /products` — global pipe ใน `main.ts` เป็น superset อยู่แล้ว (มี `enableImplicitConversion` เพิ่มด้วย) ทำให้ก่อนหน้านี้ class-transformer วิ่ง **2 รอบต่อ 1 คำขอ** บน endpoint ที่ร้อนที่สุดของระบบ

---

## 4. การวัดผล — ⚠️ ทำบน dev Mac (8-core/7.65GB, Docker Desktop) ที่รัน k6 พร้อมกันด้วย ไม่ใช่ VM เป้าหมาย

**อ่านหัวข้อนี้ทั้งหมดก่อนเอาตัวเลขไปอ้างที่ไหน** — เครื่องที่วัดไม่ใช่ deployment target (§8.1 ระบุ 4 core/6GB) และ k6 เองก็แย่งซีพียูกับ container อยู่บนเครื่องเดียวกัน ตัวเลขในหัวข้อนี้ใช้เป็น **สัญญาณเชิงคุณภาพ** เท่านั้น ไม่ใช่ตัวเลข deliverable — รูปแบบเดียวกับที่เคยบันทึกไว้ใน `handoff_29_08_2026_git-pull-k6-retry-local.md` (CPU contention บนเครื่อง local ทำให้ตัวเลขเชื่อถือไม่ได้)

### 4.1 Idle (ไม่มีโหลด)

| endpoint | latency |
| :--- | :--- |
| `GET /products` | 5–10 ms |
| `POST /orders` (409 conflict) | 7–8 ms |
| ขนาด response body | 1,447 bytes |

### 4.2 Closed-loop VU sweep — บน config เก่า (8 instance, ก่อนแก้วันนี้)

| VUs | rps | p95 |
| :--- | :--- | :--- |
| 50 | 6,194 | 16 ms |
| 100 | 7,733 | 28 ms |
| 200 | 5,006 | 95 ms |
| 400 | 2,402 | 469 ms |
| 800 | ~1,100 | 1.78–17.5 s (มี 502) |

**Throughput ยุบตัวหลัง ~100 VUs** — พีคอยู่ที่ 100 VUs แล้วลดลงเรื่อยๆ จนถึง 800 VUs ที่ทั้ง latency และ error กระโดดขึ้นชัดเจน (502)

### 4.3 อื่นๆ ที่วัดได้บน config เก่า

- Cache hit rate: **99.2%** (881,620 hits / 6,960 misses)
- ที่ 200 VUs เท่ากัน: `/health/live` 10,213 rps เทียบกับ `/products` 4,190 rps
- CPU ต่อ container ที่ 400 VUs: apps 60–77% ของ 1 core ต่อตัว, nginx 54%, redis-cache 15%, redis-data 11%, postgres-primary 1.7%, postgres-replica 0.03%

### 4.4 ⚠️ เครื่องนี้ noise สูงเกินกว่าจะเชื่อ A/B ได้

รัน 200 VUs ซ้ำ **7 ครั้งติดกันแบบไม่เปลี่ยนอะไรเลย** ได้: 700 / 976 / 1,157 / 2,982 / 3,352 / 4,943 / 5,406 rps — **ต่างกันสูงสุด 7.7 เท่า** ระหว่างรอบที่แย่สุดกับดีสุด `load average` ของ host ขึ้นไปถึง 35–56 จากแอป GUI อื่นบนเครื่อง (ไม่ใช่จาก container)

**สรุป: ยังไม่มีการพิสูจน์ว่า 6 instance เร็วกว่าหรือช้ากว่า 8 instance** — ตัวเลขทั้งหมดในหัวข้อนี้ผันผวนเกินกว่าจะเทียบ config ต่อ config บนเครื่องนี้ได้

### 4.5 หลังแก้ config วันนี้ — ยิงซ้ำแล้วได้ผล "แย่กว่า" บนเครื่องนี้ (ยังไม่รู้ว่าจะเกิดบน VM จริงไหม)

รัน `k6 run loadtest.js` (1,000 read VUs + 500 write VUs) บนเครื่องเดิม หลังใช้ config ใหม่ (6 instance, `cpus 0.75`):

- Read p95: **3,214 ms**
- Write p95: **10,300 ms**
- 5xx: **1,308 ครั้ง**

เทียบกับ config เก่าที่ยิงในรอบ §4.2–4.3 ที่ **ไม่มี 5xx เลย** — ผลรอบนี้แย่ลงชัดเจนบนเครื่องที่วัด

**สมมติฐานที่ยังไม่ยืนยัน**: cgroup CPU ceiling ของ app tier ลดจาก `8 × 1.5 = 12.0` core-เทียบเท่า เหลือ `6 × 0.75 = 4.5` — บน dev Mac ที่มี 8 physical core, ceiling เดิม 12.0 **เกิน** จำนวน core จริงอยู่แล้วจึงแทบไม่เคย throttle จริง ในขณะที่ ceiling ใหม่ 4.5 **บีบคอ** แอปจริงบนเครื่องนี้ (มี core ว่างเหลือแต่ cgroup ไม่ให้ใช้) จึงอาจอธิบายว่าทำไมโหลดเดียวกันดูแย่ลงหลังแก้

ข้อสังเกต: บน VM เป้าหมายจริง (4 physical core) ceiling ใหม่ 4.5 core ยัง**สูงกว่า**จำนวน core จริงของทั้งเครื่อง (4) เช่นกัน ดังนั้นกลไกการบีบคอแบบเดียวกับที่เห็นบน dev Mac **อาจไม่เกิดในรูปแบบเดียวกัน** บน VM จริง — แต่นี่เป็นเพียงการให้เหตุผลจากตัวเลข ไม่ใช่การวัดจริง **ต้องพิสูจน์บน VM 4-core จริงเท่านั้น** ห้ามสรุปจากเครื่อง dev

---

## 5. ยืนยันแล้ว vs ยังไม่พิสูจน์

### ✅ ยืนยันแล้ว

- `pnpm run build`, `pnpm run lint`, `pnpm run test` (49 tests) ผ่านหมด
- สแตกขึ้นครบ **11 container healthy** ด้วย config ใหม่
- §9.3 Data Integrity ผ่านครบ 4 ข้อ หลัง `k6 run loadtest.js` เต็มรอบ: `remaining_stock = 0`, `COUNT(*), COUNT(DISTINCT user_id) = 50, 50`, Redis counter `"0"`, ไม่มีใครได้เกิน 1 ชิ้น

### ❌ ยังไม่พิสูจน์

- **ไม่รู้ว่า 6 instance เร็วกว่าหรือช้ากว่า 8 instance จริง** — เครื่องที่ใช้วัด noise สูงเกินไป (§4.4)
- **ไม่รู้ว่าผลลบที่เห็นหลังแก้ (§4.5) จะเกิดบน VM 4-core จริงไหม** — เป็นแค่สมมติฐานจาก cgroup ceiling
- **ยังไม่เคยรัน config นี้ (หรือ config ไหนเลย) บน VM เป้าหมายจริงตั้งแต่มีการดริฟต์ไป 8 instance** — ตัวเลขอ้างอิงล่าสุดจาก VM จริงยังเป็นของรอบ 2026-08-28 (ก่อนดริฟต์)

---

## 6. ก้าวถัดไป (สำคัญที่สุดก่อนอ้างตัวเลขกับกลุ่มเพื่อน)

1. **Deploy config ใหม่ (6 instance, `cpus 0.75` ทุก service) ขึ้น VM เป้าหมาย 4-core/6GB จริง** — ยังไม่เคยทำเลยตั้งแต่ session นี้
2. **ยิง k6 จากเครื่องแยกต่างหาก ไม่ใช่จากตัว VM เอง** — เพื่อไม่ให้ k6 แย่ง CPU กับ container เหมือนที่เกิดซ้ำๆ บนเครื่อง dev (ทั้งรอบนี้และรอบ `handoff_29_08_2026_git-pull-k6-retry-local.md`)
3. **วัดเทียบ 6 vs 8 instance บน VM จริงถ้ายังอยากรู้คำตอบ** — dev Mac ตอบคำถามนี้ไม่ได้ (§4.4)
4. หลังยิงบน VM จริงแล้ว ให้เอาตัวเลขไปแทนที่เพดาน "~1,500 rps" เดิมใน `CLAUDE.md` §0.1 ที่ยังอ้างอิงจากตอน 3 instance
5. ถ้าผล §4.5 (แย่ลงหลังลด cpus) เกิดซ้ำบน VM จริงด้วย ต้องกลับมาทบทวนว่า `cpus 0.75` ต่อ instance พอจริงไหมสำหรับ VM 4-core — อาจต้องลดจำนวน instance ลงแทนที่จะลด cpus ต่อ instance (ตรงข้ามกับที่ compose เดิมทำตอนดริฟต์ไป 8 instance)
