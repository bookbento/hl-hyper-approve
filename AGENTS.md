# HL Hyper Approve — agent guide

ระบบ e-approval / memo อนุมัติของ HL (e-approval.hylifeconnect.com) ซึ่งเป็นตัวที่ย้ายจาก Express เดิมมาเป็น NestJS แล้ว
สถานะการย้ายระบบดูที่ `docs/MIGRATION-STATUS.md` · ตอบผู้ใช้เป็นภาษาไทย (ศัพท์เทคนิคใช้อังกฤษได้)

## Layout (pnpm monorepo)
| path | อะไร |
|---|---|
| `apps/api` | NestJS API (package `apps/api`) — modules อยู่ใน `src/modules/*`, guard/config/upload อยู่ใน `src/common/*` |
| `frontend` | React + Vite SPA (`my-react-app`), locales อยู่ที่ `public/locales/{th,en}` |
| `packages/database` | Prisma schema + client (`@hl/database`) และ migrations |

Express ตัวเดิม (ที่ยังรันบน prod) อยู่ใน repo แยก `C:\Bookbik\HL-E-APPROVAL` — ถ้าแก้บั๊กที่ต้นเหตุมาจากโค้ดเก่า ให้เช็คว่าต้อง port ไปฝั่งนั้นด้วยหรือไม่
| `docker/`, `docker-compose*.yml`, `.github/workflows` | deploy แบบ image (ดู agent `deployer`) |

## Commands
```bash
pnpm dev                      # api + frontend
pnpm --filter @hl/database build && pnpm --filter apps/api build
pnpm test:api                 # jest
pnpm --filter my-react-app test:run   # vitest
pnpm --filter my-react-app test:smoke # Playwright smoke (credentials from env)
cd apps/api && npx tsc --noEmit -p .
```
หมายเหตุ: frontend มี tsc error ค้างอยู่ก่อนแล้ว (`tsconfig.app.json` ~42 ตัว) เวลาเช็คให้ดูว่าจำนวน**ไม่เพิ่มขึ้น**

## Rules
- **prod 43.208.169.222 คือระบบที่ทั้งบริษัทใช้อยู่** — ทำได้แค่คำสั่งอ่านอย่างเดียว เว้นแต่ผู้ใช้อนุมัติขั้นนั้นๆ ชัดเจน
- เครื่อง dev 43.210.109.106 ใช้ร่วมกับระบบอื่น — แตะได้เฉพาะของ hlememo-dev (ดู `docs/DEV-SERVER.md`)
- ข้อมูลใน dev/test เป็นสำเนาที่มีอีเมลจริง → ห้ามตั้ง SMTP จริง
- state updater ของ React ต้องไม่มีผลข้างเคียง (เคยทำให้ไฟล์ซ้ำ 6→12 ใน `MemoForm.tsx`)
- PDF: ก่อนจะคำนวณตำแหน่งใดๆ ให้ normalize page box / rotation ก่อนเสมอ (`memo-pdf/pdf.core.ts`, `docs/WPS-PDF-INVERTED-MEDIABOX.md`)
- ห้าม commit secret · ข้อความ commit ใช้ conventional commits

## Skills & agents (`.claude/`)
- งาน security (auth, ไฟล์, การอนุมัติ, ลายเซ็น): skill `hyper-security-review` + agent `security-reviewer`
- deploy/infra: agent `deployer` (อ่านและจดลง `deployer-notes.md` ทุกครั้ง)
- รีวิวโค้ด: `typescript-reviewer`, `react-reviewer`, `database-reviewer`, `silent-failure-hunter`, `code-reviewer`
- ปิดงาน: skill `verification-loop` · locale th/en: `i18n-sync`
