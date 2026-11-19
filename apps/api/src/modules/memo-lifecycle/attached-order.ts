/**
 * Final order of a memo's file attachments (AttachedFile.orderNo).
 *
 * The form sends `attachedOrderTokens`: "old:<attachedFileId>" for files already
 * saved, "new:<i>" for the i-th file in this request's `attachedFiles`.
 * Unknown/duplicate tokens are ignored; anything the tokens don't mention keeps
 * its current place after the listed ones (kept files first, then new uploads),
 * so an old client that sends no tokens still gets "existing, then new".
 */
export function orderAttachedIds(
  rawTokens: unknown,
  keptIds: number[],
  newIds: number[],
): number[] {
  let tokens: unknown = rawTokens;
  if (typeof tokens === 'string') {
    try {
      tokens = JSON.parse(tokens);
    } catch {
      tokens = [];
    }
  }
  const list = Array.isArray(tokens) ? tokens : [];

  const kept = new Set(keptIds);
  const out: number[] = [];
  const seen = new Set<number>();
  const push = (id: number | undefined) => {
    if (id === undefined || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };

  for (const tk of list) {
    if (typeof tk !== 'string') continue;
    const [kind, num] = tk.split(':');
    const n = Number(num);
    if (!Number.isInteger(n) || n < 0) continue;
    if (kind === 'old' && kept.has(n)) push(n);
    else if (kind === 'new') push(newIds[n]);
  }
  keptIds.forEach(push);
  newIds.forEach(push);
  return out;
}
