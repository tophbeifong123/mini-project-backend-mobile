# 🏛️ Flash Sale System — Architecture & Concurrency Blueprint

> **โจทย์**: Mobile Backend Architecture & Performance Testing (Flash Sale System)
> **เป้าหมาย**: Read 1,000 concurrent users + Write burst 500 concurrent users แย่งสินค้า 50 ชิ้น
> **การันตี**: Zero Overselling · 1 ชิ้น / 1 ผู้ใช้ / 1 สินค้า · ตอบ HTTP เร็ว (ไม่มี synchronous DB write ใน controller)

---

## 0. 🎯 Requirement Traceability (โจทย์ → สถาปัตยกรรม)

| # | ข้อกำหนดจากโจทย์ | ที่อยู่ในเอกสารนี้ |
| :-- | :--- | :--- |
| 1.1 | Load Balancer: Nginx → **≥ 3 instances** | §2 |
| 1.2 | Backend: NestJS **Modular structure** | §3 |
| 1.3 | Database: PostgreSQL + TypeORM + **Connection Pooling** | §8 |
| 1.3.1 | Schema / Entity / Migration | **§3.1** |
| 1.4 | Caching & Invalidation: Redis | §5 |
| 1.5 | Message Queue: **BullMQ** (async order processing) | §6.2 |
| 1.6 | **Stateless Auth: JWT** (ห้าม in-memory session) | §4 |
| 1.7 | Observability Dashboard (Bull-Board) | §9 |
| 2.1 | `POST /api/v1/auth/token` | §4.2 |
| 2.2 | `GET /api/v1/products?page=1&limit=10` + cache invalidation | §5 |
| 2.3 | `POST /api/v1/orders` → **202 Accepted** | §6 |
| 2.3.1 | Limit 1 per user | §6.1 + §6.4 |
| 2.3.2 | Concurrency (API level) — atomic Redis ops | §6.1 |
| 2.3.3 | Concurrency (Worker/DB level) — locking + unique constraint | §6.3 + §6.4 |
| 2.3.4 | Cache Invalidation หลัง worker ตัดสต็อกสำเร็จ | §5.4 |
| 3 | Load Test (k6) + Dashboard + Data Integrity Proof | §9, §10 |

---

## 1. 🏗️ ภาพรวมสถาปัตยกรรม (System Architecture Diagram)

```mermaid
flowchart TD
    subgraph Clients["👥 High Concurrency Traffic (k6)"]
        C1["1,000 Read VUs<br/>GET /products"]
        C2["500 Write VUs<br/>POST /orders (burst)"]
    end

    subgraph Edge["⚖️ Edge Layer"]
        NGINX["Nginx Reverse Proxy :8080<br/>least_conn · keepalive 64<br/>proxy_http_version 1.1"]
    end

    subgraph BackendCluster["🚀 NestJS Cluster (3 Instances)"]
        APP1["app-1 :3000<br/>API + Worker"]
        APP2["app-2 :3000<br/>API + Worker"]
        APP3["app-3 :3000<br/>API + Worker"]
    end

    subgraph AuthMod["🔐 Auth (Stateless)"]
        JWT["JWT HS256<br/>verify in-process<br/>zero I/O"]
    end

    subgraph RedisCache["⚡ redis-cache :6379 (allkeys-lru)"]
        CACHE["Catalog Metadata Cache<br/>catalog:page:P:limit:L"]
        L1[/"Single-flight memo<br/>(per-process, metadata only)"/]
    end

    subgraph RedisData["🔒 redis-data :6380 (noeviction + AOF)"]
        LUA["Atomic Lua Gatekeeper<br/>stock counter · in-flight lock<br/>has_bought flag"]
        QUEUE["BullMQ: orders queue<br/>deterministic jobId"]
        BOARD["Bull-Board /admin/queues<br/>(behind Basic Auth)"]
    end

    subgraph WorkerTier["⚙️ BullMQ Consumer"]
        WORKER["Worker concurrency 5 / node<br/>= DB pool size"]
    end

    subgraph DatabaseTier["🗄️ PostgreSQL 16"]
        PG_PRIMARY[("Primary :5432<br/>Atomic SQL decrement<br/>UNIQUE(user_id, product_id)<br/>CHECK(remaining_stock >= 0)")]
        PG_REPLICA[("Replica :5433<br/>catalog reads only<br/>streaming replication")]
    end

    C1 & C2 --> NGINX
    NGINX -->|least_conn| APP1 & APP2 & APP3

    APP1 & APP2 & APP3 --> JWT
    APP1 & APP2 & APP3 -->|read| CACHE
    CACHE -.->|miss| PG_REPLICA
    APP1 & APP2 & APP3 -->|"MGET stock overlay"| LUA

    APP1 & APP2 & APP3 -->|write| LUA
    LUA -->|allowed| QUEUE
    LUA -->|rejected| NGINX

    QUEUE --> WORKER
    WORKER -->|"createQueryRunner('master')"| PG_PRIMARY
    PG_PRIMARY -->|streaming replication| PG_REPLICA
    WORKER -.->|invalidate metadata| CACHE
    QUEUE --- BOARD
```

> **หมายเหตุสำคัญ — แยก Redis 2 instance**
> `redis-cache` ตั้ง `maxmemory-policy allkeys-lru` เพราะเป็นแคชล้วน แต่ `redis-data` เก็บ **stock counter + BullMQ jobs** ซึ่งเป็น source of truth ชั่วคราว **ห้ามถูก evict เด็ดขาด** จึงต้อง `noeviction` + เปิด AOF
> ถ้ารวมไว้ตัวเดียว LRU จะลบ job หรือลบ `stock:*` ทิ้งกลางการทดสอบ → ระบบขายไม่ได้ทันที (ดู §7 Failure Matrix)
> *(อ้างอิง: Summary_Best_Practice B04 §ops, B05 §ops)*

---

## 2. ⚖️ Edge Layer: Nginx

```nginx
upstream backend {
    least_conn;                 # กระจายตาม in-flight connection จริง เหมาะกับ burst
    server app-1:3000 max_fails=3 fail_timeout=10s;
    server app-2:3000 max_fails=3 fail_timeout=10s;
    server app-3:3000 max_fails=3 fail_timeout=10s;
    keepalive 64;
}

server {
    listen 80;

    location / {
        proxy_pass http://backend;

        # ⚠️ บังคับ 2 บรรทัดนี้ ไม่งั้น `keepalive 64` ข้างบนไม่ทำงานเลย
        # Nginx จะคุย upstream ด้วย HTTP/1.0 + Connection: close
        # → TCP handshake ใหม่ทุก request (ตัวฉุด p95 อันดับ 1)
        proxy_http_version 1.1;
        proxy_set_header Connection "";

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # กัน upstream ค้างแล้วกิน worker_connections จนหมด
        proxy_connect_timeout 2s;
        proxy_send_timeout    5s;
        proxy_read_timeout    5s;
    }
}
```

> Nginx เวอร์ชันฟรีมีแค่ **passive health check** (`max_fails` / `fail_timeout`) — มันอ่านสถานะ `HEALTHCHECK` ของ Docker/Podman **ไม่ได้** อย่าออกแบบโดยคิดว่ามี active failover *(B06 slide-errata #1, #2)*

---

## 3. 🧱 NestJS Modular Structure

```
src/
├─ main.ts                        # global ValidationPipe, graceful shutdown, mount Bull-Board
├─ app.module.ts
├─ config/
│  ├─ database.config.ts          # buildTypeOrmOptions() — replication (master/slaves) + pool sizing
│  └─ env.validation.ts           # ตรวจ env ตอน bootstrap (fail fast)
├─ database/
│  ├─ data-source.ts              # CLI DataSource สำหรับ migration (master เท่านั้น)
│  ├─ migrate-and-seed.ts         # bootstrap ของ container: migration → seed DB → seed Redis
│  └─ migrations/                 # <ts>-InitSchema.ts (DDL ตาม §3.1.1)
├─ database_config/database.module.ts    # TypeOrmModule.forRootAsync
├─ bullmq_config/bullmq.module.ts        # BullModule.forRootAsync (redis-data) + queue 'orders'
├─ bull_board/                    # /admin/queues + Basic Auth
├─ logger/logger.module.ts        # nestjs-pino — single-line JSON + redact
├─ common/
│  ├─ middleware/correlation-id.middleware.ts
│  ├─ interceptors/logging.interceptor.ts
│  └─ filters/all-exceptions.filter.ts
├─ auth/                          # §4
│  ├─ auth.controller.ts          # POST /api/v1/auth/token
│  ├─ auth.service.ts             # sign JWT (ไม่แตะ DB)
│  ├─ jwt.strategy.ts             # verify only — zero I/O
│  ├─ jwt-auth.guard.ts
│  └─ dto/create-token.dto.ts
├─ products/                      # §5
│  ├─ products.controller.ts      # GET /api/v1/products
│  ├─ products.service.ts         # cache-aside + single-flight + stock overlay
│  ├─ entities/product.entity.ts
│  └─ dto/list-products.dto.ts
├─ orders/                        # §6
│  ├─ orders.controller.ts        # POST /api/v1/orders → 202
│  ├─ orders.service.ts           # Lua gatekeeper + enqueue (+ compensation)
│  ├─ orders.processor.ts         # BullMQ worker → Primary DB
│  ├─ entities/order.entity.ts
│  ├─ dto/create-order.dto.ts
│  └─ errors/sold-out.error.ts
├─ redis/
│  ├─ redis.module.ts             # 2 connections: cache / data
│  ├─ redis.service.ts
│  ├─ redis.constants.ts          # injection token
│  ├─ redis.keys.ts               # ⚠️ key-builder รวมศูนย์ ห้ามต่อ string เอง
│  └─ lua/                        # .lua โหลดด้วย defineCommand (nest-cli.json ต้อง copy เป็น asset)
├─ health/                        # /health/live, /health/ready
└─ seed/
   ├─ seed.ts                     # products-seed.json → DB (remaining_stock = available_stock)
   └─ seed-redis.ts               # DB → SET stock:flash_sale:* NX
```

> โครง folder ยึดแนวของ reference project (module folder + `entities/` + `dto/` + `*_config/` แยก)
> **migration อยู่ที่ `src/database/migrations/` ไม่ใช่ `src/migrations/`**

จัดโมดูล **ตาม domain (feature) ไม่ใช่ตาม layer** — controller ทำแค่ HTTP, business logic อยู่ที่ service, ไม่มี DB access ใน controller *(B02)*

---

### 3.1 🗄️ Database Schema — Entities + DDL

> เอกสารส่วนนี้คือ **สเปกของ `product.entity.ts` และ `order.entity.ts`** ที่ถูกอ้างถึงในโครงสร้างด้านบน
> **type ทุกตัวที่นี่มีผลกับ API contract (§3 ของ `CLAUDE.md`) โดยตรง** — เดาเองไม่ได้

#### 3.1.1 DDL (baseline migration)

```sql
-- src/database/migrations/<ts>-InitSchema.ts

CREATE TABLE products (
  id                    VARCHAR(32)    PRIMARY KEY,           -- 'p-1001' มาจาก seed — ห้าม generate เอง
  name                  VARCHAR(255)   NOT NULL,
  description           TEXT           NOT NULL DEFAULT '',
  price                 NUMERIC(10,2)  NOT NULL,              -- เงิน = NUMERIC เท่านั้น ห้าม float
  available_stock       INTEGER        NOT NULL,              -- สต็อกตั้งต้น — ห้าม UPDATE หลัง seed
  remaining_stock       INTEGER        NOT NULL,              -- คงเหลือจริง (source of truth)
  is_flash_sale_active  BOOLEAN        NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ    NOT NULL DEFAULT now(),

  CONSTRAINT chk_positive_stock CHECK (remaining_stock >= 0),
  CONSTRAINT chk_stock_ceiling  CHECK (remaining_stock <= available_stock),
  CONSTRAINT chk_price_positive CHECK (price >= 0)
);

CREATE TABLE orders (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     VARCHAR(64)  NOT NULL,                          -- = JWT claim `sub` — ไม่มี FK โดยเจตนา (§3.1.4)
  product_id  VARCHAR(32)  NOT NULL REFERENCES products(id),
  status      VARCHAR(16)  NOT NULL DEFAULT 'CONFIRMED',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT uq_user_product_order UNIQUE (user_id, product_id),   -- ⭐ ด่านที่ 4 ของ "1 ชิ้น/คน"
  CONSTRAINT chk_order_status CHECK (status IN ('CONFIRMED', 'CANCELLED'))
);

CREATE INDEX idx_orders_product ON orders (product_id);           -- ใช้ตอนพิสูจน์ Data Integrity (§9.3)
```

> `gen_random_uuid()` เป็น built-in ตั้งแต่ PostgreSQL 13 — บน PG 16 ไม่ต้องลง `pgcrypto`

**หมายเหตุเรื่อง index ของ read path** — ⚠️ **ฉบับก่อนหน้ามี `CREATE INDEX idx_products_flash_sale ... WHERE is_flash_sale_active = true` เอกสารนี้ตัดออกโดยตั้งใจ**
`GET /api/v1/products` แสดงสินค้า**ทุกตัว** (`meta.total = 20`) ไม่ได้ filter ตาม `is_flash_sale_active` เลย index ตัวนั้นจึงแทบไม่มีวันถูกใช้ (และตารางมีแค่ 20 แถว planner จะเลือก seq scan อยู่ดี)
→ **สิ่งที่จำเป็นจริงคือ `ORDER BY id` ที่แน่นอน** ไม่ใช่ index เพิ่ม เพราะ `LIMIT/OFFSET` ที่ไม่มี `ORDER BY` ที่ deterministic จะ **ข้ามหรือคืนแถวซ้ำ** ได้ ซึ่ง `id` เป็น PK มี index อยู่แล้ว

#### 3.1.2 Entity — `products/product.entity.ts`

```typescript
import { Column, Entity, PrimaryColumn } from 'typeorm';

// ⚠️ node-postgres คืนคอลัมน์ NUMERIC มาเป็น **string** เสมอ (กัน precision หาย)
// ถ้าไม่แปลง response จะเป็น "price": "2990.00" ซึ่ง **ผิด API contract** ที่บังคับเป็น number
// → k6 ของกลุ่มอื่นที่ assert `price === 2990` จะพังทันที
const numericTransformer = {
  to:   (value: number): number => value,
  from: (value: string | null): number => (value === null ? 0 : Number(value)),
};

@Entity('products')
export class Product {
  @PrimaryColumn({ type: 'varchar', length: 32 })
  id!: string;                       // ⚠️ ห้ามใช้ @PrimaryGeneratedColumn — id มาจาก seed

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'text', default: '' })
  description!: string;

  @Column({ type: 'numeric', precision: 10, scale: 2, transformer: numericTransformer })
  price!: number;

  @Column({ name: 'available_stock', type: 'int' })
  availableStock!: number;

  @Column({ name: 'remaining_stock', type: 'int' })
  remainingStock!: number;

  @Column({ name: 'is_flash_sale_active', type: 'boolean', default: false })
  isFlashSaleActive!: boolean;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
```

#### 3.1.3 Entity — `orders/order.entity.ts`

```typescript
import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

export enum OrderStatus {
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
}

@Entity('orders')
@Unique('uq_user_product_order', ['userId', 'productId'])
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'varchar', length: 64 })
  userId!: string;                   // = JWT `sub` เท่านั้น ห้ามรับจาก body (invariant §4 ข้อ 2)

  @Index()
  @Column({ name: 'product_id', type: 'varchar', length: 32 })
  productId!: string;

  @Column({ type: 'varchar', length: 16, default: OrderStatus.CONFIRMED })
  status!: OrderStatus;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
```

#### 3.1.4 การตัดสินใจที่ต้องรู้ ไม่งั้นจะ "แก้ให้ถูกหลัก" แล้วพัง

| # | การตัดสินใจ | เหตุผล | ถ้าทำตรงข้ามจะพังยังไง |
| :-- | :--- | :--- | :--- |
| 1 | **`price` เป็น `NUMERIC` + transformer** | เงินห้ามเป็น float; แต่ driver คืน string | response เป็น `"2990.00"` → **ผิด contract → กลุ่มอื่นยิงเราไม่ผ่าน** |
| 2 | **`products.id` เป็น `VARCHAR` PK ที่กำหนดเอง** | `p-1001` มาจาก seed และ §9.3 query ด้วยค่านี้ | ใช้ `@PrimaryGeneratedColumn('uuid')` → **seed เข้าไม่ได้ทั้งชุด** |
| 3 | **ไม่มีตาราง `users` และ `user_id` ไม่มี FK** | `/auth/token` ออก token ให้ `userId` อะไรก็ได้โดย **ไม่แตะ DB** (§4) — ไม่มี user จริงในระบบ | เติม FK → **INSERT order พังทุกใบ** เพราะไม่มีแถวใน `users` |
| 4 | **`available_stock` ห้าม UPDATE หลัง seed** | เป็นตัวหารของทุกการพิสูจน์ใน §9.3 และเป็นเพดานของ `chk_stock_ceiling` | ถ้าขยับ จะพิสูจน์ oversell ไม่ได้อีกเลย |
| 5 | **`orders` ไม่มีสถานะ `RESERVED`** | worker `INSERT` ครั้งเดียวตอน commit ด้วย `CONFIRMED` — ช่วง "จองแล้วยังไม่ยืนยัน" อยู่ใน **Redis เท่านั้น** | สร้าง enum ครบ 3 ค่าแล้วรอข้อมูลที่ไม่มีวันมา (เทียบ state machine ที่ [`diagrams.md`](./diagrams.md) §7) |
| 6 | **ไม่มีคอลัมน์ `quantity`** | โจทย์บังคับ 1 ชิ้น/คน และ `UNIQUE (user_id, product_id)` เป็นตัวบังคับ | มี `quantity` เมื่อไหร่ `UNIQUE` ก็กัน oversell ไม่ได้อีก |

> **`chk_stock_ceiling` ทำอะไรได้และทำอะไรไม่ได้** — มันกันไม่ให้ `remaining_stock` โตเกินสต็อกตั้งต้น (เช่นถ้าอนาคตมี path คืนสต็อกใน DB)
> ⚠️ แต่ **มันจับ drift ระหว่าง Redis กับ DB ไม่ได้** เพราะ compensation เกิดฝั่ง Redis ล้วน ส่วน `remaining_stock` ใน DB ไม่เคยเพิ่มขึ้นเลยในดีไซน์ปัจจุบัน — ตัวจับ drift ตัวเดียวที่มีคือ **§9.3 ข้อ 4**

#### 3.1.5 การแมป seed → คอลัมน์ → response

| `products-seed.json` | คอลัมน์ | field ใน response (§3 ของ `CLAUDE.md`) |
| :--- | :--- | :--- |
| `productId` | `id` | `productId` |
| `name` | `name` | `name` |
| `description` | `description` | *(ไม่ส่งออก)* |
| `price` | `price` `NUMERIC(10,2)` | `price` — **number** |
| `availableStock` | `available_stock` **และ** `remaining_stock` *(ตอน seed ตั้งเท่ากัน)* | `availableStock` |
| — | `remaining_stock` | `remainingStock` — ⚠️ **response อ่านจาก Redis counter ไม่ใช่จากคอลัมน์นี้** (§5.2) |
| `isFlashSaleActive` | `is_flash_sale_active` | `isFlashSaleActive` |

> `pnpm run seed` ตั้ง `remaining_stock = available_stock` แล้ว `pnpm run seed:redis` จึงคัดลอกค่านั้นไปเป็น `stock:flash_sale:{id}` ด้วย `SET ... NX`
> **ลำดับนี้สลับไม่ได้** และคอลัมน์ `remaining_stock` ยังเป็น **source of truth** เสมอ ส่วน counter ใน Redis เป็นเพียงสำเนาที่เร็วกว่า

#### 3.1.6 จุดที่ write ทั้งหมดไปรวมกัน

worker ทุกตัวใน 3 instance (รวม 15 concurrent — §8) `UPDATE` **แถวเดียวกัน** คือ `products` ของ `p-1001`
→ PostgreSQL จะ **serialize พวกมันที่ row lock ของแถวนั้น** ซึ่ง **ถูกต้องและตั้งใจ**: ของมี 50 ชิ้น = `UPDATE` สำเร็จ 50 ครั้ง ไม่ใช่ปริมาณที่ต้องกังวล
ส่วน `INSERT INTO orders` ขอแค่ `KEY SHARE` บนแถว products (จาก FK) ซึ่ง **ไม่ชนกับ `FOR NO KEY UPDATE`** ที่ `UPDATE` ถือไว้ จึงไม่เกิด lock escalation

> ✅ นี่คือเหตุผลที่ **PostgreSQL ไม่ใช่คอขวด** ในระบบนี้ — คอขวดอยู่ที่ `redis-data` (ดู [`architecture-rationale.md`](./architecture-rationale.md) §6 Q3)

---

## 4. 🔐 Stateless Authentication (JWT)

โจทย์บังคับ **JWT + ห้ามใช้ in-memory session** เพราะทั้ง 3 instance ต้อง verify token ได้เองโดยไม่ต้องแชร์ state

### 4.1 หลักการ
- **HS256 + shared secret** จาก `JWT_SECRET` (env) — ทั้ง 3 instance ใช้ secret เดียวกัน จึง verify ข้าม instance ได้
- **Verify แบบ zero-I/O**: ห้าม query DB/Redis ตอน validate token เด็ดขาด ที่ 500 concurrent มันจะกลายเป็นคอขวดทันที
- `userId` ที่ใช้เป็น key ใน Redis (§6.1) และเป็น `orders.user_id` **ต้องมาจาก JWT claim `sub` เท่านั้น** ห้ามรับจาก request body — ไม่งั้นสวมสิทธิ์กันได้และ dedup พังทั้งระบบ
- ข้อจำกัดที่ยอมรับ: JWT **เพิกถอนไม่ได้** จึงตั้ง TTL สั้น (`15m`) พอสำหรับ load test *(B06)*

### 4.2 `POST /api/v1/auth/token`
```jsonc
// Request
{ "userId": "user-999" }

// Response 200
{ "status": "success", "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6..." }
```
เป็นการ **จำลอง** login — ไม่ตรวจรหัสผ่าน, ไม่แตะ DB, แค่ sign token. โจทย์ระบุชัดว่า endpoint นี้ **ไม่ถูกวัด performance**

### 4.3 ใช้กับ Order
`POST /api/v1/orders` ต้องมี `Authorization: Bearer <token>` — `JwtAuthGuard` ปฏิเสธ 401 ก่อนแตะ Redis เสมอ

---

## 5. ⚡ Read Path (1,000 concurrent users)

### 5.1 แยก Metadata ออกจาก Stock — หัวใจของข้อนี้

โจทย์ระบุเป็น **"เงื่อนไขสำคัญ"** ว่า `remainingStock` ต้องถูกต้องเสมอ ถ้าแคชทั้ง object รวม stock ไว้ด้วยกัน จะต้อง invalidate ทุกครั้งที่มีคนซื้อ = แคชพังตลอดเวลาระหว่าง flash sale (hit ratio ตกฮวบ)

| ชนิดข้อมูล | ตัวอย่างฟิลด์ | ที่เก็บ | TTL |
| :--- | :--- | :--- | :--- |
| **Metadata** (แทบไม่เปลี่ยน) | `productId`, `name`, `price`, `availableStock`, `isFlashSaleActive` | `redis-cache` → `catalog:page:{p}:limit:{l}` | 30–60s **+ jitter** |
| **Stock** (เปลี่ยนตลอด) | `remainingStock` | `redis-data` → `stock:flash_sale:{productId}` | ไม่มี TTL (`noeviction`) |

> `availableStock` = สต็อกตั้งต้น (คงที่, มาจาก seed) · `remainingStock` = คงเหลือจริง (นับถอยหลัง) — response ต้องมีทั้งคู่

### 5.2 Read Flow — Cache-Aside + Stock Overlay

```
GET /api/v1/products?page=1&limit=10
  │
  ├─ 1) GET catalog:page:1:limit:10  ────────────► HIT → metadata[]
  │                                   └─ MISS ──► single-flight → Replica DB
  │                                                → SETEX + jitter → metadata[]
  │
  ├─ 2) MGET stock:flash_sale:p-1001 ... (1 roundtrip, N สินค้า)
  │
  └─ 3) merge: { ...metadata, remainingStock: Number(stockValue) }
        → { status, data[], meta{ total, page, limit, totalPages } }
```

**ขั้นตอน (2) และ (3) คือคำตอบของ "เงื่อนไขสำคัญ"** — metadata อยู่ในแคชได้นานเป็นนาทีโดยไม่ต้อง invalidate เลย ขณะที่ `remainingStock` อ่านสดจาก counter ทุก request ด้วยต้นทุน 1 `MGET`

### 5.3 กัน Cache Stampede
- **Single-flight promise memoization** (ใช้จริง): ใน 1 process ถ้ามี request หน้าเดียวกันเข้ามาพร้อมกันตอน cache miss ให้แชร์ Promise เดียวกัน → query DB ครั้งเดียว. **แก้ปัญหาได้ ~90% ด้วยโค้ดสิบกว่าบรรทัด** และเป็น per-process cache ของ *in-flight request* ไม่ใช่การเก็บ state ข้ามคำขอ จึงไม่ผิดกฎ stateless
- **TTL jitter** (ใช้จริง): `ttl = 30 + random(0..30)` วินาที — key ที่ถูกเซ็ตพร้อมกันตอน warm-up จะไม่หมดอายุพร้อมกัน (avalanche) *(B04)*
- **Probabilistic early expiration / XFetch** — *ทางเลือก, ไม่ใช้ในการส่งงาน*: สูตร `−β · δ · ln(rand()) > TTL_remaining` ใช้ refresh ล่วงหน้าใน background. ที่ TTL 60s กับ k6 run ~60s มันแทบไม่ทำงานเลยและพิสูจน์ในรายงานไม่ได้ — เขียนอธิบายไว้ได้แต่ไม่ต้อง implement

> ❌ **ไม่ใช้ L1 in-memory LRU cache** — ถ้าเก็บผลลัพธ์ที่มี `remainingStock` ไว้ใน RAM ของแต่ละ instance นาน 1–2 วินาที ทั้ง 3 instance จะตอบสต็อกไม่ตรงกัน ขัดกับ "เงื่อนไขสำคัญ" ของโจทย์โดยตรง และขัดกฎ stateless *(B06)*

### 5.4 Cache Invalidation
- **Metadata cache**: invalidate เฉพาะตอนแก้ข้อมูลสินค้าจริง (ชื่อ/ราคา) — ไม่ต้องแตะตอนมีคนซื้อ
- **Stock**: ไม่ต้อง invalidate เพราะ worker `DECR` counter ตัวเดียวกันที่ read path อ่าน → เห็นค่าใหม่ทันที
- Worker ยังคงส่ง invalidate metadata หลังตัดสต็อกสำเร็จ (§6.3) เพื่อรองรับกรณีสินค้าเปลี่ยนสถานะ `isFlashSaleActive`
  — แต่ **debounce ไม่เกิน 1 ครั้ง/วินาที** (แก้ 2026-08-26): ของ 50 ชิ้นหมดใน window ~300 ms
  = ล้างทั้งแคช 50 ครั้งรวดตอนที่ reader 1,000 คนกำลังยิงอยู่พอดี ซึ่งไม่ใช่สิ่งที่โจทย์ข้อ 2.3 กฎ 4 ต้องการ
  เป็น trailing debounce จึงไม่มีการล้างที่หายไปเฉยๆ
- ลำดับที่ถูก: **update DB → แล้วค่อย DEL cache** (ไม่ใช่ DEL ก่อน) และพึ่ง TTL เป็น safety net เสมอ *(B04)*
- ❌ ห้ามใช้ `KEYS pattern` ในการล้างแคช — เป็น O(N) และบล็อก Redis ทั้งตัว ใช้ `SCAN` หรือ key ที่คำนวณตรงได้ *(B04 slide-errata #1)*

---

## 6. 🛡️ Write Path — 4-Tier Defense (500 VUs แย่ง 50 ชิ้น)

```
POST /api/v1/orders   { productId }   + Bearer JWT
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ Tier 0: JwtAuthGuard  → userId = jwt.sub   (401 ถ้าไม่ผ่าน)   │
└───────────────────────────┬──────────────────────────────────┘
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ Tier 1: Redis Lua Gatekeeper  (1 roundtrip, atomic)          │
│  • เคยซื้อสำเร็จแล้ว?      → 409                              │
│  • มี request in-flight?   → 429  (กันกดรัว 2-3 ครั้ง)        │
│  • stock counter <= 0?     → 409  (450 คนจบที่นี่ ~ไม่กี่ ms)  │
│  • ผ่าน: DECR stock + SET in-flight lock                     │
└───────────────────────────┬──────────────────────────────────┘
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ Tier 2: BullMQ  jobId = order:{userId}:{productId}           │
│  • enqueue ล้ม → ชดเชยคืนสต็อกทันที (สำคัญ! ดู §6.2)          │
│  • สำเร็จ → ตอบ 202 Accepted ทันที ไม่รอ DB                   │
└───────────────────────────┬──────────────────────────────────┘
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ Tier 3: Worker → PostgreSQL **Primary เท่านั้น**              │
│  UPDATE ... SET remaining_stock = remaining_stock - 1         │
│  WHERE id = $1 AND remaining_stock > 0     (atomic)          │
└───────────────────────────┬──────────────────────────────────┘
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ Tier 4: DB Constraints (ด่านสุดท้าย ทะลุไม่ได้)                │
│  UNIQUE (user_id, product_id) · CHECK (remaining_stock >= 0)  │
└──────────────────────────────────────────────────────────────┘
```

### 6.1 Tier 1: Atomic Lua Gatekeeper

รวม 3 การตรวจ + 2 การเขียน ไว้ใน **1 roundtrip ที่ atomic** — Redis เป็น single-threaded ระหว่างรัน Lua จึงไม่มีทาง interleave ระหว่าง 500 requests

```lua
-- gatekeeper.lua
-- KEYS[1] lock:order:{userId}:{productId}     in-flight mutex
-- KEYS[2] stock:flash_sale:{productId}        fast stock counter
-- KEYS[3] bought:{productId}:{userId}         committed flag
-- ARGV[1] lock_ttl_ms   (เช่น 30000)
-- ARGV[2] requestToken — สุ่มใหม่ **ทุกคำขอ** ไม่ใช่ jobId
--         (jobId ซ้ำทุกครั้งที่คนเดิมขอของเดิม → compare-and-delete แยกการถือครองไม่ออก)

-- 0) stock counter ต้องมีอยู่จริง ห้ามตีความ nil ว่า 0
--    (nil = ยังไม่ seed หรือถูก evict → ต้องแยกออกจาก "ของหมด")
local raw = redis.call('GET', KEYS[2])
if raw == false then
    return -4            -- STOCK_NOT_INITIALIZED → 503 Service Unavailable
end

-- 1) เคยซื้อสำเร็จไปแล้ว
if redis.call('EXISTS', KEYS[3]) == 1 then
    return -1            -- ALREADY_PURCHASED → 409 Conflict
end

-- 2) มีคำสั่งซื้อกำลังประมวลผลอยู่ (กดรัว)
if redis.call('EXISTS', KEYS[1]) == 1 then
    return -2            -- REQUEST_IN_FLIGHT → 429 Too Many Requests
end

-- 3) ของหมด
if tonumber(raw) <= 0 then
    return -3            -- SOLD_OUT → 409 Conflict
end

-- 4) จองสิทธิ์: หักสต็อก + ตั้ง mutex พร้อมกันแบบ atomic
redis.call('DECR', KEYS[2])
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[1])
return 1                 -- ALLOWED
```

> **ทำไม `-4` ถึงสำคัญ**: โค้ดแบบ `tonumber(redis.call('GET', k) or '0')` จะแปลง "ไม่มี key" เป็น "สต็อก 0" → ถ้า Redis restart หรือ key ถูก evict ระบบจะตอบ *ของหมด* ตลอดกาลโดยไม่มีใครรู้ว่าผิดปกติ. แยก error code ออกมาแล้วตอบ 503 ทำให้ปัญหานี้ปรากฏใน dashboard ทันที

**การ seed stock counter** (ขาดไม่ได้):
- ตอน bootstrap ให้ตั้ง `SET stock:flash_sale:{id} <remaining_stock จาก DB> NX` สำหรับสินค้า flash sale ทุกตัว — `NX` กันไม่ให้ instance ที่ 2 และ 3 เขียนทับค่าที่ถูกหักไปแล้ว
- `redis-data` ต้อง `maxmemory-policy noeviction` + เปิด AOF (§1)

### 6.2 Tier 2: Enqueue + Compensation

```typescript
// orders.service.ts
async createOrder(userId: string, productId: string) {
  const jobId = `order:${userId}:${productId}`;   // deterministic → BullMQ ปฏิเสธซ้ำเอง

  // token สุ่มใหม่ทุกคำขอ — ใช้เป็นค่าใน lock (ให้ compare-and-delete แยกการถือครองได้จริง)
  // และเป็นตัวพิสูจน์ว่า job ที่อยู่ในคิวเป็นของคำขอนี้
  const requestToken = randomUUID();

  const verdict = await this.redis.gatekeeper(userId, productId, requestToken, LOCK_TTL_MS);

  switch (verdict) {
    case -1: throw new ConflictException('You already purchased this product');
    case -2: throw new HttpException('Order already in progress', 429);
    case -3: throw new ConflictException('Sold out');
    case -4: throw new ServiceUnavailableException('Stock not initialized');
  }

  // ⚠️ สต็อกถูกหักใน Redis ไปแล้ว ณ จุดนี้
  // ถ้า enqueue ล้มแล้วไม่ชดเชย = สต็อก 1 ชิ้นหายถาวร
  // → remainingStock จะไม่มีวันลงถึง 0 → ตกเกณฑ์ Data Integrity Proof
  let job: Job<OrderJobData> | undefined;
  try {
    job = await this.ordersQueue.add('process-order', { userId, productId, correlationId }, {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 200 },  // + jitter ที่ฝั่ง worker
      removeOnComplete: { count: 5000 },             // ต้องเก็บพอให้ dashboard นับ Completed ได้
      removeOnFail: { count: 5000 },                 // เก็บหลักฐาน job ที่ fail ไว้โชว์
    });
  } catch (err) {
    await this.redis.compensate(userId, productId, requestToken);  // INCR stock + ปล่อย lock (atomic)
    throw new ServiceUnavailableException('Queue unavailable');
  }

  // ⚠️ FIX (b) v2 — BullMQ เจอ `jobId` ซ้ำแล้ว **คืน job เดิมเงียบๆ ไม่ throw**
  // ถ้าพึ่ง catch อย่างเดียว: DECR ไปแล้ว + queue.add() เป็น no-op = สต็อกหาย 1 ชิ้นถาวร
  //
  // ❌ **ห้ามเทียบกับ `job.data` ที่ `add()` คืนมา** — มันคือ object ที่เราส่งเข้าไปเอง
  //    `Job.create()` เขียนกลับแค่ `job.id` ไม่เคยอ่าน data จาก Redis
  //    (node_modules/bullmq/dist/cjs/classes/job.js:124-135) และตอน jobId ซ้ำ
  //    ฝั่ง Lua แค่ `return jobId` โดยทิ้ง payload ใหม่ (addStandardJob-9.js:445)
  //    → เทียบยังไงก็ตรงเสมอ = เช็คตาย (ฉบับก่อนของเอกสารนี้ผิดตรงนี้)
  //
  // ✅ ต้อง **อ่าน job กลับจาก Redis** แล้วเทียบ token ที่เก็บอยู่จริง
  if (!job) {
    await this.redis.compensate(userId, productId, requestToken);
    throw new ServiceUnavailableException('Queue unavailable');
  }

  const stored = await this.ordersQueue.getJob(jobId);   // Job.fromId → HGETALL
  if (!stored) {
    // ยืนยันไม่ได้ ≠ เป็นของคนอื่น — **ห้ามคืนสต็อก** (คืนผิดตอนของขายแล้วแย่กว่าไม่คืน)
    this.logger.error(`cannot verify queued job ${jobId} — NOT compensating`);
  } else if (stored.data?.requestToken !== requestToken) {
    await this.redis.compensate(userId, productId, requestToken);
    throw new ConflictException('Order already processed');
  }

  return { status: 'processing', orderJobId: jobId, message: 'Your order is in the queue.' };
}
```

- `removeOnComplete` ตั้ง `count` ให้มากกว่าจำนวน job ทั้งหมดของการทดสอบ (500) ไม่งั้น Bull-Board จะโชว์ **Completed Jobs** ไม่ครบ ซึ่งเป็นสิ่งที่โจทย์บังคับให้แสดง
- `attempts` มาคู่กับข้อบังคับว่า **handler ต้อง idempotent** เสมอ — BullMQ เป็น at-least-once *(B05)*
- BullMQ **ไม่มี** job option ชื่อ `timeout` (นั่นคือ Bull v4) ถ้าต้องการ ให้ทำเองด้วย `Promise.race` *(B05 slide-errata #2)*

### 6.3 Tier 3: Worker — จุดที่พลาดกันบ่อยที่สุด

> ⚠️ **กับดัก Read-Write Split**: `repository.findOne()` จะวิ่งไป **Replica** โดยอัตโนมัติ ซึ่งมี replication lag 10–100ms → worker อ่านเจอสต็อกเก่า → race condition ทันที
> Worker **ต้อง** ใช้ `dataSource.createQueryRunner('master')` เท่านั้น

```typescript
// orders.processor.ts
@Processor('orders', { concurrency: 5 })   // = ขนาด pool ของ master (§8) ห้ามเกิน
export class OrdersProcessor extends WorkerHost {
  async process(job: Job<OrderJobData>) {
    const { userId, productId } = job.data;
    const queryRunner = this.dataSource.createQueryRunner('master');
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let committed = false;
    try {
      // ── Atomic decrement: ไม่ต้อง SELECT ก่อน จึงไม่มี TOCTOU และไม่ถือ lock นาน ──
      const result = await queryRunner.manager
        .createQueryBuilder()
        .update(Product)
        .set({ remainingStock: () => 'remaining_stock - 1' })
        .where('id = :productId AND remaining_stock > 0', { productId })
        .execute();

      if (result.affected === 0) {
        throw new SoldOutError();     // permanent — ห้าม retry
      }

      await queryRunner.manager.insert(Order, {
        userId, productId, status: OrderStatus.CONFIRMED,
      });

      await queryRunner.commitTransaction();
      committed = true;               // ◄── หมุดชี้ขาดของทุก branch ข้างล่าง
    } catch (err) {
      if (!committed) await queryRunner.rollbackTransaction();

      // 23505 = unique violation → job นี้เคยสำเร็จไปแล้ว (retry ซ้ำ)
      // ถือว่า "สำเร็จ" ไม่ต้องคืนสต็อก ไม่ต้อง retry — นี่คือ idempotency
      if (err.code === '23505') {
        await queryRunner.release();
        return { status: 'already_confirmed' };
      }

      // ⚠️ FIX (a) — คืนสต็อก **เฉพาะตอนล้มเหลวถาวรจริง** เท่านั้น
      // ถ้าคืนทุกครั้งที่ catch: attempt 1 เจอ deadlock 40P01 → คืนสต็อก → attempt 2 สำเร็จ
      // → Redis สูงกว่า DB ถาวร 1 หน่วย ตกเกณฑ์ §9.3 ข้อ 4 (`compensated:{jobId}` กันได้แค่คืน "ซ้ำ")
      // compensate เป็น Lua ที่ INCR stock + DEL lock ในสเต็ปเดียว และ
      // guard ด้วย key `compensated:{jobId}` ไม่ให้คืนซ้ำเมื่อ retry
      const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

      if (err instanceof SoldOutError) {
        // ⚠️ **ห้ามคืนสต็อกตรงนี้** (แก้ 2026-08-26)
        // SoldOutError = Redis บอก "ผ่าน" แต่ DB บอก "หมด" → Redis สูงกว่า DB อยู่ก่อนแล้ว
        // ถ้าคืน จะดัน Redis ขึ้นอีก → ปล่อยคนถัดไป → ตาย sold-out อีก → คืนอีก **วนไม่จบ**
        // counter จะลู่เข้าหา 1 ไม่มีวันถึง 0 = ตกเกณฑ์ §9.3 ข้อ 4
        // การไม่คืนทำให้ counter ลู่ลงเข้าหา DB แล้วหยุดเอง (lock ปล่อยให้ TTL เก็บ)
        return { status: 'sold_out' };   // ❌ อย่า throw — permanent failure
      }

      if (isFinalAttempt) {
        await this.redis.compensateOnce(job.id, userId, productId, requestToken);
      }

      await queryRunner.release();
      throw err;                                                       // ✅ transient → retry
    } finally {
      if (queryRunner.isReleased === false) await queryRunner.release();
    }

    // ── Side effects หลัง commit — แยกออกมานอก try เดิมโดยเจตนา ──
    // ถ้าโค้ดพวกนี้ throw ต้อง **ห้าม** ไปเข้า catch ข้างบนเด็ดขาด
    // ไม่งั้นจะ "คืนสต็อกใน Redis ทั้งที่ DB ตัดไปแล้ว" → Redis บวกเกินจริง → oversell
    try {
      await this.redis.markBought(productId, userId);       // SET bought:{p}:{u}
      await this.redis.releaseInFlightLock(userId, productId, requestToken);  // compare-and-delete
      await this.redis.invalidateCatalogCache();
    } catch (e) {
      this.logger.error({ msg: 'post-commit side effect failed', jobId: job.id, err: e });
      // กลืน error ทิ้ง — order สำเร็จไปแล้ว TTL ของ lock จะเก็บกวาดให้เอง
    }

    return { status: 'confirmed' };
  }
}
```

**สามจุดที่ต่างจากโค้ดที่เขียนกันทั่วไป และเป็นจุดชี้ขาด:**
1. **`committed` flag** — กัน `rollbackTransaction()` ถูกเรียกบน transaction ที่ commit ไปแล้ว (TypeORM จะ throw ทับ error เดิม กลบสาเหตุจริง)
2. **Side effect หลัง commit อยู่นอก try เดิม** — ป้องกันเคสที่ Redis สะดุดหลัง DB commit แล้วระบบไป "คืนสต็อก" ทั้งที่ของขายไปแล้วจริง
3. **`compensateOnce` guard ด้วย jobId + คืนเฉพาะ attempt สุดท้าย** — BullMQ retry ได้ 3 ครั้ง `compensated:{jobId}` กันการคืน *ซ้ำ* ส่วน `isFinalAttempt` กันการคืน *job ที่ยังไม่ตาย* (ต้องมีทั้งคู่)
4. **`SoldOutError` → `return` ไม่ใช่ `throw`** — เป็น permanent failure การ retry ไม่มีทางสำเร็จ มีแต่เปลือง attempt *(B05 slide-errata #6, #8)*

### 6.4 Tier 4: Database Constraints

> 📐 **schema เต็มอยู่ที่ §3.1** — constraint พวกนี้ถูกสร้างมาพร้อมตารางใน baseline migration แล้ว ไม่ใช่ `ALTER TABLE` ทีหลัง
> ส่วนนี้ยกมาย้ำเฉพาะตัวที่ทำหน้าที่เป็น **ด่านที่ 4** ของ write path

```sql
-- ⭐ 1 ชิ้น/คน — ทะลุไม่ได้แม้โค้ดจะมีบั๊ก
CONSTRAINT uq_user_product_order UNIQUE (user_id, product_id)

-- ⭐ zero-oversell — ต่อให้ Lua, BullMQ และ atomic UPDATE พังพร้อมกัน
CONSTRAINT chk_positive_stock CHECK (remaining_stock >= 0)
```

Constraint คือด่านที่ **ไม่พึ่งความถูกต้องของโค้ดเลย** — ต่อให้ Redis พัง, worker มีบั๊ก, หรือมี process แปลกปลอมเขียนเข้ามา ฐานข้อมูลก็ยังปฏิเสธ. ทุกอย่างข้างบนคือ optimization เพื่อ *ไม่ให้ traffic ไปถึงตรงนี้*, ส่วนตรงนี้คือ *ความถูกต้อง*

Error mapping: `23505` → 409 · `23514` (check) → 400 · `40P01` (deadlock) → retry แบบ exponential + jitter *(B03)*

---

## 7. 🔥 Failure Matrix

| สถานการณ์ | ผลถ้าไม่จัดการ | มาตรการในเอกสารนี้ |
| :--- | :--- | :--- |
| `redis-data` restart / stock key หาย | ตอบ "ของหมด" ตลอดกาลอย่างเงียบๆ | Lua คืน `-4` → 503 + seed ตอน bootstrap ด้วย `NX` (§6.1) |
| Redis LRU evict BullMQ job | order หายไปเฉยๆ ลูกค้าได้ 202 แต่ไม่มีของ | แยก `redis-data` เป็น `noeviction` + AOF (§1) |
| `queue.add()` ล้มหลัง DECR | สต็อกหายถาวร → `remainingStock` ไม่ถึง 0 | compensate ใน `catch` (§6.2) |
| Worker ตายหลัง commit ก่อน `markBought` | คืนสต็อกทั้งที่ขายไปแล้ว → oversell | side effect อยู่นอก try เดิม + `committed` flag (§6.3) |
| BullMQ retry job ที่สำเร็จแล้ว | insert ซ้ำ / คืนสต็อกซ้ำ | `UNIQUE` → จับ `23505` แล้ว return + `compensateOnce` (§6.3) |
| Worker อ่านสต็อกจาก Replica | race condition จาก replication lag | บังคับ `createQueryRunner('master')` (§6.3) |
| Worker concurrency > DB pool | job timeout รอ connection | concurrency 5 = pool 5 (§8) |
| ผู้ใช้กดรัว 2–3 ครั้ง | ได้ของเกิน 1 ชิ้น | in-flight lock + `bought` flag + `UNIQUE` (§6.1, §6.4) |
| Cache หมดอายุพร้อมกันตอน 1,000 VUs | DB โดนถล่ม (stampede/avalanche) | single-flight + TTL jitter (§5.3) |

---

## 8. 🎛️ Connection Pooling & Resource Sizing

**สูตรที่ต้องใช้** *(B06 — เป็นจุดที่สไลด์คำนวณผิด)*:
```
ต่อ "เซิร์ฟเวอร์แต่ละตัว" แยกกัน:
  connections บน primary = instances × poolSize   ≤ 80% ของ max_connections ของ primary
  connections บน replica = instances × poolSize   ≤ 80% ของ max_connections ของ replica
```
TypeORM replication สร้าง pool **แยกต่อ master และต่อ slave แต่ละตัว** ไม่ใช่ pool เดียว

> ⚠️ **แก้จากฉบับก่อน (2026-08-26)** — เดิมเขียนว่า `instances × (1 + replicas) × poolSize ≤ 80% ของ max_connections`
> ซึ่ง **มิติผิด**: มันบวก connection ที่ไปลงคนละเซิร์ฟเวอร์เข้าด้วยกัน แล้วเอาไปเทียบกับ limit ของเซิร์ฟเวอร์เดียว
> ค่าที่ถูกคือ **30 บน primary และ 30 บน replica แยกกัน** ไม่ใช่ 60 ที่ต้องเทียบกับ 100

| องค์ประกอบ | ค่า | เหตุผล |
| :--- | :--- | :--- |
| `poolSize` ต่อ DataSource | **10** | 3 instances × (1 master + 1 replica) × 10 = **60 connections** |
| Primary `max_connections` | 100 | ใช้จริง 30 (master pool) → 30% ปลอดภัย |
| Replica `max_connections` | ≥ 100 | ใช้จริง 30 (slave pool) — hot standby ต้อง ≥ ของ primary |
| **Worker concurrency** | **5 / instance** | ⚠️ **ห้ามเกิน poolSize** ของ master. รวม 15 concurrent writes ทั้งคลัสเตอร์ ซึ่งเกินพอสำหรับของ 50 ชิ้น |
| Redis: `redis-cache` | 1 client (multiplexed) | แคชล้วน `allkeys-lru` |
| Redis: `redis-data` | 3 clients | ① คำสั่งทั่วไป/Lua ② BullMQ producer ③ BullMQ worker (blocking `BZPOPMIN` ใช้ connection แยกเสมอ) |
| Nginx | `worker_connections 10240`, `keepalive 64` | ต้องมาคู่กับ `proxy_http_version 1.1` (§2) |

> **ข้อควรระวัง (แก้ 2026-08-26)** — ฉบับก่อนเขียนว่า "ทั้ง API และ worker แย่ง pool 10 ตัวเดียวกัน" **ซึ่งไม่จริงกับโค้ดที่เขียนจริง**
> เพราะเปิด `replication` + `defaultMode: 'slave'` ไว้ TypeORM จึงสร้าง **pool แยกต่อ master และต่อ slave**
> → API อ่าน catalog ลง **slave pool** ส่วน worker ขอ `createQueryRunner('master')` ลง **master pool** — **ไม่เคยชนกัน**
>
> `WORKER_CONCURRENCY = 5` จึงไม่ได้มีที่มาจากการแย่ง pool (จะเป็น 10 ก็ยังปลอดภัย)
> เพดานจริงของ write path คือ **row lock ของสินค้าแถวเดียว** ที่ทุก worker ยิงใส่ ซึ่ง serialize อยู่แล้วไม่ว่า concurrency จะเป็นเท่าไหร่
>
> ⚠️ **แต่ถ้าวันไหนตัด replica ทิ้ง** master กับ slave จะยุบเป็น pool เดียว แล้วคำเตือนเดิมจะ *กลายเป็นจริงขึ้นมา*
> ต้อง re-derive `DB_POOL_SIZE` (เช่นเป็น 20) **ก่อน** แก้ compose ไม่ใช่หลัง

---

## 9. 📊 Observability & Load Test (k6)

### 9.1 สิ่งที่ต้องแสดงตามโจทย์

| หมวด | Metric | เป้าหมาย | ดูจากไหน |
| :--- | :--- | :--- | :--- |
| **Cache** | Hit / Miss Ratio | ≥ 90% | `redis-cli INFO stats` → `keyspace_hits` / `keyspace_misses` |
| **Queue** | Waiting / Active / Completed / **Failed** | Completed = 50, Failed = job ของคนที่ของหมด | Bull-Board `/admin/queues` |
| **Throughput** | Req/s, **p95 latency**, Error rate | p95 read < 200ms, error < 0.1% | k6 summary |
| **DB Primary** | Active connections, lock wait | active < 30 | `pg_stat_activity` |
| **DB Replica** | Replication lag | < 1s | `pg_stat_replication` |

> วัด **percentile ไม่ใช่ average** — p95/p99 คือคนที่โกรธที่สุดและมักเป็นคนที่ข้อมูลเยอะที่สุด *(B06)*
> Bull-Board **ต้องมี Basic Auth คลุม** เพราะมันเปิดดู payload และกด retry/remove job ได้ *(B05 slide-errata #10)*

### 9.2 โครงสร้าง `loadtest.js` (k6)

```js
export const options = {
  scenarios: {
    read_heavy: {                       // 1,000 concurrent readers
      executor: 'constant-vus', vus: 1000, duration: '60s',
      exec: 'readProducts', startTime: '5s',
    },
    write_burst: {                      // 500 คนแย่ง 50 ชิ้น พร้อมกัน
      executor: 'per-vu-iterations', vus: 500, iterations: 3,
      exec: 'placeOrder', startTime: '20s', maxDuration: '30s',
    },
  },
  thresholds: {
    'http_req_duration{scenario:read_heavy}':  ['p(95)<200'],
    'http_req_duration{scenario:write_burst}': ['p(95)<300'],
  },
};
```

- **setup()**: วนขอ JWT จาก `/api/v1/auth/token` ให้ `user-1` … `user-500` → เก็บเป็น array ส่งต่อเข้า VU (แต่ละ VU ใช้ token ของตัวเอง **ห้ามซ้ำ**)
- **readProducts**: สุ่ม `page` และ `limit` เพื่อไม่ให้ยิงโดน cache key เดียวตลอด — ไม่งั้น hit ratio ที่วัดได้จะสวยเกินจริง
- **placeOrder**: `iterations: 3` คือการ **จำลองการกดรัว** ตามโจทย์ — คาดหวัง 1 ครั้งได้ 202 อีก 2 ครั้งได้ 429/409 ซึ่งเป็นหลักฐานว่า in-flight lock ทำงาน
- อย่านับ 409/429 เป็น error ใน threshold — มันคือ **พฤติกรรมที่ถูกต้อง** ให้ `check()` แยก tag

### 9.3 Data Integrity Proof (เกณฑ์ตัดสิน)

```sql
-- 1) สต็อกต้องเป็น 0 พอดี ไม่ติดลบ ไม่เหลือ
SELECT id, available_stock, remaining_stock
FROM products WHERE id = 'p-1001';
-- คาดหวัง: available_stock = 50, remaining_stock = 0

-- 2) ต้องมี order 50 แถวพอดี และ user ไม่ซ้ำเลย
SELECT COUNT(*) AS total_orders,
       COUNT(DISTINCT user_id) AS unique_users
FROM orders WHERE product_id = 'p-1001';
-- คาดหวัง: total_orders = 50, unique_users = 50

-- 3) ไม่มีใครได้เกิน 1 ชิ้น (ต้องได้ 0 แถว)
SELECT user_id, COUNT(*) FROM orders
WHERE product_id = 'p-1001'
GROUP BY user_id HAVING COUNT(*) > 1;

-- 4) counter ใน Redis ต้องตรงกับ DB
--    redis-cli GET stock:flash_sale:p-1001  →  ต้องได้ "0"
```
ข้อ 4 ไม่ได้อยู่ในโจทย์ แต่เป็นตัวจับ bug ที่ดีที่สุด: ถ้า Redis ≠ DB แปลว่า compensation logic (§6.2, §6.3) มีรูรั่ว

---

## 10. ⚖️ เปรียบเทียบ: Naive vs สถาปัตยกรรมนี้

| มิติ | Naive Approach | สถาปัตยกรรมนี้ |
| :--- | :--- | :--- |
| **รับ Order** | Query DB ตรงใน controller | Redis Lua pre-filter → BullMQ → **202 ทันที** |
| **กัน Oversell** | `if (stock > 0)` ในแอป (TOCTOU) | **Atomic SQL decrement + `CHECK (stock >= 0)`** |
| **กันซื้อซ้ำ** | `SELECT` หา order เดิมก่อน insert | **Redis in-flight mutex + `bought` flag + `UNIQUE(user_id, product_id)`** |
| **Read-Write Split** | ปล่อย TypeORM route เอง | **บังคับ master connection ใน transaction** |
| **Cache กับ Stock** | แคชทั้ง object → invalidate ทุกครั้งที่ขาย | **แยก metadata (แคชนาน) ออกจาก stock counter (อ่านสด)** |
| **Stampede** | ไม่จัดการ → DB ถล่มตอน TTL หมด | **single-flight + TTL jitter** |
| **Redis** | ตัวเดียวทำทุกอย่าง | **แยก cache (`allkeys-lru`) กับ data/queue (`noeviction` + AOF)** |
| **ชดเชยเมื่อล้มเหลว** | ไม่มี / คืนสต็อกใน catch เดียวกับทุกอย่าง | **compensate แบบ idempotent + แยก side effect ออกจาก tx** |
| **Auth** | ตรวจ session ใน memory | **JWT HS256 verify แบบ zero-I/O** |
| **Load Balancer** | round-robin เปล่าๆ | **`least_conn` + keepalive ที่เปิดใช้งานจริง + timeouts** |

---

## 📚 อ้างอิง
- 🎓 **อ่านไม่เข้าใจ? เริ่มที่นี่ก่อน**: [`docs/Architecture/architecture-primer.md`](./architecture-primer.md) — ฉบับปูพื้นฐานตั้งแต่ศูนย์ (ไม่ใช่สเปก)
- โจทย์: [`docs/Requirement/Flash Sale System.pdf`](../Requirement/Flash%20Sale%20System.pdf)
- 📊 ไดอะแกรม DFD / Control Flow / CSPEC: [`docs/Architecture/diagrams.md`](./diagrams.md)
- 🧭 **ทำไมถึงเลือกสถาปัตยกรรมนี้ + ข้อดีข้อเสีย + บันทึกการถกเถียง**: [`docs/Architecture/architecture-rationale.md`](./architecture-rationale.md)
- ⚠️ ฉบับเก่า (archived, ห้ามใช้เป็นสเปก): [`docs/Architecture/old_architecture.md`](./old_architecture.md)
- ข้อมูลตั้งต้น: [`docs/Requirement/products-seed.json`](../Requirement/products-seed.json)
- สรุปบทเรียน (agent): [`docs/Summary_Best_Practice/For_agent/INDEX.md`](../Summary_Best_Practice/For_agent/INDEX.md)
- สรุปบทเรียน (ฉบับอ่าน): [`docs/Summary_Best_Practice/For_human/`](../Summary_Best_Practice/For_human/)
- กติกาสำหรับ AI agent: [`CLAUDE.md`](../../CLAUDE.md)
