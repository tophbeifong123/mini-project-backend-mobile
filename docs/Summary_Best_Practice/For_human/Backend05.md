# Backend 05 — Async Communication: Pub/Sub & Message Queues

> ที่มา: `Backend05 - Async Communication.pdf`
> ขอบเขต: Sync vs Async · Redis Pub/Sub · Message Queue กับ BullMQ · Job lifecycle & retry · ระบบอีเมลที่ทนความล้มเหลว · Delayed/Priority/Rate limit/Concurrency

---

## 1. สรุปสาระสำคัญ (Core Concepts)

| หัวข้อ | ใจความ |
|---|---|
| **ปัญหาของ sync** | ผู้ใช้รอครบทุกขั้นตอน (ตัวอย่างในสไลด์: register = 25 วินาที), thread ถูกจอง, ไม่มี retry, mobile เปลืองแบตและ timeout ง่าย |
| **หลักตัดสิน** | operation ใช้เวลา **> 1 วินาที** หรือ **ไม่จำเป็นต้องได้ผลลัพธ์ทันที** → ทำเป็น async |
| **Pub/Sub** | one-to-many, broadcast, **ไม่มี persistence, ไม่มี ack, ไม่มี retry, ไม่มีลำดับ** — ข้อความหายถ้าไม่มีใคร subscribe |
| **Message Queue** | point-to-point, มี persistence, มี ack, มี retry อัตโนมัติ, FIFO ในคิว |
| **Event Streaming** | log-based, เก็บลำดับ, consumer มี offset ของตัวเอง (Kafka — ไม่ครอบคลุมในบทนี้) |
| **BullMQ** | queue บน Redis: job persistent, retry + backoff, delayed job, priority, rate limiter, concurrency, Bull Board UI |
| **Job lifecycle** | Waiting → Active → Completed / Failed → (retry ด้วย backoff) → Permanent Fail; Delayed สำหรับ job ที่ตั้งเวลา |
| **Exponential backoff** | delay 1s → 2s → 4s → 8s… ให้ปลายทางมีเวลาฟื้นตัว และไม่ถล่มซ้ำ |
| **SMTP 4xx vs 5xx** | 4xx (421/450/451/452) = transient → retry; 5xx (550/551/552/553) = permanent → **อย่า retry** |
| **สองไคลเอนต์ Redis** | client ที่อยู่ใน subscribe mode รันคำสั่งอื่นไม่ได้ → ต้องมี publisher client แยกจาก subscriber client |

---

## 2. Best Practices (พร้อมเหตุผล)

### 2.1 การเลือกรูปแบบ

| Practice | เหตุผล |
|---|---|
| **Pub/Sub สำหรับ broadcast ที่ "หายได้"** (cache invalidation, real-time notification, metrics) | ไม่มี delivery guarantee — ถ้าพลาดหนึ่งข้อความแล้วธุรกิจเสียหาย แสดงว่าเลือกเครื่องมือผิด |
| **Queue สำหรับงานที่ "ต้องเกิดขึ้น"** (อีเมล, payment, media processing) | job อยู่ใน Redis จนกว่าจะสำเร็จ, รอด restart, retry ได้ |
| **แยกคิวตามประเภทงาน** (`email`, `image-processing`, `video-encoding`) | งานหนัก (video) ไม่ไปขวางงานเบา (email); ตั้ง concurrency/rate limit ต่างกันได้; monitor แยกได้ |
| **ส่ง reference ไม่ใช่ payload ก้อนใหญ่** (`videoUrl` ไม่ใช่ buffer 100MB) | job เก็บใน Redis (RAM) — payload ใหญ่กิน memory มหาศาลและ serialize ช้า |

### 2.2 Reliability

| Practice | เหตุผล |
|---|---|
| **job handler ต้อง idempotent เสมอ** | BullMQ รับประกัน **at-least-once** ไม่ใช่ exactly-once — worker อาจตายหลังทำงานเสร็จแต่ก่อน ack ทำให้ job ถูกรันซ้ำ ถ้า handler ไม่ idempotent ผู้ใช้จะได้อีเมลซ้ำ/ถูกชาร์จซ้ำ |
| **retry + exponential backoff สำหรับ external service ทุกตัว** | ความล้มเหลวชั่วคราว (network blip, rate limit, service restart) คือเรื่องปกติ ไม่ใช่ข้อยกเว้น |
| **แยก transient กับ permanent failure** | retry อีเมลไปยัง address ที่ไม่มีอยู่จริง (550) 5 ครั้ง = เสียเวลา, เสีย reputation ของ domain, และไม่มีทางสำเร็จ |
| **`removeOnFail: false`** | เก็บ job ที่ล้มเหลวไว้ debug ได้ว่า payload อะไร error อะไร attempt ที่เท่าไร |
| **มี Dead Letter Queue** | job ที่ retry จนหมดต้องไปอยู่ที่ที่มีคนเห็นและ replay ได้ ไม่ใช่หายไปเงียบ ๆ |
| **alert เมื่อ permanent failure** | ถ้าไม่มีใครดู failed queue มันก็เท่ากับข้อมูลหาย |
| **job timeout** | worker ที่ค้างอยู่กับ job เดียวตลอดกาลคือ worker ที่ตายแล้วในทางปฏิบัติ |
| **graceful shutdown** | ตอน deploy worker ต้องทำ job ปัจจุบันให้จบก่อนตาย ไม่งั้น job จะกลายเป็น stalled |

### 2.3 Throughput & Control

| Practice | เหตุผล |
|---|---|
| **concurrency ตามชนิดงาน** — CPU-bound 1–2, I/O-bound 5–20, งานเบา 20–50 | งาน CPU-bound ที่ตั้ง concurrency สูงจะแย่ง event loop กันเองแล้วช้าลงทั้งหมด; งาน I/O-bound ที่ตั้งต่ำจะปล่อยให้ CPU ว่างระหว่างรอ network |
| **rate limiter ตาม quota ของปลายทาง** (SendGrid 100/s, Mailgun 1000/hr, Stripe 100/s) | เกิน quota = โดน 429, โดนแบน, หรือติด spam filter — และ retry จะยิ่งทำให้แย่ลง |
| **priority สำหรับงานที่ผู้ใช้รออยู่** (password reset = 1, newsletter = 10) | ผู้ใช้ที่กด "ลืมรหัสผ่าน" ไม่ควรต่อคิวหลัง newsletter 50,000 ฉบับ |
| **delayed job แทน cron สำหรับงานต่อผู้ใช้** (trial หมดอายุ, reminder) | ตรงเวลาต่อรายบุคคล และยกเลิกได้ด้วย `job.remove()` |
| **`removeOnComplete` เป็นตัวเลขหรือ age** | เก็บ job สำเร็จไว้ทั้งหมด = Redis memory โตไม่หยุด (สไลด์เรียกว่า memory leak ซึ่งถูกต้อง) |
| **monitor queue length + alert เมื่อ backlog** | waiting count ที่โตเรื่อย ๆ = worker ช้ากว่า producer ต้อง scale ก่อนที่ Redis จะเต็ม |

---

## 3. What to Concern (จุดที่ต้องระวัง)

1. **"Exactly-once" ไม่มีอยู่จริง** — สไลด์เขียนทั้ง "At-least-once delivery" และ "🎯 Exactly-once: Each job processed once" ในหน้าเดียวกัน ซึ่งขัดกันเอง ความจริงคือ **at-least-once** และวิธีเดียวที่ได้ผลลัพธ์เสมือน exactly-once คือ **idempotent handler** ข้อนี้สำคัญที่สุดในบท
2. **Pub/Sub + multi-instance = งานซ้ำ** — สไลด์ยกตัวอย่างเองว่า 3 instance subscribe แล้วผู้ใช้ได้อีเมล 3 ฉบับ นี่คือเหตุผลที่ business logic ต้องอยู่ในคิว ไม่ใช่ใน pub/sub handler
3. **Job ที่ค้างใน active (stalled)** — worker crash กลางทาง BullMQ จะกู้คืนหลัง lock หมดอายุ แต่ระหว่างนั้น job ค้าง และเมื่อกู้คืนแล้ว **job จะถูกรันใหม่ทั้งหมด** (ย้ำเรื่อง idempotency)
4. **Redis เป็น single point of failure ของทั้งระบบ async** — Redis ล่ม = คิวหยุด, job ที่ยังไม่ persist หาย ต้องเปิด AOF และวางแผน HA (ต่อจากข้อกังวลใน Backend04)
5. **Retry storm** — ถ้า SMTP ล่มและมี 100,000 job ที่ retry พร้อมกันด้วย backoff เดียวกัน มันจะกลับมาถล่มพร้อมกันอีก **ต้องมี jitter** (สไลด์ไม่ได้พูดถึง — เหมือนกับกรณี avalanche ใน Backend04)
6. **Payload ที่ใหญ่ + `removeOnComplete: false`** = Redis memory ระเบิด และเมื่อชน `maxmemory` + policy ผิด (Backend04) **job ในคิวอาจถูก evict ทิ้ง**
7. **ลำดับของ job ไม่การันตีเมื่อมีหลาย worker** — FIFO เป็นเรื่องของการ "หยิบ" ไม่ใช่การ "เสร็จ"; ถ้างานต้องเรียงลำดับจริง ต้องใช้ concurrency 1 หรือ FlowProducer/job group
8. **Bull Board ไม่มี auth ในตัว** — สไลด์ mount ที่ `/admin/queues` โดยไม่มี guard ซึ่งเปิดให้ใครก็ได้ดู payload ของ job (ซึ่งอาจมีอีเมล/ชื่อผู้ใช้) และ **retry/remove job ได้** ต้องมี auth เสมอ
9. **การเปลี่ยนโครงสร้าง payload ของ job** — job เก่าที่ค้างในคิวยังใช้โครงเดิม ถ้า deploy handler ใหม่ที่คาดโครงใหม่ job เก่าจะพังทั้งหมด ต้องรองรับทั้งสองรูปแบบชั่วคราว (versioning)
10. **`@nestjs/bull` (Bull) กับ `bullmq` เป็นคนละไลบรารี** — สไลด์ผสมกัน ดู Errata ข้อ 1 นี่จะทำให้โค้ดตัวอย่าง copy ไปแล้วไม่ทำงาน

---

## 4. Performance

| จุด | ผลกระทบ | คำแนะนำ |
|---|---|---|
| **Response time** | จาก 25s เหลือ < 200ms (ตัวอย่างในสไลด์) | ย้ายทุกอย่างที่ผู้ใช้ไม่ต้องรอผลออกจาก request path |
| **Concurrency** | ตั้งผิดทำให้ทั้ง throughput และ latency แย่ | CPU-bound 1–2, I/O-bound 5–20, งานเบา 20–50 |
| **Worker scaling** | scale แยกจาก API ได้ | `pm2 start worker.js -i 4` × concurrency 5 = 20 job ขนาน |
| **Rate limiting** | ป้องกันการถูก throttle จากปลายทาง (ซึ่งจะยิ่งช้ากว่า) | ตั้งให้ต่ำกว่า quota จริงเล็กน้อย |
| **Payload size** | กระทบ memory + serialize time | ส่ง id/URL แทน binary |
| **Queue lag** | ตัวชี้วัดสุขภาพที่แท้จริง | วัดอายุของ job ที่รอนานที่สุด ไม่ใช่แค่จำนวน waiting |
| **`removeOnComplete`** | ถ้าไม่ตั้ง Redis memory โตเชิงเส้นตามจำนวน job | `{ age: 3600 }` หรือจำนวนคงที่ เช่น 100–1000 |

**Metric ที่ควรมีบน dashboard:** waiting / active / completed-per-hour / failed-per-hour / processing rate / average job duration / p95-p99 job latency / queue lag / stalled count

---

## 5. Pros & Cons

### Async Processing
| Pros | Cons |
|---|---|
| response เร็ว, UX ดี, ประหยัดแบตมือถือ | ระบบซับซ้อนขึ้น: มี worker, มี queue, มี state ให้ตามอีกที่ |
| retry อัตโนมัติ + job รอด restart | debug ยากขึ้น — error ไม่ได้อยู่ใน request/response เดิม |
| scale worker แยกจาก API ได้ | eventual consistency — ผู้ใช้อาจยังไม่เห็นผลทันที ต้องออกแบบ UI รองรับ |
| fault isolation (worker ตาย API ยังอยู่) | ต้องมี monitoring/alerting เพิ่ม ไม่งั้นงานล้มเหลวเงียบ ๆ |
| ทำ scheduled/delayed/priority ได้ | ต้องเขียน handler ให้ idempotent ทุกตัว |

### Pub/Sub vs Message Queue
| | Pub/Sub | Message Queue |
|---|---|---|
| **Model** | one-to-many (broadcast) | point-to-point (1 consumer ได้ job) |
| **Persistence** | ❌ ไม่มี | ✅ เก็บใน Redis |
| **Ack / Retry** | ❌ ไม่มีทั้งคู่ | ✅ มีทั้งคู่ |
| **Ordering** | ❌ ไม่การันตี | ✅ FIFO ในคิว (แต่ดูข้อ 7 ใน §3) |
| **Pros** | latency ต่ำสุด, decouple สมบูรณ์, ผู้รับหลายคนพร้อมกัน | เชื่อถือได้, retry, ตั้งเวลา, จัดลำดับความสำคัญ |
| **Cons** | ข้อความหาย, ทำซ้ำในทุก instance | overhead สูงกว่า, ต้องดูแล worker + queue |
| **ใช้กับ** | cache invalidation, real-time update, metrics | อีเมล, payment, media, batch, งานตั้งเวลา |

---

## 6. ✅ Should Do / ❌ Should Not Do

### ✅ ควรทำ
| ทำ | เพราะ |
|---|---|
| ทุกอย่างที่ > 1s หรือไม่ต้องการผลทันที → เข้าคิว | ปกป้อง response time และ thread |
| handler idempotent (เช็ค log/unique key ก่อนทำ) | at-least-once delivery ทำให้ job รันซ้ำได้เสมอ |
| retry + exponential backoff + **jitter** | ให้ปลายทางฟื้น และไม่ถล่มพร้อมกันซ้ำ |
| แยก transient (4xx) กับ permanent (5xx) failure | ไม่เสียเวลา retry สิ่งที่ไม่มีวันสำเร็จ |
| แยกคิวตามชนิดงาน + ตั้ง concurrency/rate limit ต่อคิว | งานหนักไม่ขวางงานเบา |
| ส่ง reference ไม่ใช่ binary | Redis เก็บใน RAM |
| `removeOnComplete` (จำนวนหรือ age) + `removeOnFail: false` | คุม memory แต่ยังเก็บหลักฐานตอนพัง |
| DLQ + alert เมื่อ permanent failure | งานที่ล้มเหลวต้องมีคนเห็น |
| ป้องกัน Bull Board ด้วย auth + จำกัด network | มันดู payload และ retry/remove job ได้ |
| graceful shutdown ของ worker | job ไม่กลายเป็น stalled ทุกครั้งที่ deploy |
| monitor queue length + queue lag + alert | รู้ว่าต้อง scale ก่อนที่ backlog จะระเบิด |

### ❌ ไม่ควรทำ
| อย่าทำ | เพราะ |
|---|---|
| ใช้ Pub/Sub สำหรับ payment / user creation / งานที่ห้ามพลาด | ไม่มี persistence, ไม่มี ack, ไม่มี retry |
| เขียน business logic ที่มี side effect ใน Pub/Sub handler บนหลาย instance | ทุก instance จะทำงานเดียวกันซ้ำ (ผู้ใช้ได้อีเมล N ฉบับ) |
| สมมติว่า job รันครั้งเดียวแน่นอน | at-least-once — ต้อง idempotent |
| ส่งไฟล์/buffer ขนาดใหญ่เป็น job payload | กิน RAM ของ Redis และ serialize ช้า |
| `removeOnComplete: false` | Redis memory โตไม่หยุด |
| retry ทุก error เหมือนกันหมด | permanent failure (550) จะ retry ไปเปล่า ๆ และกระทบ sender reputation |
| ปล่อย failed queue ไว้โดยไม่มีใครดู | เท่ากับข้อมูลหายแบบเงียบ ๆ |
| ตั้ง concurrency สูงกับงาน CPU-bound | แย่ง event loop กันจนช้าลงทั้งหมด |
| mount Bull Board ที่ path สาธารณะโดยไม่มี auth | เปิดเผย payload และให้คนนอก retry/remove job ได้ |
| เปลี่ยนโครงสร้าง payload โดยไม่รองรับ job เก่าในคิว | job ที่ค้างอยู่พังทั้งหมดหลัง deploy |

---

## 7. Recommendation (ลำดับลงมือจริง)

1. **แยก Redis ของคิวออกจาก Redis ของ cache** (คนละ instance หรืออย่างน้อยคนละ database) — เพราะ eviction policy ของ cache (`allkeys-lru`) จะกินงานในคิวได้
2. เปิด **AOF persistence** บน Redis ของคิว
3. เลือกไลบรารีให้ตรงกัน: **`@nestjs/bullmq` + `bullmq`** (แนะนำ) หรือ `@nestjs/bull` + `bull` — อย่าผสม
4. ตั้ง `defaultJobOptions`: `attempts: 3–5`, `backoff: exponential + jitter`, `removeOnComplete: { age: 3600 }`, `removeOnFail: false`
5. ย้าย "งานหลังสมัครสมาชิก" ทั้งหมด (อีเมล, avatar, thumbnail) ออกจาก request path เป็น job แรก
6. ทำ handler ให้ idempotent ด้วยตาราง `job_log` (unique บน jobId หรือ business key)
7. แยกคิวตามชนิดงาน + ตั้ง concurrency และ rate limiter ตาม quota จริงของปลายทาง
8. เพิ่ม DLQ + alert (Slack/PagerDuty) เมื่อ job ล้มเหลวถาวร
9. ติดตั้ง Bull Board **หลัง auth guard** และเปิด metric queue length/lag บน dashboard
10. ใช้ Pub/Sub เฉพาะ cache invalidation และ real-time notification เท่านั้น

---

## 8. ⚠️ Errata / จุดที่สไลด์เขียนไว้ต้องระวัง

1. **สไลด์ผสม Bull กับ BullMQ ซึ่งเป็นคนละไลบรารี** — คำสั่งติดตั้งคือ `npm install @nestjs/bull bullmq` แต่ `@nestjs/bull` เป็น adapter ของ **Bull (v3/v4)** ไม่ใช่ BullMQ และ import ในโค้ดก็เป็น `from 'bull'` ถ้าต้องการ BullMQ จริงต้องใช้ **`@nestjs/bullmq` + `bullmq`** เลือกอย่างใดอย่างหนึ่งให้สอดคล้องกันทั้งโปรเจกต์
2. **`timeout` ใน job options ถูกถอดออกจาก BullMQ** — มีใน Bull v4 แต่ BullMQ ไม่มี ถ้าใช้ BullMQ ต้องทำ timeout เองใน handler (`Promise.race`)
3. **`job.progress(50)` เป็น API ของ Bull** — BullMQ ใช้ **`job.updateProgress(50)`**
4. **`this.queue.on('completed' | 'failed' | 'active' | 'waiting')` ใช้ไม่ได้กับ BullMQ** — `Queue` ของ BullMQ ไม่ปล่อย event เหล่านี้ ต้องใช้คลาส **`QueueEvents`** แยก หรือใช้ `@OnWorkerEvent()` ใน processor ของ `@nestjs/bullmq`
5. **สไลด์อ้างทั้ง "At-least-once delivery" และ "Exactly-once: Each job processed once"** — ขัดกันเอง ความจริงคือ at-least-once ยึดตามนั้นและเขียน handler ให้ idempotent
6. **ตัวอย่าง DLQ มีบั๊กเชิงตรรกะ** — โค้ดเช็ค `job.attemptsMade >= job.opts.attempts` แล้ว push เข้า DLQ **แล้ว `throw error` ต่อ** ซึ่งจะทำให้ BullMQ นับ attempt เพิ่มและอาจ retry อีกครั้ง → เกิด DLQ entry ซ้ำ ควร return แทนการ throw เมื่อถึง attempt สุดท้าย
7. **`limiter: { max, duration }` ใน BullMQ เป็น option ของ Worker ไม่ใช่ Queue** — ในสไลด์ใส่ไว้ที่ `registerQueue` ซึ่งเป็นรูปแบบของ Bull v3/v4
8. **ตัวอย่างการทดสอบ "should not retry on permanent failure" ขัดกับโค้ด processor ที่แสดงไว้** — processor ในสไลด์ `throw error` ทุกกรณี แต่ test คาดว่า `result.success === false` โดยไม่ throw แปลว่ายังขาดโค้ดที่แยก 5xx ออกมา `return` แทน throw จริง ๆ ต้องเพิ่มเอง เช่น:
   ```ts
   if (error.responseCode >= 550 && error.responseCode < 560) {
     await this.markPermanentFailure(job); return { success: false, permanent: true };
   }
   throw error; // transient → retry
   ```
9. **ไม่มี jitter ใน backoff** — exponential อย่างเดียวยังทำให้ job ที่ล้มเหลวพร้อมกันกลับมาชนกันพร้อมกัน ควรใช้ custom backoff ที่บวก random
10. **Bull Board ถูก mount โดยไม่มี auth** — ในสไลด์คือ `app.use('/admin/queues', serverAdapter.getRouter())` เปล่า ๆ ต้องเพิ่ม middleware ตรวจสิทธิ์ก่อนขึ้น production
11. **Publisher ตัวอย่างใช้ `this.db.user.create(...)` (Prisma API)** ขณะที่ทั้งคอร์สใช้ TypeORM — เป็นความไม่สอดคล้องของสไลด์ ไม่ใช่ข้อผิดพลาดเชิงแนวคิด แต่ copy ไปใช้ตรง ๆ ไม่ได้

---

## 9. Checklist ก่อน merge

- [ ] เลือก Bull **หรือ** BullMQ อย่างใดอย่างหนึ่ง และ import ตรงกับ adapter ที่ใช้
- [ ] ทุก job handler idempotent และมีหลักฐานการทำงานใน DB (unique key)
- [ ] `attempts` + `backoff: exponential` + jitter ตั้งไว้ทุกคิว
- [ ] แยก transient/permanent failure และ permanent ไม่ retry
- [ ] `removeOnComplete` ตั้งเป็นจำนวนหรือ age; `removeOnFail: false`
- [ ] payload เป็น reference ไม่ใช่ binary
- [ ] มี DLQ + alert เมื่อ job ล้มเหลวถาวร
- [ ] concurrency ตั้งตามชนิดงาน และ rate limiter ตรงกับ quota ปลายทาง
- [ ] Bull Board อยู่หลัง auth
- [ ] worker มี graceful shutdown handler
- [ ] Redis ของคิวเปิด AOF และไม่ใช้ eviction policy ที่ลบ job ทิ้ง
- [ ] มี metric waiting/active/failed/queue-lag บน dashboard พร้อม alert
