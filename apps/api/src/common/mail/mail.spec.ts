const sendMail = jest.fn();
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail, verify: jest.fn().mockResolvedValue(true), close: jest.fn() })),
}));

import { MailService } from './mail.service';
import { EmailPreferenceService } from './email-preference.service';

describe('MailService', () => {
  beforeEach(() => sendMail.mockReset());

  it('sends from SMTP_FROM', async () => {
    process.env['SMTP_FROM'] = 'noreply@x.test';
    sendMail.mockResolvedValue({ messageId: '1' });
    const res = await new MailService().sendEmail(['a@x.test'], 'S', 'T', '<p>T</p>');
    expect(res).toEqual({ messageId: '1' });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'noreply@x.test', to: ['a@x.test'], subject: 'S', html: '<p>T</p>' }),
    );
  });

  it('swallows send failures', async () => {
    sendMail.mockRejectedValue(new Error('SMTP down'));
    await expect(new MailService().sendEmail(['a@x.test'], 'S', 'T')).resolves.toBeUndefined();
  });
});

describe('EmailPreferenceService', () => {
  const prisma = {
    notificationType: { findUnique: jest.fn() },
    userNotificationPreference: { findMany: jest.fn() },
  };
  const service = new EmailPreferenceService(prisma as any);

  beforeEach(() => jest.clearAllMocks());

  it('drops only users who disabled the type', async () => {
    prisma.notificationType.findUnique.mockResolvedValue({ id: 2 });
    prisma.userNotificationPreference.findMany.mockResolvedValue([{ userId: 2 }]);
    expect(await service.filterUsersForEmail([1, 2, 3], 'new-comment')).toEqual([1, 3]);
  });

  it('fails open for unknown slugs and errors', async () => {
    prisma.notificationType.findUnique.mockResolvedValueOnce(null);
    expect(await service.filterUsersForEmail([1], 'nope')).toEqual([1]);
    prisma.notificationType.findUnique.mockRejectedValueOnce(new Error('db'));
    expect(await service.filterUsersForEmail([1], 'x')).toEqual([1]);
  });

  it('skips the DB for an empty list', async () => {
    expect(await service.filterUsersForEmail([], 'x')).toEqual([]);
    expect(prisma.notificationType.findUnique).not.toHaveBeenCalled();
  });
});
