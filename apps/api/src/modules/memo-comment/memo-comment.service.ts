/**
 * MemoCommentService (Nest)
 *
 * GET    /api/memos/:id/comments
 * POST   /api/memos/:id/comments   (multipart, up to 6 files)
 * DELETE /api/comments/:commentId
 *
 * Ported from backend/src/services/memoComment.service.ts. Error bodies keep
 * the Express `{ error }` shape because the frontend toasts `data.error`.
 *
 * Note (unchanged from Express): none of these endpoints check that the
 * caller can see the memo, and any authenticated user can delete any comment
 * that has mentions.
 */
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ActionType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../../common/mail/mail.service';
import { EmailPreferenceService } from '../../common/mail/email-preference.service';
import { decodeFilename } from '../../common/upload/upload.config';
import {
  buildCommentHtml,
  buildCommentPlain,
  buildCommentSubject,
  buildDeleteCommentHtml,
  buildDeleteCommentPlain,
  buildDeleteCommentSubject,
} from './comment-email.templates';

// Draft (1) / Recalled (6): comments are recorded but nobody is notified.
const SILENT_STATUS_IDS = new Set([1, 6]);
const SILENT_STATUS_NAMES = new Set(['draft', 'recalled']);
const COMMENT_NOTIFICATION_TYPE_ID = 2;

type NameBits = { name?: string | null; lastname?: string | null; nickname?: string | null };

type CommentEmailArgs = {
  receiverIds: number[];
  memoSubject: string;
  memoNumber: string | number;
  memoId: number;
  commenter: string;
  snippet: string;
  isMention?: boolean;
  mentionedNames?: string[];
};

/** "First Last (nick)" — the comment flow's own formatting, kept as-is. */
function fmtName(u: NameBits): string {
  const base = [u.name, u.lastname].filter(Boolean).join(' ').trim();
  return u.nickname ? `${base} (${u.nickname})` : base || u.name || '';
}

function oxfordJoin(xs: string[]): string {
  if (xs.length <= 1) return xs[0] || '';
  if (xs.length === 2) return `${xs[0]} and ${xs[1]}`;
  return `${xs.slice(0, -1).join(', ')}, and ${xs[xs.length - 1]}`;
}

function isSilentStatus(status: { id: number; name: string } | null | undefined): boolean {
  const id = status?.id ?? null;
  const name = (status?.name ?? '').toLowerCase();
  return id === null || SILENT_STATUS_IDS.has(id) || SILENT_STATUS_NAMES.has(name);
}

/** Stored attachment urls are "/uploads/..." (older rows "/api/uploads/..."). */
function attachmentUrl(host: string, url: string): string {
  const normalized = url.startsWith('/api/uploads') ? url.replace(/^\/api/, '') : url;
  return `${host}${encodeURI(normalized)}`;
}

/** mentionUserIds arrives as a JSON string (multipart) or an array; drop self + junk. */
export function parseMentionUserIds(raw: unknown, actorId: number): number[] {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const arr: unknown[] = Array.isArray(parsed) ? parsed : [];
    return Array.from(
      new Set(
        arr.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0 && n !== actorId),
      ),
    );
  } catch {
    return [];
  }
}

@Injectable()
export class MemoCommentService {
  private readonly logger = new Logger(MemoCommentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly emailPrefs: EmailPreferenceService,
  ) {}

  // ── GET /api/memos/:id/comments ─────────────────────────────────────────

  async getComments(memoId: number, host: string) {
    try {
      const comments = await this.prisma.comment.findMany({
        where: { memoId },
        include: {
          user: { select: { id: true, name: true, profileImagePath: true } },
          extraUser: { select: { name: true, lastname: true, nickname: true } },
          attachments: true,
          tags: {
            select: {
              id: true,
              user: { select: { id: true, name: true, lastname: true, nickname: true } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      });

      return comments.map((c) => ({
        id: c.id,
        comment: c.comment,
        isRecallExtra: c.isRecallExtra,
        ExtraUserid: c.ExtraUserid,
        ExtraStatus: c.ExtraStatus,
        extraApprovalLineId: c.extraApprovalLineId,
        createdAt: c.createdAt,
        extraUser: c.extraUser,
        hasMentions: c.tags && c.tags.length > 0,
        tags: c.tags.map((t) => t.user),
        user: {
          id: c.user.id,
          name: c.user.name,
          profileImage: c.user.profileImagePath
            ? `/uploads/profiles/${c.user.profileImagePath}`
            : null,
        },
        attachments: c.attachments.map((att) => ({
          id: att.id,
          url: attachmentUrl(host, att.url),
          filename: att.filename,
          mimetype: att.mimetype,
        })),
      }));
    } catch (err) {
      this.logger.error(err);
      throw new InternalServerErrorException({ error: 'Failed to fetch comments' });
    }
  }

  // ── POST /api/memos/:id/comments ────────────────────────────────────────

  async addComment(params: {
    memoId: number;
    userId: number;
    content: string;
    files: Express.Multer.File[];
    rawMentions: unknown;
    host: string;
  }) {
    const { memoId, userId, content, files, rawMentions, host } = params;
    if (!content && files.length === 0) {
      throw new BadRequestException({ error: 'Comment or attachment is required' });
    }

    try {
      // 1) latest status decides whether anyone gets notified
      const latestPivot = await this.prisma.memoStatusPivot.findFirst({
        where: { memoId },
        orderBy: { createdAt: 'desc' },
        include: { status: { select: { id: true, name: true } } },
      });
      const currentStatusId = latestPivot?.status?.id ?? null;
      const isSilent = isSilentStatus(latestPivot?.status);

      // 2) comment
      const comment = await this.prisma.comment.create({
        data: { memoId, userId, comment: content },
      });

      // 3) attachments — multer already stored them under uploads/comments
      for (const file of files) {
        await this.prisma.commentAttachment.create({
          data: {
            commentId: comment.id,
            url: `/uploads/comments/${file.filename}`,
            filename: decodeFilename(file.originalname),
            mimetype: file.mimetype,
            size: file.size,
          },
        });
      }

      // 4) mentions → CommentTag
      const mentionUserIds = parseMentionUserIds(rawMentions, userId);
      if (mentionUserIds.length) {
        await this.prisma.commentTag.createMany({
          data: mentionUserIds.map((uid) => ({ memoId, commentId: comment.id, userId: uid })),
          skipDuplicates: true,
        });
      }

      // 5) reload for the response
      const full = await this.prisma.comment.findUnique({
        where: { id: comment.id },
        include: {
          user: { select: { id: true, name: true, lastname: true, profileImagePath: true } },
          attachments: true,
        },
      });
      if (!full) {
        throw new InternalServerErrorException({ error: 'Failed to add comment' });
      }

      // 6) history: commented
      await this.prisma.memoHistory.create({
        data: {
          memoId,
          userId,
          statusId: currentStatusId,
          action: `${full.user.name} ${full.user.lastname ?? ''} commented on the memo`,
          actiontype: ActionType.COMMENT,
          timestamp: new Date(),
        },
      });

      // 7) history: who mentioned whom
      if (mentionUserIds.length) {
        const mentionedUsers = await this.prisma.user.findMany({
          where: { id: { in: mentionUserIds } },
          select: { name: true, lastname: true, nickname: true },
        });
        const actorName = fmtName({ name: full.user.name, lastname: full.user.lastname });
        await this.prisma.memoHistory.create({
          data: {
            memoId,
            userId,
            action: `${actorName} mentioned ${oxfordJoin(mentionedUsers.map(fmtName))} in a comment`,
            actiontype: ActionType.UPDATE,
            timestamp: new Date(),
          },
        });
      }

      // 8) in-app notifications + email (not for Draft/Recalled)
      if (!isSilent) {
        await this.notifyNewComment({
          memoId,
          actorId: userId,
          commentId: comment.id,
          actorName: fmtName({ name: full.user.name, lastname: full.user.lastname }),
          content,
          mentionUserIds,
        });
      }

      return {
        id: full.id,
        comment: full.comment,
        createdAt: full.createdAt,
        user: {
          id: full.user.id,
          name: full.user.name,
          lastname: full.user.lastname,
          profileImage: full.user.profileImagePath
            ? `/uploads/profiles/${full.user.profileImagePath}`
            : null,
        },
        attachments: full.attachments.map((a) => ({
          id: a.id,
          url: attachmentUrl(host, a.url),
          filename: a.filename,
          mimetype: a.mimetype,
        })),
      };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(err);
      throw new InternalServerErrorException({ error: 'Failed to add comment' });
    }
  }

  private async notifyNewComment(args: {
    memoId: number;
    actorId: number;
    commentId: number;
    actorName: string;
    content: string;
    mentionUserIds: number[];
  }): Promise<void> {
    const { memoId, actorId, commentId, actorName, content, mentionUserIds } = args;
    const memoRec = await this.prisma.masterMemo.findUnique({
      where: { id: memoId },
      select: { userId: true, subject: true, memonumber: true },
    });
    if (!memoRec) return;

    // Notify mentioned users, plus the owner (unless they wrote it or are mentioned).
    const mentionRecipients = new Set<number>(mentionUserIds);
    mentionRecipients.delete(actorId);
    const ownerId = memoRec.userId;
    const others = new Set<number>();
    if (ownerId && ownerId !== actorId && !mentionRecipients.has(ownerId)) {
      others.add(ownerId);
    }

    const mentionedUsersList = await this.prisma.user.findMany({
      where: { id: { in: Array.from(mentionRecipients) } },
      select: { name: true, lastname: true, nickname: true },
    });
    const mentionedNames = mentionedUsersList.map(fmtName);
    const subj = memoRec.subject ?? String(memoId);

    const notifyMentions = new Set(
      await this.emailPrefs.filterUsersForEmail(Array.from(mentionRecipients), 'tagged-in-comment'),
    );
    const othersSlug = mentionedNames.length > 0 ? 'others-mentioned' : 'new-comment';
    const notifyOthers = new Set(
      await this.emailPrefs.filterUsersForEmail(Array.from(others), othersSlug),
    );

    const buildNoti = (uid: number, message: string): Prisma.NotificationCreateManyInput => ({
      memoId,
      userId: uid,
      actorId,
      notificationTypeId: COMMENT_NOTIFICATION_TYPE_ID,
      message,
      commentId,
    });

    const notis: Prisma.NotificationCreateManyInput[] = [];
    for (const uid of mentionRecipients) {
      if (notifyMentions.has(uid)) {
        notis.push(buildNoti(uid, `You were mentioned in memo "${subj}" by ${actorName}.`));
      }
    }
    for (const uid of others) {
      if (notifyOthers.has(uid)) {
        notis.push(
          buildNoti(
            uid,
            mentionedNames.length > 0
              ? `${actorName} mentioned ${mentionedNames.join(', ')} in a comment on "${subj}".`
              : `New comment in memo "${subj}" by ${actorName}.`,
          ),
        );
      }
    }
    if (notis.length) await this.prisma.notification.createMany({ data: notis });

    const base = {
      memoSubject: subj,
      memoNumber: memoRec.memonumber ?? memoId,
      memoId,
      commenter: actorName,
      snippet: content ? content.slice(0, 120) : '[attachment]',
      mentionedNames,
    };
    if (mentionRecipients.size) {
      await this.sendCommentEmails({ ...base, receiverIds: [...mentionRecipients], isMention: true });
    }
    if (others.size) {
      await this.sendCommentEmails({ ...base, receiverIds: [...others], isMention: false });
    }
  }

  // ── DELETE /api/comments/:commentId ─────────────────────────────────────

  async deleteComment(commentId: number, actorId: number): Promise<void> {
    try {
      const commentData = await this.prisma.comment.findUnique({
        where: { id: commentId },
        include: {
          memo: { select: { subject: true, memonumber: true, userId: true } },
          tags: { select: { userId: true } },
          user: { select: { name: true, lastname: true } },
        },
      });
      if (!commentData) {
        throw new NotFoundException({ error: 'Comment not found' });
      }
      // Only comments with mentions can be deleted.
      if (commentData.tags.length === 0) {
        throw new ForbiddenException({ error: 'Only comments with mentions can be deleted.' });
      }

      const { memo, tags, user: commenter } = commentData;
      const memoId = commentData.memoId;
      const actorDisp = fmtName(commenter);
      const subj = memo.subject ?? String(memoId);

      const mentionRecipients = new Set<number>(tags.map((t) => t.userId));
      mentionRecipients.delete(actorId);
      const ownerId = memo.userId;
      const others = new Set<number>();
      if (ownerId && ownerId !== actorId && !mentionRecipients.has(ownerId)) {
        others.add(ownerId);
      }

      const mentionedUsersList = await this.prisma.user.findMany({
        where: { id: { in: Array.from(mentionRecipients) } },
        select: { name: true, lastname: true, nickname: true },
      });
      const mentionedNames = mentionedUsersList.map(fmtName);

      await this.prisma.comment.delete({ where: { id: commentId } });

      // Owner notices reuse the removed-mention preference too.
      const notifyMentions = new Set(
        await this.emailPrefs.filterUsersForEmail(Array.from(mentionRecipients), 'removed-mention'),
      );
      const notifyOthers = new Set(
        await this.emailPrefs.filterUsersForEmail(Array.from(others), 'removed-mention'),
      );

      const buildNoti = (uid: number, message: string): Prisma.NotificationCreateManyInput => ({
        memoId,
        userId: uid,
        actorId,
        notificationTypeId: COMMENT_NOTIFICATION_TYPE_ID,
        message,
      });
      const notis: Prisma.NotificationCreateManyInput[] = [];
      for (const uid of mentionRecipients) {
        if (notifyMentions.has(uid)) {
          notis.push(buildNoti(uid, `${actorDisp} removed a mention of you in memo "${subj}".`));
        }
      }
      for (const uid of others) {
        if (notifyOthers.has(uid)) {
          notis.push(
            buildNoti(
              uid,
              `${actorDisp} removed a comment mentioning ${mentionedNames.join(', ')} in "${subj}".`,
            ),
          );
        }
      }
      if (notis.length) await this.prisma.notification.createMany({ data: notis });

      const base = {
        memoSubject: subj,
        memoNumber: memo.memonumber ?? String(memoId),
        memoId,
        commenter: actorDisp,
        snippet: commentData.comment ? commentData.comment.slice(0, 120) : '[attachment]',
        mentionedNames,
      };
      if (mentionRecipients.size) {
        await this.sendDeleteCommentEmails({ ...base, receiverIds: [...mentionRecipients], isMention: true });
      }
      if (others.size) {
        await this.sendDeleteCommentEmails({ ...base, receiverIds: [...others], isMention: false });
      }
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(err);
      throw new InternalServerErrorException({ error: 'Failed to delete comment' });
    }
  }

  // ── Email ───────────────────────────────────────────────────────────────

  /** Re-checks the memo status by latest pivot id (as Express did) before sending. */
  private async isMemoSilent(memoId: number): Promise<boolean> {
    const latestPivot = await this.prisma.memoStatusPivot.findFirst({
      where: { memoId },
      orderBy: { id: 'desc' },
      include: { status: { select: { id: true, name: true } } },
    });
    return isSilentStatus(latestPivot?.status);
  }

  private async emailRecipients(receiverIds: number[], slug: string) {
    const filtered = await this.emailPrefs.filterUsersForEmail(receiverIds, slug);
    if (!filtered.length) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: filtered } },
      select: { id: true, name: true, email: true },
    });
    return users.filter((u) => !!u.email);
  }

  private viewLink(memoId: number): string {
    return `${process.env['FRONTEND_URL']}/memo/${memoId}`;
  }

  private async sendCommentEmails(a: CommentEmailArgs): Promise<void> {
    try {
      if (await this.isMemoSilent(a.memoId)) return;
      if (!a.receiverIds?.length) return;

      const slug = a.isMention
        ? 'tagged-in-comment'
        : a.mentionedNames && a.mentionedNames.length > 0
          ? 'others-mentioned'
          : 'new-comment';
      const sendTo = await this.emailRecipients(a.receiverIds, slug);
      if (!sendTo.length) return;

      const subjectLine = buildCommentSubject(a.memoNumber, a.memoSubject, a.isMention, a.mentionedNames);
      const viewLink = this.viewLink(a.memoId);
      await Promise.allSettled(
        sendTo.map((u) =>
          this.mail.sendEmail(
            [u.email],
            subjectLine,
            buildCommentPlain(u.name, a.commenter, a.snippet, a.memoNumber, viewLink, a.isMention, a.mentionedNames),
            buildCommentHtml(u.name, a.commenter, a.snippet, a.memoSubject, a.memoNumber, viewLink, a.isMention, a.mentionedNames),
            [],
          ),
        ),
      );
    } catch (err) {
      this.logger.error(`comment-mail error: ${(err as Error).message}`);
    }
  }

  private async sendDeleteCommentEmails(a: CommentEmailArgs): Promise<void> {
    try {
      if (await this.isMemoSilent(a.memoId)) return;
      if (!a.receiverIds?.length) return;

      const sendTo = await this.emailRecipients(a.receiverIds, 'removed-mention');
      if (!sendTo.length) return;

      const subjectLine = buildDeleteCommentSubject(a.memoNumber, a.memoSubject, a.isMention);
      const viewLink = this.viewLink(a.memoId);
      await Promise.allSettled(
        sendTo.map((u) =>
          this.mail.sendEmail(
            [u.email],
            subjectLine,
            buildDeleteCommentPlain(u.name, a.commenter, a.snippet, a.memoNumber, viewLink, a.isMention, a.mentionedNames),
            buildDeleteCommentHtml(u.name, a.commenter, a.snippet, a.memoSubject, a.memoNumber, viewLink, a.isMention, a.mentionedNames),
            [],
          ),
        ),
      );
    } catch (err) {
      this.logger.error(`delete-comment-mail error: ${(err as Error).message}`);
    }
  }
}
