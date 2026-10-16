import { UserService } from './user.service';

describe('UserService.getNotificationPreferences', () => {
  const types = [
    { id: 1, name: 'Wait for your turn', slug: 'wait-for-your-turn', description: 'd1' },
    { id: 2, name: 'New comment', slug: 'new-comment', description: null },
    { id: 3, name: 'Status Update', slug: 'status-update', description: 'deprecated' },
  ];
  const prisma: any = {
    notificationType: { findMany: jest.fn().mockResolvedValue(types) },
    userNotificationPreference: {
      findMany: jest.fn(),
      createMany: jest.fn(),
    },
  };
  const service = new UserService(prisma, {} as any);

  beforeEach(() => jest.clearAllMocks());

  it('returns the flat Express shape the profile page reads, without status-update', async () => {
    prisma.userNotificationPreference.findMany.mockResolvedValue([
      { notificationTypeId: 1, emailEnabled: false },
      { notificationTypeId: 2, emailEnabled: true },
      { notificationTypeId: 3, emailEnabled: true },
    ]);

    expect(await service.getNotificationPreferences(7)).toEqual({
      preferences: [
        {
          notificationTypeId: 1,
          notificationTypeName: 'Wait for your turn',
          notificationTypeSlug: 'wait-for-your-turn',
          notificationTypeDescription: 'd1',
          emailEnabled: false,
        },
        {
          notificationTypeId: 2,
          notificationTypeName: 'New comment',
          notificationTypeSlug: 'new-comment',
          notificationTypeDescription: null,
          emailEnabled: true,
        },
      ],
    });
    expect(prisma.userNotificationPreference.createMany).not.toHaveBeenCalled();
  });

  it('creates missing rows (enabled) and defaults them to enabled in the result', async () => {
    prisma.userNotificationPreference.findMany.mockResolvedValue([]);
    const res = await service.getNotificationPreferences(7);
    expect(prisma.userNotificationPreference.createMany).toHaveBeenCalledWith({
      data: [1, 2, 3].map((id) => ({ userId: 7, notificationTypeId: id, emailEnabled: true })),
      skipDuplicates: true,
    });
    expect(res.preferences.map((p) => p.emailEnabled)).toEqual([true, true]);
  });
});
