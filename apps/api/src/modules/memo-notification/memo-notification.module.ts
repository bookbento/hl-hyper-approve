import { Module } from '@nestjs/common';
import { MemoNotificationService } from './memo-notification.service';

/**
 * Batch 8a-2 — status-change notifications + emails (no routes).
 * MailService / EmailPreferenceService come from the global MailModule.
 */
@Module({
  providers: [MemoNotificationService],
  exports: [MemoNotificationService],
})
export class MemoNotificationModule {}
