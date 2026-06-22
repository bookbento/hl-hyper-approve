export interface ReferenceMemoSummary {
  id: number;
  subject: string;
  memoNumber: string;
  createdAt: string;
  status: string;
  createdBy: {
    id: number;
    name: string;
    lastname?: string;
  };
}

export interface ReferenceMemoDetail extends ReferenceMemoSummary {
  mainFiles: MemoFile[];
  attachedFiles: MemoFile[];
  comments: MemoComment[];
  hasAccess: boolean;
}

export interface MemoFile {
  id: number;
  fileName: string;
  filePath: string;
  size: number;
  fileType?: string;
}

export interface MemoComment {
  id: number;
  comment: string;
  createdAt: string;
  user: {
    id: number;
    name: string;
    lastname?: string;
    profileImagePath?: string;
  };
  attachments?: CommentAttachment[];
}

export interface CommentAttachment {
  id: number;
  filename: string;
  url: string;
  mimetype: string;
  size: number;
}