import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { MemoQueryModule } from '../memo-query/memo-query.module';
import { MemoNotificationModule } from '../memo-notification/memo-notification.module';
import { ExtraApprovalController } from './extra-approval.controller';
import { ExtraApprovalService } from './extra-approval.service';

/** Batch 7b — extra approval lines (see ExtraApprovalController). */
@Module({
  imports: [
    MemoQueryModule,
    MemoNotificationModule,
    JwtModule.register({
      secret: process.env['JWT_SECRET'] ?? 'changeme',
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [ExtraApprovalController],
  providers: [ExtraApprovalService, JwtAuthGuard, Reflector],
  exports: [ExtraApprovalService],
})
export class ExtraApprovalModule {}
