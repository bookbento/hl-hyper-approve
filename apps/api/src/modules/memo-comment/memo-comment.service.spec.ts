import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { MemoCommentService, parseMentionUserIds } from './memo-comment.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../../common/mail/mail.service';
import { EmailPreferenceService } from '../../common/mail/email-preference.service';
import { MemoAccessService } from '../memo-query/memo-access.service';

const mockPrisma = {
  memoStatusPivot: { findFirst: jest.fn() },
  comment: { create: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), delete: jest.fn() },
  commentAttachment: { create: jest.fn() },
  commentTag: { createMany: jest.fn() },
  memoHistory: { create: jest.fn() },
  user: { findMany: jest.fn() },
  masterMemo: { findUnique: jest.fn() },
  notification: { createMany: jest.fn() },
};
const mockMail = { sendEmail: jest.fn() };
const mockPrefs = { filterUsersForEmail: jest.fn() };
const mockAccess = { canViewMemo: jest.fn() };

const PROCESSING = { status: { id: 5, name: 'Processing' } };
const DRAFT = { status: { id: 1, name: 'Draft' } };

const users: Record<number, { id: number; name: string; lastname: string | null; nickname: string | null; email: string }> = {
  1: { id: 1, name: 'Owner', lastname: 'O', nickname: null, email: 'owner@x.test' },
  2: { id: 2, name: 'Actor', lastname: 'A', nickname: null, email: 'actor@x.test' },
  3: { id: 3, name: 'Tagged', lastname: 'T', nickname: 'tt', email: 'tagged@x.test' },
};

describe('MemoCommentService', () => {
  let service: MemoCommentService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoCommentService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MailService, useValue: mockMail },
        { provide: EmailPreferenceService, useValue: mockPrefs },
        { provide: MemoAccessService, useValue: mockAccess },
      ],
    }).compile();
    service = module.get(MemoCommentService);
    jest.clearAllMocks();
    process.env['FRONTEND_URL'] = 'https://fe.test';

    mockPrisma.memoStatusPivot.findFirst.mockResolvedValue(PROCESSING);
    mockPrisma.comment.create.mockResolvedValue({ id: 50 });
    mockPrisma.comment.findUnique.mockResolvedValue({
      id: 50,
      comment: 'hello',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      user: { id: 2, name: 'Actor', lastname: 'A', profileImagePath: 'p.png' },
      attachments: [],
    });
    mockPrisma.masterMemo.findUnique.mockResolvedValue({ userId: 1, subject: 'Budget', memonumber: 'MN-1' });
    mockPrisma.user.findMany.mockImplementation(({ where }) =>
      Promise.resolve((where.id.in as number[]).map((id) => users[id]).filter(Boolean)),
    );
    mockPrefs.filterUsersForEmail.mockImplementation((ids: number[]) => Promise.resolve(ids));
    mockMail.sendEmail.mockResolvedValue(undefined);
    mockAccess.canViewMemo.mockResolvedValue(true);
  });

  describe('parseMentionUserIds', () => {
    it('accepts JSON strings and arrays, dropping self, junk and duplicates', () => {
      expect(parseMentionUserIds('[3,"4",3,2,0,-1,"x"]', 2)).toEqual([3, 4]);
      expect(parseMentionUserIds([5, 5], 2)).toEqual([5]);
      expect(parseMentionUserIds('not json', 2)).toEqual([]);
      expect(parseMentionUserIds(undefined, 2)).toEqual([]);
    });
  });

  describe('addComment', () => {
    const base = { memoId: 9, userId: 2, content: 'hello', files: [] as Express.Multer.File[], rawMentions: undefined, host: 'http://api' };

    it('rejects an empty comment without files', async () => {
      await expect(service.addComment({ ...base, content: '' })).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.comment.create).not.toHaveBeenCalled();
    });

    it('403s and discards uploads when the user cannot see the memo', async () => {
      mockAccess.canViewMemo.mockResolvedValue(false);
      const tmp = require('path').join(require('os').tmpdir(), `hl-comment-1791518968645.pdf`);
      require('fs').writeFileSync(tmp, 'x');
      const file = { path: tmp, filename: 'f.pdf', originalname: 'f.pdf', mimetype: 'application/pdf', size: 1 } as Express.Multer.File;

      await expect(service.addComment({ ...base, files: [file] })).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockAccess.canViewMemo).toHaveBeenCalledWith(2, 9);
      expect(mockPrisma.comment.create).not.toHaveBeenCalled();
      // The unlink is fire-and-forget; poll instead of a fixed 50ms (flaky under load).
      for (let i = 0; i < 100 && require('fs').existsSync(tmp); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(require('fs').existsSync(tmp)).toBe(false);
    });

    it('stores attachments with decoded names under /uploads/comments', async () => {
      const file = {
        filename: '123-a.pdf',
        originalname: Buffer.from('ไฟล์.pdf', 'utf8').toString('latin1'),
        mimetype: 'application/pdf',
        size: 10,
      } as Express.Multer.File;
      await service.addComment({ ...base, content: '', files: [file] });
      expect(mockPrisma.commentAttachment.create).toHaveBeenCalledWith({
        data: { commentId: 50, url: '/uploads/comments/123-a.pdf', filename: 'ไฟล์.pdf', mimetype: 'application/pdf', size: 10 },
      });
    });

    it('notifies the owner and emails them for a plain comment', async () => {
      const res = await service.addComment(base);

      expect(mockPrisma.memoHistory.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.notification.createMany).toHaveBeenCalledWith({
        data: [
          { memoId: 9, userId: 1, actorId: 2, notificationTypeId: 2, message: 'New comment in memo "Budget" by Actor A.', commentId: 50 },
        ],
      });
      expect(mockPrefs.filterUsersForEmail).toHaveBeenCalledWith([1], 'new-comment');
      expect(mockMail.sendEmail).toHaveBeenCalledTimes(1);
      const [to, subject, text] = mockMail.sendEmail.mock.calls[0];
      expect(to).toEqual(['owner@x.test']);
      expect(subject).toBe('New comment on memo MN-1: Budget');
      expect(text).toContain('View details: https://fe.test/memo/9');
      expect(res.user.profileImage).toBe('/uploads/profiles/p.png');
    });

    it('tags mentions, records mention history and emails both groups', async () => {
      await service.addComment({ ...base, rawMentions: '[3]' });

      expect(mockPrisma.commentTag.createMany).toHaveBeenCalledWith({
        data: [{ memoId: 9, commentId: 50, userId: 3 }],
        skipDuplicates: true,
      });
      expect(mockPrisma.memoHistory.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: 'Actor A mentioned Tagged T (tt) in a comment' }) }),
      );
      const messages = mockPrisma.notification.createMany.mock.calls[0][0].data.map((n: any) => n.message);
      expect(messages).toEqual([
        'You were mentioned in memo "Budget" by Actor A.',
        'Actor A mentioned Tagged T (tt) in a comment on "Budget".',
      ]);
      const subjects = mockMail.sendEmail.mock.calls.map((c) => c[1]);
      expect(subjects).toEqual([
        'You were mentioned on memo MN-1: Budget',
        'New comment (with mention) on memo MN-1: Budget',
      ]);
    });

    it('respects email/notification opt-outs', async () => {
      mockPrefs.filterUsersForEmail.mockResolvedValue([]);
      await service.addComment(base);
      expect(mockPrisma.notification.createMany).not.toHaveBeenCalled();
      expect(mockMail.sendEmail).not.toHaveBeenCalled();
    });

    it('stays silent while the memo is a Draft', async () => {
      mockPrisma.memoStatusPivot.findFirst.mockResolvedValue(DRAFT);
      await service.addComment({ ...base, rawMentions: [3] });
      expect(mockPrisma.commentTag.createMany).toHaveBeenCalled();
      expect(mockPrisma.notification.createMany).not.toHaveBeenCalled();
      expect(mockMail.sendEmail).not.toHaveBeenCalled();
    });
  });

  describe('deleteComment', () => {
    it('404s for a missing comment', async () => {
      mockPrisma.comment.findUnique.mockResolvedValue(null);
      await expect(service.deleteComment(1, 2)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses to delete a comment without mentions', async () => {
      mockPrisma.comment.findUnique.mockResolvedValue({ memoId: 9, userId: 2, tags: [], memo: {}, user: {} });
      await expect(service.deleteComment(1, 2)).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.comment.delete).not.toHaveBeenCalled();
    });

    it('refuses to delete a comment written by someone else', async () => {
      mockPrisma.comment.findUnique.mockResolvedValue({ memoId: 9, userId: 7, tags: [{ userId: 3 }], memo: {}, user: {} });
      await expect(service.deleteComment(1, 2)).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.comment.delete).not.toHaveBeenCalled();
    });

    it('deletes and notifies the mentioned user and the owner', async () => {
      mockPrisma.comment.findUnique.mockResolvedValue({
        memoId: 9,
        userId: 2,
        comment: 'ping',
        tags: [{ userId: 3 }],
        memo: { subject: 'Budget', memonumber: null, userId: 1 },
        user: { name: 'Actor', lastname: 'A' },
      });

      await service.deleteComment(50, 2);

      expect(mockPrisma.comment.delete).toHaveBeenCalledWith({ where: { id: 50 } });
      const messages = mockPrisma.notification.createMany.mock.calls[0][0].data.map((n: any) => n.message);
      expect(messages).toEqual([
        'Actor A removed a mention of you in memo "Budget".',
        'Actor A removed a comment mentioning Tagged T (tt) in "Budget".',
      ]);
      expect(mockPrefs.filterUsersForEmail).toHaveBeenCalledWith([3], 'removed-mention');
      expect(mockMail.sendEmail.mock.calls.map((c) => c[1])).toEqual([
        'A mention of you was deleted on memo 9: Budget',
        'A comment with a mention was deleted on memo 9: Budget',
      ]);
    });
  });

  describe('getComments', () => {
    it('403s when the user cannot see the memo', async () => {
      mockAccess.canViewMemo.mockResolvedValue(false);
      await expect(service.getComments(9, 2, 'http://api')).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.comment.findMany).not.toHaveBeenCalled();
    });

    it('maps tags, profile image and attachment urls', async () => {
      mockPrisma.comment.findMany.mockResolvedValue([
        {
          id: 1,
          comment: 'c',
          isRecallExtra: false,
          ExtraUserid: null,
          ExtraStatus: null,
          extraApprovalLineId: null,
          createdAt: new Date(),
          extraUser: null,
          tags: [{ id: 7, user: { id: 3, name: 'Tagged' } }],
          user: { id: 2, name: 'Actor', profileImagePath: null },
          attachments: [{ id: 4, url: '/api/uploads/comments/a b.pdf', filename: 'a b.pdf', mimetype: 'application/pdf' }],
        },
      ]);

      const [c] = await service.getComments(9, 2, 'http://api');
      expect(c.hasMentions).toBe(true);
      expect(c.tags).toEqual([{ id: 3, name: 'Tagged' }]);
      expect(c.user.profileImage).toBeNull();
      expect(c.attachments[0].url).toBe('http://api/uploads/comments/a%20b.pdf');
    });
  });
});
