# Backend 02 — NestJS Fundamentals & Architecture for Testability

> ที่มา: `Backend02 - NestJS Fundamentals & Architecture for Testability.pdf`
> ขอบเขต: ทำไมต้อง NestJS · Modules/Controllers/Providers · DTO Validation · Dependency Injection · Unit Testing

---

## 1. สรุปสาระสำคัญ (Core Concepts)

| หัวข้อ | ใจความ |
|---|---|
| **NestJS คืออะไร** | framework ครอบ Express/Fastify + TypeScript + DI container + โครงสร้าง modular แบบ opinionated (แนวคิดคล้าย Angular) |
| **Module** | หน่วยจัดกลุ่มตาม feature/domain — มี `imports`, `controllers`, `providers`, `exports`; provider เป็น **module-scoped** โดย default ต้อง `exports` ถึงจะให้ module อื่นใช้ได้ |
| **Controller** | ชั้น HTTP เท่านั้น — รับ request, ดึง param, ส่งต่อ service, คืน response **ห้ามมี business logic** |
| **Provider / Service** | business logic + data access, `@Injectable()`, เป็น **singleton ต่อ module** โดย default |
| **Layer flow** | Controller → Service → Repository → Database |
| **DTO + ValidationPipe** | นิยามรูปร่าง request ด้วย class-validator แล้วให้ pipe validate อัตโนมัติ คืน 400 พร้อมรายการ error |
| **DI** | ไม่ `new` dependency เอง แต่รับผ่าน constructor → container เป็นคนหา/สร้าง/ฉีดให้ |
| **Provider scope** | `DEFAULT` (singleton) / `REQUEST` (ต่อ HTTP request) / `TRANSIENT` (ใหม่ทุกครั้งที่ inject) |
| **Custom provider** | `useValue` (ค่าคงที่/config), `useClass` (สลับ implementation), `useFactory` (สร้างแบบ dynamic/async, มี `inject` สำหรับ dependency) |
| **Testing** | `Test.createTestingModule({ providers: [Real, { provide: Dep, useValue: mock }] }).compile()` |

**Request Lifecycle:** Request → Middleware → Guards → Interceptors → Pipes → Handler → Interceptors → Response

---

## 2. Best Practices (พร้อมเหตุผล)

### 2.1 โครงสร้าง

| Practice | เหตุผล |
|---|---|
| **แบ่ง module ตาม feature/domain ไม่ใช่ตาม technical layer** (`users/` ไม่ใช่ `controllers/`, `services/`) | ตอนแก้ feature หนึ่ง ไฟล์ที่เกี่ยวข้องอยู่ในโฟลเดอร์เดียวกัน และตอนต้องแตกเป็น microservice คุณ "ยกโฟลเดอร์" ออกไปได้เลย (ต่อยอดจาก modular monolith ใน Backend01) |
| **Thin controller** — controller แค่ delegate | ทำให้ business logic ทดสอบได้โดยไม่ต้องยิง HTTP, และ logic เดิมถูก reuse จาก queue worker / CLI / GraphQL resolver ได้ |
| **`exports` เฉพาะสิ่งที่จำเป็น** | ควบคุม coupling ระหว่างโมดูล ถ้า export ทุกอย่าง encapsulation หายไปและกลายเป็น big ball of mud |
| **แยก shared module** (`database`, `config`, `logging`) | cross-cutting concern อยู่ที่เดียว เปลี่ยนทีเดียวมีผลทั้งระบบ |
| **ใช้ `nest g resource`** | ได้โครงสร้าง + spec file + import ที่ถูกต้องทันที ลดความหลากหลายที่ไม่จำเป็นในทีม |

### 2.2 Validation & Error

| Practice | เหตุผล |
|---|---|
| **`ValidationPipe` แบบ global พร้อม `whitelist: true`** | ตัด property ที่ไม่ได้ประกาศใน DTO ทิ้ง → กัน **mass assignment** (เช่นผู้ใช้ส่ง `role: "admin"` แนบมา) |
| **`forbidNonWhitelisted: true`** | ตอบ 400 แทนที่จะเงียบ ๆ ตัดทิ้ง → client รู้ตัวว่าส่งผิด และเราจับ bug ได้เร็ว |
| **`transform: true`** | แปลง payload เป็น instance ของ DTO class จริง → type ที่ประกาศไว้ตรงกับ runtime (`@Type(() => Number)` ทำงาน) |
| **ใช้ built-in HTTP exception** (`NotFoundException`, `ConflictException`) | ได้ status code + รูปแบบ error ที่สม่ำเสมอทั้งระบบโดยไม่ต้องเขียนเอง |
| **โยน exception จาก service ไม่ใช่ return null** | controller ไม่ต้องเดาว่าค่า null แปลว่าอะไร และ error format สม่ำเสมอ |

### 2.3 Dependency Injection

| Practice | เหตุผล |
|---|---|
| **Constructor injection เสมอ** | dependency ทั้งหมดมองเห็นได้จาก signature เดียว → อ่านรู้ทันทีว่า class นี้พึ่งอะไร และ mock ได้ครบ |
| **ใช้ class token เป็นค่าเริ่มต้น** | type-safe, auto-complete, refactor แล้วชื่อตามไปด้วย ต่างจาก string token ที่พิมพ์ผิดแล้วพังตอน runtime |
| **ถ้าต้องใช้ token ที่ไม่ใช่ class ให้ใช้ `Symbol` หรือค่าคงที่ที่ export** | กัน token ชนกันข้าม module และ IDE ตามหา reference ได้ |
| **`useFactory` + `inject` สำหรับ async resource** (DB, Redis) | connection ถูกสร้าง/เชื่อมต่อให้เสร็จก่อนแอปรับ traffic แทนที่จะ lazy แล้วพังกลางทาง |
| **`useClass` สำหรับสลับ implementation ตาม environment** | เปลี่ยน SendGrid → SES โดยไม่แตะโค้ดที่เรียกใช้เลย |
| **อยู่กับ `DEFAULT` (singleton) ให้นานที่สุด** | ประหยัดหน่วยความจำและเร็วสุด (สร้างครั้งเดียว) — ดู §3 เรื่อง REQUEST scope |

### 2.4 Testing

| Practice | เหตุผล |
|---|---|
| **1 test = 1 unit, mock dependency ทั้งหมด** | test fail แล้วรู้ทันทีว่าพังที่ไหน ไม่ต้องไล่หาข้าม 3 ชั้น |
| **AAA pattern (Arrange-Act-Assert)** | อ่าน test ปุ๊บรู้ว่ากำลังทดสอบอะไร ลด cognitive load ตอน review |
| **ตั้งชื่อ test เป็นพฤติกรรม** — `should throw NotFoundException when user not found` ไม่ใช่ `should work` | เมื่อ CI แดง ชื่อ test คือ bug report บรรทัดเดียว |
| **จัดกลุ่มด้วย `describe` ซ้อนตาม method** | เห็น coverage เชิงพฤติกรรมของแต่ละ method ได้ทันที |
| **Controller test เช็คแค่ "เรียก service ถูกตัว ส่ง param ถูก คืนค่าถูก"** | HTTP mechanics เป็นหน้าที่ framework, validation เป็นหน้าที่ pipe, business logic ทดสอบที่ service แล้ว — ทดสอบซ้ำคือ maintenance cost เปล่า ๆ |
| **มี factory function สร้าง mock** | ลด boilerplate และ mock ทุก test เริ่มจากสถานะสะอาดเหมือนกัน |

---

## 3. What to Concern (จุดที่ต้องระวัง)

1. **`REQUEST` scope แพร่ขึ้นด้านบน (scope bubbling)** — ถ้า service ที่เป็น REQUEST ถูก inject เข้า controller controller นั้นจะกลายเป็น REQUEST scope ตามไปด้วย และทุกตัวที่ inject มันก็ตามอีก ผลคือ **สร้าง instance ใหม่ทุก request ทั้งสายโซ่** → performance ตกอย่างมีนัยสำคัญ ใช้เมื่อจำเป็นจริงเท่านั้น ทางเลือกที่ดีกว่าคือ `AsyncLocalStorage` (`nestjs-cls`) สำหรับ request context
2. **Singleton + state = bug ข้าม request** — สไลด์แสดง `private cache = new Map()` ใน service singleton ถ้าเผลอเก็บข้อมูลเฉพาะผู้ใช้ลงไป **ผู้ใช้คนหนึ่งจะเห็นข้อมูลของอีกคน** (data leak ข้าม tenant) service ต้อง stateless
3. **Circular dependency** — module A import B, B import A เกิดง่ายมากเมื่อโปรเจกต์โต NestJS จะโยน error ที่อ่านยาก (`Nest can't resolve dependencies`) วิธีแก้เฉพาะหน้าคือ `forwardRef()` แต่การมี circular dep คือสัญญาณว่า **boundary ของโมดูลวางผิด** ควรแยก shared module ออกมาแทน
4. **DTO ที่ไม่มี `whitelist`** — เปิดช่อง mass assignment ตรง ๆ นี่เป็นช่องโหว่ระดับ OWASP ไม่ใช่แค่เรื่องความสะอาดของโค้ด
5. **Decorator + `emitDecoratorMetadata`** — DI ทำงานได้เพราะ TypeScript ปล่อย metadata ของ type ถ้าใช้ `interface` เป็น type ของ constructor parameter **DI จะพัง** เพราะ interface หายไปตอน compile → ต้องใช้ abstract class หรือ token
6. **Test ที่ mock ทุกอย่าง อาจ pass ทั้งที่ระบบพัง** — unit test บอกไม่ได้ว่า SQL ที่ repository เขียนถูกหรือไม่ ต้องมี integration test คู่กัน (สไลด์เปรียบเทียบไว้แล้ว: unit = ทุกอย่าง mock/เร็วระดับ ms, integration = DB จริง/ระดับวินาที)
7. **Learning curve** — สไลด์ระบุ Medium-High ทีมที่ไม่คุ้น decorator/DI จะช้าใน 2–3 สัปดาห์แรก ต้องเผื่อเวลาไว้ในแผน

---

## 4. Performance

| ประเด็น | ผลกระทบ | คำแนะนำ |
|---|---|---|
| **Provider scope** | REQUEST/TRANSIENT = สร้าง object ใหม่ทุกครั้ง + scope bubbling | ใช้ DEFAULT ให้มากที่สุด, ใช้ AsyncLocalStorage แทน REQUEST scope |
| **HTTP adapter** | Express vs Fastify ต่างกันที่ throughput ระดับเท่าตัวใน benchmark | ถ้า workload เป็น I/O ล้วนและ RPS สูง พิจารณา `@nestjs/platform-fastify` (แต่ต้องเช็คว่า middleware ที่ใช้รองรับ) |
| **ValidationPipe** | validate ทุก request มี cost แต่คุ้มเสมอ | ใช้ `transform: true` และหลีกเลี่ยง custom validator ที่ยิง DB — validation ควรเป็น pure |
| **Framework overhead ไม่ใช่ bottleneck จริง** | ในแอปจริง เวลาส่วนใหญ่หมดไปกับ DB query และ external call | อย่าปรับ framework ก่อนวัด — ดู Backend03 (N+1, index) และ Backend04 (cache) ก่อน |
| **Interceptor แบบ global** | ทำงานทุก request ถ้าเขียน serialize หนัก ๆ จะกระทบทั้งระบบ | ระวังการ `JSON.parse(JSON.stringify())` ใน interceptor |

---

## 5. Pros & Cons

### NestJS
| Pros | Cons |
|---|---|
| โครงสร้างมาตรฐาน คนใหม่เข้าใจเร็ว ทีมใหญ่ไม่ชนกัน | opinionated — ถ้าไม่ชอบแนวทางของมัน จะฝืนตลอด |
| DI container ในตัว → testability ระดับ first-class | boilerplate เยอะกว่า Express มาก สำหรับ API 3 endpoint คือ overkill |
| TypeScript-first, type safety ตั้งแต่ DTO ถึง repository | learning curve ปานกลาง-สูง (decorator, DI, module graph) |
| มี Guards/Pipes/Interceptors/Filters เป็น cross-cutting ที่มาตรฐาน | error message ของ DI container อ่านยากเมื่อ dependency graph ซับซ้อน |
| CLI generate โครงให้ + มี testing module ในตัว | มี abstraction layer เพิ่มจาก Express → debug ลึก ๆ ต้องรู้ทั้งสองชั้น |
| รองรับ microservices/message pattern ในตัว | overhead เล็กน้อยเทียบกับ Fastify เปล่า ๆ |

### Dependency Injection
| Pros | Cons |
|---|---|
| mock ได้ทันทีโดยไม่ต้อง monkey-patch | dependency graph มองไม่เห็นด้วยตาเปล่า ต้องพึ่ง error ตอน runtime |
| สลับ implementation ตาม environment ได้ | นักพัฒนาใหม่งงว่า "instance นี้มาจากไหน" |
| ใช้ instance เดียวร่วมกันทั้งแอป (logger, config) | ถ้าใช้ scope ผิด จะจ่าย performance โดยไม่รู้ตัว |

---

## 6. ✅ Should Do / ❌ Should Not Do

### ✅ ควรทำ
| ทำ | เพราะ |
|---|---|
| controller บาง — delegate อย่างเดียว | testable + reusable logic |
| `ValidationPipe` global + `whitelist` + `forbidNonWhitelisted` + `transform` | กัน mass assignment และได้ error format มาตรฐาน |
| constructor injection + class token | type-safe และเห็น dependency ครบจากที่เดียว |
| แยก module ตาม domain, `exports` เท่าที่จำเป็น | คุม coupling และเตรียมทางแตก service |
| service เป็น stateless | singleton ปลอดภัยและ scale ออกได้ (ดู Backend06) |
| โยน built-in exception จาก service | HTTP status ถูกต้องอัตโนมัติ |
| ตั้งชื่อ test เป็นพฤติกรรม + AAA | CI แดงแล้วอ่านเข้าใจทันที |
| `nest g resource` เวลาสร้าง feature ใหม่ | โครงสร้างสม่ำเสมอทั้งทีม |

### ❌ ไม่ควรทำ
| อย่าทำ | เพราะ |
|---|---|
| ใส่ business logic / DB access ใน controller | ทดสอบยาก reuse ไม่ได้ ผูกกับ HTTP layer |
| `new Database()` ใน constructor | mock ไม่ได้ → test ต้องมี DB จริง ช้าและเปราะ |
| เก็บ state ต่อผู้ใช้ไว้ใน service singleton | ข้อมูลรั่วข้าม request และ scale ออกไม่ได้ |
| ใช้ REQUEST scope เพราะ "สะดวกดี" | scope bubbling ทำให้ทั้งสายโซ่สร้างใหม่ทุก request |
| ใช้ `interface` เป็น type ของ constructor param สำหรับ DI | metadata หายตอน compile → DI resolve ไม่ได้ |
| แก้ circular dependency ด้วย `forwardRef()` แล้วจบ | มันคืออาการ ไม่ใช่โรค — boundary ของโมดูลผิด |
| unit-test business logic ซ้ำที่ controller | จ่ายค่า maintenance โดยไม่ได้ความมั่นใจเพิ่ม |
| ตั้งชื่อ test ว่า `should work` | ไม่ช่วยอะไรตอน CI แดงเวลาตี 2 |

---

## 7. Recommendation (ลำดับลงมือจริง)

1. `nest new` → ตั้ง `ValidationPipe` global ใน `main.ts` **ทันที** พร้อม `whitelist/forbidNonWhitelisted/transform`
2. สร้าง `ConfigModule` + validate schema ของ env (ต่อยอดจาก "validate config at startup" ใน Backend01)
3. สร้าง feature module แรกด้วย `nest g resource` แล้วยึดโครงนี้เป็นมาตรฐานทีม
4. เขียน service ให้ stateless + โยน HTTP exception + มี unit test คู่กับทุก method ที่มี branch
5. ใช้ `useFactory` async สำหรับ DB/Redis connection
6. เพิ่ม global exception filter + logging interceptor ที่แนบ correlation id (เตรียมทางให้ Backend06)
7. เพิ่ม integration test ชั้นบน (supertest + DB จริง) สำหรับ happy path ของแต่ละ feature

---

## 8. ⚠️ Errata / จุดที่สไลด์เขียนไว้ต้องระวัง

1. **สไลด์บอกว่า provider เป็น "Singleton — One instance per module"** — ข้อความนี้ทำให้เข้าใจผิด จริง ๆ แล้ว **singleton ต่อ application (ต่อ DI container)** ไม่ใช่ต่อ module ถ้า module A และ B ต่าง import module ที่ export `UserService` ทั้งคู่จะได้ **instance เดียวกัน** ไม่ใช่คนละตัว
2. **สไลด์ 20 "Without DI" กับ "With DI" เปรียบเทียบไม่ครบ** — `const service = new UserService(mockDb, mockMailer)` ใช้ได้จริงก็ต่อเมื่อ mock มีรูปร่างตรง type ในทางปฏิบัติควรใช้ `Test.createTestingModule` เหมือนสไลด์หลัง เพื่อให้ทดสอบตรงกับที่ Nest ประกอบจริง
3. **Mock ที่ประกาศเป็น `let mockRepo: any`** — เสีย type safety ทั้งหมด ถ้า signature ของ repository เปลี่ยน test จะยัง pass ทั้งที่โค้ดจริงพัง แนะนำ `jest.Mocked<Repository<User>>` หรือ `Partial<Repository<User>>` แทน `any`
4. **สไลด์ Provider Scopes ยกตัวอย่าง `private cache = new Map()` ใน DEFAULT scope ว่า "Shared across all requests"** — ถูกในทางเทคนิค แต่เป็นตัวอย่างที่อันตราย ถ้าอ่านผ่าน ๆ จะเข้าใจว่าเก็บ state ใน singleton ได้ตามสบาย ในระบบ multi-instance (Backend06) cache แบบนี้จะไม่ sync กันด้วย — ต้องใช้ Redis (Backend04)
5. **`jest.spyOn(realService, 'create')` ในหัวข้อ Partial Mocks** — ระวังการ spy method ของ class ที่กำลังทดสอบเอง มันทำให้คุณทดสอบ mock ไม่ใช่โค้ดจริง ใช้เฉพาะเมื่อ method นั้นเป็น side effect ที่ไม่เกี่ยวกับสิ่งที่กำลังพิสูจน์
6. **Interface ใช้เป็น DI token ไม่ได้** — สไลด์ไม่ได้พูดถึง แต่เป็นกับดักอันดับต้น ๆ ของคนเริ่มใช้ NestJS

---

## 9. Checklist ก่อน merge

- [ ] `ValidationPipe` global ตั้ง `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`
- [ ] controller ไม่มี business logic / ไม่มี DB access
- [ ] service ไม่มี mutable state ที่ผูกกับผู้ใช้
- [ ] dependency ทั้งหมดรับผ่าน constructor และใช้ class/Symbol token
- [ ] module `exports` เฉพาะที่จำเป็น และไม่มี circular dependency
- [ ] ทุก branch ของ business logic มี unit test พร้อมชื่อที่บอกพฤติกรรม
- [ ] mock มี type ไม่ใช่ `any`
- [ ] error ที่ผู้ใช้เห็นเป็น built-in exception ไม่ใช่ 500 ดิบ ๆ
