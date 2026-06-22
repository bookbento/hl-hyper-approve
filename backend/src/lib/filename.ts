export function decodeFilename(name: string) {
  try {
    return Buffer.from(name, "latin1").toString("utf8");
  } catch {
    return name;
  }
}

// กันอักขระต้องห้าม/CRLF/ช่องว่างซ้ำ และจำกัดความยาว
export function safeFileName(name: string, max = 180) {
  return name
    .replace(/[\r\n]/g, " ")
    .replace(/[\/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
