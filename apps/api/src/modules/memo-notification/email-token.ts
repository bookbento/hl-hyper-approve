import * as jwt from 'jsonwebtoken';

/**
 * Signed one-click approve token embedded in "your turn" emails.
 * Ported from backend/src/lib/token.ts — same payload, secret and expiry, so
 * links already sitting in inboxes keep working across the cut-over.
 */
export type EmailTokenPayload = { memoId: number; loaActionId: number };

function secret(): string {
  const s = process.env['EMAIL_TOKEN_SECRET'];
  if (!s) throw new Error('Missing EMAIL_TOKEN_SECRET');
  return s;
}

/** loaActionId = memoApproverAction.id */
export function makeEmailToken(memoId: number, loaActionId: number): string {
  return jwt.sign({ memoId, loaActionId }, secret(), { expiresIn: '7d' });
}

export function verifyEmailToken(token: string): EmailTokenPayload | null {
  try {
    return jwt.verify(token, secret()) as EmailTokenPayload;
  } catch {
    return null;
  }
}
