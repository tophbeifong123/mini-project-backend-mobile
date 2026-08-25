# Backend 06 — Scaling, Load Balancing & Observability

> ที่มา: `Backend06 - Scaling, Load Balancing & Observability.pdf`
> ขอบเขต: Vertical vs Horizontal scaling · Stateless design · Nginx load balancing · PostgreSQL replication · Health checks · Structured logging · Metrics · Load testing

---

## 1. สรุปสาระสำคัญ (Core Concepts)

| หัวข้อ | ใจความ |
|---|---|
| **Vertical scaling** | เพิ่มสเปกเครื่องเดียว — ง่ายแต่มีเพดาน, แพง, single point of failure, ต้อง downtime ตอนอัปเกรด |
| **Horizontal scaling** | เพิ่มจำนวนเครื่อง — ถูกกว่า, ขยายได้เกือบไม่จำกัด, HA, deploy ได้ไม่ต้อง downtime แต่ระบบซับซ้อนขึ้น |
| **Stateless** | ทุก request ไปที่ instance ไหนก็ได้ → ห้ามเก็บ session ใน memory ต้องอยู่ใน Redis หรือใช้ JWT |
| **Load balancing algorithms** | Round Robin (ค่าเริ่มต้น, งาน stateless) · Least Connections (request ยาวไม่เท่ากัน) · IP Hash (sticky, เลี่ยงถ้าทำได้) · Weighted (เครื่องสเปกต่างกัน) |
| **Nginx health check** | ฟรี = **passive** เท่านั้น (`max_fails`, `fail_timeout`); active health check (`health_check`) ต้องใช้ Nginx Plus |
| **Replication** | Primary รับ write, Replica รับ read, ส่งต่อกันด้วย WAL stream |
| **Replication lag** | ปกติ 10–100ms, โหลดหนัก 100ms–1s → ทำให้ "อ่านสิ่งที่เพิ่งเขียน" ไม่เจอ |
| **Read-your-writes** | หลัง write ต้องอ่านจาก primary (หรือทำใน transaction เดียวกัน) |
| **Liveness vs Readiness** | Liveness fail → restart container; Readiness fail → ถอดออกจาก load balancer แต่ยังไม่ restart |
| **Observability 3 เสา** | Logs (เกิดอะไรขึ้น) · Metrics (แนวโน้ม/alert) · Traces (request ไหลผ่านอะไรบ้าง) |
| **Structured logging** | JSON + correlation id → query/filter/correlate ได้ ต่างจาก log ข้อความดิบ |
| **ผลลัพธ์ที่คาดหวัง** | สไลด์: 1 instance = 500 RPS/p95 300ms → 3 instances = 1400 RPS/p95 150ms (ไม่ใช่ 3 เท่าพอดี) |

---

## 2. Best Practices (พร้อมเหตุผล)

### 2.1 Stateless & Scaling

| Practice | เหตุผล |
|---|---|
| **ห้ามเก็บ session/cache/counter ไว้ใน memory ของ instance** | request ถัดไปอาจไปคนละ instance → ผู้ใช้หลุด login แบบสุ่ม และ restart ทีเดียวข้อมูลหายหมด |
| **ใช้ JWT หรือ Redis session** | JWT: validate ได้ทุก instance โดยไม่ต้องแตะ DB (เร็วสุด); Redis: revoke ได้ทันที — เลือกตามความต้องการเรื่องการเพิกถอน |
| **ทุก instance รันโค้ดเวอร์ชันเดียวกัน + rolling update** | ถ้าเวอร์ชันปนกัน ผู้ใช้จะเจอพฤติกรรมต่างกันแบบสุ่ม และ debug แทบไม่ได้ |
| **graceful shutdown** | ตอน rolling update instance ต้องหยุดรับ request ใหม่ → ทำ request ที่ค้างให้จบ → ปิด connection แล้วค่อยตาย ไม่งั้นผู้ใช้เจอ 502 ทุกครั้งที่ deploy |
| **คำนวณ connection pool รวม** — `instances × poolSize ≤ max_connections` | นี่คือสาเหตุอันดับหนึ่งของ "too many connections" เวลาที่ scale ออก: pool ที่เคยพอดีตอน 1 instance กลายเป็นเกินทันทีที่มี 5 |

### 2.2 Load Balancing

| Practice | เหตุผล |
|---|---|
| **Round Robin เป็นค่าเริ่มต้นสำหรับ backend ที่ stateless** | เรียบง่าย คาดเดาได้ กระจายเท่ากัน |
| **Least Connections เมื่อ request ยาวไม่เท่ากัน** (upload, long-polling, WebSocket) | Round Robin จะโยน request ใหม่เข้าเครื่องที่ยังติดงานยาวอยู่ ทำให้ latency กระจายไม่สม่ำเสมอ |
| **เลี่ยง IP Hash / sticky session** | NAT/proxy ทำให้ผู้ใช้จำนวนมากมี IP เดียวกัน → กระจายไม่เท่า; และเมื่อเครื่องล่ม session ของผู้ใช้กลุ่มนั้นหายทั้งก้อน — มันคือการยอมแพ้ต่อ stateless design |
| **ตั้ง `max_fails` + `fail_timeout`** | Nginx จะเลิกส่ง traffic ไป instance ที่ตอบไม่ได้ และกลับมาลองใหม่อัตโนมัติ |
| **ตั้ง proxy timeout ให้ชัด** (`connect/send/read`) | ไม่งั้น request ที่ค้างจะยึด worker connection ของ Nginx ไว้จนหมด |
| **forward `X-Real-IP` / `X-Forwarded-For`** | ไม่งั้นแอปจะเห็น IP ของ Nginx ทุก request → rate limiting, audit log, geo ผิดหมด |

### 2.3 Replication

| Practice | เหตุผล |
|---|---|
| **แยก read/write** — 80–90% ของ query เป็น read | primary โฟกัสที่ write อย่างเดียว → throughput รวมเพิ่มขึ้นมาก |
| **read-your-writes ต้องอ่านจาก primary** | replication lag ทำให้ผู้ใช้ที่เพิ่งสร้างโพสต์แล้วกดดูทันที เจอ 404 — เป็น bug ที่ผู้ใช้รายงานแต่ทีม reproduce ไม่ได้ (เพราะ lag ไม่คงที่) |
| **monitor replication lag + alert** | lag ที่โตขึ้นเรื่อย ๆ = replica ตามไม่ทัน = ข้อมูลที่ผู้ใช้เห็นเก่าขึ้นเรื่อย ๆ และเป็นสัญญาณว่า primary โหลดเกิน |
| **วางแผน failover และซ้อมจริง** (Patroni/repmgr) | replica ที่ promote ไม่ได้ตอนจำเป็น ก็ไม่ต่างจากไม่มี |
| **`wal_level=replica`, `max_wal_senders` = จำนวน replica + 1, replication slot** | slot ป้องกันไม่ให้ primary ลบ WAL ก่อนที่ replica จะตามทัน (แต่ดู §3 ข้อ 7) |

### 2.4 Observability

| Practice | เหตุผล |
|---|---|
| **มีทั้ง liveness และ readiness** | คนละความหมาย: app ที่ยังรันอยู่แต่ต่อ DB ไม่ได้ ควรถูกถอดจาก LB (readiness fail) แต่ **ไม่ควร restart** (liveness pass) เพราะ restart ไม่ช่วยถ้า DB ล่ม — และการ restart รัว ๆ จะยิ่งทำให้ฟื้นตัวช้า |
| **liveness ต้องเบาและไม่เช็ค dependency** | ถ้า liveness เช็ค DB ด้วย แล้ว DB ล่มชั่วคราว **container ทุกตัวจะถูก restart พร้อมกัน** = outage ที่เราสร้างเอง |
| **structured logging (JSON)** | query ได้ (`level=error AND userId=123`), aggregate ได้, correlate ได้ — log ข้อความดิบทำสามอย่างนี้ไม่ได้เลย |
| **correlation/trace id ทุก request** | ระบบมีหลาย instance + worker ถ้าไม่มี id ร่วม คุณจะไล่ไม่ได้ว่าเกิดอะไรขึ้นกับ request นั้น |
| **ห้าม log password/token/PII** | log ถูกส่งไปที่ centralized storage ที่คนเข้าถึงได้กว้างกว่า DB มาก และเก็บนาน — เป็นช่องรั่วที่พบบ่อยที่สุดช่องหนึ่ง |
| **ระดับ log ขั้นต่ำใน production คือ `info`** | debug log ปริมาณมหาศาลทำให้ disk เต็ม, cost พุ่ง, และ log ที่สำคัญจมหาย |
| **centralized logging** | log ที่กระจายอยู่ใน 5 instance = ไม่มีใครหาเจอตอน incident |
| **วัด p50/p95/p99 ไม่ใช่ average** | average ซ่อนปัญหา — p99 คือประสบการณ์ของผู้ใช้ที่โกรธที่สุด และมักเป็นกลุ่มที่มีข้อมูลเยอะที่สุด |
| **load test ก่อนขึ้น production** | ตัวเลขจริงเท่านั้นที่บอกได้ว่าต้องมีกี่ instance |

---

## 3. What to Concern (จุดที่ต้องระวัง)

1. **Docker HEALTHCHECK ไม่ได้ทำให้ Nginx หยุดส่ง traffic** — สไลด์ 44 อ้างว่า container ถูก mark unhealthy แล้ว "Nginx stops routing" ซึ่ง **ไม่จริง** Nginx ไม่รู้จัก Docker health status; มันจะหยุดส่งก็ต่อเมื่อ request จริงล้มเหลวครบ `max_fails` เท่านั้น ถ้าต้องการให้ health status มีผลจริง ต้องใช้ orchestrator (Kubernetes readinessProbe / Swarm) หรือ service mesh
2. **JWT เพิกถอนไม่ได้** — สไลด์เชียร์ JWT ว่า "ไม่ต้อง query DB เลย" ซึ่งเป็นข้อดี แต่ด้านกลับคือ **logout / ban user / เปลี่ยนสิทธิ์ ไม่มีผลจนกว่า token จะหมดอายุ** ต้องมี TTL สั้น + refresh token หรือ blacklist ใน Redis (ซึ่งก็แลกข้อดีเรื่อง "ไม่ต้องแตะ state" ไปครึ่งหนึ่ง)
3. **Replication lag ทำให้เกิดบั๊กที่ reproduce ยากที่สุด** — ผ่าน dev/staging (lag ต่ำ) แต่พังใน production ตอน peak ต้องคิดตั้งแต่ออกแบบว่า path ไหนต้องอ่านจาก primary
4. **Replica ไม่ช่วยเรื่อง write เลย** — ถ้า bottleneck คือ write, replication ไม่แก้อะไร (ต้อง sharding / partitioning / queue)
5. **การเพิ่ม instance ย้ายคอขวดไปที่ DB** — 3 instance × pool 20 = 60 connection ถ้า `max_connections = 50` ระบบจะแย่ลงกว่าเดิม พิจารณา **PgBouncer** เมื่อ instance เยอะ
6. **Nginx เองเป็น single point of failure** — สไลด์วาด Nginx ตัวเดียวหน้าทุกอย่าง production จริงต้องมี 2 ตัว + VIP/DNS failover หรือใช้ managed LB
7. **Replication slot ที่ replica ตายค้างไว้ = primary disk เต็ม** — slot บังคับให้ primary เก็บ WAL ไว้รอ replica ตลอดกาล ถ้า replica หายไปนานโดยไม่ลบ slot **primary จะ disk full แล้วหยุดรับ write ทั้งระบบ** ต้อง monitor `pg_replication_slots`
8. **Log อาจกลายเป็นค่าใช้จ่ายอันดับต้น ๆ** — JSON log ที่ verbose × RPS สูง × retention ยาว = บิลที่แพงกว่า compute เอง ต้องมี sampling สำหรับ log ปริมาณมาก
9. **Sticky session ทำให้ scale-in อันตราย** — ลด instance ทีไร ผู้ใช้กลุ่มหนึ่งหลุดทุกครั้ง
10. **Health endpoint ที่หนักเกินไป** — ถ้า `/health` ยิง query DB ทุก 5 วินาที × 3 instance × หลาย probe = โหลดที่ไม่จำเป็น และตอน DB ช้า health check จะ timeout พร้อมกันหมดจน LB ถอด instance ทั้งหมดทิ้ง (cascading failure)

---

## 4. Performance

| ตัวชี้วัด | เป้าหมาย (จากสไลด์) | หมายเหตุ |
|---|---|---|
| **Throughput** | 1000+ RPS สำหรับ web API ทั่วไป | 1 instance 500 RPS → 3 instances 1400 RPS (~2.8x ไม่ใช่ 3x เพราะมี LB overhead + คอขวดร่วมที่ DB) |
| **Latency p50** | < 100ms | ครึ่งหนึ่งของ request |
| **Latency p95** | < 200ms | ตัวเลขที่ควรใช้ตั้ง SLO |
| **Latency p99** | < 500ms | มักถูกกำหนดโดย GC pause, lock contention, cache miss |
| **Error rate** | < 0.1% | แยก 5xx (ปัญหาเรา) กับ 4xx (ปัญหา client) |
| **Replication lag** | < 1s | alert เมื่อเกิน |
| **Connection pool** | `instances × poolSize ≤ 80% ของ max_connections` | เหลือที่ให้ migration job, admin tool, monitoring |
| **CPU ต่อ instance** | ~45% หลัง scale (จากสไลด์) | เผื่อหัวไว้รองรับ spike และการที่ instance หนึ่งล่ม |

**เครื่องมือ:** k6 (load test แบบ ramp-up → peak → ramp-down), `pg_stat_statements` (query ช้า), Prometheus + Grafana (metric), ELK/CloudWatch (log)

**ลำดับการหาคอขวดที่ถูกต้อง:** วัดก่อน → optimize query + index (Backend03) → cache (Backend04) → ย้ายงานหนักเข้าคิว (Backend05) → **แล้วค่อย scale ออก** การเพิ่ม instance ให้กับแอปที่มี N+1 query คือการจ่ายเงินเพื่อยิง query แย่ ๆ ให้เร็วขึ้น

---

## 5. Pros & Cons

### Horizontal vs Vertical Scaling
| | Horizontal | Vertical |
|---|---|---|
| **Pros** | ขยายได้เกือบไม่จำกัด, HA/redundancy, zero-downtime deploy, คุ้มค่ากว่า | ง่ายมาก ไม่ต้องแก้สถาปัตยกรรม, ไม่มีปัญหา distributed system |
| **Cons** | ต้อง stateless, ต้องมี LB, log กระจาย, connection pool คูณจำนวน instance, ระบบซับซ้อน | มีเพดานทางกายภาพ, แพงแบบไม่เชิงเส้น, single point of failure, ต้อง downtime ตอนอัปเกรด |

### Database Replication
| Pros | Cons |
|---|---|
| เพิ่ม read capacity หลายเท่า | ไม่ช่วยเรื่อง write เลย |
| replica เป็น backup แบบ real-time | replication lag → eventual consistency ในแอป |
| promote เป็น primary ได้เมื่อ primary ล่ม | ซับซ้อนขึ้น: ต้อง monitor lag, จัดการ slot, ซ้อม failover |
| วาง replica ใกล้ผู้ใช้ในภูมิภาคอื่นได้ | ค่าใช้จ่ายเพิ่มตามจำนวน replica |

### Observability
| Pros | Cons |
|---|---|
| debug production ได้จริง, รู้ปัญหาก่อนผู้ใช้แจ้ง | ค่าเก็บ log/metric อาจแพงกว่าที่คิดมาก |
| ตั้ง alert เชิงรุกได้, พิสูจน์ SLA ได้ | ต้องมีวินัยเรื่อง log level และ PII |
| structured log ทำให้ query/aggregate ได้ | ใส่ instrument ทุกที่มี overhead (แม้เล็กน้อย) |

---

## 6. ✅ Should Do / ❌ Should Not Do

### ✅ ควรทำ
| ทำ | เพราะ |
|---|---|
| ออกแบบ stateless ตั้งแต่ต้น (Redis session หรือ JWT) | เป็นเงื่อนไขบังคับของ horizontal scaling ทั้งหมด |
| Round Robin เป็นค่าเริ่มต้น, Least Connections เมื่อ request ยาวไม่เท่ากัน | ตรงกับลักษณะ workload |
| ตั้ง `max_fails`/`fail_timeout` + proxy timeout | LB ถอด instance ที่ตายออกและไม่ปล่อยให้ connection ค้าง |
| forward `X-Real-IP` / `X-Forwarded-For` | rate limit / audit / geo ทำงานถูก |
| แยก liveness (เบา ไม่เช็ค dependency) กับ readiness (เช็ค DB/Redis) | restart เฉพาะเมื่อ restart ช่วยจริง |
| graceful shutdown ทั้ง API และ worker | deploy ได้โดยไม่มี 502 และไม่มี job ค้าง |
| structured JSON log + correlation id ทุก request | ไล่ปัญหาข้าม instance ได้ |
| redact PII/secret ก่อน log | log เก็บนานและเข้าถึงได้กว้าง |
| แยก read → replica, read-your-writes → primary | ได้ throughput โดยไม่แลกความถูกต้องที่ผู้ใช้สังเกตเห็น |
| monitor replication lag + replication slot | กัน data staleness และกัน primary disk full |
| คำนวณ `instances × poolSize` ก่อน scale ทุกครั้ง | กัน "too many connections" ที่ล้มทั้งระบบ |
| load test ด้วย k6 ก่อนขึ้น production | รู้ capacity จริง ไม่ใช่เดา |
| Nginx อย่างน้อย 2 ตัว หรือใช้ managed LB | LB เดี่ยวคือ SPOF |

### ❌ ไม่ควรทำ
| อย่าทำ | เพราะ |
|---|---|
| เก็บ session / in-memory cache / counter ใน process | ผู้ใช้หลุดแบบสุ่ม และหายทุกครั้งที่ restart |
| ใช้ sticky session / IP Hash เพื่อเลี่ยงการทำ stateless | กระจายไม่เท่า, เครื่องล่ม = session หาย, scale-in อันตราย |
| ให้ liveness probe เช็ค DB | DB สะดุดครั้งเดียว = container ทุกตัว restart พร้อมกัน |
| อ่านข้อมูลที่เพิ่งเขียนจาก replica | replication lag → ผู้ใช้เห็น 404 |
| เขียนลง replica | replica เป็น read-only, error แน่นอน |
| log password / token / เลขบัตร / PII | log รั่วง่ายกว่า DB มาก |
| ตั้ง log level เป็น debug ใน production | disk เต็ม, cost พุ่ง, สัญญาณสำคัญจมหาย |
| ดูแค่ average latency | ซ่อนปัญหา p99 ที่ผู้ใช้เจอจริง |
| scale out โดยไม่แก้ query/cache ก่อน | จ่ายเงินเพื่อขยายปัญหาเดิม |
| เพิ่ม instance โดยไม่ปรับ pool size | ทำให้ DB ปฏิเสธ connection ทั้งระบบ |
| ปล่อย replication slot ของ replica ที่ตายทิ้งไว้ | primary disk เต็มจนหยุดรับ write |
| พึ่ง Docker HEALTHCHECK ว่า Nginx จะเข้าใจ | Nginx ไม่รู้จัก Docker health status |

---

## 7. Recommendation (ลำดับลงมือจริง)

1. **ทำ stateless ให้เสร็จก่อน** — ย้าย session ไป Redis หรือเปลี่ยนเป็น JWT + refresh token; ไล่หา in-memory state ที่หลงเหลือให้หมด
2. เพิ่ม **graceful shutdown** (`app.enableShutdownHooks()` + ปิด server/worker อย่างเป็นระเบียบ)
3. เพิ่ม **`/health/live`** (เบามาก) และ **`/health/ready`** (เช็ค DB + Redis) แยกกัน — `@nestjs/terminus`
4. เพิ่ม **structured logging + correlation id interceptor** และ redact field ที่อ่อนไหว
5. ยก stack ขึ้นเป็น Nginx + 3 instance ด้วย Compose, ทดสอบการกระจายด้วย endpoint ที่คืน `INSTANCE_ID`
6. **คำนวณ connection pool ใหม่** ให้ `instances × poolSize ≤ 80% max_connections`
7. **load test ด้วย k6** เก็บ baseline (RPS, p50/p95/p99, error rate) เทียบก่อน/หลัง
8. ตั้ง **centralized logging + metric dashboard** (request rate, error rate, latency percentiles, queue depth, cache hit ratio, replication lag)
9. ตั้ง **alert** ที่มีความหมาย: error rate > 1%, p95 > SLO, replication lag > 1s, queue backlog, connection pool ใกล้เต็ม
10. เพิ่ม **read replica** เมื่อพิสูจน์แล้วว่าคอขวดคือ read — พร้อมกำหนดชัดว่า path ไหนต้องอ่านจาก primary
11. ซ้อม **failover** และ **rollback** อย่างน้อยหนึ่งครั้งก่อนขึ้นจริง

---

## 8. ⚠️ Errata / จุดที่สไลด์เขียนไว้ต้องระวัง

1. **สไลด์ 44 ("Testing Health Checks") ผิดในเชิงกลไก** — ลำดับที่แสดงไว้คือ "Docker marks unhealthy → Nginx stops routing" **Nginx อ่านสถานะ health ของ Docker ไม่ได้** สิ่งที่เกิดขึ้นจริงคือ Nginx จะเลิกส่ง traffic ก็ต่อเมื่อ request จริงล้มเหลวครบ `max_fails` ภายใน `fail_timeout` เท่านั้น ถ้าต้องการพฤติกรรมตามที่สไลด์อธิบาย ต้องใช้ Kubernetes readinessProbe, Docker Swarm หรือ Nginx Plus active health check
2. **สไลด์บอกว่า `HEALTHCHECK` ใน Dockerfile ทำให้ instance ถูกถอดจาก pool** — ตามข้อ 1 มันแค่เปลี่ยนสถานะที่แสดงใน `docker ps` เท่านั้น (ยกเว้นใช้ Swarm/orchestrator)
3. **ตัวอย่าง `/health` เดียวที่เช็คทั้ง DB และ memory ถูกใช้เป็นทั้ง liveness และ readiness** — ขัดกับตารางเปรียบเทียบในสไลด์เอง ถ้า Kubernetes ใช้ endpoint นี้เป็น livenessProbe **DB ล่มจะทำให้ pod ทุกตัวถูก restart วนไป** ต้องแยกเป็นสอง endpoint
4. **"TypeORM detects connection failures, skips failed replica, master serves reads if all replicas down"** — เป็นการอธิบายที่มองโลกในแง่ดีเกินจริง TypeORM ไม่มี active health check ต่อ replica; มันเลือก slave แบบ round-robin และการ fail over ขึ้นกับพฤติกรรมของ driver ณ ตอนเกิด error **อย่าออกแบบระบบโดยพึ่งพฤติกรรมนี้** ให้ตั้ง connection timeout + retry ที่ระดับแอป และ monitor เอง
5. **`replication: { master, slaves }` เป็น API ที่ถูกของ TypeORM** แต่ควรรู้ว่าค่านี้ **ไม่มี health check ในตัว** และ query ที่อยู่ใน transaction จะไปที่ master เสมอ (ซึ่งเป็นพฤติกรรมที่ต้องการ)
6. **`poolSize: 10` ที่วางไว้ระดับ root ในตัวอย่าง replication** — เมื่อใช้ replication แล้ว pool จะถูกสร้าง **ต่อ master และต่อ slave แต่ละตัว** ดังนั้นสูตรจริงคือ `instances × (1 + จำนวน slaves) × poolSize` ไม่ใช่ `instances × poolSize` ตามที่สไลด์คำนวณไว้ในหน้า 10 — จุดนี้ทำให้ประเมิน connection ต่ำกว่าความจริงหลายเท่า
7. **สไลด์ไม่พูดถึงความเสี่ยงของ replication slot** — slot ที่ค้างจาก replica ที่ตายจะทำให้ primary เก็บ WAL ไม่หยุดจน disk เต็มและหยุดรับ write ต้อง monitor และมีนโยบายลบ slot ที่ไม่ใช้ (หรือใช้ `max_slot_wal_keep_size`)
8. **สไลด์วาด Nginx ตัวเดียวเป็นทางเข้าเดียวของระบบ** โดยไม่ระบุว่านั่นคือ single point of failure ซึ่งขัดกับเป้าหมาย "99.9%+ uptime, no single point of failure" ที่ระบุไว้ในหน้า 5
9. **JWT ถูกนำเสนอโดยไม่พูดถึงข้อจำกัดเรื่องการเพิกถอน** — "Zero database queries for auth" เป็นข้อดีที่มาพร้อมข้อเสียที่ต้องออกแบบรับมือ (short TTL + refresh token หรือ Redis blacklist)
10. **`pg_basebackup ... -U postgres` ในตัวอย่าง replica** ไม่ตรงกับ init script ที่สร้าง role `replicator` ไว้สำหรับ replication โดยเฉพาะ — ควรใช้ `-U replicator` ให้สอดคล้องกัน
11. **ตัวเลข "3 instances = 2.8x RPS" เป็นตัวอย่างประกอบ ไม่ใช่ค่าที่รับประกัน** — ถ้าคอขวดอยู่ที่ DB การเพิ่ม instance อาจได้ผลตอบแทนเกือบเป็นศูนย์ ต้องวัดของตัวเองเสมอ

---

## 9. Checklist ก่อนขึ้น Production

**Application**
- [ ] ไม่มี in-memory session / state ใด ๆ ที่ผูกกับผู้ใช้
- [ ] session อยู่ใน Redis หรือใช้ JWT (พร้อมกลยุทธ์เพิกถอน)
- [ ] connection pool คำนวณจาก `instances × (1 + replicas) × poolSize ≤ 80% max_connections`
- [ ] config ทั้งหมดมาจาก env และ validate ตอน boot
- [ ] graceful shutdown ทั้ง HTTP server และ queue worker

**Infrastructure**
- [ ] Nginx (หรือ managed LB) พร้อม `max_fails`/`fail_timeout`/proxy timeout
- [ ] มีมากกว่า 1 backend instance และ LB ไม่ใช่ SPOF
- [ ] read replica ตั้งค่าแล้ว + monitor lag + monitor replication slot
- [ ] Redis สำหรับ shared state (และแยก instance/DB จากคิว)

**Observability**
- [ ] `/health/live` (เบา) และ `/health/ready` (เช็ค dependency) แยกกัน
- [ ] structured JSON log + correlation id + redact PII
- [ ] centralized logging ใช้งานได้จริง (ค้นข้าม instance ได้)
- [ ] metric: request rate, error rate, p50/p95/p99, queue depth, cache hit ratio, replication lag
- [ ] alert ผูกกับ SLO ไม่ใช่แค่ threshold ลอย ๆ

**Operations**
- [ ] CI/CD + rolling update strategy
- [ ] ขั้นตอน backup/restore ทดสอบแล้วจริง
- [ ] ซ้อม failover ของ DB แล้ว
- [ ] load test (k6) มี baseline และผ่านเกณฑ์ p95/error rate
- [ ] มี incident response plan และรู้ว่าใครถูกเรียกตอนตี 3
