/**
 * Extra-approval emails (line requested / approvers added / line deleted).
 * Ported verbatim from backend/src/services/extraApproval.service.ts.
 */

export function buildExtraPlain(
  receiver: string,
  actorName: string,
  memoSubject: string,
  ref: string | number,
  viewLink: string,
  mode: 'requested' | 'added',
  addedNames?: string[],
  isOwner?: boolean,
): string {
  const addedUsersStr = addedNames?.length ? ` (${addedNames.join(', ')})` : '';
  const lead = isOwner
    ? mode === 'added'
      ? `${actorName} added extra approver(s)${addedUsersStr} to your memo "${memoSubject}".`
      : `${actorName} requested an extra-approval line${addedUsersStr} for your memo "${memoSubject}".`
    : mode === 'added'
      ? `${actorName} added you as an extra approver on "${memoSubject}".`
      : `${actorName} created an extra-approval line${addedUsersStr} for "${memoSubject}" and you are listed as an approver.`;
  return `Hello ${receiver},\n\n${lead}\n\nView memo: ${viewLink}\nMemo No.: ${ref}`;
}

export function buildExtraHtml(
  receiver: string,
  actorName: string,
  memoSubject: string,
  ref: string | number,
  viewLink: string,
  mode: 'requested' | 'added',
  addedNames?: string[],
  isOwner?: boolean,
): string {
  const addedUsersStr = addedNames?.length ? ` (<b>${addedNames.join(', ')}</b>)` : '';
  const leadHtml = isOwner
    ? mode === 'added'
      ? `<strong>${actorName}</strong> added <b>extra approver(s)</b>${addedUsersStr} to your memo <em>"${memoSubject}"</em>.`
      : `<strong>${actorName}</strong> requested an <b>extra-approval line</b>${addedUsersStr} for your memo <em>"${memoSubject}"</em>.`
    : mode === 'added'
      ? `<strong>${actorName}</strong> added you as an <b>extra approver</b> on <em>"${memoSubject}"</em>.`
      : `<strong>${actorName}</strong> created an <b>extra-approval line</b>${addedUsersStr} for <em>"${memoSubject}"</em> and you are listed as an approver.`;

  return `
  <html>
    <body style="font-family:'Segoe UI',Arial,sans-serif;background:#f7f9fc;margin:0;padding:0">
      <div style="max-width:640px;margin:20px auto;background:#fff;border-radius:8px;overflow:hidden">
        <div style="background:#edecec; padding:25px;text-align:center">
          <h2 style="margin:0;color:#183e33">HyLife e-Approval</h2>
        </div>
        <div style="padding:30px">
          <p>Hello <strong>${receiver}</strong>,</p>
          <p>${leadHtml}</p>
          <p style="text-align:center;margin:30px 0">
            <a href="${viewLink}"
               style="background:#183e33;color:#fff;padding:12px 28px;border-radius:5px;text-decoration:none">
              Open Memo
            </a>
          </p>
          <p style="font-size:12px;color:#888">Memo No.: ${ref}</p>
        </div>
        <div style="background:#fafafa;text-align:center;font-size:12px;color:#777;padding:15px">
          © ${new Date().getFullYear()} HYLIFE GROUP
        </div>
      </div>
    </body>
  </html>`;
}

export function buildDeleteExtraPlain(
  receiver: string,
  actorName: string,
  memoSubject: string,
  ref: string | number,
  viewLink: string,
  deletedNames: string[],
  isOwner: boolean,
): string {
  const deletedUsersStr = deletedNames.length ? ` (${deletedNames.join(', ')})` : '';
  const lead = isOwner
    ? `${actorName} removed an extra approval line${deletedUsersStr} from your memo "${memoSubject}".`
    : `${actorName} removed your extra approval line from "${memoSubject}".`;
  return `Hello ${receiver},\n\n${lead}\n\nView memo: ${viewLink}\nMemo No.: ${ref}`;
}

export function buildDeleteExtraHtml(
  receiver: string,
  actorName: string,
  memoSubject: string,
  ref: string | number,
  viewLink: string,
  deletedNames: string[],
  isOwner: boolean,
): string {
  const deletedUsersStr = deletedNames.length ? ` (<b>${deletedNames.join(', ')}</b>)` : '';
  const leadHtml = isOwner
    ? `<strong>${actorName}</strong> removed an <b>extra approval line</b>${deletedUsersStr} from your memo <em>"${memoSubject}"</em>.`
    : `<strong>${actorName}</strong> removed your <b>extra approval line</b> from <em>"${memoSubject}"</em>.`;

  return `
  <html>
    <body style="font-family:'Segoe UI',Arial,sans-serif;background:#f7f9fc;margin:0;padding:0">
      <div style="max-width:640px;margin:20px auto;background:#fff;border-radius:8px;overflow:hidden">
        <div style="background:#edecec; padding:25px;text-align:center">
          <h2 style="margin:0;color:#183e33">HyLife e-Approval</h2>
        </div>
        <div style="padding:30px">
          <p>Hello <strong>${receiver}</strong>,</p>
          <p>${leadHtml}</p>
          <p style="text-align:center;margin:30px 0">
            <a href="${viewLink}"
               style="background:#183e33;color:#fff;padding:12px 28px;border-radius:5px;text-decoration:none">
              View Memo
            </a>
          </p>
          <p style="font-size:12px;color:#888">Memo No.: ${ref}</p>
        </div>
        <div style="background:#fafafa;text-align:center;font-size:12px;color:#777;padding:15px">
          © ${new Date().getFullYear()} HYLIFE GROUP
        </div>
      </div>
    </body>
  </html>`;
}
