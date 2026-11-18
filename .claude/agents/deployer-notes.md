# Deployer — Issue Memory (hl-hyper-approve)

> ความจำของ agent `deployer` — อ่านทุกครั้งก่อนช่วยงาน และ **เขียนเพิ่มทุกครั้ง** ที่เจอเรื่องใหม่
> รูปแบบ: - **อาการ/สถานการณ์** → **สาเหตุ** → **วิธีแก้ / คำสั่ง** _(อัปเดต: YYYY-MM-DD)_
> ของใหม่ไว้บนสุดของแต่ละหมวด · ห้ามจด secret จริง

---

## เครื่อง prod — 43.208.169.222 (e-approval.hylifeconnect.com) ⚠️ ระบบจริง

สำรวจแบบอ่านอย่างเดียวเมื่อ 2026-11-18:
- AWS t3.medium (2 vCPU / 3.7GB), **ไม่มี swap**, Ubuntu 24.04, disk 193GB ใช้ 36%
- SSH: `plink -batch -hostkey <fp> -i eapp.ppk ubuntu@43.208.169.222` — key เป็น PuTTY v2 และ puttygen บนเครื่อง dev ของเราเป็นแบบ GUI แปลงทาง CLI ไม่ได้ ถ้าจะใช้ใน GitHub secret ต้องแปลงผ่าน GUI: Conversions → Export OpenSSH key
- ระบบเก่า: Express รันด้วย pm2 `hlememo-backend` (`/var/www/hlememo/backend/dist/src/index.js`, :3001)
- nginx + certbot เสิร์ฟ `/var/www/hlememo/frontend/dist`, proxy `/api/` และ `/ws` ไป :3001
  - มี alias สาธารณะ `/uploads/` และ `/source-uploads/` ที่**ไม่ต้อง auth**
- Postgres 16 บนเครื่อง ฐาน `hlememo` ~132MB
  - `listen_addresses='*'` และ pg_hba มี `host all all 0.0.0.0/0 md5` → ที่กันไว้มีแค่ ufw (เปิดเฉพาะ Nginx/SSH)
  - local `trust`
- **uploads 45GB** ที่ `/var/www/hlememo/uploads` → ห้าม copy หรือย้าย ให้ bind mount
- backup: cron `0 */3 * * *` รัน `/var/www/db_backup.sh` → `/var/www/backup/db` ⚠️ **ในสคริปต์มีรหัส DB เป็น plaintext** (ควรเปลี่ยนรหัสแล้วย้ายไป `~/.pgpass`)
- โค้ดบนเครื่องชี้ไป repo `HL-IBC-Software-Dev/HL-EMEMO-FIX-EXCEL` @ `b028656` และ working tree ไม่ clean (deploy ด้วยมือ)
- Docker **ยังไม่ได้ติดตั้ง**
- DNS ชี้ตรงมาที่เครื่อง (ไม่ผ่าน Cloudflare) → Caddy ขอ cert จาก Let's Encrypt ด้วย HTTP-01 เองได้

## เครื่อง dev — 43.210.109.106 (ใช้ร่วมกับเว็บอื่นราว 11 ตัว)

สำรวจเมื่อ 2026-11-18:
- t3.medium, swap 2G, Docker 29.1 + compose 2.40 (มาจาก Ubuntu apt)
- foodreview รันด้วย Docker อยู่แล้ว (`ghcr.io/bookbento/food-review-*`, bind ที่ 127.0.0.1) → GHCR login ของ bookbento มีอยู่บนเครื่องแล้ว
- port ที่ถูกใช้: 22 53 80 443 3001 3002 3005 3009 3100 3306 3307 5432 → hyper ใช้ api :3011 (host network) และ web 127.0.0.1:8089 โดยมี nginx :8088 อยู่ข้างหน้า
- Postgres `listen_addresses=localhost` และ pg_hba รับแค่ 127.0.0.1 → api ต้องใช้ `network_mode: host` ห้ามแก้ listen (ต้อง restart ซึ่งกระทบระบบอื่น)
- DB `hlememo_dev` (สำเนาจาก `test-myapp`, มีอีเมลจริง → ห้ามตั้ง SMTP จริง) · uploads `/var/www/hlememo-dev/uploads` ~33MB
- nginx site `/etc/nginx/sites-available/hlememo-dev` ยังมีอยู่ แต่ unlink ไปเมื่อ 2026-11-13

## Migration

- ฐานเก่าสร้างด้วย `prisma db push` → ครั้งแรกต้อง baseline: เทียบ diff กับ schema ก่อน ถ้าต่างกันแค่ index ของ migration ถัดมา ให้รัน `migrate resolve --applied 0_init` แล้วค่อย `migrate deploy` (logic เดิมอยู่ที่ `deploy-production.sh:169-187`) _(2026-11-18)_

## คำสั่ง & สิทธิ์

- (ยังไม่มี — จดเพิ่มเมื่อเจอ)
