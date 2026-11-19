# Prod cutover runbook: Express → Nest (Docker + Caddy)

| | |
|---|---|
| วันที่ | เสาร์ 21 พ.ย. 2026 · ช่วงปิดระบบ: `__:__–__:__` (แจ้ง user ล่วงหน้า) |
| เครื่อง | prod `43.208.169.222`, เว็บ `e-approval.hylifeconnect.com` |
| image | `ghcr.io/bookbento/hl-hyper-approve-{api,web}:<TAG>` ใช้ commit เดียวกับที่ QA บน dev ผ่านแล้ว |
| DB | Postgres 16 ฐาน `hlememo` บนเครื่อง ใช้ฐานเดิม ไม่ย้าย |
| uploads | `/var/www/hlememo/uploads` (45GB) ใช้ bind mount ห้าม copy |

หลักการ:
- **ของเก่าหยุดไว้ ยังไม่ลบ** migration ทั้งหมดเป็นการเพิ่ม index อย่างเดียว Express จึงยังกลับมารันบน DB นี้ได้
- **ห้ามรัน Express กับ Nest พร้อมกัน** เพราะทั้งคู่มี scheduler ปิด memo ที่หมดอายุ (`memo-expiry`) ถ้ารันพร้อมกันจะทำงานซ้ำและส่งอีเมลซ้ำ
- ทุกขั้นบน prod ทำทีละขั้นและเช็คผลก่อนไปขั้นต่อไป · ห้ามจด secret ลงไฟล์นี้หรือ git
- SSH: `plink -batch -hostkey <fp> -i eapp.ppk ubuntu@43.208.169.222` (ดู `.claude/agents/deployer-notes.md`)

---

## 0. ก่อนวันเสาร์ (พฤ.–ศ.)

- [ ] **QA บน dev ผ่านแล้ว** (`http://43.210.109.106:8088`): login, dashboard ทั้งหมด/All, เปิดและเซ็น memo (รวม PDF จาก WPS เช่น m6.11.pdf), อัปโหลด 6 ไฟล์โดยไม่ซ้ำ, approve/reject, CC, admin
- [ ] จด **TAG** = commit sha ที่ QA ผ่าน: `TAG=________________`
- [ ] **GHCR token:** สร้าง PAT แบบ classic สิทธิ์ `read:packages` อย่างเดียว ไว้ใช้ login บน prod
- [ ] **ค่า secret จาก Express:** ใช้ค่าเดิมจาก `/var/www/hlememo/backend/.env` (ชื่อตัวแปรตรงกัน)
  - `JWT_SECRET` และ `EMAIL_TOKEN_SECRET` **ต้องใช้ค่าเดิม** ไม่อย่างนั้นลิงก์ approve ในอีเมลที่ส่งไปแล้วจะใช้ไม่ได้ทั้งหมด
  - `SMTP_*` ใช้ค่าจริงของ prod
- [ ] **(แนะนำ) ซ้อมเช็ค drift แบบอ่านอย่างเดียว:** เปิด tunnel `plink -L 55433:localhost:5432 ...` แล้วรันจากเครื่องเรา
  ```bash
  cd packages/database
  npx prisma migrate diff --from-url "postgresql://<user>:<pass>@localhost:55433/hlememo" \
    --to-schema-datamodel prisma/schema.prisma --script
  ```
  ผลที่ควรได้มีแค่ `CREATE INDEX` 4 ตัว (`MemoStatusPivot_memoId_createdAt_id_idx`, `MemoHistory_memoId_idx`, `Comment_memoId_createdAt_idx`, `ExtraApprovalLine_memoId_idx`) และ `ALTER TABLE "AttachedFile" ADD COLUMN "orderNo"` อีก 1 บรรทัด ถ้ามีอย่างอื่นปนมา **หยุดและคุยกันก่อน**
- [ ] **(ทำวันศุกร์ได้, ต้องอนุมัติ) ลง Docker:** ไม่กระทบ Express/nginx ที่รันอยู่
  ```bash
  sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2
  sudo usermod -aG docker ubuntu   # logout แล้ว login ใหม่
  docker version && docker compose version
  ```
- [ ] **(ทำวันศุกร์ได้) เตรียมไฟล์:**
  - `mkdir -p ~/hyper`
  - copy `docker-compose.prod.yml` ไปไว้ใน `~/hyper/`
  - เขียน `~/hyper/.env` (`chmod 600`) ตามขั้น 3
- [ ] แจ้ง user เรื่องเวลาปิดระบบ และบอกว่าหลังเปิดอาจต้อง login ใหม่

## 1. เช็คก่อนเริ่ม (อ่านอย่างเดียว)

```bash
free -h; df -h /                        # RAM ว่างพอ, disk < 80%
pm2 ls                                  # hlememo-backend online
sudo systemctl is-active nginx postgresql
stat -c '%u %U' /var/www/hlememo/uploads   # ควรเป็น uid 1000 (ubuntu) = user ใน container
sudo -u postgres psql -d hlememo -c "select count(*) from \"MasterMemo\";"   # จดไว้เทียบ
```
`MasterMemo` = `________`

## 2. ปิดระบบเก่าและสำรองข้อมูล ← เริ่มนับ downtime

```bash
pm2 stop hlememo-backend && pm2 save    # save: reboot แล้วจะไม่ขึ้นมาเอง
sudo pg_dump -U postgres -Fc hlememo -f /var/www/backup/db/pre-cutover-$(date +%F-%H%M).dump
ls -lh /var/www/backup/db/ | tail -2    # ไฟล์ต้องไม่ว่าง (~ร้อย MB)
```
ถ้าไม่ปิด pm2 ก่อน dump จะได้ snapshot ที่ข้อมูลยังเขียนต่ออยู่

## 3. ให้ container ต่อ Postgres ได้

```bash
# pg_hba: อนุญาตวง IP ของ docker bridge (ใช้ reload ไม่ต้อง restart)
echo "host  hlememo  all  172.16.0.0/12  scram-sha-256" | sudo tee -a /etc/postgresql/16/main/pg_hba.conf
sudo -u postgres psql -c "select pg_reload_conf();"
# ufw บล็อก container→host ด้วย (INPUT chain) → เปิด 5432 เฉพาะวง docker
sudo ufw allow from 172.16.0.0/12 to any port 5432 proto tcp
```
- ถ้า user ของ DB ใช้รหัสแบบ md5 ให้ใส่ `md5` แทน `scram-sha-256` ดูได้จากบรรทัด `0.0.0.0/0 md5` ที่มีอยู่เดิม

`~/hyper/.env` (`chmod 600`):
```
DOMAIN=e-approval.hylifeconnect.com
IMAGE_API=ghcr.io/bookbento/hl-hyper-approve-api
IMAGE_WEB=ghcr.io/bookbento/hl-hyper-approve-web
TAG=<TAG จากขั้น 0>
DATABASE_URL=postgresql://<user>:<pass>@host.docker.internal:5432/hlememo
JWT_SECRET=<ค่าเดิมจาก Express>
EMAIL_TOKEN_SECRET=<ค่าเดิมจาก Express>
APP_BASE_URL=https://e-approval.hylifeconnect.com
FRONTEND_URL=https://e-approval.hylifeconnect.com
CORS_ORIGIN=https://e-approval.hylifeconnect.com
SMTP_HOST=  SMTP_PORT=  SMTP_USER=  SMTP_PASS=  SMTP_FROM=   # ค่าจริงของ prod (ใส่บรรทัดละตัว)
```

## 4. ดึง image และ migrate

```bash
cd ~/hyper
echo "<PAT>" | docker login ghcr.io -u bookbento --password-stdin
C="docker compose -f docker-compose.prod.yml"
$C pull
$C run --rm api sh /app/packages/database/scripts/migrate-deploy.sh
```
ผลที่ควรได้:
- `✅ Baselined 0_init`
- migration ถัดมา 5 ตัวรันผ่าน: `CREATE INDEX` 4 ตัว และเพิ่ม column `AttachedFile.orderNo` (มีค่า default จึงเสร็จทันที) ทั้งหมดใช้แค่ไม่กี่วินาที และไม่มีใครเขียน DB อยู่ตอนนั้น

ถ้าได้ `❌ Live DB differs…` ให้**หยุด** อ่าน SQL ที่สคริปต์พิมพ์ออกมา แล้วตัดสินใจว่าจะไปต่อหรือ rollback (ยังไม่มีอะไรถูกแก้)

## 5. สลับ nginx เป็น Caddy

```bash
sudo systemctl stop nginx && sudo systemctl disable nginx
$C up -d
$C logs -f web     # รอบรรทัด "certificate obtained successfully" ของ e-approval.hylifeconnect.com
```
- ถ้าขอ cert ไม่ได้ภายใน ~2 นาที (DNS, port 80, rate limit): **rollback ขั้น R** แล้วค่อยหาสาเหตุ cert เดิมของ certbot ยังอยู่
- ห้ามรัน `up` ซ้ำหลายรอบจนชน rate limit ของ Let's Encrypt (5 ครั้งที่ล้มเหลวต่อชั่วโมง)

## 6. Smoke test

```bash
curl -fsS https://e-approval.hylifeconnect.com/api/health
curl -sI https://e-approval.hylifeconnect.com/ | head -3          # 200, Cache-Control no-store
curl -sI https://e-approval.hylifeconnect.com/uploads/x | head -1   # ไม่ควรได้ไฟล์ (ไม่มี path สาธารณะแล้ว)
$C ps; docker stats --no-stream; free -h
$C exec api gs --version                                   # มี ghostscript ไว้บีบไฟล์ PDF ที่อัปโหลด
```
ทดสอบใน browser ด้วย account ของ IT:
- [ ] login แล้ว dashboard แสดงตัวเลข · เลือก "ทั้งหมด" ไม่ค้าง · จำนวนตรงกับ `MasterMemo` (ตามสิทธิ์)
- [ ] เปิด memo **เก่า** แล้ว PDF และไฟล์แนบโหลดได้ (พิสูจน์ว่า mount 45GB ถูกต้อง)
- [ ] สร้าง memo ทดสอบพร้อมไฟล์แนบ → approve → **อีเมลเข้าจริง** → กดลิงก์ approve ในอีเมลได้
- [ ] ไฟล์แนบเรียงตามลำดับที่ลากไว้ · PDF สแกนที่อัปโหลดมีขนาดเล็กลง (`$C logs api | grep PdfCompress`) · ไฟล์ใน comment ดาวน์โหลดได้และชื่อไทยถูกต้อง
- [ ] ลิงก์ approve ในอีเมลที่ส่งไป**ก่อน** cutover ยังใช้ได้ (ยืนยันว่า `EMAIL_TOKEN_SECRET` ตรง)
- [ ] หน้า admin, CC, การแจ้งเตือน
- [ ] `$C logs --tail 200 api` ไม่มี error ซ้ำๆ

ผ่านแล้ว → **เปิดระบบ** แจ้ง user · จดเวลาจบ downtime `__:__`

## 7. หลังเปิดระบบ

- เฝ้าดู 1–2 ชม.แรกด้วย `$C logs -f api` และ `docker stats` (api จำกัด 1g, เครื่องไม่มี swap)
- `docker logout ghcr.io` (หรือเก็บ PAT ไว้ใช้รอบหน้า)
- cron `db_backup.sh` ยังทำงานเหมือนเดิม เพราะ Postgres ยังอยู่บนเครื่อง
- จดสิ่งที่เจอลง `.claude/agents/deployer-notes.md`

## 8. หลังระบบนิ่งแล้ว 1–2 สัปดาห์ (ค่อยโละของเก่า)

- `pm2 delete hlememo-backend` · `pm2 unstartup`
- `sudo apt purge nginx` (หรือ disable ไว้เฉยๆ) · `sudo systemctl disable --now certbot.timer`
- ย้าย/ลบ `/var/www/hlememo/{backend,frontend}`
- **ปิด pg_hba `0.0.0.0/0`** · เปลี่ยนรหัส DB และย้ายจาก `db_backup.sh` ไป `~/.pgpass`
- ย้าย `.github/workflow-drafts/deploy-prod.yml` → `.github/workflows/` และตั้ง environment `production` ให้ต้องมีคน approve

---

## R. Rollback (~5 นาที)

ใช้ได้ทุกเวลาก่อนลบของเก่าในขั้น 8:
```bash
cd ~/hyper && docker compose -f docker-compose.prod.yml down
sudo systemctl enable --now nginx
pm2 start hlememo-backend && pm2 save
curl -fsS https://e-approval.hylifeconnect.com/api/health || curl -sI https://e-approval.hylifeconnect.com/
```
- index และ column `AttachedFile.orderNo` ที่ migrate เพิ่มเข้าไปไม่มีผลกับ Express (column มีค่า default) จึงไม่ต้องลบ ตาราง `_prisma_migrations` ก็ปล่อยไว้ได้
- ไฟล์ PDF ที่ถูกบีบระหว่างนั้นยังเป็น PDF ปกติ Express เปิดได้เหมือนเดิม
- ถ้าข้อมูลเสียหายจริง (ไม่น่าเกิด เพราะไม่มีการแก้ข้อมูล): `pg_restore --clean -d hlememo <pre-cutover dump>` ต้องปิดทั้งสองระบบก่อน
