import { daysLeftTH, getExpiryStateTH, ymdTH } from './memo-expiry.time';

// Times written in Thai local (+07:00) for readability.
const th = (s: string) => new Date(`${s}+07:00`);

describe('memo-expiry time helpers', () => {
  it('ymdTH uses the Thai calendar day', () => {
    expect(ymdTH(new Date('2026-10-14T17:30:00Z'))).toBe('2026-10-15'); // 00:30 TH
    expect(ymdTH(new Date('2026-10-14T16:59:00Z'))).toBe('2026-10-14'); // 23:59 TH
  });

  describe('getExpiryStateTH', () => {
    const exp = th('2026-10-20T14:30:00');

    it('is "expired" from the expiry instant on', () => {
      expect(getExpiryStateTH(exp, th('2026-10-20T14:30:00'))).toBe('expired');
      expect(getExpiryStateTH(exp, th('2026-11-01T00:00:00'))).toBe('expired');
      expect(getExpiryStateTH(exp, th('2026-10-20T14:29:59'))).toBeNull();
    });

    it('is "3d" 1–3 Thai days before, at the expiry minute or one minute late', () => {
      for (const day of ['17', '18', '19']) {
        expect(getExpiryStateTH(exp, th(`2026-10-${day}T14:30:00`))).toBe('3d');
        expect(getExpiryStateTH(exp, th(`2026-10-${day}T14:31:59`))).toBe('3d');
        expect(getExpiryStateTH(exp, th(`2026-10-${day}T14:32:00`))).toBeNull();
        expect(getExpiryStateTH(exp, th(`2026-10-${day}T14:29:00`))).toBeNull();
      }
      expect(getExpiryStateTH(exp, th('2026-10-16T14:30:00'))).toBeNull(); // 4 days
      expect(getExpiryStateTH(exp, th('2026-10-20T14:00:00'))).toBeNull(); // same day
    });

    it('wraps the one-minute grace past midnight', () => {
      const lateNight = th('2026-10-20T23:59:00');
      expect(getExpiryStateTH(lateNight, th('2026-10-18T23:59:30'))).toBe('3d');
      // 00:00 the next day is (expMin + 1) % 1440 and still 1..3 days out
      expect(getExpiryStateTH(lateNight, th('2026-10-19T00:00:10'))).toBe('3d');
    });
  });

  it('daysLeftTH counts Thai calendar days', () => {
    const exp = th('2026-10-20T00:10:00');
    expect(daysLeftTH(exp, th('2026-10-19T23:50:00'))).toBe(1);
    expect(daysLeftTH(exp, th('2026-10-17T00:10:00'))).toBe(3);
  });
});
