# 🔁 Handoff — Production VM ต้อง login PSU passport ก่อนออกเน็ตได้

**วันที่**: 2026-08-29
**ขอบเขต**: production VM (`172.30.58.5`, user `cloud`) ยังไม่มี internet ออก → `apt` / `docker pull` ใช้ไม่ได้จนกว่าจะ login captive portal ของ PSU ก่อน
**ไฟล์ที่แตะ**: ไม่มี — งานนี้อยู่นอก repo ทั้งหมด (infra ของ VM เอง) เขียนบันทึกนี้ไว้เพื่อไม่ให้คนถัดไปงงว่าทำไม container บน VM นั้น pull image ไม่ได้

---

## 1. ปัญหา

VM ที่จะใช้รัน production stack (`172.30.58.5`) อยู่หลัง PSU network ที่ต้อง login captive portal ("PSU passport") ก่อนถึงจะออกอินเทอร์เน็ตได้ — ถ้าไม่ login ก่อน `apt`, `docker pull`, `pnpm install` (ถ้าต้องออกเน็ต) จะล้มหมด

**เข้าใจผิดที่เจอระหว่างทาง**: ตอนแรกลองเปิด `http://172.30.58.5/` ในเบราว์เซอร์คาดว่าจะเจอหน้า login — ผิด
`ping` ไป `172.30.58.5` ผ่าน (host ทำงานอยู่) แต่ **port 80 connection refused** เพราะ `172.30.58.5` คือตัว VM เอง ไม่มี web server ฟังอยู่ที่ port 80
Captive portal ไม่ได้ intercept การเชื่อมต่อ *เข้าไปหา* VM — มันดัก traffic ที่ *VM พยายามออก* ไปอินเทอร์เน็ตต่างหาก ดังนั้นการ login ต้องทำจากฝั่ง VM เอง (ผ่าน SSH เข้าไปรัน curl) ไม่ใช่เปิดเบราว์เซอร์จากเครื่อง local ไปหา IP ของ VM ตรงๆ

## 2. วิธีแก้ — สคริปต์ login

ทางทีม PSU ให้สคริปต์มาสำหรับ POST username/password ไปที่ captive portal endpoint (`cp-xml-40g.psu.ac.th:6082`) ตรง:

```bash
#!/bin/bash

# Prompt for the username interactively
read -p "Username: " username

# Prompt for the password silently (input is hidden)
read -s -p "Password: " password

echo ""

# Send the POST request using the captured variables
curl --data-urlencode "username=${username}" \
     --data-urlencode "password=${password}" \
     --data "login=" \
     -H "Content-Type: application/x-www-form-urlencoded" \
     -X POST https://cp-xml-40g.psu.ac.th:6082/php/action_page.php
```

**ต้องรันสคริปต์นี้จากภายใน VM เอง** (ผ่าน SSH) ไม่ใช่จากเครื่อง local — เพราะ traffic ที่ต้องถูก authenticate คือ traffic ขาออกของ VM

### ขั้นตอนที่ใช้จริง

```bash
ssh cloud@172.30.58.5
# ใส่รหัสผ่าน SSH ของ VM เอง (คนละอันกับ PSU passport)
```

ถ้ายังไม่มีไฟล์สคริปต์อยู่บน VM ให้สร้างตรงนั้นเลยด้วย heredoc (เร็วกว่า `scp` เพราะไม่ต้องสลับ terminal):

```bash
cat > psu-passport-login.sh << 'EOF'
#!/bin/bash
read -p "Username: " username
read -s -p "Password: " password
echo ""
curl --data-urlencode "username=${username}" \
     --data-urlencode "password=${password}" \
     --data "login=" \
     -H "Content-Type: application/x-www-form-urlencoded" \
     -X POST https://cp-xml-40g.psu.ac.th:6082/php/action_page.php
EOF
chmod +x psu-passport-login.sh
./psu-passport-login.sh
```

จะถาม `Username:` แล้ว `Password:` (hidden input) — ผู้ใช้พิมพ์ credential ของตัวเองตรงนั้น **AI agent ห้ามพิมพ์/รับ credential แทนผู้ใช้เด็ดขาด** (นโยบายความปลอดภัยของ tool)

### ตรวจว่าออกเน็ตได้จริงหลัง login

```bash
curl -I https://google.com     # ควรได้ HTTP 200 ไม่ใช่ timeout
apt update                     # หรือ docker pull ที่ต้องใช้จริง
```

## 3. สถานะ ณ ตอนเขียนบันทึกนี้

⚠️ **ยังไม่ยืนยันว่า login สำเร็จ** — รอบล่าสุดเจอ `bash: ./psu-passport-login.sh: No such file or directory` (สคริปต์ยังไม่ถูกสร้างบน VM) แล้วได้ให้ heredoc ข้างบนไปสร้างไฟล์ ยังไม่มีผลยืนยันกลับมาว่ารันสำเร็จหรือ output ของ curl เป็นอย่างไร

**สิ่งที่คนถัดไปต้องทำ**: SSH เข้า `cloud@172.30.58.5` รัน `./psu-passport-login.sh` (สร้างใหม่ด้วย heredoc ข้างบนถ้ายังไม่มีไฟล์) แล้วเช็คว่า `curl -I https://google.com` ตอบ 200 ก่อนจะเชื่อว่า VM ออกเน็ตได้จริง — ถ้า session หมดอายุ (captive portal มักมี timeout) ต้อง login ซ้ำเรื่อยๆ ทุกครั้งที่ session หลุด

**ไม่เกี่ยวกับ §4 Concurrency Invariants หรือ API contract ของโปรเจกต์เลย** — เป็นแค่ prerequisite ของ infra ก่อนจะ deploy/rebuild image บน VM จริง
