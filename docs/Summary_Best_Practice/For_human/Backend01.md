# Backend 01 — Modern Backend Architecture & Containerization

> ที่มา: `Backend01 - Modern Backend Architecture & Containerization.pdf`
> ขอบเขต: Monolith vs Microservices · DevOps/CI-CD · Infrastructure as Code · Docker · Dockerizing Node.js

---

## 1. สรุปสาระสำคัญ (Core Concepts)

| หัวข้อ | ใจความ |
|---|---|
| **Monolithic** | codebase เดียว deploy เป็นก้อนเดียว, shared DB, in-process call, ACID ได้เต็ม, พังทั้งระบบพร้อมกัน |
| **Microservices** | หลาย service deploy แยกกัน, database-per-service, network call, eventual consistency, fault isolation |
| **DevOps** | ลบกำแพง Dev↔Ops ด้วย pipeline อัตโนมัติ: Code → Build → Test → Deploy → Monitor |
| **IaC** | โครงสร้างพื้นฐานเป็นไฟล์ที่ version control ได้ (เช่น docker-compose) แทนการ SSH เข้าไปตั้งค่ามือ |
| **Container** | process ที่ถูก isolate ด้วย namespace + cgroups แต่ **แชร์ kernel ของ host** → เบา (MB) และ start เร็ว ต่างจาก VM ที่มี Guest OS เต็ม (GB) |
| **Image / Layer** | ทุกคำสั่งใน Dockerfile = 1 layer, layer ถูก cache และ share ข้าม image ได้ |
| **Multi-stage build** | stage `builder` สร้าง artifact → stage `production` copy เฉพาะ artifact → image เล็กลง ~1.2GB → ~150MB |

**หลักตัดสินใจสถาปัตยกรรม (จากสไลด์):** เริ่มที่ monolith เสมอ แล้วค่อยแตกเป็น service เมื่อทีม > 15–20 คน หรือมี domain boundary ชัด — ระหว่างทางใช้ **modular monolith** เป็นทางสายกลาง
เคสจริง: Instagram เริ่ม Django monolith โตถึง 30M users แล้วค่อยแยก Feed/Stories/Messaging ออกมา · Uber ใช้ microservices ตั้งแต่วันแรกจนมี ~2,200 services และต้องมี platform team ดูแลโดยเฉพาะ

---

## 2. Best Practices (พร้อมเหตุผล)

### 2.1 สถาปัตยกรรม

| Practice | เหตุผล |
|---|---|
| **เริ่มด้วย well-structured monolith** | ต้นทุน operation ต่ำสุด และคุณยัง "ไม่รู้" domain boundary ที่แท้จริงในวันแรก การแตก service ผิดที่ แพงกว่าการรวมกลับมาก |
| **แยกเป็นโมดูลตาม domain ตั้งแต่วันแรก** (modular monolith) | เมื่อถึงวันที่ต้องแตกจริง คุณแค่ "ยก" โมดูลออกไป ไม่ต้อง rewrite เพราะ boundary ถูกวางไว้แล้ว |
| **แตก service ด้วยเหตุผลที่วัดได้** เท่านั้น (ทีมโตจนชนกัน, bottleneck เฉพาะจุด, SLA ต่างกัน) | microservices ไม่ได้ให้ performance ฟรี ๆ — มันแลก in-process call (นาโนวินาที) เป็น network call (มิลลิวินาที) + ต้องจัดการ partial failure |
| **ยอมรับ eventual consistency ก่อนแตก service** | เมื่อ database-per-service แล้ว transaction ข้าม service ทำไม่ได้ ต้องใช้ Saga/compensating transaction ถ้าธุรกิจรับไม่ได้ อย่าแตก |

### 2.2 Docker Image

| Practice | เหตุผล |
|---|---|
| **Multi-stage build** | build tool / dev dependencies / source map ไม่หลุดไป production → image เล็ก, attack surface น้อย, pull เร็ว |
| **Alpine base (`node:20-alpine`)** | เล็กกว่า `node:20` มาก → deploy/scale เร็วขึ้น และ CVE น้อยกว่าเพราะแพ็กเกจน้อยกว่า |
| **`COPY package*.json` ก่อน `COPY . .`** | layer cache: แก้โค้ดแล้ว layer `npm ci` ยัง HIT → build 30 วินาที แทน 5 นาที |
| **`.dockerignore`** | กัน `node_modules`, `.git`, `.env` ไม่ให้เข้า build context → build เร็ว, image เล็ก, **และไม่ทำ secret หลุดเข้า image layer** |
| **`USER node` (non-root)** | ถ้ามีช่องโหว่ RCE ผู้โจมตีได้สิทธิ์ user ธรรมดา ไม่ใช่ root ที่จะไปทะลุ container escape ได้ง่ายกว่า |
| **pin tag ให้ชัด ไม่ใช้ `latest`** | `latest` เปลี่ยนใต้เท้าเราได้ตลอด → build ที่เคยผ่าน กลับพังโดยไม่มีใครแก้อะไร (ไม่ reproducible) |
| **tag image ด้วย commit SHA** | rollback ได้แม่นยำ และรู้ว่า image ที่รันอยู่ตรงกับโค้ดบรรทัดไหน |
| **ใส่ `HEALTHCHECK`** | orchestrator/LB รู้ว่า container "รันอยู่" ≠ "พร้อมรับ traffic" (ดูรายละเอียดใน Backend06) |
| **สแกน image หา CVE** | base image เก่าคือหนี้ด้านความปลอดภัยที่สะสมเงียบ ๆ |

### 2.3 Configuration & Secrets

| Practice | เหตุผล |
|---|---|
| **config มาจาก environment variable** | image เดียวกันรันได้ทุก environment → สิ่งที่ทดสอบบน staging คือ binary เดียวกับที่ขึ้น production |
| **`.env` เข้า `.gitignore` เสมอ** | secret ที่ commit ไปแล้วอยู่ใน git history ตลอดกาล ต้อง rotate ไม่ใช่แค่ลบไฟล์ |
| **ส่ง secret ตอน runtime ไม่ใช่ตอน build** | อะไรที่อยู่ใน image layer ใครที่ pull image ได้ ก็ `docker history` อ่านได้หมด |
| **แยก secret dev / prod คนละชุด** | ถ้า dev secret หลุด (ซึ่งหลุดง่ายกว่ามาก) production ยังปลอดภัย |
| **prod ดึงจาก secrets manager** | ได้ audit log ว่าใครอ่านตอนไหน + rotate ได้โดยไม่ต้อง redeploy |
| **validate config ตอน startup** | fail fast — พังตอน boot ดีกว่าพังตอนลูกค้าใช้งานเพราะ env var สะกดผิด |

---

## 3. What to Concern (จุดที่ต้องระวัง)

1. **Microservices tax** — ค่าใช้จ่ายที่มองไม่เห็น: service discovery, distributed tracing, contract testing, versioning ของ API, network partition, retry storm ทั้งหมดนี้ต้องมีคนดูแล Uber ต้องมี **platform team** ไม่ใช่เรื่องบังเอิญ
2. **Container ≠ VM ในแง่ security** — แชร์ kernel เดียวกับ host ช่องโหว่ระดับ kernel = ทะลุถึง host ได้ ถ้าต้องการ isolation ระดับ multi-tenant จริง ๆ ต้องใช้ gVisor/Kata/Firecracker หรือแยก node
3. **Layer caching เป็นดาบสองคม** — ถ้าไม่ pin base image `RUN npm ci` อาจ HIT cache เก่าและติดตั้ง dependency ที่มี CVE ค้างอยู่ ใช้ `--no-cache` เป็นระยะใน CI
4. **`docker run --env-file`** ไม่ใช่ secret management จริง — ค่าที่ส่งเข้าไปยัง `docker inspect` ออกมาได้ และติดอยู่ใน shell history ใช้ได้ที่ dev เท่านั้น
5. **Resource limit** — ถ้าไม่ใส่ `--memory` / `--cpus` container เดียวที่ memory leak จะดูดทรัพยากรจนเพื่อนบ้านตายหมด (noisy neighbor)
6. **`depends_on` ใน Compose รอแค่ container start ไม่ได้รอ service ready** — app จะพยายามต่อ DB ที่ยังไม่พร้อมแล้ว crash ต้องมี retry logic ในแอป หรือใช้ `condition: service_healthy`
7. **Volume ของ database ใน dev** — `docker-compose down -v` ลบข้อมูลทั้งหมด ระวังอย่าติดนิสัยพิมพ์ `-v` ทุกครั้ง

---

## 4. Performance

| จุด | ผลกระทบ | วิธีทำ |
|---|---|---|
| **Image size** | ยิ่งเล็ก → pull เร็ว, cold start เร็ว, scale-out เร็ว, ค่า egress ถูกลง | multi-stage + alpine + prod deps only → ~1.2GB ลดเหลือ ~150MB |
| **Build time** | กระทบ feedback loop ของทีมทั้งวัน | เรียง layer จาก "เปลี่ยนน้อย" → "เปลี่ยนบ่อย", ใช้ `.dockerignore`, ใช้ registry cache ใน CI |
| **Startup time** | กระทบเวลา rolling update และ auto-scale | อย่าทำงานหนักใน bootstrap, ใช้ `--start-period` ใน healthcheck ให้ app มีเวลา warm |
| **cgroups limit** | ป้องกัน runaway process, ทำให้ performance คาดเดาได้ | `--memory`, `--cpus`, `--pids-limit` |
| **Network** | container ใน network เดียวกันคุยกันด้วยชื่อ ไม่ต้องออก host | สร้าง custom network → `postgresql://db:5432` |

**ข้อควรรู้เพิ่ม (นอกสไลด์):** Node.js รุ่นเก่ากว่า 18 อ่าน cgroup limit ไม่เห็น ทำให้ V8 ตั้ง heap ตาม RAM ของ host แล้วโดน OOM-kill — ถ้าเจออาการนี้ให้ตั้ง `NODE_OPTIONS=--max-old-space-size` ให้สอดคล้องกับ `--memory`

---

## 5. Pros & Cons

### Monolithic
| Pros | Cons |
|---|---|
| deploy หน่วยเดียว ง่าย | scale ได้ทั้งก้อนเท่านั้น แม้ bottleneck อยู่จุดเดียว |
| ACID transaction ข้ามโมดูลได้ฟรี | โค้ดพันกันง่ายถ้าไม่มีวินัยเรื่อง module boundary |
| debug/trace ง่าย stack trace เดียวจบ | ทีมใหญ่ชนกันที่ codebase เดียว |
| ต้นทุน infra + คนดูแลต่ำสุด | bug จุดเดียวล้มทั้งระบบ |

### Microservices
| Pros | Cons |
|---|---|
| scale เฉพาะ service ที่ร้อน | ops overhead สูงมาก ต้องมี platform/observability |
| fault isolation | eventual consistency + distributed transaction |
| ทีมเป็นเจ้าของ service ตัวเอง | debug ข้าม service ต้องมี distributed tracing |
| เลือก tech stack ต่างกันได้ | contract testing + API versioning เป็นภาระถาวร |

### Docker
| Pros | Cons |
|---|---|
| environment เหมือนกันทุกที่ (กำจัด "works on my machine") | isolation อ่อนกว่า VM (แชร์ kernel) |
| เบา start เร็ว density สูง | ต้องเรียนรู้ layer/caching/networking/volume เพิ่ม |
| ทำ IaC + CI/CD ได้เต็มรูปแบบ | stateful workload (DB) ต้องจัดการ volume ให้ดี ไม่งั้นข้อมูลหาย |

---

## 6. ✅ Should Do / ❌ Should Not Do

### ✅ ควรทำ
| ทำ | เพราะ |
|---|---|
| เริ่ม monolith ที่แบ่งโมดูลชัด | ถูกที่สุด และเปิดทางแตกทีหลังได้ |
| multi-stage + alpine + non-root | เล็ก เร็ว ปลอดภัย ทั้งสามอย่างพร้อมกัน |
| `.dockerignore` ตั้งแต่ไฟล์แรก | ป้องกัน `.env` หลุดเข้า image ซึ่งเป็น incident ที่แก้ยาก |
| pin version tag + tag ด้วย SHA | reproducible build และ rollback ได้ |
| ใส่ resource limit ทุก container | กัน noisy neighbor และควบคุมต้นทุน |
| `HEALTHCHECK` + `/health` endpoint ที่เช็ค dependency จริง | LB/orchestrator ตัดสินใจถูก |
| Docker Compose สำหรับ local dev | คนใหม่เข้าทีมรันทั้ง stack ได้ด้วยคำสั่งเดียว |
| validate env var ตอน boot | fail fast ก่อนถึงมือผู้ใช้ |

### ❌ ไม่ควรทำ
| อย่าทำ | เพราะ |
|---|---|
| แตก microservices ตั้งแต่ project แรก | จ่าย ops tax เต็มจำนวนก่อนจะได้ประโยชน์อะไรเลย |
| `FROM node:20` + `COPY . .` + `npm install` | image ~1.2GB, ไม่มี cache, รันเป็น root, มี dev deps ครบ |
| hardcode secret ใน Dockerfile / บิลด์ secret เข้า image | อยู่ใน layer ถาวร ใครอ่าน image ได้ก็อ่าน secret ได้ |
| commit `.env` | secret อยู่ใน git history ตลอดไป ต้อง rotate อย่างเดียว |
| ใช้ tag `latest` | build ไม่ reproducible, rollback ไม่ได้ |
| รัน container เป็น root | ยกระดับความเสียหายของช่องโหว่ทุกตัว |
| ใช้ secret ชุดเดียวกัน dev/prod | dev หลุด = prod หลุด |
| พึ่ง `depends_on` เฉย ๆ ว่า DB พร้อมแล้ว | มันรอแค่ start ไม่ได้รอ ready |

---

## 7. Recommendation (ลำดับลงมือจริง)

1. **วันแรก** — monolith + โครงโฟลเดอร์แยกตาม domain, `.dockerignore`, `.env.example` (ไม่ใช่ `.env`)
2. **สัปดาห์แรก** — multi-stage Dockerfile (base → builder → production), non-root, healthcheck, Compose ครบ stack (api + postgres + redis)
3. **ก่อนขึ้น staging** — CI pipeline: build → unit test → integration test → build image tag ด้วย SHA → push registry → deploy staging → E2E
4. **ก่อนขึ้น production** — secrets manager, resource limits, image scanning ใน pipeline, approval gate
5. **หลัง production** — วัดจริงก่อน (ดู Backend06) แล้วค่อยตัดสินว่าจะแตก service ไหนออก โดยเลือกจาก bottleneck ที่วัดได้ ไม่ใช่จากความรู้สึก

---

## 8. ⚠️ Errata / จุดที่สไลด์เขียนไว้ต้องระวัง

> ตรวจสอบโค้ดในสไลด์แล้วพบจุดที่ **copy ไปใช้ตรง ๆ ไม่ได้** — แก้ตามนี้

1. **สไลด์ 20 "✅ Optimized Approach" ใช้ไม่ได้จริง**
   stage `builder` รัน `npm ci --only=production` แล้ว `COPY . .` แต่ **ไม่มี `RUN npm run build`** จากนั้น stage สุดท้าย `COPY --from=builder /app .` ซึ่งลาก source + node_modules มาทั้งหมด → ไม่ได้ประโยชน์จาก multi-stage เลย
   ให้ยึด **สไลด์ 21** ที่ถูกต้อง (builder รัน `npm ci` เต็ม + `npm run build`, production copy เฉพาะ `dist`)
2. **สไลด์ 29 (multi-target Dockerfile) อ้าง `COPY --from=builder` แต่ไม่มี stage ชื่อ `builder`** — build จะ error ต้องเพิ่ม stage `builder` เข้าไปเอง
3. **`npm ci --only=production` เป็น flag ที่ deprecated ตั้งแต่ npm 7** — ใช้ `npm ci --omit=dev` แทน
4. **`version: '3.8'` ใน docker-compose ไม่จำเป็นแล้ว** — Compose v2 ขึ้นไป ไม่สนใจ field นี้และจะเตือน obsolete
5. **`docker run --env-file .env.production`** ที่สไลด์ 24 แนะนำ ขัดกับหลัก "ใช้ secrets manager" ในสไลด์ 25 — ใช้ได้เฉพาะ dev/staging; production ควรฉีด secret ผ่าน orchestrator secret หรือดึงจาก secrets manager ตอน runtime
6. **HEALTHCHECK ใน Docker ไม่ได้ทำให้ Nginx หยุดส่ง traffic โดยอัตโนมัติ** (จุดนี้สไลด์ Backend06 อ้างไว้ผิด) — ดูรายละเอียดในไฟล์ `Backend06.md` หัวข้อ Errata

---

## 9. Checklist ก่อน merge

- [ ] มี `.dockerignore` และครอบคลุม `node_modules`, `.git`, `.env*`, `dist`, `coverage`
- [ ] Dockerfile เป็น multi-stage และ stage สุดท้ายมีแค่ runtime + `dist` + prod deps
- [ ] `USER node` ก่อน `CMD`
- [ ] base image pin เป็น tag ที่ระบุเวอร์ชัน (ไม่ใช่ `latest`)
- [ ] ไม่มี secret ใด ๆ ใน Dockerfile / ไม่มี `.env` ใน git
- [ ] มี `HEALTHCHECK` และ `/health` endpoint ที่เช็ค DB/Redis จริง
- [ ] มี resource limit (`--memory`, `--cpus`)
- [ ] `docker-compose up` แล้วระบบขึ้นครบด้วยคำสั่งเดียว
- [ ] แอป validate env var ตอน boot และ crash ทันทีถ้าขาด
