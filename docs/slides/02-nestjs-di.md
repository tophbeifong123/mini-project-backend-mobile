# Backend 02 — NestJS & Architecture for Testability

> บทนี้ตอบคำถามเดียว: **ทำยังไงให้โค้ดที่โตขึ้นเรื่อย ๆ ยังแก้ได้ ทดสอบได้ และไม่พันกันจนแตะไม่ได้**

### 📌 หัวข้อหลักในบทนี้:
- **Module / Controller / Provider (กล่องรวมของ / รับ request / ที่อยู่ของ logic จริง)**
- **Dependency Injection (ให้ framework ส่งของที่คลาสต้องใช้เข้ามาให้ แทนที่คลาสจะ new เอง)**
- **Provider Scope (อายุของ instance: ตัวเดียวทั้งแอป หรือสร้างใหม่ทุก request)**
- **DTO + ValidationPipe (คลาสกำหนดว่า request ต้องส่งอะไรมา + ตัวตรวจให้อัตโนมัติ)**
- **Custom Provider (บอก DI เองว่า token นี้ให้ส่งของชิ้นไหนมา)**
- **Unit Testing (เทสทีละชิ้นโดยไม่ต้องพึ่ง DB จริง)**

## 0. จุดที่เรื่องเดินมาถึง

บทที่แล้วเราแพ็ก Flash Sale API ลง container  *((กล่องที่ห่อแอปกับสภาพแวดล้อมไว้ด้วยกัน ยกไปรันที่ไหนก็เหมือนเดิม))* ได้แล้ว ตอนนี้ระบบเริ่มโต มี user, product, order, payment, email แล้วทุกอย่างเริ่มพันกัน

```typescript
// สิ่งที่จะเกิดถ้าไม่วางโครงสร้างอะไรเลย
class OrderController {
  async create(req) {
    const db = new Database(process.env.DB_URL);   // ผูกกับ DB จริงตายตัว
    const mailer = new SendGrid(process.env.KEY);  // ผูกกับ SendGrid จริงตายตัว
    if (!req.body.productId) return res.status(400)...  // validate เอง
    // business logic 200 บรรทัด ปนกับเรื่อง HTTP อยู่ตรงนี้
  }
}
```

โค้ดแบบนี้มีปัญหา 2 ข้อที่จะกัดเราไปตลอดโปรเจกต์:

- **ทดสอบไม่ได้** — จะเทสทีต้องมี DB จริงและ SendGrid จริง (แปลว่าเทสทีนึงส่งอีเมลจริงด้วย)
- **เอาไปใช้ซ้ำไม่ได้** — logic ผูกติดกับ HTTP request ทั้งที่เดี๋ยวบท 05 เราจะต้องเรียก logic ก้อนเดียวกันนี้จาก queue worker  *((โปรเซสหลังบ้านที่คอยหยิบงานจากคิวมาทำ ไม่ได้มาจาก HTTP))* ซึ่งไม่มี request

> 🎯 **อ่านบทนี้จบแล้วต้องได้อะไร**
> ต้องอธิบายได้ว่า *"DI แก้ปัญหาอะไร"*  *((Dependency Injection — ให้ framework ส่งของที่คลาสต้องใช้เข้ามาให้ แทนที่คลาสจะสร้างเอง))* โดยไม่พูดคำว่า "มันคือ design pattern" (ตอบแบบนั้นไม่ได้คะแนน) และต้องอธิบายได้ว่า *"ทำไม service ต้อง stateless"*  *((stateless = ไม่เก็บข้อมูลผู้ใช้ไว้ในตัวเอง ทุก instance จึงรับ request แทนกันได้))* ซึ่งข้อหลังนี่โยงยาวไปถึงบท 04 และ 06 ทั้งบท

## 1. ปูพื้นฐาน: NestJS คืออะไร ทำไมไม่ใช้ Express เปล่า ๆ

Express คือ library บาง ๆ ที่จัดการเรื่อง HTTP ให้ — รับ request, จับคู่ route, ส่ง response แค่นั้น มัน**ไม่บอกอะไรเลย**ว่าเราควรจัดโครงสร้างโค้ดยังไง ซึ่งดีมากถ้าเขียน API 3 endpoint แต่พอทีม 5 คนช่วยกันเขียน 200 endpoint ทุกคนจะจัดโครงคนละแบบ แล้วอ่านโค้ดกันไม่รู้เรื่อง

NestJS คือ framework  *((โครงสำเร็จรูปที่กำหนดว่าโค้ดต้องวางยังไง ต่างจาก library ที่เราเรียกใช้เอง))* ที่ครอบ Express (หรือ Fastify)  *((Fastify = ตัวจัดการ HTTP อีกตัว เร็วกว่า Express))* แล้วเพิ่มของมา 3 อย่าง:

1. **โครงสร้างที่ตายตัว (opinionated)** — Module / Controller / Provider ทุกคนในทีมเขียนเหมือนกันหมด
2. **DI container ในตัว** — ทำให้การเขียนโค้ดที่เทสได้กลายเป็นเรื่องปกติ ไม่ใช่ของแถม
3. **TypeScript-first** — type ไล่ตั้งแต่ DTO  *((คลาสที่กำหนดว่า request ต้องส่งอะไรมาบ้าง ใช้ตรวจข้อมูลขาเข้า))* ยันชั้น repository

> ⚠️ **ระวังสับสน: "container" สองตัวนี้คนละเรื่องกัน**
> **Docker container** (บท 01) = กล่องที่ห่อแอปกับสภาพแวดล้อมไว้ด้วยกันเพื่อเอาไปรันที่ไหนก็ได้
>
> **DI container** (บทนี้) = โค้ดส่วนหนึ่งของ NestJS ที่ทำหน้าที่ "จำไว้ว่ามี object อะไรบ้าง แล้วสร้างและแจกจ่ายให้ class ที่ต้องการ"
>
> สองตัวนี้ไม่เกี่ยวกันเลย แค่บังเอิญใช้คำเดียวกันเพราะทั้งคู่แปลว่า "ภาชนะที่บรรจุของ"

### 1.1 สี่ชั้นของ NestJS ที่ต้องแยกให้ออก

| ชั้น | หน้าที่ | ห้ามทำอะไร |
| --- | --- | --- |
| **Module** | จัดกลุ่มของที่เกี่ยวข้องกันไว้ด้วยกัน มี `imports / controllers / providers / exports` | — |
| **Controller** | เรื่อง HTTP อย่างเดียว: รับ request → ดึง param → เรียก service → คืนค่า | **ห้ามมี business logic  *((กฎทางธุรกิจ เช่น สั่งเกิน 10 ชิ้นไม่ได้ ไม่ใช่เรื่อง HTTP))* ห้ามแตะ DB** |
| **Service (Provider)**  *((Provider = ของที่ลงทะเบียนไว้ให้ container สร้างและแจกจ่าย ส่วนใหญ่คือ service))* | business logic ทั้งหมด, โยน HTTP exception | **ห้ามเก็บ state ของผู้ใช้** |
| **Repository** | คุยกับ database | ไม่ควรมี business rule |

> 📊 **แผนภาพ: แต่ละชั้นรู้จักแค่ชั้นถัดไป — Service ไม่รู้ด้วยซ้ำว่ามันถูกเรียกมาจาก HTTP หรือจาก queue**
>
> *ข้อความ/ลำดับในแผนภาพ:*
> - Client
> - มือถือ / เว็บ
> - HTTP
> - Controller
> - ชั้น HTTP
> - Service
> - business logic
> - Repository
> - คุยกับ DB
> - DB
> - ทางเดียว ไม่ย้อนกลับ ไม่ข้ามชั้น
> - ✓ ดึง param
> - ✓ แปลงเป็น DTO
> - ✓ คืน response
> - ✗ business logic
> - ✗ เรียก DB ตรง
> - ✓ กฎทางธุรกิจ
> - ✓ transaction
> - ✓ โยน exception
> - ✗ เก็บ state ผู้ใช้
> - ✗ รู้จัก req/res
> - ✓ query
> - ✓ map entity
> - ✗ กฎทางธุรกิจ
> - ที่ต้องแยกแบบนี้เพราะ Service เป็นชั้นเดียวที่ queue worker (บท 05) จะเรียกใช้ได้ — worker ไม่มี HTTP request ให้ใช้

### 1.2 ทำไม controller ต้องบาง

คำตอบที่คนชอบตอบคือ "เพื่อความสะอาด" ซึ่งได้คะแนนน้อยมาก เพราะไม่ได้บอกว่าได้อะไร คำตอบที่ดีมี 2 ข้อ:

1. **ทดสอบได้โดยไม่ต้องยิง HTTP** — ถ้า logic อยู่ใน service เราเรียก `service.createOrder(...)` ตรง ๆ ในเทสได้เลย ไม่ต้องปั้น request object ปลอมขึ้นมา
2. **เรียกซ้ำจากทางเข้าอื่นได้** — logic ก้อนเดียวกันจะถูกเรียกจาก queue worker (บท 05), CLI, cron หรือ GraphQL resolver ในอนาคต ถ้ามันฝังอยู่ใน controller ก็ต้อง copy-paste ซึ่งแปลว่าแก้บั๊กทีต้องแก้หลายที่

### 1.3 แบ่งโฟลเดอร์ตาม domain  *((ก้อนงานตามเรื่อง เช่น users, orders))* ไม่ใช่ตาม layer  *((ชั้นทางเทคนิค เช่น controllers, services))*

```typescript
❌ แบ่งตาม layer                ✅ แบ่งตาม domain
src/                            src/
  controllers/                    users/
    user.controller.ts              user.controller.ts
    order.controller.ts             user.service.ts
  services/                         user.module.ts
    user.service.ts               orders/
    order.service.ts                order.controller.ts
  repositories/                     order.service.ts
    ...                             order.module.ts
```

เหตุผล: เวลาแก้ feature "order" ไฟล์ที่เกี่ยวข้องอยู่ในโฟลเดอร์เดียวกันหมด ไม่ต้องกระโดดข้าม 3 โฟลเดอร์ และวันที่ต้องแตกเป็น microservice  *((แยกแอปเป็นบริการเล็ก ๆ deploy คนละตัว))* ก็แค่ลากโฟลเดอร์ `orders/` ออกไปทั้งก้อน (นี่คือ modular monolith  *((แอปก้อนเดียวแต่ข้างในแบ่งโมดูลชัด พร้อมแตกออกทีหลัง))* จากบท 01 ในระดับโค้ดจริง)

> ⚠️ **กับดัก: `exports`**
> Provider เป็น **module-scoped** โดยปริยาย — module อื่นเรียกใช้ไม่ได้จนกว่าจะใส่ชื่อไว้ใน `exports` พอเจอ error "Nest can't resolve dependencies" คนมักแก้ด้วยการ export ทุกอย่างออกไปหมด ซึ่งทำลาย encapsulation  *((การซ่อนของภายในโมดูลไม่ให้ข้างนอกเข้ามายุ่ง))* จนกลายเป็นก้อนโคลนใหญ่ ๆ ให้ export เท่าที่จำเป็นจริง ๆ เท่านั้น

## 2. Dependency Injection — ใจกลางของบทนี้

### 2.1 เข้าใจปัญหาก่อน อย่าเพิ่งดู syntax

```typescript
// ไม่มี DI
class UserService {
  private db = new PostgresDatabase(process.env.DB_URL);   // ← ตัวปัญหาอยู่ตรงนี้
  private mailer = new SendGridMailer(process.env.KEY);
}
```

บรรทัดที่ `new` นี่แหละ ทำให้เกิดปัญหา 3 อย่างพร้อมกัน:

1. **เทสไม่ได้** — ทุกครั้งที่เทส `UserService` มันจะต่อ PostgreSQL จริงและส่งอีเมลจริง
2. **สลับของไม่ได้** — จะเปลี่ยน SendGrid เป็น SES ต้องไล่แก้ทุก class ที่ `new` มัน
3. **มองไม่เห็นว่า class นี้พึ่งอะไรบ้าง** — ต้องไล่อ่านทั้ง class ถึงจะรู้

DI แก้ด้วยหลักการเดียว: **อย่าสร้าง dependency เอง ให้รับเข้ามาทาง constructor**  *((วิธีนี้เรียก constructor injection · dependency = ของที่คลาสต้องใช้ เช่น db, mailer))* แล้วให้ container เป็นคนหามาให้

> 📊 **แผนภาพ: หัวใจของ DI คือ service ไม่ผูกกับ *ของชิ้นใดชิ้นหนึ่ง* แต่ผูกกับ *หน้าตาของของ* ใครมีหน้าตาตรงก็เสียบแทนกันได้**
>
> *ข้อความ/ลำดับในแผนภาพ:*
> - ❌ ไม่มี DI — สร้างเอง
> - ✅ มี DI — รับเข้ามา
> - UserService
> - new PostgresDatabase()
> - PostgreSQL จริง
> - เทสก็ต่อของจริง
> - SendGrid จริง
> - เทสก็ส่งอีเมลจริง
> - • เทสไม่ได้ถ้าไม่มีของจริง
> - • เปลี่ยน SendGrid → SES ต้องไล่แก้ทุก class
> - • ไม่รู้ว่า class พึ่งอะไรจนกว่าจะอ่านหมด
> - DI Container ของ NestJS
> - ฉีดให้ตอนสร้าง
> - constructor(db, mailer)
> - ของจริง (prod)
> - Postgres / SendGrid
> - mock (ตอนเทส)
> - สลับได้โดยไม่แก้ service
> - UserService ไม่รู้และไม่สนใจว่าได้ตัวไหนมา — ขอแค่หน้าตา (type) ตรงกัน

```typescript
@Injectable()
export class UserService {
  constructor(
    private readonly userRepo: Repository<User>,   // ← รับเข้ามา ไม่ new เอง
    private readonly mailer: MailerService,
  ) {}
}
```

> 🧠 **ประโยคที่เอาไปตอบข้อสอบได้เลย**
> DI คือการย้ายความรับผิดชอบในการ "หาและสร้าง dependency" ออกจาก class ไปให้ container ทำให้ class ไม่ผูกกับ *implementation*  *((ตัวที่ลงมือทำงานจริง เช่น SendGridMailer ไม่ใช่แค่หน้าตา))* ตัวใดตัวหนึ่ง ผลตรง ๆ คือ **mock ได้ทันทีตอนเทส**  *((mock = ของปลอมที่สวมแทนของจริงตอนเทส เช่น DB ปลอม))* และ **สลับ implementation ตาม environment ได้** โดยไม่ต้องแตะโค้ดที่เรียกใช้เลย

### 2.2 DI ทำงานได้ยังไง (และทำไม interface ใช้ไม่ได้)

NestJS รู้ว่าจะฉีดอะไรเข้าไป เพราะ TypeScript ปล่อยข้อมูล type ของ constructor parameter ออกมาตอน compile (ฟีเจอร์ชื่อ `emitDecoratorMetadata`)  *((สวิตช์ TypeScript ที่ฝัง type ไว้ให้ decorator หรือป้าย @ อ่านได้ตอนรัน))* แล้ว container เอา type นั้นไปใช้เป็น **token** เพื่อค้นหาว่าต้องเอา provider ตัวไหนมาให้

พูดง่าย ๆ คือ type ทำหน้าที่เป็น "ชื่อ" ที่ container ใช้ค้นของในกล่อง

> ⚠️ **กับดักอันดับหนึ่งของมือใหม่ NestJS**
> **`interface` ใช้เป็น DI token ไม่ได้**  *((interface = ตัวประกาศหน้าตาว่า object ต้องมี method อะไรบ้าง · DI token = ชื่อที่ container ใช้ค้นของ))* เพราะ interface ของ TypeScript *หายไปตอน compile* (เรียกว่า type erasure) พอถึง runtime  *((ตอนโปรแกรมรันอยู่จริง ต่างจาก compile ที่ยังแปลงโค้ดอยู่))* ก็ไม่เหลืออะไรให้ container เอาไปค้นหา
>
> ทางแก้: ใช้ **abstract class**  *((คลาสแม่ที่ประกาศหน้าตา method ไว้ให้ลูกไปเขียนต่อ ห้าม new ตรง ๆ))* ซึ่งยังเหลืออยู่ตอน runtime หรือประกาศ token เป็น `Symbol`  *((ค่าที่ JS การันตีว่าไม่ซ้ำกับใคร ใช้เป็นชื่อ token ได้))* / ค่าคงที่ที่ export ออกมา แล้วใช้ `@Inject(TOKEN)`

### 2.3 Custom Provider  *((บอก container เองว่าจะสร้างหรือหาของตัวนี้มาให้ยังไง))* 3 แบบ

| แบบ | ใช้ตอนไหน | ทำไม |
| --- | --- | --- |
| `useValue` | ค่าคงที่, config object, mock ในเทส | ไม่ต้องสร้างอะไร เอาค่านี้ไปใช้เลย |
| `useClass` | สลับ implementation ตาม environment | เปลี่ยน `SendGridMailer` → `SesMailer` โดยโค้ดที่เรียกใช้ไม่รู้เรื่องเลย |
| `useFactory` + `inject` | ของที่ต้อง `await` ตอนสร้าง เช่น DB, Redis  *((ที่เก็บข้อมูลในหน่วยความจำ เร็วมาก ใช้เก็บของที่ต้องแชร์กันไว้ตรงกลาง))* | connection ถูกเชื่อมต่อเสร็จ *ก่อน* แอปเริ่มรับ traffic แทนที่จะไปพังกลางทาง |

```typescript
{
  provide: 'REDIS_CLIENT',
  useFactory: async (config: ConfigService) => {
    const client = new Redis(config.get('REDIS_URL'));
    await client.ping();          // เชื่อมต่อให้เสร็จก่อน
    return client;
  },
  inject: [ConfigService],
}
```

**เรื่อง token:** ใช้ class เป็น token เป็นค่าเริ่มต้น เพราะ type-safe, auto-complete ได้ และ refactor แล้วชื่อตามไปเอง ถ้าจำเป็นต้องใช้ token ที่ไม่ใช่ class ให้ใช้ `Symbol` หรือค่าคงที่ที่ export — **อย่าใช้ string ดิบ ๆ** เพราะพิมพ์ผิดแล้วไปพังตอน runtime และ token ชนกันข้าม module ได้

## 3. Provider Scope  *((อายุของ provider ว่าถูกสร้างใหม่บ่อยแค่ไหน))* — จุดที่คนเข้าใจผิดมากที่สุด

| Scope | สร้างเมื่อไร | ควรใช้ |
| --- | --- | --- |
| `DEFAULT` | ครั้งเดียวตอนแอปเริ่ม (singleton)  *((singleton = มีตัวเดียวทั้งแอป ใครขอก็ได้ตัวเดิม))* | **เกือบทุกกรณี** |
| `REQUEST` | สร้างใหม่ทุก HTTP request | แทบไม่ต้องใช้ — ดูด้านล่าง |
| `TRANSIENT` | สร้างใหม่ทุกครั้งที่ถูก inject | กรณีพิเศษมาก ๆ |

> 🛑 **⚠ สไลด์เขียนผิด — ข้อนี้น่าจะออกสอบ**
> สไลด์เขียนว่า provider เป็น **"Singleton — one instance per module"** ซึ่ง**ผิด**
>
> ความจริงคือมันเป็น **singleton ต่อ application (ต่อ DI container)** ถ้า module A กับ module B ต่างก็ import module ที่ export `UserService` ทั้งคู่จะได้ **instance เดียวกันตัวเดิม**  *((instance = object ตัวจริงที่ถูกสร้างขึ้นมา 1 ตัว))* ไม่ใช่คนละตัว
>
> ทำไมเรื่องนี้สำคัญ: ถ้าเชื่อตามสไลด์ นายจะคิดว่าเก็บ state  *((ข้อมูลที่ค้างอยู่ในตัว object ข้ามหลาย request))* ใน service ได้เพราะ "แต่ละ module มีของตัวเอง" ซึ่งเป็นความเข้าใจผิดที่นำไปสู่บั๊กข้อมูลรั่วข้าม request โดยตรง

### 3.1 Singleton + state = บั๊กที่ร้ายที่สุดในบทนี้

```typescript
@Injectable()
export class ProductService {
  private cache = new Map();        // ⚠️ อันตราย
  private currentUser: User;        // ☠️ หายนะ
}
```

> 📊 **แผนภาพ: เพราะทุก request ใช้ instance เดียวกัน การเก็บข้อมูลของผู้ใช้ไว้ใน field ของ service คือการเอาข้อมูลไปวางไว้ในที่สาธารณะ**
>
> *ข้อความ/ลำดับในแผนภาพ:*
> - Request A
> - สมชาย
> - Request B
> - สมหญิง
> - ProductService
> - instance เดียว ใช้ร่วมกันทุก request
> - currentUser = ?
> - ① A เข้ามา → currentUser = สมชาย
> - ② B เข้ามาแทรก → currentUser = สมหญิง
> - ③ A อ่านค่าต่อ → ได้ "สมหญิง"
> - สมชายเห็นข้อมูลของสมหญิง
> - นี่ไม่ใช่เรื่อง "โค้ดไม่สะอาด" แต่เป็น ช่องโหว่ความปลอดภัย (data leak ข้าม tenant)
> - ทางแก้มีทางเดียว: service ต้อง stateless — state ที่ต้องแชร์ไปอยู่ Redis (บท 04)

> 🔗 **🔗 นี่คือจุดที่บท 02, 04 และ 06 มาเจอกัน**
> ต่อให้ `private cache = new Map()`  *((cache = ที่พักข้อมูลที่ดึงมาแล้ว ไว้ตอบซ้ำได้เร็ว ๆ))* ไม่มีข้อมูลผู้ใช้ปนเลย มันก็ยังใช้ไม่ได้ในระบบจริง เพราะพอเรา scale เป็น 3 instance (บท 06) แต่ละ instance จะมี Map ของตัวเอง **ไม่ sync กัน** ผู้ใช้คนหนึ่งเห็นราคาเก่า อีกคนเห็นราคาใหม่ แล้วแต่ว่า load balancer  *((ตัวกระจาย request ไปยัง instance ต่าง ๆ))* ส่งไปเครื่องไหน
>
> ทางแก้ทางเดียวคือย้าย state ออกไปไว้ที่กลาง = **Redis (บท 04)**
>
> สรุปเป็นกฎเดียว: **service ต้อง stateless — state ที่ต้องแชร์ไปอยู่ Redis** กฎนี้จะโผล่ซ้ำในบท 04, 05 และ 06

### 3.2 Scope bubbling — ทำไมห้ามใช้ REQUEST scope พร่ำเพรื่อ

ถ้า `ServiceA` เป็น REQUEST scope แล้ว `ServiceB` inject มันเข้ามา → `ServiceB` จะกลายเป็น REQUEST ตามไปด้วยโดยอัตโนมัติ และถ้า controller inject `ServiceB` อีกที controller ก็กลายเป็น REQUEST ตามอีก มัน "ลาม" ขึ้นข้างบนไปเรื่อย ๆ

> 📊 **แผนภาพ: ประกาศ REQUEST scope ที่ provider ตัวเดียวลึก ๆ แต่ผลกระทบเด้งขึ้นไปถึง controller**
>
> *ข้อความ/ลำดับในแผนภาพ:*
> - ก่อน: ทุกตัวเป็น DEFAULT — สร้างครั้งเดียวตอน boot
> - Controller
> - ServiceB
> - ServiceA
> - รวม 3 object ตลอดอายุแอป
> - หลัง: เปลี่ยน ServiceA ตัวเดียวเป็น REQUEST
> - → REQUEST
> - REQUEST
> - สร้างใหม่ 3 object
> - ทุก request ที่เข้ามา
> - scope ลามย้อนขึ้นไปทั้งสาย ← ทิศทางตรงข้ามกับลูกศร dependency
> - อาการ: latency สูงขึ้นทั้งระบบ แต่หาสาเหตุยากเพราะต้นเหตุอยู่ห่างจากอาการหลายชั้น

**แล้วถ้าอยากได้ข้อมูลของ request ปัจจุบันจริง ๆ ล่ะ** (เช่น userId หรือ correlation id  *((รหัสประจำ 1 request ไว้ไล่ log ต่อกันได้))*) ให้ใช้ `AsyncLocalStorage`  *((ที่เก็บข้อมูลติดไปกับ request ตลอดสาย async โดยไม่ต้องส่งต่อเป็นพารามิเตอร์))* ผ่านไลบรารี `nestjs-cls` ซึ่งให้ request context ได้โดยที่ provider ทุกตัวยังเป็น DEFAULT scope เหมือนเดิม

### 3.3 Circular dependency

module A import B และ B import A → NestJS โยน error ที่อ่านยาก คนส่วนใหญ่แก้ด้วย `forwardRef()`  *((บอก Nest ให้ค่อยไปหา dependency ตัวนั้นทีหลัง จะได้ไม่วนตาย))* แล้วจบ

> ⚠️ **คำตอบที่ได้คะแนนเต็ม**
> `forwardRef()` **รักษาอาการ ไม่ได้รักษาโรค** — การมี circular dependency คือสัญญาณว่า *ขอบเขตของโมดูลถูกวางผิด* สองโมดูลที่ต้องพึ่งกันไปกลับ แปลว่ามันมีความรับผิดชอบร่วมกันบางอย่างที่ยังไม่ถูกดึงออกมา
>
> วิธีแก้ที่ถูกคือดึงส่วนที่ทั้งคู่ใช้ร่วมกันออกมาเป็น shared module แล้วให้ทั้ง A และ B import จากตรงนั้นแทน ทำให้ dependency กลายเป็นทิศทางเดียว

## 4. DTO & ValidationPipe  *((ด่านตรวจ request ตาม DTO ก่อนถึง controller))*

DTO (Data Transfer Object) คือ class ที่บอกว่า request body ควรมีหน้าตายังไง ใช้คู่กับ `class-validator`  *((ไลบรารีที่ให้แปะกฎ เช่น @IsInt @IsUUID ไว้บน field ของ DTO))* แล้ว NestJS จะตรวจให้อัตโนมัติก่อนเข้า controller

```typescript
export class CreateOrderDto {
  @IsUUID()      productId: string;
  @IsInt() @Min(1) @Max(10)  quantity: number;
}

// main.ts
app.useGlobalPipes(new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
}));
```

| Option | ทำอะไร | ทำไมสำคัญ |
| --- | --- | --- |
| `whitelist: true` | ตัด property ที่ไม่ได้ประกาศใน DTO ทิ้ง | **กัน mass assignment** — ผู้ใช้ส่ง `{"quantity":1, "role":"admin", "price":0}` แนบมาด้วย ถ้าไม่ตัดทิ้งแล้วเผลอ `save(body)` ตรง ๆ ก็เท่ากับเราเพิ่งแจกสิทธิ์ admin ไปฟรี ๆ นี่เป็นช่องโหว่ระดับ OWASP  *((รายการช่องโหว่ความปลอดภัยมาตรฐานที่วงการยึดถือ))* |
| `forbidNonWhitelisted: true` | ตอบ 400 แทนที่จะเงียบ ๆ ตัดทิ้ง | client รู้ตัวว่าส่งผิด และเราจับบั๊กได้เร็ว แทนที่จะมานั่งงงว่า "ทำไมค่าที่ส่งไปหายไป" |
| `transform: true` | แปลง payload เป็น instance ของ DTO class จริง | ทำให้ type ที่ประกาศไว้ **ตรงกับของจริงตอน runtime** — ไม่งั้น `quantity: number` อาจได้ string `"3"` มาจาก query param  *((ค่าที่ต่อท้าย URL หลังเครื่องหมาย ? ซึ่งเป็น string เสมอ))* แล้ว `quantity + 1` จะได้ `"31"` แทนที่จะเป็น `4` |

### 4.1 Error handling: โยน exception อย่า return null

```typescript
// ❌
async findOne(id: string) {
  return this.repo.findOne({ where: { id } });   // คืน null → controller ต้องเดาเอง
}

// ✅
async findOne(id: string) {
  const user = await this.repo.findOne({ where: { id } });
  if (!user) throw new NotFoundException(`User ${id} not found`);
  return user;
}
```

เหตุผล: ได้ HTTP status ที่ถูกต้องอัตโนมัติ, error format เหมือนกันทั้งระบบ, และ controller ไม่ต้องมานั่งเดาว่า `null` แปลว่า "ไม่มี" หรือ "พัง"

## 5. Unit Testing  *((เทสทีละหน่วยเล็ก ๆ โดยแทนของรอบข้างด้วยของปลอม))*

```typescript
describe('UserService', () => {
  let service: UserService;
  let repo: jest.Mocked<Repository<User>>;   // ← มี type ไม่ใช่ any

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: getRepositoryToken(User), useValue: createMockRepo() },
      ],
    }).compile();
    service = module.get(UserService);
    repo = module.get(getRepositoryToken(User));
  });

  it('should throw NotFoundException when user not found', async () => {
    repo.findOne.mockResolvedValue(null);                    // Arrange
    await expect(service.findOne('x'))                       // Act
      .rejects.toThrow(NotFoundException);                   // Assert
  });
});
```

สังเกตว่าเราส่ง mock เข้าไปแทน repository จริงได้เลย โดยไม่ต้องแตะโค้ดของ `UserService` — นี่คือผลตอบแทนของ DI ที่จับต้องได้จริง

| กฎ | เหตุผล |
| --- | --- |
| 1 test = 1 unit, mock dependency ทั้งหมด | เทสแดงแล้วรู้ทันทีว่าพังที่ไหน ไม่ต้องไล่ข้าม 3 ชั้น |
| ตั้งชื่อเทสเป็น**พฤติกรรม** ไม่ใช่ `should work` | ตอน CI  *((ระบบที่รันเทสอัตโนมัติทุกครั้งที่ push โค้ด))* แดงตอนตี 2 ชื่อเทสคือ bug report บรรทัดเดียว |
| AAA (Arrange–Act–Assert) | อ่านปุ๊บรู้ว่ากำลังทดสอบอะไร ลดภาระตอน review |
| mock ต้องมี type: `jest.Mocked>` | ถ้าใช้ `any` พอ signature ของจริงเปลี่ยน **เทสจะยังเขียวทั้งที่โค้ดจริงพัง** — เทสที่โกหกแย่กว่าไม่มีเทส |

### 5.1 Controller test ควรเทสแค่ไหน

เทสแค่ 3 อย่าง: **เรียก service ถูกตัวไหม / ส่ง param ถูกไหม / คืนค่าที่ได้กลับไปไหม**

ไม่ต้องเทส: HTTP mechanics (หน้าที่ framework), validation (หน้าที่ pipe), business logic (เทสที่ service ไปแล้ว) — เทสซ้ำคือจ่ายค่าดูแลโดยไม่ได้ความมั่นใจเพิ่ม

### 5.2 ขีดจำกัดของ unit test

> ⚠️ **ข้อจำกัดที่ต้องพูดถึงในข้อสอบ**
> Unit test ที่ mock repository ทั้งหมด **พิสูจน์ไม่ได้ว่า SQL ที่เขียนถูกต้อง** เพราะ repository ตัวจริงไม่เคยถูกเรียกเลย เราอาจได้เทสเขียว 100% ในขณะที่ query พังใน production
>
> ดังนั้นต้องมี **integration test** คู่กันเสมอ (ใช้ DB จริง ช้ากว่าในระดับวินาที) ครอบ happy path  *((เส้นทางปกติที่ทุกอย่างสำเร็จ ไม่มี error))* ของแต่ละ feature

> 🛑 **⚠ สไลด์บทนี้**
> 1. สไลด์บอก provider เป็น "singleton per module" — **ผิด** เป็น singleton ต่อ application/DI container
> 2. ตัวอย่าง mock ประกาศ `let mockRepo: any` — เสีย type safety ให้ใช้ `jest.Mocked>` แทน
> 3. สไลด์ยกตัวอย่าง `private cache = new Map()` ว่า "shared across all requests" ซึ่งถูกในทางเทคนิค แต่เป็นตัวอย่างที่อันตรายมาก และในระบบหลาย instance มันยังไม่ sync กันด้วย
> 4. `jest.spyOn`  *((สั่งดักแทน method ตัวจริงชั่วคราวตอนเทส))* บน method ของ class ที่กำลังทดสอบเอง = กำลังทดสอบ mock ไม่ใช่โค้ดจริง
> 5. สไลด์ไม่ได้พูดเลยว่า `interface` ใช้เป็น DI token ไม่ได้ ทั้งที่เป็นกับดักอันดับต้น ๆ

## 6. Performance: อย่าปรับผิดที่

> 🧠 **ประโยคสำคัญ**
> **framework overhead แทบไม่เคยเป็น bottleneck  *((จุดคอขวดที่ทำให้ทั้งระบบช้า))* จริง** — ในแอปจริงเวลาส่วนใหญ่หมดไปกับ DB query และการเรียกบริการภายนอก ถ้าจะปรับ performance ให้ไปแก้ query กับ index  *((โครงสร้างช่วยให้ DB ค้นเจอเร็ว ไม่ต้องไล่ทั้งตาราง))* (บท 03) และ cache (บท 04) ก่อนเสมอ

- พิจารณา `@nestjs/platform-fastify` เฉพาะเมื่อ workload เป็น I/O  *((งานที่มัวแต่รออ่าน/เขียนดิสก์หรือเน็ต ไม่ใช่งานคำนวณ))* ล้วนและ RPS  *((จำนวน request ต่อวินาที))* สูงจริง ๆ (และต้องเช็คว่า middleware  *((โค้ดที่แทรกทำงานก่อน request จะถึง controller เช่น log, auth))* ที่ใช้อยู่รองรับ)
- อย่ายิง DB ใน custom validator — validation ควรเป็น pure  *((ตัดสินจากค่าที่รับมาอย่างเดียว ไม่ไปแตะ DB หรือยิง API))* ไม่มี side effect
- ระวัง global interceptor  *((ตัวห่อรอบการเรียก ทำงานทั้งก่อนและหลัง เช่น log, แปลง response))* ที่ serialize หนัก ๆ เช่น `JSON.parse(JSON.stringify())` เพราะมันทำงานทุก request

## 7. 🔗 บทนี้ต่อกับบทอื่นตรงไหน

> 🔗 **เส้นเชื่อม**
> - **← บท 01:** Module ตาม domain = modular monolith ที่บท 01 สั่งไว้ / `useFactory` แบบ async สำหรับ connection ก็คือหลัก "validate config ตอน boot แล้ว fail fast"  *((ตั้งค่าผิดให้แอปดับตั้งแต่ตอนเริ่ม ดีกว่าไปพังตอนมีคนใช้))*
> - **→ บท 03:** ชั้น Repository ในบทนี้คือประตูเข้าสู่ TypeORM  *((ORM ของ Node — ตัวแปลงระหว่าง object ในโค้ดกับตารางใน DB))* ทั้งบท และหลัก "โยน exception ไม่ return null" จะขยายเป็นการ map PostgreSQL error code เช่น 23505 → 409 ในบท 03
> - **→ บท 04:** "service ต้อง stateless" คือเหตุผลที่ cache ต้องอยู่ที่ Redis ไม่ใช่ `Map` ในหน่วยความจำ
> - **→ บท 05:** "controller บาง logic อยู่ service" คือเงื่อนไขที่ทำให้ queue worker เรียก business logic เดิมซ้ำได้โดยไม่ต้อง copy โค้ด
> - **→ บท 06:** stateless service คือเงื่อนไขบังคับของ horizontal scaling  *((เพิ่มจำนวนเครื่องหรือ instance แทนการอัปเครื่องเดิมให้แรงขึ้น))* / logging interceptor ที่แนบ correlation id ในบทนี้ คือรากฐานของ observability  *((มองเห็นว่าข้างในระบบเกิดอะไรขึ้น ผ่าน log / metric / trace))* ในบท 06

## 8. 📝 คลังคำตอบอัตนัย

<details>
<summary><b>Dependency Injection คืออะไร แก้ปัญหาอะไร และช่วยเรื่อง testability อย่างไร</b></summary>

โครง: ปัญหาเดิม → หลักการ → ประโยชน์ 3 ข้อ → ตัวอย่างเทส

ปัญหาเดิมคือ class สร้าง dependency ของตัวเองด้วย `new` เช่น `private db = new PostgresDatabase(...)` ทำให้ class ผูกติดกับ implementation นั้นอย่างถาวร

DI คือการย้ายความรับผิดชอบในการหาและสร้าง dependency ออกจาก class ไปให้ **container** โดย class รับ dependency ผ่าน constructor เท่านั้น

ประโยชน์ข้อแรกคือ **testability** — ตอนเทสเราส่ง mock เข้าไปแทนของจริงได้ทันที ผ่าน `Test.createTestingModule({ providers: [Real, { provide: Dep, useValue: mock }] })`  *((ตัวช่วยของ Nest ที่ปั้น DI container จำลองไว้ใช้ในเทส))* โดยไม่ต้อง monkey-patch  *((แอบไปแก้ไส้ในของ object หรือโมดูลตอนรัน))* และไม่ต้องใช้ database จริง ข้อที่สองคือ **สลับ implementation ได้** เช่นเปลี่ยนจาก SendGrid เป็น SES ด้วย `useClass` โดยโค้ดที่เรียกใช้ไม่ต้องแก้เลย ข้อที่สามคือ **อ่านง่าย** เพราะ dependency ทั้งหมดของ class มองเห็นได้จาก constructor signature จุดเดียว

ข้อควรระวังคือ dependency graph มองไม่เห็นด้วยตาเปล่า ต้องพึ่ง error ตอน runtime และหากเลือก scope ผิดจะจ่ายค่า performance โดยไม่รู้ตัว
</details>

<details>
<summary><b>ทำไม service ใน NestJS ต้อง stateless จงอธิบายผลที่เกิดขึ้นถ้าไม่ทำตาม</b></summary>

โครง: กลไก singleton → ผลเสีย 2 ระดับ (ข้ามผู้ใช้ / ข้าม instance) → ทางแก้ → โยงบท 06

เพราะ provider ใน NestJS เป็น **singleton ต่อ application** โดยปริยาย นั่นคือทุก request ที่เข้ามาใช้ instance เดียวกันทั้งหมด

ผลเสียระดับที่หนึ่ง หากเก็บข้อมูลเฉพาะผู้ใช้ไว้ใน field ของ service เช่น `private currentUser` ผู้ใช้คนที่สองจะเห็นข้อมูลของคนแรก ซึ่งเป็น **data leak ข้าม request หรือข้าม tenant**  *((tenant = ลูกค้าหรือองค์กรคนละรายที่ใช้ระบบเดียวกัน))* ถือเป็นช่องโหว่ด้านความปลอดภัย ไม่ใช่เพียงบั๊กเรื่องความสะอาดของโค้ด

ผลเสียระดับที่สองสำคัญกว่าและมักตอบไม่ถึง เมื่อ scale เป็นหลาย instance ตามบท 06 แต่ละ instance มีหน่วยความจำของตัวเอง state ที่เก็บไว้ใน `Map` จึง**ไม่ sync กัน** ผู้ใช้จะเห็นข้อมูลไม่ตรงกันขึ้นกับว่า load balancer ส่ง request ไปยัง instance ใด และข้อมูลจะหายไปทุกครั้งที่ restart ซึ่งเกิดขึ้นทุกครั้งที่ deploy

ทางแก้คือย้าย state ที่ต้องแชร์ออกไปไว้ที่เก็บกลาง คือ **Redis** ตามบท 04 และหากต้องการ context เฉพาะ request เช่น userId หรือ correlation id ให้ใช้ `AsyncLocalStorage` แทนการเปลี่ยน provider เป็น REQUEST scope
</details>

<details>
<summary><b>REQUEST scope คืออะไร ทำไมจึงควรหลีกเลี่ยง</b></summary>

โครง: นิยาม → กลไก bubbling → ผลกระทบ → ทางเลือก

REQUEST scope ทำให้ NestJS สร้าง instance ใหม่ของ provider นั้นทุก HTTP request แทนที่จะใช้ singleton ตัวเดิม

ปัญหาคือปรากฏการณ์ **scope bubbling** กล่าวคือ scope จะแพร่ขึ้นด้านบนตามสายของการ inject หาก provider ที่เป็น REQUEST ถูก inject เข้าไปใน service ตัวอื่น service นั้นจะกลายเป็น REQUEST ตามไปด้วย และหาก controller inject service นั้นอีกทอด controller ก็กลายเป็น REQUEST เช่นกัน ผลคือ **ทั้งสายโซ่ถูกสร้างใหม่ทุก request**

ผลกระทบคือ performance ลดลงอย่างมีนัยสำคัญและวินิจฉัยได้ยาก เนื่องจากสาเหตุซึ่งคือการประกาศ scope ที่ provider ตัวเดียวในระดับลึก อยู่ห่างจากอาการซึ่งคือ latency  *((เวลาที่ 1 request ใช้ตอบกลับ))* ที่สูงขึ้นทั้งระบบหลายชั้น

ทางเลือกที่ควรใช้แทนคือ `AsyncLocalStorage` ผ่านไลบรารี `nestjs-cls` ซึ่งให้ request-scoped context เช่น userId หรือ correlation id ได้ โดยที่ provider ทั้งหมดยังคงเป็น DEFAULT scope
</details>

<details>
<summary><b>อธิบายว่า `whitelist`, `forbidNonWhitelisted` และ `transform` ใน ValidationPipe ทำอะไร และทำไมจึงจำเป็น</b></summary>

โครง: อธิบายทีละตัวพร้อมผลถ้าไม่ใส่ → เน้นว่า whitelist เป็นเรื่อง security

**`whitelist: true`** ตัด property ที่ไม่ได้ประกาศไว้ใน DTO ออกจาก payload ความจำเป็นคือการป้องกัน **mass assignment** หากผู้ใช้แนบ `{"role":"admin"}` หรือ `{"price":0}` มากับ request แล้วโค้ดเผลอส่ง body ทั้งก้อนเข้า `save()` ผู้ใช้จะยกระดับสิทธิ์ตนเองหรือแก้ราคาสินค้าได้ ซึ่งเป็นช่องโหว่ระดับ OWASP ไม่ใช่เพียงเรื่องความสะอาดของโค้ด

**`forbidNonWhitelisted: true`** ทำให้ระบบตอบ 400 พร้อมระบุว่า field ใดเกินมา แทนที่จะตัดทิ้งอย่างเงียบ ๆ ประโยชน์คือฝั่ง client ทราบทันทีว่าส่งข้อมูลผิด และทีมพัฒนาตรวจพบข้อผิดพลาดได้เร็ว แทนที่จะต้องสืบหาสาเหตุว่าเหตุใดค่าที่ส่งไปจึงหายไป

**`transform: true`** แปลง plain object ให้กลายเป็น instance ของ DTO class จริง ทำให้ type ที่ประกาศไว้ตรงกับค่าที่ได้จริงตอน runtime หากไม่ใส่ ค่าที่มาจาก query parameter หรือ JSON อาจเป็น string ทั้งที่ประกาศเป็น `number` ส่งผลให้การคำนวณผิดพลาด เช่น `quantity + 1` ให้ผลเป็น `"31"` แทน `4` และ decorator อย่าง `@Type(() => Number)` จะไม่ทำงาน
</details>

<details>
<summary><b>ทำไม controller ไม่ควรมี business logic</b></summary>

โครง: หน้าที่จริงของ controller → เหตุผล 2 ข้อ (testability / reusability) → โยงบท 05

หน้าที่ของ controller คือชั้น HTTP เท่านั้น ได้แก่รับ request, ดึง parameter, ส่งต่อให้ service และคืน response

เหตุผลข้อแรกคือ **testability** เมื่อ logic อยู่ใน service เราสามารถเรียก `service.method()` ได้โดยตรงในเทส โดยไม่ต้องสร้าง request หรือ response object จำลอง และไม่ต้องยิง HTTP จริง ทำให้เทสเร็วและเปราะน้อยลง

เหตุผลข้อที่สองสำคัญกว่าและมักตอบไม่ถึงคือ **reusability** business logic ชุดเดียวกันจะต้องถูกเรียกจากทางเข้าอื่นในอนาคต เช่น queue worker ที่ประมวลผล job ตามบท 05, CLI, cron job หรือ GraphQL resolver ซึ่งทางเข้าเหล่านี้ไม่มี HTTP request หาก logic ฝังอยู่ใน controller ที่ผูกกับ HTTP ก็จำเป็นต้องคัดลอกโค้ดไปวางซ้ำ ซึ่งหมายความว่าการแก้บั๊กหนึ่งครั้งต้องแก้หลายจุด

ผลพลอยได้คือ service ที่แยกออกมากลายเป็นจุดเดียวที่โยน HTTP exception เช่น `NotFoundException` ทำให้รูปแบบ error ทั้งระบบสม่ำเสมอ
</details>

<details>
<summary><b>Unit test กับ Integration test ต่างกันอย่างไร และทำไมมี unit test อย่างเดียวไม่พอ</b></summary>

โครง: นิยาม/คุณสมบัติทั้งสอง → ข้อจำกัดของ unit → สรุปว่าต้องมีคู่กัน

Unit test ทดสอบหน่วยเดียวโดย mock dependency ทั้งหมด รันเร็วในระดับมิลลิวินาที และเมื่อล้มเหลวจะระบุได้แม่นยำว่าพังที่จุดใด ส่วน integration test ทดสอบหลายส่วนทำงานร่วมกันโดยใช้ของจริง เช่น database จริง จึงช้ากว่าในระดับวินาที

ข้อจำกัดสำคัญของ unit test คือ เมื่อ mock repository ออกไปทั้งหมด **repository ตัวจริงจะไม่เคยถูกเรียกเลย** จึงพิสูจน์ไม่ได้ว่า query ที่เขียนไว้ถูกต้อง เราอาจได้ผลเทสเขียวครบทุกข้อในขณะที่ SQL ผิดหรือ relation ไม่ถูกต้องใน production

นอกจากนี้ unit test ยังยืนยันไม่ได้ว่า migration  *((ไฟล์เวอร์ชันของโครงสร้างตาราง DB ที่รันไล่ตามลำดับ))* ใช้งานได้จริง โดยเฉพาะเมื่อ test setup ใช้ `synchronize: true` ซึ่งข้ามการรัน migration ไปเลย ตามที่กล่าวถึงในบท 03

ดังนั้นทั้งสองแบบต้องมีคู่กัน โดย unit test ครอบทุก branch ของ business logic เพื่อให้ได้ feedback ที่เร็วและแม่นยำ ส่วน integration test ครอบ happy path ของแต่ละ feature เพื่อยืนยันว่าชิ้นส่วนต่าง ๆ ทำงานร่วมกันได้จริง
</details>

<details>
<summary><b>เจอ error "Nest can't resolve dependencies" จาก circular dependency ควรแก้อย่างไร</b></summary>

โครง: สาเหตุ → ทางแก้เฉพาะหน้า → ทำไมไม่ควรหยุดแค่นั้น → ทางแก้จริง

สาเหตุคือ module A import module B ในขณะที่ B ก็ import A ทำให้ container ไม่สามารถหา instance ที่พร้อมใช้งานได้ในขณะสร้าง dependency graph

ทางแก้เฉพาะหน้าคือใช้ `forwardRef()` ทั้งสองฝั่ง ซึ่งบอกให้ NestJS resolve dependency นั้นภายหลัง

อย่างไรก็ตามไม่ควรหยุดเพียงเท่านี้ เพราะ **circular dependency เป็นอาการ ไม่ใช่ตัวโรค** มันเป็นสัญญาณว่าขอบเขตของโมดูลถูกวางไว้ผิด การที่สองโมดูลต้องพึ่งพากันไปมาแสดงว่ามีความรับผิดชอบร่วมกันบางอย่างที่ยังไม่ถูกแยกออกมา

วิธีแก้ที่ถูกต้องคือดึงส่วนที่ทั้งคู่ใช้ร่วมกันออกมาเป็น **shared module** แล้วให้ทั้ง A และ B import จากโมดูลนั้นแทน ซึ่งทำให้ dependency กลายเป็นทิศทางเดียว และสอดคล้องกับหลักการแบ่งโมดูลตาม domain ที่จะเป็นประโยชน์เมื่อต้องแตกเป็น microservice ในอนาคต
</details>

## 9. ✅ เช็คตัวเองก่อนปิดบท

- อธิบาย DI ได้โดย**เริ่มจากปัญหา** ไม่ใช่เริ่มจากคำว่า "design pattern"
- รู้ว่า provider เป็น singleton ต่อ **application** ไม่ใช่ต่อ module (สไลด์เขียนผิด)
- อธิบาย scope bubbling ได้ และรู้ว่าใช้อะไรแทน REQUEST scope
- ตอบได้ว่าทำไม `whitelist: true` เป็นเรื่อง security ไม่ใช่แค่ความเรียบร้อย
- บอกได้ว่า unit test พิสูจน์อะไร*ไม่ได้*
- ลากเส้นได้ว่า "service stateless" → Redis (บท 04) → horizontal scaling (บท 06)

  <a href="01-architecture-docker.html">← บทที่ 1</a>
  <a href="03-database.html">บทที่ 3 — Database →</a>
