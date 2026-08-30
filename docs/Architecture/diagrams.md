# 📊 Flash Sale System — Data Flow & Control Flow Diagrams

> เอกสารประกอบ [`docs/Architecture/architecture.md`](architecture.md) สำหรับใช้ในรายงาน (Report PDF)
> ใช้สัญกรณ์ **Structured Analysis (Ward–Mellor)**: DFD แสดง *ข้อมูลไหลไปไหน* · CFD/CSPEC แสดง *อะไรเป็นตัวตัดสินใจควบคุม*

| ส่วน | เนื้อหา |
| :--- | :--- |
| §1 | DFD Level 0 — Context Diagram |
| §2 | DFD Level 1 — กระบวนการหลักทั้งระบบ |
| §3 | DFD Level 2 — ขยาย Process 3.0 (Write Path) |
| §4 | Data Dictionary — นิยาม data store และ data flow |
| §5 | CFD Level 1 — Control Flow Diagram |
| §6 | CSPEC — Control Specification (ตารางตัดสินใจ + ตารางเปลี่ยนสถานะ) |
| §7 | Order State Machine |
| §8 | Concurrency Control Map — ใครคุม invariant ข้อไหน |
| §9 | Sequence Diagram — 500 VUs แย่งของ 50 ชิ้น |
| §10 | DFD Level 2 — ขยาย Process 6.0 (Observability) |

**สัญกรณ์ที่ใช้ในไดอะแกรม**

| รูป | ความหมาย |
| :--- | :--- |
| สี่เหลี่ยม `[ ]` | External Entity — ผู้กระทำนอกระบบ |
| วงรี `( )` | Process — หน่วยประมวลผลที่แปลงข้อมูล |
| ทรงกระบอก `[( )]` | Data Store — ที่เก็บข้อมูล |
| เส้นทึบ `──►` | **Data Flow** — ข้อมูลจริงที่ถูกส่ง |
| เส้นประ `╌╌►` | **Control / Event Flow** — สัญญาณควบคุม ไม่ใช่ข้อมูลธุรกิจ |

---

## 1. 🌐 DFD Level 0 — Context Diagram

มองระบบเป็นกล่องเดียว เพื่อกำหนดขอบเขตว่าอะไรอยู่ใน/นอกระบบ

```mermaid
flowchart LR
    CLIENT["👤 Mobile Client<br/>(k6 Virtual Users)"]
    OBSERVER["🧑‍💻 Operator / ผู้ตรวจงาน"]

    SYS(("0<br/>Flash Sale<br/>System"))

    CLIENT -->|"D1 คำขอ token: userId"| SYS
    SYS -->|"D2 accessToken (JWT)"| CLIENT

    CLIENT -->|"D3 คำขอรายการสินค้า: page, limit"| SYS
    SYS -->|"D4 รายการสินค้า + remainingStock + meta"| CLIENT

    CLIENT -->|"D5 คำสั่งซื้อ: productId + Bearer JWT"| SYS
    SYS -->|"D6 ผลรับเข้าคิว: 202 orderJobId<br/>หรือ 401 / 409 / 429 / 503"| CLIENT

    OBSERVER -->|"D7 คำขอดูสถานะระบบ<br/>(Basic Auth ที่ /admin)"| SYS
    SYS -->|"D8 counter ทั้งคลัสเตอร์, queue metrics,<br/>cache hit ratio, drift Redis↔DB,<br/>health status, logs"| OBSERVER

    style SYS fill:#4f46e5,color:#fff,stroke:#312e81,stroke-width:2px
    style CLIENT fill:#e0e7ff,stroke:#4338ca
    style OBSERVER fill:#e0e7ff,stroke:#4338ca
```

**ขอบเขตระบบ**: Nginx, NestJS ×6, Redis ×2, BullMQ worker, PostgreSQL primary/replica อยู่ **ใน** ระบบทั้งหมด
**นอกระบบ**: k6 (ตัวสร้าง load) และผู้ตรวจงานที่เปิดดู dashboard

> 🔐 **D7/D8 วิ่งผ่าน `/admin` ซึ่งถูก Basic Auth คลุมทั้ง prefix ที่ `main.ts`** — ครอบ `/admin/queues` (Bull-Board), `/admin/insights` และ `/admin/metrics` พร้อมกัน route ใหม่ที่เพิ่มใต้ `/admin` ทีหลังจึงถูกคลุมอัตโนมัติ

---

## 2. 🔀 DFD Level 1 — กระบวนการหลักทั้งระบบ

```mermaid
flowchart TD
    CLIENT["👤 Mobile Client"]
    OBSERVER["🧑‍💻 Operator"]

    P1(("1.0<br/>Authenticate<br/>ออก JWT"))
    P2(("2.0<br/>Browse Catalog<br/>อ่านรายการสินค้า"))
    P3(("3.0<br/>Reserve Slot<br/>จองสิทธิ์ซื้อ"))
    P4(("4.0<br/>Process Order<br/>ตัดสต็อกจริง"))
    P5(("5.0<br/>Invalidate Cache"))
    P6(("6.0<br/>Observe<br/>เก็บตัวชี้วัด"))
    P7(("7.0<br/>Verify Integrity<br/>👁️ อ่านอย่างเดียว"))

    DS1[("D1 catalog:page:*<br/>redis-cache")]
    DS2[("D2 stock:flash_sale:*<br/>redis-data")]
    DS3[("D3 lock:order:* / bought:*<br/>redis-data")]
    DS4[("D4 BullMQ orders queue<br/>redis-data")]
    DS5[("D5 products<br/>PG primary")]
    DS6[("D6 products<br/>PG replica")]
    DS7[("D7 orders<br/>PG primary")]
    DS8[("D8 metrics:counters<br/>metrics:instances<br/>redis-data")]

    CLIENT -->|"userId"| P1
    P1 -->|"accessToken"| CLIENT

    CLIENT -->|"page, limit + JWT"| P2
    P2 <-->|"metadata (cache-aside)"| DS1
    P2 -->|"อ่านเมื่อ cache miss"| DS6
    P2 -->|"MGET stock overlay"| DS2
    P2 -->|"data[] + meta{}"| CLIENT

    CLIENT -->|"productId + JWT"| P3
    P3 <-->|"ตรวจ + ตั้ง lock/bought"| DS3
    P3 <-->|"ตรวจ + DECR สต็อกเร็ว"| DS2
    P3 -->|"job: userId, productId, jobId"| DS4
    P3 -->|"202 orderJobId / 4xx"| CLIENT

    DS4 -->|"job"| P4
    P4 -->|"atomic UPDATE remaining_stock"| DS5
    P4 -->|"INSERT order CONFIRMED"| DS7
    P4 -->|"SET bought / DEL lock"| DS3
    P4 -.->|"ชดเชย: INCR สต็อกคืนเมื่อล้มเหลว"| DS2
    P4 -->|"trigger"| P5

    P5 -->|"DEL catalog:page:*"| DS1
    DS5 -.->|"streaming replication"| DS6

    P2 -.->|"inc() ⚡ ในหน่วยความจำ<br/>ไม่มี I/O"| P6
    P3 -.->|"inc() ⚡ ในหน่วยความจำ<br/>ไม่มี I/O"| P6
    P4 -.->|"inc() ⚡ ในหน่วยความจำ<br/>ไม่มี I/O"| P6
    P6 -->|"⏱️ ทุก 1 วินาที: HINCRBY เป็นชุด<br/>(write-behind ไม่ใช่ hot path)"| DS8

    DS8 --> P6
    DS4 --> P6
    DS1 --> P6
    P6 -->|"counters + สถานะราย instance"| OBSERVER

    DS2 --> P7
    DS4 --> P7
    DS5 --> P7
    DS7 --> P7
    P7 -->|"drift, verdict, headline<br/>❗ ตรวจแล้วบอก ไม่ซ่อม"| OBSERVER

    style P3 fill:#fecaca,stroke:#b91c1c,stroke-width:2px
    style P4 fill:#fecaca,stroke:#b91c1c,stroke-width:2px
    style DS2 fill:#fef3c7,stroke:#b45309
    style DS4 fill:#fef3c7,stroke:#b45309
    style P7 fill:#e0e7ff,stroke:#4338ca,stroke-dasharray: 4 3
```

> 🔴 **Process 3.0 และ 4.0 คือหัวใจของโจทย์** — เป็นสองจุดเดียวที่แตะสต็อก
> 🟡 **D2 และ D4 อยู่บน `redis-data` (`noeviction` + AOF)** ห้ามถูก evict เด็ดขาด ส่วน D1 อยู่บน `redis-cache` (`allkeys-lru`) หายได้ไม่เป็นไร
>
> ⚡ **เส้นจาก 2.0/3.0/4.0 ไป 6.0 เป็นเส้นประโดยเจตนา** — `MetricsService.inc()` เป็น **การบวก `Map` ในหน่วยความจำแบบ synchronous ล้วน ไม่มี I/O และไม่ throw** (`metrics.service.ts:85-87`)
> **hot path จึงไม่มีลูกศรเข้า D8 แม้แต่เส้นเดียว** — ตัวที่เขียนลง Redis คือ **timer 1 วินาที** ของ 6.0 ต่างหาก ถ้าวาดผิดเป็น "3.0 ─► D8" จะกลายเป็นการเพิ่มภาระให้ `redis-data` อีก ~1,500 ops/s บน connection เดียวกับที่ gatekeeper ใช้ = **เครื่องมือวัดไปกวนสิ่งที่กำลังวัด** (เหตุผลเต็มใน [`architecture-rationale.md`](./architecture-rationale.md) ADR-8)
>
> 👁️ **Process 7.0 มีแต่ลูกศร "เข้า" ไม่มีลูกศร "ออก" ไปหา data store ใดเลย** — เป็น observer อ่านอย่างเดียว ตรวจเจอ drift แล้ว**บอก** ไม่ซ่อม (ดู §10.2 ว่าทำไมการซ่อมอัตโนมัติอันตรายกว่าปัญหาเดิม)

---

## 3. 🔍 DFD Level 2 — ขยาย Process 3.0 (Write Path)

```mermaid
flowchart TD
    CLIENT["👤 Client"]

    P31(("3.1<br/>Verify JWT<br/>zero-I/O"))
    P32(("3.2<br/>Lua Gatekeeper<br/>atomic 1 roundtrip"))
    P33(("3.3<br/>Enqueue Job"))
    P34(("3.4<br/>Compensate<br/>คืนสิทธิ์"))
    P35(("3.5<br/>Map Response"))

    DS2[("D2 stock:flash_sale:*")]
    DS3[("D3 lock:* / bought:*")]
    DS4[("D4 orders queue")]

    CLIENT -->|"productId + Bearer JWT"| P31
    P31 -->|"userId = jwt.sub"| P32
    P31 -.->|"ลายเซ็นไม่ผ่าน"| P35

    P32 -->|"GET stock"| DS2
    P32 -->|"EXISTS bought / lock"| DS3
    P32 -->|"DECR stock"| DS2
    P32 -->|"SET lock PX 30000"| DS3
    P32 -->|"verdict = 1 (ผ่าน)"| P33
    P32 -.->|"verdict = -1/-2/-3/-4"| P35
    P32 -.->|"เรียกล้มเหลว/timeout ⚠️<br/>(ไม่รู้ว่า DECR ไปแล้วหรือยัง)"| P34

    P33 -->|"add job (jobId เดิมซ้ำได้ไม่มีผล)"| DS4
    P33 -->|"enqueue สำเร็จ"| P35
    P33 -.->|"enqueue ล้มเหลว ⚠️"| P34

    P34 -->|"INCR stock คืน"| DS2
    P34 -->|"DEL lock"| DS3
    P34 -.->|"503"| P35

    P35 -->|"202 / 401 / 409 / 429 / 503"| CLIENT

    style P32 fill:#fecaca,stroke:#b91c1c,stroke-width:2px
    style P34 fill:#fed7aa,stroke:#c2410c,stroke-width:2px
```

> ⚠️ **Process 3.4 คือจุดที่ blueprint ฉบับเก่าไม่มี** — ถ้า 3.3 ล้มหลังจาก 3.2 หัก `DECR` ไปแล้วโดยไม่คืน สต็อก 1 ชิ้นจะหายถาวร ทำให้ `remainingStock` ไม่มีวันลงถึง 0 = ตกเกณฑ์ Data Integrity Proof
> ✅ **แก้แล้ว (2026-08-27)**: เส้นทาง 3.2 ล้มเหลว/timeout เอง (ไม่ใช่แค่ 3.3) ก็ต้องผ่าน 3.4 ด้วย — เพราะไม่รู้ว่า Lua รันถึง `DECR` ไปแล้วหรือยัง `compensateIfReserved()` ใช้ค่าใน `lock:order:*` เป็นหลักฐานแทนการเดา (ดู §6.3 แถวสุดท้าย)

---

## 4. 📖 Data Dictionary

### 4.1 Data Stores

| ID | ชื่อ | ที่อยู่จริง | โครงสร้าง | นโยบาย |
| :-- | :--- | :--- | :--- | :--- |
| **D1** | Catalog metadata cache | `redis-cache` | `catalog:page:{p}:limit:{l}` → JSON | TTL 30–60s **+ jitter**, `allkeys-lru` |
| **D2** | Fast stock counter | `redis-data` | `stock:flash_sale:{productId}` → integer | **ไม่มี TTL**, `noeviction` |
| **D3** | Lock & purchase flag | `redis-data` | `lock:order:{u}:{p}` → token (PX 30s)<br/>`bought:{p}:{u}` → "1" | lock มี TTL, flag ไม่มี |
| **D4** | Order job queue | `redis-data` | BullMQ `orders`, `jobId = order:{u}:{p}` | AOF on, `removeOnComplete: {count: 5000}` |
| **D5** | products (เขียน) | PG **primary** | `id, name, description, price, available_stock, remaining_stock, is_flash_sale_active, created_at, updated_at` | `CHECK (remaining_stock >= 0)`<br/>`CHECK (remaining_stock <= available_stock)` |
| **D6** | products (อ่าน) | PG **replica** | เหมือน D5 | read-only, มี lag 10–100ms |
| **D7** | orders | PG **primary** | `id, user_id, product_id, status, created_at` | `UNIQUE (user_id, product_id)` |
| **D8** | Observability counters | `redis-data` | `metrics:counters` → hash (field = ชื่อ metric, value = ยอดสะสม)<br/>`metrics:instances` → hash (field = `INSTANCE_ID`, value = JSON snapshot) | **ไม่มี TTL**, `noeviction` · เขียนแบบ **write-behind ทุก 1 วินาที** ไม่ใช่ทุกครั้งที่นับ · ล้างได้ด้วย `POST /admin/metrics/reset` |

> 🟡 **ทำไม D8 ถึงอยู่บน `redis-data` ไม่ใช่ `redis-cache`** — `redis-cache` เป็น `allkeys-lru` ตัวนับจะถูก evict หายเงียบๆ กลางการยิง k6 แล้วตัวเลขในรายงานจะขาดโดยไม่มีใครรู้ (`redis.keys.ts:31-38`)
> และ **ทำไมไม่เก็บใน RAM ของ process** — 6 instance ต้องบวกลงถังใบเดียวกัน ถ้าเก็บแยกกัน หน้าแดชบอร์ดจะเห็นแค่ 1 ใน 6 ของทราฟฟิก (ผิดกฎ stateless — `CLAUDE.md` §6 DON'T)

> 📐 **type เต็มของ D5/D7 อยู่ที่** [`architecture.md`](./architecture.md) **§3.1** — `price` เป็น `NUMERIC(10,2)` และ `products.id` เป็น `VARCHAR` PK ที่กำหนดเอง ไม่ใช่ uuid

### 4.2 Data Flow — สัญกรณ์: `=` ประกอบด้วย · `+` และ · `{}` ซ้ำได้ · `()` มีหรือไม่มีก็ได้ · `|` เลือกอย่างใดอย่างหนึ่ง

```
คำขอ_token        = userId
accessToken       = header + payload + signature
payload           = sub (userId) + iat + exp

คำขอ_รายการสินค้า  = page + limit + accessToken
รายการสินค้า       = status + {สินค้า} + meta
สินค้า            = productId + name + price + availableStock
                    + remainingStock + isFlashSaleActive
meta              = total + page + limit + totalPages

คำสั่งซื้อ         = productId + accessToken
ผลรับเข้าคิว       = status + orderJobId + message
                  | ข้อผิดพลาด

order_job         = userId + productId + correlationId
verdict           = 1 | -1 | -2 | -3 | -4

metric_increment  = ชื่อ_metric + จำนวน          (ในหน่วยความจำ ไม่ข้ามเครือข่าย)
metric_flush      = {ชื่อ_metric + ยอดสะสม} + instance_snapshot
instance_snapshot = instanceId + pid + uptimeSeconds + rssMb + heapUsedMb
                    + eventLoopP99Ms + eventLoopMaxMs + updatedAt
integrity_row     = productId + name + availableStock + dbRemaining
                    + (redisRemaining) + orders + buyers + soldByDb
                    + (drift) + verdict + {note}
integrity_report  = generatedAt + verdict + headline + {integrity_row} + totals
                    + (queue) + queueDrained + (replicationLagSeconds)
                    + {redis_snapshot} + (pool)
drift             = redisRemaining − dbRemaining
integrity_verdict = ok | unknown | warn | critical
```

> **จุดสำคัญ**: `remainingStock` **ไม่ได้** อยู่ใน D1 (metadata cache) แต่ถูกดึงจาก **D2** แล้ว merge ตอน serialize
> นี่คือเหตุผลที่แคชอยู่ได้นาน 30–60 วินาทีโดยไม่ต้อง invalidate ทุกครั้งที่มีคนซื้อ แต่สต็อกยังสดเสมอ — เป็นคำตอบของ *"เงื่อนไขสำคัญ"* ในโจทย์

---

## 5. 🎛️ CFD Level 1 — Control Flow Diagram

CFD ใช้สัญกรณ์เดียวกับ DFD แต่ **ตัดข้อมูลออก เหลือแต่สัญญาณควบคุม (event flow)** เพื่อตอบว่า *อะไรสั่งให้อะไรทำงาน*

```mermaid
flowchart TD
    REQ["📥 HTTP Request มาถึง"]

    C1{{"CTRL-1<br/>JWT ถูกต้อง?"}}
    C2{{"CTRL-2<br/>Lua Gatekeeper<br/>⚛️ ATOMIC"}}
    C3{{"CTRL-3<br/>enqueue สำเร็จ?"}}
    C4{{"CTRL-4<br/>affected = 0?<br/>⚛️ ATOMIC SQL"}}
    C5{{"CTRL-5<br/>ชนิดความล้มเหลว?"}}
    C6{{"CTRL-6<br/>UNIQUE ผ่าน?<br/>⚛️ DB CONSTRAINT"}}

    R401["401 Unauthorized"]
    R409A["409 ซื้อไปแล้ว"]
    R429["429 กำลังประมวลผล"]
    R409B["409 ของหมด"]
    R503A["503 ยังไม่ seed stock"]
    R503B["503 คิวไม่พร้อม"]
    R202["✅ 202 Accepted"]

    OK["✅ order CONFIRMED"]
    COMP["🔄 Compensate<br/>INCR stock + DEL lock<br/>(guard ด้วย jobId)"]
    RETRY["🔁 Retry<br/>exponential + jitter"]
    DROP["⛔ จบงาน ไม่ retry<br/>(permanent failure)"]

    REQ --> C1
    C1 -.->|"ไม่ผ่าน"| R401
    C1 -->|"ผ่าน · userId = jwt.sub"| C2

    C2 -.->|"-1"| R409A
    C2 -.->|"-2"| R429
    C2 -.->|"-3"| R409B
    C2 -.->|"-4"| R503A
    C2 -.->|"เรียกล้มเหลว/timeout ⚠️"| COMP
    C2 -->|"1 · DECR + SET lock"| C3

    C3 -.->|"ล้มเหลว"| COMP
    COMP -.-> R503B
    C3 -->|"สำเร็จ"| R202

    R202 ==>|"⏱️ ตัดขาดแบบ async<br/>client ไม่รอผลตรงนี้"| C4

    C4 -->|"affected = 1"| C6
    C4 -.->|"affected = 0 · ของหมดใน DB"| DROP
    C6 -->|"insert สำเร็จ · COMMIT"| OK
    C6 -.->|"23505 ซ้ำ = เคยสำเร็จแล้ว"| DROP
    C6 -.->|"error อื่น"| C5

    C5 -.->|"transient เช่น เชื่อมต่อหลุด"| COMP
    COMP -.-> RETRY
    RETRY -.->|"attempt < 3"| C4
    RETRY -.->|"attempt หมด"| DROP

    OK -.->|"event: order.confirmed"| INV(("Invalidate<br/>Cache"))

    style C2 fill:#fecaca,stroke:#b91c1c,stroke-width:3px
    style C4 fill:#fecaca,stroke:#b91c1c,stroke-width:3px
    style C6 fill:#fecaca,stroke:#b91c1c,stroke-width:3px
    style R202 fill:#bbf7d0,stroke:#15803d,stroke-width:2px
    style OK fill:#bbf7d0,stroke:#15803d,stroke-width:2px
    style COMP fill:#fed7aa,stroke:#c2410c,stroke-width:2px
```

**สามจุดที่เป็น atomic boundary จริง** (🔴 กรอบหนา) — ความถูกต้องทั้งระบบวางอยู่บนสามจุดนี้เท่านั้น ที่เหลือคือ optimization เพื่อไม่ให้ traffic ไปถึง:

| จุด | กลไก atomic | ป้องกันอะไร |
| :--- | :--- | :--- |
| **CTRL-2** | Redis single-threaded ระหว่างรัน Lua | 500 requests interleave กันไม่ได้ |
| **CTRL-4** | `UPDATE ... WHERE remaining_stock > 0` ใน 1 statement | TOCTOU (อ่านแล้วค่อยเขียน) |
| **CTRL-6** | `UNIQUE (user_id, product_id)` | ซื้อซ้ำแม้โค้ดข้างบนพังหมด |

**เส้นคู่ `==>` คือจุดตัด synchronous/asynchronous** — client ได้ 202 แล้วจากไป การควบคุมหลังจากนี้อยู่ในมือ worker ทั้งหมด

---

## 6. 📋 CSPEC — Control Specification

### 6.1 Decision Table — CTRL-2 (Lua Gatekeeper)

ตรวจ **ตามลำดับบนลงล่าง** เจอเงื่อนไขแรกที่จริงแล้วหยุดทันที

| ลำดับ | เงื่อนไข | verdict | HTTP | เขียนอะไรลง Redis | เหตุผล |
| :-- | :--- | :--: | :--: | :--- | :--- |
| 1 | `GET stock` คืน `nil` | **-4** | 503 | — | key ยังไม่ seed หรือถูก evict — **ต้องแยกจาก "ของหมด"** ไม่งั้นระบบตอบของหมดตลอดกาลอย่างเงียบๆ |
| 2 | `EXISTS bought:{p}:{u}` | **-1** | 409 | — | เคยซื้อสำเร็จแล้ว (Limit 1 per user) |
| 3 | `EXISTS lock:order:{u}:{p}` | **-2** | 429 | — | มี order in-flight อยู่ = ผู้ใช้กดรัว |
| 4 | `tonumber(stock) <= 0` | **-3** | 409 | — | ของหมดจริง (450 คนจบที่นี่) |
| 5 | นอกเหนือจากนั้น | **1** | 202 | `DECR stock` + `SET lock PX 30000` | จองสิทธิ์สำเร็จ |

> ทั้ง 5 แถวรันอยู่ใน **Lua script เดียว = 1 network roundtrip และ atomic** เพราะ Redis เป็น single-threaded ระหว่างรัน Lua ไม่มีทางที่ request อื่นจะแทรกระหว่างแถว 4 กับ 5 ได้

### 6.2 Decision Table — CTRL-4/5/6 (Worker)

| เงื่อนไข | Retry? | คืนสต็อก? | สถานะสุดท้าย | เหตุผล |
| :--- | :--: | :--: | :--- | :--- |
| `affected = 1` + insert ผ่าน | — | ไม่ | **CONFIRMED** | สำเร็จ |
| `affected = 0` (ของหมดใน DB) | ❌ | ❌ **ไม่คืน** | `sold_out` → **`return`** | permanent — retry ไม่มีทางสำเร็จ · **และการคืนตรงนี้ทำให้ระบบไม่ self-heal** (ดูหมายเหตุใต้ตาราง) |
| PG `23505` (unique ซ้ำ) | ❌ | ❌ | `already_confirmed` → **`return`** | job นี้เคยสำเร็จแล้ว = **idempotency** ห้ามคืนสต็อก |
| PG `23514` (check ติดลบ) | ✅ (เหมือน transient) | เฉพาะ attempt สุดท้าย | retry ก่อน แล้วค่อย `failed` | **โค้ดจริงไม่มี case แยกสำหรับ `23514`** ตกเข้า branch เดียวกับ transient error — **ตั้งใจปล่อยไว้ เพราะ `23514` เข้าไม่ถึงตั้งแต่แรก**: `chk_positive_stock (remaining_stock >= 0)` จะถูกละเมิดได้ก็ต่อเมื่อ `remaining_stock` เป็น 0 แล้วยังถูก -1 ต่อ แต่ UPDATE มี `WHERE remaining_stock > 0` กันไว้แล้ว (`orders.processor.ts:67`) ค่าต่ำสุดที่เป็นไปได้คือ 0 พอดี · `chk_stock_ceiling` ก็ละเมิดไม่ได้เพราะ path นี้มีแต่ลด ไม่เพิ่ม · **ตรวจยืนยันแล้ว 2026-08-29 — ไม่ต้องแก้โค้ด** ถ้าวันหนึ่ง `23514` โผล่ขึ้นมาจริง แปลว่ามีคนแก้ `WHERE` clause หรือมี writer ตัวอื่นนอก worker |
| PG `40P01` (deadlock) | ✅ | เฉพาะ attempt สุดท้าย | retry | exponential backoff **+ jitter** · คืนตอน attempt 1 แล้ว attempt 2 สำเร็จ = Redis สูงกว่า DB ถาวร |
| เชื่อมต่อหลุด / timeout | ✅ | เฉพาะ attempt สุดท้าย | retry | transient — เหตุผลเดียวกับแถวบน |
| **side effect หลัง COMMIT ล้ม** | ❌ | ❌ **ห้ามคืนเด็ดขาด** | **CONFIRMED** | ⚠️ ของขายไปแล้วจริง ถ้าคืนสต็อกตรงนี้ = **oversell** |

> แถวสุดท้ายคือบั๊กที่พบใน blueprint ฉบับเก่า — `markBought` / `invalidateCache` ถูกวางไว้ใน `try` เดียวกับ transaction ทำให้ Redis สะดุดหลัง commit แล้วระบบไปคืนสต็อกทั้งที่ order เกิดขึ้นแล้ว
>
> ⚠️ **แก้ 2026-08-26 — `affected = 0` เปลี่ยนจาก "คืน" เป็น "ไม่คืน"**
> `affected = 0` แปลว่า Redis บอก "ผ่าน" แต่ DB บอก "หมด" = **Redis สูงกว่า DB อยู่ก่อนแล้ว**
> ถ้าคืน จะดัน Redis ขึ้นอีก → ปล่อยคนถัดไปเข้ามา → job ตาย sold-out อีก → คืนอีก **วนไม่จบ**
> `stock:flash_sale:p-1001` จะลู่เข้าหา 1 ไม่มีวันถึง 0 = ตกเกณฑ์ Data Integrity §9.3 ข้อ 4
> การไม่คืนทำให้ counter ลู่ลงเข้าหา DB แล้วหยุดเอง (lock ปล่อยให้ TTL เก็บ)

### 6.3 ตารางกฎการชดเชย (Compensation Rules)

| เกิดที่ | คืนสต็อก | ปลด lock | guard | ทำไม |
| :--- | :--: | :--: | :--- | :--- |
| `gatekeeper()` เรียกล้มเหลว/timeout (§3.2) | ✅ | ✅ CAS | เทียบ `requestToken` ใน `lock:order:*` ก่อนคืน | ไม่รู้ว่า Lua รันถึง `DECR` จริงหรือเปล่า — ใช้ค่าใน lock เป็นหลักฐานแทนการเดา (`compensate-if-reserved.lua`) |
| `queue.add()` ล้ม (§3.3) | ✅ | ✅ CAS | — | ยังไม่มี job ไม่มีใครมาทำต่อ |
| BullMQ dedup jobId ซ้ำ (job ที่เก็บอยู่เป็นของคำขออื่น) | ✅ | ✅ CAS | — | DECR รอบนี้ไม่มีใครกิน — ตรวจด้วย `queue.getJob()` ไม่ใช่ค่าที่ `add()` คืน |
| ตรวจ job ที่เก็บอยู่**ไม่ได้** | ❌ | ❌ | — | ยืนยันไม่ได้ ≠ เป็นของคนอื่น · คืนผิดตอนของขายแล้วแย่กว่าไม่คืน |
| worker ล้ม (transient) **ก่อน** COMMIT — attempt 1–2 | ❌ | ❌ | — | จะ retry ต่อ · คืนแล้ว retry สำเร็จ = Redis สูงกว่า DB ถาวร |
| worker ล้ม (transient) **ก่อน** COMMIT — attempt สุดท้าย | ✅ | ✅ CAS | `compensated:{jobId}:{requestToken}` (TTL 300s) | ตายจริงแล้ว ต้องคืนสิทธิ์ให้คนอื่น |
| worker เจอ `affected = 0` (sold out) | ❌ | ❌ | — | Redis สูงกว่า DB อยู่แล้ว การคืนทำให้วนไม่จบ (§6.2) |
| worker เจอ `23505` | ❌ | ❌ | — | job นี้เคยสำเร็จแล้ว = idempotency |
| worker ล้ม **หลัง** COMMIT | ❌ | ❌ | — | ปล่อยให้ lock หมดอายุเอง (TTL 30s) |

> **ปลด lock ทุกครั้งเป็น compare-and-delete** โดยเทียบกับ `requestToken` ที่ gatekeeper เขียนลงไป
> (**ไม่ใช่** `jobId` ซึ่งซ้ำทุกครั้งที่คนเดิมขอของเดิม จน CAS แยกการถือครองไม่ออก — แก้ 2026-08-26)

### 6.4 Decision Table — CTRL-7 (Integrity Verdict)

ตารางนี้เป็น **ตัวตัดสินสี ไม่ใช่ตัวสั่งการ** — ไม่ว่าออกมาแถวไหน ระบบก็ **ไม่แก้อะไรทั้งสิ้น** (`integrity.service.ts:227-281`)
ประเมินทีละสินค้า แล้วเอา verdict ที่แย่ที่สุดมาเป็นของทั้งรายงาน (`ok < unknown < warn < critical`)

| เงื่อนไข | verdict | หมายความว่าอะไร |
| :--- | :--: | :--- |
| `orders > availableStock` | 🔴 **critical** | **OVERSELL** — ข้อที่ทั้งระบบสร้างมาเพื่อกัน ถ้าขึ้นแถวนี้แปลว่าด่านที่ 4 (DB constraint) ก็ทะลุ |
| `dbRemaining < 0` | 🔴 **critical** | `remaining_stock` ติดลบ = `chk_positive_stock` ถูกละเมิด |
| `orders ≠ buyers` | 🔴 **critical** | มีคนซื้อซ้ำ = `UNIQUE (user_id, product_id)` ทะลุ |
| `availableStock − dbRemaining ≠ orders` | 🔴 **critical** | DB ไม่สมดุลในตัวเอง — ตัดสต็อกไปแล้วแต่ไม่มี order (หรือกลับกัน) |
| `redisRemaining` เป็น `null` | 🟡 **warn** | ไม่มี stock counter ใน Redis — ยังไม่ `seed:redis` หรือ key หายไป |
| `redisRemaining > dbRemaining` (drift เป็นบวก) | 🔴 **critical** | **Redis สูงกว่า DB — เสี่ยงปล่อยคนที่ 51 เข้ามา** นี่คือทิศทางที่อันตรายจริง |
| drift ติดลบ **ขณะที่คิวยังไม่ว่าง** | 🟢 **ok** | ปกติ — Redis จองก่อน DB ตัดทีหลัง แค่ note ไว้เฉยๆ ไม่ยกระดับ |
| drift ติดลบ **ขณะที่คิวว่างแล้ว** | 🟡 **warn** | **สต็อกรั่ว (undersell)** — งานหมดแล้วแต่ Redis ยังต่ำกว่า DB แปลว่ามีสิทธิ์ที่หายไปโดยไม่ถูกคืน |

> ⚖️ **สังเกตความไม่สมมาตร**: drift **เป็นบวก** = critical เสมอ แต่ drift **ติดลบ** ต้องดู `queueDrained` ก่อน
> เพราะระหว่างที่ยังมี job ค้าง Redis **ต้อง** ต่ำกว่า DB โดยธรรมชาติ (จองที่ Redis แล้ว DB ยังไม่ถูกแตะ — สถานะ `Reserved` ใน §7)
> การเช็คนี้จึงต้องอ่าน job counts จาก D4 ก่อน ไม่งั้นทุกการยิงจะรายงาน false positive ตลอดเวลาที่ระบบกำลังทำงานปกติ
>
> ⚠️ **ต้องอ่านจาก master เท่านั้น** (`createQueryRunner('master')` — invariant §4 ข้อ 3) ถ้าอ่าน replica ที่มี lag มาเทียบกับ Redis ที่สดเสมอ หน้านี้จะรายงาน drift ปลอมทุกครั้งที่ replica ตามไม่ทัน (`integrity.service.ts:176-182`)

---

## 7. 🔄 Order State Machine

```mermaid
stateDiagram-v2
    [*] --> Requested: POST /api/v1/orders

    Requested --> Rejected: JWT ไม่ผ่าน / เคยซื้อ<br/>กดรัว / ของหมด
    Requested --> Reserved: Lua verdict = 1<br/>(DECR + lock)

    Reserved --> Queued: enqueue สำเร็จ<br/>ตอบ 202
    Reserved --> Compensated: enqueue ล้มเหลว

    Queued --> Processing: worker รับ job

    Processing --> Confirmed: affected=1 + INSERT + COMMIT
    Processing --> Confirmed: PG 23505<br/>(เคยสำเร็จแล้ว = idempotent)
    Processing --> SoldOutAtDb: affected=0<br/>(permanent, ไม่ retry)
    Processing --> Retrying: transient error

    Retrying --> Processing: attempt < 3<br/>backoff + jitter
    Retrying --> Failed: attempt หมด

    SoldOutAtDb --> [*]: ไม่คืนสต็อก<br/>(ปล่อย counter ลู่ลงหา DB)
    Failed --> Compensated: เฉพาะ attempt สุดท้าย

    Confirmed --> [*]: SET bought · DEL lock<br/>invalidate cache
    Compensated --> [*]: INCR stock คืน · DEL lock
    Rejected --> [*]

    note right of Reserved
        สต็อกถูกหักใน Redis แล้ว
        แต่ DB ยังไม่ถูกแตะ
        ทางออกปกติต้องจบที่
        Confirmed หรือ Compensated
        ยกเว้น SoldOutAtDb ที่จงใจ
        ไม่คืน เพื่อให้ counter
        ลู่ลงเข้าหา DB
    end note

    note right of Confirmed
        ห้ามคืนสต็อกอีก
        แม้ side effect หลังนี้จะล้มเหลว
    end note
```

**Invariant ของ state machine**: ทุกเส้นทางที่ผ่าน `Reserved` ต้องจบที่ `Confirmed` หรือ `Compensated`
**ยกเว้นทางเดียวคือ `SoldOutAtDb`** ซึ่งจงใจไม่คืน เพราะการมาถึงสถานะนั้นแปลว่า Redis สูงกว่า DB อยู่แล้ว
การไม่คืนคือสิ่งที่ทำให้ counter ลู่ลงเข้าหาความจริง (ดู §6.2)

ถ้าเจอเส้นทาง**อื่น**ที่หลุดออกไปโดยไม่ผ่านสองสถานะนี้ แปลว่าสต็อกรั่ว และ `remainingStock` จะไม่ลงถึง 0

---

## 8. 🛡️ Concurrency Control Map

ตารางนี้ตอบว่า *invariant แต่ละข้อของโจทย์ ถูกบังคับใช้ด้วยอะไร ที่ชั้นไหน และขอบเขต atomic แค่ไหน*

| Invariant | ชั้นที่ 1 (เร็ว/กรอง) | ชั้นที่ 2 (ถูกต้องจริง) | ขอบเขต Atomic | ถ้าชั้น 1 พังจะเกิดอะไร |
| :--- | :--- | :--- | :--- | :--- |
| **ไม่ขายเกิน 50 ชิ้น** | `DECR stock:*` ใน Lua | `UPDATE ... WHERE remaining_stock > 0` + `CHECK (>= 0)` | Lua: ทั้ง script<br/>SQL: ทั้ง statement | traffic ทะลุถึง DB มากขึ้น (ช้าลง) แต่ **ยังไม่ oversell** |
| **1 คน 1 ชิ้น** | `EXISTS bought:{p}:{u}` | `UNIQUE (user_id, product_id)` | Lua: ทั้ง script<br/>DB: index | insert ซ้ำถูกปฏิเสธที่ DB → จับ `23505` → ถือว่าสำเร็จ |
| **กดรัวไม่ได้ของ 2 ชิ้น** | `lock:order:{u}:{p}` PX 30s | `jobId` deterministic + `UNIQUE` | Lua: `SET` ใน script เดียว | BullMQ ปฏิเสธ jobId ซ้ำ → ยังกันได้ |
| **ไม่อ่านสต็อกเก่า** | — | `createQueryRunner('master')` | transaction | ถ้าเผลออ่าน replica → **race condition ทันที** (ไม่มีชั้นสำรอง) |
| **retry ไม่ตัดสต็อกซ้ำ** | `compensated:{jobId}:{requestToken}` | `UNIQUE` + จับ `23505` | Redis: `SET NX` | คืนสต็อกซ้ำ → Redis บวกเกิน → oversell ที่ชั้น 1 |
| **สต็อกที่ client เห็นถูกต้อง** | — | `MGET stock:*` ทุก request | — | ถ้าเอา `remainingStock` ไปแคช → 6 instance ตอบไม่ตรงกัน |

> **แถวที่ไม่มีชั้นสำรอง (`createQueryRunner('master')`) คือแถวที่อันตรายที่สุด** — พลาดแล้วไม่มีอะไรมาช่วย และจะ reproduce ได้เฉพาะตอน load สูงเท่านั้น

> 👁️ **Process 7.0 ไม่ได้เพิ่มชั้นป้องกันให้ตารางนี้เลยแม้แต่แถวเดียว** — มันไม่ใช่ "ชั้นที่ 3"
> ทุกช่องในตารางยังบังคับใช้ด้วยกลไกเดิมทั้งหมด สิ่งที่ 7.0 เพิ่มเข้ามาคือ **ความสามารถในการมองเห็นว่าแถวไหนถูกละเมิดไปแล้ว** ซึ่งเดิมต้องรัน SQL ของ §9.3 ด้วยมือ
> การเข้าใจผิดว่ามันเป็นด่านป้องกันจะนำไปสู่การเผลอ "ให้มันซ่อม drift ให้เอง" ซึ่งเป็นสิ่งที่**ห้ามทำ** (§10.2)

---

## 9. ⏱️ Sequence Diagram — 500 VUs แย่งของ 50 ชิ้น

แสดง 3 กรณีตัวแทน: **ผู้ชนะ** · **ผู้แพ้ (ของหมด)** · **คนกดรัว**

```mermaid
sequenceDiagram
    autonumber
    actor UA as 🟢 User A (ผู้ชนะ)
    actor UB as 🔴 User B (ของหมด)
    participant NG as Nginx
    participant API as NestJS API
    participant RD as redis-data
    participant Q as BullMQ
    participant W as Worker
    participant PG as PG Primary

    Note over UA,UB: 500 VUs ยิงพร้อมกัน · stock counter = 50

    UA->>NG: POST /orders {p-1001} + JWT
    NG->>API: least_conn → app-2
    API->>API: verify JWT (zero-I/O) → userId
    API->>RD: EVALSHA gatekeeper.lua
    Note over RD: ⚛️ ATOMIC<br/>bought? no · lock? no<br/>stock 50 > 0 → DECR → 49<br/>SET lock PX 30s
    RD-->>API: verdict = 1
    API->>Q: add job (jobId order:userA:p-1001)
    Q-->>API: queued
    API-->>UA: ✅ 202 {orderJobId}

    Note over UA: client จบแค่นี้ · ไม่รอ DB

    par ผู้ใช้ที่ 51 เข้ามาหลังสต็อกหมด
        UB->>API: POST /orders {p-1001} + JWT
        API->>RD: EVALSHA gatekeeper.lua
        Note over RD: ⚛️ ATOMIC<br/>stock = 0 → ไม่ DECR
        RD-->>API: verdict = -3
        API-->>UB: ❌ 409 Sold out
        Note over UB: จบภายในไม่กี่ ms<br/>ไม่แตะ DB เลย
    and คนกดรัวซ้ำระหว่าง in-flight
        UA->>API: POST /orders {p-1001} (คลิกซ้ำ)
        API->>RD: EVALSHA gatekeeper.lua
        Note over RD: lock:order:userA:p-1001 มีอยู่
        RD-->>API: verdict = -2
        API-->>UA: ⚠️ 429 กำลังประมวลผล
    end

    Note over W,PG: ประมวลผลแบบ async · concurrency 5/node (×6 = 30)

    Q->>W: job
    W->>PG: BEGIN (master connection)
    W->>PG: UPDATE products SET remaining_stock = remaining_stock - 1<br/>WHERE id = $1 AND remaining_stock > 0
    Note over PG: ⚛️ ATOMIC · affected = 1
    W->>PG: INSERT orders (CONFIRMED)
    Note over PG: ⚛️ UNIQUE(user_id, product_id) ผ่าน
    W->>PG: COMMIT
    PG-->>W: ok

    Note over W: ✅ committed = true<br/>ตั้งแต่จุดนี้ห้ามคืนสต็อกอีก

    W->>RD: SET bought:p-1001:userA
    W->>RD: DEL lock:order:userA:p-1001
    Note over W,RD: ถ้าสองคำสั่งนี้ล้ม → log แล้วกลืน<br/>❌ ห้ามคืนสต็อก (จะกลายเป็น oversell)

    Note over UA,PG: ผลลัพธ์: orders = 50 แถว · unique users = 50<br/>remaining_stock = 0 · GET stock:flash_sale:p-1001 = "0"
```

**อ่านไดอะแกรมนี้ยังไง**: 450 คนจาก 500 จบที่ขั้นตอน `verdict = -3` ซึ่ง**ไม่แตะ PostgreSQL เลยแม้แต่ query เดียว** — นี่คือเหตุผลที่ระบบรับ burst 500 คนได้โดย DB ไม่ล่ม โหลดจริงที่ลงไปถึง DB มีแค่ 50 transaction เท่านั้น

---

## 10. 📈 DFD Level 2 — ขยาย Process 6.0 (Observability)

เพิ่มเมื่อ 2026-08-30 พร้อมโมดูล `src/observability/` — ส่วนนี้ **ไม่ได้อยู่ในเส้นทางความถูกต้อง** แต่เป็นตัวที่ทำให้พิสูจน์ความถูกต้องได้โดยไม่ต้องเปิด `psql`

### 10.1 เส้นทางตัวนับ (Metrics) — write-behind

```mermaid
flowchart TD
    P2(("2.0<br/>Browse Catalog"))
    P3(("3.0<br/>Reserve Slot"))
    P4(("4.0<br/>Process Order"))

    P61(("6.1<br/>MetricsService.inc<br/>⚡ Map ใน RAM<br/>synchronous ไม่มี I/O"))
    P62(("6.2<br/>Flush Timer<br/>⏱️ ทุก 1 วินาที"))
    P63(("6.3<br/>Serve Dashboard<br/>/admin/insights"))
    P64(("6.4<br/>Serve Prometheus<br/>/admin/metrics"))

    BUF[("buffer: Map&lt;string,number&gt;<br/>⚠️ ในหน่วยความจำ process<br/>อายุ ≤ 1 วินาที")]
    DS8[("D8 metrics:counters<br/>metrics:instances<br/>redis-data")]

    OBSERVER["🧑‍💻 Operator"]

    P2 -.->|"cache hit/miss, degraded read"| P61
    P3 -.->|"requests, accepted, 409/429/503,<br/>compensation"| P61
    P4 -.->|"confirmed, sold_out, 23505,<br/>job duration"| P61

    P61 -->|"buffer.set(name, prev + by)"| BUF
    BUF -->|"ดูดออกทั้งก้อนแล้วเคลียร์"| P62
    P62 -->|"pipeline: HINCRBY ×N<br/>+ HSET instance snapshot"| DS8
    P62 -.->|"⚠️ flush ล้ม → ใส่กลับ buffer<br/>ห้ามทิ้ง (log ทุกครั้งที่ 30)"| BUF

    DS8 --> P63
    BUF -.->|"ยอดที่ยังค้าง"| P63
    DS8 --> P64
    P63 -->|"HTML + poll insights.json ทุก 3 วิ"| OBSERVER
    P64 -->|"Prometheus exposition format"| OBSERVER

    style P61 fill:#bbf7d0,stroke:#15803d,stroke-width:3px
    style BUF fill:#fef3c7,stroke:#b45309
    style DS8 fill:#fef3c7,stroke:#b45309
```

> ⚡ **จุดสำคัญที่สุดของไดอะแกรมนี้: 6.1 ไม่มีลูกศรไป `redis-data`**
> `inc()` คือ `buffer.set(name, (buffer.get(name) ?? 0) + by)` — บรรทัดเดียว ไม่มี `await` ไม่มี network และ **ไม่มีทาง throw ใส่ผู้เรียก** (การวัดผลห้ามทำให้คำสั่งซื้อล้ม)
> ตัวที่คุยกับ Redis คือ **6.2 เท่านั้น** และคุยแค่ **~1 roundtrip ต่อวินาทีต่อ instance** (pipeline ก้อนเดียว) แทนที่จะเป็น 1 ครั้งต่อ 1 การนับ
>
> ⚠️ **ราคาที่ยอมจ่าย**: ถ้า container โดน `SIGKILL` ตัวนับ ≤ 1 วินาทีสุดท้ายหาย · `SIGTERM` ปกติไม่หาย เพราะ `onModuleDestroy` flush ปิดท้าย (`metrics.service.ts:73-79`)
> buffer นี้**ไม่ขัดกฎ stateless** (`CLAUDE.md` §5 ข้อ 1) เพราะมันไม่ใช่ state ที่ต้องแชร์ — แหล่งความจริงคือ hash บน `redis-data` buffer เป็นแค่ write-behind อายุสั้น
>
> 📊 **6.3 บวกยอดที่ยังค้างใน buffer ของ instance ที่รับ request นั้นเข้าไปด้วย** (`metrics.service.ts:96-98`) ตัวเลขบนหน้าจอจึงไม่กระตุกเป็นขั้นบันไดทุก 1 วินาที
> แต่แปลว่า **ยอดของอีก 5 instance ยังเป็นค่าที่ flush แล้วเท่านั้น** — ตัวเลขอาจต่ำกว่าความจริงได้สูงสุด ~1 วินาทีของทราฟฟิก ซึ่งยอมรับได้สำหรับการรายงานผล

### 10.2 เส้นทางตรวจความถูกต้อง (Integrity) — read-only observer

```mermaid
flowchart TD
    P71(("7.1<br/>Read Products + Orders<br/>⚠️ master เท่านั้น"))
    P72(("7.2<br/>Read Stock Counters<br/>MGET"))
    P73(("7.3<br/>Read Queue Counts"))
    P74(("7.4<br/>Read Infra Stats"))
    P75(("7.5<br/>Compute Verdict<br/>ตาราง §6.4"))

    DS2[("D2 stock:flash_sale:*")]
    DS4[("D4 orders queue")]
    DS5[("D5 products · PG primary")]
    DS7[("D7 orders · PG primary")]
    DS6[("D6 PG replica")]

    OBSERVER["🧑‍💻 Operator"]
    NOFIX["⛔ ไม่มี process ซ่อม<br/>ไม่มีลูกศรเขียนกลับ"]

    DS5 --> P71
    DS7 --> P71
    DS2 --> P72
    DS4 --> P73
    DS6 -->|"replication lag"| P74
    DS2 -.->|"INFO: ops/s, hit ratio,<br/>evicted_keys, memory"| P74

    P71 -->|"availableStock, dbRemaining,<br/>orders, buyers"| P75
    P72 -->|"redisRemaining"| P75
    P73 -->|"queueDrained?"| P75
    P74 -->|"lag, pool, redis stats"| P75

    P75 -->|"drift + verdict + headline + notes"| OBSERVER
    P75 -.-> NOFIX

    style P75 fill:#e0e7ff,stroke:#4338ca,stroke-width:2px
    style NOFIX fill:#fee2e2,stroke:#dc2626,stroke-width:2px
```

> ⛔ **ไม่มีลูกศรจาก 7.x กลับเข้า D2 หรือ D5 — และนี่คือการตัดสินใจ ไม่ใช่งานที่ยังทำไม่เสร็จ**
> `INCR` ลอยๆ เพื่อ "ซ่อม" drift = **ปล่อยคนที่ 51 เข้ามา** เพราะตัวตรวจแยกไม่ออกระหว่าง *"สิทธิ์รั่วจริง"* กับ *"job ที่ยังไม่ถึงคิว"*
> ถ้าตรวจตอนที่ยังมี job ค้าง แล้วเชื่อว่า drift ติดลบ = รั่ว มันจะคืนสต็อกให้ job ที่กำลังจะสำเร็จอยู่แล้ว → DB ลง 1 · Redis ขึ้น 1 → **oversell**
> **การตรวจปลอดภัย การซ่อมไม่ปลอดภัย** — เหตุผลเต็มใน [`architecture-rationale.md`](./architecture-rationale.md) ADR-9 และ §6 Q6
>
> 🔎 ตัวตรวจนี้ **ทำงานตอนมีคนเปิดดูเท่านั้น** (`/admin/insights.json` และ `/admin/metrics` เรียก `integrity.check()` ตรงๆ) **ไม่มี cron ไม่มี `@Interval` ในฝั่งเซิร์ฟเวอร์**
> จังหวะ "ทุก 3 วินาที" มาจาก **JavaScript ในหน้าเว็บที่ poll เอง** (`insights.page.ts:431`) ปิดแท็บเมื่อไหร่ก็หยุดยิง query ทันที — จงใจ เพื่อไม่ให้มี query วิ่งกินทรัพยากรอยู่เบื้องหลังตลอดเวลาที่ยิง k6

### 10.3 ตัวนับที่มีอยู่จริง (`metrics.constants.ts`)

| กลุ่ม | metric | ใช้ตอบอะไรในรายงาน |
| :--- | :--- | :--- |
| **write path** | `orders_requests_total` · `orders_accepted_total` | 202 ที่ตอบไปทั้งหมดเท่ากับ 50 พอดีไหม (§9.3) |
| | `orders_rejected_duplicate_total` · `_sold_out_total` · `_in_flight_total` · `_no_counter_total` | 409/429/503 แยกสาเหตุได้จริง — **ไม่ใช่ error** ต้องแยกออกจากกันในรายงาน |
| | `orders_gatekeeper_errors_total` · `orders_enqueue_failures_total` · `orders_deduped_total` · `orders_job_unverified_total` | เส้นทางที่เคยทำสต็อกหาย 8 ชิ้น (ดู `CLAUDE.md` §0.1) ตอนนี้นับได้แล้ว |
| **ชดเชย** | `stock_compensated_total` · `stock_compensation_restored_total` · `stock_compensation_failures_total` | ⚠️ `failures` > 0 = **สต็อกรั่ว** ต้องอธิบายในรายงาน |
| **worker** | `worker_jobs_confirmed_total` · `_already_confirmed_total` · `_sold_out_total` · `_transient_failures_total` · `_post_commit_failures_total` | เทียบกับตาราง §6.2 ได้ทีละแถว |
| | `worker_job_duration_ms_sum` / `_count` | เวลาเฉลี่ยต่อ job (วัดจาก `job.processedOn` ที่ BullMQ ประทับให้ ไม่ได้จับเวลาเองในเส้นทางร้อน) |
| **read path** | `catalog_cache_hits_total` / `_misses_total` | **Cache Hit/Miss ที่โจทย์ขอในรายงาน** — เป็นตัวเลขระดับ *catalog cache* โดยตรง ต่างจาก `./scripts/cache-stats.sh` ที่อ่าน `keyspace_hits` ระดับเซิร์ฟเวอร์ (รวมทุก key ปนกัน) · ใช้คู่กันได้ แต่ตัวที่ตอบโจทย์ตรงกว่าคือตัวนี้ |
| | `catalog_degraded_reads_total` | จำนวนครั้งที่อ่าน stock ไม่ได้แล้ว degrade เป็นค่าจากแคช (`CLAUDE.md` §6 DO) |
| **gauge จาก 7.x** | `flash_sale_stock_drift{product_id}` · `flash_sale_integrity_verdict` | drift Redis↔DB เป็นตัวเลขเดียว 0=ok 1=warn 2=critical |
| | `flash_sale_event_loop_p99_ms{instance}` | **หลักฐานตรงของข้อสรุป "คอขวดคือ Node event loop"** (rationale §6 Q3 — เดิมพิสูจน์ได้แค่ทางอ้อมด้วย `podman stats`) |

> 🧹 **ก่อนยิง k6 รอบใหม่ต้อง `POST /admin/metrics/reset`** ไม่งั้นตัวเลขจะทบจากรอบก่อน
> คำสั่งนี้**ไม่แตะข้อมูลธุรกิจ** (order/stock ไม่เกี่ยว) จึง**ไม่ใช่ตัวแทนของ** `RESET_CONFIRM=yes pnpm run reset` — ยังต้องรันตัวนั้นแยกอยู่ดี

---

## 📎 อ้างอิง

- สเปกเต็ม: [`docs/Architecture/architecture.md`](architecture.md)
- กติกาสำหรับผู้พัฒนา / AI agent: [`CLAUDE.md`](../../CLAUDE.md)
- โจทย์ต้นฉบับ: [`docs/Requirement/Flash Sale System.pdf`](../Requirement/Flash%20Sale%20System.pdf)
