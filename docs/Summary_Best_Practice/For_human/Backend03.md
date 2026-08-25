# Backend 03 — Database Engineering (Migrations & Transactions)

> ที่มา: `Backend03 - Database Engineering.pdf`
> ขอบเขต: ORM/TypeORM · Entity & Relations · Migrations · Transactions & ACID · Race Condition & Locking · Query Optimization · Connection Pooling

---

## 1. สรุปสาระสำคัญ (Core Concepts)

| หัวข้อ | ใจความ |
|---|---|
| **ORM** | แปลง object ↔ ตาราง ได้ type safety + query builder แลกกับ overhead และ abstraction leak |
| **Data Mapper vs Active Record** | TypeORM ใช้ Data Mapper เป็นหลัก (entity = ข้อมูลล้วน, repository = การ persist) เหมาะกับแอปใหญ่; Active Record เหมาะ CRUD ง่าย ๆ |
| **`synchronize: true`** | ให้ TypeORM sync schema ตาม entity อัตโนมัติ — **ห้ามใช้ใน production เด็ดขาด มันลบตารางได้** |
| **Migration** | version control ของ schema — มี `up()` และ `down()`, เรียงตาม timestamp, บันทึกใน table `migrations` |
| **ACID** | Atomicity (ทำหมดหรือไม่ทำเลย) · Consistency (constraint ถูกบังคับ) · Isolation (transaction ไม่กวนกัน) · Durability (commit แล้วอยู่ถาวร) |
| **Race condition** | ช่องว่างระหว่าง "อ่าน-ตรวจ" กับ "เขียน" ทำให้สองคำขอผ่าน check พร้อมกัน → double booking |
| **Isolation levels** | READ UNCOMMITTED → READ COMMITTED (ค่าเริ่มต้น PostgreSQL) → REPEATABLE READ → SERIALIZABLE (ช้าที่สุด ปลอดภัยที่สุด) |
| **Pessimistic lock** | ล็อกแถวไว้ตลอด transaction (`SELECT FOR UPDATE`) — ใช้เมื่อชนกันบ่อย |
| **Optimistic lock** | ใช้ `@VersionColumn` ตรวจตอน save ถ้า version ไม่ตรงคือมีคนแก้ก่อน — ใช้เมื่อชนกันน้อย/ผู้ใช้แก้ฟอร์มนาน |
| **Deadlock** | สอง transaction รอ lock ของกันและกัน DB จะฆ่าตัวหนึ่งทิ้ง (PostgreSQL error `40P01`) |
| **N+1** | ดึง list 1 query แล้ววน query relation ทีละแถวอีก N query — แก้ด้วย `relations: [...]` (JOIN) |

---

## 2. Best Practices (พร้อมเหตุผล)

### 2.1 Migration

| Practice | เหตุผล |
|---|---|
| **`synchronize: false` ใน production เสมอ** | TypeORM จะพยายาม "ทำให้ schema ตรงกับ entity" ซึ่งรวมถึง **DROP COLUMN / DROP TABLE** เมื่อคุณลบ field ออกจาก entity → ข้อมูลหายถาวรโดยไม่มีการถาม |
| **เขียนทั้ง `up()` และ `down()`** | ถ้า deploy แล้วพังตอนตี 2 คุณต้อง rollback ได้ ไม่ใช่ต้องมานั่งเขียน SQL แก้สดตอนนั้น |
| **ห้ามแก้ migration ที่ deploy ไปแล้ว** | migration ที่รันแล้วถูกบันทึกใน table `migrations` การแก้ไฟล์เก่าจะทำให้ environment ที่รันไปแล้วกับที่ยังไม่รัน **มี schema ต่างกันถาวร** → schema drift |
| **1 migration = 1 การเปลี่ยนแปลงเชิงตรรกะ** | review ง่าย, rollback แม่นยำ, และหา migration ที่ทำระบบพังได้เร็ว |
| **ทดสอบ migration บนสำเนาข้อมูลจริงก่อน** | migration ที่ผ่านบน DB เปล่า อาจใช้เวลา 40 นาทีและล็อกตารางบน DB จริงที่มี 50 ล้านแถว |
| **รัน migration เป็น job แยกก่อน deploy app** | ถ้ารันตอน app boot และมี 3 instance ขึ้นพร้อมกัน จะแย่งกันรัน migration; แยก job ทำให้ควบคุมลำดับและมี approval gate ได้ |
| **`migration:generate` แล้วต้องอ่านก่อน commit เสมอ** | generator เดาจาก diff ของ entity ซึ่งบางครั้งตีความเป็น drop+create แทน rename → ข้อมูลหาย |

### 2.2 Transaction

| Practice | เหตุผล |
|---|---|
| **transaction ต้องสั้นที่สุด** | ยิ่งเปิดนาน ยิ่งถือ lock นาน → คนอื่นรอ, connection ใน pool ถูกจอง, โอกาส deadlock สูงขึ้น |
| **ห้ามเรียก external API ใน transaction** | HTTP call อาจใช้ 5–30 วินาที ระหว่างนั้น DB ถือ lock ค้าง; และถ้า transaction rollback ทีหลัง คุณ "ยกเลิกอีเมลที่ส่งไปแล้ว" ไม่ได้ (ให้ push เข้า queue แทน — ดู Backend05) |
| **ใช้ `manager` ที่ transaction ให้มา ไม่ใช่ repository เดิม** | ถ้าเผลอใช้ `this.repo` ข้างใน callback คำสั่งนั้นจะวิ่งนอก transaction และ **ไม่ถูก rollback** — เป็นบั๊กที่หาเจอยากมาก |
| **ล็อก resource ตามลำดับเดียวกันทุกที่** (เช่น User ก่อน Account เสมอ) | deadlock เกิดจาก circular wait การกำหนดลำดับสากลทำให้ cycle เกิดไม่ได้ตั้งแต่แรก |
| **มี retry สำหรับ error `40P01`** | deadlock เป็นเรื่องปกติในระบบที่มี concurrency ไม่ใช่บั๊ก DB จะฆ่าตัวหนึ่งทิ้งและตัวนั้นควรลองใหม่ |
| **เลือก isolation level ตามความเสี่ยงจริง** | SERIALIZABLE ปลอดภัยสุดแต่ throughput ตกและมี serialization failure ที่ต้อง retry — ใช้เฉพาะธุรกรรมการเงิน |

### 2.3 Query & Connection

| Practice | เหตุผล |
|---|---|
| **สร้าง index บนคอลัมน์ที่ใช้ใน WHERE/JOIN/ORDER BY** | ไม่มี index = full table scan; ตาราง 10 ล้านแถวต่างกันระหว่าง 2ms กับ 8s |
| **composite index เรียงตาม selectivity และ query pattern** | index `(authorId, createdAt)` ใช้กับ query ที่กรอง `authorId` ได้ แต่ query ที่กรอง `createdAt` อย่างเดียวใช้ไม่ได้ (left-most prefix rule) |
| **`select: [...]` เอาเฉพาะคอลัมน์ที่ใช้** | ลด I/O, ลด network payload, และเปิดโอกาสให้ DB ใช้ index-only scan |
| **pagination เสมอสำหรับ list endpoint** | `find()` เปล่า ๆ บนตารางที่โต = OOM ของทั้ง process |
| **แก้ N+1 ด้วย `relations`** | 1 JOIN แทน N+1 round trip — บน list 100 แถว คือ 101 query ลดเหลือ 1 |
| **ตั้ง connection pool ให้สอดคล้องกับ `max_connections` ของ DB** | จำนวน connection รวม = instance × pool size ถ้าเกิน DB จะปฏิเสธ connection ทั้งระบบ (ดู Backend06) |
| **map PostgreSQL error code เป็น HTTP status** | `23505` → 409, `23503`/`23502`/`23514` → 400 — client แก้ปัญหาตัวเองได้ แทนที่จะเห็น 500 ลอย ๆ |

---

## 3. What to Concern (จุดที่ต้องระวัง)

1. **`synchronize: true` คือความเสี่ยงอันดับหนึ่งของบทนี้** — สไลด์เตือนไว้สองครั้ง และควรเตือนซ้ำอีก: ถ้ามันหลุดเข้า production คุณเสียข้อมูล ไม่ใช่แค่ downtime ป้องกันด้วยการอ่านจาก env และมี guard ว่า `NODE_ENV === 'production'` แล้วบังคับ false เสมอ
2. **Migration ที่ล็อกตาราง** — `ALTER TABLE ... ADD COLUMN NOT NULL DEFAULT x` บน PostgreSQL เวอร์ชันเก่า จะ rewrite ทั้งตารางและถือ `ACCESS EXCLUSIVE` lock → API ค้างหมดระหว่างนั้น รูปแบบปลอดภัยคือ: เพิ่มคอลัมน์เป็น nullable → backfill เป็น batch → ค่อยเติม constraint
3. **`onDelete: 'CASCADE'` เป็นดาบสองคม** — ลบ user คนเดียวอาจลบ post/comment เป็นแสนแถวโดยไม่มีใครรู้ตัว และเป็น operation ที่ rollback ไม่ได้หลัง commit พิจารณา soft delete หรือ `RESTRICT` สำหรับข้อมูลสำคัญ
4. **Optimistic lock แบบที่สไลด์เขียนยังมี race อยู่** — ดู §8 Errata ข้อ 1 นี่คือจุดที่คนพลาดกันมากที่สุด
5. **Pessimistic lock ไม่ได้กัน "double booking" ถ้าลืมอยู่ใน transaction เดียวกัน** — lock ถูกปล่อยตอน COMMIT ถ้าอ่านนอก transaction แล้วเขียนใน transaction lock ไม่มีผล
6. **Long transaction ทำให้ connection pool หมด** — 20 request ที่เปิด transaction ค้างพร้อมกัน บน pool size 20 = request ที่ 21 รอจนกว่าจะ timeout ทั้งที่ DB ยังว่าง
7. **Eager loading แก้ N+1 แต่สร้างปัญหาใหม่** — `relations: ['posts', 'posts.comments']` บน user ที่มี 500 post × 20 comment = cartesian product ที่ดึงข้อมูลซ้ำมหาศาล บางกรณีการยิง 2 query แยกแล้ว map ในแอป (`DataLoader` pattern) เร็วกว่า
8. **ORM ซ่อน SQL ไว้** — คุณอาจเขียนโค้ดที่ดูดี แต่ generate SQL ที่แย่มาก ต้องเปิด `logging: true` ใน dev และ `EXPLAIN ANALYZE` query ที่ช้า
9. **Migration กับ zero-downtime deploy ขัดกัน** — ถ้า migration ลบคอลัมน์ แต่ instance เก่ายังรันอยู่และยังอ่านคอลัมน์นั้น → 500 ต้องใช้ **expand-and-contract**: เพิ่มก่อน → deploy โค้ดที่ใช้ทั้งเก่าและใหม่ → ค่อยลบใน release ถัดไป

---

## 4. Performance

| จุด | ผลกระทบ | คำแนะนำ |
|---|---|---|
| **Index** | จาก O(n) เป็น O(log n) | index บนทุกคอลัมน์ที่ใช้กรอง/join/เรียง — แต่ไม่ใช่ทุกคอลัมน์ (index ทำให้ write ช้าลงและกินพื้นที่) |
| **N+1** | 101 round trip → 1 | `relations` หรือ query builder JOIN; ตรวจด้วย SQL log ว่ามี query ซ้ำแบบเดียวกันรัว ๆ ไหม |
| **`select`** | ลด I/O + network | ระบุคอลัมน์เสมอสำหรับ list ขนาดใหญ่ |
| **Pagination** | กัน OOM และ latency พุ่ง | `skip/take` สำหรับหน้าแรก ๆ; ถ้า offset ลึกมาก (`skip: 100000`) ให้ใช้ **keyset/cursor pagination** เพราะ OFFSET ยังต้องอ่านและทิ้งแถวก่อนหน้าทั้งหมด |
| **Connection pool** | เล็กไป = คิว, ใหญ่ไป = DB ล้ม | สูตรในสไลด์ `(core × 2) + spindle`; dev ~10, prod 20–50, high traffic 50–100 **แต่ต้องคูณจำนวน instance แล้วไม่เกิน `max_connections`** |
| **Isolation level** | SERIALIZABLE ตัด throughput ลงชัดเจน | ใช้ READ COMMITTED เป็นค่าเริ่มต้น ยกระดับเฉพาะจุดที่จำเป็น |
| **Lock contention** | ทำให้ p99 พุ่งแม้ average ยังดูดี | วัด p95/p99 ไม่ใช่ average; ลดขอบเขตและเวลาที่ถือ lock |

**เครื่องมือที่ควรมี:** `EXPLAIN ANALYZE`, `pg_stat_statements` (หา query ที่ mean_exec_time สูง — สไลด์ Backend06 แนะนำไว้), และ slow query log

---

## 5. Pros & Cons

### ORM (TypeORM)
| Pros | Cons |
|---|---|
| type safety + auto-complete + refactor ตามได้ | abstraction leak — ต้องรู้ SQL อยู่ดีเมื่อ tuning |
| ไม่ต้องต่อ SQL string เอง → กัน SQL injection ระดับหนึ่ง | generate SQL ที่ไม่เหมาะสมได้ง่าย (N+1, cartesian join) |
| migration + entity + repository อยู่ในระบบเดียว | performance overhead และ memory จากการ hydrate object |
| เปลี่ยน DB engine ได้ (ในทางทฤษฎี) | ในทางปฏิบัติแทบไม่มีใครเปลี่ยน และ feature เฉพาะ DB ใช้ไม่ได้เต็มที่ |

### Pessimistic vs Optimistic Locking
| | Pessimistic | Optimistic |
|---|---|---|
| **Pros** | กันชนได้แน่นอน, เขียน logic ง่าย | ไม่มี DB lock, scale ดี, เหมาะกับ REST/ผู้ใช้แก้ฟอร์มนาน |
| **Cons** | ถือ lock = คนอื่นรอ, เสี่ยง deadlock, ไม่เหมาะกับ user session ยาว | ต้องมี logic จัดการ conflict + UX บอกผู้ใช้ให้ refresh, ถ้าชนบ่อยจะ retry ไม่จบ |
| **ใช้เมื่อ** | contention สูง, critical update (สต็อก, ที่นั่ง, ยอดเงิน) | contention ต่ำ, ผู้ใช้แก้เอกสารนาน |

---

## 6. ✅ Should Do / ❌ Should Not Do

### ✅ ควรทำ
| ทำ | เพราะ |
|---|---|
| `synchronize: false` + migration ทุก environment | ป้องกันข้อมูลหายและได้ schema history |
| เขียน `down()` ให้ทุก migration และทดสอบ revert จริง | rollback ตอนกลางคืนได้ |
| transaction สั้น, ใช้ `manager` ที่ได้รับมา | ลด lock time และรับประกันว่าทุกคำสั่งอยู่ใน transaction จริง |
| ล็อกตามลำดับเดียวกันเสมอ + retry `40P01` | กัน deadlock และฟื้นตัวเองได้ |
| index + `select` + pagination + `relations` | 4 อย่างนี้แก้ปัญหา performance ของ DB ได้เกินครึ่ง |
| map error code → HTTP status | client แก้ปัญหาเองได้ ไม่ต้องเดาจาก 500 |
| ตั้ง pool size โดยคิดจากจำนวน instance | กัน "too many connections" ที่ล้มทั้งระบบ |
| expand-and-contract สำหรับ schema change ที่ breaking | deploy ได้โดยไม่ต้อง downtime |

### ❌ ไม่ควรทำ
| อย่าทำ | เพราะ |
|---|---|
| `synchronize: true` ใน production | ลบตาราง/คอลัมน์ได้จริง ข้อมูลหายถาวร |
| แก้ migration ที่ deploy ไปแล้ว | schema drift ระหว่าง environment |
| ข้าม `down()` | rollback ไม่ได้เมื่อจำเป็นที่สุด |
| เรียก API/ส่งอีเมล/charge บัตรใน transaction | ถือ lock นาน + rollback สิ่งที่ทำไปแล้วข้างนอกไม่ได้ |
| ใช้ `this.repo` ข้างใน transaction callback | คำสั่งนั้นหลุดออกนอก transaction เงียบ ๆ |
| ซ้อน transaction โดยไม่จำเป็น | ไม่ได้ประโยชน์ และทำให้ semantics ของ rollback สับสน |
| ประมวลผลหนักขณะถือ lock | คนอื่นรอทั้งแถว |
| `find()` เปล่า ๆ บนตารางที่โตไม่จำกัด | OOM |
| ล็อกคนละลำดับในแต่ละ service | deadlock รอวันเกิด |

---

## 7. Recommendation (ลำดับลงมือจริง)

1. ตั้ง `data-source.ts` + npm scripts (`migration:create/generate/run/revert/show`) และ **บังคับ `synchronize: false`**
2. Migration แรก = สร้าง schema ทั้งหมด (อย่าใช้ `synchronize` แม้แต่ครั้งเดียวใน dev ที่แชร์กัน)
3. ใส่ index ตั้งแต่ migration แรกสำหรับคอลัมน์ที่รู้แน่ว่าจะกรอง (email, foreign key, created_at)
4. ระบุจุดที่มี "อ่าน-ตรวจ-เขียน" ทั้งหมดในระบบ (สต็อก, ที่นั่ง, ยอดเงิน, quota) → หุ้มด้วย transaction + lock
5. เพิ่ม retry wrapper สำหรับ `40P01` ที่ระดับ service
6. เปิด SQL logging ใน dev, ตั้ง `pg_stat_statements` ใน staging/prod, ตรวจ top-10 slow query ทุก sprint
7. คำนวณ `instances × poolSize ≤ max_connections × 0.8` แล้วตั้งค่าให้ตรง
8. ใน CI: รัน migration บน DB เปล่า → รัน integration test → รัน `migration:revert` เพื่อพิสูจน์ว่า `down()` ใช้ได้จริง

---

## 8. ⚠️ Errata / จุดที่สไลด์เขียนไว้ต้องระวัง

1. **ตัวอย่าง Optimistic Locking ในสไลด์ 30 ยังมี race condition อยู่**
   สไลด์เขียน `findOne()` → เทียบ `doc.version !== expectedVersion` เอง → `save()` แต่ **ระหว่างการเทียบกับการ save ยังมีช่องว่างให้คนอื่นแทรกได้** (TOCTOU) การเช็ค version ด้วยมือแบบนี้ไม่ใช่ optimistic locking จริง
   วิธีที่ถูกต้องคือปล่อยให้ TypeORM ตรวจเองผ่าน `@VersionColumn` แล้วดัก `OptimisticLockVersionMismatchError` (แบบสไลด์ 28) หรือใช้ conditional update แล้วเช็คจำนวนแถวที่ถูกแก้:
   ```ts
   const r = await repo.update({ id, version: expectedVersion }, { content });
   if (r.affected === 0) throw new ConflictException('Document was modified');
   ```
2. **API ของ `findOne` — บทนี้เขียนถูกแล้ว แต่บทอื่นไม่**
   Backend03 ใช้ `findOne({ where: { id } })` ซึ่งเป็นรูปแบบที่ถูกต้องของ **TypeORM 0.3+** อย่างสม่ำเสมอทุกสไลด์
   แต่ให้ระวังเมื่ออ่านบทถัดไป: **สไลด์ Backend04 ใช้ `this.userRepo.findOne(id)` ซึ่งเป็น API ของ TypeORM 0.2 ที่ถูกถอดออกแล้ว** — ยึดแบบ `where` ของบทนี้เป็นมาตรฐาน
3. **ตัวอย่าง bank transfer ใช้ `manager.debit()` / `manager.credit()`** ซึ่งไม่มีอยู่จริงใน `EntityManager` — เป็น pseudo-code เพื่ออธิบายแนวคิด อย่า copy ไปใช้
4. **สไลด์ Transaction Best Practices บอก "Don't nest unnecessarily"** — ควรเสริมว่า TypeORM **ไม่รองรับ savepoint แบบ nested transaction จริง** การเรียก `dataSource.transaction()` ซ้อนกันจะได้ transaction ใหม่จาก connection คนละตัว ซึ่งอาจ deadlock กับตัวนอกเอง
5. **Test setup ใช้ `synchronize: true, dropSchema: true`** — สะดวกจริง แต่แปลว่า **test ไม่ได้ทดสอบ migration ของคุณเลย** จะมีกรณีที่ test เขียวแต่ production migrate ไม่ผ่าน แนะนำให้ integration test รันผ่าน migration จริง
6. **สูตร pool size `(core_count * 2) + effective_spindle_count`** เป็นสูตรของ **DB server** ไม่ใช่ของ app instance และไม่ได้คิดเรื่อง multi-instance ต้องอ่านคู่กับ Backend06 (`instances × poolSize`) เสมอ
7. **`await sleep(100)` ใน deadlock retry เป็น fixed delay** — ควรใช้ exponential backoff + jitter เหมือน Backend05 ไม่งั้น transaction ที่ชนกันจะกลับมาชนกันซ้ำที่จังหวะเดิม
8. **สไลด์ระบุ `pessimistic_write` ว่า "Blocks both reads and writes"** — ไม่ตรงกับ PostgreSQL จริง `SELECT ... FOR UPDATE` **ไม่บล็อก plain `SELECT`** (MVCC ยังอ่านเวอร์ชันเก่าได้) มันบล็อกเฉพาะ `FOR UPDATE`/`FOR SHARE`/UPDATE/DELETE

---

## 9. Checklist ก่อน merge

- [ ] `synchronize: false` และมี guard ป้องกันไม่ให้เป็น true ตอน production
- [ ] ทุก migration มี `down()` และผ่านการทดสอบ revert
- [ ] ไม่มีการแก้ไฟล์ migration ที่เคย deploy แล้ว
- [ ] ทุก transaction ใช้ `manager` ที่ได้รับมา และไม่มี external call ข้างใน
- [ ] จุดที่มี read-check-write ถูกหุ้มด้วย transaction + lock ที่เหมาะสม
- [ ] มี retry สำหรับ deadlock (`40P01`) พร้อม backoff + jitter
- [ ] endpoint ที่คืน list มี pagination และมี index รองรับ order/filter
- [ ] ไม่มี N+1 (ตรวจจาก SQL log)
- [ ] `instances × poolSize` ไม่เกิน `max_connections`
- [ ] error code ของ DB ถูก map เป็น HTTP status ที่ถูกต้อง
