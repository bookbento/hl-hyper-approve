-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ActionType" AS ENUM ('CREATE', 'APPROVE', 'REJECT', 'RECALL', 'TERMINATE', 'PUBLISH', 'COMMENT', 'DRAFT', 'EDIT', 'PROCESSING', 'UPDATE', 'REVISE');

-- CreateEnum
CREATE TYPE "ExtraStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ApprovalSlotType" AS ENUM ('FIXED_USER', 'DEPARTMENT_HEAD', 'MEMO_REQUESTER', 'FLEXIBLE_SLOT');

-- CreateEnum
CREATE TYPE "ApprovalRequirement" AS ENUM ('ALL', 'ANY');

-- CreateTable
CREATE TABLE "MemoNumber" (
    "id" SERIAL NOT NULL,
    "memonumber" TEXT NOT NULL,
    "businessUnitId" INTEGER NOT NULL,
    "departmentId" INTEGER,
    "memotypeId" INTEGER,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "sequenceNumber" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoNumber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MasterMemo" (
    "id" SERIAL NOT NULL,
    "subject" TEXT NOT NULL,
    "businessUnitId" INTEGER,
    "departmentId" INTEGER,
    "userId" INTEGER NOT NULL,
    "approvalLineId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "memonumber" TEXT,
    "memoNumberId" INTEGER,
    "memotypeId" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "MasterMemo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoStatusPivot" (
    "id" SERIAL NOT NULL,
    "memoId" INTEGER NOT NULL,
    "statusId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" INTEGER NOT NULL,

    CONSTRAINT "MemoStatusPivot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoType" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "abbreviation" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "businessUnitId" INTEGER,
    "departmentId" INTEGER,
    "createdByUserId" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDelete" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "defaultMainFileId" INTEGER,
    "defaultTypeFileId" INTEGER,
    "approvalLineId" INTEGER,
    "forEveryone" BOOLEAN NOT NULL DEFAULT false,
    "forEveryDepartmentAcrossBU" BOOLEAN NOT NULL DEFAULT false,
    "forAllDepartmentUnderSelectedBu" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "MemoType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MainFile" (
    "id" SERIAL NOT NULL,
    "memoId" INTEGER,
    "memoTypeId" INTEGER,
    "filePath" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "orderNo" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MainFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TypeFile" (
    "id" SERIAL NOT NULL,
    "memoTypeId" INTEGER NOT NULL,
    "filePath" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "orderNo" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TypeFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttachedFile" (
    "id" SERIAL NOT NULL,
    "memoId" INTEGER NOT NULL,
    "filePath" TEXT,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT,
    "size" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "url" TEXT,
    "isUrl" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "AttachedFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignaturePosition" (
    "id" SERIAL NOT NULL,
    "memoId" INTEGER NOT NULL,
    "fileId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "page" INTEGER NOT NULL,
    "x" DECIMAL(10,6) NOT NULL,
    "y" DECIMAL(10,6) NOT NULL,
    "sizePct" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "level" INTEGER,

    CONSTRAINT "SignaturePosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DatePosition" (
    "id" SERIAL NOT NULL,
    "memoId" INTEGER NOT NULL,
    "fileId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "page" INTEGER NOT NULL,
    "x" DECIMAL(10,6) NOT NULL,
    "y" DECIMAL(10,6) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "sizePct" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "level" INTEGER,

    CONSTRAINT "DatePosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoNumberPosition" (
    "id" SERIAL NOT NULL,
    "memoId" INTEGER NOT NULL,
    "fileId" INTEGER NOT NULL,
    "page" INTEGER NOT NULL,
    "x" DECIMAL(10,6) NOT NULL,
    "y" DECIMAL(10,6) NOT NULL,
    "sizePct" DOUBLE PRECISION NOT NULL DEFAULT 100,

    CONSTRAINT "MemoNumberPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotePosition" (
    "id" SERIAL NOT NULL,
    "memoId" INTEGER NOT NULL,
    "fileId" INTEGER NOT NULL,
    "page" INTEGER NOT NULL,
    "x" DECIMAL(10,6) NOT NULL,
    "y" DECIMAL(10,6) NOT NULL,
    "text" TEXT NOT NULL,
    "sizePct" DOUBLE PRECISION NOT NULL DEFAULT 100,

    CONSTRAINT "NotePosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoHistory" (
    "id" SERIAL NOT NULL,
    "memoId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "fileId" INTEGER,
    "statusId" INTEGER,
    "action" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actiontype" "ActionType",

    CONSTRAINT "MemoHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "businessUnitId" INTEGER,
    "departmentId" INTEGER,
    "defaultSignatureId" INTEGER,
    "profileImagePath" TEXT,
    "lastname" TEXT,
    "nickname" TEXT,
    "isFirstLogin" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delegatedToUserId" INTEGER,
    "delegationStartDate" TIMESTAMP(3),
    "delegationEndDate" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "defaultSignatureText" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSignature" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "path" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSignature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessUnit" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "abbreviation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Department" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "businessUnitId" INTEGER,
    "abbreviation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Status" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "Status_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineOfApproval" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "businessUnitId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LineOfApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineOfApprovalUserPivot" (
    "id" SERIAL NOT NULL,
    "lineOfApprovalId" INTEGER,
    "userId" INTEGER,
    "level" INTEGER NOT NULL,
    "isSigReq" BOOLEAN NOT NULL DEFAULT false,
    "roleDescription" TEXT,
    "slotType" "ApprovalSlotType",
    "approvalRequirement" "ApprovalRequirement" NOT NULL DEFAULT 'ALL',

    CONSTRAINT "LineOfApprovalUserPivot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineOfApprovalUserPivotForUse" (
    "id" SERIAL NOT NULL,
    "memoId" INTEGER NOT NULL,
    "userId" INTEGER,
    "level" INTEGER NOT NULL,
    "isSigReq" BOOLEAN NOT NULL DEFAULT false,
    "roleDescription" TEXT,
    "slotType" "ApprovalSlotType",
    "approvalRequirement" "ApprovalRequirement" NOT NULL DEFAULT 'ALL',
    "templatePivotId" INTEGER,

    CONSTRAINT "LineOfApprovalUserPivotForUse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalActionStatus" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalActionStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoApproverAction" (
    "id" SERIAL NOT NULL,
    "memoId" INTEGER NOT NULL,
    "loaUserId" INTEGER NOT NULL,
    "statusId" INTEGER NOT NULL,
    "actedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "emailToken" TEXT,
    "signatureImageId" INTEGER,
    "signatureText" TEXT,
    "assignedUserId" INTEGER,
    "actualActorId" INTEGER,
    "approveWithCondition" TEXT,
    "terminationReason" TEXT,
    "rejectReason" TEXT,

    CONSTRAINT "MemoApproverAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" SERIAL NOT NULL,
    "memoId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "comment" TEXT NOT NULL,
    "isRecallExtra" BOOLEAN NOT NULL DEFAULT false,
    "ExtraUserid" INTEGER,
    "ExtraStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "extraApprovalLineId" INTEGER,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommentAttachment" (
    "id" SERIAL NOT NULL,
    "commentId" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimetype" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommentAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationType" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserNotificationPreference" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "notificationTypeId" INTEGER NOT NULL,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserNotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "actorId" INTEGER NOT NULL,
    "notificationTypeId" INTEGER NOT NULL,
    "memoId" INTEGER,
    "commentId" INTEGER,
    "statusId" INTEGER,
    "message" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "emailSent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CcGroup" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "ownerId" INTEGER NOT NULL,
    "isShared" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CcGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CcGroupMember" (
    "id" SERIAL NOT NULL,
    "groupId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CcGroupMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoCc" (
    "id" SERIAL NOT NULL,
    "memoId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoCc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtraApprovalLine" (
    "id" SERIAL NOT NULL,
    "memoId" INTEGER NOT NULL,
    "createdById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "status" "ExtraStatus" NOT NULL DEFAULT 'PENDING',
    "commentId" INTEGER,

    CONSTRAINT "ExtraApprovalLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtraApprover" (
    "id" SERIAL NOT NULL,
    "extraId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "statusId" INTEGER,
    "actedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtraApprover_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoReference" (
    "id" SERIAL NOT NULL,
    "mainMemoId" INTEGER NOT NULL,
    "referenceMemoId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" INTEGER NOT NULL,

    CONSTRAINT "MemoReference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommentTag" (
    "id" SERIAL NOT NULL,
    "commentId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "memoId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommentTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminLog" (
    "id" SERIAL NOT NULL,
    "actorId" INTEGER NOT NULL,
    "actionType" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "targetId" INTEGER,
    "targetName" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserBusinessUnitAccess" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "businessUnitId" INTEGER NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedBy" INTEGER,

    CONSTRAINT "UserBusinessUnitAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserDCCManagementAccess" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "businessUnitId" INTEGER NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedBy" INTEGER,

    CONSTRAINT "UserDCCManagementAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginSession" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "loginAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "logoutAt" TIMESTAMP(3),
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "LoginSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MemoNumber_memonumber_key" ON "MemoNumber"("memonumber");

-- CreateIndex
CREATE INDEX "MemoNumber_businessUnitId_departmentId_memotypeId_year_mont_idx" ON "MemoNumber"("businessUnitId", "departmentId", "memotypeId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "MemoNumber_businessUnitId_departmentId_memotypeId_year_mont_key" ON "MemoNumber"("businessUnitId", "departmentId", "memotypeId", "year", "month", "sequenceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "MasterMemo_memonumber_key" ON "MasterMemo"("memonumber");

-- CreateIndex
CREATE UNIQUE INDEX "MasterMemo_memoNumberId_key" ON "MasterMemo"("memoNumberId");

-- CreateIndex
CREATE INDEX "MasterMemo_expiresAt_idx" ON "MasterMemo"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MemoStatusPivot_memoId_userId_statusId_key" ON "MemoStatusPivot"("memoId", "userId", "statusId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoType_approvalLineId_key" ON "MemoType"("approvalLineId");

-- CreateIndex
CREATE INDEX "MainFile_memoId_idx" ON "MainFile"("memoId");

-- CreateIndex
CREATE INDEX "MainFile_memoTypeId_idx" ON "MainFile"("memoTypeId");

-- CreateIndex
CREATE INDEX "TypeFile_memoTypeId_idx" ON "TypeFile"("memoTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_defaultSignatureId_key" ON "User"("defaultSignatureId");

-- CreateIndex
CREATE INDEX "User_deletedAt_idx" ON "User"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessUnit_name_key" ON "BusinessUnit"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Department_name_key" ON "Department"("name");

-- CreateIndex
CREATE INDEX "Department_deletedAt_idx" ON "Department"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalActionStatus_code_key" ON "ApprovalActionStatus"("code");

-- CreateIndex
CREATE INDEX "MemoApproverAction_memoId_statusId_idx" ON "MemoApproverAction"("memoId", "statusId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoApproverAction_memoId_loaUserId_version_key" ON "MemoApproverAction"("memoId", "loaUserId", "version");

-- CreateIndex
CREATE INDEX "Comment_extraApprovalLineId_idx" ON "Comment"("extraApprovalLineId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationType_name_key" ON "NotificationType"("name");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationType_slug_key" ON "NotificationType"("slug");

-- CreateIndex
CREATE INDEX "UserNotificationPreference_userId_idx" ON "UserNotificationPreference"("userId");

-- CreateIndex
CREATE INDEX "UserNotificationPreference_notificationTypeId_idx" ON "UserNotificationPreference"("notificationTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "UserNotificationPreference_userId_notificationTypeId_key" ON "UserNotificationPreference"("userId", "notificationTypeId");

-- CreateIndex
CREATE INDEX "CcGroup_ownerId_idx" ON "CcGroup"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "CcGroup_ownerId_name_key" ON "CcGroup"("ownerId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "CcGroupMember_groupId_userId_key" ON "CcGroupMember"("groupId", "userId");

-- CreateIndex
CREATE INDEX "MemoCc_userId_idx" ON "MemoCc"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoCc_memoId_userId_key" ON "MemoCc"("memoId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ExtraApprovalLine_commentId_key" ON "ExtraApprovalLine"("commentId");

-- CreateIndex
CREATE INDEX "ExtraApprovalLine_commentId_idx" ON "ExtraApprovalLine"("commentId");

-- CreateIndex
CREATE UNIQUE INDEX "ExtraApprover_extraId_userId_version_key" ON "ExtraApprover"("extraId", "userId", "version");

-- CreateIndex
CREATE INDEX "MemoReference_mainMemoId_idx" ON "MemoReference"("mainMemoId");

-- CreateIndex
CREATE INDEX "MemoReference_referenceMemoId_idx" ON "MemoReference"("referenceMemoId");

-- CreateIndex
CREATE INDEX "MemoReference_createdBy_idx" ON "MemoReference"("createdBy");

-- CreateIndex
CREATE UNIQUE INDEX "MemoReference_mainMemoId_referenceMemoId_key" ON "MemoReference"("mainMemoId", "referenceMemoId");

-- CreateIndex
CREATE UNIQUE INDEX "CommentTag_commentId_key" ON "CommentTag"("commentId");

-- CreateIndex
CREATE INDEX "AdminLog_actorId_idx" ON "AdminLog"("actorId");

-- CreateIndex
CREATE INDEX "AdminLog_module_idx" ON "AdminLog"("module");

-- CreateIndex
CREATE INDEX "AdminLog_createdAt_idx" ON "AdminLog"("createdAt");

-- CreateIndex
CREATE INDEX "UserBusinessUnitAccess_userId_idx" ON "UserBusinessUnitAccess"("userId");

-- CreateIndex
CREATE INDEX "UserBusinessUnitAccess_businessUnitId_idx" ON "UserBusinessUnitAccess"("businessUnitId");

-- CreateIndex
CREATE UNIQUE INDEX "UserBusinessUnitAccess_userId_businessUnitId_key" ON "UserBusinessUnitAccess"("userId", "businessUnitId");

-- CreateIndex
CREATE INDEX "UserDCCManagementAccess_userId_idx" ON "UserDCCManagementAccess"("userId");

-- CreateIndex
CREATE INDEX "UserDCCManagementAccess_businessUnitId_idx" ON "UserDCCManagementAccess"("businessUnitId");

-- CreateIndex
CREATE UNIQUE INDEX "UserDCCManagementAccess_userId_businessUnitId_key" ON "UserDCCManagementAccess"("userId", "businessUnitId");

-- CreateIndex
CREATE INDEX "LoginSession_userId_idx" ON "LoginSession"("userId");

-- CreateIndex
CREATE INDEX "LoginSession_loginAt_idx" ON "LoginSession"("loginAt");

-- AddForeignKey
ALTER TABLE "MemoNumber" ADD CONSTRAINT "MemoNumber_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "BusinessUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoNumber" ADD CONSTRAINT "MemoNumber_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoNumber" ADD CONSTRAINT "MemoNumber_memotypeId_fkey" FOREIGN KEY ("memotypeId") REFERENCES "MemoType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MasterMemo" ADD CONSTRAINT "MasterMemo_approvalLineId_fkey" FOREIGN KEY ("approvalLineId") REFERENCES "LineOfApproval"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MasterMemo" ADD CONSTRAINT "MasterMemo_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "BusinessUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MasterMemo" ADD CONSTRAINT "MasterMemo_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MasterMemo" ADD CONSTRAINT "MasterMemo_memotypeId_fkey" FOREIGN KEY ("memotypeId") REFERENCES "MemoType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MasterMemo" ADD CONSTRAINT "MasterMemo_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MasterMemo" ADD CONSTRAINT "MasterMemo_memoNumberId_fkey" FOREIGN KEY ("memoNumberId") REFERENCES "MemoNumber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoStatusPivot" ADD CONSTRAINT "MemoStatusPivot_memoId_fkey" FOREIGN KEY ("memoId") REFERENCES "MasterMemo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoStatusPivot" ADD CONSTRAINT "MemoStatusPivot_statusId_fkey" FOREIGN KEY ("statusId") REFERENCES "Status"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoStatusPivot" ADD CONSTRAINT "MemoStatusPivot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoType" ADD CONSTRAINT "MemoType_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoType" ADD CONSTRAINT "MemoType_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "BusinessUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoType" ADD CONSTRAINT "MemoType_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoType" ADD CONSTRAINT "MemoType_approvalLineId_fkey" FOREIGN KEY ("approvalLineId") REFERENCES "LineOfApproval"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MainFile" ADD CONSTRAINT "MainFile_memoId_fkey" FOREIGN KEY ("memoId") REFERENCES "MasterMemo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MainFile" ADD CONSTRAINT "MainFile_memoTypeId_fkey" FOREIGN KEY ("memoTypeId") REFERENCES "MemoType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TypeFile" ADD CONSTRAINT "TypeFile_memoTypeId_fkey" FOREIGN KEY ("memoTypeId") REFERENCES "MemoType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttachedFile" ADD CONSTRAINT "AttachedFile_memoId_fkey" FOREIGN KEY ("memoId") REFERENCES "MasterMemo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignaturePosition" ADD CONSTRAINT "SignaturePosition_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "MainFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignaturePosition" ADD CONSTRAINT "SignaturePosition_memoId_fkey" FOREIGN KEY ("memoId") REFERENCES "MasterMemo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignaturePosition" ADD CONSTRAINT "SignaturePosition_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatePosition" ADD CONSTRAINT "DatePosition_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "MainFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatePosition" ADD CONSTRAINT "DatePosition_memoId_fkey" FOREIGN KEY ("memoId") REFERENCES "MasterMemo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatePosition" ADD CONSTRAINT "DatePosition_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoNumberPosition" ADD CONSTRAINT "MemoNumberPosition_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "MainFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoNumberPosition" ADD CONSTRAINT "MemoNumberPosition_memoId_fkey" FOREIGN KEY ("memoId") REFERENCES "MasterMemo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotePosition" ADD CONSTRAINT "NotePosition_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "MainFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotePosition" ADD CONSTRAINT "NotePosition_memoId_fkey" FOREIGN KEY ("memoId") REFERENCES "MasterMemo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoHistory" ADD CONSTRAINT "MemoHistory_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "MainFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoHistory" ADD CONSTRAINT "MemoHistory_memoId_fkey" FOREIGN KEY ("memoId") REFERENCES "MasterMemo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoHistory" ADD CONSTRAINT "MemoHistory_statusId_fkey" FOREIGN KEY ("statusId") REFERENCES "Status"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoHistory" ADD CONSTRAINT "MemoHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "BusinessUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_defaultSignatureId_fkey" FOREIGN KEY ("defaultSignatureId") REFERENCES "UserSignature"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_delegatedToUserId_fkey" FOREIGN KEY ("delegatedToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSignature" ADD CONSTRAINT "UserSignature_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "BusinessUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineOfApproval" ADD CONSTRAINT "LineOfApproval_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "BusinessUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineOfApproval" ADD CONSTRAINT "LineOfApproval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineOfApprovalUserPivot" ADD CONSTRAINT "LineOfApprovalUserPivot_lineOfApprovalId_fkey" FOREIGN KEY ("lineOfApprovalId") REFERENCES "LineOfApproval"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineOfApprovalUserPivot" ADD CONSTRAINT "LineOfApprovalUserPivot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineOfApprovalUserPivotForUse" ADD CONSTRAINT "LineOfApprovalUserPivotForUse_templatePivotId_fkey" FOREIGN KEY ("templatePivotId") REFERENCES "LineOfApprovalUserPivot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineOfApprovalUserPivotForUse" ADD CONSTRAINT "LineOfApprovalUserPivotForUse_memoId_fkey" FOREIGN KEY ("memoId") REFERENCES "MasterMemo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineOfApprovalUserPivotForUse" ADD CONSTRAINT "LineOfApprovalUserPivotForUse_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoApproverAction" ADD CONSTRAINT "MemoApproverAction_loaUserId_fkey" FOREIGN KEY ("loaUserId") REFERENCES "LineOfApprovalUserPivotForUse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoApproverAction" ADD CONSTRAINT "MemoApproverAction_memoId_fkey" FOREIGN KEY ("memoId") REFERENCES "MasterMemo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoApproverAction" ADD CONSTRAINT "MemoApproverAction_signatureImageId_fkey" FOREIGN KEY ("signatureImageId") REFERENCES "UserSignature"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoApproverAction" ADD CONSTRAINT "MemoApproverAction_statusId_fkey" FOREIGN KEY ("statusId") REFERENCES "ApprovalActionStatus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoApproverAction" ADD CONSTRAINT "MemoApproverAction_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoApproverAction" ADD CONSTRAINT "MemoApproverAction_actualActorId_fkey" FOREIGN KEY ("actualActorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_memoId_fkey" FOREIGN KEY ("memoId") REFERENCES "MasterMemo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_ExtraUserid_fkey" FOREIGN KEY ("ExtraUserid") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_extraApprovalLineId_fkey" FOREIGN KEY ("extraApprovalLineId") REFERENCES "ExtraApprovalLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentAttachment" ADD CONSTRAINT "CommentAttachment_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserNotificationPreference" ADD CONSTRAINT "UserNotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserNotificationPreference" ADD CONSTRAINT "UserNotificationPreference_notificationTypeId_fkey" FOREIGN KEY ("notificationTypeId") REFERENCES "NotificationType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_memoId_fkey" FOREIGN KEY ("memoId") REFERENCES "MasterMemo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_notificationTypeId_fkey" FOREIGN KEY ("notificationTypeId") REFERENCES "NotificationType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_statusId_fkey" FOREIGN KEY ("statusId") REFERENCES "Status"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CcGroup" ADD CONSTRAINT "CcGroup_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CcGroupMember" ADD CONSTRAINT "CcGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CcGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CcGroupMember" ADD CONSTRAINT "CcGroupMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoCc" ADD CONSTRAINT "MemoCc_memoId_fkey" FOREIGN KEY ("memoId") REFERENCES "MasterMemo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoCc" ADD CONSTRAINT "MemoCc_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtraApprovalLine" ADD CONSTRAINT "ExtraApprovalLine_memoId_fkey" FOREIGN KEY ("memoId") REFERENCES "MasterMemo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtraApprovalLine" ADD CONSTRAINT "ExtraApprovalLine_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtraApprover" ADD CONSTRAINT "ExtraApprover_extraId_fkey" FOREIGN KEY ("extraId") REFERENCES "ExtraApprovalLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtraApprover" ADD CONSTRAINT "ExtraApprover_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtraApprover" ADD CONSTRAINT "ExtraApprover_statusId_fkey" FOREIGN KEY ("statusId") REFERENCES "Status"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoReference" ADD CONSTRAINT "MemoReference_mainMemoId_fkey" FOREIGN KEY ("mainMemoId") REFERENCES "MasterMemo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoReference" ADD CONSTRAINT "MemoReference_referenceMemoId_fkey" FOREIGN KEY ("referenceMemoId") REFERENCES "MasterMemo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoReference" ADD CONSTRAINT "MemoReference_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentTag" ADD CONSTRAINT "CommentTag_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentTag" ADD CONSTRAINT "CommentTag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentTag" ADD CONSTRAINT "CommentTag_memoId_fkey" FOREIGN KEY ("memoId") REFERENCES "MasterMemo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminLog" ADD CONSTRAINT "AdminLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBusinessUnitAccess" ADD CONSTRAINT "UserBusinessUnitAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBusinessUnitAccess" ADD CONSTRAINT "UserBusinessUnitAccess_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "BusinessUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBusinessUnitAccess" ADD CONSTRAINT "UserBusinessUnitAccess_grantedBy_fkey" FOREIGN KEY ("grantedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserDCCManagementAccess" ADD CONSTRAINT "UserDCCManagementAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserDCCManagementAccess" ADD CONSTRAINT "UserDCCManagementAccess_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "BusinessUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserDCCManagementAccess" ADD CONSTRAINT "UserDCCManagementAccess_grantedBy_fkey" FOREIGN KEY ("grantedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoginSession" ADD CONSTRAINT "LoginSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

