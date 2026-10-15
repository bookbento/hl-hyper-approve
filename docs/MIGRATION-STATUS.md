# HL Hyper Approve — สถานะการ revamp (Express → NestJS monorepo)

อัปเดตล่าสุด: 2026-10-15 — **ย้ายครบแล้ว ถอด Express (`backend/`) และ gateway ออกแล้ว** (branch `devcompany`, ยังไม่ได้ deploy ขึ้น production)
ตัวเดิม: `C:\Bookbik\HL-E-APPROVAL` (commit สุดท้าย `0dc6d6f` 2026-05-27 — หลังจากนั้นไม่มีงานใหม่ให้ตามมา port)

## โครงสร้างปัจจุบัน

```
apps/api            NestJS (port 3001) — ทุก route + memo-expiry cron
frontend            React (Vite) — dev proxy /api → localhost:3001
packages/database   @hl/database — Prisma schema + migrations + seed + client ตัวเดียว (build เป็น dist/ ตอน postinstall)
```

Nest ฟังที่ 3001 ซึ่งเป็น port เดิมของ Express ทั้ง nginx (`upstream hlememo_backend`) และ Vite proxy จึงไม่ต้องแก้
ไม่มี gateway/proxy แล้ว route ที่ไม่มีใครรับจะได้ 404 ของ Nest

- dev: `pnpm dev` (api + frontend) — env ของ api ต้อง export เอง หรือใช้ `node --env-file=.env` (ดู `apps/api/env-example.txt`)
- production: `sudo ./deploy-production.sh` (ดู "Deploy ครั้งแรกหลังถอด Express" ด้านล่าง)
- parity script ของแต่ละ batch (`apps/api/scripts/compare-*.js`) ต้องใช้ `backend/` จึงลบไปพร้อมกัน ดูได้ที่ commit `6e3c883`

## ย้ายแล้ว

| Batch | Module (Nest) | หมายเหตุ |
|---|---|---|
| 1 | business-unit, department, type, admin-log, cc-group | |
| 2 | auth, user | |
| 3 | user-signature, file-serving (`/api/secure-uploads/*`) | + `common/upload/upload.config.ts` |
| 4 | approval-line, memotype | |
| 5 | notification, loa-management, memocc | |
| 6a | memo-query (list/get/search/search-stats/references/awaiting/current-approvers) | ⚠️ ดู "หนี้ที่ค้าง" ข้อ 1 |
| 6b | memo-lifecycle (create/update/delete/force-delete/renew-expiry/upload-main) | |
| 6c | memo search pipeline (`memo-query/search/*`, `memo-search.service.ts`) | port จริงแทน bridge ที่ require ไปหา backend (ซึ่งพังอยู่) |
| 8a-1 | memo-pdf: GET `/memos/:id/download[/:filename]`, `/raw`, `/pdf` + `memo-pdf/pdf.core.ts` | `pdf.core` ย้ายมาแบบแก้แค่ import แล้วผ่าน prettier เทียบกับ Express ทีละ byte บนข้อมูลจำลอง (memo 40 ฉบับ × final/preview/signed) ได้ 120/120 ตรงกัน ฟอนต์ฝังครบ |
| 8a-2 | memo-notification (ไม่มี route): `MemoNotificationService` notifyStatusUpdate/notifyCcAssigned/notifyRecallUpdate/sendEmailsAsync/pushNoti + `email-token.ts` + templates | ยังไม่มีใครเรียก (approve/recall/extra ย้ายใน 7b/8b) backend ยังตัดไม่ได้ ผล parity ดูหมายเหตุ 8a-2 |
| 7b | extra-approval: `/memos/:id/extra-approval-lines` (POST/GET), `.../active`, `/memos/extra-approval-lines/active/bulk`, `.../:lineId/action`, `.../:lineId/append`, DELETE `.../:lineId`, `.../eligible-users` (2 แบบ) | ดูหมายเหตุ 7b |
| 8b | memo-status: POST `/memos/:id/action-signature`, `/action`, `/status`, `/recall`, `/recall-preserve`, `/recall-clear`, GET `/memos/:id/actions`, `/memos/:id/approver-status`, POST `/memos/approver-status/bulk`, GET `/memos/action/email` (ไม่ต้อง login) | ดูหมายเหตุ 8b |
| 7a | memo-comment (GET/POST `/memos/:id/comments`, DELETE `/comments/:commentId`), memo-position (`/memos/signature`, `/date`, `/note`) + `common/mail` (MailService, EmailPreferenceService) | ลบ route ซ้ำ 4 ตัวใน `memo.routes.ts` แล้ว ดูหมายเหตุ 7a ด้านล่าง |
| 9 | memo-expiry: cron ทุกนาที (`@nestjs/schedule`, Asia/Bangkok) + `/api/dev/expiry/set/:memoId`, `/run`, `/reset/:memoId` | ดูหมายเหตุ 9 |
| 10 | health (`GET /api/health`), origin policy (CORS allow-list + ตัวกรอง no-origin ของ production), ถอด gateway + `backend/` | ดูหมายเหตุ 10 |

## Express

ถอดออกแล้วทั้งหมด (`e49af3c`) ไม่มีอะไรเหลือบน Express

### Deploy ครั้งแรกหลังถอด Express

`deploy-production.sh` ทำให้อัตโนมัติ แต่ควรรู้ว่าจะเกิดอะไร:

1. **env ย้ายไป `apps/api/.env`** (pm2 ส่งให้ด้วย `node --env-file`) ครั้งแรกสคริปต์ copy มาจาก `backend/.env` ให้
   ต้องเพิ่มเองถ้ายังไม่มี: `TRUST_PROXY_HOPS=1`, `APP_BASE_URL`, `EMAIL_TOKEN_SECRET`, `FRONTEND_URL`, `SMTP_HOST`, `SMTP_FROM`
   (`JWT_SECRET` ห้ามเป็น `changeme`) ถ้าขาด Nest จะไม่บูตและบอกรายการที่ขาดทั้งหมดในครั้งเดียว
2. **migration:** production ใช้ `prisma db push` มาตลอด ไม่มีตาราง `_prisma_migrations` สคริปต์จะเทียบ DB จริงกับ
   `schema.prisma` ถ้าต่างกันแค่ index B1 จะ `migrate resolve --applied 0_init` แล้ว `migrate deploy` (สร้าง index)
   ถ้าต่างมากกว่านั้นจะหยุดและพิมพ์ SQL ให้ตรวจเอง
3. **pm2:** ลบ `hlememo-backend` (Express) แล้วเริ่ม `hlememo-api` (`apps/api/ecosystem.config.js`, instance เดียว
   เพราะ cron อยู่ใน process) บน 3001 nginx ไม่ต้องแก้
4. **โฟลเดอร์ `/var/www/hlememo/backend`** บน server จะเหลือแต่ไฟล์ที่ไม่อยู่ใน git สคริปต์ไม่ลบให้
   ตรวจ `backend/uploads` และ `backend/src/uploads` ก่อนลบเอง (nginx ยังมี `/source-uploads/` ชี้ไปที่ `backend/src/uploads`)
5. rollback: ดูหัวไฟล์ `deploy-production.sh`

### หมายเหตุ 9 (memo-expiry)

- **เทียบกับ Express:** clone DB จำลอง (memo 300, วันหมดอายุกระจายรอบเวลาอ้างอิงทั้งหมดอายุแล้ว/ใกล้หมด 1–3 วัน/ข้ามเที่ยงคืนไทย, ครึ่งหนึ่ง Processing, มี extra line, CC, ปิดรับอีเมล, pivot Expired เดิม, reminder ที่ส่งไปแล้ว, SMTP ปฏิเสธบางคน) แล้วรัน sweep 17 รอบที่เวลาเดียวกันทั้งสองฝั่ง เทียบอีเมลทุกฉบับและแถวใน MemoStatusPivot, MemoHistory, Notification ได้ **3,148 checks ต่างกัน 0** (อีเมล 827 ฉบับ, reminder 136, หมดอายุ 198) สคริปต์อยู่ที่ commit `f10dd8c` (`compare-memo-expiry.js`)
- **ต่างจากเดิม:**
  - กัน sweep ซ้อนกัน: ถ้ารอบก่อนยังไม่จบ (SMTP ช้า) รอบใหม่จะข้าม เดิม node-cron ยิงซ้อนได้และส่ง reminder ซ้ำ
  - `MEMO_EXPIRY_CRON=off` ปิด cron ได้ (e2e ตั้งไว้ใน `test/setup-env.ts`) ต้องมี process เดียวที่รัน ไม่งั้นอีเมลออกสองรอบ
  - หา status id ของ waiting/Expired ครั้งเดียวต่อรอบ (เดิมหาใหม่ทุก memo) และล้าง cache stats/facets ของ search เมื่อเปลี่ยนเป็น Expired (C2)
  - ตัด `logoAttachment()` ที่ไม่มีใครใช้ (ส่ง `[]` ตลอด)
- **`/api/dev/expiry/*`:** เดิมไม่มี auth เลยและเปิดใน production ด้วย ตอนนี้ต้องเป็น admin และไม่ register เมื่อ `NODE_ENV=production` (ได้ 404)
- **ของเดิมที่คงไว้:** การแจ้งเตือนในระบบก็กรองด้วย email preference (`near-expiry`/`status-expired`) เหมือน Express, ไม่มีการเขียน `[expiry:expired]` จริง สิ่งที่กันอีเมลซ้ำคือ pivot Expired

### หมายเหตุ 10 (ถอด Express)

- **ของที่ Express ทำอยู่หน้าทุก route และย้ายมาแล้ว:** CORS allow-list (`CORS_ORIGIN`, `FRONTEND_URL`, `APP_BASE_URL`, `FRONT_BASE_URL`, `https://e-approval.hylifeconnect.com` + localhost นอก production) ตอบ 403 `CORS_NOT_ALLOWED` กับ origin อื่น และตัวกรอง production ที่ปฏิเสธ request ที่ไม่มี Origin (ยกเว้น same-origin/same-site, referer ที่อนุญาต, `/api/health`, ลิงก์อีเมล) — `common/http/origin-policy.ts`, JSON body limit 5mb
- **ทดสอบบูตจริง:** `node --env-file dist/main.js` แบบ production บน DB จำลอง: health 200, ไม่มี Origin 403, same-origin ไม่ login 401, origin แปลก 403, origin ที่อนุญาตได้ header CORS, `/api/dev/expiry/run` 404, cron รันตอนบูตและส่งเมลพลาดก็ไม่ล่ม
- **migration:** ไฟล์ `.sql` ใน `backend/prisma/migrations` ไม่เคยถูก commit (`.gitignore` มี `*.sql`) และเรียงลำดับผิด (`20250113_add_user_delegation` มาก่อน `init`) สร้าง DB ใหม่ไม่ได้ จึงทำ baseline `0_init` จาก `schema.prisma` + `20261015000000_memo_status_pivot_latest_idx` (B1) และเพิ่ม `!packages/database/prisma/migrations/**/migration.sql` ใน `.gitignore` ของเดิมเก็บไว้ในเครื่องที่ `packages/database/prisma/legacy-migrations/` (ไม่อยู่ใน git)
- **seed:** ขยับ sequence ทุกตารางหลัง insert id ตายตัว (เดิม insert ครั้งต่อไปชน id) seed ยังไม่มี status `Expired`/`Deleted` — ถ้าใช้กับ DB ใหม่ต้องเพิ่มตาม id ของ production
- `scripts/init-notification-preferences.ts` → `pnpm db:init-preferences` (packages/database)

### หมายเหตุ 8b

- **เทียบกับ Express ด้วย `apps/api/scripts/compare-memo-status.js`:** clone DB เป็นสองชุดให้ Express (ชุด A) กับ Nest (ชุด B) รันลำดับเดียวกัน อ่าน approver-status ทุก memo (300) + bulk ทุก user แล้วไล่ memo Processing ทีละฉบับ: approve แบบมีลายเซ็น+เงื่อนไข / `/action` / reject และ terminate ผ่าน `/status` / ลิงก์อีเมล approve, reject (redirect), กดซ้ำ, token เก่า, memo หมดอายุ, terminate / approver คนถัดไป / approve ซ้ำ (409) / recall-clear → draft → publish / recall-preserve / recall แบบเก่า / `/status` 6, 3, 99 / `/action` recalled, processing, terminated, code ผิด ได้ **628 checks ต่างกัน 0** ข้อมูล 7 ตาราง (MemoStatusPivot, MemoHistory, MemoApproverAction, Notification, ExtraApprovalLine, ExtraApprover, Comment) ตรงกันทุกแถว
- **สถานะล่าสุดเสมอกันได้:** ทุกที่หา "สถานะล่าสุด" ด้วย `orderBy createdAt desc` อย่างเดียว ข้อมูลจำลองมี 33 memo ที่มี pivot 2 แถว `createdAt` เท่ากัน รอบแรก memo 148 ได้ผลต่างกันระหว่าง A กับ B เพราะ Postgres คืนแถวไหนก่อนก็ได้ (Express ก็เป็นแบบนี้) พอขยับ `createdAt` ให้ไม่ซ้ำแล้วตรงกันหมด → ✅ เพิ่ม `id desc` แล้ว (`fcec9b7`)
- **แก้สิทธิ์ที่หลวม:**
  - `/status`, `/recall`, `/recall-preserve` ใช้ user จาก JWT ไม่เชื่อ `userId` ใน body แล้ว และต้องผ่าน `canViewMemo` (`/recall-clear`, `/actions` ด้วย) frontend ส่ง `userId = me.id` อยู่แล้วจึงไม่กระทบ
  - `/action` ต้องเป็น approver ของ `loaUserId` นั้นหรือผู้รับมอบอำนาจที่ยังมีผล (เหมือน `/action-signature`) เดิมใครก็ approve แทนใครก็ได้
  - `GET /memos/:id/approver-status` ใช้กฎเดียวกับ bulk (เห็น memo ใน list ได้ ไม่ใช่ Draft ของคนอื่น ไม่ใช่ Deleted) เดิมไม่เช็กอะไร ใน parity นับเป็น "intended" 37 ครั้ง
- **ยังหลวมอยู่ (คงไว้เหมือนเดิม รอตัดสินใจ):** `/status` statusId 3 (ตั้ง Approved ตรงๆ) และ 4 (reject) เช็กแค่ `canViewMemo` ไม่ได้เช็กว่าเป็น approver, `/recall` แบบเก่าไม่เช็กสถานะ frontend ไม่ได้เรียก `/recall`, `/recall-preserve`, `/actions`, `/status` 3/6 และ `/action` code อื่นนอกจาก approved เลย ถ้าไม่มี client อื่นควรลบทิ้ง
- **บั๊กเดิมที่คงไว้ (Express ก็ 500 เหมือนกัน):** `/recall` แบบเก่า create pivot 6 ชน unique ถ้าเคย recall แล้ว, `/action` recalled ชนกันแบบเดียวกันใน `handleRecall`, ลิงก์อีเมล terminate create pivot 7 ชน unique ถ้า owner เคยมีแถว 7
- **ต่างจากเดิม:** งานหลังตอบ (setImmediate) มี `.catch` ครบ (เดิม reject/recall ผ่าน `/status` ไม่มี) memo ที่ไม่มีอยู่ได้ 404 แทน 500 ลิงก์อีเมล terminate ไม่ update แถว action ซ้ำครั้งที่สอง (ค่าเดียวกัน) ตัด debug log รายแถวของ approver-status ทิ้ง
- **หน้า static:** หน้าผลของลิงก์อีเมล (`backend/views/email-actions/*.html`) ยกมาเป็น `memo-status/email-action.pages.ts` ทีละ byte ส่วน `/img` ไม่มีหน้าไหนใช้แล้ว (config รูปใน Express ไม่ได้ render) ลบทิ้งพร้อม `backend/fonts` (Nest มีชุดของตัวเองที่ `apps/api/fonts`)
- **C2 ทำแล้วบางส่วน:** `MemoSearchNestService.invalidateAll()` ล้าง cache stats/facets ทุกครั้งที่ 8b เขียนสถานะ (ล้างทั้งหมดเพราะการเปลี่ยนสถานะครั้งเดียวกระทบ owner, approver และ CC) ส่วน create/update/delete ใน memo-lifecycle ยังรอ TTL 60 วินาที
- **B3 เลื่อนไป (ยังไม่ทำ ดู Performance):** ถ้า denormalize `currentStatusId` ลง `MasterMemo` ตอนนี้ cron หมดอายุที่ยังอยู่บน Express จะเขียน pivot โดยไม่อัปเดตคอลัมน์ใหม่ ทำหลัง port cron (และต้องมี migration ซึ่งรอย้ายไป `packages/database`)
- **backend เหลือ 7 ไฟล์:** ลบ controller/service/lib/middleware ที่ไม่มีใครใช้, `views`, `fonts` และ vitest ของ service ที่ลบ (`vitest` ตั้ง `passWithNoTests`) test ที่ fail บน Windows (หนี้ข้อ 5) หายไปพร้อมไฟล์
- **`assertConfig`:** production ต้องมี `APP_BASE_URL` (http/https) และ `EMAIL_TOKEN_SECRET` แล้ว

### หมายเหตุ 7b

- **เทียบกับ Express:** endpoint ที่อ่านอย่างเดียว (list/active/bulk/eligible-users) ใช้ `apps/api/scripts/compare-extra-approval.js` ได้ 6,075/6,075 ตรงกัน ฝั่งเขียน clone DB เป็นสองชุดให้ Express กับ Nest รันลำดับเดียวกัน (memo Processing 40 ฉบับ × create/act approve/reject/ซ้ำ/append/create แบบ pre-approved/remove/statusCode ผิด รวม 396 ครั้ง) response, อีเมล และการเรียก notify ตรงกัน ข้อมูลใน 6 ตาราง (ExtraApprovalLine, ExtraApprover, Comment, Notification, MemoHistory, MemoStatusPivot) ตรงกันทุกแถว ส่วนที่ต่างกันมีแค่ลำดับแถวจาก query ที่ไม่มี `orderBy` (ทั้ง approver ใน response ของ create และลำดับ notification ตอนลบ line)
- **แก้สิทธิ์ที่หลวม:** GET list และ GET active ตอนนี้ต้องผ่าน `canViewMemo` เดิมใครที่ login แล้วก็อ่าน extra line ของ memo ไหนก็ได้
- **ต่างจากเดิม:** approver ใน response ของ create เรียงตาม id แล้ว (เดิมไม่มี orderBy ลำดับสุ่ม) id ใน path ที่ไม่ใช่ตัวเลขได้ 400 (เดิม Prisma error เป็น 500) ตัด `makeEmailToken` ที่สร้างแล้วไม่ได้ใช้ (และส่ง argument สลับกัน) กับการเช็ก "approver ระดับปัจจุบัน" ใน eligible-users ที่ซ้ำกับ "approver ใน version ล่าสุด" ออก
- **`/append` frontend ไม่ได้เรียก:** port ไว้ตามเดิม
- ~~**backend ยังเหลือ `hasActiveExtraLine`**~~ ลบแล้วใน 8b

### หมายเหตุ 8a-2

- **template อีเมลยกมาจาก Express แทบทั้งหมด:** อยู่ที่ `memo-notification.templates.ts` ส่วนที่ query DB ย้ายเข้า service พร้อม `getApproverLineStatus` (เดิมอยู่ที่ `backend/src/approverLine.ts`) และ `getPendingActions`
- **เทียบกับ Express ด้วย `apps/api/scripts/compare-memo-notification.js`:** รันบน DB ชั่วคราว (สคริปต์นี้เขียนลง DB) เทียบอีเมลทุกฉบับ (to/subject/text/html/sha ของไฟล์แนบ), notification ที่สร้าง และ emailToken ข้อมูลจำลองมี memo 300 ฉบับ × 8 กรณี (status 5/3 กลางสาย/3 ระดับสุดท้าย/4/7 + reason override, CC assigned ×2, recall) รวม user ที่ปิดรับอีเมลบางประเภท การมอบอำนาจทั้งที่ยังมีผลและหมดอายุ การอนุมัติแทน ระดับ ANY และวันหมดอายุ ได้ 2,399/2,400 ตรงกัน (อีเมล 3,453 ฉบับ) อีก 1 กรณีที่ไม่ตรงเป็นเรื่องลำดับแถวในระดับเดียวกัน (ดูข้อถัดไป) รัน memo นั้นแยกแล้วตรงกันทุกรอบ
- **ลำดับ approver ในระดับเดียวกันไม่คงที่:** query `orderBy level` + `distinct` ไม่มีตัวตัดสินลำดับกรณีเสมอกัน ทั้ง Express และ Nest จึงเรียงคนในระดับเดียวกันสลับกันได้ ทั้งในตารางอีเมลและในลำดับผู้รับ → ✅ เพิ่ม `loaUserId` เป็นตัวตัดสินแล้ว (`fcec9b7`)
- **ต่างจากเดิม:** การส่งอีเมลแบบไม่รอผล (`void sendEmailsAsync`) มี `.catch` แล้ว ไม่หลุดเป็น unhandled rejection และตัด `notification.findMany` ที่ดึงมาแล้วไม่ได้ใช้ทิ้ง
- ~~**ตอนทำ 8b ต้องเพิ่ม `EMAIL_TOKEN_SECRET` และ `APP_BASE_URL` ใน `assertConfig`**~~ ทำแล้ว

### หมายเหตุ 8a-1

- **ของที่หายตอนย้าย repo (กู้คืนแล้ว):** ฟอนต์ PDF/ลายเซ็น (`backend/fonts`, `frontend/public/fonts`, และชุดของ Nest ที่ `apps/api/fonts`) และหน้าผลลัพธ์ของลิงก์ในอีเมล `backend/views/email-actions/*.html` ก่อนกู้ PDF ที่ Express สร้างใช้ Helvetica แทน ภาษาไทยจึงพัง
- **แก้บั๊กเดิม:** `/raw` ใส่ชื่อไฟล์ภาษาไทยลงใน `filename="…"` ตรงๆ ทำให้ได้ 500 เสมอ และ resolve ไฟล์จาก cwd แทน `UPLOADS_DIR` (frontend ไม่ได้เรียก `/raw` จึงไม่มีใครเห็น)
- **`pdf.core` ใช้ `prisma` จาก `@hl/database` ตรงๆ (ไม่ผ่าน DI):** ใน e2e ต้อง `jest.mock` ตัวไฟล์นี้
- **เพิ่ม prettier (`apps/api/.prettierrc`):** singleQuote, trailingComma all, printWidth 100 ใช้เฉพาะกับไฟล์ใหม่ เพราะไฟล์เดิมหลายไฟล์ไม่ได้จัดด้วย prettier มาก่อน

### หมายเหตุ 7a

- **Nest เริ่มส่งอีเมลแล้ว:** production ต้องมี `FRONTEND_URL`, `SMTP_HOST`, `SMTP_FROM` (`assertConfig` บังคับ) และ `SMTP_PORT/USER/PASS/SECURE/REQUIRE_TLS` ตามเดิม
- **แก้สิทธิ์ที่หลวมจากตัวเดิมแล้ว:** อ่าน/โพสต์ comment ต้องผ่าน `canViewMemo` (กฎเดียวกับการเปิด memo) และลบได้เฉพาะเจ้าของ comment (ตรงกับ UI ที่แสดงปุ่มลบเฉพาะ `isMe && hasMentions`) ถ้าถูกปฏิเสธ ไฟล์ที่ multer เขียนไว้จะถูกลบทิ้ง
- **ยังค้าง:** positions เขียน body ลง DB ตรงๆ รวมถึง `userId` จาก body และ frontend ไม่ได้เรียกใช้ ควรลบ endpoint ทิ้ง (รอเจ้าของระบบยืนยัน)
- **ต่างจากเดิมเล็กน้อย:** ไฟล์เกิน 50MB ได้ 413 (เดิม 400 `FILE_TOO_LARGE`) ซึ่ง frontend มีข้อความรองรับ 413 อยู่แล้ว ส่วนไฟล์เกิน 6 ได้ 400 ข้อความของ Nest
- ~~**โค้ดที่ไม่มีใครเรียกแล้วแต่ยังค้างใน backend:**~~ (backend ถูกลบทั้งหมดแล้ว) handler ของ 6a ใน `memoQuery.service` (รวม getApprovers/getBusinessUnits/getApprovalLines/getMemoApprovalLine) และ `memoLifecycle.service` ของ 6b ยังลบไม่ได้ทั้งไฟล์เพราะ `getWaitingStatusId` ยังถูกใช้ ให้ลบตอนถอด Express

## หนี้ (ปิดครบแล้ว)

1. ~~**memo search ยังไม่ได้ port จริง**~~ ✅ port แล้ว (6c) เดิม bridge require ไปผิด path ทำให้ `/api/memos/search` กับ `/search/stats` ตอบ 500 ตั้งแต่ 6a
   logic คงเดิมทุกบรรทัด (SQL คัดลอกมาตรงตัว) แยกเป็น `search/{filters,resolvers,items,aggregates,timing,types,display-name}.ts` และเพิ่ม spec ที่ mock Prisma ไว้
   เทียบผลแล้ว (2026-10-09) ด้วย `apps/api/scripts/compare-memo-search.js` บน Postgres 17 ชั่วคราวที่สร้างข้อมูลจำลองเอง (memo 300, action 1,210 แถว รวมหลาย version, level ANY/ALL, extra line, CC, comment tag, timestamp ที่เท่ากัน)
   เทียบ 952 ครั้ง (user 35 คน × request 27 แบบ + stat counts) ไม่มีจุดต่าง แต่ยังไม่ได้รันกับข้อมูล production จริง ถ้ามีสำเนา DB ให้รันซ้ำอีกรอบ (`COMPARE_USERS=N`)
   `backend/src/services/memoSearch.service.ts` ยังลบไม่ได้ เพราะ `memoQuery.service` ของ backend (ที่ memo.routes/controller ยังใช้) import อยู่
2. ~~**Prisma 2 pool ใน process เดียว**~~ ✅ แก้แล้ว (A2): `PrismaService` เป็น DI token ที่ bind กับ `prisma` ของ `@hl/database` (ฝั่ง Nest เหลือ 1 pool ส่วน Express ยังเป็นอีก process จนกว่าจะถอดออก)
3. ~~**`deploy-production.sh` ยัง deploy แบบเดิม**~~ ✅ เขียนใหม่ (`ded11a1`): pnpm workspace, `apps/api/ecosystem.config.js` (`hlememo-api` บน 3001 จึงไม่ต้องแก้ nginx), env จาก `apps/api/.env` ผ่าน `node --env-file`, baseline + `migrate deploy`, health check — ดู "Deploy ครั้งแรกหลังถอด Express"
   migration ย้ายมา `packages/database` แล้ว (baseline `0_init` เพราะของเดิมไม่เคยอยู่ใน git และเรียงผิด) และ `seed.ts` ขยับ sequence แล้ว ทดสอบบน DB เปล่า: migrate → seed → insert user ได้, seed ซ้ำได้
4. ~~**`main.ts` ยังไม่มี `app.enableShutdownHooks()`**~~ ✅ แก้แล้ว (A1): `PrismaModule.onApplicationShutdown` เรียก `$disconnect()`
5. ~~**backend test ที่ fail อยู่แล้ว**~~ ไฟล์ถูกลบใน 8b: มี 2 test ใน `backend/src/__tests__/memoLifecycle.service.test.ts` (`absFromDbPath`) fail บน Windows มาก่อน A1–A4 (น่าจะเป็นเรื่อง path separator) ส่วน logic นี้ port ไป Nest แล้วใน 6b
6. ~~**`UPLOADS_DIR` คำนวณ 2 แบบ**~~ ✅ memo-query import จาก `upload.config` แล้ว (หา root จาก `pnpm-workspace.yaml` อย่างเดียว)

## Performance — สิ่งที่ควรหยิบมาใส่

รวบรวมจากเอกสารในตัวเดิม (`HL-E-APPROVAL/dashboard-memo-search-performance-recommendations.txt`,
`dashboard-search-migration-STATUS.txt`) และ pattern ที่ใช้อยู่แล้วใน sentral / malinmarket / food-review / HL-assets-management-inventory

### A. ทำพร้อมกับตอน port (ต้นทุนต่ำ)

| # | เรื่อง | ที่มา | รายละเอียด |
|---|---|---|---|
| A1 ✅ | `enableShutdownHooks()` | sentral, malinmarket, food-review `main.ts` | ปิด Prisma pool ให้เรียบร้อยตอน restart |
| A2 ✅ | Prisma client ตัวเดียว | sentral `packages/db/src/client.ts` | factory + lazy singleton, log `query` เฉพาะ dev (ดูหนี้ข้อ 2) |
| A3 ✅ | ตรวจ env ทั้งหมดตอนบูต | sentral/food-review `assertProductionConfig()` | เก็บปัญหาทุกข้อแล้ว throw ครั้งเดียว เช่น `DATABASE_URL`, JWT secret, `EXPRESS_TARGET`, SMTP จะได้ไม่ต้อง deploy ซ้ำทีละตัว |
| A4 ✅ | `trust proxy` ตาม hop | sentral `TRUST_PROXY_HOPS` | หลัง nginx ค่า `req.ip` ใน AdminLog/LoginLog จะถูก |
| A5 | เก็บ timing log ของ search | ตัวเดิม `MEMO_SEARCH_TIMING=1` | ตอน port memo search อย่าทิ้ง phase timing: hiddenIds/count/fetchItems/snapshots/stats/facets |
| A6 | จำกัด `pageSize` | ตัวเดิม ข้อ 6 | ใส่ `@Max(200)` ใน `search-memos.dto.ts` แล้วแยก export endpoint สำหรับดึงทั้งหมด |
| A7 | gzip | — | ทั้ง Express และ Nest ยังไม่มี `compression()` เช็ก nginx ก่อน ถ้า nginx ยังไม่ gzip `/api` ให้เปิดที่ nginx (ดีกว่าทำใน Node) |

### B. ฐานข้อมูล (ต้องทำ migration)

| # | เรื่อง | รายละเอียด |
|---|---|---|
| B1 ✅ | Index ของ latest status | `MemoStatusPivot` ตอนนี้มีแค่ unique `(memoId, userId, statusId)` แต่ query `DISTINCT ON` หา status ล่าสุดต่อ memo ต้องใช้ `(memoId, createdAt DESC, id DESC)` |
| B2 | Index อื่นที่เอกสารเดิมแนะนำ | `MemoApproverAction(memoId, version)`, `LineOfApprovalUserPivotForUse(userId, level)`, `ExtraApprover(userId, extraId, actedAt)`, `ExtraApprovalLine(memoId, status)`, CC `(userId, memoId)`, `CommentTag(userId, memoId)` ให้ตรวจด้วย `EXPLAIN ANALYZE` ก่อนเพิ่ม |
| B3 | Denormalize `currentStatusId` + `latestActionAt` ลง `MasterMemo` | ไม่ต้องใช้ `DISTINCT ON` ทุก request ทำให้ filter/count/sort ด้วย latest action ได้ตรงๆ ควร set ในจุดเดียว (service ที่เขียน status pivot / approve action) ตอน port batch 8 แล้วแนบ backfill script ไปด้วย |
| B4 | `pg_trgm` สำหรับ text search | ค้น `subject`, `memonumber`, ชื่อผู้ใช้ ด้วย `contains` ตอนนี้ scan ทั้งตาราง เปลี่ยนเป็น GIN `gin_trgm_ops` |

### C. API / ฝั่ง frontend

| # | เรื่อง | ที่มา | รายละเอียด |
|---|---|---|---|
| C1 | แยก rows ออกจาก stats/facets | ตัวเดิม ข้อ 1 | มี `/api/memos/search/stats` แล้ว ให้ทำ facets แบบเดียวกัน แล้วให้ frontend โหลดเป็น background |
| C2 (บางส่วน) | Cache invalidation | ตัวเดิม ข้อ 2 | LRU cache ของ stats/facets ตอนนี้หมดอายุตาม TTL 60 วินาทีอย่างเดียว ยังไม่มีการ invalidate เมื่อ approve/create พอ batch 8 ย้ายมาอยู่ process เดียวกันแล้ว ค่อยเพิ่ม `invalidateUser(userId)` ใน service ที่เปลี่ยน status |
| C3 | Keyset pagination | sentral `center-*.service.ts` (`cursor: { id }, skip: 1`) | ใช้กับ list ที่โตไม่หยุด เช่น admin-logs, notifications, login logs แทน `skip/offset` ส่วนตาราง dashboard ที่ต้องกระโดดไปหน้าไหนก็ได้ ใช้ offset ต่อไป |
| C4 | TanStack Query `staleTime` | HL-assets-management-inventory `DashboardShell.tsx` (`staleTime: 60_000`) | frontend ตัวนี้ยังไม่มี data-fetching cache ทุกหน้า fetch ใหม่หมด ควรเริ่มที่ข้อมูล master เช่น BU, department, type, memotype, user list |
| C5 | Virtualized list | kuji `@tanstack/react-virtual` | ใช้กับตาราง/dropdown ที่ยาวมาก เช่นเลือก user ใน CC หรือ approval line |
| C6 | Lazy-load ข้อมูลหนักของแถว | ตัวเดิม ข้อ 5 | approver snapshots, latest comment, history ให้โหลดตอน expand/hover แทนการ enrich ทุกแถว |

ทำ A1–A4 เสร็จแล้ว (2026-10-09): `common/config/assert-config.ts` ตรวจ `DATABASE_URL`, `TRUST_PROXY_HOPS`, `EXPRESS_TARGET` และใน production ตรวจ `JWT_SECRET` กับ `TRUST_PROXY_HOPS>=1`
(7a เพิ่มการตรวจ `FRONTEND_URL`/SMTP ใน production แล้ว) ส่วน `auth.controller` เปลี่ยนจากอ่าน `x-forwarded-for` เองมาใช้ `req.ip` และ Express ตั้ง `trust proxy` เป็น hops+1 (แทน `true`)
ระหว่างทำพบด้วยว่า `apps/api` ไม่ได้ประกาศ `multer` เป็น dependency ทำให้ `node dist/main` บูตไม่ได้หลัง `pnpm install` แก้แล้ว

B1 ทำแล้ว (migration `20261015000000_memo_status_pivot_latest_idx`) พร้อม tie-breaker `id desc` ทุกจุดที่หาสถานะล่าสุดด้วย Prisma (`common/latest-status-order.ts`, SQL ของ search มีอยู่แล้ว)
และ `loaUserId` เป็นตัวตัดสินลำดับ approver ในระดับเดียวกัน (หมายเหตุ 8a-2)

**B3 ยังไม่ทำโดยตั้งใจ:** การมีสถานะซ้ำสองที่ (pivot + คอลัมน์ใน `MasterMemo`) ต้องอัปเดตทุกจุดที่เขียน pivot (memo-status, recall, extra-approval, email-action, lifecycle, expiry) ถ้าพลาดจุดเดียวข้อมูลจะไม่ตรงกันแบบเงียบๆ
ควรวัด A5 กับ `EXPLAIN ANALYZE` บนข้อมูล production หลังมี index B1 ก่อน ถ้ายังช้าค่อยทำพร้อม backfill

ลำดับที่แนะนำต่อจากนี้: deploy → วัด A5 บนข้อมูลจริง → C1/C2 → B3 ถ้ายังจำเป็น → ที่เหลือตามที่วัดได้

## งานถัดไป

- [x] A1–A4
- [x] Port `memoSearch.service` เข้า Nest (6c)
- [x] เทียบผล memo search กับตัวเก่าบนข้อมูลจำลอง (952/952 ตรงกัน) — ถ้ามีสำเนา production ให้รันซ้ำ
- [x] **Batch 7a**: comments + positions + mail infra + ลบ route ซ้ำ
- [x] **Batch 8a-1**: `pdf.core` + PDF download
- [x] **Batch 8a-2**: `memoNotification.service` (notifyStatusUpdate/notifyCcAssigned/notifyRecallUpdate, pushNoti, email token) → Nest
- [x] **Batch 7b**: extra-approval-lines → Nest (ใช้ notifyStatusUpdate จาก 8a)
- [x] **Batch 8b**: approve/action/status/recall/email-action → Nest (C2 บางส่วน, B3 เลื่อนไปหลัง cron)
- [x] **memo-expiry cron** → Nest (`@nestjs/schedule`) — parity 3,148/3,148
- [x] `dev-expiry` port แล้ว (admin เท่านั้น, ไม่มีใน production)
- [x] หน้า static ของ Express ย้ายไปพร้อม email-action ใน 8b
- [x] tie-breaker `id desc` + index B1
- [x] ถอด `GatewayModule` + `backend/` ออก, ปรับ `package.json` root
- [x] เขียน `deploy-production.sh` ใหม่สำหรับ monorepo (หนี้ข้อ 3) + `serversetup.sh`
- [ ] **deploy ขึ้น production** (`sudo ./deploy-production.sh` บน branch `production`) แล้วทดสอบ login / approve / อีเมล / PDF
- [ ] รอเจ้าของระบบตัดสินใจ: endpoint ที่ frontend ไม่เรียก — positions (`/memos/signature`, `/date`, `/note`), `/recall`, `/recall-preserve`, `/actions`, `/status` 3/6 — และ `/status` 3/4 ที่เช็กแค่ `canViewMemo` (ดูหมายเหตุ 8b)
- [ ] B3 หลังวัดผลบน production (ดู Performance)
