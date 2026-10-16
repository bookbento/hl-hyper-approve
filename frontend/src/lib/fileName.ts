// Display names for uploaded files.
//
// 1. Storage prefixes added on upload are not part of the user's name:
//    "1712345678901-name.pdf" (memo/comment files), "1712345678901_0_name.doc" (templates).
// 2. Older uploads (downloaded with a broken Content-Disposition, then re-uploaded)
//    hold Thai names as UTF-8 bytes read as latin1 ("à¹ƒà¸š…"). When every byte is
//    still there it decodes back cleanly; partly destroyed names are left as they are.

const PREFIX = /^\d{10,}(?:-|_\d+_)/;
// a UTF-8 lead byte (as a latin1 char) followed by a continuation byte
const MOJIBAKE = /[Â-ô][\u0080-¿]/;

export function repairMojibake(name: string): string {
  if (!MOJIBAKE.test(name)) return name;
  const bytes = new Uint8Array(name.length);
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c > 0xff) return name; // real Unicode already: not mojibake
    bytes[i] = c;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return name;
  }
}

export function displayFileName(name?: string | null): string {
  if (!name) return "";
  let s = String(name);
  // prefixes can be nested when a downloaded file was uploaded again
  while (PREFIX.test(s)) s = s.replace(PREFIX, "");
  return repairMojibake(s);
}
