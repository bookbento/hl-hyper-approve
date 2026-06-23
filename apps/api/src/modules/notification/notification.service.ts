import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtPayload } from '../../common/guards/jwt.guard';

/**
 * NotificationService
 *
 * Pure business logic — no HTTP, no req/res.
 * Mirrors Express notification.controller.ts parity 100%.
 */
@Injectable()
export class NotificationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /api/notifications
   * Cursor-based paginated list of notifications for the authenticated user.
   */
  async getNotifications(
    user: JwtPayload,
    params: { unreadOnly?: boolean; limit?: number; cursor?: number },
  ) {
    const { unreadOnly, limit = 10, cursor } = params;

    const where: Record<string, unknown> = { userId: user.id };
    if (unreadOnly === true) where['isRead'] = false;

    const notis = await this.prisma.notification.findMany({
      where,
      take: limit,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { createdAt: 'desc' },
      include: {
        type: { select: { name: true } },
        memo: { select: { id: true, subject: true, memonumber: true } },
        status: { select: { name: true } },
        comment: { select: { id: true, comment: true } },
        actor: { select: { id: true, name: true, profileImagePath: true } },
      },
    });

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

    return {
      items,
      nextCursor: items.length === limit ? items[items.length - 1].id : null,
    };
  }

  /**
   * GET /api/notifications/unread-count
   */
  async getUnreadCount(user: JwtPayload): Promise<{ count: number }> {
    const count = await this.prisma.notification.count({
      where: { userId: user.id, isRead: false },
    });
    return { count };
  }

  /**
   * PATCH /api/notifications/mark-all-read
   */
  async markAllRead(user: JwtPayload): Promise<{ updated: number }> {
    const result = await this.prisma.notification.updateMany({
      where: { userId: user.id },
      data: { isRead: true },
    });
    return { updated: result.count };
  }

  /**
   * PATCH /api/notifications/:id/mark-read
   * Returns 404 if notification not found or does not belong to user.
   */
  async markOneRead(user: JwtPayload, id: number): Promise<{ updated: boolean }> {
    const result = await this.prisma.notification.updateMany({
      where: { id, userId: user.id },
      data: { isRead: true },
    });

    if (result.count === 0) {
      throw new NotFoundException('Notification not found');
    }

    return { updated: true };
  }

  /**
   * DELETE /api/notifications/clear-read
   */
  async clearRead(user: JwtPayload): Promise<{ deleted: number }> {
    const result = await this.prisma.notification.deleteMany({
      where: { userId: user.id, isRead: true },
    });
    return { deleted: result.count };
  }
}
