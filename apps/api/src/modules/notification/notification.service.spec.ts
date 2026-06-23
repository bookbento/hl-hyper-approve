import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtPayload } from '../../common/guards/jwt.guard';

const mockUser: JwtPayload = {
  id: 1,
  name: 'Test User',
  role: 'USER',
  businessUnitId: 1,
};

const mockNoti = {
  id: 10,
  userId: 1,
  isRead: false,
  createdAt: new Date('2024-01-01'),
  type: { name: 'approval' },
  memo: { id: 5, subject: 'Test Memo', memonumber: 'M001' },
  status: { name: 'Pending' },
  comment: null,
  actor: { id: 2, name: 'Actor', profileImagePath: 'uploads/actor.png' },
};

const mockPrisma = {
  notification: {
    findMany: jest.fn(),
    count: jest.fn(),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
  },
};

describe('NotificationService', () => {
  let service: NotificationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<NotificationService>(NotificationService);
    jest.clearAllMocks();
  });

  describe('getNotifications', () => {
    it('returns paginated notifications with profileImageUrl', async () => {
      mockPrisma.notification.findMany.mockResolvedValue([mockNoti]);

      const result = await service.getNotifications(mockUser, { limit: 10 });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].actor?.profileImageUrl).toBe('/uploads/uploads/actor.png');
      expect(result.nextCursor).toBeNull(); // 1 item < limit 10
    });

    it('sets nextCursor when items equal limit', async () => {
      const notis = Array(5).fill({ ...mockNoti, id: 5 });
      mockPrisma.notification.findMany.mockResolvedValue(notis);

      const result = await service.getNotifications(mockUser, { limit: 5 });

      expect(result.nextCursor).toBe(5);
    });

    it('filters by unreadOnly=true', async () => {
      mockPrisma.notification.findMany.mockResolvedValue([]);

      await service.getNotifications(mockUser, { unreadOnly: true, limit: 10 });

      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 1, isRead: false } }),
      );
    });

    it('uses cursor when provided', async () => {
      mockPrisma.notification.findMany.mockResolvedValue([]);

      await service.getNotifications(mockUser, { limit: 10, cursor: 42 });

      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 1, cursor: { id: 42 } }),
      );
    });

    it('returns null profileImageUrl when actor has no path', async () => {
      const notiNoImg = { ...mockNoti, actor: { id: 2, name: 'Actor', profileImagePath: null } };
      mockPrisma.notification.findMany.mockResolvedValue([notiNoImg]);

      const result = await service.getNotifications(mockUser, { limit: 10 });

      expect(result.items[0].actor?.profileImageUrl).toBeNull();
    });
  });

  describe('getUnreadCount', () => {
    it('returns count of unread notifications', async () => {
      mockPrisma.notification.count.mockResolvedValue(3);

      const result = await service.getUnreadCount(mockUser);

      expect(result).toEqual({ count: 3 });
      expect(mockPrisma.notification.count).toHaveBeenCalledWith({
        where: { userId: 1, isRead: false },
      });
    });
  });

  describe('markAllRead', () => {
    it('marks all notifications as read for user', async () => {
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 5 });

      const result = await service.markAllRead(mockUser);

      expect(result).toEqual({ updated: 5 });
      expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
        where: { userId: 1 },
        data: { isRead: true },
      });
    });
  });

  describe('markOneRead', () => {
    it('marks a single notification as read', async () => {
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.markOneRead(mockUser, 10);

      expect(result).toEqual({ updated: true });
    });

    it('throws NotFoundException when notification not found', async () => {
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.markOneRead(mockUser, 999)).rejects.toThrow(NotFoundException);
    });
  });

  describe('clearRead', () => {
    it('deletes all read notifications for user', async () => {
      mockPrisma.notification.deleteMany.mockResolvedValue({ count: 7 });

      const result = await service.clearRead(mockUser);

      expect(result).toEqual({ deleted: 7 });
      expect(mockPrisma.notification.deleteMany).toHaveBeenCalledWith({
        where: { userId: 1, isRead: true },
      });
    });
  });
});
