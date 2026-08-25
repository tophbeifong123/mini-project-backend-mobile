# 🚀 Flash Sale System — Mini Project Backend (Mobile)

High-throughput, low-latency backend สำหรับสถานการณ์ **Flash Sale** — รองรับ **1,000 concurrent readers** และ **write burst 500 คนแย่งสินค้า 50 ชิ้น** โดยการันตี **Zero Overselling** และ **1 ชิ้นต่อ 1 ผู้ใช้**

> **สถานะปัจจุบัน**: 📐 **Blueprint** — ออกแบบเสร็จแล้ว ยังไม่เริ่ม implement (`src/` ยังไม่ถูกสร้าง)

---

## 📚 เอกสาร

| เอกสาร | คำอธิบาย |
| :--- | :--- |
| 🏛️ [**System Architecture & Concurrency Blueprint**](docs/architecture.md) | สเปกหลักของระบบ — read path, write path 4-tier, failure matrix, pooling, load test |
| 🤖 [**CLAUDE.md**](CLAUDE.md) | กติกาสำหรับ AI agent และผู้พัฒนา — stack, คำสั่ง, API contract, DO/DON'T |
| 🗄️ [**old_architecture.md**](docs/old_architecture.md) | ⚠️ **ฉบับเก่า เก็บไว้อ้างอิงเท่านั้น** — ห้ามใช้เป็นสเปก (มีสรุปปัญหาที่พบอยู่หัวไฟล์) |
| 📄 [**โจทย์ต้นฉบับ**](docs/Flash%20Sale%20System.pdf) | Mobile Backend Architecture & Performance Testing |
| 🌱 [**products-seed.json**](docs/products-seed.json) | ข้อมูลสินค้าตั้งต้น (`p-1001` มีสต็อก 50 ชิ้น = ตัวที่ใช้ทดสอบ) |
| 📖 [**สรุปบทเรียน (ฉบับอ่าน)**](docs/Summary_Best_Practice/For_human/) | Backend01–06 ภาษาไทยแบบละเอียด |
| ⚙️ [**สรุปบทเรียน (ฉบับ agent)**](docs/Summary_Best_Practice/agent/INDEX.md) | กฎแบบย่อ + **slide-errata** (โค้ดในสไลด์ที่ผิด ห้ามลอก) |

---

## 🏗️ ภาพรวมสถาปัตยกรรม

```
k6 (1,000 read VUs + 500 write VUs)
        │
        ▼
  Nginx :8080  ── least_conn + keepalive
        │
        ├──► app-1 ─┐
        ├──► app-2 ─┼── NestJS (API + BullMQ worker)  ◄── JWT HS256 (stateless)
        └──► app-3 ─┘
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

**หลักคิดสำคัญ**: แคช *metadata สินค้า* ไว้นาน แต่ `remainingStock` อ่านสดจาก Redis counter ทุก request แล้ว merge ตอนตอบกลับ — ทำให้แคชไม่ต้องถูก invalidate ทุกครั้งที่มีคนซื้อ แต่สต็อกยังถูกต้องเสมอ ([รายละเอียด](docs/architecture.md#5-%EF%B8%8F-read-path-1000-concurrent-users))

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

> ⚠️ ยังไม่มีโค้ด — ส่วนนี้คือขั้นตอนที่ *จะ* ใช้เมื่อ implement เสร็จ

```bash
cp .env.example .env
podman compose up -d       # Nginx + 3 app + PG primary/replica + redis ×2
pnpm run migration:run
pnpm run seed              # โหลด products-seed.json เข้า DB
pnpm run seed:redis        # SET stock:flash_sale:* จาก DB
k6 run loadtest.js
```

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

- [ ] Source code + `docker-compose.yml` (1-click start)
- [ ] `loadtest.js` (k6)
- [ ] Report (PDF): diagram · cache invalidation strategy · การกันสั่งซื้อซ้ำ · ผล load test · ตารางเทียบกับกลุ่มเพื่อน · การแบ่งงานในทีม
