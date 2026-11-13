# DEV server — 43.210.109.106

**http://43.210.109.106:8088** · ใช้ทดสอบภายใน (dev 2 คน) ไม่ใช่ production

> **สถานะ 2026-11-13: ปิดอยู่** ตอนนี้ทดสอบผ่าน `pnpm dev` ในวง LAN แทน ได้ลบ pm2 app และเอา nginx site ออกแล้ว แต่ไฟล์ใน `/var/www/hlememo-dev` กับ DB `hlememo_dev` ยังอยู่
> ถ้าจะเปิดกลับ: `sudo ln -s /etc/nginx/sites-available/hlememo-dev /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx` แล้วรัน `deploy-dev.sh` (ต้องเปิด port 8088 ใน Security Group ด้วย)

เครื่องนี้ใช้ร่วมกับระบบอื่นอีกหลายตัว (AWS t3.medium, Ubuntu 24.04) ห้ามรัน `serversetup.sh` หรือ `apt upgrade` เอง

| | |
|---|---|
| SSH | `ssh -i ~/Downloads/hlserver-git.ppk ubuntu@43.210.109.106` (ไฟล์นี้เป็น OpenSSH PEM ไม่ใช่ PuTTY key) |
| app | `/var/www/hlememo-dev` |
| api | pm2 `hlememo-dev-api` → `127.0.0.1:3011` (`apps/api/ecosystem.dev.config.js`), log อยู่ที่ `apps/api/logs/` |
| web | nginx `:8088` → `frontend/dist`, `/api/` → `:3011` (`/etc/nginx/sites-available/hlememo-dev`) |
| db | Postgres 16 บนเครื่อง, DB/user `hlememo_dev` (รหัสผ่านอยู่ใน `apps/api/.env` บนเครื่องเท่านั้น) |
| uploads | `/var/www/hlememo-dev/uploads` |

port 3001 บนเครื่องนี้ถูก `foodreview-api` ใช้อยู่ เลยใช้ 3011 แทน

## Deploy

```bash
SSH_KEY=~/Downloads/hlserver-git.ppk ./scripts/deploy-dev.sh
```

build ทุกอย่างบนเครื่องเรา (database, api, frontend) แล้วส่งขึ้นไปเป็น tarball ฝั่งเซิร์ฟเวอร์ทำแค่ `pnpm install` ของ api (เพื่อให้ bcrypt, sharp และ Prisma engine เป็นของ Linux), `prisma migrate deploy`, `pm2 startOrReload` แล้วรอ `/api/health`
ไฟล์ `.env`, `uploads/` และ `node_modules/` บนเครื่องจะไม่ถูกทับ

## ค่าที่ตั้งใจให้ต่างจาก production

- **`NODE_ENV=development`** เพราะเข้าเว็บผ่าน HTTP ด้วย IP แต่ production ตั้ง cookie login เป็น `secure` ถ้าใช้ production จะ login ไม่ติด ผลพลอยได้คือ `/api/dev/expiry/*` (เฉพาะ admin) ใช้งานได้
- **ไม่ได้ตั้ง `SMTP_HOST`** เพราะข้อมูลเป็นสำเนาที่มีอีเมลผู้ใช้จริง ระบบจึงต้องไม่ส่งอีเมลออกไปเลย ใน log จะเห็น `ECONNREFUSED :587` ซึ่งเป็นเรื่องปกติ
  ถ้าจะทดสอบอีเมล ให้ชี้ไปที่ mail catcher (เช่น Mailpit) ห้ามใช้ SMTP จริง
- `VITE_BACKEND_API_URL` ถูกฝังไว้ตอน build (`DEV_PUBLIC_URL`, ค่าเริ่มต้น `http://43.210.109.106:8088`) ต้องเป็น URL เต็ม เพราะ frontend หลายจุดต่อ URL เองหรือเรียก `new URL(x, BASE_URL)`

## ข้อมูล

ตั้งต้นเมื่อ 2026-11-13 โดยคัดลอกจาก DB `test-myapp` (เดโมของตัวเก่าที่ `/var/www/test-eapp` บนเครื่องเดียวกัน, memo ประมาณ 19k) และคัดลอก `uploads/` มาด้วย
เนื่องจาก DB นี้สร้างด้วย `db push` จึง baseline ด้วย `migrate resolve --applied 0_init` หลังตรวจ diff แล้วพบว่าต่างกันแค่ index 2 ตัวของ migration ถัดมา

## ตั้งค่าครั้งแรก (ทำไปแล้ว ใช้อ้างอิงถ้าต้องสร้างใหม่)

1. `sudo mkdir -p /var/www/hlememo-dev/apps/api && sudo chown -R ubuntu:ubuntu /var/www/hlememo-dev`
2. สร้าง role และ DB `hlememo_dev` แล้วรัน `pg_dump --no-owner --no-acl test-myapp | psql hlememo_dev` จากนั้นโอน owner ของตารางและ sequence ให้ `hlememo_dev`
3. `cp -a /var/www/test-eapp/uploads /var/www/hlememo-dev/uploads`
4. เขียน `apps/api/.env` ให้มี `DATABASE_URL`, `JWT_SECRET`, `EMAIL_TOKEN_SECRET` (สุ่มด้วย `openssl rand -hex 32`), `TRUST_PROXY_HOPS=1`, `APP_BASE_URL`/`FRONTEND_URL`/`CORS_ORIGIN=http://43.210.109.106:8088`, `UPLOADS_DIR`, `SMTP_HOST=` (ว่างไว้) แล้ว `chmod 600`
5. สร้าง nginx site ฟังที่ `:8088` แล้ว `nginx -t && systemctl reload nginx`
6. เปิด inbound TCP 8088 ใน AWS Security Group ของ instance
7. รัน `deploy-dev.sh` ครั้งแรก ถ้าเจอ P3005 ให้ baseline ตามหัวข้อ "ข้อมูล"
