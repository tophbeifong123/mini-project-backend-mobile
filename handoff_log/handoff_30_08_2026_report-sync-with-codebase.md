# 🔁 Handoff — sync รายงาน `Report_flash-sale-report.md` ให้ตรงกับโค้ดจริง + เช็ค Synology Drive/Git

**วันที่**: 2026-08-30
**ขอบเขต**: (1) ตรวจว่าปัญหา Synology Drive แย่งล็อก `.git` เกิดขึ้นจริงกับ repo นี้หรือยัง (2) ไล่รายงานทีละข้อความเทียบกับ `src/` แล้วแก้จุดที่ไม่ตรง
**ไฟล์ที่แตะ**: `docs/Requirement/Report_flash-sale-report.md` (ไฟล์นี้ **ยังไม่เคยถูก commit** มาก่อน — เป็น untracked ตลอด), `handoff_log/*`
**สถานะ**: ✅ จบงาน — เอกสารล้วน **ไม่แตะ `src/` เลย** จึงไม่ต้องรัน build/lint/test ซ้ำ (ผลล่าสุด 35/35 จาก 2026-08-29 ยังใช้ได้)

---

## 1. Synology Drive vs Git — **ตอนนี้ยังไม่มีปัญหา**

ผู้ใช้ยกคำแนะนำ 3 ทางเลือกมาถามว่า "เรามีปัญหานี้ไหม" — ตรวจแล้ว **ไม่มีอาการ**:

| ตรวจอะไร | ผล |
| :--- | :--- |
| `.git/index.lock` ค้าง | ไม่มี |
| `git status` | สะอาด · `main` ตรงกับ `origin/main` |
| `git fsck` | มีแต่ dangling commit/blob ปกติจาก rebase/amend เก่า **ไม่ใช่ความเสียหาย** |
| ไฟล์ `*conflicted copy*` | ไม่พบทั้ง repo |
| `.git` เป็น dir จริงไหม | ใช่ · 3.9M · ไม่ใช่ junction/symlink |

**แนะนำทางเลือกที่ 2** (Sync Rules → File Filter ยกเว้น `.git`, `node_modules`, `dist`) เพราะทำได้เร็วและไม่ต้องย้ายโปรเจกต์ออกจาก SynologyDrive
⚠️ **ยังไม่ยืนยันว่าผู้ใช้ตั้งค่าแล้วหรือยัง** — ถ้าตั้งแล้วให้เช็ค `git status` ทันทีหลังกด Apply เผื่อ Selective Sync ลบ `.git` ออกจากเครื่องไปด้วย

> กับดักเดิมที่ยังอยู่: SynologyDrive เปลี่ยน mode bit เป็น `100755` เองเรื่อย ๆ (ดู `handoff_29_08_2026_verify-audit-and-report-doc.md` §5) — session นี้ `git diff --summary` ว่าง ไม่เจอ

## 2. รายงานไม่ตรงกับโค้ด 6 จุด — แก้แล้วทั้งหมด

วิธีตรวจคือ **อ่านโค้ดจริงมายืนยันทุกข้อความ** ไม่ใช่เทียบกับเอกสารอื่น (บทเรียนจาก `handoff_29_08_2026_doc-accuracy-audit.md` ที่ audit จากการอ่านอย่างเดียวแล้วสรุปผิด)

| # | เดิม | แก้เป็น | หลักฐาน |
| :-- | :--- | :--- | :--- |
| 1 | DFD write path เขียน `DEL catalog:page:*` — อ่านเหมือนลบด้วย pattern **ขัดกับ §2.3 ของรายงานเองที่เขียนว่าห้ามใช้ `KEYS`** | `SMEMBERS catalog:index -> DEL` + เพิ่ม `catalog:index` ในกล่อง D1 | `redis.service.ts:371-384` |
| 2 | §2.3 ไม่เคยพูดถึง `catalog:index` เลย ทั้งที่เป็นกลไกที่ทำให้ล้างแคชได้โดยไม่สแกน keyspace | เพิ่มย่อหน้า **Live-Key Index** (SADD ใน MULTI เดียวกับ SETEX + index มี TTL ของตัวเอง) | `redis.service.ts:282-306` · `redis.keys.ts` |
| 3 | §2.4 Tier 2 ตกกับดักใหญ่ที่สุดของ BullMQ — **dedup แล้วคืน job เดิมเงียบ ๆ ไม่ throw** → `try/catch` ไม่มีวันทำงาน | เพิ่มการอ่าน job กลับด้วย `getJob(jobId)` เทียบ `requestToken` + ผลลัพธ์ 3 ทาง + เตือนว่าห้ามเทียบ `job.data` ที่ `add()` คืนมา | `orders.service.ts:157-188` |
| 4 | ตารางนโยบายชดเชย §2.5 ขาด 2 กรณีที่มีอยู่จริงในโค้ด | เพิ่มแถว "โดน dedup (token ไม่ตรง) → คืน + 409" และ "ยืนยัน job ไม่ได้ (`getJob` = null) → **ไม่คืน**" | `orders.service.ts:178-188` |
| 5 | §3.5 เขียน "RAM ต่อ instance 60–90 MB" — ปนกันระหว่าง *เพดาน* กับ *ที่ใช้จริง* | "จำกัด 512 MB (ใช้จริง 60–90 MB)" | `docker-compose.yml:193` |
| 6 | §4 เขียน "pool 8 × 6 = 48 จาก max 100" โดยไม่บอกว่าเป็นค่า**ต่อเซิร์ฟเวอร์** ชวนให้คิดว่ารวมกันแล้วเกือบเต็ม | ระบุว่า TypeORM replication แยก pool ต่อ master/replica → **48/100 บน primary และ 48/100 บน replica ไม่ใช่ 96 รวมกัน** | `database.config.ts:10-19` · `docker-compose.yml:54,218` |

เพิ่มอีก 1 ย่อหน้าใน §2.2: **read path degrade ไม่ใช่ล้ม** — `MGET` ล้ม → ตกไปใช้ `fallbackRemainingStock` + นับ + log error ไม่ตอบ 503 (`products.service.ts:109-137`) และอัปเดตวันที่หน้าปกเป็น 30 ส.ค. 2569

## 3. ✅ ส่วนที่ตรวจแล้ว **ตรงอยู่แล้ว ไม่ได้แตะ**

อย่าไปแก้ซ้ำ — ยืนยันกับโค้ดแล้วทุกข้อ:

- Lua `gatekeeper` ทั้งบล็อกในรายงานตรงกับ `src/redis/lua/gatekeeper.lua` ทุกบรรทัด รวม verdict `-1/-2/-3/-4`
- ชื่อ constraint ทั้ง 3 (`uq_user_product_order`, `chk_positive_stock`, `chk_stock_ceiling`) ตรงกับ migration
- key format `bought:{productId}:{userId}` · `lock:order:{userId}:{productId}` · `stock:flash_sale:{productId}`
- lock TTL 30 วินาที · TTL แคช 30–60 วิ + jitter (`CATALOG_CACHE_TTL_BASE/JITTER = 30/30` ทั้งใน `.env` และ `docker-compose.yml`)
- nginx: `least_conn` · `keepalive 128` · `max_fails=0` · `proxy_next_upstream error` · `proxy_read_timeout 10s` · 6 upstream
- Redis 2 ตัว: cache `allkeys-lru` 256mb (`:6379`) · data `noeviction` + AOF 512mb (`:6380`)
- Node 22 (Dockerfile) · **35 unit tests** — นับ `it(` ได้ 8 + 18 + 9 = 35 ตรงกับที่รายงานเขียน

## 4. 🚧 ค้างไว้ให้คนถัดไป

| เรื่อง | สถานะ |
| :--- | :--- |
| **ตัวเลขผลทดสอบในรายงานยังเป็นของ 28 ส.ค.** | 2,548 rps · read p95 469.79ms · write p95 317.34ms · hit 97.63% — **ยังไม่ได้ยิงซ้ำหลังงานวันนี้** (แต่วันนี้ไม่แตะ `src/` จึงไม่กระทบ) |
| **TODO 4 จุดในรายงาน** | รายชื่อสมาชิก · screenshot k6 / Bull-Board / cache-stats · ตารางเทียบกลุ่มเพื่อน |
| **ยิงข้ามกลุ่ม** | ยังไม่เคยทำ — เป็น deliverable ตรง ๆ |
| **`package-lock.json` ยังอยู่ใน repo** | ขัด CLAUDE.md §1 (`pnpm` เท่านั้น) · ยังไม่ได้คุยกับทีม |
| **Synology Drive File Filter** | ยังไม่ยืนยันว่าตั้งค่าแล้ว (§1) |
