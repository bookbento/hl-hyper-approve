// lib/notify.ts
import { Prisma } from "@prisma/client";
import { prisma } from "../../prisma/client";
import { filterUsersForEmail } from "./notificationPreferences";

type NotiData = Omit<
  Prisma.NotificationUncheckedCreateInput,
  "id" | "userId" | "actorId" | "createdAt" | "updatedAt"
>;

export async function pushNoti(
  receiverIds: number[],
  actorId: number,
  data: NotiData,
  notificationSlug?: string
) {
  let finalReceiverIds = receiverIds;

  if (notificationSlug && receiverIds.length > 0) {
    try {
      finalReceiverIds = await filterUsersForEmail(receiverIds, notificationSlug);
    } catch (err) {
      console.error(`[pushNoti] Error filtering users for ${notificationSlug}:`, err);
    }
  }

  if (finalReceiverIds.length === 0) {
    return;
  }

  const tx = finalReceiverIds.map((uid) =>
    prisma.notification.create({
      data: {
        ...data,
        userId: uid,
        actorId,
      } as Prisma.NotificationUncheckedCreateInput,
    })
  );
  // สร้างใน DB แต่ไม่ broadcast ตรงนี้
  await prisma.$transaction(tx);
}
