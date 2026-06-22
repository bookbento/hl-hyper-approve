// src/lib/token.ts
import jwt from 'jsonwebtoken';

const SECRET = process.env.EMAIL_TOKEN_SECRET!;
if (!SECRET) throw new Error('Missing EMAIL_TOKEN_SECRET');


export function makeEmailToken(
  memoId: number,
  loaActionId: number        // ← id ของ memoApproverAction
) {
  return jwt.sign(
    { memoId, loaActionId }, // ⬅️ payload มีแค่สองฟิลด์พอ
    SECRET,
    { expiresIn: "7d" }
  );
}

export function verifyEmailToken(token: string) {
  try {
    return jwt.verify(token, SECRET) as {
      memoId: number;
      loaActionId: number;
      action: 'approve' | 'reject';
    };
  } catch {
    return null;
  }
}
