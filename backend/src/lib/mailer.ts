// lib/mailer.ts
import nodemailer, { SentMessageInfo } from "nodemailer";

export type MailAttachment = {
  filename: string;
  // ถ้าแนบจากไฟล์ ให้ระบุ path
  path?: string;
  // ถ้าแนบจาก Buffer/String ให้ระบุ content
  content?: Buffer | string;
  // ระบุ MIME type ถ้าใช้ content
  contentType?: string;
  cid?: string;
};

/* ---------- 1) สร้าง transporter global ครั้งเดียว (มี pool) ---------- */
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,                        // smtp.office365.com
  port: Number(process.env.SMTP_PORT) || 587,         // 587
  secure: process.env.SMTP_SECURE === "true",         // false (เพราะ 587)
  requireTLS: process.env.SMTP_REQUIRE_TLS === "true",// true
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  pool: true,
  maxConnections: 1,
  tls: { minVersion: "TLSv1.2" },
});

/* ตรวจจับว่าเชื่อมต่อ SMTP ได้ไหมตอนสตาร์ต */
transporter.verify()
  .then(() => console.log("✅ SMTP ready"))
  .catch(err => console.error("❌ SMTP verify failed:", err));

/* ---------- 2) ฟังก์ชันส่งเมล --------------------------------------- */
export async function sendEmail(
  to: string[],
  subject: string,
  text: string,
  html?: string,
  attachments?: MailAttachment[]
): Promise<SentMessageInfo | void> {
  try {
    return await transporter.sendMail({
      from: process.env.SMTP_FROM,   // "ระบบแจ้งเตือน" <user@...>
      to,
      subject,
      text,
      html,
      attachments,
    });
  } catch (err) {
    console.error("❌ email send error (ignored):", err);
    // TODO: บันทึก retry/แจ้ง admin ตามต้องการ
  }
}
