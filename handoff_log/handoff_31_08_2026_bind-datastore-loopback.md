# 🔒 Handoff — ผูก published port ของ datastore กับ `127.0.0.1` (ปิดรู §0.1 ก่อนขึ้น VM)

**วันที่**: 2026-08-31
**ขอบเขต**: แก้ `docker-compose.yml` 4 บรรทัด (`ports:` ของ postgres ×2 + redis ×2) ให้ผูกกับ loopback แทนทุก interface · **ไม่แตะโค้ดใน `src/` เลย** · ต่อจาก [`handoff_31_08_2026_right-size-to-4core-vm.md`](handoff_31_08_2026_right-size-to-4core-vm.md) ที่ push ไปแล้วใน commit `81b787b`
**ไฟล์ที่แตะ**: `docker-compose.yml` เท่านั้น

---

## 1. TL;DR

- ปิดรูที่ `CLAUDE.md` §0.1 มาร์กไว้ว่า 🟠 **"datastore เปิดทุก interface ไม่มีรหัสผ่าน"** ตั้งแต่ 2026-08-30
- แก้แค่ prefix `127.0.0.1:` หน้า port mapping ของ 4 service — **`nginx :8080` จงใจไม่แตะ** เพราะกลุ่มอื่นต้องยิง k6 เข้ามาได้
- **ไม่กระทบเครื่องมือใดๆ** — ตรวจแล้วทุกตัวที่ต่อ datastore ใช้ `localhost`/`127.0.0.1` อยู่แล้ว (ดู §3)
- เป็นงาน **security ล้วน** ไม่ได้ทำให้เร็วขึ้น ไม่ได้แก้บั๊ก latency ไม่เปลี่ยน API contract

---

## 2. ทำไมต้องแก้ — และแก้คำพูดที่เคยเขียนไว้ผิด

`CLAUDE.md` §0.1 เขียนไว้ว่าการ `SET stock:flash_sale:p-1001 9999` จากเครื่องอื่น "ข้ามการป้องกันทั้ง 4 ชั้น" — **ประโยคนี้ไม่แม่น** ตรวจจริงแล้วได้ผลต่างกันตามช่องที่เปิด:

| ช่องที่เปิด | ข้ามได้ถึงไหน | ทำให้ oversell จริงไหม |
| :--- | :--- | :--- |
| **Redis** (`redis-data` ไม่มี `requirepass`) | ข้าม **Tier 1** (gatekeeper) ได้ — ปล่อยคนทะลุมาเท่าไหร่ก็ได้ | **ไม่** — Tier 3 (`WHERE remaining_stock > 0`) และ Tier 4 (`CHECK >= 0`) ยังกันอยู่ · อาการจริงคือคนได้ `202` แล้ว job ตายเป็น `SoldOutError` = พังเชิงพฤติกรรม ไม่ใช่ขายเกิน |
| **Postgres** (รหัส `flashsale`/`flashsale` เขียนอยู่ใน `docker-compose.yml` ตรงๆ) | **ข้ามได้ทุกด่านจริง** | **ใช่** — `UPDATE products SET remaining_stock = 9999` หรือ `DELETE FROM orders` แตะ source of truth ตรงๆ · Tier 3/4 อยู่ *ใน* Postgres เอง ใครเข้าถึง Postgres ได้ก็คือเข้าถึงตัวป้องกันเสียเอง |

**ตัวอันตรายจริงคือ Postgres ไม่ใช่ Redis** และรหัสก็ไม่ใช่ความลับ — มันอยู่ใน `docker-compose.yml` ที่ push ขึ้น GitHub public ไปแล้ว

**สถานการณ์ที่น่าจะเกิดจริงกว่าการกลั่นแกล้ง คืออุบัติเหตุ**: วันยิงข้ามกลุ่มทุกคนอยู่ LAN เดียวกัน เพื่อนตั้ง `BASE_URL` ผิด หรือรัน `loadtest/reset.sh` ของกลุ่มตัวเองแล้วมันไปโดน DB ของเรา → §9.3 ไม่ผ่านโดยหาสาเหตุไม่เจอตอนอยู่หน้างาน

---

## 3. การเปลี่ยนแปลง

```diff
 postgres-primary:
-      - "5432:5432"
+      - "127.0.0.1:5432:5432"
 postgres-replica:
-      - "5433:5432"
+      - "127.0.0.1:5433:5432"
 redis-cache:
-      - "6379:6379"
+      - "127.0.0.1:6379:6379"
 redis-data:
-      - "6380:6379"
+      - "127.0.0.1:6380:6379"

 nginx:
       - "8080:80"     ← ไม่แตะ ต้องเปิดให้กลุ่มอื่นยิง k6
```

พร้อมคอมเมนต์กันคนมาแก้กลับไว้เหนือ mapping แรก

### ทำไมถึงไม่กระทบอะไร

`ports: "5432:5432"` ผูกกับ `0.0.0.0` (ทุก interface) · ใส่ `127.0.0.1:` = ยังเข้าจากเครื่องตัวเองได้เหมือนเดิม **ตัดแค่การเข้าจากเครื่องอื่นบน LAN** · grep ทุกตัวที่ต่อ datastore แล้วใช้ loopback หมด:

| ตัวที่ต่อ | ใช้อะไร | หลังแก้ |
| :--- | :--- | :--- |
| `pnpm run reset` (Redis) | `127.0.0.1:6380` — `reset.ts:54-55` | ✅ ทดสอบแล้ว |
| `pnpm run reset` / `seed` (PG) | `localhost:5432` — `data-source.ts:52-53` | ✅ ทดสอบแล้ว |
| `scripts/cache-stats.sh` | `127.0.0.1` — `:12` | ✅ (แต่พังด้วยเหตุอื่น ดู §5) |
| `loadtest/reset.sh` · `verify.sh` · `.ps1` | `psql -h 127.0.0.1` | ✅ |
| **container คุยกันเอง** | Docker network (`postgres-primary:5432`) **ไม่ผ่าน published port** | ✅ ไม่เกี่ยวกันตั้งแต่แรก |
| **k6 จากเครื่องเพื่อน** | `http://<ip>:8080` → nginx | ✅ ไม่แตะ |

> ไม่มีไฟล์ `.env` ในเครื่อง ทุกตัวจึงใช้ค่า default ซึ่งเป็น loopback ทั้งหมด

---

## 4. ผลการตรวจสอบ

ยิงจริงหลัง `docker compose up -d` (LAN IP ตอนทดสอบ = `172.30.88.229`):

```
จาก 127.0.0.1 :  PG 5432 OPEN ✓ · Redis 6380 OPEN ✓ · nginx 8080 OPEN ✓
จาก LAN IP    :  PG 5432 BLOCKED ✓ · PG 5433 BLOCKED ✓
                 Redis 6379 BLOCKED ✓ · Redis 6380 BLOCKED ✓
                 nginx 8080 OPEN ✓  (ต้องเปิด)
```

เครื่องมือฝั่งโฮสต์หลังแก้:
- `RESET_CONFIRM=yes pnpm run reset` → ผ่าน (ลบ stock=20 bought=50 · seed 20 products · 20 counters)
- `psql -h localhost -p 5432` → คืน `remaining_stock = 50` · `psql -h localhost -p 5433` (replica) → คืน `20`
- `GET /api/v1/products` → `200`
- `docker compose config --quiet` → ผ่าน · container **11/11 healthy**
- `build` / `lint` / `test` → ผ่าน **49 tests**

---

## 5. สิ่งที่ **ไม่ได้** ทำ และเจอระหว่างทาง

| เรื่อง | สถานะ |
| :--- | :--- |
| **ไม่ใส่ `requirepass` ให้ Redis** | จงใจ — จะลามไปต้องแก้ `redis.module.ts`, BullMQ connection, env ทั้งหมด และเพิ่มจุดพังใหม่ ทั้งที่การผูก loopback ปิดช่องเดียวกันได้ด้วยการแก้ 4 บรรทัด **ได้ผลเท่ากันสำหรับภัยที่เป็นจริง** (คนบน LAN วันสอบ) |
| **ไม่แก้รหัส PG ที่ hardcode** | `flashsale`/`flashsale` ยังอยู่ใน `docker-compose.yml` · หลังผูก loopback แล้วมันเข้าถึงไม่ได้จากข้างนอก จึงลดความสำคัญลง แต่**ยังเป็นรหัสที่อ่านได้จาก GitHub public** |
| 🟠 **Bull-Board `admin`/`admin` hardcode** | **ยังไม่แก้** — §0.1 มาร์กไว้แล้ว · `/admin` เปิดผ่าน `:8080` ซึ่งยังเปิดสู่ LAN อยู่ (ต้องเปิด) **นี่คือรูที่เหลืออยู่จริงหลัง commit นี้** |
| `scripts/cache-stats.sh` พัง | **มีมาก่อน ไม่เกี่ยวกับงานนี้** — สคริปต์ hardcode `podman` (`:28`) แต่เครื่องใช้ `docker` → `podman: command not found` |
| `loadtest/verify.sh:184` · `verify.ps1:177` | **มีมาก่อน** — เรียก `compose exec nest-1` แต่ service ชื่อ `app-1` · น่าจะพังมานานแล้ว |

---

## 6. คนต่อไปต้องทำอะไร

1. **ยังไม่ได้ deploy ขึ้น VM เลยสักครั้ง** — โค้ดอยู่แค่บน GitHub กับรันบน dev Mac · ทุกตัวเลข performance ใน repo ยังมาจาก dev Mac 8-core ที่รัน k6 พร้อมกัน **ใช้อ้างในรายงานไม่ได้**
2. **ถ้าจะให้กลุ่มอื่นยิงเข้ามา** ต้องเช็คว่า `8080` เข้าถึงได้จาก LAN จริง (ทดสอบแล้วว่าเปิด) และ **ปิด/เปลี่ยนรหัส Bull-Board ก่อน** เพราะมันเปิดดู payload และกด retry/remove job ได้
3. **หลังขึ้น VM ต้องรัน §9.3 ซ้ำ** — คำสั่ง `psql`/`redis-cli` จากโฮสต์ยังใช้ได้เหมือนเดิม (loopback) หรือใช้ `docker exec fs-postgres-primary psql -U flashsale -d flashsale -tAc '...'` ซึ่งไม่พึ่ง published port เลย
