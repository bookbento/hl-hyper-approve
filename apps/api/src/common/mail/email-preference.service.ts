import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Per-user email opt-out by notification type.
 * Ported from filterUsersForEmail in backend/src/lib/notificationPreferences.ts.
 */
@Injectable()
export class EmailPreferenceService {
  private readonly logger = new Logger(EmailPreferenceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Users who should get this notification type: everyone except those who
   * explicitly disabled it. Fails open (returns all users) on unknown slug or
   * error, matching the Express behavior.
   */
  async filterUsersForEmail(userIds: number[], notificationTypeSlug: string): Promise<number[]> {
    try {
      if (userIds.length === 0) return [];

      const notificationType = await this.prisma.notificationType.findUnique({
        where: { slug: notificationTypeSlug },
      });
      if (!notificationType) {
        this.logger.warn(`Unknown notification type slug: ${notificationTypeSlug}`);
        return userIds;
      }

      const disabled = await this.prisma.userNotificationPreference.findMany({
        where: {
          userId: { in: userIds },
          notificationTypeId: notificationType.id,
          emailEnabled: false,
        },
        select: { userId: true },
      });
      const disabledIds = new Set(disabled.map((p) => p.userId));
      return userIds.filter((id) => !disabledIds.has(id));
    } catch (err) {
      this.logger.error(`Error filtering users for email: ${(err as Error).message}`);
      return userIds;
    }
  }
}
