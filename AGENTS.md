# 🤖 AGENTS.md — แนวปฏิบัติสำหรับ AI Agent และผู้พัฒนา

> **โปรเจกต์**: Backend Assignment 06 (NestJS + TypeORM Replication + PostgreSQL Primary-Replica + Redis + Nginx Load Balancer + Observability)  
> **ตัวจัดการแพ็กเกจ (Package Manager)**: `pnpm` (บังคับใช้เท่านั้น ห้ามใช้ npm หรือ yarn)  
> **เวอร์ชัน Node.js**: `>= 20.x` (แนะนำ: `v22.x`)

---

## 1. 🛠️ เทคโนโลยีและสภาพแวดล้อมที่ใช้ (Tech Stack)

- **Runtime & Package Manager**: Node.js `>= 20.x`, `pnpm ^9.x`
- **Framework**: NestJS `^11.0.1` (Express platform)
- **Load Balancer**: Nginx `alpine` (Reverse Proxy, Round Robin / Least Connections)
- **Database (Persistent & Replication)**: PostgreSQL 16 (Primary on port 5432, Replica on port 5433) ผ่าน TypeORM `^1.1.0` (Replication Read-Write Split)
- **Cache & Concurrency**: Redis 7 ผ่านไลบรารี `ioredis ^6.0.0`
- **Observability**: Structured JSON Logger, Correlation ID Middleware (`X-Correlation-ID`), Liveness & Readiness Probes
- **Validation**: `class-validator` และ `class-transformer` พร้อม Global `ValidationPipe`
- **Testing**: Jest `^30.x`, Supertest `^7.x`
- **Container Engine**: Podman (รองรับ `podman compose` หรือ `podman-compose`) ใช้งานร่วมกับ `docker-compose.yml`

---

## 2. 📂 โครงสร้างสำคัญและจุดเริ่มต้นของโค้ด (Project Structure & Entry Points)

- `src/main.ts`: จุดเริ่มต้นของแอปพลิเคชัน (ตั้งค่า Global ValidationPipe, CORS, Port binding)
- `src/app.module.ts`: Root Module นำเข้า Config, TypeORM, Redis, Health, Interceptors และ Feature Modules
- `src/app.controller.ts`: Endpoint `GET /instance` ระบุ `INSTANCE_ID` ของแต่ละ Node
- `src/health/`:
  - `health.controller.ts`: `GET /health/live` (Liveness) & `GET /health/ready` (Readiness ตรวจสอบ DB/Redis)
  - `health.module.ts`: โมดูลตรวจสอบสุขภาพระบบ
- `src/common/`:
  - `middleware/trace-id.middleware.ts`: สร้างและดึง `X-Correlation-ID` / `X-Trace-ID`
  - `interceptors/logging.interceptor.ts`: บันทึก Structured JSON Log พร้อม Data Redaction
- `src/config/`:
  - `database.config.ts`: การตั้งค่า TypeORM Replication (`master` / `slaves` Read-Write Split)
  - `data-source.ts`: TypeORM CLI DataSource สำหรับการทำ Database Migration
- `src/redis/`:
  - `redis.service.ts`: Wrapper จัดการคำสั่ง Redis (`get`, `set` พร้อม TTL, `del`, `acquireLock`, `releaseLock` ด้วย Lua script, `incr`, `ping`)
  - `redis.constants.ts`: Injection Tokens และ Key Constants
- `src/students/`: โมดูลและ CRUD สำหรับนักศึกษา พร้อม Cache-Aside & Distributed Locking
- `src/courses/`: โมดูลหลักสูตรและการลงทะเบียน (จัดการ Race Condition ด้วย Pessimistic Lock บน Primary Database)
- `nginx/nginx.conf`: การตั้งค่า Reverse Proxy และ Load Balancing สำหรับ 3 Backend Instances
- `postgres-init/init-replication.sh`: สคริปต์สร้าง Replication User บน Primary Database
- `scripts/test-replication-lag.js`: สคริปต์ทดสอบ Replication Lag และ Read-Write Split

---

## 3. ⚡ คำสั่งสำคัญที่ใช้บ่อย (Run / Test / Build / Migration)

> ⚠️ **ต้องใช้ `pnpm` ในการรันคำสั่ง Node/NestJS เสมอ**

```bash
# --- Infrastructure ด้วย Podman (Nginx, 3 Backend Instances, Primary/Replica DB, Redis) ---
podman compose up -d                  # สตาร์ตทุกคอนเทนเนอร์ในระบบ
podman compose ps                     # ตรวจสอบสถานะการทำงานและ Healthcheck ของคอนเทนเนอร์
podman compose down                   # ปิดและหยุดคอนเทนเนอร์ทั้งหมด

# --- ติดตั้ง Dependencies และ Build ---
pnpm install                          # ติดตั้ง dependencies ทั้งหมด
pnpm add -w <pkg>                     # ติดตั้งแพ็กเกจใหม่ที่ root workspace (ต้องใส่ flag -w เสมอ)
pnpm add -w -D <dev-pkg>              # ติดตั้ง devDependencies ที่ root workspace
pnpm run build                        # คอมไพล์ TypeScript ไปยังโฟลเดอร์ dist/

# --- รันเซิร์ฟเวอร์สำหรับพัฒนาและ Production ---
pnpm run start:dev                    # สตาร์ตเซิร์ฟเวอร์โหมด Development (Hot Reload)
pnpm run start:prod                   # รันโค้ดที่คอมไพล์แล้วบนโหมด Production

# --- ตรวจสอบ Code Style และ จัดฟอร์แมต ---
pnpm run lint                         # ตรวจสอบและแก้ไขข้อผิดพลาดตามกฎ ESLint
pnpm run format                       # จัดรูปแบบโค้ดทั้งหมดด้วย Prettier

# --- การทดสอบ (Testing) ---
pnpm run test                         # รัน Unit Tests ทั้งหมด
pnpm run test:watch                   # รัน Unit Tests แบบ Watch Mode
pnpm run test:cov                     # รัน Unit Tests พร้อมสร้างรายงาน Coverage
pnpm run test:e2e                     # รัน End-to-End (E2E) Tests

# --- การจัดการ Database Migrations (TypeORM) ---
pnpm run migration:generate -- src/migrations/<MigrationName>  # สร้างไฟล์ Migration จากความต่างของ Entity
pnpm run migration:run                # ทำการ Migrate ไปยังฐานข้อมูล
pnpm run migration:revert             # ยกเลิก (Rollback) Migration ล่าสุด
pnpm run migration:show               # ดูสถานะ Migration ที่ถูกรันไปแล้วหรือยังค้างอยู่

# --- สคริปต์ทดสอบ Replication ---
node scripts/test-replication-lag.js  # ทดสอบการเขียนลง Primary และอ่านจาก Replica
```

---

## 4. 📐 รูปแบบ Architecture และ Core Patterns

1. **Stateless Backend Design**:
   - ไม่มี In-Memory State หรือ Session ผูกติดกับ RAM ของ Node.js process
   - การเก็บ State หรือ Cache ทั้งหมดต้องส่งผ่าน Redis เพื่อให้ขยาย Instance (Scale-out) ได้อย่างไร้รอยต่อ
2. **Nginx Reverse Proxy & Load Balancing**:
   - Nginx ทำหน้าที่รับ Traffic ที่ Port 80 (ภายนอกเข้าผ่าน 8080) และกระจายไปยัง `app-1`, `app-2`, `app-3`
   - รองรับอัลกอริทึม `round-robin` และ `least_conn` พร้อมส่งต่อ Client Headers (`Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`)
3. **Multi-Tier Health Checks (Liveness & Readiness)**:
   - **Liveness Probe** (`GET /health/live`): ตรวจสอบว่า Process ยังทำงานอยู่
   - **Readiness Probe** (`GET /health/ready`): ตรวจสอบว่า Dependency (PostgreSQL, Redis) พร้อมรับงาน หากไม่พร้อมจะส่งคืน `503 Service Unavailable` เพื่อให้ Load Balancer ถอดออกจาก Pool ชั่วคราว
4. **PostgreSQL Streaming Replication & Read-Write Split**:
   - Write Query และ DDL ทั้งหมดถูกส่งไปยัง **Primary Database**
   - Read Query ทั่วไปถูกส่งไปยัง **Replica Database** เพื่อลดภาระของฐานข้อมูลหลัก
   - **Critical Operations & Transactions**: คำสั่งที่ต้องป้องกัน Race Condition (เช่น การตัดที่นั่งหลักสูตร) **ต้องอ่านและล็อกบน Primary เท่านั้น** เพื่อป้องกันปัญหา Replication Lag
5. **Structured JSON Logging & Distributed Tracing**:
   - บันทึก Log ทุก Request ในรูปแบบ Single-line JSON มาตรฐาน
   - ติดตาม Trace ด้วย `X-Correlation-ID` ที่ส่งผ่าน Header และส่งต่อใน Response Header
   - ปกปิดข้อมูลอ่อนไหว (Data Redaction) อัตโนมัติสำหรับ Password, Token, Secrets
6. **Cache-Aside & Distributed Locking**:
   - ตรวจสอบ Redis Cache ก่อน Query Database
   - Distributed Lock โดยใช้ Redis Mutex Token และปลดล็อกผ่าน **Lua Script เท่านั้น**

---

## 5. 🚫 สิ่งที่ควรทำและข้อห้ามเด็ดขาด (Do's & Don'ts)

### ✅ สิ่งที่ต้องทำ (DO):
- **Strict Typing**: กำหนด Data Type ให้ชัดเจน หลีกเลี่ยงการใช้ `any` หรือ `unknown` โดยไม่มี Type Guard
- **Primary Lock on Transactions**: คำขอที่มี Transaction และ Pessimistic Lock ต้องสั่ง Query บน Master เสมอ
- **Always Set TTL**: ต้องระบุเวลาหมดอายุ (TTL) ทุกครั้งที่บันทึกข้อมูลลง Redis
- **Atomic Lua Lock Release**: ใช้ Lua Script ในการตรวจสอบ Token ก่อนลบ Redis Lock ทุกครั้ง
- **Proper HTTP Exceptions**: ใช้ NestJS Exceptions มาตรฐาน (`NotFoundException`, `ConflictException`, `BadRequestException`, `ServiceUnavailableException`)
- **Use Migrations**: ใช้ไฟล์ Migration สำหรับทุกการเปลี่ยนแปลง Schema ของฐานข้อมูล

### ❌ ข้อห้ามเด็ดขาด (DON'T):
- ❌ **ห้ามใช้ `npm` หรือ `yarn`** เด็ดขาด บังคับใช้ `pnpm` เท่านั้น
- ❌ **ห้ามเก็บ State ใน Memory ของ Node.js** ข้อมูลที่แชร์ต้องเก็บใน Redis หรือ DB
- ❌ **ห้ามเปิด `synchronize: true`** ในคอนฟิก TypeORM สำหรับสภาพแวดล้อม Production
- ❌ **ห้ามอ่านข้อมูลที่ต้อง Lock จาก Replica** เพราะอาจเจอ Replication Lag ทำให้เกิด Race Condition
- ❌ **ห้ามลบ Redis Lock ด้วยคำสั่ง `DEL` ตรงๆ** โดยไม่ผ่านการตรวจสอบ Token เจ้าของ
- ❌ **ห้าม Hardcode ข้อมูลลับ (Secrets, รหัสผ่าน)** ให้เรียกใช้ผ่าน `ConfigService` หรือ `.env` เสมอ
- ❌ **ห้าม Commit ไฟล์ `.env`** และห้ามแก้ไขไฟล์ `pnpm-lock.yaml` ด้วยตนเอง

---

## 6. 🧪 รายการตรวจสอบหลังการแก้ไขโค้ด (Verification Checklist)

ก่อนที่จะสรุปงานหรือส่งมอบโค้ด AI Agent **ต้องดำเนินการตรวจสอบดังต่อไปนี้**:

1. **คอมไพล์ผ่าน (Typecheck & Build)**:
   ```bash
   pnpm run build
   ```
   ต้องคอมไพล์สำเร็จโดยไม่มี TypeScript Error ใดๆ
2. **ความสะอาดของโค้ด (Lint & Code Style)**:
   ```bash
   pnpm run lint
   ```
   ต้องผ่านการตรวจสอบตามกฎ ESLint
3. **การทดสอบอัตโนมัติ (Automated Tests)**:
   ```bash
   pnpm run test
   ```
   Unit Tests ทั้งหมดต้องผ่าน (หากเทสต์ตกให้แก้ไขที่ต้นเหตุของฟังก์ชัน ห้ามลบ Assertion ทิ้ง)
4. **รักษาความเข้ากันได้ของ API (Contract Preservation)**:
   เส้นทาง Endpoint, รูปแบบ Request/Response JSON และเงื่อนไข Validation ต้องคงเดิม ไม่ทำให้ระบบเดิมเสียหาย

---

## ❓ 7. งานที่ต้องหยุดถามผู้ใช้ก่อนดำเนินการ (Clarification Triggers)

AI Agent **ต้องหยุดและสอบถามขอการยืนยันจากผู้ใช้ก่อน** หากต้องทำงานในลักษณะต่อไปนี้:

- ⚠️ **การกระทำที่ส่งผลกระทบต่อข้อมูลใน Database**: การสั่งรัน `migration:revert`, การลบตาราง/คอลัมน์ หรือการรัน Raw SQL ที่ลบข้อมูล
- ⚠️ **การเพิ่ม/ลบ External Dependencies**: การติดตั้งแพ็กเกจ npm ใหม่ หรือการถอด/อัปเกรด dependencies หลักใน `package.json`
- ⚠️ **การเปลี่ยนแปลง API Contract**: การเปลี่ยนชื่อ endpoint, เปลี่ยน HTTP method, ลบฟิลด์ใน payload หรือเปลี่ยน schema ของ response
- ⚠️ **การแก้ไขนโยบาย Cache หรือ Distributed Lock**: การเปลี่ยนรูปแบบ TTL, การปิดระบบ Lock หรือการลบมาตรการป้องกัน Concurrency
- ⚠️ **การแก้ไข Configuration หลักของระบบ**: การแก้ไข `.env.example`, ข้อมูลเชื่อมต่อฐานข้อมูล หรือคอนฟิกใน `docker-compose.yml`
