/**
 * Email templates for memo status / CC notifications.
 * Ported verbatim from backend/src/services/memoNotification.service.ts —
 * output is compared byte-for-byte against Express (scripts/compare-memo-notification.js).
 */

export type StatusCode = 'waiting' | 'approved' | 'rejected' | 'terminated';

export type CcEmailOptions = {
  statusId?: number;
  statusLabel?: string;
  detailLines?: string[];
};

/** Base URL of the API, used for the "View in System" link in plain-text mail. */
export function appBaseUrl(): string {
  return process.env['APP_BASE_URL'] || 'https://your-app.com';
}

export function safeFilename(base: string, ext = '.pdf'): string {
  const name = String(base)
    .normalize('NFKD')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
  return `${name}${ext}`;
}

export function formatExpiresAt(dt?: Date | null): string | null {
  if (!dt) return null;
  try {
    return dt.toLocaleString('th-TH', {
      timeZone: 'Asia/Bangkok',
      hour12: false,
    });
  } catch {
    return dt.toISOString().replace('T', ' ').replace('Z', ' UTC');
  }
}

// ── Status colour / label helpers ─────────────────────────────────────────────

export function statusLabelFromId(s?: number): string {
  if (s === 3) return 'Approved';
  if (s === 7) return 'Terminated';
  if (s === 4) return 'Rejected';
  return 'Processing';
}

export function statusColorHex(s?: number): string {
  return s === 4 ? '#e74c3c' : s === 3 ? '#27ae60' : s === 7 ? '#34495e' : '#2980b9';
}

export function statusTitle(status: number): string {
  switch (status) {
    case 4:
      return 'Memo Has Rejected';
    case 3:
      return 'Memo Has Approved';
    case 7:
      return 'Memo Has Terminated';
    default:
      return 'Memo Is Processing';
  }
}

export function statusColorBg(s: number): string {
  return s === 4 ? '#fff8f8' : s === 3 ? '#f8fff9' : s === 7 ? '#f5f7fa' : '#f5f8ff';
}

export function statusColorBorder(s: number): string {
  return s === 4 ? '#e74c3c' : s === 3 ? '#2ecc71' : s === 7 ? '#7f8c8d' : '#3498db';
}

export function statusColorText(s: number): string {
  return s === 4 ? '#e74c3c' : s === 3 ? '#27ae60' : s === 7 ? '#34495e' : '#2980b9';
}

// ── Approver table helpers ────────────────────────────────────────────────────

export function renderApproverTable(
  title: string,
  items: Array<{
    name: string;
    statusCode: StatusCode;
    isLevelSatisfied?: boolean;
    level?: number;
  }>,
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
          it.statusCode === 'waiting'
            ? '<span style="color:#3498db;">Waiting for approval</span>'
            : it.statusCode === 'approved'
              ? it.isLevelSatisfied
                ? '<span style="color:#27ae60;">Level approved</span>'
                : '<span style="color:#27ae60;">Approved</span>'
              : it.statusCode === 'terminated'
                ? '<span style="color:#b58900;">Terminated</span>'
                : '<span style="color:#e74c3c;">Rejected</span>';

        const levelNumber = level + 1;
        const approverNumber =
          approversInLevel.length > 1 ? `${levelNumber}.${indexInLevel + 1}` : `${levelNumber}`;

        return `
        <tr>
          <td style="padding:8px;border:1px solid #ddd;">${approverNumber} ${it.name}</td>
          <td style="padding:8px;border:1px solid #ddd;">${badge}</td>
        </tr>`;
      });
    })
    .join('');

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
  opts: CcEmailOptions = {},
): string {
  const statusText = opts.statusLabel ?? statusLabelFromId(opts.statusId);
  const headLine = opts.statusId
    ? `Memo "${subject}" is ${statusText}. You are CC on this memo.`
    : `${actor} CC'd you on memo "${subject}".`;

  const details = (opts.detailLines ?? []).map((l) => `- ${l}`).join('\n');
  const expiry = expiresAtText ? `Link expires on: ${expiresAtText}\n` : '';

  return `Hello ${receiver}

${headLine}

👁️ View Memo: ${viewLink}

Status        : ${statusText}
Memo Type     : ${typeName}
Memo Number   : ${ref}
Business Unit : ${buName}
Department    : ${deptName}
${details ? `\n${details}\n` : ''}${expiry}Ref: ${ref}
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
  opts: CcEmailOptions = {},
): string {
  const statusText = opts.statusLabel ?? statusLabelFromId(opts.statusId);
  const color = statusColorHex(opts.statusId);
  const headLine = opts.statusId
    ? `Memo <em>"${subject}"</em> is <strong>${statusText}</strong>. You are CC on this memo.`
    : `<strong>${actor}</strong> CC'd you on memo <em>"${subject}"</em>.`;

  const detailList = (opts.detailLines ?? []).map((li) => `<li>${li}</li>`).join('');

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
            ${detailList ? `<ul style="margin:10px 0 0 18px; color:#4a5568;">${detailList}</ul>` : ''}
          </div>

          <p style="text-align:center;margin:18px 0 8px;">
            <a href="${viewLink}" style="background:${color};color:#fff;padding:12px 28px;border-radius:5px;text-decoration:none;display:inline-block">
              View Memo
            </a>
          </p>
          ${
            expiresAtText
              ? `<p style="font-size:12px;color:#888;text-align:center;margin-top:4px">This memo will expire on <strong>${expiresAtText}</strong></p>`
              : ''
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
  conditionOrReason?: string | null,
): string {
  const expiryLine = expiresAtText ? `Link expires on: ${expiresAtText}\n` : '';
  const extraLine = conditionOrReason ? `\n${conditionOrReason}\n` : '';

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
View in System   : ${appBaseUrl()}/memos/${memoId}

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
  conditionOrReason?: string | null,
): string {
  const isFinal = [3, 4, 7].includes(statusId);

  const extraSection = conditionOrReason
    ? `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-bottom:20px;">
      <tr>
        <td style="background-color:#fff8e1;border-left:4px solid ${statusId === 3 ? '#f59e0b' : '#ef4444'};padding:15px;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;color:#2d3748;">
          <strong style="color:${statusId === 3 ? '#d97706' : '#dc2626'};">${statusId === 3 ? 'Approval Condition:' : statusId === 4 ? 'Reject Reason:' : 'Termination Reason:'}</strong><br>
          <span style="white-space:pre-wrap;">${conditionOrReason}</span>
        </td>
      </tr>
    </table>`
    : '';

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
    ${btnRow(approveLink, '#28a745', 'Approve')}
    ${btnRow(approveWithConditionLink, '#d97706', 'Approve With Conditions')}
    ${btnRow(viewLink, '#3182ce', 'View Memo')}`;

  const approverBtns = `
    ${btnRow(approveLink, '#28a745', 'Approve')}
    ${btnRow(approveWithConditionLink, '#d97706', 'Approve With Conditions')}
    ${btnRow(rejectLink, '#e8c113', 'Revision Required')}
    ${btnRow(terminateLink, '#dc3545', 'Terminate')}
    ${btnRow(viewLink, '#3182ce', 'View Memo')}`;

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
                ${detailRow('Subject', subject)}
                ${detailRow('Memo Number', ref)}
                ${detailRow('Business Unit', businessUnit)}
                ${detailRow('Department', department)}
                ${detailRow('Type', documentType)}
                ${detailRow('Comments', commentCount, true)}
                ${detailRow('Attachments', attachmentCount, true)}
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

export function normalizeStatusCode(code?: string): StatusCode {
  const c = (code ?? '').toLowerCase();
  if (c.includes('terminat')) return 'terminated';
  if (c.includes('reject')) return 'rejected';
  if (c.includes('approve')) return 'approved';
  return 'waiting';
}
