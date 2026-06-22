// utils/filterDrafts.ts
export function filterDrafts<T extends { userId: number; status: string }>(
  items: T[],
  currentUserId: number
) {
  return items.filter(it =>
    it.status !== "Draft" || it.userId === currentUserId
  );
}
