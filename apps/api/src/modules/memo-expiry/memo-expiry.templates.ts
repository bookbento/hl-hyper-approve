/**
 * Expiry reminder / expired email bodies.
 * Ported unchanged from backend/src/lib/memo-expiry.ts (byte-for-byte output).
 */
import type { ExpiryState } from './memo-expiry.time';

export const inDaysPhrase = (n: number) => (n === 1 ? 'in 1 day' : `in ${n} days`);

export function buildExpiryPlain(
  memoSubject: string,
  ref: string | number,
  viewLink: string,
  mode: ExpiryState,
  daysLeft?: number,
): string {
  const lead =
    mode === '3d'
      ? `This memo will expire ${inDaysPhrase(daysLeft ?? 3)}.`
      : `This memo has expired`;
  return `Hello,

${lead}

Subject : ${memoSubject || '(No subject)'}
Memo No.: ${ref}
Open memo: ${viewLink}`;
}

export function buildExpiryHtml(
  memoSubject: string,
  ref: string | number,
  viewLink: string,
  mode: ExpiryState,
  daysLeft?: number,
): string {
  const leadHtml =
    mode === '3d'
      ? `This memo will <b>expire ${inDaysPhrase(daysLeft ?? 3)}</b>.`
      : `This memo has <b>expired</b>.`;

  return `
  <html>
    <body style="font-family:'Segoe UI',Arial,sans-serif;background:#f7f9fc;margin:0;padding:0">
      <div style="max-width:640px;margin:20px auto;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #eee">
        <div style="background:#edecec;padding:25px;text-align:center">
          <h2 style="margin:0;color:#183e33">HyLife e-Approval</h2>
        </div>
        <div style="padding:30px">
          <h2 style="margin:0 0 10px 0;font-weight:600;color:#183e33">${
            memoSubject || '(No subject)'
          }</h2>
          <p style="margin:0 0 6px 0;font-size:13px;color:#666">Memo No.: <b>${ref}</b></p>
          <p style="margin:14px 0">${leadHtml}</p>
          <p style="text-align:center;margin:28px 0">
            <a href="${viewLink}"
               style="background:#183e33;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;display:inline-block">
              Open Memo
            </a>
          </p>
        </div>
        <div style="background:#fafafa;text-align:center;font-size:12px;color:#777;padding:15px">
          © ${new Date().getFullYear()} HYLIFE GROUP
        </div>
      </div>
    </body>
  </html>`;
}
