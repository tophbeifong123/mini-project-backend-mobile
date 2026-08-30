# 🧹 รีวิว 6 agent (scrutinize + karpathy) → เก็บกวาดเฉพาะส่วนที่ปลอดภัย

> **วันที่**: 2026-08-30 (ต่อจาก [`handoff_30_08_2026_arch-doc-sync-and-compensation-guard-fix.md`](handoff_30_08_2026_arch-doc-sync-and-compensation-guard-fix.md))
> **แตะ `src/` ไหม**: ✅ แตะ 6 ไฟล์ — `build` / `test` ผ่านหมด (**5 suites / 49 tests**)
> **ยิง k6 ไหม**: ❌ **ไม่ได้ยิง — และไม่จำเป็นต้องยิง** ดูเหตุผลใน §5 (พิสูจน์ด้วย byte-compare ของ `dist/` แทน)

---

## 0. TL;DR

- `git pull` ตามหลัง 9 commits — ไฟล์บนดิสก์**ตรงกับ remote ทุก byte อยู่แล้ว** (SynologyDrive sync มาก่อน git) ไม่มีอะไรสูญหาย
- รีวิว 6 agent (3 `/scrutinize` + 3 `/karpathy-guidelines`) เจอของจริง **บั๊ก 2 ตัว · เอกสารเคลมเท็จ 2 จุด · ช่องโหว่สภาพแวดล้อมทดสอบ 2 ข้อ · โค้ดตาย ~205 บรรทัด**
- แก้ไปเฉพาะ **"กลุ่มสบายใจ"** — ไม่แตะ invariant §4, ไม่เข้าเงื่อนไข §8, ไม่ต้องยิง k6
- **ของที่เจอแล้วยังไม่แก้ 5 ข้อ บันทึกลง CLAUDE.md §0.1 แล้ว** — อ่านก่อนจะไปแก้ซ้ำ

---

## 1. 🔀 git pull — ไฟล์มาก่อน commit

`main` ตามหลัง `origin/main` 9 commits แต่ `git pull` ไม่ผ่าน เพราะมีไฟล์ค้าง 27 + untracked 16

**ก่อนแตะอะไร ตรวจก่อน**: เทียบทุกไฟล์กับ `origin/main` แล้วพบว่า **byte-identical ทั้งหมด** — SynologyDrive sync ไฟล์มาจากอีกเครื่องแล้ว แต่ git history ยังไม่มา จึงไม่มีอะไรจะเสีย

แก้ด้วย `git stash push -u` เป็นจุดกู้คืน แล้ว `git pull --ff-only` → `4ac37d6` → `352a938`

> 💡 **บทเรียน**: อาการ "pull ไม่ได้เพราะไฟล์ค้าง" บน repo ที่อยู่บน cloud sync **อย่าเพิ่ง stash/reset ทันที** — เทียบกับ remote ก่อน ส่วนใหญ่มันคือไฟล์ชุดเดียวกัน

---

## 2. 🔍 รอบที่ 1 — `/scrutinize` 3 agent

แบ่งไฟล์ไม่ให้ชนกัน: (1) write path + Lua (2) read path + auth + infra (3) observability + ops + tests

### 🔴 บั๊กที่ยังไม่แก้ — `orders.processor.ts:63-64`

```ts
const queryRunner = this.dataSource.createQueryRunner('master');
await queryRunner.connect();          // ← อยู่นอก try
await queryRunner.startTransaction(); // ← อยู่นอก try
let committed = false;
try {                                 // ← try เริ่มบรรทัด 67
```

`finally` ที่คืน query runner และบล็อก `isFinalAttempt → compensateOnce` (บรรทัด 125-133) **ไม่ครอบสองบรรทัดนี้**

ถ้า primary สะดุดจังหวะเปิด transaction → `process()` reject ทันที → **ไม่มีการชดเชยในทุก attempt** → สต็อก 1 หน่วยที่ `gatekeeper.lua` จองไว้หายถาวร → counter ค้างที่ 1, ออเดอร์ 49/50, **ตกเกณฑ์ §9.3 ข้อ 4**

**นี่คือ path เดียวในระบบที่หักสต็อกแล้วไม่มีทางชดเชยเลย** (ละเมิด invariant §4 ข้อ 6) · แก้ = ย้าย 2 บรรทัดเข้าไปใน `try` เท่านั้น (`safeRollback` เช็ค `isTransactionActive` อยู่แล้ว และ `release()` บน runner ที่ยังไม่ connect เป็น no-op)

**⚠️ ยังไม่แก้ในรอบนี้** เพราะเป็น write path → §7 ข้อ 5 บังคับให้ยิง k6 พิสูจน์ §9.3 ก่อน

### 🟠 ตัวนับ leak โกหก — `orders.processor.ts:126`

```ts
this.metrics.inc(Metric.STOCK_COMPENSATED);   // บวกก่อน
await this.redis.compensateOnce(...);          // แล้วค่อย await ที่ไม่มี try/catch
```

`STOCK_COMPENSATION_FAILURES` ถูกยิงจาก `orders.service.ts:261,280` **เท่านั้น — ฝั่ง worker ไม่เคยยิงเลย** ผลคือถ้าชดเชยฝั่ง worker ล้มเหลว จะถูกนับเป็น "สำเร็จ" และตัวนับ leak ยังเป็นศูนย์

รายงาน §3.8 เดิมบอกให้เฝ้าตัวนี้เพราะ "ถ้าไม่เป็นศูนย์แปลว่าสต็อกรั่วจริง" — **จริง แต่ไม่พอ · ค่าศูนย์เชื่อไม่ได้** (แก้ในรายงานแล้ว)

### 🟠 ช่องโหว่สภาพแวดล้อมทดสอบ (สำคัญวันยิงข้ามกลุ่ม)

| ปัญหา | หลักฐาน |
| :--- | :--- |
| **datastore เปิดทุก interface ไม่มีรหัสผ่าน** | `docker-compose.yml:46,102,145,171` publish PG 5432/5433 + Redis ทั้งคู่ · `redis-data.conf:10` = `protected-mode no` ไม่มี `requirepass` · ใครบน LAN ก็ `SET stock:flash_sale:p-1001 9999` ข้ามการป้องกันทั้ง 4 ชั้นได้ที่ source of truth |
| **Bull-Board = `admin`/`admin` hardcode** | ทั้ง 6 services เป็นสตริงตรง ๆ ไม่ใช่ `${VAR}` · `env.validation.ts:133,137` ตั้ง default `'admin'` ทำให้ `getOrThrow()` **ไม่มีวัน throw** · แก้ `.env` ไม่มีผลกับ container |

**วิธีแก้ที่ไม่กระทบ workflow**: ผูกพอร์ตกับ `127.0.0.1` (เช่น `127.0.0.1:6380:6379`) — คำสั่ง §9.3 และ `seed:redis` ยังรันจากโฮสต์ได้ปกติ มีแค่ `8080:80` ที่ต้องเปิดจริง

### ✅ ที่ตรวจแล้วแน่นดี (ไม่ต้องกลับไปตรวจซ้ำ)

- invariant §4 ข้อ **2, 3, 4, 7, 10** ผ่านครบ พร้อม `file:line`
- `isFinalAttempt` **ไม่มี off-by-one** — ตรวจเทียบกับเลขคณิต retry ในโค้ด `bullmq@6.2.2` จริง (`job.js:449`)
- `price` เป็น number · `remainingStock` ไม่ถูกแคช · ตาราง status code §3 ตรงหมด
- **`/admin` ทดสอบด้วย URL หลบ middleware 11 แบบ** (สลับพิมพ์ใหญ่-เล็ก, URL-encode, สแลชซ้อน, dot-segment) กับ Express 5.2.1 จริง — **ไม่มีแบบไหนเล็ดลอด** ปัญหาอยู่ที่รหัสผ่านกับพอร์ต ไม่ใช่วิธี mount

---

## 3. 🧠 รอบที่ 2 — `/karpathy-guidelines` 3 agent

### 🏆 ข้อค้นพบที่ดีที่สุดของทั้งเซสชัน — `redis.service.ts:322-368`

**ความซับซ้อนเป็นตัว *สร้าง* บั๊ก ไม่ใช่บั๊กที่บังเอิญอยู่ในนั้น**

โค้ดซ้อน rate limiter 3 ชั้น: leading branch + distributed `SET NX` throttle + trailing `setTimeout`

**ถ้าใช้กลไกเดียวจะไม่มีทางทิ้งงานเลย** — leading อย่างเดียวก็ flush ทันที, trailing อย่างเดียวก็จองเสมอ · เฉพาะการซ้อนกันเท่านั้นที่หลุด:

1. บรรทัด 327 ตั้ง `lastCatalogFlushAt = now` (ใช้โควตา local ไปแล้ว)
2. บรรทัด 328 ขอ throttle ไม่ได้ (instance อื่นถืออยู่)
3. บรรทัด 332 `return` — **ไม่ได้จองรอบ trailing**
4. instance ที่ชนะ throttle flush ไป**ก่อน**ที่ instance นี้จะ commit → การล้างของ instance นี้หายเฉย ๆ

เหลือ trailing timer อย่างเดียวก็จบ: **ลด ~40 บรรทัด และทำให้บั๊กเกิดไม่ได้เชิงโครงสร้าง** · กรณีแย่สุดคือ 6 flush/วินาทีทั้งคลัสเตอร์ ซึ่งไม่มีนัยกับ 1,500 rps

**⚠️ ยังไม่แก้** — เป็นนโยบาย cache ตาม §8 ต้องขออนุญาตก่อน

### Dashboard: ~1,100 จาก 1,300 บรรทัด คุ้มค่า

agent ให้คำตอบที่ไม่ปั้นข้อหา — **`insights.page.ts` 444 บรรทัดเป็นการตัดสินใจที่ถูก** เพราะข้อจำกัดที่หัวไฟล์เขียนไว้เอง (ห้าม CDN, ไม่มี build step, ไม่มี static asset route) ทำให้ CSS-only divs คือพื้นต่ำสุดแล้ว ไม่ใช่ของฟุ่มเฟือย

ที่ตายจริง ~205 บรรทัด: `/admin/metrics` (~117 — โค้ดเขียนเองว่าไม่มี Prometheus ในสแตก), `METRIC_LABELS` (25), บล็อกธีมมืด (13), tooltip (19), field ตาย (16)

### `/health/ready` — agent แย้งกลับ และมันถูก

สมมติฐานตั้งต้นคือ "ไม่มีใครใช้ = speculative code" แต่ agent เจอผู้ใช้จริง: **`bull-board.service.ts:83` มีเมนู "Readiness"** (+ `curl` ใน `README.md:91`, `loadtest/README.md:171`)

→ มันคือ **operator diagnostic ไม่ใช่ probe ของ LB** · ที่ speculative คือ **คอมเมนต์** ที่อ้างว่า nginx จะถอด instance ซึ่ง nginx OSS ทำไม่ได้เชิงโครงสร้าง (แก้แล้ว §4)

---

## 4. ✅ ที่แก้จริงในรอบนี้ ("กลุ่มสบายใจ")

เกณฑ์คัดเข้า: ไม่แตะ invariant §4 · ไม่เข้า §8 · ไม่แตะ write path (จึงไม่ต้องยิง k6) · พิสูจน์ว่าตายจริงด้วย grep ไม่ใช่เดา

| งาน | ไฟล์ | ผล |
| :--- | :--- | :--- |
| **บั๊ก DOM leak** | `insights.page.ts` | `insertAdjacentHTML('afterend')` ยิงทุก 3 วิ แทรก div เป็น**พี่น้อง**ของ `#worker-bars` ขณะที่ `bars()` ล้างแค่**ลูก** → **1,200 div/ชม.** · เปลี่ยนเป็น `#worker-avg` + `textContent` |
| ลบ `METRIC_LABELS` | `metrics.constants.ts` | −26 บรรทัด · **0 importer** · หน้าเว็บ hardcode label ไทยเอง · ดริฟต์ไปแล้ว (`Metric` 24 ตัว, map 22) |
| ลบบล็อก CSS ที่เข้าไม่ถึง | `insights.page.ts` | −13 บรรทัด · `:root[data-theme="dark"]` — **ไม่มีอะไรตั้ง `data-theme` ทั้ง repo** |
| ลบ `INSTANCE_STALE_MS` | `metrics.service.ts` | −2 บรรทัด · **0 importer** · หน้าเว็บ hardcode `15` เอง |
| แก้คอมเมนต์โกหก 4 จุด | `health.controller.ts` · `health.module.ts` · `redis.service.ts` · `orders.service.ts` | ดู §4.1 |

### 4.1 คอมเมนต์ 4 จุดที่บรรยายสิ่งที่ระบบไม่ได้ทำ

| ที่ | เดิมเขียนว่า | ความจริง |
| :--- | :--- | :--- |
| `health.controller.ts:49` | "terminus ตอบ 503 เพื่อให้ nginx ถอด instance ออกจาก pool" | healthcheck ทั้ง 6 ตัวชี้ `/health/live` · nginx OSS ไม่มี active check · `max_fails=0` ปิด passive check · **ผู้เรียกจริงคือคน** |
| `health.module.ts:8` | "ใช้ `TypeOrmHealthIndicator`" | `grep` เจอ 1 hit คือคอมเมนต์เอง · controller เขียน `pingDatabase` เองเพราะ indicator สำเร็จรูปแยก master/slave ไม่ได้ |
| `redis.service.ts:370` | "ใช้ภายในและตอน shutdown" | มี 2 ผู้เรียก อยู่ใน `invalidateCatalogCache` ทั้งคู่ · `RedisService` implement แค่ `OnModuleInit` |
| `orders.service.ts:167` | คอมเมนต์ "Blocker (b) fix" วางเหนือ `if (!job)` | BullMQ dedup คืน job ที่ **truthy** → `!job` ไม่มีวันจริงในเคสนั้น · ตัวดักจริงคือ `readStoredJob` บรรทัด 187-201 → **ย้ายคอมเมนต์ไปที่นั่น** |

> **`if (!job)` ไม่ได้ลบ** — ยังจำเป็นสำหรับ TypeScript narrowing (`job` เป็น `Job | undefined` ที่บรรทัด 145 และ TS ไม่ narrow ข้าม `try/catch`) เขียนคอมเมนต์ใหม่บอกไว้ว่ามันมีไว้ทำอะไร

### 4.2 ที่ตัดออกจากแผนหลัง scrutinize (สำคัญ)

แผนรอบแรกถูก agent ตรวจแล้วเจอว่าผิด 2 เรื่อง จึง**ตัด 2 งานทิ้ง**:

- ~~ลบ `soldByDb`~~ — มันอยู่ใน JSON response ของ `/admin/insights.json` **ซึ่งเป็นเกณฑ์เดียวกับที่แผนใช้กัน `row.name`/`prioritized` ออกไปเอง** — แผนใช้เกณฑ์ตัวเองไม่สม่ำเสมอ
- ~~ลบ `Verdict | 'unknown'`~~ — แตะ 5 จุด แต่ **TypeScript คุ้มให้แค่จุดเดียว** อีก 4 จุดเป็น JS ใน template string

ตัดสองอันนี้ทำให้ citation ที่ต้องตามแก้ลดจาก **~50 จุด เหลือ ~22 จุด**

---

## 5. 🧪 การพิสูจน์ — และเหตุผลที่ไม่ต้องยิง k6

### 5.1 จุดตรวจที่ `build`/`lint`/`test` มองไม่เห็น

> **นี่คือช่องโหว่ที่ scrutinize จับได้ และเป็นเหตุผลหลักที่ตัดงานเสี่ยงทิ้ง**

`insights.page.ts` เป็น **template string** — TypeScript, eslint, jest **มองไม่เห็นข้างในเลย** ทั้งที่งาน 3 ใน 5 ข้อลงตรงนั้น
พิมพ์คอมมาเกินใน `STATUS`/`rank` → build ผ่าน, เทสต์ผ่าน 49/49, แล้วหน้าเว็บโยน `SyntaxError` ตาย IIFE ทั้งก้อนตอนเปิดจริง = หน้าว่างเปล่าไม่อัปเดต

จึงเพิ่ม gate ที่**เอา `<script>` ในหน้าไปรันผ่าน `new Function()` จริง**:

```bash
node -e "
const {renderInsightsPage}=require('./dist/observability/insights.page');
const h=renderInsightsPage({instanceId:'x',nodeEnv:'test',queuesPath:'/admin/queues'});
new Function(h.match(/<script>([\s\S]*?)<\/script>/)[1]);   # โยนทันทีถ้า JS พัง
if(!h.includes('id=\"worker-avg\"')) throw new Error('markup หาย');
if((h.match(/prefers-color-scheme/g)||[]).length!==1) throw new Error('ลบบล็อก CSS ผิดตัว');
"
```

### 5.2 ทำไมไม่ต้องยิง k6 ทั้งที่แตะ `orders.service.ts`

§7 ข้อ 5 บังคับว่าแตะ write path ต้องยิง load test — **ปลดเงื่อนไขด้วยหลักฐานแทน**:

`nest build` ตัดคอมเมนต์ทิ้งอยู่แล้ว จึงเทียบ `dist/` ก่อน-หลัง ได้ผลว่า **byte-identical ทั้ง 4 ไฟล์** (ยืนยันด้วย SHA-1) แปลว่าพฤติกรรมไม่เปลี่ยนเลยแม้แต่ byte เดียว

```
e95eaa1c...  orders.service.js     (เท่าเดิม)
8a4ab697...  health.controller.js  (เท่าเดิม)
2eb8aa93...  health.module.js      (เท่าเดิม)
c56e78be...  redis.service.js      (เท่าเดิม)
```

### 5.3 ผลรวม

`build` exit 0 · `test` **49/49** · `eslint` (ไม่ใช้ `--fix`) สะอาด · gate หน้าเว็บผ่าน

> ⚠️ **ห้ามใช้ `pnpm run lint` ตอนตรวจ scope** — script คือ `eslint --fix` ซึ่งแก้ไฟล์เอง ทำให้ `git diff` เชื่อไม่ได้ · ใช้ `pnpm exec eslint "{src,apps,libs,test}/**/*.ts"` แทน

---

## 6. 📄 รายงาน — แก้แล้ว 4 หัวข้อ แต่ยังส่งไม่ได้

`docs/Requirement/Report_flash-sale-report.md` **+21/−2**

| หัวข้อ | แก้อะไร |
| :--- | :--- |
| §2.3 | แก้เคลม "trailing debounce ไม่ทิ้งงาน" ให้ตรงกับโค้ดจริง + บอกขอบเขตความเสียหายจริง (ยังจำกัด เพราะไม่มี endpoint แก้ข้อมูลสินค้า และ `remainingStock` ไม่ได้ถูกแคช) |
| §3.7 | เพิ่มขอบเขตที่ unit test ครอบไม่ถึง (Lua, userId จาก JWT, controller 202, `requestToken` ที่ spec ไม่ได้ใส่) |
| §3.8 | แก้เคลมตัวนับ leak — เพิ่มกรอบอธิบายว่า **ค่าศูนย์เชื่อไม่ได้** |
| §4.1 | เพิ่มข้อจำกัด 3 ข้อ + หัวข้อใหม่ "ข้อจำกัดด้านความปลอดภัยของสภาพแวดล้อมทดสอบ" |

**ไม่แตะ**: ตัวเลขที่วัดจริงทุกตัว, TODO ทั้ง 7 จุด, diagram ทั้ง 4 บล็อก

### ⚠️ ยังส่งไม่ได้ — ขาด 5 อย่าง

1. **ไม่มีโฟลเดอร์ `fig/`** — ลิงก์รูปทั้ง 3 เสียหมด
2. **ไม่ได้ติดตั้ง graphviz** (`which dot` = not found) — diagram ยังเป็น `dot` source · **export PDF ตอนนี้จะได้บล็อกโค้ดแทนรูป ทั้งที่ "Diagram สถาปัตยกรรม" คือ deliverable ข้อ 1**
3. รายชื่อสมาชิกว่าง
4. คอลัมน์เทียบกลุ่มเพื่อนว่าง (ต้องยิงข้ามกลุ่มก่อน)
5. ยังเป็น Markdown ยังไม่เป็น PDF

---

## 7. 🚧 ค้างไว้ — เรียงตามความคุ้มค่า

| # | งาน | ติดตรงไหน |
| :--- | :--- | :--- |
| 1 | **`orders.processor.ts:63-64`** ย้าย 2 บรรทัดเข้า `try` | write path → §7 ข้อ 5 ต้องยิง k6 พิสูจน์ §9.3 |
| 2 | **ยุบ debounce เหลือชั้นเดียว** (−40 บรรทัด + ปิดบั๊ก) | นโยบาย cache → §8 ต้องขออนุญาต |
| 3 | **ผูกพอร์ตกับ `127.0.0.1`** | `docker-compose.yml` → §8 · ต้องขึ้น stack ใหม่ทดสอบ |
| 4 | `metrics.service.ts:143-172` — `pipeline.exec()` กลืน error รายคำสั่ง | ioredis **resolve ไม่ reject** ตอน command error (ยืนยันใน `ioredis/built/pipeline.js:182` — loop เช็ค error เป็น cluster-only) · redis-data เต็มที่ 512mb → `HINCRBY` คืน OOM → ตัวนับค้างเงียบ |
| 5 | `loadtest.js:81-84` threshold มีแค่ latency | `reads_bad_contract` / `orders_unexpected_status` ขึ้นหลักหมื่นได้แล้ว k6 ยัง exit 0 |
| 6 | ลบ `/admin/metrics` (~117 บรรทัด) | รายงานอ้างถึงในตารางที่ 8 + §4.1 → ต้องแก้รายงานตาม ไม่คุ้มตอนใกล้ส่ง |
| 7 | graphviz + render diagram → `fig/` | ปลดล็อกรายงาน |

---

## 8. ⚠️ ข้อควรระวังสำหรับคนทำต่อ

- **ชุดเทสต์ผ่าน 49/49 จริง** และรอบนี้เร็ว (~1 วิ) · `ETIMEDOUT` จาก SynologyDrive **ไม่ได้เกิดทุกครั้ง** ถ้าเจอให้แยกรันทีละ suite แล้วดูว่าเป็น `ETIMEDOUT` หรือ assertion จริง
- **`pnpm run build` ใช้ ~3 วินาที ไม่ใช่ 8 นาที** (incremental ผ่าน `dist/tsconfig.build.tsbuildinfo`) · เลข 8 นาทีคือ cold build — อย่าเข้าใจผิดว่าค้างแล้วกด Ctrl+C
- **`docs/Codebase/All_in_one/codebase-guide.md` เป็นไฟล์ generate** (บรรทัด 3 เขียนเตือนไว้เอง) — แก้ที่ `Separate/` แล้วรัน `node scripts/build-all-in-one.mjs` เท่านั้น
- ไฟล์ `.ts` บางตัวมี mode `100755` (executable bit ติดมาจาก SynologyDrive) — เป็นของเดิม แต่เป็นปัญหา mount **ตระกูลเดียวกับที่เคยทำให้ seed file เจอ `EACCES` เมื่อ 27 ส.ค.**
- `handoff_log/handoff_30_08_2026_arch-doc-sync-...md:42` ยังอ้าง `insights.page.ts:431` (ตอนนี้คือ 418) — **จงใจไม่แก้** เพราะ handoff log คือบันทึกย้อนหลัง ไม่ใช่เอกสารที่ต้องตรงกับปัจจุบัน
