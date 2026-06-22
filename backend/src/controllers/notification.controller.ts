import { RequestHandler } from "express";
import { prisma } from "../../prisma/client";

/* GET /api/notifications ----------------------------------------------*/
export const getNotifications: RequestHandler = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) {
    res.sendStatus(401);
    return;
  }

  const { unreadOnly, limit = 10, cursor } = req.query as any;
  const where: any = { userId };
  if (unreadOnly === "true") where.isRead = false;

  /* 1) ดึง Notification + actor (คนทำ) */
  const notis = await prisma.notification.findMany({
    where,
    take: +limit,
    ...(cursor ? { skip: 1, cursor: { id: +cursor } } : {}),
    orderBy: { createdAt: "desc" },
    include: {
      type: { select: { name: true } },
      memo: { select: { id: true, subject: true, memonumber: true } },
      status: { select: { name: true } },
      comment: { select: { id: true, comment: true } },
      actor: {
        // 🆕 เพิ่ม actor
        select: { id: true, name: true, profileImagePath: true },
      },
    },
  });

  /* 2) Return notifications with profile image URLs instead of base64 */
  const items = notis.map((n) => ({
    ...n,
    actor: n.actor
      ? {
          ...n.actor,
          profileImageUrl: n.actor.profileImagePath
            ? `/uploads/${n.actor.profileImagePath}`
            : null,
        }
      : null,
  }));

  res.setHeader("Cache-Control", "no-store");
  res.json({
    items,
    nextCursor: items.length === +limit ? items[items.length - 1].id : null,
  });
};

/** PATCH /api/notifications/mark-all-read  →  mark isRead = true ทุก notification ของ user */
export const markAllReadNotifications: RequestHandler = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) {
    res.sendStatus(401);
    return;
  }

  const result = await prisma.notification.updateMany({
    where: { userId },
    data: { isRead: true },
  });

  res.json({ updated: result.count });
};

/* GET /api/notifications/unread-count --------------------------------*/
export const getUnreadCount: RequestHandler = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) {
    res.sendStatus(401);
    return;
  }

  const count = await prisma.notification.count({
    where: { userId, isRead: false },
  });
  res.json({ count });
};

/** DELETE /api/notifications/clear-read  →  ลบ notification ที่ isRead = true ทั้งหมดของ user */
export const clearReadNotifications: RequestHandler = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) {
    res.sendStatus(401);
    return;
  }

  // delete all read notifications for this user
  const result = await prisma.notification.deleteMany({
    where: {
      userId,
      isRead: true,
    },
  });

  res.json({ deleted: result.count });
};
// controllers/notification.controller.ts
export const markReadNotification: RequestHandler = async (req, res) => {
  const userId = req.user?.id;
  const id = +req.params.id;
  if (!userId) {res.sendStatus(401);
    return ;
  }

  const noti = await prisma.notification.updateMany({
    where: { id, userId },
    data: { isRead: true },
  });

  if (noti.count === 0) {
     res.sendStatus(404);
    return;
  }
  res.json({ updated: true });
};