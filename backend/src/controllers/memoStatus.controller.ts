import { sendEmail } from "../lib/mailer";
import { filterUsersForEmail } from "../lib/notificationPreferences";
import { RequestHandler } from "express";
import { prisma } from "../../prisma/client";
import { pushNoti } from "../lib/notify";
import { makeEmailToken } from "../lib/token";
import {
  getPendingActions,
  recordApproverAction,
} from "../services/memoApproval.service";
import path from "path";
import { getApproverLineStatus } from "../approverLine";
import { createSignedPdfBuffer } from "../services/pdf.core";
import { logMemoHistory } from "../lib/memoHistory";
import { ActionType, ExtraStatus, Prisma } from "@prisma/client";
const BASE_URL = process.env.APP_BASE_URL || "https://your-app.com";

function safeFilename(base: string, ext = ".pdf") {
  const name = String(base)
    .normalize("NFKD")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-") // กันอักขระต้องห้ามบน Windows/ทั่วไป
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
  return `${name}${ext}`;
}
/* ───── FRONTEND_URL: ต้องมีใน .env ───── */
if (!process.env.FRONTEND_URL) {
  throw new Error("Environment variable FRONTEND_URL is not set");
}
const FRONTEND_URL: string = process.env.FRONTEND_URL as string;

type ClonePivot = {
  id: number;
  userId: number | null; // Updated to handle flexible slots
  level: number;
  approvalRequirement?: string;
  user: { id: number; name: string } | null; // Updated to handle flexible slots
};

type UserNameBits = {
  name?: string | null;
  lastname?: string | null;
  nickname?: string | null;
};
export async function updateCurrentMemoStatus(
  memoId: number,
  actorUserId: number, // ใครเป็นคนเปลี่ยนสถานะ (เก็บลง pivot.userId)
  newStatusId: number
) {
  return prisma.$transaction(async (tx) => {
    // 1) กันชน unique: ถ้ามีแถว (memoId, actorUserId, newStatusId) อยู่แล้ว ลบทิ้งก่อน
    const cur = await tx.memoStatusPivot.findFirst({
      where: { memoId, userId: actorUserId },
      orderBy: { createdAt: "desc" },
      select: { id: true, statusId: true },
    });

    if (cur) {
      // ถ้าสถานะเดิมตรงกับที่จะตั้ง → แค่เลื่อนเวลา ไม่ต้องลบอะไร
      if (cur.statusId === newStatusId) {
        return tx.memoStatusPivot.update({
          where: { id: cur.id },
          data: { createdAt: new Date() },
        });
      }

      // ลบแถวสถานะเดียวกันที่ "ไม่ใช่แถวล่าสุด"
      await tx.memoStatusPivot.deleteMany({
        where: {
          memoId,
          userId: actorUserId,
          statusId: newStatusId,
          id: { not: cur.id },
        },
      });

      // อัปเดตแถวล่าสุดให้เป็นสถานะใหม่ (id คงเดิม)
      return tx.memoStatusPivot.update({
        where: { id: cur.id },
        data: { statusId: newStatusId, createdAt: new Date() },
      });
    }

    // ยังไม่เคยมีแถวของ (memoId,userId) → ค่อย create ครั้งแรก
    return tx.memoStatusPivot.create({
      data: { memoId, userId: actorUserId, statusId: newStatusId },
    });
  });
}

async function updateCurrentMemoStatusTx(
  tx: Prisma.TransactionClient,
  memoId: number,
  actorUserId: number,
  newStatusId: number
) {
  // กัน unique เด้งถ้ามีแถวสถานะเดียวกันอยู่แล้ว
  const cur = await tx.memoStatusPivot.findFirst({
    where: { memoId, userId: actorUserId },
    orderBy: { createdAt: "desc" },
    select: { id: true, statusId: true },
  });

  if (cur) {
    // ถ้าสถานะเดิมตรงกับที่จะตั้ง → แค่เลื่อนเวลา ไม่ต้องลบอะไร
    if (cur.statusId === newStatusId) {
      return tx.memoStatusPivot.update({
        where: { id: cur.id },
        data: { createdAt: new Date() },
      });
    }

    // ลบแถวสถานะเดียวกันที่ "ไม่ใช่แถวล่าสุด"
    await tx.memoStatusPivot.deleteMany({
      where: {
        memoId,
        userId: actorUserId,
        statusId: newStatusId,
        id: { not: cur.id },
      },
    });

    // อัปเดตแถวล่าสุดให้เป็นสถานะใหม่ (id คงเดิม)
    return tx.memoStatusPivot.update({
      where: { id: cur.id },
      data: { statusId: newStatusId, createdAt: new Date() },
    });
  }

  // ยังไม่เคยมีแถวของ (memoId,userId) → ค่อย create ครั้งแรก
  return tx.memoStatusPivot.create({
    data: { memoId, userId: actorUserId, statusId: newStatusId },
  });
}

export function toDisplayName(
  u: UserNameBits | null | undefined,
  opts: { includeNickname?: boolean } = {}
): string {
  const first = (u?.name ?? "").trim();
  const last = (u?.lastname ?? "").trim();
  const nick = (u?.nickname ?? "").trim();

  const full = [first, last].filter(Boolean).join(" ").trim();

  // ถ้าต้องการใส่ชื่อเล่น และมีชื่อเล่นจริง ๆ
  if (opts.includeNickname && nick) {
    // กันเคสชื่อเล่นซ้ำกับชื่อจริง
    const sameAsFirst =
      first &&
      nick &&
      first.localeCompare(nick, undefined, { sensitivity: "accent" }) === 0;
    const sameAsFull =
      full &&
      nick &&
      full.localeCompare(nick, undefined, { sensitivity: "accent" }) === 0;

    if (!sameAsFirst && !sameAsFull) {
      if (full) return `${full} (${nick})`;
      if (first) return `${first} (${nick})`;
      return nick; // มีแต่ชื่อเล่น
    }
  }

  return full || first || nick || "";
}

export async function getUserDisplayName(userId: number): Promise<string> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, lastname: true, nickname: true },
  });
  return toDisplayName(u, { includeNickname: true }) || `User#${userId}`;
}

export async function getRecallType(
  memoId: number
): Promise<"preserve" | "clear" | "none"> {
  const last = await prisma.memoHistory.findFirst({
    where: { memoId, statusId: 6 },
    orderBy: { timestamp: "desc" },
    select: { action: true },
  });
  if (!last) return "none";
  return last.action?.includes("(preserve)") ? "preserve" : "clear";
}

async function getClonePivots(memoId: number): Promise<ClonePivot[]> {
  const latestVer =
    (
      await prisma.memoApproverAction.aggregate({
        where: { memoId },
        _max: { version: true },
      })
    )._max.version ?? 1;

  const rows = await prisma.memoApproverAction.findMany({
    where: { memoId, version: latestVer },
    orderBy: [{ loaUser: { level: "asc" } }],
    distinct: ["loaUserId"],
    select: {
      loaUser: {
        select: {
          id: true,
          userId: true,
          level: true,
          approvalRequirement: true,
          user: {
            select: { id: true, name: true, lastname: true, nickname: true },
          },
        },
      },
    },
  }) as any[];

  /* map ให้ได้ shape ตรงกับ ClonePivot */
  return rows.map((r) => ({
    id: r.loaUser.id,
    userId: r.loaUser.userId,
    level: r.loaUser.level,
    approvalRequirement: r.loaUser.approvalRequirement ?? "ALL",
    user: r.loaUser.user
      ? {
        id: r.loaUser.user.id,
        name:
          toDisplayName(r.loaUser.user, { includeNickname: true }) ||
          `User#${r.loaUser.user.id}`,
      }
      : null,
  }));
}

export async function notifyStatusUpdate(
  memoId: number,
  actorId: number,
  actorName: string,
  statusId: number,
  currentLevel: number | null,
  versionOverride?: number,
  reasonOverride?: string | null
) {
  /* 1) โหลด memo + metadata ------------------------------------------------ */
  const memo = await prisma.masterMemo.findUnique({
    where: { id: memoId },
    select: {
      id: true,
      memonumber: true,
      memoNumberRecord: { select: { memonumber: true } },
      subject: true,
      memoType: { select: { name: true } },
      businessUnit: { select: { name: true } },
      department: { select: { name: true } },
      userId: true,
      approvalLineId: true,
      expiresAt: true,
    },
  });
  if (!memo) return;

  const {
    id,
    memonumber: memoNumber,
    subject,
    memoType,
    businessUnit,
    department,
    userId: ownerId,
  } = memo;

  const typeName = memoType?.name ?? "Unknown";
  const ref: string = memoNumber ?? memo.memoNumberRecord?.memonumber ?? `memo-${id}`;
  const buName = businessUnit?.name ?? "-";
  const deptName = department?.name ?? "-";

  console.log(`[notify] → ENTER memo=${memoId} status=${statusId} actor=${actorId}`);
  console.log(`[notify] memo loaded: subject="${memo.subject}", approvalLineId=${memo.approvalLineId}`);

  const expiresAtText = formatExpiresAt(memo.expiresAt);

  /* 2) คิดรายชื่อผู้รับ + ข้อความ --------------------------------------- */
  let receivers: number[] = [];
  let message = "";

  // Processing
  if (statusId === 5) {
    const version = versionOverride ?? (await getLatestVersion(memoId));
    const waitingStat = await prisma.approvalActionStatus.findUnique({
      where: { code: "waiting" },
      select: { id: true },
    });
    if (!waitingStat) return;

    const waitingRows = await prisma.memoApproverAction.findMany({
      where: { memoId, version, statusId: waitingStat.id },
      select: {
        loaUser: {
          select: {
            userId: true,
            level: true,
            approvalRequirement: true,
            user: { select: { name: true } },
          },
        },
      },
      orderBy: { loaUser: { level: "asc" } },
    });
    if (!waitingRows.length) return;

    // ✅ Fix: skip ANY levels that are already satisfied (≥1 approved)
    const approvedStat = await prisma.approvalActionStatus.findUnique({
      where: { code: "approved" },
      select: { id: true },
    });

    const satisfiedAnyLevels = new Set<number>();
    if (approvedStat) {
      const approvedRows = await prisma.memoApproverAction.findMany({
        where: { memoId, version, statusId: approvedStat.id },
        select: {
          loaUser: { select: { level: true, approvalRequirement: true } },
        },
      });
      for (const row of approvedRows) {
        if (row.loaUser.approvalRequirement === "ANY") {
          satisfiedAnyLevels.add(row.loaUser.level);
        }
      }
    }

    // Filter out waiting users whose ANY level is already satisfied
    const effectiveWaitingRows = waitingRows.filter(
      (w) => !satisfiedAnyLevels.has(w.loaUser.level)
    );
    if (!effectiveWaitingRows.length) return;

    const minLevel = Math.min(...effectiveWaitingRows.map((w) => w.loaUser.level));
    const atMinLevel = effectiveWaitingRows.filter((w) => w.loaUser.level === minLevel);

    receivers = atMinLevel.map((w) => w.loaUser.userId).filter((id): id is number => id !== null);
    message = `It's your turn to approve request "${subject}".`;
  }

  // Approved
  else if (statusId === 3) {
    const pivots = await getClonePivots(memoId);
    const maxLevel = Math.max(...pivots.map((p) => p.level));
    if (currentLevel === maxLevel) {
      receivers = [ownerId];
      message = `Memo "${subject}" has been approved by all approvers.`;
    } else {
      // ✅ Fix: use .filter() to get ALL users at next level (not just first)
      const nextLevel = (currentLevel ?? -1) + 1;
      const nextPivots = pivots.filter((p) => p.level === nextLevel);
      const nextUserIds = nextPivots
        .map((p) => p.userId)
        .filter((id): id is number => id !== null);
      if (!nextUserIds.length) return;
      receivers = nextUserIds;
      message = `It's your turn to approve request "${subject}".`;
    }
  }

  // Rejected
  else if (statusId === 4) {
    receivers = [ownerId];
    message = `${actorName} has rejected memo "${subject}".`;
    console.log(`[notify] Reject branch → receivers=[${receivers.join(",")}] message="${message}"`);
  }

  // Terminated
  else if (statusId === 7) {
    receivers = [ownerId];
    message = `${actorName} has terminated the approval process for memo "${subject}".`;
  } else {
    return;
  }

  /* 3) บันทึก Notification + broadcast ----------------------------------- */
  receivers = Array.from(new Set(receivers));
  console.log(`[notify] after dedupe → receivers=[${receivers.join(",")}]`);

  // ✅ Determine notification type slug for the main actors
  let asyncNotificationSlug = 'status-approved';
  if (statusId === 5) {
    asyncNotificationSlug = 'wait-for-your-turn';
  } else if (statusId === 3) {
    if (message.includes("turn to approve")) {
      asyncNotificationSlug = 'wait-for-your-turn';
    } else {
      asyncNotificationSlug = 'status-approved';
    }
  } else if (statusId === 4) {
    asyncNotificationSlug = 'status-rejected';
  } else if (statusId === 7) {
    asyncNotificationSlug = 'status-terminated';
  }

  await pushNoti(receivers, actorId, {
    notificationTypeId: 3,
    memoId,
    statusId,
    message,
  }, asyncNotificationSlug); // ✅ Pass the slug!
  console.log(`[notify] pushNoti done`);

  const notis = await prisma.notification.findMany({
    where: { memoId, statusId, actorId, userId: { in: receivers } },
    include: {
      actor: { select: { id: true, name: true, profileImagePath: true } },
      memo: {
        select: {
          id: true,
          subject: true,
          history: {
            where: { statusId: 1 },
            orderBy: { timestamp: "asc" },
            take: 1,
            select: {
              timestamp: true,
              user: { select: { id: true, name: true, profileImagePath: true } },
            },
          },
        },
      },
      type: { select: { name: true } },
      status: { select: { name: true } },
    },
  });

  // Notifications created, now send email notifications

  /* —— ส่งอีเมลทันทีสำหรับ Approved/Rejected/Terminated —— */
  if ([3, 4, 7].includes(statusId)) {
    try {
      // ✅ Determine notification type based on status
      // If status is 5 (Processing) or 3 (Approved but sending "turn" email), it's a "Wait for your turn" notification
      // However, this block handles IMMEDIATE emails for [3, 4, 7], so:
      // - 3 (Approved): It's a "status-update" (Final Approved) in this block context?
      //   Wait, let's look at logic above.
      //   If statusId == 3:
      //     If currentLevel == maxLevel: receivers = [owner]. Message = "Approved by all". -> Status Update
      //     Else: receivers = [next approver]. Message = "It's your turn". -> Wait for your turn
      //   BUT, the if condition for this block is `if ([3, 4, 7].includes(statusId))`.
      //   If statusId == 3 AND it's not final (intermediate approval), it DOES NOT enter this block?
      //   Let's check line 316 logic again.
      //   If statusId == 3 (Approved):
      //     ...
      //     If intermediate: receivers = [next]. Message = "Your turn".
      //   So if statusId == 3, it CAN be "Wait for your turn".

      // LOGIC CORRECTION:
      // The immediate block `if ([3, 4, 7].includes(statusId))` handles:
      // - 3 (Approved): Could be Final (Status Update) OR Intermediate (Wait for your turn)
      // - 4 (Rejected): Status Update
      // - 7 (Terminated): Status Update

      let notificationTypeSlug = 'status-approved'; // fallback
      if (statusId === 3) {
        if (message.includes("turn to approve")) {
          notificationTypeSlug = 'wait-for-your-turn';
        } else {
          notificationTypeSlug = 'status-approved';
        }
      } else if (statusId === 4) {
        notificationTypeSlug = 'status-rejected';
      } else if (statusId === 7) {
        notificationTypeSlug = 'status-terminated';
      }

      // ✅ ดึงข้อมูล condition/reason จาก action ล่าสุด
      let conditionOrReason: string | null = reasonOverride ?? null;
      if (!conditionOrReason && (statusId === 3 || statusId === 4 || statusId === 7)) {
        // ดึง status code ที่ต้องการ
        const targetStatusCode = statusId === 3 ? 'approved' 
                                : statusId === 4 ? 'rejected' 
                                : 'terminated';
        
        const targetStatus = await prisma.approvalActionStatus.findUnique({ 
          where: { code: targetStatusCode },
          select: { id: true }
        });

        if (targetStatus) {
            // *** HERE IT LOOKS AT memoApproverAction ***
          const latestAction = await prisma.memoApproverAction.findFirst({
            where: { 
              memoId,
              statusId: targetStatus.id,
              actedAt: { not: null }
            },
            orderBy: { actedAt: 'desc' },
            select: {
              approveWithCondition: true,
              rejectReason: true,
              terminationReason: true
            }
          });

          if (latestAction) {
            conditionOrReason = statusId === 3 
              ? latestAction.approveWithCondition
              : statusId === 4
              ? latestAction.rejectReason
              : latestAction.terminationReason;
            
            console.log(`[notify] Found condition/reason for statusId ${statusId}:`, conditionOrReason ? 'YES' : 'NO');
          } else {
            console.log(`[notify] No action found for statusId ${statusId}`);
          }
        }
      }

      // ✅ Filter users based on their email notification preferences
      const filteredReceivers = await filterUsersForEmail(receivers, notificationTypeSlug);

      if (!filteredReceivers.length) {
        console.log(`[notify] No users want email notifications for ${notificationTypeSlug}`);
        return;
      }

      // 1) ผู้รับหลัก (เฉพาะคนที่ต้องการรับอีเมล)
      const users = await prisma.user.findMany({
        where: { id: { in: filteredReceivers } },
        select: { id: true, name: true, lastname: true, nickname: true, email: true },
      });
      console.log("🔔 [notify] immediate-email users:", users.map((u) => u.email));

      // 2) ข้อมูล common
      const commentCount = await prisma.comment.count({ where: { memoId } });
      const attachedCount = await prisma.attachedFile.count({ where: { memoId } });

      let signedPdf: Buffer;
      try {
        signedPdf = await createSignedPdfBuffer(memoId);
      } catch (e) {
        console.error("❌ createSignedPdfBuffer failed", e);
        signedPdf = Buffer.alloc(0);
      }

      const logoPath = path.resolve(
        process.cwd(),
        "..",
        "frontend",
        "public",
        "img",
        "New-ememo-icon-4.png"
      );

      const approverTableHtml = await buildApproverTablesHtml(memoId);

      // 3) ส่งอีเมลผู้รับหลัก (Approver/Owner) → ใช้เทมเพลตเต็ม
      for (const u of users) {
        try {
          const display = toDisplayName(u, { includeNickname: true }) || `User#${u.id}`;
          await sendEmail(
            [u.email],
            `Notification for memo ${ref}: ${subject}`,
            buildPlain(
              display,
              message,
              ref,
              memoId,
              "#",
              "#",
              "#",
              "#",
              "#",
              buName,
              deptName,
              typeName,
              commentCount,
              attachedCount,
              expiresAtText,
              conditionOrReason // ✅ ส่ง condition/reason
            ),
            buildHtml(
              display,
              message,
              subject,
              ref,
              typeName,
              buName,
              deptName,
              approverTableHtml,
              memoId,
              statusId,
              "#",
              "#",
              "#",
              "#",
              "#",
              u.id === ownerId,
              commentCount,
              attachedCount,
              expiresAtText,
              conditionOrReason // ✅ ส่ง condition/reason
            ),
            // ✅ แนบ PDF เฉพาะ approver ที่ถึงคิว (intermediate approval)
            message.includes("turn to approve")
              ? [{ filename: safeFilename(ref, ".pdf"), content: signedPdf, contentType: "application/pdf" }]
              : undefined
          );
          console.log(`✅ [notify] email sent to ${u.email}`);
        } catch (err) {
          console.error(`❌ [notify] sendEmail failed for ${u.email}`, err);
        }
      }

      /* === CC mail: ใส่รายละเอียดสถานะให้ชัด === */
      if (statusId === 3 || statusId === 7 || statusId === 4) {
        // รายชื่อ CC ของเมโมนี้
        const ccUsers = await prisma.memoCc.findMany({ where: { memoId }, select: { userId: true } });
        const ccIds = Array.from(new Set(ccUsers.map((u) => u.userId)));
        const ccIdsOnly = ccIds.filter((id) => !receivers.includes(id)); // กันซ้ำผู้รับหลัก

        if (ccIdsOnly.length) {
          // push noti ให้ CC ด้วยข้อความสรุป
          const ccMsg =
            statusId === 3
              ? `Memo "${subject}" has been approved by all approvers.`
              : statusId === 7
              ? `${actorName} has terminated the approval process for memo "${subject}".`
              : `${actorName} has rejected memo "${subject}".`;
          await pushNoti(ccIdsOnly, actorId, {
            notificationTypeId: 3,
            memoId,
            statusId,
            message: ccMsg,
          });

          // ✅ Filter CC users based on their email notification preferences
          const { filterUsersForEmail } = await import('../lib/notificationPreferences');
          const filteredCcIds = await filterUsersForEmail(ccIdsOnly, 'cc-notification');

          if (filteredCcIds.length) {
            // โหลดข้อมูล user ของ CC (เฉพาะคนที่ต้องการรับอีเมล)
            const ccRows = await prisma.user.findMany({
              where: { id: { in: filteredCcIds } },
              select: { id: true, name: true, lastname: true, nickname: true, email: true },
            });

            const viewLink = `${FRONTEND_URL}/memo/${memoId}`;
            const statusLabel = statusId === 3 ? "Approved" : statusId === 7 ? "Terminated" : "Rejected";
            const ccSubject = `Memo ${ref} — ${statusLabel} (CC)`;

            // รายละเอียดเสริมสำหรับ CC (อ่านง่ายในตัวอีเมล)
            const ccDetailLines: string[] = [];
            if (statusId === 3) {
              ccDetailLines.push("All approvers have approved.");
            } else if (statusId === 7) {
              ccDetailLines.push(`Terminated by: ${actorName}`);
            } else if (statusId === 4) {
              ccDetailLines.push(`Rejected by: ${actorName}`);
            }

            for (const u of ccRows) {
              if (!u.email) continue;
              const display = toDisplayName(u, { includeNickname: true }) || `User#${u.id}`;

              const ccPlain = buildCcPlain(
                display,
                actorName,
                subject ?? "",
                ref,
                viewLink,
                typeName,
                buName,
                deptName,
                expiresAtText,
                { statusId, statusLabel, detailLines: ccDetailLines } // 👈 เพิ่มสถานะ + รายละเอียด
              );

              const ccHtml = buildCcHtml(
                display,
                actorName,
                subject ?? "",
                ref,
                viewLink,
                typeName,
                buName,
                deptName,
                expiresAtText,
                { statusId, statusLabel, detailLines: ccDetailLines } // 👈 เพิ่มสถานะ + รายละเอียด
              );

              await sendEmail(
                [u.email],
                ccSubject,
                ccPlain,
                ccHtml
                // ❌ CC ไม่แนบ PDF — แนบเฉพาะ approver ที่ถึงคิวเท่านั้น
              );
            }
          }
        }
      }
      /* === END CC mail === */
    } catch (err) {
      console.error("❌ [notify] immediate-email block failed", err);
    }
    return;
  }

  /* 4) ส่งเมล “ทีหลัง” แบบ fire-and-forget สำหรับเคสอื่น ๆ */
  // Case: Status 5 (Processing) -> "Wait for your turn"
  // Case: any other fallback
  asyncNotificationSlug = 'status-approved';
  if (statusId === 5) {
    asyncNotificationSlug = 'wait-for-your-turn';
  }

  void sendEmailsAsync({
    receivers,
    subject,
    message,
    ref,
    typeName,
    buName,
    deptName,
    memoId,
    statusId,
    ownerId,
    versionOverride,
    notificationTypeSlug: asyncNotificationSlug, // ✅ Pass correct slug
  });
}



type CcEmailOptions = {
  statusId?: number;                // 3/5/7
  statusLabel?: string;             // "Approved" | "Processing" | "Terminated"
  detailLines?: string[];           // บรรทัดรายละเอียดเสริม
};

function statusLabelFromId(s?: number) {
  if (s === 3) return "Approved";
  if (s === 7) return "Terminated";
  if (s === 4) return "Rejected";
  return "Processing";
}

function statusColorHex(s?: number) {
  // ใช้ธีมเดียวกับ buildHtml
  return s === 4 ? "#e74c3c"
    : s === 3 ? "#27ae60"
      : s === 7 ? "#34495e"
        : "#2980b9";
}

function buildCcPlain(
  receiver: string,
  actor: string,
  subject: string,
  ref: string | number,
  viewLink: string,
  typeName: string,
  buName: string,
  deptName: string,
  expiresAtText?: string | null,
  opts: CcEmailOptions = {}
) {
  const statusText = opts.statusLabel ?? statusLabelFromId(opts.statusId);
  const headLine = opts.statusId
    ? `Memo "${subject}" is ${statusText}. You are CC on this memo.`
    : `${actor} CC'd you on memo "${subject}".`;

  const details = (opts.detailLines ?? []).map(l => `- ${l}`).join("\n");
  const expiry = expiresAtText ? `Link expires on: ${expiresAtText}\n` : "";

  return `Hello ${receiver}

${headLine}

👁️ View Memo: ${viewLink}

Status        : ${statusText}
Memo Type     : ${typeName}
Memo Number   : ${ref}
Business Unit : ${buName}
Department    : ${deptName}
${details ? `\n${details}\n` : ""}${expiry}Ref: ${ref}
`;
}

function buildCcHtml(
  receiver: string,
  actor: string,
  subject: string,
  ref: string | number,
  viewLink: string,
  typeName: string,
  buName: string,
  deptName: string,
  expiresAtText?: string | null,
  opts: CcEmailOptions = {}
) {
  const statusText = opts.statusLabel ?? statusLabelFromId(opts.statusId);
  const color = statusColorHex(opts.statusId);
  const headLine = opts.statusId
    ? `Memo <em>"${subject}"</em> is <strong>${statusText}</strong>. You are CC on this memo.`
    : `<strong>${actor}</strong> CC'd you on memo <em>"${subject}"</em>.`;

  const detailList = (opts.detailLines ?? [])
    .map(li => `<li>${li}</li>`)
    .join("");

  return `
  <html>
    <body style="font-family:'Segoe UI',Arial,sans-serif;background:#f7f9fc;margin:0;padding:0">
      <div style="max-width:640px;margin:20px auto;background:#fff;border-radius:8px;overflow:hidden">
        <div style="padding:22px 28px; border-left:5px solid ${color}; background:#f8fafc;">
          <div style="font-size:15px; color:#2d3748; line-height:1.6;">
            <p>Hello <strong>${receiver}</strong>,</p>
            <p>${headLine}</p>
          </div>

          <div style="margin:14px 0; padding:12px 14px; background:#fff; border:1px solid #e2e8f0; border-radius:6px;">
            <div style="margin-bottom:6px;">
              <span style="display:inline-block; background:${color}; color:#fff; padding:4px 10px; border-radius:12px; font-size:12px;">
                ${statusText}
              </span>
            </div>
            <div><strong>Memo No.:</strong> ${ref}</div>
            <div><strong>Type:</strong> ${typeName}</div>
            <div><strong>Business Unit:</strong> ${buName}</div>
            <div><strong>Department:</strong> ${deptName}</div>
            ${detailList ? `<ul style="margin:10px 0 0 18px; color:#4a5568;">${detailList}</ul>` : ""}
          </div>

          <p style="text-align:center;margin:18px 0 8px;">
            <a href="${viewLink}" style="background:${color};color:#fff;padding:12px 28px;border-radius:5px;text-decoration:none;display:inline-block">
              View Memo
            </a>
          </p>
          ${expiresAtText
      ? `<p style="font-size:12px;color:#888;text-align:center;margin-top:4px">This memo will expire on <strong>${expiresAtText}</strong></p>`
      : ""
    }
          <p style="font-size:12px;color:#888;text-align:center;margin:6px 0 0">Ref: ${ref}</p>
        </div>

        <div style="background:#fafafa;text-align:center;font-size:12px;color:#777;padding:15px">
          © ${new Date().getFullYear()} HYLIFE GROUP
        </div>
      </div>
    </body>
  </html>`;
}


// ---- Main: notify CC (template-matched) ----
export async function notifyCcAssigned(
  memoId: number,
  actorId: number,
  ccUserIds: number[],
  statusIdForNoti: number = 5 // Processing
) {
  if (!ccUserIds.length) return;

  const memo = await prisma.masterMemo.findUnique({
    where: { id: memoId },
    select: {
      id: true,
      subject: true,
      memonumber: true,
      memoNumberRecord: { select: { memonumber: true } },
      businessUnit: { select: { name: true } },
      department: { select: { name: true } },
      memoType: { select: { name: true } },
      userId: true,
      expiresAt: true,
    },
  });
  if (!memo) return;

  const ref =
    memo.memonumber ?? memo.memoNumberRecord?.memonumber ?? `memo-${memo.id}`;
  const buName = memo.businessUnit?.name ?? "-";
  const deptName = memo.department?.name ?? "-";
  const typeName = memo.memoType?.name ?? "Unknown";

  const actorName = await getUserDisplayName(actorId);
  const expiresAtText = formatExpiresAt(memo.expiresAt);
  const viewLink = `${FRONTEND_URL}/memo/${memo.id}`;

  // เพิ่มสรุปรายละเอียดสถานะที่รอ (เฉพาะ Processing)
  const detailLines: string[] = [];
  if (statusIdForNoti === 5) {
    const waiting = await getCurrentWaitingSummary(memoId);
    if (waiting) {
      if (waiting.names.length) {
        detailLines.push(`Waiting approver(s): ${waiting.names.join(", ")}`);
      }
    }
  }

  // 1) pushNoti แบบเรียลไทม์ให้ทุกคนที่ถูก CC
  await pushNoti(Array.from(new Set(ccUserIds)), actorId, {
    notificationTypeId: 3,
    memoId,
    statusId: statusIdForNoti,
    message:
      statusIdForNoti === 5
        ? `${actorName} CC'd you on memo "${memo.subject}" (Processing).`
        : `${actorName} CC'd you on memo "${memo.subject}".`,
  });

  // 2) ส่งอีเมลแจ้ง CC (เฉพาะคนที่ต้องการรับอีเมล)
  // ✅ Filter CC users based on their email notification preferences
  const { filterUsersForEmail } = await import('../lib/notificationPreferences');
  const filteredCcIds = await filterUsersForEmail(ccUserIds, 'cc-notification');

  if (!filteredCcIds.length) {
    console.log('No CC users want email notifications');
    return;
  }

  const users = await prisma.user.findMany({
    where: { id: { in: filteredCcIds } },
    select: {
      id: true,
      name: true,
      lastname: true,
      nickname: true,
      email: true,
    },
  });

  const logoPath = path.resolve(
    process.cwd(),
    "..",
    "frontend",
    "public",
    "img",
    "New-ememo-icon-4.png"
  );

  const statusLabel = statusLabelFromId(statusIdForNoti);
  const emailSubjectPrefix =
    statusIdForNoti === 5 ? `${statusLabel}` : `${statusLabel}`;

  for (const u of users) {
    if (!u.email) continue;

    const display =
      toDisplayName(u, { includeNickname: true }) || `User#${u.id}`;
    const subj = `Memo ${ref} — ${emailSubjectPrefix} (CC)`;

    const plain = buildCcPlain(
      display,
      actorName,
      memo.subject ?? "",
      ref,
      viewLink,
      typeName,
      buName,
      deptName,
      expiresAtText,
      { statusId: statusIdForNoti, statusLabel, detailLines }
    );

    const html = buildCcHtml(
      display,
      actorName,
      memo.subject ?? "",
      ref,
      viewLink,
      typeName,
      buName,
      deptName,
      expiresAtText,
      { statusId: statusIdForNoti, statusLabel, detailLines }
    );

    await sendEmail([u.email], subj, plain, html, []);
  }
}




// ✅ ดึง userId ของผู้ที่ "approved" แล้วในเวอร์ชันล่าสุด (ก่อน recall)
async function getApprovedUsersInLatestVersion(
  memoId: number
): Promise<number[]> {
  const latest = await getLatestVersion(memoId);
  const rows = await prisma.memoApproverAction.findMany({
    where: {
      memoId,
      version: latest,
      status: { code: "approved" },
    },
    select: {
      loaUser: { select: { userId: true } },
    },
  });
  const ids = rows
    .map((r) => r.loaUser.userId)
    .filter((id): id is number => id !== null);
  return Array.from(new Set(ids));
}

async function resetActionsInCurrentVersion(
  memoId: number,
  opts?: { only?: "waiting_or_rejected" }
) {
  const waitingId = await prisma.approvalActionStatus
    .findUnique({
      where: { code: "waiting" },
      select: { id: true },
    })
    .then((r) => r!.id);

  const currentVersion =
    (
      await prisma.memoApproverAction.aggregate({
        where: { memoId },
        _max: { version: true },
      })
    )._max.version ?? 1;

  await prisma.memoApproverAction.updateMany({
    where: {
      memoId,
      version: currentVersion,
      ...(opts?.only === "waiting_or_rejected"
        ? { status: { code: { in: ["waiting", "rejected"] } } }
        : {}),
    },
    data: {
      statusId: waitingId,
      actedAt: null,
      signatureImageId: null,
      signatureText: null,
      emailToken: null,
      approveWithCondition: null,
    },
  });

  return currentVersion;
}

// ✅ ส่ง Notification + WS สำหรับเหตุการณ์ Recall (statusId = 6)
//    receivers = owner + ผู้ที่อนุมัติแล้วเท่านั้น
async function notifyRecallUpdate(
  memoId: number,
  actorId: number,
  actorName: string
) {
  const memo = await prisma.masterMemo.findUnique({
    where: { id: memoId },
    select: {
      id: true,
      subject: true,
      memonumber: true,
      userId: true,
      memoType: { select: { name: true } },
    },
  });
  if (!memo) return;

  const ref = memo.memonumber ?? memo.id;
  const subject = memo.subject;
  const typeName = memo.memoType?.name ?? "Unknown";

  // --- แจ้งเตือน CC ผู้รับสำเนา (เฉพาะ Recall) ---
  // ตั้งต้นที่ CC เลย ไม่ต้องเช็ค Owner/Approved แล้ว
  try {
    const ccUsers = await prisma.memoCc.findMany({ where: { memoId }, select: { userId: true } });
    const ccIds = Array.from(new Set(ccUsers.map((u) => u.userId)));

    if (ccIds.length) {
      // 1) Push Noti ให้ CC
      const ccMsg = `${actorName} has recalled memo "${subject}".`;
      await pushNoti(ccIds, actorId, {
        notificationTypeId: 3,
        memoId,
        statusId: 6, // Recall
        message: ccMsg,
      });

      // 2) Filter & Email
      const { filterUsersForEmail } = await import('../lib/notificationPreferences');
      const filteredCcIds = await filterUsersForEmail(ccIds, 'cc-notification');

      if (filteredCcIds.length) {
        const ccRows = await prisma.user.findMany({
          where: { id: { in: filteredCcIds } },
          select: { id: true, name: true, lastname: true, nickname: true, email: true },
        });

        const viewLink = `${FRONTEND_URL}/memo/${memoId}`;
        const statusLabel = "Recalled";
        const ccSubject = `Memo ${ref} — ${statusLabel} (CC)`;

        const ccDetailLines: string[] = [`Recalled by: ${actorName}`];

        // We already have some memo info from above, need businessUnit/dept/expiresAt for email templates
        const memoDetails = await prisma.masterMemo.findUnique({
          where: { id: memoId },
          select: {
            businessUnit: { select: { name: true } },
            department: { select: { name: true } },
            expiresAt: true
          }
        });
        const buName = memoDetails?.businessUnit?.name ?? "-";
        const deptName = memoDetails?.department?.name ?? "-";
        const expiresAtText = formatExpiresAt(memoDetails?.expiresAt);

        for (const u of ccRows) {
          if (!u.email) continue;
          const display = toDisplayName(u, { includeNickname: true }) || `User#${u.id}`;

          const ccPlain = buildCcPlain(
            display,
            actorName,
            subject ?? "",
            ref,
            viewLink,
            typeName,
            buName,
            deptName,
            expiresAtText,
            { statusId: 6, statusLabel, detailLines: ccDetailLines }
          );

          const ccHtml = buildCcHtml(
            display,
            actorName,
            subject ?? "",
            ref,
            viewLink,
            typeName,
            buName,
            deptName,
            expiresAtText,
            { statusId: 6, statusLabel, detailLines: ccDetailLines }
          );

          await sendEmail([u.email], ccSubject, ccPlain, ccHtml, []);
        }
      }
    }
  } catch (err) {
    console.error("❌ [notifyRecallUpdate] error sending CC notifications", err);
  }
}

// ✅ แทนที่ฟังก์ชันเดิมทั้งก้อนนี้
async function getActiveExtraApproversForEmail(memoId: number) {
  // ดึงทุก extra line (ล่าสุดก่อน)
  const lines = await prisma.extraApprovalLine.findMany({
    where: { memoId },
    orderBy: { id: "desc" },
    select: { id: true, status: true },
  });
  if (!lines.length) return [];

  // ใช้ทุกเส้นที่ยัง active; ถ้าไม่มี active เลย ใช้ไลน์ล่าสุดเพียงเส้นเดียว
  const ACTIVE = new Set<ExtraStatus>(["PENDING", "IN_PROGRESS"]);
  const activeIds = lines.filter((l) => ACTIVE.has(l.status)).map((l) => l.id);
  const targetIds = activeIds.length ? activeIds : [lines[0].id];

  // โหลด approver ของทุกเส้นเป้าหมาย
  const rows = await prisma.extraApprover.findMany({
    where: { extraId: { in: targetIds } },
    select: {
      userId: true,
      actedAt: true,
      status: { select: { name: true } },
    },
    orderBy: { userId: "asc" },
  });
  if (!rows.length) return [];

  // map สถานะ -> code
  const toCode = (
    r: (typeof rows)[number]
  ): "waiting" | "approved" | "rejected" | "terminated" => {
    const n = (r.status?.name ?? "").toLowerCase();
    if (n.includes("reject")) return "rejected";
    if (n.includes("terminat")) return "terminated";   // ✅ เพิ่มบรรทัดนี้ (terminat ครอบทั้ง terminate/terminated)
    if (n.includes("approve") || r.actedAt) return "approved";
    return "waiting";
  };

  // รวมผู้ใช้ที่ซ้ำกันหลายเส้น โดยเลือกสถานะที่ "แรงสุด" (rejected > waiting > approved)
  const severity: Record<"waiting" | "approved" | "rejected" | "terminated", number> = {
    approved: 0,
    waiting: 1,
    rejected: 2,
    terminated: 5,
  };
  const byUser = new Map<number, "waiting" | "approved" | "rejected" | "terminated">();

  for (const r of rows) {
    const code = toCode(r);
    const prev = byUser.get(r.userId);
    if (prev == null || severity[code] > severity[prev]) {
      byUser.set(r.userId, code);
    }
  }

  // โหลดชื่อผู้ใช้ตาม userId ที่ได้หลัง dedupe
  const userIds = Array.from(byUser.keys());
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true, lastname: true, nickname: true },
  });
  const nameMap = new Map(
    users.map((u) => [
      u.id,
      toDisplayName(u, { includeNickname: true }) || `User#${u.id}`,
    ])
  );

  // (ออปชัน) เรียงให้ดูง่าย: ตามชื่อ
  userIds.sort((a, b) =>
    (nameMap.get(a) ?? "").localeCompare(nameMap.get(b) ?? "")
  );

  return userIds.map((userId) => ({
    userId,
    name: nameMap.get(userId) ?? `User#${userId}`,
    statusCode: byUser.get(userId)!,
  }));
  // ถ้าอยาก “ซ่อนไปเลย” เมื่ออนุมัติแล้ว ให้เปิดบรรทัดนี้:
  // .filter(r => r.statusCode !== "approved")
}

// ✅ สร้างตาราง HTML (ขึ้นเลขลำดับใหม่ในแต่ละตาราง)
function renderApproverTable(
  title: string,
  items: Array<{ name: string; statusCode: StatusCode; isLevelSatisfied?: boolean; level?: number }>
) {
  // Group approvers by level for proper numbering
  const levelGroups = new Map<number, Array<{ name: string; statusCode: StatusCode; isLevelSatisfied?: boolean }>>();
  
  items.forEach(item => {
    const level = item.level ?? 0; // Default to level 0 if not provided (for extra approvers)
    if (!levelGroups.has(level)) {
      levelGroups.set(level, []);
    }
    levelGroups.get(level)!.push(item);
  });

  // Sort levels and generate rows with hierarchical numbering
  const sortedLevels = Array.from(levelGroups.keys()).sort((a, b) => a - b);
  
  const rows = sortedLevels.flatMap(level => {
    const approversInLevel = levelGroups.get(level)!;
    
    return approversInLevel.map((it, indexInLevel) => {
      const badge =
        it.statusCode === "waiting"
          ? '<span style="color:#3498db;">Waiting for approval</span>'
          : it.statusCode === "approved"
            ? it.isLevelSatisfied 
              ? '<span style="color:#27ae60;">Level approved</span>'  // Show "Level approved" for satisfied levels
              : '<span style="color:#27ae60;">Approved</span>'        // Show "Approved" for individual approvals
            : it.statusCode === "terminated"
              ? '<span style="color:#b58900;">Terminated</span>'   // ✅ ใหม่
              : '<span style="color:#e74c3c;">Rejected</span>';

      // Generate hierarchical numbering: {level+1}.{index_in_level+1} or just {level+1} if only one approver
      const levelNumber = level + 1;
      const approverNumber = approversInLevel.length > 1 
        ? `${levelNumber}.${indexInLevel + 1}` 
        : `${levelNumber}`;

      return `
        <tr>
          <td style="padding:8px;border:1px solid #ddd;">${approverNumber} ${it.name}</td>
          <td style="padding:8px;border:1px solid #ddd;">${badge}</td>
        </tr>`;
    });
  }).join("");


  return `
    <h3 style="margin:8px 0 6px 0;">${title}</h3>
    <table style="border-collapse:collapse;width:100%;margin:6px 0 20px 0;">
      <thead>
        <tr>
          <th style="padding:8px; border:1px solid #ddd; text-align:left;">Approver</th>
          <th style="padding:8px; border:1px solid #ddd; text-align:left;">Status</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}
function formatExpiresAt(dt?: Date | null): string | null {
  if (!dt) return null;
  try {
    // เวลาไทยอ่านง่าย; จะเปลี่ยน timezone/locale ตามต้องการก็ได้
    return dt.toLocaleString("th-TH", {
      timeZone: "Asia/Bangkok",
      hour12: false,
    });
  } catch {
    // fallback
    return dt.toISOString().replace("T", " ").replace("Z", " UTC");
  }
}

type StatusCode = "waiting" | "approved" | "rejected" | "terminated";

function norm(code?: string): StatusCode {
  const c = (code ?? "").toLowerCase();
  if (c.includes("terminat")) return "terminated"; // ครอบทั้ง terminate/terminated
  if (c.includes("reject")) return "rejected";
  if (c.includes("approve")) return "approved";
  return "waiting";
}
async function buildApproverTablesHtml(memoId: number) {
  const latestVer = await getLatestVersion(memoId);
  const main = await getApproverLineStatus(memoId, latestVer);       // [{ name, level, statusCode, isLevelSatisfied }]
  const extra = await getActiveExtraApproversForEmail(memoId); // [{ userId, name, statusCode }]

  const mainHtml = renderApproverTable(
    "Main approval line",
    main.map(a => ({ 
      name: a.name, 
      level: a.level, // Include level information for hierarchical numbering
      statusCode: norm(a.statusCode),
      isLevelSatisfied: a.isLevelSatisfied 
    }))
  );

  const extraHtml = extra.length
    ? renderApproverTable(
      "Extra approval line",
      extra.map((e, idx) => ({ 
        name: e.name, 
        level: idx, // Use sequential levels for extra approvers since they don't have hierarchy
        statusCode: norm(e.statusCode),
        isLevelSatisfied: false // Extra approvers don't have level satisfaction logic
      }))
    )
    : "";

  return mainHtml + extraHtml;
}

async function sendEmailsAsync({
  receivers,
  subject,
  message,
  ref,
  typeName,
  buName,
  deptName, // <-- NEW
  memoId,
  statusId,
  ownerId,
  versionOverride,
  notificationTypeSlug = 'status-approved', // Default to status-approved if not specified
}: {
  receivers: number[];
  subject: string;
  message: string;
  ref: string | number;
  typeName: string;
  buName: string;
  deptName: string;
  memoId: number;
  statusId: number;
  ownerId: number;
  versionOverride?: number;
  notificationTypeSlug?: string;
}) {
  // ✅ Filter users based on their email notification preferences
  console.log(`[sendEmailsAsync] Filtering users using preference: ${notificationTypeSlug}`);
  const filteredReceivers = await filterUsersForEmail(receivers, notificationTypeSlug);

  if (!filteredReceivers.length) {
    console.log(`[sendEmailsAsync] No users want email notifications for ${notificationTypeSlug}`);
    return;
  }

  const logoPath = path.resolve(
    process.cwd(), // -> .../backend
    "..", // -> ขึ้นไป .../HL-EMEMO-DEPLOYED
    "frontend",
    "public",
    "img",
    "New-ememo-icon-4.png"
  );

  const commentCount = await prisma.comment.count({ where: { memoId } });
  const attachedCount = await prisma.attachedFile.count({ where: { memoId } });
  // ใต้ส่วนที่หาคอมเมนต์/ไฟล์แนบ
  const memoExpireRow = await prisma.masterMemo.findUnique({
    where: { id: memoId },
    select: { expiresAt: true },
  });
  const expiresAtText = formatExpiresAt(memoExpireRow?.expiresAt);

  let signedPdf: Buffer;
  try {
    signedPdf = await createSignedPdfBuffer(memoId);
  } catch (err) {
    console.error("❌ สร้าง signed PDF ไม่สำเร็จ:", err);
    signedPdf = Buffer.alloc(0);
  }

  // map display name ของผู้รับ
  const userNameMap = new Map<number, string>();
  const nameRows = await prisma.user.findMany({
    where: { id: { in: filteredReceivers } },
    select: { id: true, name: true, lastname: true, nickname: true },
  });
  for (const u of nameRows) {
    userNameMap.set(
      u.id,
      toDisplayName(u, { includeNickname: true }) || `User#${u.id}`
    );
  }

  const approverTable = await buildApproverTablesHtml(memoId);

  /* 2) โหลดแถว waiting เวอร์ชันล่าสุด + ล้าง token เก่า */
  const pendings = await getPendingActions(memoId, versionOverride);
  if (pendings.length) {
    await prisma.memoApproverAction.updateMany({
      where: { id: { in: pendings.map((p) => p.actionId) } },
      data: { emailToken: null },
    });
  }

  /* 3) สร้าง–เก็บ–ส่งเมลเฉพาะคนที่อยู่ใน filteredReceivers */
  const uniqueActions = new Map<number, any>();
  for (const p of pendings) {
    if (!filteredReceivers.includes(p.userId)) continue;
    const existing = uniqueActions.get(p.userId);
    // Keep action with lower level (or first one found if undefined level)
    if (!existing || (p.level !== undefined && existing.level !== undefined && p.level < existing.level)) {
      uniqueActions.set(p.userId, p);
    } else if (!existing) {
      uniqueActions.set(p.userId, p);
    }
  }

  await Promise.all(
    Array.from(uniqueActions.values()).map(async (p) => {
      const token = makeEmailToken(memoId, p.actionId);
      await prisma.memoApproverAction.update({
        where: { id: p.actionId },
        data: { emailToken: token },
      });

      const approveLink = `${BASE_URL}/api/memos/action/email?token=${token}&action=approve`;
      const rejectLink = `${FRONTEND_URL}/memo/${memoId}?action=reject`;
      const viewLink = `${FRONTEND_URL}/memo/${memoId}`;
      const terminateLink = `${FRONTEND_URL}/memo/${memoId}?action=terminate`;
      const approveWithConditionLink = `${FRONTEND_URL}/memo/${memoId}?action=approve-with-condition`;

      // ชื่อผู้รับ
      const recipientName =
        userNameMap.get(p.userId) ?? p.name ?? `User#${p.userId}`;

      await sendEmail(
        [p.email],
        `Notification for memo ${ref}: ${subject}`,
        buildPlain(
          recipientName,
          message,
          ref,
          memoId,
          approveLink,
          rejectLink,
          viewLink,
          terminateLink,
          approveWithConditionLink,
          buName,
          deptName,
          typeName,
          commentCount,
          attachedCount,
          expiresAtText
        ),
        buildHtml(
          recipientName,
          message,
          subject,
          ref,
          typeName,
          buName,
          deptName,
          approverTable, // ✅ ตาราง main + extra
          memoId,
          statusId,
          approveLink,
          rejectLink,
          terminateLink,
          viewLink,
          approveWithConditionLink,
          p.userId === ownerId,
          commentCount,
          attachedCount,
          expiresAtText
        ),
        [
          {
            filename: safeFilename(typeof ref === "number" ? String(ref) : ref, ".pdf"),
            content: signedPdf,
            contentType: "application/pdf",
          },
        ]
      );
    })
  );
}

/* ---------------- template helper (สั้นๆ) ------------------------------- */
function buildPlain(
  name: string,
  msg: string,
  ref: string | number,
  memoId: number,
  approveLink: string,
  rejectLink: string,
  viewLink: string,
  terminateLink: string,
  approveWithConditionLink: string,
  bu: string,
  dept: string,
  typeName: string,
  commentCount: number,
  attachedCount: number,
  expiresAtText?: string | null,
  conditionOrReason?: string | null
): string {
  const expiryLine = expiresAtText ? `Link expires on: ${expiresAtText}\n` : "";
  const extraLine = conditionOrReason ? `\n${conditionOrReason}\n` : "";

  return `Hello ${name}

${msg}
${extraLine}
✅ Approve: ${approveLink}
✅ Approve With Condition: ${approveWithConditionLink}
❌ Reject:  ${rejectLink}
👁️ View Memo: ${viewLink}
Terminate : ${terminateLink}
Memo Type    : ${typeName}
Memo Number  : ${ref}
Business Unit    : ${bu}
Department       : ${dept}
View in System   : ${BASE_URL}/memos/${memoId}

Comments Total   : ${commentCount}
Attachments Total: ${attachedCount}
${expiryLine}Ref: ${ref}

`;
}

function buildHtml(
  recipientName: string,
  message: string,
  subject: string,
  ref: string | number,
  documentType: string,
  businessUnit: string,
  department: string,
  approverTable: string,
  memoId: number,
  statusId: number,
  approveLink: string,
  rejectLink: string,
  terminateLink: string,
  viewLink: string,
  approveWithConditionLink: string,
  isOwner: boolean,
  commentCount: number,
  attachmentCount: number,
  expiresAtText?: string | null,
  conditionOrReason?: string | null
) {
  // ถ้าเป็นสถานะสรุป ให้ไม่มีปุ่ม
  const isFinal = [3, 4, 7].includes(statusId);

  // สร้าง section สำหรับแสดง condition/reason
  const extraSection = conditionOrReason ? `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-bottom:20px;">
      <tr>
        <td style="background-color:#fff8e1;border-left:4px solid ${statusId === 3 ? '#f59e0b' : '#ef4444'};padding:15px;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;color:#2d3748;">
          <strong style="color:${statusId === 3 ? '#d97706' : '#dc2626'};">${statusId === 3 ? 'Approval Condition:' : statusId === 4 ? 'Reject Reason:' : 'Termination Reason:'}</strong><br>
          <span style="white-space:pre-wrap;">${conditionOrReason}</span>
        </td>
      </tr>
    </table>` : '';

  // Outlook mobile strips <style> blocks, so all styles must be inline.
  // Use table-based buttons for maximum compatibility.
  const btnRow = (href: string, bg: string, label: string) => `
    <tr>
      <td align="center" style="padding:6px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;min-width:260px;">
          <tr>
            <td align="center" style="background:${bg};padding:12px 24px;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;font-weight:600;">
              <a href="${href}" style="color:#ffffff;text-decoration:none;display:block;" target="_blank">${label}</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;

  const ownerBtns = `
    ${btnRow(approveLink, "#28a745", "Approve")}
    ${btnRow(approveWithConditionLink, "#d97706", "Approve With Conditions")}
    ${btnRow(viewLink, "#3182ce", "View Memo")}`;

  const approverBtns = `
    ${btnRow(approveLink, "#28a745", "Approve")}
    ${btnRow(approveWithConditionLink, "#d97706", "Approve With Conditions")}
    ${btnRow(rejectLink, "#e8c113", "Revision Required")}
    ${btnRow(terminateLink, "#dc3545", "Terminate")}
    ${btnRow(viewLink, "#3182ce", "View Memo")}`;

  const actionButtons = isFinal
    ? ``
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
        ${isOwner ? ownerBtns : approverBtns}
       </table>`;

  const expiryBlock = expiresAtText
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
        <tr><td align="center" style="padding:10px 0;font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#718096;">
          This memo will expire on <strong>${expiresAtText}</strong><br>
          <span style="font-size:12px;">Ref: ${ref}</span>
        </td></tr>
       </table>`
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
        <tr><td align="center" style="padding:10px 0;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;color:#718096;">
          Ref: ${ref}
        </td></tr>
       </table>`;

  // Helper for detail rows (2-column table row)
  const detailRow = (label: string, value: string | number, isBadge = false) => {
    const valHtml = isBadge
      ? `<span style="display:inline-block;padding:4px 10px;background:#e2e8f0;font-size:13px;font-family:'Segoe UI',Arial,sans-serif;">${value}</span>`
      : `<span style="color:#2d3748;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;">${value}</span>`;
    return `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;font-weight:600;color:#4a5568;width:40%;">${label}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${valHtml}</td>
      </tr>`;
  };

  return `
<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>${subject}</title>
  <!--[if mso]>
  <style type="text/css">
    table { border-collapse: collapse; }
    td { font-family: 'Segoe UI', Arial, sans-serif; }
  </style>
  <![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#f0f4f8;font-family:'Segoe UI',Arial,sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <!-- Outer wrapper -->
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background-color:#f0f4f8;">
    <tr>
      <td align="center" style="padding:30px 10px;">
        <!-- Main container -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="680" style="border-collapse:collapse;max-width:680px;width:100%;background-color:#ffffff;">

          <!-- Banner -->
          <tr>
            <td style="background-color:${statusColorBg(statusId)};border-left:5px solid ${statusColorBorder(statusId)};padding:15px;text-align:center;">
              <h1 style="margin:0;font-family:'Segoe UI',Arial,sans-serif;font-size:20px;font-weight:600;color:${statusColorText(statusId)};">${statusTitle(statusId)}</h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding:30px;">

              <!-- Greeting -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
                <tr>
                  <td style="font-family:'Segoe UI',Arial,sans-serif;font-size:16px;color:#2d3748;padding-bottom:20px;">
                    Hello <strong>${recipientName}</strong>
                  </td>
                </tr>
              </table>

              <!-- Message box -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-bottom:25px;">
                <tr>
                  <td style="background-color:#f8fafc;border-left:4px solid #3498db;padding:20px;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;color:#2d3748;">
                    ${message}
                    ${approverTable}
                  </td>
                </tr>
              </table>

              <!-- Condition/Reason Section -->
              ${extraSection}

              <!-- Details table -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-bottom:30px;">
                ${detailRow("Subject", subject)}
                ${detailRow("Memo Number", ref)}
                ${detailRow("Business Unit", businessUnit)}
                ${detailRow("Department", department)}
                ${detailRow("Type", documentType)}
                ${detailRow("Comments", commentCount, true)}
                ${detailRow("Attachments", attachmentCount, true)}
              </table>

              <!-- Action buttons -->
              ${actionButtons}

              <!-- Expiry -->
              ${expiryBlock}

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#f7fafc;text-align:center;padding:20px;font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#718096;border-top:1px solid #e2e8f0;">
              &copy; ${new Date().getFullYear()} hylifegroup&nbsp;|&nbsp;
              <a href="https://hylifegroup.com" style="color:#3182ce;text-decoration:none;">hylifegroup.com</a>
            </td>
          </tr>

        </table>
        <!-- /Main container -->
      </td>
    </tr>
  </table>
</body>
</html>
`;
}

/* สี/ข้อความตาม status (คงเดิม) */
function statusTitle(status: number): string {
  switch (status) {
    case 4:
      return "Memo Has Rejected";
    case 3:
      return "Memo Has Approved";
    case 7:
      return "Memo Has Terminated";
    default:
      return "Memo Is Processing";
  }
}

function statusColorBg(s: number) {
  return s === 4
    ? "#fff8f8"
    : s === 3
      ? "#f8fff9"
      : s === 7
        ? "#f5f7fa"
        : "#f5f8ff";
}
function statusColorBorder(s: number) {
  return s === 4
    ? "#e74c3c"
    : s === 3
      ? "#2ecc71"
      : s === 7
        ? "#7f8c8d"
        : "#3498db";
}
function statusColorText(s: number) {
  return s === 4
    ? "#e74c3c"
    : s === 3
      ? "#27ae60"
      : s === 7
        ? "#34495e"
        : "#2980b9";
}

// ตรวจสิทธิ์: ต้องเป็น approver ที่ "กำลัง waiting" ที่ level ต่ำสุด ณ เวอร์ชันล่าสุด
async function isCurrentMinWaitingApprover(
  memoId: number,
  userId: number
): Promise<boolean> {
  const version = await getLatestVersion(memoId);

  const waiting = await prisma.approvalActionStatus.findUnique({
    where: { code: "waiting" },
    select: { id: true },
  });
  if (!waiting) return false;

  // ดึงทุก action ที่ waiting ของเวอร์ชันล่าสุด พร้อม userId และ level ของ loaUser
  const rows = await prisma.memoApproverAction.findMany({
    where: { memoId, version, statusId: waiting.id },
    select: {
      loaUser: { select: { userId: true, level: true } },
    },
  });
  if (rows.length === 0) return false;

  const minLevel = Math.min(...rows.map((r) => r.loaUser.level));
  return rows.some(
    (r) => r.loaUser.userId === userId && r.loaUser.level === minLevel
  );
}

export const updateMemoStatus: RequestHandler = async (req, res, next) => {
  const { userId, statusId, fileId, terminationReason } = req.body;
  const memoId = Number(req.params.id);

  const userName = await getUserDisplayName(Number(userId));
  const ownerId = await prisma.masterMemo
    .findUnique({
      where: { id: memoId },
      select: { userId: true },
    })
    .then((r) => r!.userId);

  const terminated = await prisma.memoStatusPivot.findFirst({
    where: { memoId, statusId: 7 },
    select: { id: true },
  });
  if (terminated && statusId !== 7) {
    res.status(400).json({
      error: "This memo is already terminated; no further actions allowed.",
    });
    return; // ✅ ต้อง return
  }

  const getPrevStatusId = async () => {
    const prev = await prisma.memoStatusPivot.findFirst({
      where: { memoId },
      orderBy: { createdAt: "desc" },
      select: { statusId: true },
    });
    return prev?.statusId ?? 0;
  };

  /* ───────── Terminate (7) ───────── */
  if (statusId === 7) {
    // 1) ต้องอยู่ Processing ก่อน
    const latest = await prisma.memoStatusPivot.findFirst({
      where: { memoId },
      orderBy: { createdAt: "desc" },
      select: { statusId: true },
    });
    if (latest?.statusId !== 5) {
      const statusName = await prisma.status.findUnique({
        where: { id: latest?.statusId ?? 0 },
        select: { name: true },
      }).then(r => r?.name ?? "Unknown");

      console.warn(
        `[updateMemoStatus] BLOCKED: memoId=${memoId} cannot terminate. Current status: ${statusName}(${latest?.statusId}). User: ${userId}`
      );

      // Return specific status codes for frontend i18n lookup
      const statusCodeMap: Record<number, string> = {
        1: "DRAFT_TERMINATE",
        3: "APPROVED",
        4: "REJECTED",
        6: "RECALLED",
        7: "TERMINATED",
        8: "EXPIRED",
      };

      const statusCodeKey = statusCodeMap[latest?.statusId ?? 0] || "UNKNOWN";

      res.status(409).json({
        code: "MEMO_STATUS_CHANGED",
        statusCode: statusCodeKey,
        currentStatus: statusName,
        currentStatusId: latest?.statusId,
      });
      return;
    }

    // 2) ต้องเป็น approver ที่รออยู่ในเลเวลต่ำสุด
    const allowed = await isCurrentMinWaitingApprover(memoId, Number(userId));
    if (!allowed) {
      res.status(403).json({
        error:
          "Only the current waiting approver at the minimal level can terminate.",
      });
      return;
    }

    const prevStatusId = await getPrevStatusId();

    // 3) เตรียมข้อมูลสำหรับอัปเดต MemoApproverAction
    const latestVer =
      (
        await prisma.memoApproverAction.aggregate({
          where: { memoId },
          _max: { version: true },
        })
      )._max.version ?? 0;

    const clonePivots = await getClonePivots(memoId);
    const myPivot = clonePivots.find((p) => p.userId === Number(userId));
    const myLoaUserId = myPivot?.id ?? null;

    const [waitingStat, rejectedStat, terminatedStat] = await Promise.all([
      prisma.approvalActionStatus.findUnique({
        where: { code: "waiting" },
        select: { id: true },
      }),
      prisma.approvalActionStatus.findUnique({
        where: { code: "rejected" },
        select: { id: true },
      }),
      prisma.approvalActionStatus.findUnique({
        where: { code: "terminated" },
        select: { id: true },
      }),
    ]);

    // 4) ทำธุรกรรมเดียว: อัปเดต ApproverAction + สร้าง StatusPivot + History
    await prisma.$transaction(async (tx) => {
      // 4.1 อัปเดตสถานะของคนที่กด terminate (เฉพาะเวอร์ชันล่าสุด และยัง waiting/rejected)
      if (myLoaUserId && terminatedStat?.id) {   
        const updateResult = await tx.memoApproverAction.updateMany({
          where: {
            memoId,
            loaUserId: myLoaUserId,
            version: latestVer,
            statusId: {
              in: [waitingStat?.id ?? -1, rejectedStat?.id ?? -1],
            },
          },
          data: {
            statusId: terminatedStat.id,
            actedAt: new Date(),
            terminationReason: terminationReason || null,
          },
        });
        
        // Verify the update
        const verifyRecord = await tx.memoApproverAction.findFirst({
          where: {
            memoId,
            loaUserId: myLoaUserId,
            version: latestVer,
          },
          include: {
            status: { select: { code: true, label: true } },
          },
        });
      }

      // 4.2 บันทึกสถานะ 7 (Terminate) → อัปเดตแถวเดิม
      await updateCurrentMemoStatusTx(tx, memoId, ownerId, 7);

      // 4.3 บันทึกประวัติ
      await tx.memoHistory.create({
        data: {
          memoId,
          userId,
          statusId: prevStatusId, // เก็บสถานะก่อนหน้า
          action: terminationReason
            ? `${userName} terminated the memo: ${terminationReason}`
            : `${userName} terminated the memo`,
          actiontype: ActionType.TERMINATE,
          timestamp: new Date(),
          ...(fileId ? { fileId } : {}),
        },
      });
    });

    // 5) ตอบกลับ แล้วค่อย notify async
    res.status(202).json({ message: "Memo terminated (emails queued)" });

    setImmediate(async () => {
      try {
        const myLevel =
          (await getClonePivots(memoId)).find((p) => p.userId === userId)
            ?.level ?? 0;
        await notifyStatusUpdate(memoId, userId, userName, 7, myLevel);
      } catch (e) {
        console.error("async terminate-flow failed", e);
      }
    });
    return;
  }

  // helper บันทึกประวัติ
  async function recordHistory(
    action: string,
    actiontype: ActionType,
    memoId: number,
    userId: number,
    prevStatusId: number,
    fileId?: number
  ) {
    await prisma.memoHistory.create({
      data: {
        memoId,
        userId,
        statusId: prevStatusId, // เก็บสถานะก่อนหน้า
        action,
        actiontype,
        timestamp: new Date(),
        ...(fileId != null ? { fileId } : {}),
      },
    });
  }

  /* ───────── Terminate (7) ───────── */
  if (statusId === 7) {
    // เก็บสถานะก่อนหน้าไว้ใน History
    const prevStatusId = await getPrevStatusId();

    // หาเวอร์ชันล่าสุดของแอ็กชันผู้อนุมัติ
    const latestVer =
      (
        await prisma.memoApproverAction.aggregate({
          where: { memoId },
          _max: { version: true },
        })
      )._max.version ?? 0;

    // หา pivot ของผู้ที่กด terminate
    const clonePivots = await getClonePivots(memoId); // มีอยู่แล้วในโค้ดคุณ
    const myPivot = clonePivots.find((p) => p.userId === Number(userId));
    const myLoaUserId = myPivot?.id ?? null;

    // ดึงสถานะ terminated จาก ApprovalActionStatus
    const terminatedStat = await prisma.approvalActionStatus.findUnique({
      where: { code: "terminated" },
      select: { id: true },
    });

    // ทำเป็นทรานแซกชัน: อัปเดต ApproverAction + บันทึก History
    await prisma.$transaction(async (tx) => {
      // อัปเดตสถานะของผู้ที่กดยุติ (เฉพาะเวอร์ชันล่าสุด และเฉพาะแถวที่ยัง waiting/rejected)
      if (myLoaUserId && terminatedStat?.id) {
        await tx.memoApproverAction.updateMany({
          where: {
            memoId,
            loaUserId: myLoaUserId,
            version: latestVer,
            status: { code: { in: ["waiting", "rejected"] } },
          },
          data: {
            statusId: terminatedStat.id,
            actedAt: new Date(),
          },
        });
      }

      // บันทึกประวัติการยุติ
      await tx.memoHistory.create({
        data: {
          memoId,
          userId,
          statusId: prevStatusId, // เก็บสถานะก่อนหน้า
          action: `${userName} terminated the memo`,
          actiontype: ActionType.TERMINATE,
          timestamp: new Date(),
          ...(fileId ? { fileId } : {}),
        },
      });
    });

    // ตอบกลับทันที แล้วค่อย notify แบบ async
    res.status(202).json({ message: "Memo terminated (emails queued)" });

    setImmediate(async () => {
      try {
        const myLevel =
          (await getClonePivots(memoId)).find((p) => p.userId === userId)
            ?.level ?? 0;
        await notifyStatusUpdate(memoId, userId, userName, 7, myLevel);
      } catch (e) {
        console.error("async terminate-flow failed", e);
      }
    });

    return;
  }

  /* ---------- Recall (6) ---------- */
  if (statusId === 6) {
    const prevStatusId = await getPrevStatusId();
    const approvedBefore = await getApprovedUsersInLatestVersion(memoId);

    await updateCurrentMemoStatus(memoId, ownerId, 6);
    await updateCurrentMemoStatus(memoId, ownerId, 1);
    await recordHistory(
      `${userName} recalled memo`,
      ActionType.RECALL, // ✅
      memoId,
      userId,
      prevStatusId,
      fileId
    );

    res.json({ message: "Recalled and set to Draft" });
    setImmediate(() =>
      notifyRecallUpdate(memoId, userId, userName)
    );
    return;
  }

  /* ---------- Reject (4) ---------- */
  if (statusId === 4) {
    const { rejectReason } = req.body;
    
    // Get previous status before updating
    const prevStatusId = await prisma.memoStatusPivot
      .findFirst({ 
        where: { memoId }, 
        orderBy: { id: "desc" }, 
        select: { statusId: true } 
      })
      .then((r) => r?.statusId ?? 0);
    
    await updateCurrentMemoStatus(memoId, ownerId, 4);

    const myLevel =
      (await getClonePivots(memoId)).find((p) => p.userId === userId)?.level ??
      0;

    // Get rejected status ID
    const rejectedStat = await prisma.approvalActionStatus.findUnique({
      where: { code: "rejected" },
      select: { id: true },
    });

    // Save reject reason to MemoApproverAction and update status
    const myPivot = await prisma.lineOfApprovalUserPivotForUse.findFirst({
      where: { memoId, userId },
      select: { id: true },
    });

    if (myPivot) {
      const latestVersion = await prisma.memoApproverAction
        .findFirst({
          where: { memoId, loaUserId: myPivot.id },
          orderBy: { version: "desc" },
          select: { version: true },
        })
        .then((r) => r?.version ?? 0);

      // Update status to rejected and save reject reason
      await prisma.memoApproverAction.updateMany({
        where: {
          memoId,
          loaUserId: myPivot.id,
          version: latestVersion,
        },
        data: { 
          statusId: rejectedStat?.id,
          actedAt: new Date(),
          rejectReason: rejectReason || null,
        },
      });
    }

    // Create history entry with reject reason
    const actionText = rejectReason 
      ? `${userName} rejected the memo: ${rejectReason}`
      : `${userName} rejected the memo`;
    
    await prisma.memoHistory.create({
      data: {
        memoId,
        userId,
        statusId: prevStatusId, // Use previous status, not current
        action: actionText,
        actiontype: ActionType.REJECT,
        timestamp: new Date(),
      },
    });

    res.status(202).json({ message: "Rejected (emails will be sent async)" });
    setImmediate(() =>
      notifyStatusUpdate(memoId, userId, userName, 4, myLevel)
    );
    return;
  }

  /* ---------- Publish (5) ---------- */
  if (statusId === 5) {
    const clonePivots = await getClonePivots(memoId);
    if (!clonePivots.length) {
      res.status(400).json({ error: "Memo has no approver pivots" });
      return;
    }
    const myLevel = clonePivots.find((p) => p.userId === userId)?.level ?? 0;

    // (ถ้าต้องชัวร์เรื่องลำดับ) แนะนำหุ้ม 1)+2) เป็น transaction ด้วย: updateCurrentMemoStatusTx + history
    await updateCurrentMemoStatus(memoId, ownerId, 5);

    const prevStatusId = await prisma.memoStatusPivot
      .findFirst({ where: { memoId }, orderBy: { id: "desc" }, select: { statusId: true } })
      .then((r) => r?.statusId ?? 0);

    await prisma.memoHistory.create({
      data: {
        memoId,
        userId,
        fileId,
        statusId: prevStatusId,
        action: prevStatusId === 6 ? `${userName} edited memo` : `${userName} published the memo`,
        actiontype: prevStatusId === 6 ? ActionType.EDIT : ActionType.PUBLISH,
        timestamp: new Date(),
      },
    });

    // ✅ ตอบ client ก่อน
    res.json({ message: "Processing started (no version bump)" });

    // 🔔 ค่อย notify แบบ async หลังส่ง response
    setImmediate(async () => {
      try {
        // 1) แจ้ง Approver (Processing)
        await notifyStatusUpdate(memoId, userId, userName, 5, myLevel);

        // 2) แจ้ง CC (หลังจากสถานะเป็น Processing แล้ว)
        const ccUsers = await prisma.memoCc.findMany({
          where: { memoId },
          select: { userId: true },
        });
        const ccIds = Array.from(new Set(ccUsers.map((u) => u.userId)));
        if (ccIds.length) {
          await notifyCcAssigned(memoId, userId, ccIds);
        }
      } catch (e) {
        console.error("async publish-notify failed", e);
      }
    });

    return;
  }



  /* ---------- Draft (1) ---------- */
  if (statusId === 1) {
    // ✅ หา prevStatusId ก่อน
    const prevStatus = await prisma.memoStatusPivot.findFirst({
      where: { memoId, userId },
      orderBy: { createdAt: "desc" },
      select: { statusId: true },
    });
    await updateCurrentMemoStatus(memoId, ownerId, 1);

    // ถ้าสถานะก่อนหน้าเป็น Recall (6) ให้ใช้ ActionType.EDIT แทน DRAFT
    const actionTypeToUse =
      prevStatus?.statusId === 6 ? ActionType.EDIT : ActionType.DRAFT;

    await prisma.memoHistory.create({
      data: {
        memoId,
        userId,
        statusId: prevStatus?.statusId ?? 1, // เก็บสถานะเดิม
        action:
          prevStatus?.statusId === 6
            ? `${userName} edited memo after recalled`
            : `${userName} set status Draft`,
        actiontype: actionTypeToUse,
        timestamp: new Date(),
        fileId: fileId || undefined,
      },
    });

    res.json({ message: "Reverted to Draft" });
    return;
  }

  /* ---------- Approved (3) ---------- */
  if (statusId === 3) {
    await updateCurrentMemoStatus(memoId, ownerId, 3);
    const prevStatusId = await getPrevStatusId();
    await recordHistory(
      `${userName} set status Approved`,
      ActionType.APPROVE, // ✅
      memoId,
      userId,
      prevStatusId,
      fileId
    );

    const memo = await prisma.masterMemo.findUnique({
      where: { id: memoId },
      select: { approvalLineId: true },
    });

    let myLevel: number | null = null;
    if (memo?.approvalLineId) {
      const myPivot = await prisma.lineOfApprovalUserPivot.findFirst({
        where: { lineOfApprovalId: memo.approvalLineId, userId },
      });
      myLevel = myPivot?.level ?? 0;
    }

    await notifyStatusUpdate(memoId, userId, userName, 3, myLevel);

    res.json({ message: "Fully Approved" });
    return;
  }

  res.status(400).json({ error: "Invalid status transition" });
};

// GET /api/memos/:id/actions
export const getMemoActions: RequestHandler = async (req, res, next) => {
  const memoId = Number(req.params.id);
  if (isNaN(memoId)) {
    res.status(400).json({ error: "Invalid memo ID" });
    return;
  }
  try {
    // สำหรับแต่ละ loaUserId ให้นำเวอร์ชันล่าสุด (max version) มา 1 record
    const actions = await prisma.memoApproverAction.findMany({
      where: { memoId },
      orderBy: [{ loaUserId: "asc" }, { version: "desc" }],
      distinct: ["loaUserId"],
      select: {
        loaUserId: true,
        status: { select: { code: true } },
      },
    });

    res.json(
      actions.map((a) => ({
        loaUserId: a.loaUserId,
        statusCode: a.status.code,
      }))
    );
  } catch (err) {
    next(err);
  }
};

// POST /api/memos/:id/action
export const actOnMemo: RequestHandler = async (req, res) => {
  const memoId = Number(req.params.id);
  const {
    loaUserId,
    statusCode,
    userId: userIdFromBody,
  } = req.body as {
    loaUserId: number;
    statusCode:
    | "processing"
    | "approved"
    | "rejected"
    | "recalled"
    | "terminated";
    userId?: number; // optional fallback
  };

  // --- basic validations ---
  if (Number.isNaN(memoId)) {
    res.status(400).json({ error: "Invalid memoId" });
    return;
  }
  if (!loaUserId) {
    res.status(400).json({ error: "loaUserId required" });
    return;
  }
  if (!statusCode) {
    res.status(400).json({ error: "statusCode required" });
    return;
  }

  try {
    const actorId = (req.user as any)?.id ?? userIdFromBody;
    if (!actorId) {
      res.status(401).json({ error: "Unauthenticated (no actorId)" });
      return;
    }
    const actorName = await getUserDisplayName(actorId);

    // ✅ Check current memo status before allowing action
    const currentStatusPivot = await prisma.memoStatusPivot.findFirst({
      where: { memoId },
      orderBy: { createdAt: "desc" },
      include: { status: { select: { id: true, name: true } } },
    });

    const currentStatusId = currentStatusPivot?.status?.id ?? null;
    const currentStatusName = currentStatusPivot?.status?.name ?? "Unknown";

    // Log the action attempt for debugging
    console.log(
      `[actOnMemo] memoId=${memoId}, action=${statusCode}, currentStatus=${currentStatusName}(${currentStatusId}), actor=${actorId}`
    );

    // For approve/reject actions, memo must be in "Processing" (statusId = 5)
    if (statusCode === "approved" || statusCode === "rejected") {
      if (currentStatusId !== 5) {
        console.warn(
          `[actOnMemo] BLOCKED: memoId=${memoId} is not in Processing. Current status: ${currentStatusName}(${currentStatusId}). Action: ${statusCode} by user ${actorId}`
        );

        // Return specific status codes for frontend i18n lookup
        const statusCodeMap: Record<number, string> = {
          1: "DRAFT_APPROVE",
          3: "APPROVED",
          4: "REJECTED",
          6: "RECALLED",
          7: "TERMINATED",
          8: "EXPIRED",
        };

        const statusCodeKey = statusCodeMap[currentStatusId ?? 0] || "UNKNOWN";

        res.status(409).json({
          code: "MEMO_STATUS_CHANGED",
          statusCode: statusCodeKey,
          currentStatus: currentStatusName,
          currentStatusId,
        });
        return;
      }
    }

    switch (statusCode) {
      case "approved":
      case "rejected": {
        await recordApproverAction(memoId, loaUserId, statusCode);

        // (ออปชัน) เก็บประวัติทุกครั้ง
        await logMemoHistory({
          memoId,
          userId: actorId,
          statusCode,
          actorName,
        });

        // ✅ อัปเดต client ก่อน

        res.json({ ok: true });

        // 🧵 งานหนักค่อยทำทีหลัง + broadcast รอบ 2
        setImmediate(async () => {
          try {
            await evaluateAndUpdateMemoStatus(memoId, loaUserId);
          } catch (e) {
            console.error(`evaluate&update (${statusCode}) failed:`, e);
          }
        });
        return;
      }

      case "recalled": {
        const latest =
          (
            await prisma.memoApproverAction.aggregate({
              where: { memoId },
              _max: { version: true },
            })
          )._max.version ?? 1;

        await handleRecall({ memoId, loaUserId, latestVersion: latest });

        await logMemoHistory({
          memoId,
          userId: actorId,
          statusCode: "recalled",
          actorName,
        });

        // ✅ อัปเดต client ก่อน

        res.json({ ok: true });

        // 🧵 งานหนักค่อยทำทีหลัง + broadcast รอบ 2
        setImmediate(async () => {
          try {
            await evaluateAndUpdateMemoStatus(memoId, loaUserId);
          } catch (e) {
            console.error("evaluate&update (recall) failed:", e);
          }
        });
        return;
      }

      case "processing":
      case "terminated": {
        await logMemoHistory({
          memoId,
          userId: actorId,
          statusCode,
          actorName,
        });

        // ✅ อัปเดต client ก่อน

        res.json({ ok: true });

        // 🧵 งานหนักค่อยทำทีหลัง + broadcast รอบ 2
        setImmediate(async () => {
          try {
            await evaluateAndUpdateMemoStatus(memoId, loaUserId);
          } catch (e) {
            console.error(`evaluate&update (${statusCode}) failed:`, e);
          }
        });
        return;
      }

      default: {
        res.status(400).json({ error: "Invalid status transition" });
        return;
      }
    }
  } catch (err) {
    console.error("actOnMemo error:", err);
    res.status(500).json({ error: "internal error" });
  }
};

export async function getLatestVersion(memoId: number) {
  const v = await prisma.memoApproverAction.aggregate({
    where: { memoId },
    _max: { version: true },
  });
  return v._max.version ?? 1;
}

async function getCurrentWaitingSummary(memoId: number): Promise<{ level: number; names: string[] } | null> {
  const version = await getLatestVersion(memoId);
  const waiting = await prisma.approvalActionStatus.findUnique({
    where: { code: "waiting" },
    select: { id: true },
  });
  if (!waiting) return null;

  const rows = await prisma.memoApproverAction.findMany({
    where: { memoId, version, statusId: waiting.id },
    select: {
      loaUser: {
        select: {
          level: true,
          user: { select: { name: true, lastname: true, nickname: true } },
        },
      },
    },
    orderBy: { loaUser: { level: "asc" } },
  });
  if (!rows.length) return null;

  const minLevel = Math.min(...rows.map(r => r.loaUser.level));
  const atMin = rows.filter(r => r.loaUser.level === minLevel);
  const names = atMin.map(r => toDisplayName(r.loaUser.user, { includeNickname: true }) || "Unknown");
  return { level: minLevel, names };
}


/* ถูกเรียกจาก actOnMemo ถ้า statusCode === 'recalled' */
export async function handleRecall({
  memoId,
  loaUserId,
  latestVersion, // ไม่ใช้บั๊มเวอร์ชันแล้ว
}: {
  memoId: number;
  loaUserId: number;
  latestVersion: number;
}) {
  // 1) จำลองเป็น recall-clear: รีเซ็ตเฉพาะ waiting/rejected ให้กลับเป็น waiting (approved คงไว้)
  await resetActionsInCurrentVersion(memoId, { only: "waiting_or_rejected" });

  // 2) สถานะรวม → เปลี่ยนสถานะ "บนแถวเดิม" แทนการ create แถวใหม่ (ทำแบบอะตอมมิก)
  await prisma.$transaction(async (tx) => {
    const bump = async (newStatusId: number) => {
      // กัน unique ก่อน: ถ้ามี (memoId, loaUserId, newStatusId) อยู่แล้ว ลบทิ้ง
      await tx.memoStatusPivot.deleteMany({
        where: { memoId, userId: loaUserId, statusId: newStatusId },
      });

      // หาแถวล่าสุดของคู่ (memoId, loaUserId)
      const cur = await tx.memoStatusPivot.findFirst({
        where: { memoId, userId: loaUserId },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });

      if (cur) {
        // อัปเดตแถวเดิม → เปลี่ยน statusId + ขยับ timestamp
        await tx.memoStatusPivot.update({
          where: { id: cur.id },
          data: { statusId: newStatusId, createdAt: new Date() },
        });
      } else {
        // ยังไม่เคยมีเลย → ค่อย create ครั้งแรก
        await tx.memoStatusPivot.create({
          data: { memoId, userId: loaUserId, statusId: newStatusId },
        });
      }
    };

    await bump(6); // Recall
    await bump(1); // Draft
  });
}

async function upsertStatusWithHistory(
  memoId: number,
  ownerId: number,
  newStatusId: number, // 1..7
  actorId: number | null, // คนที่กดอนุมัติ/ปฏิเสธ (nullable for flexible slots)
  actorName: string,
  actionType: ActionType, // APPROVE / REJECT / PROCESSING ...
  fileId?: number
) {
  // สถานะก่อนหน้า (ของ memo ใบนี้)
  const prev = await prisma.memoStatusPivot.findFirst({
    where: { memoId },
    orderBy: { id: "desc" },
    select: { statusId: true },
  });
  const prevStatusId = prev?.statusId ?? 0;

  // ข้อความสำหรับ history

  // อัปเดตสถานะรวม + เขียนประวัติในครั้งเดียว
  await updateCurrentMemoStatus(memoId, ownerId, newStatusId);
}

// --- ที่ส่วนบนสุดของไฟล์ ---
export async function evaluateAndUpdateMemoStatus(
  memoId: number,
  actorPivotId: number
) {
  const loaPivot = await prisma.lineOfApprovalUserPivotForUse.findUnique({
    where: { id: actorPivotId },
    include: { user: { select: { id: true, name: true, lastname: true, nickname: true } } },
  });
  if (!loaPivot) throw new Error("loaUserPivotId ไม่ถูกต้อง");

  const actorId = loaPivot.userId;
  const actorName = loaPivot.user?.name || "Unknown User";
  const myLevel = loaPivot.level;

  const memo = await prisma.masterMemo.findUnique({
    where: { id: memoId },
    select: { userId: true, subject: true },
  });
  if (!memo) throw new Error("memo not found");

  const approverPivots = await getClonePivots(memoId);
  const approverPivotIds = approverPivots.map((a) => a.id);

  const version = await getLatestVersion(memoId);
  const actions = await prisma.memoApproverAction.findMany({
    where: { memoId, version, loaUserId: { in: approverPivotIds } },
    select: {
      id: true,
      loaUserId: true,
      status: { select: { code: true } },
      loaUser: { select: { level: true, approvalRequirement: true } }
    },
  }) as any[];

  // Group actions by level to handle approval requirements
  const actionsByLevel = new Map<number, typeof actions>();
  for (const action of actions) {
    const level = action.loaUser.level;
    const levelActions = actionsByLevel.get(level) || [];
    levelActions.push(action);
    actionsByLevel.set(level, levelActions);
  }

  // Group approver pivots by level
  const pivotsByLevel = new Map<number, typeof approverPivots>();
  for (const pivot of approverPivots) {
    const level = pivot.level;
    const levelPivots = pivotsByLevel.get(level) || [];
    levelPivots.push(pivot);
    pivotsByLevel.set(level, levelPivots);
  }

  // Check if any level has rejected actions
  let anyRejected = false;
  for (const levelActions of actionsByLevel.values()) {
    if (levelActions.some(a => a.status.code === "rejected")) {
      anyRejected = true;
      break;
    }
  }

  // Check if all levels are approved based on their approval requirements
  let allLevelsApproved = true;

  for (const [level, levelPivots] of pivotsByLevel) {
    const levelActions = actionsByLevel.get(level) || [];

    if (levelPivots.length === 0) continue;

    // Get approval requirement for this level (all pivots at same level should have same requirement)
    const approvalRequirement = levelPivots[0].approvalRequirement || "ALL";

    const approvedActions = levelActions.filter(a => a.status.code === "approved");
    const rejectedActions = levelActions.filter(a => a.status.code === "rejected");

    if (approvalRequirement === "ANY") {
      // For ANY: level is complete if at least one approval exists
      const hasApproval = approvedActions.length > 0;
      const allRejected = rejectedActions.length === levelPivots.length;

      // Level is incomplete if: all rejected OR no approvals yet
      if (allRejected || !hasApproval) {
        allLevelsApproved = false;
        break;
      }
      // If hasApproval is true, this level is complete - continue to next level
    } else {
      // For ALL: need all approvers to approve
      const allApproved = approvedActions.length === levelPivots.length;

      if (!allApproved) {
        allLevelsApproved = false;
        break;
      }
    }
  }

  if (anyRejected) {
    await upsertStatusWithHistory(
      memoId,
      memo.userId,
      4,
      actorId,
      actorName,
      ActionType.REJECT
    );
    if (actorId) {
      await notifyStatusUpdate(memoId, actorId, actorName, 4, myLevel);
    }
  } else if (allLevelsApproved) {
    await upsertStatusWithHistory(
      memoId,
      memo.userId,
      3,
      actorId,
      actorName,
      ActionType.APPROVE
    );
    if (actorId) {
      await notifyStatusUpdate(memoId, actorId, actorName, 3, myLevel);
    }
  } else {
    await upsertStatusWithHistory(
      memoId,
      memo.userId,
      5,
      actorId,
      actorName,
      ActionType.PROCESSING
    );
    if (actorId) {
      await notifyStatusUpdate(memoId, actorId, actorName, 5, myLevel);
    }
  }
}

// POST /api/memos/:id/recall-preserve
export const recallPreserve: RequestHandler = async (req, res) => {
  const memoId = Number(req.params.id);
  const userId = Number(req.body.userId);
  const fileId = req.body.fileId ? Number(req.body.fileId) : undefined;

  // ✅ Check current status - can only recall from Processing (5) or Rejected (4)
  const currentStatus = await prisma.memoStatusPivot.findFirst({
    where: { memoId },
    orderBy: { createdAt: "desc" },
    select: { statusId: true },
  });

  const currentStatusId = currentStatus?.statusId ?? 0;

  // Allow recall from Processing (5) or Rejected (4) for revision
  // Block: Approved (3), Terminated (7), Draft (1), Recalled (6)
  if (currentStatusId !== 5 && currentStatusId !== 4) {
    const statusCodeMap: Record<number, string> = {
      1: "DRAFT_APPROVE",  // Already draft
      3: "APPROVED",       // Already approved - cannot recall
      6: "RECALLED",       // Already recalled
      7: "TERMINATED",     // Already terminated
      8: "EXPIRED",        // Already expired
    };

    const statusCodeKey = statusCodeMap[currentStatusId] || "UNKNOWN";

    console.warn(
      `[recallPreserve] BLOCKED: memoId=${memoId} is not in Processing/Rejected. Current status: ${currentStatusId}. User: ${userId}`
    );
    res.status(409).json({
      code: "MEMO_STATUS_CHANGED",
      statusCode: statusCodeKey,
      currentStatusId,
    });
    return;
  }

  const userRec = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true },
  });
  const userName = userRec?.name ?? `User#${userId}`;

  // ✅ เก็บรายชื่อ approved ก่อนที่ DB จะเปลี่ยน
  const approvedBefore = await getApprovedUsersInLatestVersion(memoId);

  // ✅ ดึงสถานะก่อนหน้า (ล่าสุด)
  const prevStatus = await prisma.memoStatusPivot.findFirst({
    where: { memoId },
    orderBy: { id: "desc" },
    select: { statusId: true },
  });
  const prevStatusId = prevStatus?.statusId ?? 0;

  /* 1) เอา Processing/Approved/Rejected เก่าออกก่อน */
  await prisma.memoStatusPivot.deleteMany({
    where: { memoId, statusId: { in: [3, 4, 5] } },
  });

  /* 2) Recall */
  await updateCurrentMemoStatus(memoId, userId, 6);
  await updateCurrentMemoStatus(memoId, userId, 1);
  await prisma.memoHistory.create({
    data: {
      memoId,
      userId,
      fileId,
      statusId: prevStatusId, // ✅ เก็บสถานะก่อนหน้า
      action: `${userName} recalled memo (preserve)`,
      actiontype: "RECALL", // ต้องตรงกับ enum ActionType
      timestamp: new Date(),
    },
  });
  await prisma.memoHistory.create({
    data: {
      memoId,
      userId,
      fileId,
      statusId: 6, // ✅ ตรงนี้ถ้าต้องการให้เป็น "ก่อน Draft" ก็ใส่สถานะ Recall (6)
      action: `${userName} set memo back to Draft (preserve)`,
      actiontype: "RECALL", // หรือจะใช้ "RECALL" ก็ได้ถ้าถือว่าเป็น action เดียวกัน
      timestamp: new Date(),
    },
  });

  res.json({ message: "Recall (preserve) done" });

  // ✅ แจ้งเตือน CC (async)
  setImmediate(() => {
    notifyRecallUpdate(memoId, userId, userName).catch(
      console.error
    );
  });
};

async function getStatusIdByName(name: string, tx?: Prisma.TransactionClient) {
  const client = tx ?? prisma;

  // ถ้าเรียก Recall แต่ใน DB เป็น Recalled (หรือกลับกัน) ให้ครอบทั้งคู่ไว้
  const aliases = new Set<string>([name]);
  if (/^recall(ed)?$/i.test(name)) {
    aliases.add("Recall");
    aliases.add("Recalled");
  }

  const row = await client.status.findFirst({
    where: { name: { in: Array.from(aliases) } },
    select: { id: true, name: true },
  });

  if (!row) throw new Error(`Status not found: ${name}`);
  return row.id;
}

// POST /api/memos/:id/recall-clear
export const recallClear: RequestHandler = async (req, res) => {
  const memoId = Number(req.params.id);
  const actorId = req.user!.id;
  const fileId = req.body.fileId ? Number(req.body.fileId) : undefined;

  if (!Number.isFinite(memoId)) {
    res.status(400).json({ error: "invalid memoId" });
    return;
  }

  // ✅ Check current status - can only recall from Processing (5) or Rejected (4)
  const currentStatus = await prisma.memoStatusPivot.findFirst({
    where: { memoId },
    orderBy: { createdAt: "desc" },
    select: { statusId: true },
  });

  const currentStatusId = currentStatus?.statusId ?? 0;

  // Allow recall from Processing (5) or Rejected (4) for revision
  // Block: Approved (3), Terminated (7), Draft (1), Recalled (6)
  if (currentStatusId !== 5 && currentStatusId !== 4) {
    const statusCodeMap: Record<number, string> = {
      1: "DRAFT_APPROVE",  // Already draft
      3: "APPROVED",       // Already approved - cannot recall
      6: "RECALLED",       // Already recalled
      7: "TERMINATED",     // Already terminated
      8: "EXPIRED",        // Already expired
    };

    const statusCodeKey = statusCodeMap[currentStatusId] || "UNKNOWN";

    console.warn(
      `[recallClear] BLOCKED: memoId=${memoId} is not in Processing/Rejected. Current status: ${currentStatusId}. User: ${actorId}`
    );
    res.status(409).json({
      code: "MEMO_STATUS_CHANGED",
      statusCode: statusCodeKey,
      currentStatusId,
    });
    return;
  }

  try {
    const [rejectedId, recallId, draftId, rawName] = await Promise.all([
      getStatusIdByName("Rejected"),
      getStatusIdByName("Recalled"),
      getStatusIdByName("Draft"),
      getUserDisplayName(actorId), // ✅ เพิ่มชื่อผู้กด action
    ]);
    const userName = rawName ?? `User#${actorId}`;

    const touchPivot = async (
      tx: Prisma.TransactionClient,
      memoId: number,
      userId: number,
      statusId: number
    ) => {
      await tx.memoStatusPivot.upsert({
        where: { memoId_userId_statusId: { memoId, userId, statusId } },
        create: { memoId, userId, statusId },
        update: { createdAt: new Date() }, // ให้เป็น "ล่าสุด" เสมอ
      });
    };

    // ใช้ตอน notify (อยู่นอก tx ได้)
    const [owner, approvedBefore] = await Promise.all([
      prisma.masterMemo.findUnique({
        where: { id: memoId },
        select: { userId: true },
      }).then(r => r!),
      getApprovedUsersInLatestVersion(memoId),
    ]);

    const result = await prisma.$transaction(async (tx) => {
      // 0) สถานะล่าสุดของเจ้าของเมโม
      const prev = await tx.memoStatusPivot.findFirst({
        where: { memoId, userId: owner.userId },
        orderBy: { createdAt: "desc" },
        select: { statusId: true },
      });
      const prevStatusId = prev?.statusId ?? 0;

      // 0.1) เคยมีการ reject มั้ย (ก่อนลบ)
      const [extraLineRejected, extraApproverRejected] = await Promise.all([
        tx.extraApprovalLine.count({ where: { memoId, status: ExtraStatus.REJECTED } }).then(c => c > 0),
        tx.extraApprover.count({ where: { extra: { memoId }, statusId: rejectedId } }).then(c => c > 0),
      ]);
      const ownerRejected = prevStatusId === rejectedId;
      const isRevise = ownerRejected || extraLineRejected || extraApproverRejected;

      // 1) รีเซ็ต actions เวอร์ชันปัจจุบันให้กลับไป waiting (approved คงไว้)
      const currentVersion = await resetActionsInCurrentVersion(memoId);

      // 2) สถานะรวม → Recall → Draft (touch เวลาเสมอ)
      await touchPivot(tx, memoId, owner.userId, recallId);
      await touchPivot(tx, memoId, owner.userId, draftId);

      // 3) ลบทุก extra-line + เขียน history ว่าลบไปกี่เส้น (พร้อมชื่อคนทำ)
      const extraLineIds = await tx.extraApprovalLine
        .findMany({ where: { memoId }, select: { id: true } })
        .then(rows => rows.map(r => r.id));

      if (extraLineIds.length > 0) {
        // ✅ เก็บ Comment ไว้แต่ระบุว่าเป็นของ Extraที่ถูก Recall 
        await tx.comment.updateMany({
          where: { extraApprovalLineId: { in: extraLineIds } },
          data: { 
            isRecallExtra: true,
            // (Optional) เราอาจจะตัดความสัมพันธ์ทิ้งเพื่อไม่ให้ติด Foreign Key หริอ Prisma อาจจะ SetNull ให้ถ้าไม่ตัด
            // แต่ปกติกำหนดแค่ isRecallExtra ก็พอถ้า schema เป็น onDelete: SetNull 
            // ขอเผื่อความชัวร์แก้เป็น null ด้วย
            extraApprovalLineId: null 
          }
        });

        await tx.extraApprover.deleteMany({ where: { extraId: { in: extraLineIds } } });
        await tx.extraApprovalLine.deleteMany({ where: { id: { in: extraLineIds } } });
        await tx.memoHistory.create({
          data: {
            memoId,
            userId: actorId,
            actiontype: ActionType.UPDATE,
            action: `The Extra Approval line was removed due to the recall process`,
            fileId,
            timestamp: new Date(),
          },
        });
      }

      // 4) History หลัก → Revised ถ้าเคยมี reject (owner หรือ extra) มิฉะนั้น Recalled
      await tx.memoHistory.create({
        data: {
          memoId,
          userId: actorId,
          fileId,
          statusId: prevStatusId || undefined,
          action: isRevise ? `${userName} revised the memo` : `${userName} recalled the memo`,
          actiontype: isRevise ? ActionType.REVISE : ActionType.RECALL,
          timestamp: new Date(),
        },
      });

      return { currentVersion, removedExtraLines: extraLineIds.length };
    });

    // ✅ response ใส่คนที่ทำ action ออกไปด้วย
    res.json({
      message: `Recall done on version ${result.currentVersion}`,
      removedExtraLines: result.removedExtraLines,
      performedBy: { id: actorId, name: userName },
    });

    // notify หลัง commit (ส่งชื่อเดียวกัน)
    setImmediate(async () => {
      notifyRecallUpdate(memoId, actorId, userName).catch(console.error);
    });
  } catch (e) {
    console.error("recall error:", e);
    res.status(500).json({ error: "internal error" });
  }
};


// GET /api/memos/:id/approver-status
export const getApproverStatus: RequestHandler = async (req, res) => {
  const memoId = Number(req.params.id);
  console.log(`[getApproverStatus] Called for memoId=${memoId}`);

  if (Number.isNaN(memoId)) {
    res.status(400).json({ error: "Invalid memo ID" });
    return;
  }

  const version = await getLatestVersion(memoId);

  const snapshot = await prisma.memoApproverAction.findMany({
    where: { memoId, version },
    select: {
      loaUserId: true,
      actedAt: true,
      createdAt: true,
      status: { select: { code: true } }, // waiting | approved | rejected | terminated
      loaUser: {
        select: {
          level: true,
          userId: true,
          approvalRequirement: true, // Include approval requirement
          user: { select: { name: true, lastname: true, nickname: true } },
        },
      },
    },
    orderBy: [{ loaUser: { level: "asc" } }, { loaUserId: "asc" }],
  });

  // --- กรณีมี snapshot (ใช้เส้นอนุมัติของเวอร์ชันนี้) ---
  if (snapshot.length > 0) {
    // เวลาเริ่มรอบนี้ (สร้าง action เวอร์ชันนี้ครั้งแรก) = min(createdAt)
    const roundStart = new Date(
      Math.min(...snapshot.map((r) => r.createdAt?.getTime() ?? Date.now()))
    );

    // Group by level to check if ANY requirement is met
    const levelApprovalStatus = new Map<number, {
      hasApproval: boolean;
      requirement: string;
      approvedBy?: string;
    }>();

    for (const row of snapshot) {
      const level = row.loaUser.level;
      if (!levelApprovalStatus.has(level)) {
        levelApprovalStatus.set(level, {
          hasApproval: false,
          requirement: row.loaUser.approvalRequirement || "ALL"
        });
      }
      if (row.status?.code === "approved") {
        const levelStatus = levelApprovalStatus.get(level)!;
        levelStatus.hasApproval = true;
        levelStatus.approvedBy = toDisplayName(row.loaUser.user, { includeNickname: true }) || `User#${row.loaUser.userId}`;
      }
    }

    console.log(`[getApproverStatus] memoId=${memoId}, levelApprovalStatus:`,
      Array.from(levelApprovalStatus.entries()).map(([level, status]) => ({
        level,
        requirement: status.requirement,
        hasApproval: status.hasApproval,
        approvedBy: status.approvedBy
      }))
    );

    const data = snapshot.map((row, idx) => {
      const code = (row.status?.code ?? "waiting") as
        | "waiting"
        | "approved"
        | "rejected"
        | "terminated";

      const level = row.loaUser.level;
      const levelStatus = levelApprovalStatus.get(level);
      const isLevelSatisfied = levelStatus?.requirement === "ANY" && levelStatus?.hasApproval;

      console.log(`[getApproverStatus] Processing user ${row.loaUser.userId} at level ${level}: code=${code}, requirement=${levelStatus?.requirement}, hasApproval=${levelStatus?.hasApproval}, isLevelSatisfied=${isLevelSatisfied}`);

      if (code !== "waiting") {
        // คนนี้ตัดสินใจแล้ว → ใช้เวลาของตัวเอง
        const since = row.actedAt ?? row.createdAt ?? null;
        return {
          userId: row.loaUser.userId,
          name:
            toDisplayName(row.loaUser.user, { includeNickname: true }) ||
            `User#${row.loaUser.userId}`,
          level: row.loaUser.level,
          statusCode: code,
          actedAt: row.actedAt?.toISOString(),
          since: since ? since.toISOString() : null,
          approvalRequirement: row.loaUser.approvalRequirement || "ALL",
          isLevelSatisfied,
          approvedBy: levelStatus?.approvedBy,
        };
      }

      // code === 'waiting' → check if level is satisfied
      if (isLevelSatisfied) {
        // Level already satisfied by another approver - show as "not_required"
        console.log(`[getApproverStatus] User ${row.loaUser.userId} at level ${level} marked as not_required. Approved by: ${levelStatus?.approvedBy}`);
        return {
          userId: row.loaUser.userId,
          name:
            toDisplayName(row.loaUser.user, { includeNickname: true }) ||
            `User#${row.loaUser.userId}`,
          level: row.loaUser.level,
          statusCode: "not_required" as const,
          actedAt: undefined,
          since: null,
          approvalRequirement: row.loaUser.approvalRequirement || "ALL",
          isLevelSatisfied: true,
          approvedBy: levelStatus?.approvedBy,
        };
      }

      // code === 'waiting' and level not satisfied → ยืมเวลาคนก่อนหน้า
      // หา “คนก่อนหน้า” ที่เลเวลต่ำกว่าและกดแล้ว (มี actedAt)
      const prevDone = snapshot
        .filter(
          (s) =>
            s.loaUser.level < row.loaUser.level &&
            (s.status?.code === "approved" || s.status?.code === "rejected") &&
            s.actedAt
        )
        .sort((a, b) => b.loaUser.level - a.loaUser.level)[0];

      const borrowedSince = prevDone?.actedAt ?? roundStart;

      return {
        userId: row.loaUser.userId,
        name:
          toDisplayName(row.loaUser.user, { includeNickname: true }) ||
          `User#${row.loaUser.userId}`,
        level: row.loaUser.level,
        statusCode: "waiting" as const,
        actedAt: undefined,
        // โชว์เวลาเริ่มนับเป็นของ “คนก่อนหน้า” จนกว่าคนนี้จะกดเอง
        since: borrowedSince ? borrowedSince.toISOString() : null,
        approvalRequirement: row.loaUser.approvalRequirement || "ALL",
        isLevelSatisfied: false,
      };
    });

    res.json(data);
    return;
  }

  // --- Fallback: ยังไม่มี snapshot (ยัง Draft) → อ่านจาก LineOfApproval ---
  const memo = await prisma.masterMemo.findUnique({
    where: { id: memoId },
    select: { approvalLineId: true },
  });

  if (!memo?.approvalLineId) {
    res.json([]);
    return;
  }

  const pivots = await prisma.lineOfApprovalUserPivot.findMany({
    where: { lineOfApprovalId: memo.approvalLineId },
    select: {
      userId: true,
      level: true,
      user: { select: { name: true, lastname: true, nickname: true } },
    },
    orderBy: [{ level: "asc" }, { userId: "asc" }],
  });

  const fallbackData = pivots.map((p) => ({
    userId: p.userId,
    name:
      toDisplayName(p.user, { includeNickname: true }) || `User#${p.userId}`,
    level: p.level,
    statusCode: "waiting" as const,
    actedAt: undefined,
    since: null, // ยังไม่เริ่มรอบอนุมัติ
  }));

  res.json(fallbackData);
};

// POST /api/memos/approver-status/bulk
// Body: { memoIds: number[] }
// Response: Record<memoId, ApproverStatus[]>
//
// Bulk replacement for the per-memo GET version above. Frontend dashboard previously
// fired one request per memo (N+1) which scaled poorly with hundreds/thousands of memos.
// This endpoint enforces the same visibility rules as getAllMemos and reuses the exact
// snapshot/fallback logic of getApproverStatus.
export const getApproverStatusBulk: RequestHandler = async (req, res) => {
  const currentUserId = (req as any).user?.id;
  if (!currentUserId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const raw = (req.body?.memoIds ?? []) as unknown[];
  if (!Array.isArray(raw)) {
    res.status(400).json({ error: "memoIds must be an array" });
    return;
  }

  const memoIds = Array.from(
    new Set(
      raw
        .map((v) => Number(v))
        .filter((v): v is number => Number.isInteger(v) && v > 0)
    )
  );

  if (memoIds.length === 0) {
    res.json({});
    return;
  }

  if (memoIds.length > 5000) {
    res.status(400).json({ error: "Too many memoIds (max 5000)" });
    return;
  }

  try {
    // Visibility filter — mirrors getAllMemos
    const visibleMemos = await prisma.masterMemo.findMany({
      where: {
        id: { in: memoIds },
        OR: [
          { userId: currentUserId },
          { approverActions: { some: { loaUser: { userId: currentUserId } } } },
          { ccRecipients: { some: { userId: currentUserId } } },
          {
            extraApprovalLines: {
              some: { approvers: { some: { userId: currentUserId } } },
            },
          },
          { commentTags: { some: { userId: currentUserId } } },
        ],
      },
      select: {
        id: true,
        userId: true,
        approvalLineId: true,
        statuses: {
          include: { status: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    const allowed = visibleMemos.filter((m) => {
      const latest = m.statuses?.[0]?.status?.name ?? "";
      if (latest === "Deleted") return false;
      if (latest === "Draft" && m.userId !== currentUserId) return false;
      return true;
    });

    if (allowed.length === 0) {
      res.json({});
      return;
    }

    const allowedIds = allowed.map((m) => m.id);
    const approvalLineByMemo = new Map<number, number | null>();
    for (const m of allowed) approvalLineByMemo.set(m.id, m.approvalLineId ?? null);

    // 1) Latest version per memo
    const latestVersions = await prisma.memoApproverAction.groupBy({
      by: ["memoId"],
      where: { memoId: { in: allowedIds } },
      _max: { version: true },
    });
    const versionByMemo = new Map<number, number>();
    for (const v of latestVersions) {
      versionByMemo.set(v.memoId, v._max.version ?? 1);
    }

    // 2) Bulk fetch snapshot rows for every (memoId, version) pair
    const snapshotRows = versionByMemo.size
      ? await prisma.memoApproverAction.findMany({
          where: {
            OR: Array.from(versionByMemo.entries()).map(([memoId, version]) => ({
              memoId,
              version,
            })),
          },
          select: {
            memoId: true,
            loaUserId: true,
            actedAt: true,
            createdAt: true,
            status: { select: { code: true } },
            loaUser: {
              select: {
                level: true,
                userId: true,
                approvalRequirement: true,
                user: {
                  select: { name: true, lastname: true, nickname: true },
                },
              },
            },
          },
          orderBy: [
            { memoId: "asc" },
            { loaUser: { level: "asc" } },
            { loaUserId: "asc" },
          ],
        })
      : [];

    type SnapshotRow = (typeof snapshotRows)[number];
    const snapshotByMemo = new Map<number, SnapshotRow[]>();
    for (const r of snapshotRows) {
      const arr = snapshotByMemo.get(r.memoId);
      if (arr) arr.push(r);
      else snapshotByMemo.set(r.memoId, [r]);
    }

    // 3) Fallback path: memos without snapshot need pivots from LineOfApproval
    const lineIdsToFetch = new Set<number>();
    for (const id of allowedIds) {
      if (!snapshotByMemo.has(id)) {
        const lineId = approvalLineByMemo.get(id);
        if (lineId) lineIdsToFetch.add(lineId);
      }
    }

    const pivots = lineIdsToFetch.size
      ? await prisma.lineOfApprovalUserPivot.findMany({
          where: { lineOfApprovalId: { in: Array.from(lineIdsToFetch) } },
          select: {
            lineOfApprovalId: true,
            userId: true,
            level: true,
            user: { select: { name: true, lastname: true, nickname: true } },
          },
          orderBy: [{ level: "asc" }, { userId: "asc" }],
        })
      : [];

    type Pivot = (typeof pivots)[number];
    const pivotsByLine = new Map<number, Pivot[]>();
    for (const p of pivots) {
      if (p.lineOfApprovalId == null) continue;
      const arr = pivotsByLine.get(p.lineOfApprovalId);
      if (arr) arr.push(p);
      else pivotsByLine.set(p.lineOfApprovalId, [p]);
    }

    // 4) Build per-memo response (same algorithm as getApproverStatus)
    const result: Record<number, any[]> = {};

    for (const memoId of allowedIds) {
      const snapshot = snapshotByMemo.get(memoId);

      if (snapshot && snapshot.length > 0) {
        const roundStart = new Date(
          Math.min(
            ...snapshot.map((r) => r.createdAt?.getTime() ?? Date.now())
          )
        );

        const levelApprovalStatus = new Map<
          number,
          { hasApproval: boolean; requirement: string; approvedBy?: string }
        >();

        for (const row of snapshot) {
          const level = row.loaUser.level;
          if (!levelApprovalStatus.has(level)) {
            levelApprovalStatus.set(level, {
              hasApproval: false,
              requirement: row.loaUser.approvalRequirement || "ALL",
            });
          }
          if (row.status?.code === "approved") {
            const ls = levelApprovalStatus.get(level)!;
            ls.hasApproval = true;
            ls.approvedBy =
              toDisplayName(row.loaUser.user, { includeNickname: true }) ||
              `User#${row.loaUser.userId}`;
          }
        }

        result[memoId] = snapshot.map((row) => {
          const code = (row.status?.code ?? "waiting") as
            | "waiting"
            | "approved"
            | "rejected"
            | "terminated";
          const level = row.loaUser.level;
          const levelStatus = levelApprovalStatus.get(level);
          const isLevelSatisfied =
            levelStatus?.requirement === "ANY" && levelStatus?.hasApproval;

          if (code !== "waiting") {
            const since = row.actedAt ?? row.createdAt ?? null;
            return {
              userId: row.loaUser.userId,
              name:
                toDisplayName(row.loaUser.user, { includeNickname: true }) ||
                `User#${row.loaUser.userId}`,
              level: row.loaUser.level,
              statusCode: code,
              actedAt: row.actedAt?.toISOString(),
              since: since ? since.toISOString() : null,
              approvalRequirement: row.loaUser.approvalRequirement || "ALL",
              isLevelSatisfied,
              approvedBy: levelStatus?.approvedBy,
            };
          }

          if (isLevelSatisfied) {
            return {
              userId: row.loaUser.userId,
              name:
                toDisplayName(row.loaUser.user, { includeNickname: true }) ||
                `User#${row.loaUser.userId}`,
              level: row.loaUser.level,
              statusCode: "not_required" as const,
              actedAt: undefined,
              since: null,
              approvalRequirement: row.loaUser.approvalRequirement || "ALL",
              isLevelSatisfied: true,
              approvedBy: levelStatus?.approvedBy,
            };
          }

          // borrowed since
          const prevDone = snapshot
            .filter(
              (s) =>
                s.loaUser.level < row.loaUser.level &&
                (s.status?.code === "approved" ||
                  s.status?.code === "rejected") &&
                s.actedAt
            )
            .sort((a, b) => b.loaUser.level - a.loaUser.level)[0];
          const borrowedSince = prevDone?.actedAt ?? roundStart;

          return {
            userId: row.loaUser.userId,
            name:
              toDisplayName(row.loaUser.user, { includeNickname: true }) ||
              `User#${row.loaUser.userId}`,
            level: row.loaUser.level,
            statusCode: "waiting" as const,
            actedAt: undefined,
            since: borrowedSince ? borrowedSince.toISOString() : null,
            approvalRequirement: row.loaUser.approvalRequirement || "ALL",
            isLevelSatisfied: false,
          };
        });
      } else {
        // Fallback: no snapshot (Draft) → use LineOfApprovalUserPivot
        const lineId = approvalLineByMemo.get(memoId);
        const lps = lineId ? pivotsByLine.get(lineId) ?? [] : [];
        result[memoId] = lps.map((p) => ({
          userId: p.userId,
          name:
            toDisplayName(p.user, { includeNickname: true }) ||
            `User#${p.userId}`,
          level: p.level,
          statusCode: "waiting" as const,
          actedAt: undefined,
          since: null,
        }));
      }
    }

    // Memos in input but not allowed → simply omitted from response.
    // Memos allowed but with neither snapshot nor approvalLine → empty array.
    res.json(result);
  } catch (err) {
    console.error("[getApproverStatusBulk] failed:", err);
    res.status(500).json({ error: "Failed to fetch approver-status (bulk)" });
  }
};
