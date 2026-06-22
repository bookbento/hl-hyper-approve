// src/lib/files.ts
import { BASE_URL } from "./api";

/**
 * Convert profile image path/URL from API response to a usable URL
 * Handles profileImageUrl, profileImagePath, or profileImage fields
 */
export function getAvatarUrlFromUser(user: any): string | null {
  let raw: string | null =
    (user?.profileImageUrl as any) ??
    (user?.profileImagePath as any) ??
    (user?.profileImage as any) ??
    null;

  if (!raw) return null;

  raw = raw.replace?.(/\\/g, "/") ?? raw; // windows path

  // base64
  if (typeof raw === "string" && raw.startsWith("data:image/")) return raw;

  // full URL
  if (/^https?:\/\//i.test(raw)) return raw;

  // /uploads/...
  if (raw.startsWith("/uploads/")) return toSecureUploadUrl(raw)!;

  // profiles/xxx.jpg or plain filename
  const path = raw.startsWith("profiles/") ? raw : `profiles/${raw}`;
  return toSecureUploadUrl(`/uploads/${path}`);
}

/** คืน URL สำหรับไฟล์ใต้ /api/secure-uploads/* แบบไม่ซ้ำ prefix และรองรับทั้ง absolute/relative */
export function toSecureUploadUrl(input?: string | null): string {
  if (!input) return "";
  let s = String(input).trim();
  if (!s) return "";

  // ถ้าเป็น absolute -> ใช้เฉพาะ path (รวม query ถ้ามี)
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      s = (u.pathname + u.search) || "";
    } catch {
      s = s.replace(/^https?:\/\/[^/]+/i, "");
    }
  }

  // ตัด / นำหน้า
  s = s.replace(/^\/+/, "");

  // ลบ prefix ที่ซ้ำ ๆ ออกให้หมด (กันเคส api/secure-uploads/... ที่ถูกส่งมาแล้ว)
  s = s.replace(/^(?:api\/secure-uploads\/)+/i, "");
  // ลบ uploads/ ที่แบ็กเอนด์บางที่ส่งมา
  s = s.replace(/^(?:uploads\/)+/i, "");

  // กันเคสโฟลเดอร์ซ้ำ เช่น profiles/profiles/... หรือ attached/attached/...
  s = s.replace(/^(?:profiles\/)+/i, "profiles/");
  s = s.replace(/^(?:attached\/)+/i, "attached/");

  // ประกบ prefix ให้เหลือครั้งเดียว
  const path = `api/secure-uploads/${s}`;

  // join กับ BASE_URL แล้วบีบ // ที่ซ้ำ
  return `${(BASE_URL || "").replace(/\/+$/, "")}/${path}`.replace(/([^:]\/)\/+/g, "$1");
}
