import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { MemoQueryModule } from '../memo-query/memo-query.module';
import { MemoNotificationModule } from '../memo-notification/memo-notification.module';
import { ExtraApprovalModule } from '../extra-approval/extra-approval.module';
import { EmailActionController, MemoStatusController } from './memo-status.controller';
import { MemoStatusService } from './memo-status.service';
import { MemoRecallService } from './memo-recall.service';
import { ApproverStatusService } from './approver-status.service';
import { EmailActionService } from './email-action.service';

/** Batch 8b — approve / status / recall / one-click email action (see MemoStatusController). */
@Module({
  imports: [
    MemoQueryModule,
    MemoNotificationModule,
    ExtraApprovalModule,
    JwtModule.register({
      secret: process.env['JWT_SECRET'] ?? 'changeme',
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [MemoStatusController, EmailActionController],
  providers: [
    MemoStatusService,
    MemoRecallService,
    ApproverStatusService,
    EmailActionService,
    JwtAuthGuard,
    Reflector,
  ],
  exports: [MemoStatusService],
})
export class MemoStatusModule {}
