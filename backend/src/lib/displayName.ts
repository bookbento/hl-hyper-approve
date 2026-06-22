export type UserNameBits = {
  name?: string | null;
  lastname?: string | null;
  nickname?: string | null;
};

export function toDisplayName(u: UserNameBits | null | undefined): string {
  const first = (u?.name ?? "").trim();
  const last  = (u?.lastname ?? "").trim();
  const nick  = (u?.nickname ?? "").trim();
  const full  = [first, last].filter(Boolean).join(" ").trim();
  return full || first || nick || "";
}
