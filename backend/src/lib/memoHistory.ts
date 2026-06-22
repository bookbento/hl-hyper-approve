// utils/memoHistory.ts
import { ActionType } from "@prisma/client";
import { prisma } from "../../prisma/client";

export async function logMemoHistory({
  memoId,
  userId,
  statusCode,  // "approved" | "rejected" | ...
  actorName,   // ชื่อแสดงผล
  fileId,
}: {
  memoId: number;
  userId: number;
  statusCode: string;
  actorName: string;
  fileId?: number;
}) {
  // 1) ดึงสถานะก่อนหน้า
  const prevStatus = await prisma.memoStatusPivot.findFirst({
    where: { memoId },
    orderBy: { id: "desc" }, // เอา record ล่าสุด
    select: { statusId: true },
  });
  const prevStatusId = prevStatus?.statusId ?? 0;

  // 2) mapping statusCode -> ActionType enum
  const actionTypeMap: Record<string, ActionType> = {
    approved: ActionType.APPROVE,
    rejected: ActionType.REJECT,
    recalled: ActionType.RECALL,
    terminated: ActionType.TERMINATE,
    publish: ActionType.PUBLISH,
  };
  const actiontype = actionTypeMap[statusCode.toLowerCase()]  ;

  // 3) mapping statusCode -> action text
  const actionTextMap: Record<string, string> = {
    approved: `${actorName} has approved the memo`,
    rejected: `${actorName} has rejected the memo`,
    recalled: `${actorName} has recalled the memo`,
    terminated: `${actorName} has terminated the memo`,
    publish: `${actorName} has published the memo`,
  };
  const actionText = actionTextMap[statusCode.toLowerCase()] ?? `${actorName} updated the memo`;

  // 4) เขียนประวัติ
  await prisma.memoHistory.create({
    data: {
      memoId,
      userId,
      fileId,
      statusId: prevStatusId, // ✅ เก็บสถานะก่อนหน้า
      action: actionText,
      actiontype,
      timestamp: new Date(),
    },
  });
}
