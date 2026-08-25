# Backend 04 — Redis: Caching & Atomic Operations

> ที่มา: `Backend04 - Redis.pdf`
> ขอบเขต: Performance bottleneck · Redis data structures · Caching strategies · Invalidation · Stampede/Avalanche · Atomic ops · Distributed lock · Eviction policy

---

## 1. สรุปสาระสำคัญ (Core Concepts)

| หัวข้อ | ใจความ |
|---|---|
| **Cache hierarchy** | CPU (ns) → RAM (μs) → SSD (ms) → Network/DB (10–100ms) — Redis อยู่ชั้น RAM |
| **Hit ratio** | `hits / (hits + misses)` — ตัวชี้วัดหลัก เป้าหมาย > 80% |
| **ควร cache เมื่อ** | read-heavy, query แพง, ข้อมูลค่อนข้างนิ่ง, endpoint ที่ traffic สูง |
| **ไม่ควร cache เมื่อ** | write-heavy, ข้อมูลเปลี่ยนเร็วมาก, ต้องการ consistency เข้มงวด |
| **Data structures** | STRING (session/token) · HASH (object) · LIST (feed) · SET (unique) · SORTED SET (leaderboard) |
| **Redis เป็น single-threaded** | ไม่มี lock overhead, performance คาดเดาได้ — แต่ **คำสั่งเดียวที่ช้าบล็อกทุกคน** |
| **Persistence** | RDB (snapshot ตามช่วงเวลา) / AOF (log ทุก write) — optional |
| **Cache-aside (lazy loading)** | อ่าน cache → miss → อ่าน DB → เขียน cache — ค่าเริ่มต้นสำหรับ read-heavy |
| **Write-through** | เขียน DB แล้วเขียน cache ทันที — cache สดเสมอ แลกกับ write latency |
| **Write-behind** | เขียน cache แล้ว flush ลง DB แบบ async — เร็วสุด แต่ **ข้อมูลหายได้ถ้า cache ล่ม** |
| **Stampede** | key ยอดนิยมหมดอายุ → ทุก request ทะลุไป DB พร้อมกัน |
| **Avalanche** | key จำนวนมากหมดอายุพร้อมกัน → DB โดนถล่ม |
| **Atomic commands** | `INCR`/`DECR`/`INCRBY`/`SETNX`/`GETSET`/`MULTI-EXEC` — แก้ปัญหา read-modify-write ที่ไม่ atomic |
| **Distributed lock** | `SET key token NX EX ttl` + ปลดล็อกด้วย Lua script ที่เทียบ token ก่อนลบ |

---

## 2. Best Practices (พร้อมเหตุผล)

### 2.1 Caching

| Practice | เหตุผล |
|---|---|
| **ตั้ง TTL ทุก key เสมอ** | key ที่ไม่มี TTL คือ memory leak ที่จะโตจนชน `maxmemory` แล้วทำให้ทั้งระบบเริ่ม evict สิ่งที่ยังต้องใช้ |
| **TTL ตามความถี่ที่ข้อมูลเปลี่ยน** (30s–5m / 10m–1h / 1h–24h) | TTL ยาวไป = ผู้ใช้เห็นข้อมูลเก่า, สั้นไป = hit ratio ตกและ DB โดนหนัก |
| **cache failure ต้องไม่ทำให้ request พัง** | Redis เป็น optimization ไม่ใช่ source of truth ถ้า Redis ล่มแล้วแอปล่มตาม แปลว่าคุณเพิ่ม single point of failure เข้าไปแทนที่จะเพิ่มความเร็ว |
| **key naming: `{namespace}:{entity}:{id}:{field}`** | อ่านออก, ค้นด้วย pattern ได้, กันชนกันข้าม service/multi-tenant |
| **invalidate cache ที่เกี่ยวข้องทั้งหมดตอน write** | dependency chain — แก้ user 1 คน อาจต้องล้าง `user:1`, `user:1:posts`, `users:list` ถ้าลืมตัวใดตัวหนึ่ง ผู้ใช้จะเห็นข้อมูลค้าง |
| **ใส่ jitter ให้ TTL** (`base + random`) | กัน avalanche — ถ้า warm cache 1,000 key พร้อมกันด้วย TTL เท่ากัน มันจะหมดอายุพร้อมกันอีกในอีก 5 นาที |
| **ใช้ lock หรือ probabilistic early refresh กับ hot key** | กัน stampede — request แรกเท่านั้นที่ไป DB ที่เหลือรอหรือใช้ค่าเก่า |
| **cache เฉพาะ hot data** | RAM แพงกว่า disk มาก; cache ทุกอย่าง = จ่ายแพงเพื่อ hit ratio ที่ไม่ดีขึ้น |

### 2.2 Atomicity & Locking

| Practice | เหตุผล |
|---|---|
| **ใช้ `INCR` แทน get→+1→set** | read-modify-write จากหลาย instance ทำให้ยอด "หาย" (lost update) — `INCR` เป็น atomic ในตัวเพราะ Redis single-threaded |
| **lock ต้องมี TTL เสมอ** | ถ้า worker crash ระหว่างถือ lock และ lock ไม่หมดอายุ resource นั้นจะถูกล็อกตลอดกาล (deadlock ถาวร) |
| **lock ต้องมี unique token ต่อผู้ถือ** | ป้องกันการที่ worker A (ซึ่ง lock หมดอายุไปแล้ว) มาลบ lock ของ worker B |
| **ปลดล็อกด้วย Lua script (get + del ใน operation เดียว)** | ถ้าแยกเป็น 2 คำสั่ง จะมีช่องว่างระหว่าง `GET` กับ `DEL` ที่ lock อาจหมดอายุและถูกคนอื่นคว้าไป — แล้วเราไปลบ lock ของเขา |
| **ใช้ `try...finally` ปลดล็อกเสมอ** | exception ระหว่างงานต้องไม่ทำให้ lock ค้าง |
| **งานยาวต้องมี lock renewal (heartbeat)** | ถ้างานใช้เวลานานกว่า TTL จะมี worker ตัวที่สองเข้ามาทำงานซ้อน |
| **critical section ต้อง idempotent อยู่ดี** | ถึงจะมี lock ก็มีหน้าต่างที่ผิดพลาดได้ (clock drift, GC pause) — ตัวอย่างในสไลด์เช็ค `status === 'COMPLETED'` ก่อน charge ซ้ำ ซึ่งถูกต้องมาก |

### 2.3 Operations

| Practice | เหตุผล |
|---|---|
| **ตั้ง `maxmemory` + `maxmemory-policy`** | ถ้าไม่ตั้ง Redis จะกิน RAM จนถูก OOM-kill ทั้ง process = cache หายหมดทันที |
| **`allkeys-lru` สำหรับ cache ล้วน / `volatile-lru` สำหรับใช้ผสม / `noeviction` สำหรับข้อมูลสำคัญ** | นโยบายต้องตรงกับความหมายของข้อมูล — ถ้าใช้ Redis เก็บ queue ด้วยแล้วตั้ง `allkeys-lru` งานในคิวจะถูก evict ทิ้ง |
| **monitor hit ratio + memory + slowlog** | hit ratio ต่ำ = cache ไม่คุ้ม; memory ใกล้เต็ม = ใกล้ evict; slowlog = มีคำสั่งบล็อก event loop |
| **connection pooling / reuse client** | สร้าง connection ใหม่ทุก request คือ overhead ที่ทำลายเหตุผลของการใช้ cache |

---

## 3. What to Concern (จุดที่ต้องระวัง)

1. **`KEYS` บล็อก Redis ทั้ง instance** — Redis single-threaded, `KEYS pattern` เป็น O(N) บน keyspace ทั้งหมด บน DB ที่มี 5 ล้าน key คำสั่งเดียวหยุดให้บริการทุกคนหลายวินาที **ใช้ `SCAN` เสมอ** (สไลด์เตือนไว้ในหมายเหตุแต่โค้ดตัวอย่างยังใช้ `keys()` — ดู Errata)
2. **Cache-DB inconsistency เป็นเรื่องที่หลีกเลี่ยงไม่ได้ ทำได้แค่จำกัดหน้าต่าง** — ไม่ว่าจะ invalidate ก่อนหรือหลัง update DB ก็มี interleaving ที่ทำให้ cache ค้างค่าเก่า TTL คือตาข่ายนิรภัยชั้นสุดท้าย **ห้ามพึ่ง invalidation อย่างเดียว**
3. **Delete-then-update vs update-then-delete** — สไลด์ใช้ "update DB แล้วค่อย `del` cache" ซึ่งดีกว่า "del ก่อน update" แต่ยังมีเคสที่ read แทรกระหว่างกลางแล้วเขียนค่าเก่ากลับเข้า cache รูปแบบที่ทนทานกว่าคือ delete + TTL สั้น หรือ delayed double-delete
4. **Redis เป็น single point of failure ถ้าออกแบบผิด** — ถ้า session อยู่ใน Redis อย่างเดียวและ Redis ล่ม ผู้ใช้ทั้งระบบหลุด login ต้องมี replication/Sentinel/Cluster (สไลด์แตะเรื่อง Redlock ไว้เท่านั้น)
5. **Distributed lock ไม่ใช่การรับประกันความถูกต้อง** — ระหว่าง worker เช็ค lock กับตอนทำงานจริง อาจเกิด GC pause / clock drift ทำให้ lock หมดอายุโดยที่ worker ไม่รู้ตัว **Redlock เองก็ถูกวิจารณ์ทางวิชาการว่าไม่ปลอดภัยสำหรับ correctness** ใช้ lock เพื่อ "ลดงานซ้ำ" ได้ แต่ correctness ต้องมาจาก idempotency + unique constraint ใน DB
6. **Over-caching** — cache ข้อมูลที่แทบไม่มีใครอ่านซ้ำ = จ่าย RAM แพง ๆ เพื่อ hit ratio 5%
7. **Large value** — ค่ามากกว่า 1MB ทำให้ network transfer ช้าและกิน memory; แตกเป็น key ย่อยหรือบีบอัด
8. **Cache ทำให้ debug ยากขึ้น** — "ทำไมยังเห็นข้อมูลเก่า" กลายเป็นคำถามประจำวัน ต้องมี tooling ดู TTL/ค่าใน cache และมีวิธีล้าง cache ต่อ key ได้จาก admin
9. **การเก็บข้อมูลส่วนบุคคลใน cache** — key ที่ไม่มี namespace ต่อ tenant เสี่ยงข้อมูลข้ามผู้ใช้ และ Redis มักไม่ได้เข้ารหัส at-rest โดย default

---

## 4. Performance

| จุด | ตัวเลขอ้างอิงจากสไลด์ | หมายเหตุ |
|---|---|---|
| **Latency** | DB ~100ms → Cache ~1ms (เร็วขึ้น ~100x) | เฉพาะ path ที่ hit; miss จะช้ากว่าเดิมเล็กน้อยเพราะเพิ่ม round trip |
| **Hit ratio เป้าหมาย** | > 80% | ต่ำกว่านี้ให้ทบทวนว่า TTL สั้นไป หรือ cache ผิดของ |
| **Single-threaded** | ไม่มี lock overhead | แลกกับ: คำสั่ง O(N) ตัวเดียวหยุดทั้ง instance |
| **Memory** | จำกัดด้วย RAM (GB) vs disk (TB) | RAM แพงกว่า/GB มาก → cache เฉพาะ hot data |
| **Stampede** | 1,000 concurrent query ยิง DB พร้อมกัน | แก้ด้วย lock / early refresh / background refresh |
| **Avalanche** | key จำนวนมากหมดพร้อมกัน | แก้ด้วย TTL jitter + stale fallback |

**สิ่งที่ควรวัดจริง:** `INFO stats` (`keyspace_hits`/`keyspace_misses`), `INFO memory` (`used_memory`, `evicted_keys`), `SLOWLOG GET 10`, และ p95/p99 latency ของ endpoint ก่อน/หลังใส่ cache — **ถ้า p99 ไม่ดีขึ้น แปลว่า cache ยังไม่ได้แก้ bottleneck จริง**

---

## 5. Pros & Cons

### Redis Cache
| Pros | Cons |
|---|---|
| latency ระดับ sub-millisecond | RAM แพง ความจุจำกัด |
| ลดภาระ DB อย่างมีนัยสำคัญ | เพิ่ม component ที่ต้องดูแล/monitor/ทำ HA |
| atomic operation ในตัว → แก้ race ได้โดยไม่ต้องพึ่ง DB lock | consistency เป็น eventual เสมอ |
| data structure หลากหลาย (leaderboard, rate limit, session) | invalidation เป็นปัญหาที่แก้ยากโดยธรรมชาติ |
| pub/sub + queue ใช้ต่อยอดได้ (Backend05) | single-threaded → คำสั่งช้าตัวเดียวกระทบทุกคน |

### Caching Strategies
| | Cache-Aside | Write-Through | Write-Behind |
|---|---|---|---|
| **Pros** | เรียบง่าย, cache เฉพาะที่ถูกใช้จริง, cache ล่มก็ยังทำงานได้ | cache สดหลัง write เสมอ, ไม่มี stale read ทันทีหลัง update | write latency ต่ำสุด, รองรับ write throughput สูง |
| **Cons** | request แรกช้าเสมอ (cold), เสี่ยง stampede | write ช้าลง (DB + cache), cache ข้อมูลที่อาจไม่มีใครอ่าน | **ข้อมูลหายถ้า cache ล่มก่อน flush**, ต้องมี worker |
| **ใช้กับ** | read-heavy ทั่วไป (ค่าเริ่มต้น) | ต้องการ consistency หลัง write | counter/analytics ที่ยอมเสียได้บ้าง |

---

## 6. ✅ Should Do / ❌ Should Not Do

### ✅ ควรทำ
| ทำ | เพราะ |
|---|---|
| ตั้ง TTL ทุก key + ใส่ jitter | กัน memory leak และกัน avalanche |
| ครอบ cache ด้วย try/catch แล้ว fallback ไป DB | cache ล่มต้องไม่ทำให้ระบบล่ม |
| ใช้ key naming convention แบบ namespace | ค้น/ลบ/แยก tenant ได้ และกัน key ชนกัน |
| ใช้ `SCAN` แทน `KEYS` | ไม่บล็อก event loop ของ Redis |
| ใช้ `INCR`/`SETNX` แทน read-modify-write | atomic จริงและไม่มี lost update |
| lock ต้องมี TTL + unique token + ปลดด้วย Lua | กัน deadlock ถาวร และกันการปลด lock ของคนอื่น |
| `try...finally` รอบ critical section | lock ไม่ค้างเมื่อเกิด exception |
| ตั้ง `maxmemory` + eviction policy ที่ตรงกับการใช้งาน | ควบคุมพฤติกรรมตอน RAM เต็มแทนที่จะให้ระบบตัดสินใจแทน |
| monitor hit ratio, memory, evicted_keys, slowlog | รู้ก่อนที่ผู้ใช้จะรู้ |
| ทำให้ critical section idempotent แม้จะมี lock | lock เป็น best-effort ไม่ใช่การรับประกัน |

### ❌ ไม่ควรทำ
| อย่าทำ | เพราะ |
|---|---|
| ใช้ Redis เป็น primary datastore | ออกแบบมาเป็น cache; ข้อมูลสำคัญต้องอยู่ใน DB ที่ durable |
| `KEYS *` ใน production | บล็อก Redis ทั้ง instance |
| เก็บ value > 1MB | network + memory ไม่คุ้ม |
| ปล่อย key ไม่มี TTL | memory โตไม่หยุดจนเริ่ม evict ของที่ยังต้องใช้ |
| ให้ cache error โยนออกไปถึงผู้ใช้ | เปลี่ยน optimization เป็น single point of failure |
| พึ่ง invalidation อย่างเดียวโดยไม่มี TTL | พลาดสักจุดคือข้อมูลค้างถาวร |
| ใช้ TTL เท่ากันทั้งหมดตอน warm cache | avalanche รอบต่อไปในอีก TTL วินาที |
| ใช้ distributed lock แทน DB constraint สำหรับความถูกต้อง | lock อาจหมดอายุกลางคัน; ความถูกต้องต้องมาจาก unique constraint/idempotency |
| get→+1→set สำหรับ counter | lost update ทันทีที่มีมากกว่า 1 instance |

---

## 7. Recommendation (ลำดับลงมือจริง)

1. **วัดก่อน** — หา endpoint ที่ p95 แย่ที่สุดและ query ที่แพงที่สุด (`pg_stat_statements` จาก Backend03) อย่าใส่ cache แบบเดาสุ่ม
2. เริ่มด้วย **cache-aside + TTL สั้น (60–300s)** บน endpoint อ่านอย่างเดียวที่ traffic สูง
3. วาง **key convention** และ helper กลาง (`cacheKey.user(id)`) ตั้งแต่วันแรก อย่าให้แต่ละคนตั้งชื่อเอง
4. หุ้มทุกการเรียก cache ด้วย try/catch + fallback DB
5. เพิ่ม **invalidation ตอน write** สำหรับ key ที่เกี่ยวข้องทั้ง chain
6. เพิ่ม **jitter** ให้ TTL และ **lock/early-refresh** เฉพาะ key ที่ร้อนจริง (อย่าทำทุก key — ซับซ้อนเกินจำเป็น)
7. ตั้ง `maxmemory` + `allkeys-lru` และเปิด metric hit ratio บน dashboard
8. เมื่อมี counter/quota/rate limit ให้ใช้ `INCR` + `EXPIRE` ไม่ใช่ read-modify-write
9. ใช้ distributed lock **เฉพาะ** งานที่ทำซ้ำแล้วเสียหาย (charge เงิน, ส่งอีเมลจำนวนมาก) และคู่กับ idempotency check ใน DB เสมอ

---

## 8. ⚠️ Errata / จุดที่สไลด์เขียนไว้ต้องระวัง

1. **สไลด์ Cache Invalidation Patterns ใช้ `this.redis.keys(pattern)` ทั้งที่ comment เตือนเองว่า "KEYS is O(N), use SCAN in production"** — โค้ดตัวอย่างขัดกับคำเตือนของตัวเอง ถ้า copy ไปใช้จะบล็อก Redis จริง ให้เปลี่ยนเป็น `scanStream` หรือเก็บ index ของ key ที่เกี่ยวข้องไว้ใน SET แล้วลบจากรายการนั้นแทน
2. **`this.cache.set(lockKey, '1', { ttl: 10, nx: true })` ใช้ไม่ได้กับ `cache-manager`** — `Cache` interface ของ `@nestjs/cache-manager` **ไม่รองรับ `nx`** ต้องใช้ raw client (`ioredis`) `redis.set(key, token, 'EX', 10, 'NX')` เหมือนที่สไลด์ distributed lock ทำถูกไว้แล้ว
3. **`await this.cache.ttl(key)` ในตัวอย่าง probabilistic early expiration ก็ไม่มีใน `cache-manager`** — ต้องใช้ `redis.ttl(key)` จาก client โดยตรง
4. **Stampede solution ข้อ 1 ใช้ recursion `return this.getPopularPost()` แบบไม่มีขอบเขต** — ถ้า worker ที่ถือ lock ตายไป request ที่เหลือจะ recurse ซ้ำไม่จบจนกว่า lock TTL จะหมด และมีโอกาส stack overflow ควรเปลี่ยนเป็น loop ที่มี max retry + backoff และมี fallback ไปอ่าน DB ตรง ๆ เมื่อครบจำนวน
5. **การปลด lock ในตัวอย่าง stampede ไม่ได้เทียบ token** (`await this.cache.del(lockKey)` เฉย ๆ) — ขัดกับหลักที่สไลด์ distributed lock สอนไว้เอง มีสิทธิ์ลบ lock ของ request อื่น
6. **`finally { releaseLock(lockKey, token) }` ในตัวอย่าง PaymentService อ้าง `token` ที่ประกาศในบล็อกก่อนหน้า** — ถ้า `acquireLock` throw หรือ `token` เป็น null การเข้าถึงใน `finally` จะพลาด ต้องตรวจ `if (token)` ก่อนปลด
7. **สไลด์บอกว่า Redlock "N=5 recommended"** — ควรเสริมว่า Redlock ต้องเป็น **Redis instance ที่อิสระต่อกันจริง ๆ** (ไม่ใช่ primary + replica ของ cluster เดียวกัน) มิฉะนั้นการนับ majority ไม่มีความหมาย และ Redlock ยังเป็นที่ถกเถียงว่าไม่เหมาะกับงานที่ต้องการ correctness
8. **ตัวอย่าง cache-aside ครอบ `cache.set` ไว้ใน try เดียวกับ DB query** — ถ้า `cache.set` ล้มเหลว โค้ดจะไปยิง DB ซ้ำอีกครั้งใน catch (query เดียวกันสองรอบ) ควรแยก try/catch เฉพาะรอบการเรียก cache
9. **สไลด์ไม่ได้พูดถึง HA ของ Redis เลย** — ในสภาพแวดล้อมจริงที่ scale ออกหลาย instance (Backend06) Redis เดี่ยว ๆ คือ single point of failure ต้องวางแผน Sentinel หรือ managed Redis
10. **`const user = await this.userRepo.findOne(id)` ในสไลด์ Basic Cache Operations เป็น API ของ TypeORM 0.2 ที่ถูกถอดออกแล้ว**
    ตั้งแต่ **TypeORM 0.3 ต้องเป็น `findOne({ where: { id } })`** ซึ่งเป็นรูปแบบที่สไลด์ Backend03 ใช้ถูกต้องตลอดทั้งบท — จุดนี้ Backend04 เขียนย้อนกลับไปใช้ของเก่า

---

## 9. Checklist ก่อน merge

- [ ] ทุก key ที่เขียนมี TTL และ TTL มี jitter สำหรับงาน bulk/warm-up
- [ ] key ใช้ convention `{namespace}:{entity}:{id}` และมี helper กลาง
- [ ] ทุกการเรียก cache ถูกครอบด้วย try/catch และ fallback ไป DB
- [ ] ไม่มี `KEYS` ในโค้ด production (ใช้ `SCAN` หรือ index set)
- [ ] counter ทุกตัวใช้ `INCR`/`INCRBY` ไม่ใช่ get→set
- [ ] distributed lock มี TTL + unique token + ปลดด้วย Lua + `try/finally` + ตรวจ token ก่อนปลด
- [ ] critical section idempotent (มี unique constraint หรือ status check ใน DB รองรับ)
- [ ] ตั้ง `maxmemory` และ `maxmemory-policy` ที่ตรงกับการใช้งาน
- [ ] มี metric hit ratio / evicted_keys / used_memory บน dashboard
- [ ] มี invalidation ครบทั้ง dependency chain ของทุก write path
