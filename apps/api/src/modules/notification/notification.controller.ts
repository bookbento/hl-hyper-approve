/**
 * NotificationController
 *
 * Mirrors Express notification.routes.ts / notification.controller.ts parity 100%:
 *   GET    /api/notifications                 — paginated list (cursor-based)
 *   GET    /api/notifications/unread-count    — unread badge count
 *   PATCH  /api/notifications/mark-all-read   — mark all as read
 *   PATCH  /api/notifications/:id/mark-read   — mark one as read
 *   DELETE /api/notifications/clear-read      — delete all read notifications
 *
 * Security: JwtAuthGuard on all routes (mirrors Express authenticate middleware).
 */
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard, JwtPayload } from '../../common/guards/jwt.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { NotificationService } from './notification.service';
import { GetNotificationsDto } from './dto/get-notifications.dto';

@Controller()
@UseGuards(JwtAuthGuard)
export class NotificationController {
  constructor(private readonly service: NotificationService) {}

  // GET /api/notifications?unreadOnly=true&limit=20&cursor=42
  @Get('api/notifications')
  getNotifications(
    @CurrentUser() user: JwtPayload,
    @Query() query: GetNotificationsDto,
  ) {
    return this.service.getNotifications(user, {
      unreadOnly: query.unreadOnly,
      limit: query.limit ?? 10,
      cursor: query.cursor,
    });
  }

  // GET /api/notifications/unread-count
  @Get('api/notifications/unread-count')
  getUnreadCount(@CurrentUser() user: JwtPayload) {
    return this.service.getUnreadCount(user);
  }

  // PATCH /api/notifications/mark-all-read
  @Patch('api/notifications/mark-all-read')
  @HttpCode(HttpStatus.OK)
  markAllRead(@CurrentUser() user: JwtPayload) {
    return this.service.markAllRead(user);
  }

  // PATCH /api/notifications/:id/mark-read
  @Patch('api/notifications/:id/mark-read')
  @HttpCode(HttpStatus.OK)
  markOneRead(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.service.markOneRead(user, id);
  }

  // DELETE /api/notifications/clear-read
  @Delete('api/notifications/clear-read')
  @HttpCode(HttpStatus.OK)
  clearRead(@CurrentUser() user: JwtPayload) {
    return this.service.clearRead(user);
  }
}
