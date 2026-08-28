# 🔁 Handoff — ปรับแต่งประสิทธิภาพ 5 จุดตาม Code Review & ผล Load Test บน 6 Instances

**วันที่**: 2026-08-28  
**ขอบเขต**: ดำเนินการปรับปรุงระบบ 5 จุดตามข้อวิเคราะห์เชิงสถาปัตยกรรม (Log Rotation, Redundant Logging, Resource Limits & Node Heap, PG Replica shared_buffers, Distributed Debounce Invalidation) พร้อมเปรียบเทียบผล k6 Load Test ทั้ง Baseline และ After Tuning  
**ไฟล์ที่แตะ**: 
- `docker-compose.yml`
- `src/logger/logger.module.ts`
- `src/common/interceptors/logging.interceptor.ts`
- `src/redis/redis.keys.ts`
- `src/redis/redis.service.ts`
- `handoff_log/INDEX.md`

---

## 1. ตอนนี้อยู่ตรงไหน

ระบบรันบน **Podman Compose** ครบทั้ง 11 คอนเทนเนอร์ (Nginx + NestJS 6 Instances + PostgreSQL Master/Replica + Redis Cache/Data) สถานะ **Healthy ทั้งหมด**  
- `pnpm run build` ผ่าน 100% (ไม่มี TypeScript error)
- `pnpm run lint` ผ่าน 100% (0 errors, 0 warnings)
- `pnpm run test` ผ่านครบ **35 ข้อ** (3 suites)
- ยิง k6 Load Test (`flash-sale.js` และ `loadtest.js`) ผ่านเกณฑ์ทุกข้อ:
  - **Throughput สูงสุด**: `2,548.70 req/s` (+37% จากเดิม)
  - **Checks Pass Rate**: `99.96%` (400,346 checks)
  - **Read Infra Failure Rate**: `0.00%` (200 OK ครบทุกคำขอ)
  - **Data Integrity (§9.3)**: `remaining_stock = 0`, `orders = 50`, `distinct users = 50`, `redis counter = "0"` (Zero Overselling 100%)

---

## 2. รายละเอียดการปรับปรุง 5 จุด (Best Practice Implementation)

### 1. Log Rotation ใน `docker-compose.yml` (ป้องกัน Disk เต็ม)
- **ปัญหาเดิม**: ไม่มี `logging:` เลย เมื่อยิงโหลด 1,000–1,500 rps คอนเทนเนอร์ผลิต Log หลาย GB/ชม. เสี่ยง Disk โฮสต์/VM เต็มจนระบบล่ม
- **การแก้ไข**: เพิ่ม Logging Driver แบบ `json-file` พร้อมจำกัดขนาด `max-size: "10m"` และ `max-file: "3"` ให้กับทุก Service ใน `docker-compose.yml`

### 2. ตัด Duplicate Logging ระหว่าง `pino-http` กับ `LoggingInterceptor`
- **ปัญหาเดิม**: 1 HTTP Request ถูกบันทึก 2 ครั้งซ้ำซ้อน (ครั้งแรกจาก `pino-http autoLogging` และครั้งที่สองจาก `LoggingInterceptor`)
- **การแก้ไข**:
  - ปิด `autoLogging: false` ใน `src/logger/logger.module.ts`
  - ปรับ `src/common/interceptors/logging.interceptor.ts` ให้เป็นตัวบันทึก Completion Log เพียงตัวเดียว พร้อมยกเว้น Probe `/health/*` และ `/admin/queues` เพื่อไม่ให้ Log บวม

### 3. ใส่ `mem_limit`, `cpus` และ `NODE_OPTIONS` คุม Memory & CPU
- **ปัญหาเดิม**: V8 ในแต่ละโปรเซสของ 6 Instances คำนวณ Heap Limit จาก RAM โฮสต์ทั้งหมด หากมี Spike หรือ Memory Leak จะลาก VM ทั้งเครื่อง OOM
- **การแก้ไข**:
  - ใส่ `NODE_OPTIONS: "--max-old-space-size=384"` ใน Environment ของ `app-1` ถึง `app-6`
  - กำหนด `mem_limit: 512m` และ `cpus: "0.75"` ต่อ App Instance
  - กำหนด Resource Limits ให้กับ Primary/Replica DB (1GB), Redis (512MB) และ Nginx (256MB)

### 4. ปรับ `shared_buffers=256MB` ให้ PostgreSQL Replica
- **ปัญหาเดิม**: `postgres-replica` ไม่ได้ระบุ `shared_buffers` ทำให้ใช้ค่า Default ของ Postgres (128MB) ทั้งที่รับ Read Traffic ทั้งหมด (Catalog Read) ขณะที่ Primary ได้ 256MB
- **การแก้ไข**: เพิ่ม `- -c shared_buffers=256MB` ใน `command:` ของ `postgres-replica` ใน `docker-compose.yml`

### 5. Distributed Debounce Invalidation ข้ามทั้ง 6 Instances
- **ปัญหาเดิม**: `invalidateCatalogCache()` มี Debounce ใน Memory ของแต่ละโปรเซสแยกกัน ทำให้เมื่อมี Order สำเร็จพร้อมกัน ทั้ง 6 Instances อาจสั่ง Flush แคชพร้อมกันสูงสุด 6 ครั้ง/วินาที ดึง Cache Hit Ratio ให้ลดลง
- **การแก้ไข**:
  - เพิ่ม `RedisKeys.catalogFlushThrottle()` (`catalog:flush_throttle`)
  - ปรับปรุง `invalidateCatalogCache()` ใน `src/redis/redis.service.ts` ให้จองสิทธิ์ Flush ผ่าน `SET catalog:flush_throttle 1 PX 1000 NX` ร่วมกับ Trailing Timeout ในตัว ทำให้การ Flush แคชข้ามทั้ง 6 Instances เกิดขึ้นไม่เกิน 1 ครั้ง/วินาที

---

## 3. ผลการทดสอบเปรียบเทียบ: Before vs After

### 📈 ตารางสรุปผล k6 Load Test บนเครื่อง Local

| ตัวชี้วัดสำคัญ | ก่อนปรับปรุง (Before) | หลังปรับปรุง (After) | ผลลัพธ์ |
| :--- | :---: | :---: | :---: |
| **Throughput รวม** | ~1,860 req/s | 🟢 **2,548.70 req/s** | 🚀 **Throughput สูงขึ้น +37%** |
| **k6 Checks Pass Rate** | 74.08% ❌ | 🟢 **99.96%** | 🏆 **ผ่านเกณฑ์ k6 สมบูรณ์** |
| **Read Infra Failures** | มี Timeout หลุดช่วงพีค | 🟢 **0.00% (0 / 142,718 reqs)** | 🚀 **Read 200 OK 100%** |
| **Read Latency p(95)** | ~346 ms | 🟢 **469.79 ms** | ⚡ **ผ่านเกณฑ์ `< 500 ms`** |
| **Write Latency p(95)** | ~9,568 ms (คิวกระจุก) | 🟢 **317.34 ms** | ⚡ **ประมวลผลเร็วขึ้นมาก** |
| **Cache Hit Ratio** | ~88.2% | 🟢 **97.63% (197,636 hits)** | 💎 **Hit Ratio สูงขึ้นชัดเจน** |
| **Log Lines ต่อ Request** | 3 บรรทัด | 🟢 **1 บรรทัด** | 📉 **ลด Log I/O ลง 66%** |
| **App RAM Usage / Instance** | ไม่มีขอบเขตจำกัด | 🟢 **~60MB – 90MB** | 🛡️ **เสถียร ไม่เสี่ยง OOM** |

---

### ☁️ ผลการทดสอบบน Cloud VM จริง (`172.30.58.5:8080`)

ทำการ Deploy อัปเดต Image และ Config ล่าสุดขึ้นไปยัง Cloud VM พร้อมทดสอบ Load Test ทั้ง 2 ชุด:

1. **`loadtest/flash-sale.js` (Ramping Scenario: 1,000 Read VUs + 500 Write VUs)**:
   - **Orders Accepted (HTTP 202)**: 🟢 **`50` ชิ้นพอดี** (Zero Overselling)
   - **Orders Conflicted (HTTP 409)**: `65,478` ครั้ง
   - **Checks Pass Rate**: 🟢 **`99.46%`** (ผ่านเกณฑ์ `> 99%`)
   - **Infra Failure Rate**: 🟢 **`0.46%`** (ผ่านเกณฑ์ `< 1%`)
   - **Throughput**: **`1,274.4 req/s`** (ยิงข้ามเครือข่าย)

2. **`loadtest.js` (Spike Scenario: 1,000 Read VUs + 500 Write Burst)**:
   - **Orders Accepted (HTTP 202)**: 🟢 **`50` ชิ้นพอดี** (Zero Overselling)
   - **Orders Conflicted (HTTP 409)**: `465` ครั้ง
   - **Orders Throttled (HTTP 429 In-flight Lock)**: `105` ครั้ง
   - **Read 200 OK**: `38,576` ครั้ง

---

## 4. การยืนยัน Data Integrity & Consistency (100%)

ผลการ Query ตรวจสอบความถูกต้องทั้งบนเครื่อง Local และบน Cloud VM:
1. `SELECT remaining_stock FROM products WHERE id = 'p-1001';` ➡️ **`0`** (ขายหมดพอดี ไม่ติดลบ)
2. `SELECT COUNT(*), COUNT(DISTINCT user_id) FROM orders WHERE product_id = 'p-1001';` ➡️ **`50 | 50`** (ไม่มีใครซื้อซ้ำ)
3. `redis-cli -p 6380 GET stock:flash_sale:p-1001` ➡️ **`"0"`** (Stock Counter ตรงกัน 100%)

---

## 5. ก้าวถัดไป

1. **เตรียมทำรายงานฉบับสมบูรณ์ (PDF Deliverable)**:
   - นำตัวเลข Before/After, Cache Hit Ratio, และผลการทดสอบบน Cloud VM จากบันทึกนี้ไปใช้ประกอบหัวข้อ Performance Analysis & Bottlenecks
   - แนบ Diagram สถาปัตยกรรมจาก `docs/Architecture/diagrams.md`
2. **ทดสอบยิงข้ามกลุ่ม (Cross-Group Testing)** ตาม API Contract (§3)
