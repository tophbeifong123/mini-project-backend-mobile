# 🏛️ Flash Sale System — Architecture & Concurrency Blueprint

> **โจทย์**: Mobile Backend Architecture & Performance Testing (Flash Sale System)
> **เป้าหมาย**: Read 1,000 concurrent users + Write burst 500 concurrent users แย่งสินค้า 50 ชิ้น
> **การันตี**: Zero Overselling · 1 ชิ้น / 1 ผู้ใช้ / 1 สินค้า · ตอบ HTTP เร็ว (ไม่มี synchronous DB write ใน controller)

---

## 0. 🎯 Requirement Traceability (โจทย์ → สถาปัตยกรรม)

| # | ข้อกำหนดจากโจทย์ | ที่อยู่ในเอกสารนี้ |
| :-- | :--- | :--- |
| 1.1 | Load Balancer: Nginx → **≥ 3 instances** (รันจริง **6 instances**) | §2 |
| 1.2 | Backend: NestJS **Modular structure** | §3 |
| 1.3 | Database: PostgreSQL + TypeORM + **Connection Pooling** | §8 |
| 1.3.1 | Schema / Entity / Migration | **§3.1** |
| 1.4 | Caching & Invalidation: Redis | §5 |
| 1.5 | Message Queue: **BullMQ** (async order processing) | §6.2 |
| 1.6 | **Stateless Auth: JWT** (ห้าม in-memory session) | §4 |
| 1.7 | Observability Dashboard (Bull-Board + หน้า Insights ของเราเอง) | §9 · **§9.4** |
| 2.1 | `POST /api/v1/auth/token` | §4.2 |
| 2.2 | `GET /api/v1/products?page=1&limit=10` + cache invalidation | §5 |
| 2.3 | `POST /api/v1/orders` → **202 Accepted** | §6 |
| 2.3.1 | Limit 1 per user | §6.1 + §6.4 |
| 2.3.2 | Concurrency (API level) — atomic Redis ops | §6.1 |
| 2.3.3 | Concurrency (Worker/DB level) — locking + unique constraint | §6.3 + §6.4 |
| 2.3.4 | Cache Invalidation หลัง worker ตัดสต็อกสำเร็จ | §5.4 |
| 3 | Load Test (k6) + Dashboard + Data Integrity Proof | §9 (§9.3 = proof ทำมือ · §9.4 = อัตโนมัติ), §10 |

---

## 1. 🏗️ ภาพรวมสถาปัตยกรรม (System Architecture Diagram)

```mermaid
flowchart TD
    subgraph Clients["👥 High Concurrency Traffic (k6)"]
        C1["1,000 Read VUs<br/>GET /products"]
        C2["500 Write VUs<br/>POST /orders (burst)"]
    end

    subgraph Edge["⚖️ Edge Layer"]
        NGINX["Nginx Reverse Proxy :8080<br/>least_conn · keepalive 128<br/>proxy_http_version 1.1<br/>max_fails=0 · proxy_next_upstream error"]
    end

    subgraph BackendCluster["🚀 NestJS Cluster (6 Instances)"]
        APP1["app-1 :3000<br/>API + Worker<br/>RUN_MIGRATIONS=true"]
        APP2["app-2 :3000<br/>API + Worker"]
        APP3["app-3 :3000<br/>API + Worker"]
        APP4["app-4 :3000<br/>API + Worker"]
        APP5["app-5 :3000<br/>API + Worker"]
        APP6["app-6 :3000<br/>API + Worker"]
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
        METRICS["metrics:counters · metrics:instances<br/>write-behind counters (flush 1s)"]
    end

    subgraph WorkerTier["⚙️ BullMQ Consumer"]
        WORKER["Worker concurrency 5 / node<br/>6 nodes = 30 concurrent writes<br/>(≤ master pool 8 / instance)"]
    end

    subgraph DatabaseTier["🗄️ PostgreSQL 16"]
        PG_PRIMARY[("Primary :5432<br/>Atomic SQL decrement<br/>UNIQUE(user_id, product_id)<br/>CHECK(remaining_stock >= 0)")]
        PG_REPLICA[("Replica :5433<br/>catalog reads only<br/>streaming replication")]
    end

    C1 & C2 --> NGINX
    NGINX -->|least_conn| APP1 & APP2 & APP3 & APP4 & APP5 & APP6

    APP1 & APP2 & APP3 & APP4 & APP5 & APP6 --> JWT
    APP1 & APP2 & APP3 & APP4 & APP5 & APP6 -->|read| CACHE
    CACHE -.->|miss| PG_REPLICA
    APP1 & APP2 & APP3 & APP4 & APP5 & APP6 -->|"MGET stock overlay"| LUA

    APP1 & APP2 & APP3 & APP4 & APP5 & APP6 -->|write| LUA
    LUA -->|allowed| QUEUE
    LUA -->|rejected| NGINX

    QUEUE --> WORKER
    WORKER -->|"createQueryRunner('master')"| PG_PRIMARY
    PG_PRIMARY -->|streaming replication| PG_REPLICA
    WORKER -.->|invalidate metadata| CACHE
    QUEUE --- BOARD
    APP1 & APP2 & APP3 & APP4 & APP5 & APP6 -.->|"metrics flush 1/s"| METRICS
    METRICS --- INSIGHTS["/admin/insights + /admin/metrics<br/>(same Basic Auth on /admin)"]
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

    # ⚠️ max_fails=0 = ปิด passive health check โดยเจตนา
    # backend ทั้ง 6 ตัวเหมือนกันทุกอย่าง เวลาโหลดพีคมันช้าพร้อมกัน
    # ถ้าเปิด max_fails ไว้ nginx จะตัดออกครบทุกตัว → `no live upstreams` → 502 รวด
    # (วัดจริง 2026-08-27: 502 จำนวน 115,005 ครั้ง และ write path ไม่ถูกทดสอบเลย)
    server app-1:3000 max_fails=0;
    server app-2:3000 max_fails=0;
    server app-3:3000 max_fails=0;
    server app-4:3000 max_fails=0;
    server app-5:3000 max_fails=0;
    server app-6:3000 max_fails=0;
    keepalive 128;
}

server {
    listen 80;

    location / {
        proxy_pass http://backend;

        # ⚠️ บังคับ 2 บรรทัดนี้ ไม่งั้น `keepalive 128` ข้างบนไม่ทำงานเลย
        # Nginx จะคุย upstream ด้วย HTTP/1.0 + Connection: close
        # → TCP handshake ใหม่ทุก request (ตัวฉุด p95 อันดับ 1)
        proxy_http_version 1.1;
        proxy_set_header Connection "";

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # ⚠️ default ของ proxy_next_upstream คือ `error timeout` แปลว่า request ที่
        # timeout จะถูกยิงซ้ำไป upstream ตัวถัดไปเอง → ตอนระบบเริ่มช้า = คูณโหลดเข้าไปอีก
        proxy_next_upstream error;

        # กัน upstream ค้างแล้วกิน worker_connections จนหมด
        proxy_connect_timeout 5s;
        proxy_send_timeout    10s;
        proxy_read_timeout    10s;
    }
}
```

> Nginx เวอร์ชันฟรีมีแค่ **passive health check** (`max_fails` / `fail_timeout`) — มันอ่านสถานะ `HEALTHCHECK` ของ Docker/Podman **ไม่ได้** อย่าออกแบบโดยคิดว่ามี active failover *(B06 slide-errata #1, #2)*
>
> ด้วยเหตุนี้ คอนฟิกจริงจึง **ปิด passive health check ทิ้ง (`max_fails=0`, ไม่มี `fail_timeout`)**
> เพราะ backend ทั้ง 6 ตัวเหมือนกันหมด เวลาโหลดพีคมันช้าพร้อมกัน → nginx ตัดออกครบทุกตัวพร้อมกัน
> → `no live upstreams` → 502 รวด หน้าที่จับ instance ตายจึงเป็นของ `healthcheck` ใน compose ไม่ใช่ของ nginx

---

## 3. 🧱 NestJS Modular Structure

```
src/
├─ main.ts                        # global ValidationPipe, graceful shutdown, Basic Auth ครอบ `/admin` ทั้ง prefix (`main.ts:47`)
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
├─ bull_board/                    # /admin/queues (Basic Auth ครอบมาจาก main.ts)
│  ├─ bull-board.service.ts     # BullMQAdapter + uiConfig + formatter ที่ redact requestToken
│  └─ bull-board.theme.ts       # ธีม/โลโก้/favicon — ตกแต่งล้วน ไม่มี logic
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
├─ observability/                 # §9.4
│  ├─ observability.module.ts     # @Global — MetricsService ถูกฉีดเข้า orders/products/worker
│  ├─ metrics.constants.ts        # ⚠️ ชื่อ metric รวมศูนย์ ห้ามพิมพ์ string ลอยๆ (เหตุผลเดียวกับ redis.keys.ts)
│  ├─ metrics.service.ts          # write-behind counter → hash `metrics:counters` บน redis-data
│  ├─ integrity.service.ts        # เทียบ Redis counter ↔ DB (อ่านอย่างเดียว ไม่ซ่อม)
│  ├─ observability.controller.ts # /admin/insights · /admin/insights.json · /admin/metrics
│  └─ insights.page.ts            # HTML หน้าเดียว ไม่มี build step (auto-refresh 3 วิ)
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
> ⚠️ แต่ **มันจับ drift ระหว่าง Redis กับ DB ไม่ได้** เพราะ compensation เกิดฝั่ง Redis ล้วน ส่วน `remaining_stock` ใน DB ไม่เคยเพิ่มขึ้นเลยในดีไซน์ปัจจุบัน — ตัวจับ drift อยู่นอก DB: **§9.3 ข้อ 4** (ทำมือ) หรือ **§9.4 `IntegrityService`** (อัตโนมัติ แต่ยังเป็น *ตัวจับ* ไม่ใช่ *ตัวซ่อม*)

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

worker ทุกตัวใน 6 instance (รวม 30 concurrent — §8) `UPDATE` **แถวเดียวกัน** คือ `products` ของ `p-1001`
→ PostgreSQL จะ **serialize พวกมันที่ row lock ของแถวนั้น** ซึ่ง **ถูกต้องและตั้งใจ**: ของมี 50 ชิ้น = `UPDATE` สำเร็จ 50 ครั้ง ไม่ใช่ปริมาณที่ต้องกังวล
ส่วน `INSERT INTO orders` ขอแค่ `KEY SHARE` บนแถว products (จาก FK) ซึ่ง **ไม่ชนกับ `FOR NO KEY UPDATE`** ที่ `UPDATE` ถือไว้ จึงไม่เกิด lock escalation

> ✅ นี่คือเหตุผลที่ **PostgreSQL ไม่ใช่คอขวด** ในระบบนี้ — คอขวดอยู่ที่ `redis-data` (ดู [`architecture-rationale.md`](./architecture-rationale.md) §6 Q3)

---

## 4. 🔐 Stateless Authentication (JWT)

โจทย์บังคับ **JWT + ห้ามใช้ in-memory session** เพราะทั้ง 6 instance ต้อง verify token ได้เองโดยไม่ต้องแชร์ state

### 4.1 หลักการ
- **HS256 + shared secret** จาก `JWT_SECRET` (env) — ทั้ง 6 instance ใช้ secret เดียวกัน จึง verify ข้าม instance ได้
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
| **ตัวนับ observability** (§9.4) | ชื่อ metric → จำนวนสะสมทั้งคลัสเตอร์ | `redis-data` → `metrics:counters` (hash) | ไม่มี TTL — ล้างด้วย `pnpm run reset` หรือ `POST /admin/metrics/reset` |
| **สถานะราย instance** (§9.4) | `rssMb`, `eventLoopP99Ms`, `updatedAt` | `redis-data` → `metrics:instances` (hash, field = `INSTANCE_ID`) | ไม่มี TTL — ถือว่า stale เมื่อ heartbeat เก่ากว่า 15s (`metrics.service.ts:20`) |

> `availableStock` = สต็อกตั้งต้น (คงที่, มาจาก seed) · `remainingStock` = คงเหลือจริง (นับถอยหลัง) — response ต้องมีทั้งคู่
> สอง key ล่างอยู่บน **`redis-data` ไม่ใช่ `redis-cache`** โดยเจตนา: `allkeys-lru` จะ evict ตัวนับหายเงียบๆ กลางการทดสอบ (`redis.keys.ts:31-41`)

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

> ❌ **ไม่ใช้ L1 in-memory LRU cache** — ถ้าเก็บผลลัพธ์ที่มี `remainingStock` ไว้ใน RAM ของแต่ละ instance นาน 1–2 วินาที ทั้ง 6 instance จะตอบสต็อกไม่ตรงกัน ขัดกับ "เงื่อนไขสำคัญ" ของโจทย์โดยตรง และขัดกฎ stateless *(B06)*

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
- ตอน bootstrap ให้ตั้ง `SET stock:flash_sale:{id} <remaining_stock จาก DB> NX` สำหรับสินค้า flash sale ทุกตัว — `NX` กันไม่ให้ instance ที่ 2 ถึง 6 เขียนทับค่าที่ถูกหักไปแล้ว
- `redis-data` ต้อง `maxmemory-policy noeviction` + เปิด AOF (§1)

### 6.2 Tier 2: Enqueue + Compensation

```typescript
// orders.service.ts
async createOrder(userId: string, productId: string) {
  const jobId = `order:${userId}:${productId}`;   // deterministic → BullMQ ปฏิเสธซ้ำเอง

  // token สุ่มใหม่ทุกคำขอ — ใช้เป็นค่าใน lock (ให้ compare-and-delete แยกการถือครองได้จริง)
  // และเป็นตัวพิสูจน์ว่า job ที่อยู่ในคิวเป็นของคำขอนี้
  const requestToken = randomUUID();

  // ⚠️ ต้องมี try/catch — `commandTimeout` (redis.module.ts) ยกเลิกแค่การรอฝั่ง client
  // ถ้า Lua "รันถึง DECR ไปแล้ว" ก่อนจะ timeout ฝั่งเราจะไม่รู้ผล ต้องชดเชยแบบ "เดาไม่ได้"
  // (compensateIfReserved ใช้ค่าใน lock:order:* เป็นหลักฐานแทนการเดา — ดู §6.3 ตารางชดเชย)
  let verdict: number;
  try {
    verdict = await this.redis.gatekeeper(userId, productId, requestToken, LOCK_TTL_MS);
  } catch (err) {
    await this.compensateIfReserved(userId, productId, jobId, requestToken);
    throw new ServiceUnavailableException('Stock service unavailable');
  }

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
  — และมันไม่ใช่แค่เรื่องหน้าจอ: dedup ของเราพึ่ง BullMQ ปฏิเสธ `jobId` ซ้ำ (invariant §4 ข้อ 9 ของ `CLAUDE.md`) ซึ่งทำงานได้ **ก็ต่อเมื่อ job เดิมยังอยู่ใน Redis** ถ้า trim ทิ้ง คนเดิมสั่งซื้อซ้ำได้
- ⚠️ **`defaultJobOptions` ใน `bullmq_config/bullmq.module.ts:32-37` ไม่มีผลกับคิว `orders`** — ตรงนั้นตั้ง `attempts: 3`, `backoff.delay: 500`, `removeOnComplete/removeOnFail: false` (ไม่ลบเลย) แต่ `orders.service.ts:152-155` ส่ง option ครบชุดมาทับทุกตัวทุกครั้งที่ `add()` ค่าที่บังคับใช้จริงคือ `delay: 200` + `count: 5000` ตามโค้ดด้านบน
  ถือเป็น **dead config ที่ยังไม่ลบ** เพราะคอมเมนต์ในไฟล์นั้นอธิบายเหตุผลของ retention ไว้ — อย่าอ่านค่าจากไฟล์นั้นแล้วเชื่อว่านั่นคือค่าที่ job ใช้จริง
- `attempts` มาคู่กับข้อบังคับว่า **handler ต้อง idempotent** เสมอ — BullMQ เป็น at-least-once *(B05)*
- BullMQ **ไม่มี** job option ชื่อ `timeout` (นั่นคือ Bull v4) ถ้าต้องการ ให้ทำเองด้วย `Promise.race` *(B05 slide-errata #2)*

### 6.3 Tier 3: Worker — จุดที่พลาดกันบ่อยที่สุด

> ⚠️ **กับดัก Read-Write Split**: `repository.findOne()` จะวิ่งไป **Replica** โดยอัตโนมัติ ซึ่งมี replication lag 10–100ms → worker อ่านเจอสต็อกเก่า → race condition ทันที
> Worker **ต้อง** ใช้ `dataSource.createQueryRunner('master')` เท่านั้น

```typescript
// orders.processor.ts
@Processor('orders', { concurrency: 5 })   // ≤ ขนาด pool ของ master (= 8, §8) ห้ามเกิน
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
      // → Redis สูงกว่า DB ถาวร 1 หน่วย ตกเกณฑ์ §9.3 ข้อ 4
      //   (`compensated:{jobId}:{requestToken}` กันได้แค่คืน "ซ้ำ")
      // compensate เป็น Lua ที่ INCR stock + DEL lock ในสเต็ปเดียว และ
      // guard ด้วย key `compensated:{jobId}:{requestToken}` ไม่ให้คืนซ้ำเมื่อ retry
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
3. **`compensateOnce` guard ด้วย jobId + requestToken + คืนเฉพาะ attempt สุดท้าย** — BullMQ retry ได้ 3 ครั้ง `compensated:{jobId}:{requestToken}` กันการคืน *ซ้ำ* ส่วน `isFinalAttempt` กันการคืน *job ที่ยังไม่ตาย* (ต้องมีทั้งคู่)
   > ⚠️ `requestToken` อยู่ใน key **โดยเจตนา** (แก้ 2026-08-30) — `jobId` เป็น deterministic ถ้า guard มีแค่ `jobId` คำขอ *รอบถัดไป* ของคนเดิมจะชน guard ของรอบก่อน แล้วไม่คืนสต็อก = หายถาวร · retry ยังถูกคุมเหมือนเดิมเพราะ BullMQ อ่าน `job.data` ชุดเดิม จึงได้ token เดิม
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

Error mapping (**ในตัว worker ไม่ใช่ HTTP** — client ได้ 202 ไปตั้งแต่ตอน enqueue แล้ว จึงไม่มี error ตัวไหนกลายเป็น status code ให้ client เห็น · ดู `orders.processor.ts`):

| code | worker ทำอะไร |
| :--- | :--- |
| `23505` unique_violation | `return { status: 'already_confirmed' }` — **ไม่ retry ไม่คืนสต็อก** (idempotency) |
| `23514` check_violation | ไม่มี branch แยก → ตกไป transient (retry) · **เข้าไม่ถึงโดยการออกแบบ** เพราะ `WHERE remaining_stock > 0` กัน `chk_positive_stock` ไว้แล้ว (ยืนยัน 2026-08-29 · ดู `diagrams.md` §6.2) |
| `40P01` deadlock | retry แบบ exponential + jitter · compensate เฉพาะ attempt สุดท้าย *(B03)* |

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
| Worker concurrency > DB pool | job timeout รอ connection | concurrency 5 ≤ master pool 8 (§8) |
| ผู้ใช้กดรัว 2–3 ครั้ง | ได้ของเกิน 1 ชิ้น | in-flight lock + `bought` flag + `UNIQUE` (§6.1, §6.4) |
| Cache หมดอายุพร้อมกันตอน 1,000 VUs | DB โดนถล่ม (stampede/avalanche) | single-flight + TTL jitter (§5.3) |
| `redis-data` สะดุดตอน flush ตัวนับ observability | ตัวเลขในรายงานขาดหาย + log storm ซ้ำเติมตอนโหลดพีค | buffer ที่ flush ไม่ผ่านถูกใส่กลับ แล้ว log ทุก 30 ครั้งเท่านั้น (§9.4) |

---

## 8. 🎛️ Connection Pooling & Resource Sizing

> อัปเดต **2026-08-27** — ขยายจาก 3 → **6 instances** และลด `DB_POOL_SIZE` จาก 10 → **8**
> ตัวเลขทุกตัวใน §นี้มาจาก `docker-compose.yml` / `nginx.conf` จริง ไม่ใช่ค่าที่ตั้งใจไว้ตอนออกแบบ

**สูตรที่ต้องใช้** *(B06 — เป็นจุดที่สไลด์คำนวณผิด)*:
```
ต่อ "เซิร์ฟเวอร์แต่ละตัว" แยกกัน:
  connections บน primary = instances × poolSize   ≤ 80% ของ max_connections ของ primary
  connections บน replica = instances × poolSize   ≤ 80% ของ max_connections ของ replica
```
TypeORM replication สร้าง pool **แยกต่อ master และต่อ slave แต่ละตัว** ไม่ใช่ pool เดียว

> ⚠️ **แก้จากฉบับก่อน (2026-08-26)** — เดิมเขียนว่า `instances × (1 + replicas) × poolSize ≤ 80% ของ max_connections`
> ซึ่ง **มิติผิด**: มันบวก connection ที่ไปลงคนละเซิร์ฟเวอร์เข้าด้วยกัน แล้วเอาไปเทียบกับ limit ของเซิร์ฟเวอร์เดียว
> ค่าที่ถูกที่ 6 instances คือ **48 บน primary และ 48 บน replica แยกกัน** ไม่ใช่ 96 ที่ต้องเทียบกับ 100

| องค์ประกอบ | ค่า | เหตุผล / ที่มา |
| :--- | :--- | :--- |
| จำนวน instance | **6** (`app-1` … `app-6`) | `docker-compose.yml` — โจทย์บังคับ ≥ 3 |
| `poolSize` ต่อ DataSource | **8** (`DB_POOL_SIZE`) | ตั้งที่ compose ทุก service · default ใน `env.validation.ts` คือ 10 แต่ไม่ถูกใช้ใน container |
| Connections บน **primary** | **6 × 8 = 48** / 100 (48%) | master pool — เฉพาะ worker (`createQueryRunner('master')`) |
| Connections บน **replica** | **6 × 8 = 48** / 100 (48%) | slave pool — catalog read (`defaultMode: 'slave'`) |
| headroom ต่อเซิร์ฟเวอร์ | ✅ ยังใต้กฎ 80% | 48 ≤ 80 · เพดานที่พังคือ **10 instances** (10 × 8 = 80) |
| **Worker concurrency** | **5 / instance** → รวม **30** | ≤ master pool 8 · อ่านจาก `process.env` ตอน decorate class แก้ใน `.env` ไม่มีผล |
| Redis: `redis-cache` | 1 client / instance → **6** | แคชล้วน `allkeys-lru` · `maxmemory 256mb` |
| Redis: `redis-data` | ≈ **36** (6 × 6) | ต่อ instance: ① client ทั่วไป/Lua ② BullMQ `Queue` (มี 3 ออบเจกต์ — Nest 11 ไม่ dedupe) ③ Worker 2 ตัว (client + blocking) · `maxmemory 512mb` `noeviction` + AOF |
| Nginx | `worker_connections 10240`, `keepalive 128` | ต้องมาคู่กับ `proxy_http_version 1.1` (§2) |

### 8.1 🖥️ Deployment Target — Production VM

| ทรัพยากร | มีเท่าไหร่ | ใครกิน |
| :--- | :--- | :--- |
| vCPU | **4 core** | 6 Node process (app) + nginx `worker_processes 2` (ผูกกับ `cpus: 1.0`) + postgres ×2 + redis ×2 = **11 container** |
| RAM | **6 GB** | redis จองไว้แล้ว 768 MB (256 + 512) · PG primary `shared_buffers=256MB` · PG replica default 128MB · ที่เหลือหาร 6 Node process |
| Storage | **30 GB** | ดู §8.2 ข้อ 3 |

> ✅ **แก้แล้ว (2026-08-28)** — เดิมไม่มี resource limit เลย ตอนนี้ `docker-compose.yml` มี `mem_limit`/`cpus`
> ทุก service แล้ว (app-N: `mem_limit 512m`, `cpus 0.75`) และ `NODE_OPTIONS: "--max-old-space-size=384"`
> ใน environment ของ app-N ด้วย — ดู `handoff_log/handoff_28_08_2026_performance-tuning-and-review-fixes.md` ข้อ 3

### 8.2 🧭 เพดานจริงอยู่ตรงไหน (จุดที่จะตันก่อน)

เรียงตามลำดับที่จะเจอ — **การเพิ่ม instance ไม่ได้ขยับข้อไหนเลยหลังจากนี้**

1. **CPU ของ VM (4 core)** — แต่ละ instance คือ **1 Node process = 1 JS thread** (`src/main.ts` ไม่มี cluster / PM2 / worker_threads)
   6 process บน 4 core คือ **oversubscribe อยู่แล้ว** — เพิ่มเป็น 8–10 จะได้ context switch มากขึ้น ไม่ใช่ throughput
2. **`redis-data` เป็น single thread ตัวเดียว** ที่รับงานทั้ง 4 อย่างพร้อมกัน:
   `gatekeeper.lua` (write) · BullMQ queue · `MGET stock:*` **ทุก read request ไม่เคยแคช** · AOF fsync
   → เพิ่ม app instance = เพิ่มโหลดให้ redis ตัวเดียวนี้ตรงๆ
3. **Disk 30 GB — log rotation** ✅ **แก้แล้ว (2026-08-28)**: ทุก service ใน `docker-compose.yml` มี `logging: {driver: json-file, options: {max-size: "10m", max-file: "3"}}` แล้ว
   และตัด duplicate logging ออกแล้ว (`pino-http autoLogging: false` — เหลือ **1 บรรทัด/request** ไม่ใช่ 3 เหมือนเดิม)
4. **Row lock แถวเดียว** — 30 concurrent worker ทั้งคลัสเตอร์ `UPDATE products` ของ `p-1001` แถวเดียวกัน
   จำนวน worker ที่เพิ่มจึง **ไม่ช่วยให้ขายเร็วขึ้น** — มีแต่ค้างรอโดยกิน pool connection ไว้
5. **single-flight เป็น per-process** (`products.service.ts` ใช้ `Map` ใน RAM)
   แคชหลุดทีไร → มี **6 query วิ่งเข้า replica พร้อมกัน** (ไม่ใช่ 1) — เพิ่ม instance = เพิ่มจำนวนนี้
6. ~~`invalidateCatalogCache()` debounce เป็น per-process~~ ✅ **แก้แล้ว (2026-08-28) — ไม่ใช่บั๊กอีกต่อไป**
   เดิมกลัวว่า 6 instance จะ flush ได้ถึง 6 ครั้ง/วินาที เพราะ debounce เป็น `Map` ใน RAM ต่อ process
   ตอนนี้ `redis.service.ts` ใช้ **distributed throttle** ข้าม instance จริง: หลัง per-process debounce แล้ว
   ต้องแย่งชิง `SET catalog:flush_throttle 1 PX 1000 NX` บน `redis-cache` ก่อน — เฉพาะ instance ที่ชนะถึงจะ flush จริง
   ผลคือ flush ทั้งคลัสเตอร์ไม่เกิน **1 ครั้ง/วินาทีจริง** ไม่ใช่ 6 ครั้ง (`RedisKeys.catalogFlushThrottle()`)

> **สรุป**: ข้อ 1–2 ทำให้การเพิ่ม instance จาก 6 เป็น 8–10 บน VM ตัวนี้ **ได้ผลลดลงหรือติดลบ**
> ข้อ 5 ทำให้การเพิ่ม instance **ไปเพิ่มโหลดให้ replica** ด้วย (ข้อ 6 แก้แล้ว ไม่เพิ่มโหลดให้ redis-cache อีกต่อไป)
> จุดที่ยังมีที่ว่างจริงคือ **connection headroom (48/80)** และ **RAM** — ไม่ใช่ CPU

> **ข้อควรระวัง (แก้ 2026-08-26)** — ฉบับก่อนเขียนว่า "ทั้ง API และ worker แย่ง pool ตัวเดียวกัน" **ซึ่งไม่จริงกับโค้ดที่เขียนจริง**
> เพราะเปิด `replication` + `defaultMode: 'slave'` ไว้ TypeORM จึงสร้าง **pool แยกต่อ master และต่อ slave**
> → API อ่าน catalog ลง **slave pool** ส่วน worker ขอ `createQueryRunner('master')` ลง **master pool** — **ไม่เคยชนกัน**
>
> `WORKER_CONCURRENCY = 5` จึงไม่ได้มีที่มาจากการแย่ง pool (จะเป็น 8 เท่า poolSize ก็ยังปลอดภัย)
> เพดานจริงของ write path คือ **row lock ของสินค้าแถวเดียว** ที่ทุก worker ยิงใส่ ซึ่ง serialize อยู่แล้วไม่ว่า concurrency จะเป็นเท่าไหร่
>
> ⚠️ **แต่ถ้าวันไหนตัด replica ทิ้ง** master กับ slave จะยุบเป็น pool เดียว แล้วคำเตือนเดิมจะ *กลายเป็นจริงขึ้นมา*
> ต้อง re-derive `DB_POOL_SIZE` **ก่อน** แก้ compose ไม่ใช่หลัง
> ⚠️ ที่ 6 instances ค่าที่ถูกคือ **13** (6 × 13 = 78 ≤ 80) — เลข **20** ที่เคยเขียนไว้ในฉบับ 3 instances
> จะกลายเป็น 6 × 20 = **120 > max_connections 100** คือ start ไม่ขึ้นทันที

---

## 9. 📊 Observability & Load Test (k6)

### 9.1 สิ่งที่ต้องแสดงตามโจทย์

| หมวด | Metric | เป้าหมาย | ดูจากไหน |
| :--- | :--- | :--- | :--- |
| **Cache** | Hit / Miss Ratio | ≥ 90% | `redis-cli INFO stats` → `keyspace_hits` / `keyspace_misses` · หรือ `/admin/insights` (§9.4) ที่อ่าน `INFO` ให้ทั้งสองตัว **และ** มีตัวนับระดับแอป `catalog_cache_hits_total` / `catalog_cache_misses_total` แยกต่างหาก |
| **Queue** | Waiting / Active / Completed / **Failed** | Completed = 50, Failed = job ของคนที่ของหมด | Bull-Board `/admin/queues` (แท็บ Metrics มีกราฟจริงเพราะ worker เปิด `metrics: { maxDataPoints: MetricsTime.ONE_WEEK }` — `orders.processor.ts:43`) |
| **Throughput** | Req/s, **p95 latency**, Error rate | p95 read < 200ms, error < 0.1% | k6 summary |
| **DB Primary** | Active connections, lock wait | active < 48 (= 6 x pool 8) | `pg_stat_activity` · pool ของ instance ที่ตอบคำขอนี้ดูได้ที่ `/admin/insights` (§9.4) |
| **DB Replica** | Replication lag | < 1s | `pg_stat_replication` · หรือ `/admin/insights` ที่ถาม `pg_last_xact_replay_timestamp()` จากฝั่ง replica เอง (`integrity.service.ts:309-332`) |

> วัด **percentile ไม่ใช่ average** — p95/p99 คือคนที่โกรธที่สุดและมักเป็นคนที่ข้อมูลเยอะที่สุด *(B06)*
> Bull-Board **ต้องมี Basic Auth คลุม** เพราะมันเปิดดู payload และกด retry/remove job ได้ *(B05 slide-errata #10)*
> ตั้งแต่ 2026-08-30 Basic Auth ถูกครอบที่ **prefix `/admin` ทั้งก้อน** (`main.ts:47`) ไม่ใช่เฉพาะ `/admin/queues` — route ใหม่ใต้ `/admin` จึงถูกคลุมอัตโนมัติ

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

> ทั้ง 4 ข้อนี้ถูกทำให้อัตโนมัติแล้วที่ `/admin/insights` (§9.4) — แต่ SQL ชุดนี้ยังเป็นหลักฐานที่เอาไปใส่รายงานได้ตรงๆ ห้ามตัดทิ้ง

### 9.4 🔭 ชั้น Observability ในตัวแอป (`src/observability/`)

> เพิ่ม **2026-08-30** · เหตุผล: ทุกแถวใน §9.1 เดิมต้องไปเปิดของคนละที่แล้วเอามาต่อกันเอง (`redis-cli` + `psql` + Bull-Board + k6 summary) ซึ่งทำระหว่างยิงโหลดไม่ทัน
> โมดูลนี้เป็น `@Global` เพราะ `MetricsService` ถูกฉีดเข้าเกือบทุก service ที่มีเส้นทางร้อน (`observability.module.ts:16-22`)

#### 9.4.1 เอนด์พอยต์ + auth

| path | คืออะไร | หมายเหตุ |
| :--- | :--- | :--- |
| `GET /admin/insights` | หน้า HTML หน้าเดียว auto-refresh ทุก 3 วินาที | ไม่มี build step ไม่มี dependency ภายนอก — HTML เป็น string ใน `insights.page.ts` |
| `GET /admin/insights.json` | payload ดิบของหน้าเดียวกัน `{ counters, instances, integrity }` | `observability.controller.ts:39-47` |
| `GET /admin/metrics` | Prometheus exposition format (`text/plain; version=0.0.4`) | **ยังไม่มี Prometheus ในสแตกโดยเจตนา** (ตกลงกันว่าไม่เพิ่ม service) — เปิดไว้ให้ชี้ scrape มาได้ทีหลัง และ `curl` ดูดิบๆ ก็อ่านออก |
| `POST /admin/metrics/reset` | ล้างตัวนับก่อนยิง k6 รอบใหม่ | ไม่แตะข้อมูลธุรกิจ (`orders` / `stock:*` ไม่เกี่ยว) — `observability.controller.ts:164-169` |

ทุก route อยู่ใต้ `/admin` **เดียวกับ Bull-Board โดยเจตนา** — Basic Auth ครอบทีเดียวที่ prefix นั้น (`main.ts:47`) จะได้ไม่มีทางเผลอเปิดหน้าใดหน้าหนึ่งทิ้งไว้ และ route ใหม่ใต้ `/admin` ในอนาคตถูกคลุมอัตโนมัติ

#### 9.4.2 ตัวนับ: ทำไมต้อง write-behind ไม่ใช่ `HINCRBY` ตรงๆ

- `MetricsService.inc()` เป็น **synchronous ล้วน ไม่มี I/O และไม่มีทาง throw ใส่ผู้เรียก** (`metrics.service.ts:85-87`) — เรียกจาก hot path ได้โดยไม่เพิ่ม latency และ *การวัดผลห้ามทำให้คำสั่งซื้อล้ม*
- ถ้าเปลี่ยนเป็น `HINCRBY` ทุกครั้งที่นับ: ที่เพดานที่วัดได้ (~1,500 rps ตอน 3 instances — ยังไม่ได้วัดซ้ำหลังขยายเป็น 6) จะเพิ่มภาระให้ `redis-data` อีกราว **1,500 ops/s บน connection เดียวกับที่ gatekeeper ใช้** = เครื่องมือวัดไปกวนสิ่งที่กำลังวัด
  buffer ใน RAM แล้ว flush **1 ครั้ง/วินาที ด้วย pipeline** เหลือ ~1 roundtrip/วินาที/instance (`metrics.service.ts:18`, `143-157`)
- **state จริงอยู่บน `redis-data` (hash `metrics:counters`) ไม่ใช่ RAM ของ process** — 6 instance ต้องบวกลงถังใบเดียวกัน ถ้าเก็บใน RAM หน้าแดชบอร์ดจะเห็นแค่ ~1 ใน 6 ของทราฟฟิก (และผิดกฎ stateless — `CLAUDE.md` §6 DON'T)
  buffer ใน RAM มีอายุ ≤ 1 วินาที จึงเป็น **write-behind buffer ไม่ใช่ shared state** — ไม่ขัด §5 ข้อ 1 ด้วยเหตุผลเดียวกับ single-flight memoization ใน §5.3
- ต้นทุนที่ยอมรับ: `SIGKILL` = ตัวนับ ≤ 1 วินาทีสุดท้ายหาย · `SIGTERM` ปกติไม่หาย เพราะ `onModuleDestroy` flush ปิดท้าย (`metrics.service.ts:73-79`) — อีกเหตุผลหนึ่งที่ `app.enableShutdownHooks()` ต้องอยู่
- flush ไม่ผ่าน → **ใส่ของกลับเข้า buffer ห้ามทิ้ง** แล้ว log แค่ทุก 30 ครั้ง (Redis สะดุดตอนพีคจะ flush ไม่ผ่านรัวๆ = log storm ซ้ำเติม) — `metrics.service.ts:159-172`
- `readCounters()` บวก buffer ที่ยังค้างของ instance ที่ตอบคำขอนั้นเข้าไปด้วย (`metrics.service.ts:90-100`) — ตัวเลขที่เห็นจึงไม่ได้ช้ากว่าจริง 1 วินาทีเต็ม
- ชื่อ metric รวมศูนย์ที่ `metrics.constants.ts` **ด้วยเหตุผลเดียวกับ `redis.keys.ts`** — สะกดผิดที่จุดเรียกใช้ = ตัวนับแตกเป็นสองใบเงียบๆ

**จุดที่ยิงตัวนับ** — ทุกจุดเป็น branch ที่มีอยู่แล้ว ไม่มีการเพิ่ม I/O หรือ try/catch ใหม่:

| ไฟล์ | นับอะไร |
| :--- | :--- |
| `orders.service.ts:74`, `203` และทุก `case` | ผลลัพธ์ทุกกิ่งของ write path: 202 · 409 ซื้อซ้ำ · 409 ของหมด · 429 กดรัว · 503 ไม่มี counter · 503 gatekeeper ล้ม · 503 enqueue ล้ม · 409 โดน dedup · "ยืนยัน job ไม่ได้จึงไม่คืนสต็อก" · การชดเชยทั้งสั่ง/สำเร็จ/ล้มเหลว |
| `orders.processor.ts` | `confirmed` · `already_confirmed` (23505) · `sold_out` · transient failure · post-commit side effect ล้ม · ระยะเวลา job (sum + count) วัดจาก `job.processedOn` ที่ BullMQ ประทับให้ (`orders.processor.ts:190-196`) |
| `products.service.ts:79`, `135` | cache hit / miss ต่อคำขอ และ **degraded read** (อ่าน stock counter ไม่ได้แล้วเสิร์ฟค่าจากแคช — §5 DO) |

**ราย instance** (hash `metrics:instances`, field = `INSTANCE_ID`): `pid`, uptime, `rssMb`, `heapUsedMb` และ **event loop delay p99/max ราย 1 วินาที** จาก `monitorEventLoopDelay`
p99 ที่พุ่งคือสัญญาณเตือนล่วงหน้าของรูที่ `CLAUDE.md` §0.1 ระบุไว้: event loop ตันเกิน 30 วินาที → BullMQ ทิ้ง job ไป `failed` **โดยไม่เรียก handler** → `compensateOnce` ไม่ทำงาน → สต็อกหาย 1 ชิ้น
`INSTANCE_ID` ตั้งไว้ครบทั้ง 6 service ใน `docker-compose.yml` ถ้าลืมตั้งจะ fallback เป็น `hostname()` เพื่อไม่ให้ทั้ง 6 ตัวเขียนทับ field เดียวกัน (`metrics.service.ts:62`)
heartbeat ที่เก่ากว่า 15 วินาที ถือว่า instance ตายแล้ว (`metrics.service.ts:20`)

#### 9.4.3 `IntegrityService` — ตัวจับ drift ไม่ใช่ตัวซ่อม

ทำสิ่งที่ §9.3 ทั้ง 4 ข้อทำด้วยมือ ให้เป็นอัตโนมัติ แล้วสรุปเป็น verdict เดียว:

| verdict | เงื่อนไข |
| :--- | :--- |
| `critical` | `orders > available_stock` (oversell) · `remaining_stock < 0` · `orders ≠ distinct users` (ซื้อซ้ำ) · `available_stock − remaining_stock ≠ orders` (DB ไม่สมดุลในตัวเอง) · **`redisRemaining > dbRemaining`** |
| `warn` | ไม่มี stock counter ใน Redis (ยังไม่ `seed:redis`?) · คิวว่างแล้วแต่ Redis ยังต่ำกว่า DB |
| `ok` | ไม่มี oversell ไม่มีคนซื้อซ้ำ Redis กับ DB ตรงกัน |

- **`drift = redisRemaining − dbRemaining`** · ติดลบระหว่างที่ยังมี job ค้างในคิว = **ปกติ** (Redis จองก่อน DB ตัดทีหลัง) แต่ถ้าคิวว่างแล้วยังติดลบ = สต็อกรั่วจริง จึงยกระดับเป็น `warn` (`integrity.service.ts:133-147`)
  เป็นบวก = อันตราย เพราะ Redis สูงกว่า DB คือการปล่อยคนที่ 51 เข้ามา
- ⚠️ **ต้องอ่านจาก master เท่านั้น** (`integrity.service.ts:182` — invariant §4 ข้อ 3) ถ้าอ่านจาก replica ที่มี lag แล้วเอาไปเทียบกับ Redis ที่สดเสมอ หน้านี้จะรายงาน drift ปลอมทุกครั้งที่ replica ตามไม่ทัน
- อ่านเพิ่มในรอบเดียวกัน: `getJobCounts` ของคิว `orders` · replication lag ถามจากฝั่ง replica เอง (`pg_last_xact_replay_timestamp()`) · `INFO` ของ Redis ทั้งสองตัว (hit ratio, ops/s, evicted keys) · ขนาด pool ของ master — `waiting > 0` ต่อเนื่องคือคอขวดที่ `WORKER_CONCURRENCY` สูงเกิน pool (§8)
- ทุกแหล่งที่อ่านไม่ได้ **คืน `null` แทนที่จะโยน** — หน้าแดชบอร์ดต้องไม่ล้มเพราะแหล่งเดียวล่ม (หลักเดียวกับ degrade ของ read path ใน §5)

> ⚠️ **ไม่มีการซ่อม drift อัตโนมัติ และจงใจไม่ทำ** (`integrity.service.ts:105-109`)
> `INCR` ลอยๆ เพื่อ "ปรับให้ตรง" คือการปล่อยคนที่ 51 เข้ามา ซึ่งแย่กว่าปัญหาเดิม หน้าที่ของที่นี่คือ *บอกให้คนตัดสินใจ*
> รูที่ `CLAUDE.md` §0.1 เขียนว่า "ไม่มี reconciliation Redis ↔ DB" จึง **แคบลงเป็น "มีตัวจับแล้ว แต่ยังไม่มีตัวซ่อม" — ไม่ได้ถูกปิด**

#### 9.4.4 ข้อจำกัดที่ต้องรู้ก่อนใช้ตอนยิงจริง

- ทุกครั้งที่หน้าเว็บ poll (`insights.json` ทุก 3 วินาที) **และทุกครั้งที่ scrape `/admin/metrics`** จะยิง query ไป primary + replica + `INFO` Redis 2 ตัว + `getJobCounts` ในรอบเดียว — **อย่าเปิดหน้านี้ทิ้งไว้หลายแท็บระหว่างยิง k6** เพราะมันใช้ทรัพยากรตัวเดียวกับที่กำลังวัด · **overhead จริงยังไม่ถูกวัด**
- ตัวเลขทุกตัวเป็น **counter สะสม ไม่มี rate** — ต้องล้างก่อนยิงรอบใหม่ ไม่งั้นเป็นผลรวมของหลายรอบ (`pnpm run reset` ล้าง `metrics:counters` + `metrics:instances` ให้แล้ว — `reset.ts:79-82`)
- **ไม่มี histogram ของ latency ฝั่ง HTTP** — p95/p99 ยังต้องอ่านจาก k6 summary เท่านั้น ส่วนของ worker มีแค่ sum/count คือ *ค่าเฉลี่ย* ซึ่ง §9.1 เตือนเองว่าห้ามใช้ตัดสิน
- hash สองใบนี้อยู่บน `redis-data` ที่เป็น `noeviction` จึงไม่มีวันหายเอง — ขนาดไม่โต (field คงที่: จำนวน metric ใน `metrics.constants.ts` + 6 instance) แต่**ค่าไม่มีวันลดเอง** — ต้องล้างด้วยมือทุกครั้ง
- **ยังไม่เคยเปิดหน้านี้ระหว่างยิง k6 จริง** — ทุกอย่างในหัวข้อนี้พิสูจน์แล้วแค่ระดับ unit test (`integrity.service.spec.ts`)

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
- ข้อมูลตั้งต้น: [`docs/Requirement/products-seed.json`](../Requirement/products-seed.json)
- สรุปบทเรียน (agent): [`docs/Summary_Best_Practice/For_agent/INDEX.md`](../Summary_Best_Practice/For_agent/INDEX.md)
- สรุปบทเรียน (ฉบับอ่าน): [`docs/Summary_Best_Practice/For_human/`](../Summary_Best_Practice/For_human/)
- กติกาสำหรับ AI agent: [`CLAUDE.md`](../../CLAUDE.md)
