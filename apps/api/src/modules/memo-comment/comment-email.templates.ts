/**
 * Email bodies for comment notifications.
 * Ported verbatim from backend/src/services/memoComment.service.ts.
 */

function layout(inner: string): string {
  return `
  <html>
    <body style="font-family:'Segoe UI',Arial,sans-serif;background:#f7f9fc;margin:0;padding:0">
      <div style="max-width:640px;margin:20px auto;background:#fff;border-radius:8px;overflow:hidden">
        <div style="background:#edecec; padding:25px;text-align:center">
          <h2 style="margin:0;color:#183e33">HyLife e-Approval</h2>
        </div>
        <div style="padding:30px">
${inner}
        </div>
        <div style="background:#fafafa;text-align:center;font-size:12px;color:#777;padding:15px">
          © ${new Date().getFullYear()} HYLIFE GROUP
        </div>
      </div>
    </body>
  </html>`;
}

function viewButton(viewLink: string, ref: string | number): string {
  return `          <p style="text-align:center;margin:30px 0">
            <a href="${viewLink}"
               style="background:#183e33;color:#fff;padding:12px 28px;border-radius:5px;text-decoration:none">
              View Memo
            </a>
          </p>
          <p style="font-size:12px;color:#888">Memo No.: ${ref}</p>`;
}

// ── New comment ──────────────────────────────────────────────────────────────

export function buildCommentSubject(
  memoNumber: string | number,
  memoSubject: string,
  isMention: boolean | undefined,
  mentionedNames: string[] | undefined,
): string {
  if (isMention) return `You were mentioned on memo ${memoNumber}: ${memoSubject}`;
  if (mentionedNames && mentionedNames.length > 0) {
    return `New comment (with mention) on memo ${memoNumber}: ${memoSubject}`;
  }
  return `New comment on memo ${memoNumber}: ${memoSubject}`;
}

export function buildCommentPlain(
  receiver: string,
  commenter: string,
  snippet: string,
  ref: string | number,
  viewLink: string,
  isReceiverMentioned = false,
  mentionedNames?: string[],
): string {
  let lead = `${commenter} left a new comment:`;
  if (isReceiverMentioned) {
    if (mentionedNames && mentionedNames.length > 0) {
      lead = `${commenter} mentioned ${mentionedNames.join(', ')}:`;
    } else {
      lead = `${commenter} mentioned you:`;
    }
  } else if (mentionedNames && mentionedNames.length > 0) {
    lead = `${commenter} mentioned ${mentionedNames.join(', ')} in a comment:`;
  }

  return `Hello ${receiver},

${lead}
"${snippet}"

View details: ${viewLink}
Memo No.: ${ref}`;
}

export function buildCommentHtml(
  receiver: string,
  commenter: string,
  snippet: string,
  subject: string,
  ref: string | number,
  viewLink: string,
  isReceiverMentioned = false,
  mentionedNames?: string[],
): string {
  let leadHtml = `<strong>${commenter}</strong> left a new comment on memo <em>"${subject}"</em>`;
  if (isReceiverMentioned) {
    if (mentionedNames && mentionedNames.length > 0) {
      leadHtml = `<strong>${commenter}</strong> mentioned <b>${mentionedNames.join(', ')}</b> on memo <em>"${subject}"</em>`;
    } else {
      leadHtml = `<strong>${commenter}</strong> mentioned you on memo <em>"${subject}"</em>`;
    }
  } else if (mentionedNames && mentionedNames.length > 0) {
    leadHtml = `<strong>${commenter}</strong> mentioned <b>${mentionedNames.join(', ')}</b> in a comment on memo <em>"${subject}"</em>`;
  }

  return layout(`          <p>Hello <strong>${receiver}</strong>,</p>
          <p>${leadHtml}</p>
          <blockquote style="margin:15px 0;padding-left:15px;border-left:3px solid #183e33;color:#555">
            ${snippet}
          </blockquote>
${viewButton(viewLink, ref)}`);
}

// ── Deleted comment / mention ────────────────────────────────────────────────

export function buildDeleteCommentSubject(
  memoNumber: string | number,
  memoSubject: string,
  isMention: boolean | undefined,
): string {
  return isMention
    ? `A mention of you was deleted on memo ${memoNumber}: ${memoSubject}`
    : `A comment with a mention was deleted on memo ${memoNumber}: ${memoSubject}`;
}

export function buildDeleteCommentPlain(
  receiver: string,
  commenter: string,
  snippet: string,
  ref: string | number,
  viewLink: string,
  isReceiverMentioned = false,
  mentionedNames?: string[],
): string {
  let lead = `${commenter} deleted a comment.`;
  if (isReceiverMentioned) {
    lead = `${commenter} deleted a mention of you.`;
  } else if (mentionedNames && mentionedNames.length > 0) {
    lead = `${commenter} deleted a comment mentioning ${mentionedNames.join(', ')}.`;
  }

  return `Hello ${receiver},

${lead}

Previous message:
"${snippet}"

View details: ${viewLink}
Memo No.: ${ref}`;
}

export function buildDeleteCommentHtml(
  receiver: string,
  commenter: string,
  snippet: string,
  subject: string,
  ref: string | number,
  viewLink: string,
  isReceiverMentioned = false,
  mentionedNames?: string[],
): string {
  let leadHtml = `<strong>${commenter}</strong> removed a comment on memo <em>"${subject}"</em>`;
  if (isReceiverMentioned) {
    leadHtml = `<strong>${commenter}</strong> removed a mention of you on memo <em>"${subject}"</em>`;
  } else if (mentionedNames && mentionedNames.length > 0) {
    leadHtml = `<strong>${commenter}</strong> removed a comment mentioning <b>${mentionedNames.join(', ')}</b> on memo <em>"${subject}"</em>`;
  }

  return layout(`          <p>Hello <strong>${receiver}</strong>,</p>
          <p>${leadHtml}</p>
          <p>The deleted message was:</p>
          <blockquote style="margin:15px 0;padding-left:15px;border-left:3px solid #ccc;color:#888;font-style:italic">
            <del>${snippet}</del>
          </blockquote>
${viewButton(viewLink, ref)}`);
}
