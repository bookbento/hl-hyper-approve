/**
 * Thai-time helpers for the memo expiry sweep.
 * Ported unchanged from backend/src/lib/memo-expiry.ts.
 */
export const MS_MIN = 60 * 1000;
const MS_HOUR = 60 * MS_MIN;
const MS_DAY = 24 * MS_HOUR;

// Asia/Bangkok = UTC+7 (no DST)
const TH_OFFSET_MS = Number(process.env['TZ_OFFSET_MINUTES'] ?? '420') * MS_MIN;

export type ExpiryState = '3d' | 'expired';

/** YYYY-MM-DD of `d` in Thai time. */
export function ymdTH(d: Date): string {
  const dateTH = new Date(d.getTime() + TH_OFFSET_MS);
  const y = dateTH.getUTCFullYear();
  const m = String(dateTH.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dateTH.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * - "expired" once the Thai-time expiry instant has passed
 * - "3d"      3, 2 or 1 Thai days before, only at the expiry's minute-of-day
 *             (or one minute later, in case the cron tick is late) — once a day
 * - null      otherwise
 */
export function getExpiryStateTH(expiresAt: Date, now: Date): ExpiryState | null {
  const expMsTH = expiresAt.getTime() + TH_OFFSET_MS;
  const nowMsTH = now.getTime() + TH_OFFSET_MS;

  if (nowMsTH >= expMsTH) return 'expired';

  const diffDay = Math.floor(expMsTH / MS_DAY) - Math.floor(nowMsTH / MS_DAY);
  if (diffDay >= 1 && diffDay <= 3) {
    const MIN_PER_DAY = MS_DAY / MS_MIN; // 1440
    const expMin = Math.floor((expMsTH % MS_DAY) / MS_MIN);
    const nowMin = Math.floor((nowMsTH % MS_DAY) / MS_MIN);
    if (nowMin === expMin || nowMin === (expMin + 1) % MIN_PER_DAY) {
      return '3d';
    }
  }

  return null;
}

/** Thai calendar days from `now` to `expiresAt` (1..3 when state is "3d"). */
export function daysLeftTH(expiresAt: Date, now: Date): number {
  const expMsTH = expiresAt.getTime() + TH_OFFSET_MS;
  const nowMsTH = now.getTime() + TH_OFFSET_MS;
  return Math.floor(expMsTH / MS_DAY) - Math.floor(nowMsTH / MS_DAY);
}
