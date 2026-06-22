/**
 * memoNotification.service.ts
 *
 * Wave 5 extract: notification/email-dispatch logic for status-change events.
 * Moved from memoStatus.controller.ts — behaviour parity 100%.
 *
 * Responsibilities:
 *  - notifyStatusUpdate  (main status-change push + email)
 *  - notifyCcAssigned    (CC push + email when memo enters Processing)
 *  - notifyRecallUpdate  (CC push + email on Recall)
 *  - sendEmailsAsync     (fire-and-forget email for Processing approvers)
 *  - All email template helpers (buildPlain, buildHtml, buildCcPlain, buildCcHtml, etc.)
 *
 * NOT here (state machine — Wave 7):
 *  - evaluateAndUpdateMemoStatus
 *  - updateCurrentMemoStatus / updateCurrentMemoStatusTx
 *  - upsertStatusWithHistory
 */

import { sendEmail } from "../lib/mailer";
import { filterUsersForEmail } from "../lib/notificationPreferences";
import { prisma } from "../../prisma/client";
import { pushNoti } from "../lib/notify";
import { makeEmailToken } from "../lib/token";
import path from "path";
import { getApproverLineStatus } from "../approverLine";
import { createSignedPdfBuffer } from "./pdf.core";
import { getPendingActions } from "./memoApproval.service";
import { ExtraStatus } from "@prisma/client";
import {
  toDisplayName,
  getUserDisplayName,
  getLatestVersion,
} from "../controllers/memoStatus.controller";

const BASE_URL = process.env.APP_BASE_URL || "https://your-app.com";

if (!process.env.FRONTEND_URL) {
  throw new Error("Environment variable FRONTEND_URL is not set");
}
const FRONTEND_URL: string = process.env.FRONTEND_URL as string;

// ── Types ─────────────────────────────────────────────────────────────────────

export type StatusCode = "waiting" | "approved" | "rejected" | "terminated";

type CcEmailOptions = {
  statusId?: number;
  statusLabel?: string;
  detailLines?: string[];
};

// ── Tiny helpers ──────────────────────────────────────────────────────────────

// ── getClonePivotsForMemo (mirrors getClonePivots in controller) ───────────────

type ClonePivotLocal = {
  id: number;
  userId: number | null;
  level: number;
  approvalRequirement?: string;
  user: { id: number; name: string } | null;
};

async function getClonePivotsForMemo(memoId: number): Promise<ClonePivotLocal[]> {
  const latestVer =
    (
      await prisma.memoApproverAction.aggregate({
        where: { memoId },
        _max: { version: true },
      })
    )._max.version ?? 1;

  const rows = await prisma.memoApproverAction.findMany({
    where: { memoId, version: latestVer },
    orderBy: [{ loaUser: { level: "asc" } }],
    distinct: ["loaUserId"],
    select: {
      loaUser: {
        select: {
          id: true,
          userId: true,
          level: true,
          approvalRequirement: true,
          user: {
            select: { id: true, name: true, lastname: true, nickname: true },
          },
        },
      },
    },
  }) as any[];

  return rows.map((r: any) => ({
    id: r.loaUser.id,
    userId: r.loaUser.userId,
    level: r.loaUser.level,
    approvalRequirement: r.loaUser.approvalRequirement ?? "ALL",
    user: r.loaUser.user
      ? {
          id: r.loaUser.user.id,
          name:
            toDisplayName(r.loaUser.user, { includeNickname: true }) ||
            `User#${r.loaUser.user.id}`,
        }
      : null,
  }));
}


export function safeFilename(base: string, ext = ".pdf"): string {
  const name = String(base)
    .normalize("NFKD")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
  return `${name}${ext}`;
}

export function formatExpiresAt(dt?: Date | null): string | null {
  if (!dt) return null;
  try {
    return dt.toLocaleString("th-TH", {
      timeZone: "Asia/Bangkok",
      hour12: false,
    });
  } catch {
    return dt.toISOString().replace("T", " ").replace("Z", " UTC");
  }
}

function norm(code?: string): StatusCode {
  const c = (code ?? "").toLowerCase();
  if (c.includes("terminat")) return "terminated";
  if (c.includes("reject")) return "rejected";
  if (c.includes("approve")) return "approved";
  return "waiting";
}

// ── Status colour / label helpers ─────────────────────────────────────────────

export function statusLabelFromId(s?: number): string {
  if (s === 3) return "Approved";
  if (s === 7) return "Terminated";
  if (s === 4) return "Rejected";
  return "Processing";
}

export function statusColorHex(s?: number): string {
  return s === 4
    ? "#e74c3c"
    : s === 3
    ? "#27ae60"
    : s === 7
    ? "#34495e"
    : "#2980b9";
}

export function statusTitle(status: number): string {
  switch (status) {
    case 4:
      return "Memo Has Rejected";
    case 3:
      return "Memo Has Approved";
    case 7:
      return "Memo Has Terminated";
    default:
      return "Memo Is Processing";
  }
}

export function statusColorBg(s: number): string {
  return s === 4
    ? "#fff8f8"
    : s === 3
    ? "#f8fff9"
    : s === 7
    ? "#f5f7fa"
    : "#f5f8ff";
}

export function statusColorBorder(s: number): string {
  return s === 4
    ? "#e74c3c"
    : s === 3
    ? "#2ecc71"
    : s === 7
    ? "#7f8c8d"
    : "#3498db";
}

export function statusColorText(s: number): string {
  return s === 4
    ? "#e74c3c"
    : s === 3
    ? "#27ae60"
    : s === 7
    ? "#34495e"
    : "#2980b9";
}

// ── Approver table helpers ────────────────────────────────────────────────────

export function renderApproverTable(
  title: string,
  items: Array<{
    name: string;
    statusCode: StatusCode;
    isLevelSatisfied?: boolean;
    level?: number;
  }>
): string {
  const levelGroups = new Map<
    number,
    Array<{ name: string; statusCode: StatusCode; isLevelSatisfied?: boolean }>
  >();

  items.forEach((item) => {
    const level = item.level ?? 0;
    if (!levelGroups.has(level)) {
      levelGroups.set(level, []);
    }
    levelGroups.get(level)!.push(item);
  });

  const sortedLevels = Array.from(levelGroups.keys()).sort((a, b) => a - b);

  const rows = sortedLevels
    .flatMap((level) => {
      const approversInLevel = levelGroups.get(level)!;

      return approversInLevel.map((it, indexInLevel) => {
        const badge =
          it.statusCode === "waiting"
            ? '<span style="color:#3498db;">Waiting for approval</span>'
            : it.statusCode === "approved"
            ? it.isLevelSatisfied
              ? '<span style="color:#27ae60;">Level approved</span>'
              : '<span style="color:#27ae60;">Approved</span>'
            : it.statusCode === "terminated"
            ? '<span style="color:#b58900;">Terminated</span>'
            : '<span style="color:#e74c3c;">Rejected</span>';

        const levelNumber = level + 1;
        const approverNumber =
          approversInLevel.length > 1
            ? `${levelNumber}.${indexInLevel + 1}`
            : `${levelNumber}`;

        return `
        <tr>
          <td style="padding:8px;border:1px solid #ddd;">${approverNumber} ${it.name}</td>
          <td style="padding:8px;border:1px solid #ddd;">${badge}</td>
        </tr>`;
      });
    })
    .join("");

  return `
    <h3 style="margin:8px 0 6px 0;">${title}</h3>
    <table style="border-collapse:collapse;width:100%;margin:6px 0 20px 0;">
      <thead>
        <tr>
          <th style="padding:8px; border:1px solid #ddd; text-align:left;">Approver</th>
          <th style="padding:8px; border:1px solid #ddd; text-align:left;">Status</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

export async function getActiveExtraApproversForEmail(memoId: number): Promise<
  Array<{ userId: number; name: string; statusCode: StatusCode }>
> {
  const lines = await prisma.extraApprovalLine.findMany({
    where: { memoId },
    orderBy: { id: "desc" },
    select: { id: true, status: true },
  });
  if (!lines.length) return [];

  const ACTIVE = new Set<ExtraStatus>(["PENDING", "IN_PROGRESS"]);
  const activeIds = lines.filter((l) => ACTIVE.has(l.status)).map((l) => l.id);
  const targetIds = activeIds.length ? activeIds : [lines[0].id];

  const rows = await prisma.extraApprover.findMany({
    where: { extraId: { in: targetIds } },
    select: {
      userId: true,
      actedAt: true,
      status: { select: { name: true } },
    },
    orderBy: { userId: "asc" },
  });
  if (!rows.length) return [];

  const toCode = (
    r: (typeof rows)[number]
  ): StatusCode => {
    const n = (r.status?.name ?? "").toLowerCase();
    if (n.includes("reject")) return "rejected";
    if (n.includes("terminat")) return "terminated";
    if (n.includes("approve") || r.actedAt) return "approved";
    return "waiting";
  };

  const severity: Record<StatusCode, number> = {
    approved: 0,
    waiting: 1,
    rejected: 2,
    terminated: 5,
  };
  const byUser = new Map<number, StatusCode>();

  for (const r of rows) {
    const code = toCode(r);
    const prev = byUser.get(r.userId);
    if (prev == null || severity[code] > severity[prev]) {
      byUser.set(r.userId, code);
    }
  }

  const userIds = Array.from(byUser.keys());
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true, lastname: true, nickname: true },
  });
  const nameMap = new Map(
    users.map((u) => [
      u.id,
      toDisplayName(u, { includeNickname: true }) || `User#${u.id}`,
    ])
  );

  userIds.sort((a, b) =>
    (nameMap.get(a) ?? "").localeCompare(nameMap.get(b) ?? "")
  );

  return userIds.map((userId) => ({
    userId,
    name: nameMap.get(userId) ?? `User#${userId}`,
    statusCode: byUser.get(userId)!,
  }));
}

export async function buildApproverTablesHtml(memoId: number): Promise<string> {
  const latestVer = await getLatestVersion(memoId);
  const main = await getApproverLineStatus(memoId, latestVer);
  const extra = await getActiveExtraApproversForEmail(memoId);

  const mainHtml = renderApproverTable(
    "Main approval line",
    main.map((a) => ({
      name: a.name,
      level: a.level,
      statusCode: norm(a.statusCode),
      isLevelSatisfied: a.isLevelSatisfied,
    }))
  );

  const extraHtml = extra.length
    ? renderApproverTable(
        "Extra approval line",
        extra.map((e, idx) => ({
          name: e.name,
          level: idx,
          statusCode: norm(e.statusCode),
          isLevelSatisfied: false,
        }))
      )
    : "";

  return mainHtml + extraHtml;
}

// ── Email templates ───────────────────────────────────────────────────────────

export function buildCcPlain(
  receiver: string,
  actor: string,
  subject: string,
  ref: string | number,
  viewLink: string,
  typeName: string,
  buName: string,
  deptName: string,
  expiresAtText?: string | null,
  opts: CcEmailOptions = {}
): string {
  const statusText = opts.statusLabel ?? statusLabelFromId(opts.statusId);
  const headLine = opts.statusId
    ? `Memo "${subject}" is ${statusText}. You are CC on this memo.`
    : `${actor} CC'd you on memo "${subject}".`;

  const details = (opts.detailLines ?? []).map((l) => `- ${l}`).join("\n");
  const expiry = expiresAtText ? `Link expires on: ${expiresAtText}\n` : "";

  return `Hello ${receiver}

${headLine}

👁️ View Memo: ${viewLink}

Status        : ${statusText}
Memo Type     : ${typeName}
Memo Number   : ${ref}
Business Unit : ${buName}
Department    : ${deptName}
${details ? `\n${details}\n` : ""}${expiry}Ref: ${ref}
`;
}

export function buildCcHtml(
  receiver: string,
  actor: string,
  subject: string,
  ref: string | number,
  viewLink: string,
  typeName: string,
  buName: string,
  deptName: string,
  expiresAtText?: string | null,
  opts: CcEmailOptions = {}
): string {
  const statusText = opts.statusLabel ?? statusLabelFromId(opts.statusId);
  const color = statusColorHex(opts.statusId);
  const headLine = opts.statusId
    ? `Memo <em>"${subject}"</em> is <strong>${statusText}</strong>. You are CC on this memo.`
    : `<strong>${actor}</strong> CC'd you on memo <em>"${subject}"</em>.`;

  const detailList = (opts.detailLines ?? [])
    .map((li) => `<li>${li}</li>`)
    .join("");

  return `
  <html>
    <body style="font-family:'Segoe UI',Arial,sans-serif;background:#f7f9fc;margin:0;padding:0">
      <div style="max-width:640px;margin:20px auto;background:#fff;border-radius:8px;overflow:hidden">
        <div style="padding:22px 28px; border-left:5px solid ${color}; background:#f8fafc;">
          <div style="font-size:15px; color:#2d3748; line-height:1.6;">
            <p>Hello <strong>${receiver}</strong>,</p>
            <p>${headLine}</p>
          </div>

          <div style="margin:14px 0; padding:12px 14px; background:#fff; border:1px solid #e2e8f0; border-radius:6px;">
            <div style="margin-bottom:6px;">
              <span style="display:inline-block; background:${color}; color:#fff; padding:4px 10px; border-radius:12px; font-size:12px;">
                ${statusText}
              </span>
            </div>
            <div><strong>Memo No.:</strong> ${ref}</div>
            <div><strong>Type:</strong> ${typeName}</div>
            <div><strong>Business Unit:</strong> ${buName}</div>
            <div><strong>Department:</strong> ${deptName}</div>
            ${detailList ? `<ul style="margin:10px 0 0 18px; color:#4a5568;">${detailList}</ul>` : ""}
          </div>

          <p style="text-align:center;margin:18px 0 8px;">
            <a href="${viewLink}" style="background:${color};color:#fff;padding:12px 28px;border-radius:5px;text-decoration:none;display:inline-block">
              View Memo
            </a>
          </p>
          ${
            expiresAtText
              ? `<p style="font-size:12px;color:#888;text-align:center;margin-top:4px">This memo will expire on <strong>${expiresAtText}</strong></p>`
              : ""
          }
          <p style="font-size:12px;color:#888;text-align:center;margin:6px 0 0">Ref: ${ref}</p>
        </div>

        <div style="background:#fafafa;text-align:center;font-size:12px;color:#777;padding:15px">
          © ${new Date().getFullYear()} HYLIFE GROUP
        </div>
      </div>
    </body>
  </html>`;
}

export function buildPlain(
  name: string,
  msg: string,
  ref: string | number,
  memoId: number,
  approveLink: string,
  rejectLink: string,
  viewLink: string,
  terminateLink: string,
  approveWithConditionLink: string,
  bu: string,
  dept: string,
  typeName: string,
  commentCount: number,
  attachedCount: number,
  expiresAtText?: string | null,
  conditionOrReason?: string | null
): string {
  const expiryLine = expiresAtText ? `Link expires on: ${expiresAtText}\n` : "";
  const extraLine = conditionOrReason ? `\n${conditionOrReason}\n` : "";

  return `Hello ${name}

${msg}
${extraLine}
✅ Approve: ${approveLink}
✅ Approve With Condition: ${approveWithConditionLink}
❌ Reject:  ${rejectLink}
👁️ View Memo: ${viewLink}
Terminate : ${terminateLink}
Memo Type    : ${typeName}
Memo Number  : ${ref}
Business Unit    : ${bu}
Department       : ${dept}
View in System   : ${BASE_URL}/memos/${memoId}

Comments Total   : ${commentCount}
Attachments Total: ${attachedCount}
${expiryLine}Ref: ${ref}

`;
}

export function buildHtml(
  recipientName: string,
  message: string,
  subject: string,
  ref: string | number,
  documentType: string,
  businessUnit: string,
  department: string,
  approverTable: string,
  memoId: number,
  statusId: number,
  approveLink: string,
  rejectLink: string,
  terminateLink: string,
  viewLink: string,
  approveWithConditionLink: string,
  isOwner: boolean,
  commentCount: number,
  attachmentCount: number,
  expiresAtText?: string | null,
  conditionOrReason?: string | null
): string {
  const isFinal = [3, 4, 7].includes(statusId);

  const extraSection = conditionOrReason
    ? `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-bottom:20px;">
      <tr>
        <td style="background-color:#fff8e1;border-left:4px solid ${statusId === 3 ? "#f59e0b" : "#ef4444"};padding:15px;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;color:#2d3748;">
          <strong style="color:${statusId === 3 ? "#d97706" : "#dc2626"};">${statusId === 3 ? "Approval Condition:" : statusId === 4 ? "Reject Reason:" : "Termination Reason:"}</strong><br>
          <span style="white-space:pre-wrap;">${conditionOrReason}</span>
        </td>
      </tr>
    </table>`
    : "";

  const btnRow = (href: string, bg: string, label: string) => `
    <tr>
      <td align="center" style="padding:6px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;min-width:260px;">
          <tr>
            <td align="center" style="background:${bg};padding:12px 24px;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;font-weight:600;">
              <a href="${href}" style="color:#ffffff;text-decoration:none;display:block;" target="_blank">${label}</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;

  const ownerBtns = `
    ${btnRow(approveLink, "#28a745", "Approve")}
    ${btnRow(approveWithConditionLink, "#d97706", "Approve With Conditions")}
    ${btnRow(viewLink, "#3182ce", "View Memo")}`;

  const approverBtns = `
    ${btnRow(approveLink, "#28a745", "Approve")}
    ${btnRow(approveWithConditionLink, "#d97706", "Approve With Conditions")}
    ${btnRow(rejectLink, "#e8c113", "Revision Required")}
    ${btnRow(terminateLink, "#dc3545", "Terminate")}
    ${btnRow(viewLink, "#3182ce", "View Memo")}`;

  const actionButtons = isFinal
    ? ``
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
        ${isOwner ? ownerBtns : approverBtns}
       </table>`;

  const expiryBlock = expiresAtText
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
        <tr><td align="center" style="padding:10px 0;font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#718096;">
          This memo will expire on <strong>${expiresAtText}</strong><br>
          <span style="font-size:12px;">Ref: ${ref}</span>
        </td></tr>
       </table>`
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
        <tr><td align="center" style="padding:10px 0;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;color:#718096;">
          Ref: ${ref}
        </td></tr>
       </table>`;

  const detailRow = (label: string, value: string | number, isBadge = false) => {
    const valHtml = isBadge
      ? `<span style="display:inline-block;padding:4px 10px;background:#e2e8f0;font-size:13px;font-family:'Segoe UI',Arial,sans-serif;">${value}</span>`
      : `<span style="color:#2d3748;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;">${value}</span>`;
    return `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;font-weight:600;color:#4a5568;width:40%;">${label}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${valHtml}</td>
      </tr>`;
  };

  return `
<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>${subject}</title>
  <!--[if mso]>
  <style type="text/css">
    table { border-collapse: collapse; }
    td { font-family: 'Segoe UI', Arial, sans-serif; }
  </style>
  <![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#f0f4f8;font-family:'Segoe UI',Arial,sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background-color:#f0f4f8;">
    <tr>
      <td align="center" style="padding:30px 10px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="680" style="border-collapse:collapse;max-width:680px;width:100%;background-color:#ffffff;">

          <tr>
            <td style="background-color:${statusColorBg(statusId)};border-left:5px solid ${statusColorBorder(statusId)};padding:15px;text-align:center;">
              <h1 style="margin:0;font-family:'Segoe UI',Arial,sans-serif;font-size:20px;font-weight:600;color:${statusColorText(statusId)};">${statusTitle(statusId)}</h1>
            </td>
          </tr>

          <tr>
            <td style="padding:30px;">

              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
                <tr>
                  <td style="font-family:'Segoe UI',Arial,sans-serif;font-size:16px;color:#2d3748;padding-bottom:20px;">
                    Hello <strong>${recipientName}</strong>
                  </td>
                </tr>
              </table>

              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-bottom:25px;">
                <tr>
                  <td style="background-color:#f8fafc;border-left:4px solid #3498db;padding:20px;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;color:#2d3748;">
                    ${message}
                    ${approverTable}
                  </td>
                </tr>
              </table>

              ${extraSection}

              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-bottom:30px;">
                ${detailRow("Subject", subject)}
                ${detailRow("Memo Number", ref)}
                ${detailRow("Business Unit", businessUnit)}
                ${detailRow("Department", department)}
                ${detailRow("Type", documentType)}
                ${detailRow("Comments", commentCount, true)}
                ${detailRow("Attachments", attachmentCount, true)}
              </table>

              ${actionButtons}

              ${expiryBlock}

            </td>
          </tr>

          <tr>
            <td style="background-color:#f7fafc;text-align:center;padding:20px;font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#718096;border-top:1px solid #e2e8f0;">
              &copy; ${new Date().getFullYear()} hylifegroup&nbsp;|&nbsp;
              <a href="https://hylifegroup.com" style="color:#3182ce;text-decoration:none;">hylifegroup.com</a>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
}

// ── getCurrentWaitingSummary (internal helper) ────────────────────────────────

async function getCurrentWaitingSummary(
  memoId: number
): Promise<{ level: number; names: string[] } | null> {
  const version = await getLatestVersion(memoId);
  const waiting = await prisma.approvalActionStatus.findUnique({
    where: { code: "waiting" },
    select: { id: true },
  });
  if (!waiting) return null;

  const rows = await prisma.memoApproverAction.findMany({
    where: { memoId, version, statusId: waiting.id },
    select: {
      loaUser: {
        select: {
          level: true,
          user: { select: { name: true, lastname: true, nickname: true } },
        },
      },
    },
    orderBy: { loaUser: { level: "asc" } },
  });
  if (!rows.length) return null;

  const minLevel = Math.min(...rows.map((r) => r.loaUser.level));
  const atMin = rows.filter((r) => r.loaUser.level === minLevel);
  const names = atMin.map(
    (r) =>
      toDisplayName(r.loaUser.user, { includeNickname: true }) || "Unknown"
  );
  return { level: minLevel, names };
}

// ── sendEmailsAsync ───────────────────────────────────────────────────────────

export async function sendEmailsAsync({
  receivers,
  subject,
  message,
  ref,
  typeName,
  buName,
  deptName,
  memoId,
  statusId,
  ownerId,
  versionOverride,
  notificationTypeSlug = "status-approved",
}: {
  receivers: number[];
  subject: string;
  message: string;
  ref: string | number;
  typeName: string;
  buName: string;
  deptName: string;
  memoId: number;
  statusId: number;
  ownerId: number;
  versionOverride?: number;
  notificationTypeSlug?: string;
}): Promise<void> {
  console.log(
    `[sendEmailsAsync] Filtering users using preference: ${notificationTypeSlug}`
  );
  const filteredReceivers = await filterUsersForEmail(
    receivers,
    notificationTypeSlug
  );

  if (!filteredReceivers.length) {
    console.log(
      `[sendEmailsAsync] No users want email notifications for ${notificationTypeSlug}`
    );
    return;
  }

  const logoPath = path.resolve(
    process.cwd(),
    "..",
    "frontend",
    "public",
    "img",
    "New-ememo-icon-4.png"
  );
  void logoPath; // kept for future use

  const commentCount = await prisma.comment.count({ where: { memoId } });
  const attachedCount = await prisma.attachedFile.count({ where: { memoId } });

  const memoExpireRow = await prisma.masterMemo.findUnique({
    where: { id: memoId },
    select: { expiresAt: true },
  });
  const expiresAtText = formatExpiresAt(memoExpireRow?.expiresAt);

  let signedPdf: Buffer;
  try {
    signedPdf = await createSignedPdfBuffer(memoId);
  } catch (err) {
    console.error("❌ สร้าง signed PDF ไม่สำเร็จ:", err);
    signedPdf = Buffer.alloc(0);
  }

  const userNameMap = new Map<number, string>();
  const nameRows = await prisma.user.findMany({
    where: { id: { in: filteredReceivers } },
    select: { id: true, name: true, lastname: true, nickname: true },
  });
  for (const u of nameRows) {
    userNameMap.set(
      u.id,
      toDisplayName(u, { includeNickname: true }) || `User#${u.id}`
    );
  }

  const approverTable = await buildApproverTablesHtml(memoId);

  const pendings = await getPendingActions(memoId, versionOverride);
  if (pendings.length) {
    await prisma.memoApproverAction.updateMany({
      where: { id: { in: pendings.map((p) => p.actionId) } },
      data: { emailToken: null },
    });
  }

  const uniqueActions = new Map<number, (typeof pendings)[number]>();
  for (const p of pendings) {
    if (!filteredReceivers.includes(p.userId)) continue;
    const existing = uniqueActions.get(p.userId);
    if (
      !existing ||
      (p.level !== undefined &&
        existing.level !== undefined &&
        p.level < existing.level)
    ) {
      uniqueActions.set(p.userId, p);
    } else if (!existing) {
      uniqueActions.set(p.userId, p);
    }
  }

  await Promise.all(
    Array.from(uniqueActions.values()).map(async (p) => {
      const token = makeEmailToken(memoId, p.actionId);
      await prisma.memoApproverAction.update({
        where: { id: p.actionId },
        data: { emailToken: token },
      });

      const approveLink = `${BASE_URL}/api/memos/action/email?token=${token}&action=approve`;
      const rejectLink = `${FRONTEND_URL}/memo/${memoId}?action=reject`;
      const viewLink = `${FRONTEND_URL}/memo/${memoId}`;
      const terminateLink = `${FRONTEND_URL}/memo/${memoId}?action=terminate`;
      const approveWithConditionLink = `${FRONTEND_URL}/memo/${memoId}?action=approve-with-condition`;

      const recipientName =
        userNameMap.get(p.userId) ?? p.name ?? `User#${p.userId}`;

      await sendEmail(
        [p.email],
        `Notification for memo ${ref}: ${subject}`,
        buildPlain(
          recipientName,
          message,
          ref,
          memoId,
          approveLink,
          rejectLink,
          viewLink,
          terminateLink,
          approveWithConditionLink,
          buName,
          deptName,
          typeName,
          commentCount,
          attachedCount,
          expiresAtText
        ),
        buildHtml(
          recipientName,
          message,
          subject,
          ref,
          typeName,
          buName,
          deptName,
          approverTable,
          memoId,
          statusId,
          approveLink,
          rejectLink,
          terminateLink,
          viewLink,
          approveWithConditionLink,
          p.userId === ownerId,
          commentCount,
          attachedCount,
          expiresAtText
        ),
        [
          {
            filename: safeFilename(
              typeof ref === "number" ? String(ref) : ref,
              ".pdf"
            ),
            content: signedPdf,
            contentType: "application/pdf",
          },
        ]
      );
    })
  );
}

// ── notifyStatusUpdate ────────────────────────────────────────────────────────

export async function notifyStatusUpdate(
  memoId: number,
  actorId: number,
  actorName: string,
  statusId: number,
  currentLevel: number | null,
  versionOverride?: number,
  reasonOverride?: string | null
): Promise<void> {
  const memo = await prisma.masterMemo.findUnique({
    where: { id: memoId },
    select: {
      id: true,
      memonumber: true,
      memoNumberRecord: { select: { memonumber: true } },
      subject: true,
      memoType: { select: { name: true } },
      businessUnit: { select: { name: true } },
      department: { select: { name: true } },
      userId: true,
      approvalLineId: true,
      expiresAt: true,
    },
  });
  if (!memo) return;

  const {
    id,
    memonumber: memoNumber,
    subject,
    memoType,
    businessUnit,
    department,
    userId: ownerId,
  } = memo;

  const typeName = memoType?.name ?? "Unknown";
  const ref: string =
    memoNumber ?? memo.memoNumberRecord?.memonumber ?? `memo-${id}`;
  const buName = businessUnit?.name ?? "-";
  const deptName = department?.name ?? "-";

  console.log(
    `[notify] → ENTER memo=${memoId} status=${statusId} actor=${actorId}`
  );
  console.log(
    `[notify] memo loaded: subject="${memo.subject}", approvalLineId=${memo.approvalLineId}`
  );

  const expiresAtText = formatExpiresAt(memo.expiresAt);

  let receivers: number[] = [];
  let message = "";

  if (statusId === 5) {
    const version = versionOverride ?? (await getLatestVersion(memoId));
    const waitingStat = await prisma.approvalActionStatus.findUnique({
      where: { code: "waiting" },
      select: { id: true },
    });
    if (!waitingStat) return;

    const waitingRows = await prisma.memoApproverAction.findMany({
      where: { memoId, version, statusId: waitingStat.id },
      select: {
        loaUser: {
          select: {
            userId: true,
            level: true,
            approvalRequirement: true,
            user: { select: { name: true } },
          },
        },
      },
      orderBy: { loaUser: { level: "asc" } },
    });
    if (!waitingRows.length) return;

    const approvedStat = await prisma.approvalActionStatus.findUnique({
      where: { code: "approved" },
      select: { id: true },
    });

    const satisfiedAnyLevels = new Set<number>();
    if (approvedStat) {
      const approvedRows = await prisma.memoApproverAction.findMany({
        where: { memoId, version, statusId: approvedStat.id },
        select: {
          loaUser: { select: { level: true, approvalRequirement: true } },
        },
      });
      for (const row of approvedRows) {
        if (row.loaUser.approvalRequirement === "ANY") {
          satisfiedAnyLevels.add(row.loaUser.level);
        }
      }
    }

    const effectiveWaitingRows = waitingRows.filter(
      (w) => !satisfiedAnyLevels.has(w.loaUser.level)
    );
    if (!effectiveWaitingRows.length) return;

    const minLevel = Math.min(
      ...effectiveWaitingRows.map((w) => w.loaUser.level)
    );
    const atMinLevel = effectiveWaitingRows.filter(
      (w) => w.loaUser.level === minLevel
    );

    receivers = atMinLevel
      .map((w) => w.loaUser.userId)
      .filter((id): id is number => id !== null);
    message = `It's your turn to approve request "${subject}".`;
  } else if (statusId === 3) {
    const pivots = await getClonePivotsForMemo(memoId);
    const maxLevel = Math.max(...pivots.map((p) => p.level));
    if (currentLevel === maxLevel) {
      receivers = [ownerId];
      message = `Memo "${subject}" has been approved by all approvers.`;
    } else {
      // ✅ Fix: use .filter() to get ALL users at next level (not just first)
      const nextLevel = (currentLevel ?? -1) + 1;
      const nextPivots = pivots.filter((p) => p.level === nextLevel);
      const nextUserIds = nextPivots
        .map((p) => p.userId)
        .filter((id): id is number => id !== null);
      if (!nextUserIds.length) return;
      receivers = nextUserIds;
      message = `It's your turn to approve request "${subject}".`;
    }
  } else if (statusId === 4) {
    receivers = [ownerId];
    message = `${actorName} has rejected memo "${subject}".`;
    console.log(
      `[notify] Reject branch → receivers=[${receivers.join(",")}] message="${message}"`
    );
  } else if (statusId === 7) {
    receivers = [ownerId];
    message = `${actorName} has terminated the approval process for memo "${subject}".`;
  } else {
    return;
  }

  receivers = Array.from(new Set(receivers));
  console.log(`[notify] after dedupe → receivers=[${receivers.join(",")}]`);

  let asyncNotificationSlug = "status-approved";
  if (statusId === 5) {
    asyncNotificationSlug = "wait-for-your-turn";
  } else if (statusId === 3) {
    if (message.includes("turn to approve")) {
      asyncNotificationSlug = "wait-for-your-turn";
    } else {
      asyncNotificationSlug = "status-approved";
    }
  } else if (statusId === 4) {
    asyncNotificationSlug = "status-rejected";
  } else if (statusId === 7) {
    asyncNotificationSlug = "status-terminated";
  }

  await pushNoti(
    receivers,
    actorId,
    {
      notificationTypeId: 3,
      memoId,
      statusId,
      message,
    },
    asyncNotificationSlug
  );
  console.log(`[notify] pushNoti done`);

  await prisma.notification.findMany({
    where: { memoId, statusId, actorId, userId: { in: receivers } },
    include: {
      actor: { select: { id: true, name: true, profileImagePath: true } },
      memo: {
        select: {
          id: true,
          subject: true,
          history: {
            where: { statusId: 1 },
            orderBy: { timestamp: "asc" },
            take: 1,
            select: {
              timestamp: true,
              user: { select: { id: true, name: true, profileImagePath: true } },
            },
          },
        },
      },
      type: { select: { name: true } },
      status: { select: { name: true } },
    },
  });

  if ([3, 4, 7].includes(statusId)) {
    try {
      let notificationTypeSlug = "status-approved";
      if (statusId === 3) {
        if (message.includes("turn to approve")) {
          notificationTypeSlug = "wait-for-your-turn";
        } else {
          notificationTypeSlug = "status-approved";
        }
      } else if (statusId === 4) {
        notificationTypeSlug = "status-rejected";
      } else if (statusId === 7) {
        notificationTypeSlug = "status-terminated";
      }

      let conditionOrReason: string | null = reasonOverride ?? null;
      if (
        !conditionOrReason &&
        (statusId === 3 || statusId === 4 || statusId === 7)
      ) {
        const targetStatusCode =
          statusId === 3 ? "approved" : statusId === 4 ? "rejected" : "terminated";

        const targetStatus = await prisma.approvalActionStatus.findUnique({
          where: { code: targetStatusCode },
          select: { id: true },
        });

        if (targetStatus) {
          const latestAction = await prisma.memoApproverAction.findFirst({
            where: {
              memoId,
              statusId: targetStatus.id,
              actedAt: { not: null },
            },
            orderBy: { actedAt: "desc" },
            select: {
              approveWithCondition: true,
              rejectReason: true,
              terminationReason: true,
            },
          });

          if (latestAction) {
            conditionOrReason =
              statusId === 3
                ? latestAction.approveWithCondition
                : statusId === 4
                ? latestAction.rejectReason
                : latestAction.terminationReason;

            console.log(
              `[notify] Found condition/reason for statusId ${statusId}:`,
              conditionOrReason ? "YES" : "NO"
            );
          } else {
            console.log(`[notify] No action found for statusId ${statusId}`);
          }
        }
      }

      const filteredReceivers = await filterUsersForEmail(
        receivers,
        notificationTypeSlug
      );

      if (!filteredReceivers.length) {
        console.log(
          `[notify] No users want email notifications for ${notificationTypeSlug}`
        );
        return;
      }

      const users = await prisma.user.findMany({
        where: { id: { in: filteredReceivers } },
        select: {
          id: true,
          name: true,
          lastname: true,
          nickname: true,
          email: true,
        },
      });
      console.log(
        "🔔 [notify] immediate-email users:",
        users.map((u) => u.email)
      );

      const commentCount = await prisma.comment.count({ where: { memoId } });
      const attachedCount = await prisma.attachedFile.count({ where: { memoId } });

      let signedPdf: Buffer;
      try {
        signedPdf = await createSignedPdfBuffer(memoId);
      } catch (e) {
        console.error("❌ createSignedPdfBuffer failed", e);
        signedPdf = Buffer.alloc(0);
      }

      const logoPath = path.resolve(
        process.cwd(),
        "..",
        "frontend",
        "public",
        "img",
        "New-ememo-icon-4.png"
      );
      void logoPath;

      const approverTableHtml = await buildApproverTablesHtml(memoId);

      for (const u of users) {
        try {
          const display =
            toDisplayName(u, { includeNickname: true }) || `User#${u.id}`;
          await sendEmail(
            [u.email],
            `Notification for memo ${ref}: ${subject}`,
            buildPlain(
              display,
              message,
              ref,
              memoId,
              "#",
              "#",
              "#",
              "#",
              "#",
              buName,
              deptName,
              typeName,
              commentCount,
              attachedCount,
              expiresAtText,
              conditionOrReason
            ),
            buildHtml(
              display,
              message,
              subject,
              ref,
              typeName,
              buName,
              deptName,
              approverTableHtml,
              memoId,
              statusId,
              "#",
              "#",
              "#",
              "#",
              "#",
              u.id === ownerId,
              commentCount,
              attachedCount,
              expiresAtText,
              conditionOrReason
            ),
            message.includes("turn to approve")
              ? [
                  {
                    filename: safeFilename(ref, ".pdf"),
                    content: signedPdf,
                    contentType: "application/pdf",
                  },
                ]
              : undefined
          );
          console.log(`✅ [notify] email sent to ${u.email}`);
        } catch (err) {
          console.error(`❌ [notify] sendEmail failed for ${u.email}`, err);
        }
      }

      if (statusId === 3 || statusId === 7 || statusId === 4) {
        const ccUsers = await prisma.memoCc.findMany({
          where: { memoId },
          select: { userId: true },
        });
        const ccIds = Array.from(new Set(ccUsers.map((u) => u.userId)));
        const ccIdsOnly = ccIds.filter((id) => !receivers.includes(id));

        if (ccIdsOnly.length) {
          const ccMsg =
            statusId === 3
              ? `Memo "${subject}" has been approved by all approvers.`
              : statusId === 7
              ? `${actorName} has terminated the approval process for memo "${subject}".`
              : `${actorName} has rejected memo "${subject}".`;
          await pushNoti(ccIdsOnly, actorId, {
            notificationTypeId: 3,
            memoId,
            statusId,
            message: ccMsg,
          });

          const filteredCcIds = await filterUsersForEmail(
            ccIdsOnly,
            "cc-notification"
          );

          if (filteredCcIds.length) {
            const ccRows = await prisma.user.findMany({
              where: { id: { in: filteredCcIds } },
              select: {
                id: true,
                name: true,
                lastname: true,
                nickname: true,
                email: true,
              },
            });

            const viewLink = `${FRONTEND_URL}/memo/${memoId}`;
            const statusLabel =
              statusId === 3
                ? "Approved"
                : statusId === 7
                ? "Terminated"
                : "Rejected";
            const ccSubject = `Memo ${ref} — ${statusLabel} (CC)`;

            const ccDetailLines: string[] = [];
            if (statusId === 3) {
              ccDetailLines.push("All approvers have approved.");
            } else if (statusId === 7) {
              ccDetailLines.push(`Terminated by: ${actorName}`);
            } else if (statusId === 4) {
              ccDetailLines.push(`Rejected by: ${actorName}`);
            }

            for (const u of ccRows) {
              if (!u.email) continue;
              const display =
                toDisplayName(u, { includeNickname: true }) || `User#${u.id}`;

              const ccPlain = buildCcPlain(
                display,
                actorName,
                subject ?? "",
                ref,
                viewLink,
                typeName,
                buName,
                deptName,
                expiresAtText,
                { statusId, statusLabel, detailLines: ccDetailLines }
              );

              const ccHtml = buildCcHtml(
                display,
                actorName,
                subject ?? "",
                ref,
                viewLink,
                typeName,
                buName,
                deptName,
                expiresAtText,
                { statusId, statusLabel, detailLines: ccDetailLines }
              );

              await sendEmail([u.email], ccSubject, ccPlain, ccHtml);
            }
          }
        }
      }
    } catch (err) {
      console.error("❌ [notify] immediate-email block failed", err);
    }
    return;
  }

  asyncNotificationSlug = "status-approved";
  if (statusId === 5) {
    asyncNotificationSlug = "wait-for-your-turn";
  }

  void sendEmailsAsync({
    receivers,
    subject,
    message,
    ref,
    typeName,
    buName,
    deptName,
    memoId,
    statusId,
    ownerId,
    versionOverride,
    notificationTypeSlug: asyncNotificationSlug,
  });
}

// ── notifyCcAssigned ──────────────────────────────────────────────────────────

export async function notifyCcAssigned(
  memoId: number,
  actorId: number,
  ccUserIds: number[],
  statusIdForNoti: number = 5
): Promise<void> {
  if (!ccUserIds.length) return;

  const memo = await prisma.masterMemo.findUnique({
    where: { id: memoId },
    select: {
      id: true,
      subject: true,
      memonumber: true,
      memoNumberRecord: { select: { memonumber: true } },
      businessUnit: { select: { name: true } },
      department: { select: { name: true } },
      memoType: { select: { name: true } },
      userId: true,
      expiresAt: true,
    },
  });
  if (!memo) return;

  const ref =
    memo.memonumber ?? memo.memoNumberRecord?.memonumber ?? `memo-${memo.id}`;
  const buName = memo.businessUnit?.name ?? "-";
  const deptName = memo.department?.name ?? "-";
  const typeName = memo.memoType?.name ?? "Unknown";

  const actorName = await getUserDisplayName(actorId);
  const expiresAtText = formatExpiresAt(memo.expiresAt);
  const viewLink = `${FRONTEND_URL}/memo/${memo.id}`;

  const detailLines: string[] = [];
  if (statusIdForNoti === 5) {
    const waiting = await getCurrentWaitingSummary(memoId);
    if (waiting?.names.length) {
      detailLines.push(`Waiting approver(s): ${waiting.names.join(", ")}`);
    }
  }

  await pushNoti(Array.from(new Set(ccUserIds)), actorId, {
    notificationTypeId: 3,
    memoId,
    statusId: statusIdForNoti,
    message:
      statusIdForNoti === 5
        ? `${actorName} CC'd you on memo "${memo.subject}" (Processing).`
        : `${actorName} CC'd you on memo "${memo.subject}".`,
  });

  const filteredCcIds = await filterUsersForEmail(ccUserIds, "cc-notification");

  if (!filteredCcIds.length) {
    console.log("No CC users want email notifications");
    return;
  }

  const users = await prisma.user.findMany({
    where: { id: { in: filteredCcIds } },
    select: {
      id: true,
      name: true,
      lastname: true,
      nickname: true,
      email: true,
    },
  });

  const statusLabel = statusLabelFromId(statusIdForNoti);

  for (const u of users) {
    if (!u.email) continue;

    const display =
      toDisplayName(u, { includeNickname: true }) || `User#${u.id}`;
    const subj = `Memo ${ref} — ${statusLabel} (CC)`;

    const plain = buildCcPlain(
      display,
      actorName,
      memo.subject ?? "",
      ref,
      viewLink,
      typeName,
      buName,
      deptName,
      expiresAtText,
      { statusId: statusIdForNoti, statusLabel, detailLines }
    );

    const html = buildCcHtml(
      display,
      actorName,
      memo.subject ?? "",
      ref,
      viewLink,
      typeName,
      buName,
      deptName,
      expiresAtText,
      { statusId: statusIdForNoti, statusLabel, detailLines }
    );

    await sendEmail([u.email], subj, plain, html, []);
  }
}

// ── notifyRecallUpdate ────────────────────────────────────────────────────────

export async function notifyRecallUpdate(
  memoId: number,
  actorId: number,
  actorName: string
): Promise<void> {
  const memo = await prisma.masterMemo.findUnique({
    where: { id: memoId },
    select: {
      id: true,
      subject: true,
      memonumber: true,
      userId: true,
      memoType: { select: { name: true } },
    },
  });
  if (!memo) return;

  const ref = memo.memonumber ?? memo.id;
  const subject = memo.subject;
  const typeName = memo.memoType?.name ?? "Unknown";

  try {
    const ccUsers = await prisma.memoCc.findMany({
      where: { memoId },
      select: { userId: true },
    });
    const ccIds = Array.from(new Set(ccUsers.map((u) => u.userId)));

    if (ccIds.length) {
      const ccMsg = `${actorName} has recalled memo "${subject}".`;
      await pushNoti(ccIds, actorId, {
        notificationTypeId: 3,
        memoId,
        statusId: 6,
        message: ccMsg,
      });

      const filteredCcIds = await filterUsersForEmail(ccIds, "cc-notification");

      if (filteredCcIds.length) {
        const ccRows = await prisma.user.findMany({
          where: { id: { in: filteredCcIds } },
          select: {
            id: true,
            name: true,
            lastname: true,
            nickname: true,
            email: true,
          },
        });

        const viewLink = `${FRONTEND_URL}/memo/${memoId}`;
        const statusLabel = "Recalled";
        const ccSubject = `Memo ${ref} — ${statusLabel} (CC)`;
        const ccDetailLines: string[] = [`Recalled by: ${actorName}`];

        const memoDetails = await prisma.masterMemo.findUnique({
          where: { id: memoId },
          select: {
            businessUnit: { select: { name: true } },
            department: { select: { name: true } },
            expiresAt: true,
          },
        });
        const buName = memoDetails?.businessUnit?.name ?? "-";
        const deptName = memoDetails?.department?.name ?? "-";
        const expiresAtText = formatExpiresAt(memoDetails?.expiresAt);

        for (const u of ccRows) {
          if (!u.email) continue;
          const display =
            toDisplayName(u, { includeNickname: true }) || `User#${u.id}`;

          const ccPlain = buildCcPlain(
            display,
            actorName,
            subject ?? "",
            ref,
            viewLink,
            typeName,
            buName,
            deptName,
            expiresAtText,
            { statusId: 6, statusLabel, detailLines: ccDetailLines }
          );

          const ccHtml = buildCcHtml(
            display,
            actorName,
            subject ?? "",
            ref,
            viewLink,
            typeName,
            buName,
            deptName,
            expiresAtText,
            { statusId: 6, statusLabel, detailLines: ccDetailLines }
          );

          await sendEmail([u.email], ccSubject, ccPlain, ccHtml, []);
        }
      }
    }
  } catch (err) {
    console.error(
      "❌ [notifyRecallUpdate] error sending CC notifications",
      err
    );
  }
}
