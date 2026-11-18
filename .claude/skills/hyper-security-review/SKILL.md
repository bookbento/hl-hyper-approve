---
name: hyper-security-review
description: Security checklist specific to HL Hyper Approve (e-approval) — use when touching auth/JWT cookies, the one-click email approve token, file uploads or file serving (memo PDFs, attachments, signatures), approver/role permissions, PDF signature stamping, or deploy config and secrets. For generic web-security patterns use the `security-review` skill alongside this one.
metadata:
  origin: adapted from malinmarket-security-review (ECC)
---

# Hyper Security Review

Hyper holds signed company approvals, personal signature images and internal documents.
The worst outcomes are: someone approves a memo they shouldn't, reads a memo/file they
aren't on, or forges a signature stamp. Review every change against those three.

## When to Activate

- `apps/api/src/modules/auth`, `common/guards/*` (JWT, roles, self-or-admin)
- `modules/memo-notification/email-token.ts` or the `/api/memos/action/email` flow
- Upload handling (`common/upload/upload.config.ts`), `modules/file-serving`, `modules/user-signature`
- `modules/memo-lifecycle` (create/update/approve/reject), `approval-line`, `extra-approval`, `loa-management` (delegation)
- `modules/memo-pdf/pdf.core.ts` (what gets stamped where)
- `common/config/assert-config.ts`, Docker/compose/CI env, anything with secrets

## Checklist

### 1. Authorization: is the caller on this memo?
- [ ] Every memo/file endpoint uses `JwtAuthGuard` **and** checks the user is the creator, a current/past approver, a CC member, a delegate (LOA) or admin — not just "logged in".
- [ ] Approve/reject verifies it's **this user's turn** in the approval line (and the memo status allows it), inside the same transaction as the status write (no double-approve race).
- [ ] IDs from the body/params (memoId, fileId, userId) are never trusted for ownership; derive the actor from the JWT (`JwtPayload`).
- [ ] Role checks via `roles.guard.ts` / `self-or-admin.guard.ts`, not ad-hoc `if (user.role === ...)` scattered in services.

### 2. One-click email approve token
- [ ] Token signed with `EMAIL_TOKEN_SECRET` (`email-token.ts`), short expiry, bound to memoId + approver userId + action.
- [ ] On use: re-check it's still that approver's turn and the memo is still pending (token replay after someone else acted must fail).
- [ ] Never log full tokens or put them in error messages.

### 3. Files (uploads + serving)
- [ ] Paths resolved with `resolveSafeUploadPath()` — must stay under `UPLOADS_DIR` (no `../`, no absolute paths from the client).
- [ ] Files served only through `modules/file-serving` (JWT + memo access check). The legacy nginx `/uploads/` public alias on the old prod server is a known exposure — don't reintroduce a public static route in Caddy.
- [ ] Main files: PDF only (check magic bytes, not just extension/mimetype). Attachments: the extension allow-list in `MemoForm.tsx` must match the API's.
- [ ] Size limits consistent across layers: frontend 50MB, multer, Caddy/nginx body limit (100MB).
- [ ] Signature images (`user-signature`) only readable by the owner, admin, and the PDF renderer — never listable.

### 4. PDF stamping integrity
- [ ] Stamps are placed from server-stored positions, not client-supplied coordinates at approve time.
- [ ] Only the approver's own signature image is stamped for their step.
- [ ] Malformed PDFs (inverted MediaBox, `/Rotate`, encrypted) must not crash rendering or put stamps off-page — see `docs/WPS-PDF-INVERTED-MEDIABOX.md`.

### 5. Auth/session
- [ ] JWT cookie `httpOnly`, `secure` in production, `sameSite` set; `JWT_SECRET` never the `changeme` fallback (`assert-config.ts` enforces in production).
- [ ] Login rate-limited; LoginLog records the real client IP (`TRUST_PROXY_HOPS` = number of proxies, 1 behind Caddy/nginx).

### 6. Secrets & deploy
- [ ] No secrets in git, Docker images (`.dockerignore` excludes `.env*`) or compose files — they come from GitHub Secrets written to the server `.env` by CI.
- [ ] Postgres not reachable from the internet (pg_hba no `0.0.0.0/0`, security group closed on 5432). The old prod server currently violates this — tracked in the deploy plan.
- [ ] No DB passwords in shell scripts (use `~/.pgpass`, chmod 600).
- [ ] Dev/test copies of prod data: `SMTP_HOST` empty or a mail catcher — real users' emails are in the data.

### 7. Logging & PII
- [ ] AdminLog/LoginLog written for privileged actions; no passwords, tokens or full file paths of other users in logs or API errors.

## How to run a review
1. List changed files; map each to the sections above.
2. For each endpoint touched, trace guard → service → DB query and confirm the access rule.
3. Write findings as `file:line — what can go wrong — fix`. Severity: CRITICAL (approve/read without access, secret leak), HIGH, MEDIUM.
4. Add a regression test for every CRITICAL/HIGH fix (`*.spec.ts` next to the service).
