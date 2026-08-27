# 📊 Flash Sale System — Load Test, Scaling & Cloud Deployment Report

> **บันทึกสรุปการทดสอบประสิทธิภาพ การแก้ปัญหาคอขวด การขยายระบบ (Horizontal Scaling) และการ Deploy บน Cloud VM**  
> วันที่: 27 สิงหาคม 2026

---

## 📌 1. ภาพรวมการดำเนินงาน (Executive Overview)

ในวันนี้เราได้ทำการทดสอบประสิทธิภาพระบบ Flash Sale Backend ภายใต้โหลดสูง (1,000 Concurrent Read Users + 500 Concurrent Write Users) วิเคราะห์คอขวด ปรับแต่งสถาปัตยกรรมระบบ และ Deploy ขึ้น Cloud VM โดยมีผลการดำเนินงานหลักดังนี้:

1. **วิเคราะห์ผลการทดสอบ Load Test รอบแรก**: พบปัญหา Throughput และ Connection Drop เมื่อยิง 1,000 VUs พร้อมกันทันทีบน 3 Instances
2. **นำเข้าชุดทดสอบใหม่**: เพิ่มโฟลเดอร์ `loadtest/` (`flash-sale.js`, `reset.ps1`/`.sh`, `verify.ps1`/`.sh`)
3. **ขยายสถาปัตยกรรม (Horizontal Scaling)**: ขยาย NestJS App จาก **3 Instances ➡️ 6 Instances**
4. **ปรับจูน Edge Proxy (Nginx)**: เพิ่ม `keepalive 128;`, ปรับ `proxy_read_timeout 10s`, และเกลี่ยโหลดแบบ `least_conn`
5. **แก้ปัญหา Timeout & Auto-trim URL**: เพิ่ม `timeout: 10s` ใน k6 และตัด `/` ส่วนเกินท้าย URL ป้องกัน Error
6. **Deploy ขึ้น Cloud VM (`172.30.58.5`)**: ติดตั้งและรันระบบบน Cloud สำเร็จ พร้อมยืนยันความถูกต้องของข้อมูล (Zero Overselling)

---

## 🔍 2. สรุปปัญหาที่พบในรอบแรกและการวิเคราะห์ (Root Cause Analysis)

### 2.1 ปัญหา `Contract Violations` 1.4 ล้านครั้งคืออะไร?
* **ความหมาย**: ใน `loadtest.js` ได้ตั้งเงื่อนไขไว้ว่า หากคำขอใดไม่ได้รับ `HTTP 200 OK` (เช่น เกิด Timeout หรือ 502/504) จะถูกนับเป็น `Contract Violation` ทันที
* **สาเหตุ**: เมื่อ 1,000 VUs ยิงวนลูปต่อเนื่องไม่มีพัก Traffic พุ่งสูงถึง **12,500 req/s** เกินกว่าที่ App 3 ตัวจะรับไหว คำขอ ~90% จึงติดคิวจนเกิน Timeout (10s)
* **ข้อเท็จจริง**: **ไม่ใช่โค้ด JSON ผิดสเปก** แต่เกิดจากคำขอส่งกลับมาไม่ทัน (Capacity ไม่พอ)

### 2.2 ปัญหา `HTTP 429` (In-flight Lock) vs สคริปต์ทดสอบ
* เมื่อผู้ใช้กดย้ำรัวๆ ขณะที่คำสั่งซื้อเดิมยังประมวลผลไม่เสร็จ ระบบตอบ **`HTTP 429 Too Many Requests`** เพื่อป้องกัน Race Condition
* สคริปต์ `flash-sale.js` นับ 429 เป็น `Infra Failure` ทั้งที่เป็นพฤติกรรมความปลอดภัยที่ถูกต้องตามสเปก

---

## 🏗️ 3. การปรับปรุงสถาปัตยกรรมระบบ (Architecture Scaling & Tuning)

```
[ k6 Client / Users (1,000 VUs) ]
               │
               ▼
   [ Nginx Reverse Proxy (:8080) ]  <-- keepalive 128, timeout 10s, least_conn
               │
   ┌───────────┼───────────┬───────────┬───────────┬───────────┐
   ▼           ▼           ▼           ▼           ▼           ▼
[ app-1 ]   [ app-2 ]   [ app-3 ]   [ app-4 ]   [ app-5 ]   [ app-6 ]  <-- NestJS (Pool: 8)
   │           │           │           │           │           │
   ├───────────┴───────────┼───────────┴───────────┴───────────┤
   ▼                       ▼                                   ▼
[ Redis Cache ]     [ Redis Data ]                    [ PostgreSQL ]
(:6379, LRU)        (:6380, Stock/BullMQ)             (Master:5432 / Replica:5433)
```

### 🛠️ รายละเอียดการตั้งค่าที่ปรับปรุง:

1. **`docker-compose.yml`**:
   * เพิ่มบริการ **`app-4`**, **`app-5`**, **`app-6`**
   * ปรับ `DB_POOL_SIZE` เป็น `8` ต่อ Instance (`6 × 8 = 48` connections ปลอดภัยต่อ `max_connections = 100` ของ PostgreSQL)
2. **`nginx.conf`**:
   * เพิ่ม upstream ครบ 6 เซิร์ฟเวอร์ พร้อมเปิด `least_conn`
   * เปิด `keepalive 128;` แบบ HTTP/1.1 ป้องกันการสร้าง TCP Handshake ใหม่ทุกครั้ง
   * ขยาย `proxy_connect_timeout 5s;`, `proxy_read_timeout 10s;`, `proxy_send_timeout 10s;`

---

## 📈 4. ผลการทดสอบเปรียบเทียบ: ก่อนแก้ vs หลังแก้

### 4.1 ตารางเปรียบเทียบบนเครื่อง Local

| ตัวชี้วัดสำคัญ | ก่อนขยาย (3 Instances) | หลังขยาย (6 Instances) | สถานะ |
| :--- | :---: | :---: | :---: |
| **Contract Violations** | `1,409,758` ครั้ง (หลุด ~90%) | 🟢 **`0` ครั้ง (ไม่มีเลย)** | 🚀 **แก้ปัญหาได้ 100%** |
| **Unexpected Status (5xx/502)** | `1,164` ครั้ง | 🟢 **`0` ครั้ง** | 🚀 **ระบบไม่ล่ม** |
| **Read Success Rate (200 OK)** | ~10% – 20% | 🟢 **100.00%** | 🚀 **ผ่านสมบูรณ์** |
| **Checks Pass Rate (`flash-sale.js`)** | 25.92% ❌ | 🟢 **99.97%** | 🚀 **ผ่านเกณฑ์ k6** |
| **Infra Failure Rate (`flash-sale.js`)** | 67.10% ❌ | 🟢 **0.04%** (Read หลุด 0%) | 🚀 **เสถียรมาก** |
| **Orders Accepted (HTTP 202)** | 50 คำสั่งซื้อ | 🟢 **50 คำสั่งซื้อ (ตรงเป๊ะ)** | 🏆 **Zero Overselling** |

---

### 4.2 ผลการทดสอบยิงข้ามเครือข่ายไปยัง Cloud VM (`172.30.58.5:8080`)

| ตัวชี้วัด | `flash-sale.js` (Ramping) | `loadtest.js` (Spike) | เกณฑ์ |
| :--- | :---: | :---: | :---: |
| **Orders Accepted (202)** | **`50` รายการ** | **`50` รายการ** | 50 ชิ้นพอดี |
| **Overselling** | 🟢 **`0` ชิ้น** | 🟢 **`0` ชิ้น** | ต้องไม่มี |
| **Orders Conflicted (409)** | `81,985` ครั้ง | `1,342` ครั้ง | ป้องกันซื้อซ้ำ |
| **Orders Throttled (429)** | สกัดผ่าน Lock | `91` ครั้ง | ป้องกันกดรัว |
| **Check Pass Rate** | 🟢 **`99.95%`** | 🟢 **`99.99%`** | `> 99.0%` |
| **Infra Failure Rate** | 🟢 **`0.06%`** | 🟢 **`0.01%`** | `< 1.0%` |
| **Contract Violations** | `0` ครั้ง | `8` ครั้ง *(ลดจาก 1.4M)* | `0` |
| **Write Latency (p95)** | 🟢 **`430.82 ms`** *(ผ่าน)* | **`8,108.58 ms`** *(คิวรอตอนยิงซ้อน)* | `< 500 ms` |
| **Cache Hit Ratio บน VM** | 🟢 **`94.47%`** | 🟢 **`94.47%`** | `≥ 70.0%` |

---

## 🛡️ 5. การยืนยัน Data Integrity & Consistency (100%)

ผลการ Query ตรวจสอบความถูกต้องของฐานข้อมูลและแคชสดใน PostgreSQL และ Redis หลังจบการทดสอบทุกรอบ:

```sql
-- 1. ตรวจสอบสต็อกสินค้า p-1001 ใน PostgreSQL
SELECT id, remaining_stock, available_stock FROM products WHERE id = 'p-1001';
-- ผลลัพธ์: remaining_stock = 0, available_stock = 50 (ตัดสต็อกครบพอดี ไม่ติดลบ)

-- 2. ตรวจสอบจำนวนออเดอร์และผู้ใช้ใน PostgreSQL
SELECT count(*) as total_orders, count(distinct user_id) as unique_users, status 
FROM orders WHERE product_id = 'p-1001' GROUP BY status;
-- ผลลัพธ์: total_orders = 50, unique_users = 50, status = CONFIRMED (ไม่มีคนซื้อซ้ำ)

-- 3. ตรวจสอบสต็อกสดใน Redis Data
GET stock:flash_sale:p-1001
-- ผลลัพธ์: "0" (ตรงกับ PostgreSQL 100%)
```

---

## 📚 6. Operations Cheat Sheet (คำสั่งที่ใช้บ่อย)

### 🔹 ก. คำสั่ง Reset ฐานข้อมูลและแคช (ต้องรันก่อนเริ่มทดสอบทุกรอบ)
```bash
# รันบนเครื่อง Local
RESET_CONFIRM=yes pnpm run reset

# รันบน Cloud VM ผ่าน SSH
ssh cloud@172.30.58.5 "docker exec -i -e RESET_CONFIRM=yes fs-app-1 node dist/database/reset.js && docker exec -i fs-redis-cache redis-cli FLUSHDB"
```

### 🔹 ข. คำสั่งรัน Load Test
```powershell
# 1. ยิงทดสอบแบบ Ramping Load (Scenario มาตรฐาน)
k6 run --env BASE_URL=http://172.30.58.5:8080 loadtest\flash-sale.js

# 2. ยิงทดสอบแบบ Spike Burst (30 วินาที)
k6 run --env BASE_URL=http://172.30.58.5:8080 loadtest.js
```

### 🔹 ค. คำสั่งตรวจสอบสุขภาพระบบบน VM
```bash
# ตรวจสอบ Health & Readiness
curl -s http://172.30.58.5:8080/health/ready

# ตรวจสอบสถานะ Container ทั้งหมด
ssh cloud@172.30.58.5 "docker compose -f ~/flash-sale-backend/docker-compose.yml ps"

# ตรวจสอบ Access Log ของ Nginx
ssh cloud@172.30.58.5 "docker logs --tail 20 fs-nginx"
```
