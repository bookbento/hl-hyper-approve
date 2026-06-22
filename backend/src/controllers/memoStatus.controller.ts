import { RequestHandler } from "express";
import { prisma } from "../../prisma/client";
import { recordApproverAction } from "../services/memoApproval.service";
import { handleRecall } from "../services/memoRecall.service";
import { logMemoHistory } from "../lib/memoHistory";
import { ActionType, ExtraStatus, Prisma } from "@prisma/client";
import {
  getLatestVersion,
  evaluateAndUpdateMemoStatus,
} from "../services/memoApproveAction.service";
export { getLatestVersion, evaluateAndUpdateMemoStatus } from "../services/memoApproveAction.service";

/* ───── FRONTEND_URL: ต้องมีใน .env ───── */
if (!process.env.FRONTEND_URL) {
  throw new Error("Environment variable FRONTEND_URL is not set");
}

import {
  notifyStatusUpdate,
  notifyCcAssigned,
  notifyRecallUpdate,
} from "../services/memoNotification.service";
// ── Notification helpers re-exported from memoNotification.service ────────────
export {
  notifyStatusUpdate,
  notifyCcAssigned,
  notifyRecallUpdate,
  sendEmailsAsync,
  safeFilename,
  formatExpiresAt,
  statusLabelFromId,
  statusColorHex,
  statusTitle,
  statusColorBg,
  statusColorBorder,
  statusColorText,
  buildPlain,
  buildHtml,
  buildCcPlain,
  buildCcHtml,
  buildApproverTablesHtml,
  renderApproverTable,
  getActiveExtraApproversForEmail,
} from "../services/memoNotification.service";
export type { StatusCode } from "../services/memoNotification.service";


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






// ---- Main: notify CC (template-matched) ----



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
// ✅ แทนที่ฟังก์ชันเดิมทั้งก้อนนี้
// ✅ สร้างตาราง HTML (ขึ้นเลขลำดับใหม่ในแต่ละตาราง)
/* ---------------- template helper (สั้นๆ) ------------------------------- */
/* สี/ข้อความตาม status (คงเดิม) */
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

// recall handlers moved to memoRecall.service (Wave 8)
export { handleRecall, recallPreserve, recallClear } from "../services/memoRecall.service";


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
