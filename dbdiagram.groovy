//// =========================
//// Enums
//// =========================
Enum ActionType {
  CREATE
  APPROVE
  REJECT
  RECALL
  TERMINATE
  PUBLISH
  COMMENT
  DRAFT
  EDIT
  PROCESSING
  UPDATE
  REVISE
}

Enum FieldType {
  TEXT
  NUMBER
  DATE
  SELECT
  CHECKBOX
  RADIO
  TEXTAREA
  CURRENCY
}

Enum TextAlign {
  LEFT
  CENTER
  RIGHT
}

//// =========================
//// Core Tables
//// =========================
Table MasterMemo {
  id                int [pk, increment]
  subject           varchar
  businessUnitId    int [null]
  teamId            int
  departmentId      int [null]
  userId            int
  approvalLineId    int [null]
  createdAt         timestamp [default: `now()`]
  memonumber        varchar [unique]
  memotypeId        int [null]
  updatedAt         timestamp [default: `now()`]
  templateId        int [null] // NEW: which template used
}

Table MemoStatusPivot {
  id        int [pk, increment]
  memoId    int
  statusId  int
  createdAt timestamp [default: `now()`]
  userId    int

  Indexes {
    (memoId, userId, statusId) [unique, name: 'memoId_userId_statusId']
  }
}

Table MemoType {
  id              int [pk, increment]
  teamId          int
  name            varchar
  abbreviation    varchar
  description     varchar
  createdByUserId int
  isActive        boolean [default: true]
  createdAt       timestamp [default: `now()`]
  updatedAt       timestamp [default: `now()`]
}

Table MainFile {
  id        int [pk, increment]
  memoId    int
  filePath  varchar
  fileName  varchar
  size      int
  orderNo   int [default: 0]
}

Table AttachedFile {
  id       int [pk, increment]
  memoId   int
  filePath varchar
  fileName varchar
  fileType varchar
  size     int
}

Table SignaturePosition {
  id      int [pk, increment]
  memoId  int
  fileId  int
  userId  int
  page    int
  x       numeric(10,6)
  y       numeric(10,6)
  sizePct float [default: 100]
}

Table DatePosition {
  id      int [pk, increment]
  memoId  int
  fileId  int
  userId  int
  page    int
  x       numeric(10,6)
  y       numeric(10,6)
  date    timestamp
  sizePct float [default: 100]
}

Table MemoHistory {
  id         int [pk, increment]
  memoId     int
  userId     int
  fileId     int [null]
  statusId   int [null]
  action     varchar
  timestamp  timestamp [default: `now()`]
  actiontype ActionType [null]
}

Table User {
  id                 int [pk, increment]
  name               varchar
  email              varchar [unique]
  password           varchar
  role               varchar
  teamId             int [null]
  businessUnitId     int [null]
  departmentId       int [null]
  defaultSignatureId int [null, unique]
  profileImagePath   varchar [null]
  lastname           varchar [null]
  nickname           varchar [null]
}

Table UserSignature {
  id        int [pk, increment]
  userId    int
  path      varchar
  label     varchar [null]
  createdAt timestamp [default: `now()`]
}

Table BusinessUnit {
  id           int [pk, increment]
  name         varchar [unique]
  abbreviation varchar [null]
}

Table Department {
  id             int [pk, increment]
  name           varchar [unique]
  businessUnitId int [null]
  abbreviation   varchar [null]
}

Table Team {
  id             int [pk, increment]
  name           varchar [unique]
  businessUnitId int [null]
  departmentId   int [null]
  abbreviation   varchar
  isDeleted      boolean [default: false]
}

Table Status {
  id          int [pk, increment]
  name        varchar
  description varchar
}

Table LineOfApproval {
  id             int [pk, increment]
  name           varchar
  teamId         int
  userId         int
  businessUnitId int [null]
  createdAt      timestamp [default: `now()`]
  updatedAt      timestamp [default: `now()`]
}

Table LineOfApprovalUserPivot {
  id               int [pk, increment]
  lineOfApprovalId int [null]
  userId           int
  level            int
  isSigReq         boolean [default: true]

  Indexes {
    (lineOfApprovalId, userId, level) [unique]
  }
}

Table ApprovalActionStatus {
  id        int [pk, increment]
  code      varchar [unique]
  label     varchar
  isFinal   boolean [default: false]
  createdAt timestamp [default: `now()`]
  updatedAt timestamp
}

Table MemoApproverAction {
  id               int [pk, increment]
  memoId           int
  loaUserId        int
  statusId         int
  actedAt          timestamp [null]
  version          int [default: 0]
  createdAt        timestamp [default: `now()`]
  updatedAt        timestamp
  emailToken       varchar [null]
  signatureImageId int [null]
  signatureText    varchar [null]

  Indexes {
    (memoId, loaUserId, version) [unique]
    (memoId, statusId)
  }
}

Table Comment {
  id        int [pk, increment]
  memoId    int
  userId    int
  comment   text
  createdAt timestamp [default: `now()`]
}

Table CommentAttachment {
  id        int [pk, increment]
  commentId int
  url       varchar
  filename  varchar
  mimetype  varchar
  size      int
  createdAt timestamp [default: `now()`]
}

Table NotificationType {
  id          int [pk, increment]
  name        varchar [unique]
  description varchar [null]
  createdAt   timestamp [default: `now()`]
  updatedAt   timestamp
}

Table Notification {
  id                 int [pk, increment]
  userId             int
  actorId            int
  notificationTypeId int
  memoId             int [null]
  commentId          int [null]
  statusId           int [null]
  message            text
  isRead             boolean [default: false]
  emailSent          boolean [default: false]
  createdAt          timestamp [default: `now()`]
  updatedAt          timestamp
}

Table MemoCc {
  id        int [pk, increment]
  memoId    int
  userId    int
  createdAt timestamp [default: `now()`]
  updatedAt timestamp

  Indexes {
    (memoId, userId) [unique, name: 'memoId_userId']
  }
}

//// =========================
//// NEW: Template Authoring
//// =========================
Table MemoTemplate {
  id              int [pk, increment]
  memoTypeId      int
  name            varchar
  version         int [default: 1]
  pdfPath         varchar
  pageCount       int
  isActive        boolean [default: true]
  createdByUserId int
  createdAt       timestamp [default: `now()`]
  updatedAt       timestamp

  Indexes {
    (memoTypeId, isActive)
    (memoTypeId, version) [unique]
  }
}

Table TemplatePage {
  id         int [pk, increment]
  templateId int
  pageNumber int
  widthPt    numeric(10,2)
  heightPt   numeric(10,2)

  Indexes {
    (templateId, pageNumber) [unique]
  }
}

Table TemplateBlock {
  id           int [pk, increment]
  templateId   int
  name         varchar
  isRepeatable boolean [default: false]
  rowHeight    numeric(10,2) [null]
  maxRows      int [null]
  orderNo      int [default: 0]

  Indexes {
    (templateId, orderNo)
  }
}

Table TemplateField {
  id            int [pk, increment]
  templateId    int
  blockId       int [null] // null => single field
  name          varchar
  label         varchar
  type          FieldType
  required      boolean [default: false]
  align         TextAlign [default: 'LEFT']
  defaultValue  varchar [null]
  formatMask    varchar [null]
  orderNo       int [default: 0]

  Indexes {
    (templateId, blockId, orderNo)
    (templateId, name) [unique]
  }
}

// --- NEW ---
Table TemplateFieldPlacement {
  id              int [pk, increment]
  templateFieldId int
  rowIndex        int [null]      // null for single fields; 1..N for repeatable rows
  pageNumber      int
  x               numeric(10,2)
  y               numeric(10,2)
  width           numeric(10,2)
  height          numeric(10,2)
  fontSize        int [default: 10]
  align           TextAlign [default: 'LEFT']

  Indexes {
    (templateFieldId, rowIndex) [unique]
    (templateFieldId, rowIndex, pageNumber)
  }
}

// --- RELATIONSHIPS ---
Ref: TemplateFieldPlacement.templateFieldId > TemplateField.id



//// =========================
//// NEW: Runtime Capture
//// =========================
Table MemoBlockRow {
  id        int [pk, increment]
  memoId    int
  blockId   int
  rowIndex  int
  createdAt timestamp [default: `now()`]

  Indexes {
    (memoId, blockId, rowIndex) [unique]
    (memoId, blockId)
  }
}

Table MemoFieldValue {
  id              int [pk, increment]
  memoId          int
  templateFieldId int
  blockRowId      int [null]
  valueText       text [null]
  valueNumber     numeric(18,6) [null]
  valueDate       timestamp [null]
  valueBool       boolean [null]
  valueJson       json [null]
  createdAt       timestamp [default: `now()`]
  updatedAt       timestamp

  Indexes {
    (memoId, templateFieldId)
    (blockRowId)
    (memoId, templateFieldId, blockRowId) [unique]
  }
}

//// =========================
//// Relationships
//// =========================
// MasterMemo links
Ref: MasterMemo.businessUnitId > BusinessUnit.id
Ref: MasterMemo.teamId > Team.id
Ref: MasterMemo.departmentId > Department.id
Ref: MasterMemo.userId > User.id
Ref: MasterMemo.approvalLineId > LineOfApproval.id
Ref: MasterMemo.memotypeId > MemoType.id
Ref: MasterMemo.templateId > MemoTemplate.id

// Attachments / files / positions
Ref: AttachedFile.memoId > MasterMemo.id
Ref: MainFile.memoId > MasterMemo.id
Ref: SignaturePosition.memoId > MasterMemo.id
Ref: SignaturePosition.fileId > MainFile.id
Ref: SignaturePosition.userId > User.id
Ref: DatePosition.memoId > MasterMemo.id
Ref: DatePosition.fileId > MainFile.id
Ref: DatePosition.userId > User.id

// History & status
Ref: MemoHistory.memoId > MasterMemo.id
Ref: MemoHistory.userId > User.id
Ref: MemoHistory.fileId > MainFile.id
Ref: MemoHistory.statusId > Status.id
Ref: MemoStatusPivot.memoId > MasterMemo.id
Ref: MemoStatusPivot.statusId > Status.id
Ref: MemoStatusPivot.userId > User.id

// Users & org
Ref: User.teamId > Team.id
Ref: User.businessUnitId > BusinessUnit.id
Ref: User.departmentId > Department.id
Ref: User.defaultSignatureId > UserSignature.id
Ref: UserSignature.userId > User.id
Ref: Department.businessUnitId > BusinessUnit.id
Ref: Team.businessUnitId > BusinessUnit.id
Ref: Team.departmentId > Department.id

// Approvals
Ref: LineOfApproval.teamId > Team.id
Ref: LineOfApproval.userId > User.id
Ref: LineOfApproval.businessUnitId > BusinessUnit.id
Ref: LineOfApprovalUserPivot.lineOfApprovalId > LineOfApproval.id
Ref: LineOfApprovalUserPivot.userId > User.id
Ref: MemoApproverAction.memoId > MasterMemo.id
Ref: MemoApproverAction.loaUserId > LineOfApprovalUserPivot.id
Ref: MemoApproverAction.statusId > ApprovalActionStatus.id
Ref: MemoApproverAction.signatureImageId > UserSignature.id

// Comments & notifications
Ref: Comment.memoId > MasterMemo.id
Ref: Comment.userId > User.id
Ref: CommentAttachment.commentId > Comment.id
Ref: Notification.notificationTypeId > NotificationType.id
Ref: Notification.userId > User.id
Ref: Notification.actorId > User.id
Ref: Notification.memoId > MasterMemo.id
Ref: Notification.commentId > Comment.id
Ref: Notification.statusId > Status.id
Ref: MemoCc.memoId > MasterMemo.id
Ref: MemoCc.userId > User.id

// Templates
Ref: MemoTemplate.memoTypeId > MemoType.id
Ref: MemoTemplate.createdByUserId > User.id
Ref: TemplatePage.templateId > MemoTemplate.id
Ref: TemplateBlock.templateId > MemoTemplate.id
Ref: TemplateField.templateId > MemoTemplate.id
Ref: TemplateField.blockId > TemplateBlock.id

// Runtime capture
Ref: MemoBlockRow.memoId > MasterMemo.id
Ref: MemoBlockRow.blockId > TemplateBlock.id
Ref: MemoFieldValue.memoId > MasterMemo.id
Ref: MemoFieldValue.templateFieldId > TemplateField.id
Ref: MemoFieldValue.blockRowId > MemoBlockRow.id


