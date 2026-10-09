/**
 * Display name used by the memo search list and facets.
 *
 * Ported verbatim from backend memoStatus.controller `toDisplayName`. Differs
 * from the simpler helper in memo-query.service.ts: it drops the nickname when
 * it duplicates the first/full name, and falls back to first name or nickname.
 */
type UserNameBits = {
  name?: string | null;
  lastname?: string | null;
  nickname?: string | null;
};

export function toDisplayName(
  u: UserNameBits | null | undefined,
  opts: { includeNickname?: boolean } = {},
): string {
  const first = (u?.name ?? '').trim();
  const last = (u?.lastname ?? '').trim();
  const nick = (u?.nickname ?? '').trim();

  const full = [first, last].filter(Boolean).join(' ').trim();

  // ถ้าต้องการใส่ชื่อเล่น และมีชื่อเล่นจริง ๆ
  if (opts.includeNickname && nick) {
    // กันเคสชื่อเล่นซ้ำกับชื่อจริง
    const sameAsFirst =
      first && nick && first.localeCompare(nick, undefined, { sensitivity: 'accent' }) === 0;
    const sameAsFull =
      full && nick && full.localeCompare(nick, undefined, { sensitivity: 'accent' }) === 0;

    if (!sameAsFirst && !sameAsFull) {
      if (full) return `${full} (${nick})`;
      if (first) return `${first} (${nick})`;
      return nick; // มีแต่ชื่อเล่น
    }
  }

  return full || first || nick || '';
}
