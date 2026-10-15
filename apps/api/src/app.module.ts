import { Module } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { AdminLogModule } from './common/admin-log/admin-log.module';
import { BusinessUnitModule } from './modules/business-unit/business-unit.module';
import { DepartmentModule } from './modules/department/department.module';
import { TypeModule } from './modules/type/type.module';
import { AdminLogReadModule } from './modules/admin-log/admin-log-read.module';
import { CcGroupModule } from './modules/cc-group/cc-group.module';
import { AuthModule } from './modules/auth/auth.module';
import { UserModule } from './modules/user/user.module';
import { UserSignatureModule } from './modules/user-signature/user-signature.module';
import { FileServingModule } from './modules/file-serving/file-serving.module';
import { GatewayModule } from './common/gateway/gateway.module';
import { ApprovalLineModule } from './modules/approval-line/approval-line.module';
import { MemotypeModule } from './modules/memotype/memotype.module';
import { NotificationModule } from './modules/notification/notification.module';
import { LoaManagementModule } from './modules/loa-management/loa-management.module';
import { MemoCcModule } from './modules/memocc/memocc.module';
import { MemoQueryModule } from './modules/memo-query/memo-query.module';
import { MemoLifecycleModule } from './modules/memo-lifecycle/memo-lifecycle.module';
import { MailModule } from './common/mail/mail.module';
import { MemoCommentModule } from './modules/memo-comment/memo-comment.module';
import { MemoPositionModule } from './modules/memo-position/memo-position.module';
import { MemoPdfModule } from './modules/memo-pdf/memo-pdf.module';
import { MemoNotificationModule } from './modules/memo-notification/memo-notification.module';
import { ExtraApprovalModule } from './modules/extra-approval/extra-approval.module';
import { MemoStatusModule } from './modules/memo-status/memo-status.module';
import { MemoExpiryModule } from './modules/memo-expiry/memo-expiry.module';

@Module({
  imports: [
    PrismaModule,
    MailModule,
    AdminLogModule,
    BusinessUnitModule,
    DepartmentModule,
    TypeModule,
    AdminLogReadModule,
    CcGroupModule,
    AuthModule,
    UserModule,
    UserSignatureModule,
    FileServingModule,
    ApprovalLineModule,
    MemotypeModule,
    NotificationModule,
    LoaManagementModule,
    MemoCcModule,
    MemoQueryModule,
    MemoLifecycleModule,
    MemoCommentModule,
    MemoPositionModule,
    MemoPdfModule,
    MemoNotificationModule,
    ExtraApprovalModule,
    MemoStatusModule,
    MemoExpiryModule,
    GatewayModule,
  ],
  providers: [
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: false, // allow extra fields for multipart/form-data
        transform: true,
      }),
    },
  ],
})
export class AppModule {}
