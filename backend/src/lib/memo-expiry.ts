// src/lib/memo-expiry.ts
import { prisma } from "../../prisma/client";
import { ActionType, ExtraStatus } from "@prisma/client";
import path from "path";
import fs from "fs";
import { sendEmail } from "../lib/mailer";
import { filterUsersForEmail } from "../lib/notificationPreferences";

/* ───────── Config ───────── */
const FRONTEND_URL =
  (process.env.FRONTEND_URL || "").replace(/\/+$/, "") ||
  "http://localhost:5173";

const MS_MIN = 60 * 1000;
const MS_HOUR = 60 * MS_MIN;
const MS_DAY = 24 * MS_HOUR;

// Asia/Bangkok = UTC+7 (ไม่มี DST)
const TH_OFFSET_MINUTES = Number(process.env.TZ_OFFSET_MINUTES ?? "420");
const TH_OFFSET_MS = TH_OFFSET_MINUTES * MS_MIN;

/* ───────── Time helpers (อิงเวลาไทย) ───────── */
const ymdTH = (d: Date) => {
  const msTH = d.getTime() + TH_OFFSET_MS;
  const dateTH = new Date(msTH);
  const y = dateTH.getUTCFullYear();
  const m = String(dateTH.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dateTH.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
};
const dayIndexTH = (d: Date) =>
  Math.floor((d.getTime() + TH_OFFSET_MS) / MS_DAY);
const atMidTH = (d: Date) => {
  const idx = dayIndexTH(d);
  const utcMs = idx * MS_DAY - TH_OFFSET_MS;
  return new Date(utcMs);
};

/**
 * คืนค่า:
 * - "expired"  เมื่อถึงเวลาไทยแล้ว (เป๊ะตามนาที/วินาที)
 * - "3d"       เฉพาะช่วง 3,2,1 วันก่อน จะยิง "วันละครั้ง" ที่นาทีเดียวกับเวลาหมดอายุ
 * - null       นอกเหนือจากนี้
 */
function getExpiryStateTH(expiresAt: Date, now: Date): "3d" | "expired" | null {
  const expMsTH = expiresAt.getTime() + TH_OFFSET_MS;
  const nowMsTH = now.getTime() + TH_OFFSET_MS;

  // ถึงเวลาจริงตามไทย → หมดอายุทันที
  if (nowMsTH >= expMsTH) return "expired";

  // 3 วันล่วงหน้า: ตรวจ “วันไทย” เหลือ 3,2,1 วัน
  const dExp = Math.floor(expMsTH / MS_DAY);
  const dNow = Math.floor(nowMsTH / MS_DAY);
  const diffDay = dExp - dNow;

  if (diffDay >= 1 && diffDay <= 3) {
    // เทียบนาทีของวัน (0..1439) เพื่อกันดีเลย์ 1 นาที
    const MIN_PER_DAY = MS_DAY / MS_MIN; // 1440
    const expMin = Math.floor((expMsTH % MS_DAY) / MS_MIN); // นาทีของ expiry ในหนึ่งวัน
    const nowMin = Math.floor((nowMsTH % MS_DAY) / MS_MIN); // นาทีปัจจุบันในหนึ่งวัน

    // ตรงนาทีเป๊ะ หรือช้าไป 1 นาที (กันกรณี cron ติดดีเลย์)
    if (nowMin === expMin || nowMin === (expMin + 1) % MIN_PER_DAY) {
      return "3d";
    }
  }

  return null;
}

/* ───────── DB helpers ───────── */
async function latestVersionOf(memoId: number) {
  const { _max } = await prisma.memoApproverAction.aggregate({
    where: { memoId },
    _max: { version: true },
  });
  return _max.version ?? 1;
}

async function getWaitingStatusId(): Promise<number | null> {
  const row = await prisma.approvalActionStatus.findFirst({
    where: { code: { in: ["waiting", "WAITING", "Waiting"] } },
    select: { id: true },
  });
  if (!row) {
    console.warn(
      'approvalActionStatus "waiting" not found; skip waiting-logic'
    );
    return null;
  }
  return row.id;
}

// ใหม่: ส่งเมลเฉพาะเมื่อสถานะเป็น "Processing" เท่านั้น
// ใหม่: ส่งเมลเฉพาะเมื่อสถานะเป็น "Processing" เท่านั้น
async function shouldSkipMemo(memoId: number) {
  const latest = await prisma.memoStatusPivot.findFirst({
    where: { memoId },
    include: { status: true },
    orderBy: { createdAt: "desc" },
  });
  const name = (latest?.status?.name || "").toLowerCase();

  // ✅ อนุญาตเฉพาะ processing ที่เหลือ "ข้าม" ทั้งหมด
  return name !== "processing";
}

async function getExpiredStatusId(): Promise<number | null> {
  const row = await prisma.status.findFirst({
    where: {
      OR: [
        { name: "Expired" },
        { name: "expired" },
        { name: "EXPIRED" },
      ],
    },
    select: { id: true },
  });

  if (!row) {
    return null;
  }

  return row.id;
}

async function markMemoExpiredStatus(memoId: number, ownerId: number | null) {
  const EXPIRED_STATUS_ID = await getExpiredStatusId();
  if (!EXPIRED_STATUS_ID) {
    return;
  }

  const [latestPivot, master] = await Promise.all([
    prisma.memoStatusPivot.findFirst({
      where: { memoId },
      include: { status: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.masterMemo.findUnique({
      where: { id: memoId },
      select: { userId: true },
    }),
  ]);

  const latestName = (latestPivot?.status?.name || "").toLowerCase();

  // ✅ NEW: สถานะที่ถือว่า "จบงานแล้ว" ไม่ต้องเปลี่ยนเป็น Expired
  const FINAL_STATUS_IDS = [3, 7,9]; // 3 = Approved, 7 = Terminated
  const FINAL_STATUS_NAMES = ["approved", "terminated" , "deleted"];

  if (
    (latestPivot && FINAL_STATUS_IDS.includes(latestPivot.statusId)) ||
    FINAL_STATUS_NAMES.includes(latestName)
  ) {
    // ข้าม: ไม่สร้าง Expired status สำหรับ memo ที่จบแล้ว
    return;
  }

  // ถ้า pivot ล่าสุดเป็น Expired อยู่แล้ว → ไม่ต้องทำซ้ำ
  const alreadyExpired =
    latestPivot?.statusId === EXPIRED_STATUS_ID || latestName === "expired";

  if (alreadyExpired) {
    return;
  }

  const userId = ownerId ?? latestPivot?.userId ?? master?.userId ?? 0;
  if (!userId) {
    return;
  }

  await prisma.$transaction(async (tx) => {
    // Check if this exact combination already exists to prevent unique constraint violation
    const existingPivot = await tx.memoStatusPivot.findFirst({
      where: {
        memoId,
        userId,
        statusId: EXPIRED_STATUS_ID,
      },
    });

    // Only create if it doesn't exist
    if (!existingPivot) {
      await tx.memoStatusPivot.create({
        data: {
          memoId,
          statusId: EXPIRED_STATUS_ID,
          userId,
        },
      });

      await tx.memoHistory.create({
        data: {
          memoId,
          userId,
          statusId: EXPIRED_STATUS_ID,
          action: `The memo has expired`,
          actiontype: ActionType.UPDATE,
        },
      });
    }
  });
}



function daysLeftTH(expiresAt: Date, now: Date) {
  const expMsTH = expiresAt.getTime() + TH_OFFSET_MS;
  const nowMsTH = now.getTime() + TH_OFFSET_MS;
  return Math.floor(expMsTH / MS_DAY) - Math.floor(nowMsTH / MS_DAY); // 1..3
}

// แก้ wasNotified ให้รับ key แบบ 3d-*
async function wasNotified(
  memoId: number,
  key: string,
  now?: Date,
  expiresAt?: Date
) {
  const tag = `[expiry:${key}]`;
  const row = await prisma.memoHistory.findFirst({
    where: { memoId, action: { contains: tag } },
    select: { id: true, timestamp: true, action: true },
    orderBy: { id: "desc" },
  });
  if (!row) return false;

  if (key.startsWith("3d")) return true; // วันละครั้งพอ

  if (key === "expired") {
    if (!expiresAt) return true;
    return row.timestamp.getTime() >= expiresAt.getTime();
  }

  return true;
}

async function markNotified(
  memoId: number,
  actorId: number | null,
  key: string,
  receivers: number[],
  display?: string
) {
  const tag = `[expiry:${key}]`;
  const owner = await prisma.masterMemo.findUnique({
    where: { id: memoId },
    select: { userId: true },
  });
  const userId = actorId ?? owner?.userId ?? 0;
  if (!userId) return;

  // ❌ เดิม: เติม (to N users) / notified N user(s)
  // ✅ ใหม่: ไม่ใส่จำนวนคน
  const actionText = display ? `${tag} ${display}` : `${tag} Notification sent`;

  await prisma.memoHistory.create({
    data: {
      memoId,
      userId,
      action: actionText,
      actiontype: ActionType.UPDATE,
      timestamp: new Date(),
    },
  });
}

/* ───────── Recipient pickers ───────── */
// 3 วันก่อนหมดอายุ → แจ้งเตือนแค่ Owner + Current Approver
// ✅ ถ้ามี extra line ที่ยังรอ approve → แจ้งเฉพาะ extra approver, ไม่แจ้ง main line
async function recipientsFor3DaysBefore(memoId: number): Promise<number[]> {
  const ids = new Set<number>();
  const memo = await prisma.masterMemo.findUnique({
    where: { id: memoId },
    select: { userId: true },
  });
  if (memo?.userId) ids.add(memo.userId);

  // 1) ตรวจ extra line ก่อน — ถ้ามี extra ที่ยังรอ → แจ้งเฉพาะ extra, ข้าม main line
  const activeExtra = await prisma.extraApprovalLine.findMany({
    where: {
      memoId,
      status: { in: [ExtraStatus.PENDING, ExtraStatus.IN_PROGRESS] },
    },
    select: { approvers: { select: { userId: true, statusId: true } } },
  });
  const extraWaiting = activeExtra.flatMap((line) =>
    line.approvers.filter((a) => a.statusId == null)
  );

  if (extraWaiting.length > 0) {
    // มี extra approver ที่ยังไม่ approve → แจ้งเฉพาะ extra
    extraWaiting.forEach((a) => ids.add(a.userId));
  } else {
    // ไม่มี extra active → แจ้ง main line current approver ตามปกติ
    const waitingId = await getWaitingStatusId();
    const latestVer = await latestVersionOf(memoId);

    if (waitingId) {
      const waiting = await prisma.memoApproverAction.findMany({
        where: { memoId, version: latestVer, statusId: waitingId },
        include: { loaUser: { select: { userId: true, level: true } } },
        orderBy: { loaUser: { level: "asc" } },
      });
      if (waiting.length) {
        const minLv = Math.min(...waiting.map((w) => w.loaUser.level));
        waiting
          .filter((w) => w.loaUser.level === minLv)
          .forEach((w) => {
            if (w.loaUser.userId !== null) {
              ids.add(w.loaUser.userId);
            }
          });
      }
    }
  }

  return Array.from(ids);
}

// หมดอายุแล้ว → แจ้งเตือนแค่ Owner + Current Approver + CC
// ✅ ถ้ามี extra line ที่ยังรอ approve → แจ้งเฉพาะ extra approver, ไม่แจ้ง main line
async function recipientsForExpired(memoId: number): Promise<number[]> {
  const ids = new Set<number>();

  const memo = await prisma.masterMemo.findUnique({
    where: { id: memoId },
    select: { userId: true },
  });
  if (memo?.userId) ids.add(memo.userId);

  // 1) ตรวจ extra line ก่อน — ถ้ามี extra ที่ยังรอ → แจ้งเฉพาะ extra, ข้าม main line
  const activeExtra = await prisma.extraApprovalLine.findMany({
    where: {
      memoId,
      status: { in: [ExtraStatus.PENDING, ExtraStatus.IN_PROGRESS] },
    },
    select: { approvers: { select: { userId: true, statusId: true } } },
  });
  const extraWaiting = activeExtra.flatMap((line) =>
    line.approvers.filter((a) => a.statusId == null)
  );

  if (extraWaiting.length > 0) {
    // มี extra approver ที่ยังไม่ approve → แจ้งเฉพาะ extra
    extraWaiting.forEach((a) => ids.add(a.userId));
  } else {
    // ไม่มี extra active → แจ้ง main line current approver ตามปกติ
    const waitingId = await getWaitingStatusId();
    const latestVer = await latestVersionOf(memoId);

    if (waitingId) {
      const waiting = await prisma.memoApproverAction.findMany({
        where: { memoId, version: latestVer, statusId: waitingId },
        include: { loaUser: { select: { userId: true, level: true } } },
        orderBy: { loaUser: { level: "asc" } },
      });
      if (waiting.length) {
        const minLv = Math.min(...waiting.map((w) => w.loaUser.level));
        waiting
          .filter((w) => w.loaUser.level === minLv)
          .forEach((w) => {
            if (w.loaUser.userId !== null) {
              ids.add(w.loaUser.userId);
            }
          });
      }
    }
  }

  // 2) CC (ผู้รับสำเนา) — แจ้งเสมอไม่ว่า extra จะ active หรือไม่
  const ccs = await prisma.memoCc.findMany({
    where: { memoId },
    select: { userId: true },
  });
  ccs.forEach((c) => ids.add(c.userId));

  return Array.from(ids);
}

/* ───────── Email Templates ───────── */
type MailAttachment = {
  filename: string;
  path?: string;
  contentType?: string;
  cid?: string;
};
const inDaysPhrase = (n: number) => (n === 1 ? "in 1 day" : `in ${n} days`);
// แก้ signature ให้รองรับ daysLeft
type ExpiryMode = "3d" | "expired";

function buildExpiryPlain(
  memoSubject: string,
  ref: string | number,
  viewLink: string,
  mode: ExpiryMode,
  daysLeft?: number // << เพิ่ม
) {
  const lead =
    mode === "3d"
      ? `This memo will expire ${inDaysPhrase(daysLeft ?? 3)}.`
      : `This memo has expired`;
  return `Hello,

${lead}

Subject : ${memoSubject || "(No subject)"}
Memo No.: ${ref}
Open memo: ${viewLink}`;
}

function buildExpiryHtml(
  memoSubject: string,
  ref: string | number,
  viewLink: string,
  mode: ExpiryMode,
  daysLeft?: number // << เพิ่ม
) {
  const leadHtml =
    mode === "3d"
      ? `This memo will <b>expire ${inDaysPhrase(daysLeft ?? 3)}</b>.`
      : `This memo has <b>expired</b>.`;

  return `
  <html>
    <body style="font-family:'Segoe UI',Arial,sans-serif;background:#f7f9fc;margin:0;padding:0">
      <div style="max-width:640px;margin:20px auto;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #eee">
        <div style="background:#edecec;padding:25px;text-align:center">
          <h2 style="margin:0;color:#183e33">HyLife e-Approval</h2>
        </div>
        <div style="padding:30px">
          <h2 style="margin:0 0 10px 0;font-weight:600;color:#183e33">${
            memoSubject || "(No subject)"
          }</h2>
          <p style="margin:0 0 6px 0;font-size:13px;color:#666">Memo No.: <b>${ref}</b></p>
          <p style="margin:14px 0">${leadHtml}</p>
          <p style="text-align:center;margin:28px 0">
            <a href="${viewLink}"
               style="background:#183e33;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;display:inline-block">
              Open Memo
            </a>
          </p>
        </div>
        <div style="background:#fafafa;text-align:center;font-size:12px;color:#777;padding:15px">
          © ${new Date().getFullYear()} HYLIFE GROUP
        </div>
      </div>
    </body>
  </html>`;
}

/** ใส่ path ที่คุณบังคับมาก่อนเป็นอันดับ 1 */
function logoAttachment(): MailAttachment[] {
  const forced = path.resolve(
    process.cwd(),
    "..",
    "frontend",
    "public",
    "img",
    "New-ememo-icon-4.png"
  );
  const candidates = [
    forced,
    path.resolve(__dirname, "../../frontend/public/img/New-ememo-icon-4.png"),
    path.resolve(process.cwd(), "views", "img", "logo.png"),
    path.resolve(process.cwd(), "views", "img", "logo.jpg"),
    path.resolve(__dirname, "../../views/img/logo.png"),
    path.resolve(__dirname, "../../views/img/logo.jpg"),
    path.resolve(process.cwd(), "dist", "views", "img", "logo.png"),
    path.resolve(process.cwd(), "dist", "views", "img", "logo.jpg"),
  ];

  const file = candidates.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });

  if (!file) {
    console.warn("[memo-expiry] logo not found. Tried:", candidates);
    return [];
  }

  const ext = path.extname(file).toLowerCase();
  const contentType =
    ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";

  return [
    { filename: path.basename(file), path: file, contentType, cid: "logo_cid" },
  ];
}

/* ───────── Email + Noti ───────── */
function htmlToText(html: string) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function emailUsers(
  userIds: number[],
  subject: string,
  html: string,
  text?: string,
  attachments?: MailAttachment[]
): Promise<number> {

  if (!userIds.length) {
    console.log(`[memo-expiry] email: no userIds, skip. subject="${subject}"`);
    return 0;
  }

  // ✅ Filter users based on their email notification preferences
  // Using 'wait-for-your-turn' for expiry/reminder notifications
  const filteredUserIds = await filterUsersForEmail(userIds, 'wait-for-your-turn');
  
  if (!filteredUserIds.length) {
    console.log('[memo-expiry] No users want email notifications for expiry reminders');
    return 0;
  }

  const users = await prisma.user.findMany({
    where: { id: { in: filteredUserIds } },
    select: { id: true, name: true, email: true },
  });

  const finalText = text ?? htmlToText(html);
  const recipients = users.filter((u) => !!u.email);
  if (!recipients.length) {

    return 0;
  }

  console.log(
    `[memo-expiry] email -> ${
      recipients.length
    } user(s). subject="${subject}"\n  recipients: ${recipients
      .map((u) => `${u.id}:${u.email}`)
      .join(", ")}`
  );

  let ok = 0;
  const failed: string[] = [];

  for (const u of recipients) {
    try {
      const info: any = await sendEmail(
        [u.email!],
        subject,
        finalText,
        html,
        attachments
      );
      const acceptedCount = Array.isArray(info?.accepted)
        ? info.accepted.length
        : 0;
      if (acceptedCount > 0) {
        ok++;
      } else {
        failed.push(`${u.id}:${u.email} (smtp rejected)`);
      }
    } catch (err: any) {
      failed.push(`${u.id}:${u.email} (${err?.message || "send error"})`);
    }
  }

  if (failed.length) console.warn(`  failed: ${failed.join(", ")}`);

  return ok;
}

async function pushNoti(
  memoId: number,
  actorId: number | null,
  userIds: number[],
  message: string,
  notificationSlug?: string
): Promise<number> {
  if (!userIds.length) {
    console.log(`[memo-expiry] noti: no userIds, skip. memoId=${memoId}`);
    return 0;
  }

  const owner = await prisma.masterMemo.findUnique({
    where: { id: memoId },
    select: { userId: true },
  });
  const finalActor = actorId ?? owner?.userId ?? 0;
  if (!finalActor) {
    return 0;
  }

  let finalUserIds = userIds;
  if (notificationSlug && userIds.length > 0) {
    try {
      finalUserIds = await filterUsersForEmail(userIds, notificationSlug);
    } catch (err) {
      console.error(`[memo-expiry] Error filtering users for ${notificationSlug}:`, err);
    }
  }

  if (finalUserIds.length === 0) {
    return 0;
  }

  console.log(
    `[memo-expiry] noti -> ${
      finalUserIds.length
    } user(s). memoId=${memoId} actor=${finalActor}\n  recipients: ${finalUserIds.join(
      ", "
    )}`
  );

  const result = await prisma.notification.createMany({
    data: finalUserIds.map((uid) => ({
      memoId,
      userId: uid,
      actorId: finalActor,
      notificationTypeId: 2,
      message,
    })),
  });

  const count = (result as any)?.count ?? 0;
  return count;
}

/* ───────── Main sweep ───────── */
/* ───────── Main sweep ───────── */
export async function sweepMemoExpiryOnce(now = new Date()) {
  const todayTH = atMidTH(now);

  const memos = await prisma.masterMemo.findMany({
    where: { expiresAt: { not: null } },
    select: {
      id: true,
      userId: true,
      subject: true,
      memonumber: true,
      expiresAt: true,
    },
  });

  for (const m of memos) {
    try {
      if (!m.expiresAt) continue;

      const state = getExpiryStateTH(m.expiresAt, now);
      const expTH = atMidTH(m.expiresAt);

      if (!state) continue;

      // ✅ เช็คสถานะล่าสุดไว้ทีเดียว (ใช้แค่สำหรับ “เมล/โนติ”)
      const skipForNoti = await shouldSkipMemo(m.id);

      // ───────── state === "3d" → แจ้งเตือนล่วงหน้า ─────────
      if (state === "3d") {
        // 3 วันล่วงหน้า: ส่งเมล/โนติ เฉพาะตัวที่ยัง Processing
        if (skipForNoti) {
          continue;
        }

        const dleft = daysLeftTH(m.expiresAt!, now); // 1..3
        const key3d = `3d-${dleft}:${ymdTH(now)}`;

        if (await wasNotified(m.id, key3d)) {
          continue;
        }

        const toIds = await recipientsFor3DaysBefore(m.id);
        if (!toIds.length) {
          continue;
        }

        const subj = `[Memo Expiry] ${
          m.memonumber ?? `#${m.id}`
        } – will expire ${inDaysPhrase(dleft)}`;
        const url = `${FRONTEND_URL}/memo/${m.id}`;
        const html = buildExpiryHtml(
          m.subject || "(No subject)",
          m.memonumber ?? `#${m.id}`,
          url,
          "3d",
          dleft
        );
        const text = buildExpiryPlain(
          m.subject || "(No subject)",
          m.memonumber ?? `#${m.id}`,
          url,
          "3d",
          dleft
        );

        const sent = await emailUsers(
          toIds,
          subj,
          html,
          text,
          []
        );
        const noti = await pushNoti(
          m.id,
          m.userId,
          toIds,
          `Memo "${m.subject || `#${m.id}`}" will expire ${inDaysPhrase(
            dleft
          )}.`,
          "near-expiry"
        );

        if (sent > 0 || noti > 0) {
          await markNotified(
            m.id,
            m.userId,
            key3d,
            toIds,
            `Notification: memo will expire ${inDaysPhrase(dleft)}`
          );
        }
        continue;
      }

      // ───────── state === "expired" → หมดอายุแล้ว ─────────
      if (state === "expired") {
        const keyExp = "expired";

        // ✅ 1) เปลี่ยนสถานะเมโมเป็น Expired ก่อน “ทุกตัวที่มี expiresAt”
        await markMemoExpiredStatus(m.id, m.userId);

        // ✅ 2) ถ้า memo ไม่ได้อยู่ใน Processing แล้ว → ไม่ต้องส่งเมล/โนติ (แต่สถานะเปลี่ยนแล้ว)
        if (skipForNoti) {
          continue;
        }

        // ✅ 3) กันส่งเมล/โนติซ้ำ: ถ้าเคยแจ้ง expired ไปแล้วให้จบเลย
        if (await wasNotified(m.id, keyExp, now, m.expiresAt!)) {
          continue;
        }

        const toIds = await recipientsForExpired(m.id);
        if (!toIds.length) {
          continue;
        }

        const subj = `[Memo Expired] ${m.memonumber ?? `#${m.id}`}`;
        const url = `${FRONTEND_URL}/memo/${m.id}`;
        const html = buildExpiryHtml(
          m.subject || "(No subject)",
          m.memonumber ?? `#${m.id}`,
          url,
          "expired"
        );
        const text = buildExpiryPlain(
          m.subject || "(No subject)",
          m.memonumber ?? `#${m.id}`,
          url,
          "expired"
        );

        const sent = await emailUsers(
          toIds,
          subj,
          html,
          text,
          []
        );
        const noti = await pushNoti(
          m.id,
          m.userId,
          toIds,
          `Memo "${m.subject || `#${m.id}`}" has expired.`,
          "status-expired"
        );

        if (sent > 0 || noti > 0) {
          // ✅ Log รวมกับ Memo has Expired ไปแล้ว ไม่ต้องบันทึกซ้ำ
          console.log(`[memo-expiry] Notified for memo ${m.id} (expired)`);
        }
        continue;
      }
    } catch (err) {
      console.error(`[memo-expiry] memo ${m.id} failed:`, err);
    }
  }
}

export async function scheduleMemoExpiry(
  cronAt = "* * * * *",
  timezone = "Asia/Bangkok"
) {
  await sweepMemoExpiryOnce().catch((e) =>
    console.error("[memo-expiry] boot sweep failed:", e)
  );

  try {
    const { default: cron } = await import("node-cron");
    cron.schedule(
      cronAt,
      async () => {
        await sweepMemoExpiryOnce().catch((e) =>
          console.error("[memo-expiry] cron error:", e)
        );
      },
      { timezone }
    );
  } catch (e: any) {
    console.warn(
      "[memo-expiry] node-cron import failed – using 1-min fallback.",
      e?.message || e
    );
    const run = () => sweepMemoExpiryOnce().catch(console.error);
    run();
    setInterval(run, MS_MIN); // ทุกนาที
  }
}
