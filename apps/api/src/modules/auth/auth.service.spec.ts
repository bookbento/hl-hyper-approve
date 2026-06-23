import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';

jest.mock('bcrypt');
const bcryptCompare = bcrypt.compare as jest.Mock;
const bcryptHash = bcrypt.hash as jest.Mock;

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  loginSession: {
    create: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
  },
  notificationType: { findMany: jest.fn() },
  userNotificationPreference: {
    count: jest.fn(),
    createMany: jest.fn(),
  },
};

const mockJwt = {
  sign: jest.fn().mockReturnValue('signed-token'),
  verify: jest.fn(),
};

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockJwt.sign.mockReturnValue('signed-token');
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: JwtService, useValue: mockJwt },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe('login', () => {
    const activeUser = {
      id: 1,
      name: 'Alice',
      email: 'alice@test.com',
      password: 'hashed',
      role: 'admin',
      businessUnitId: 1,
      deletedAt: null,
      isFirstLogin: false,
    };

    it('throws BadRequestException when email missing', async () => {
      await expect(service.login('', 'pw', null, null)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequestException when password missing', async () => {
      await expect(service.login('e@e.com', '', null, null)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws UnauthorizedException when user not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      bcryptCompare.mockResolvedValue(false);
      await expect(service.login('x@x.com', 'pw', null, null)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('throws UnauthorizedException when password mismatch', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);
      bcryptCompare.mockResolvedValue(false);
      await expect(service.login('alice@test.com', 'wrong', null, null)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('throws ForbiddenException when account deactivated (deletedAt set)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...activeUser, deletedAt: new Date() });
      bcryptCompare.mockResolvedValue(true);
      await expect(service.login('alice@test.com', 'pw', null, null)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns message, isFirstLogin, and refreshToken on success', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);
      bcryptCompare.mockResolvedValue(true);
      mockPrisma.loginSession.create.mockResolvedValue({});

      const result = await service.login('alice@test.com', 'pw', '127.0.0.1', 'agent');
      expect(result.message).toBe('Login successful');
      expect(result.isFirstLogin).toBe(false);
      expect(result.refreshToken).toBe('signed-token');
    });

    it('signs refreshToken with 7d expiry', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);
      bcryptCompare.mockResolvedValue(true);
      mockPrisma.loginSession.create.mockResolvedValue({});

      await service.login('alice@test.com', 'pw', null, null);
      expect(mockJwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, name: 'Alice', role: 'admin' }),
        { expiresIn: '7d' },
      );
    });

    it('records LoginSession with ip and userAgent', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(activeUser);
      bcryptCompare.mockResolvedValue(true);
      mockPrisma.loginSession.create.mockResolvedValue({});

      await service.login('alice@test.com', 'pw', '127.0.0.1', 'Mozilla/5.0');
      expect(mockPrisma.loginSession.create).toHaveBeenCalledWith({
        data: { userId: 1, ipAddress: '127.0.0.1', userAgent: 'Mozilla/5.0' },
      });
    });

    it('returns isFirstLogin true for first-time user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...activeUser, isFirstLogin: true });
      bcryptCompare.mockResolvedValue(true);
      mockPrisma.loginSession.create.mockResolvedValue({});

      const result = await service.login('alice@test.com', 'pw', null, null);
      expect(result.isFirstLogin).toBe(true);
    });
  });

  describe('refreshAccessToken', () => {
    it('throws ForbiddenException when token invalid', () => {
      mockJwt.verify.mockImplementation(() => { throw new Error('invalid'); });
      expect(() => service.refreshAccessToken('bad')).toThrow(ForbiddenException);
    });

    it('returns new accessToken signed with 1h', () => {
      mockJwt.verify.mockReturnValue({ id: 1, name: 'A', role: 'admin', businessUnitId: 1 });
      mockJwt.sign.mockReturnValue('new-access-token');
      const result = service.refreshAccessToken('valid-refresh');
      expect(result).toEqual({ accessToken: 'new-access-token' });
      expect(mockJwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1 }),
        { expiresIn: '1h' },
      );
    });

    it('strips JWT metadata (iat, exp) before re-signing', () => {
      mockJwt.verify.mockReturnValue({ id: 2, name: 'B', role: 'user', businessUnitId: 3, iat: 1234, exp: 5678 });
      mockJwt.sign.mockReturnValue('clean-token');
      service.refreshAccessToken('token');
      // sign should only receive { id, name, role, businessUnitId }
      expect(mockJwt.sign).toHaveBeenCalledWith(
        { id: 2, name: 'B', role: 'user', businessUnitId: 3 },
        { expiresIn: '1h' },
      );
    });
  });

  describe('logout', () => {
    it('does nothing when no token provided', async () => {
      await service.logout(undefined);
      expect(mockPrisma.loginSession.update).not.toHaveBeenCalled();
    });

    it('updates logoutAt when open session found', async () => {
      mockJwt.verify.mockReturnValue({ id: 1 });
      mockPrisma.loginSession.findFirst.mockResolvedValue({ id: 99 });
      mockPrisma.loginSession.update.mockResolvedValue({});

      await service.logout('valid-token');
      expect(mockPrisma.loginSession.update).toHaveBeenCalledWith({
        where: { id: 99 },
        data: { logoutAt: expect.any(Date) },
      });
    });

    it('silently handles expired/invalid token — cookie still cleared', async () => {
      mockJwt.verify.mockImplementation(() => { throw new Error('expired'); });
      await expect(service.logout('expired-token')).resolves.toBeUndefined();
    });

    it('does nothing when no open session found', async () => {
      mockJwt.verify.mockReturnValue({ id: 1 });
      mockPrisma.loginSession.findFirst.mockResolvedValue(null);

      await service.logout('valid-token');
      expect(mockPrisma.loginSession.update).not.toHaveBeenCalled();
    });
  });

  describe('getMe', () => {
    it('throws NotFoundException when user not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.getMe(999)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns user profile (Prisma select — no password field)', async () => {
      const userData = {
        id: 1, name: 'Alice', email: 'a@a.com', role: 'admin',
        lastname: null, nickname: null, department: null, businessUnit: null,
        profileImagePath: 'profiles/a.png', isFirstLogin: false, defaultSignatureText: null,
      };
      mockPrisma.user.findUnique.mockResolvedValue(userData);
      const result = await service.getMe(1);
      expect(result).toEqual(userData);
      expect(result).not.toHaveProperty('password');
    });
  });

  describe('getMySessions', () => {
    it('returns sessions list with last 50 sessions', async () => {
      const sessions = [{ id: 1, loginAt: new Date(), logoutAt: null, ipAddress: '1.1.1.1', userAgent: 'ua' }];
      mockPrisma.loginSession.findMany.mockResolvedValue(sessions);
      const result = await service.getMySessions(1);
      expect(result).toEqual({ sessions });
      expect(mockPrisma.loginSession.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 1 }, take: 50 }),
      );
    });
  });

  describe('changeFirstTimePassword', () => {
    it('throws BadRequestException when password too short (< 6 chars)', async () => {
      await expect(service.changeFirstTimePassword(1, 'abc')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequestException when password is whitespace only', async () => {
      await expect(service.changeFirstTimePassword(1, '      ')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws NotFoundException when user not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.changeFirstTimePassword(1, 'validpassword')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws BadRequestException when user.isFirstLogin is false', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 1, isFirstLogin: false });
      await expect(service.changeFirstTimePassword(1, 'validpassword')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('hashes password with 10 rounds and sets isFirstLogin = false', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 1, isFirstLogin: true });
      bcryptHash.mockResolvedValue('hashed-pw');
      mockPrisma.user.update.mockResolvedValue({});
      mockPrisma.notificationType.findMany.mockResolvedValue([]);
      mockPrisma.userNotificationPreference.count.mockResolvedValue(0);
      mockPrisma.userNotificationPreference.createMany.mockResolvedValue({});

      const result = await service.changeFirstTimePassword(1, 'newpassword');
      expect(result).toEqual({ message: 'Password changed successfully' });
      expect(bcryptHash).toHaveBeenCalledWith('newpassword', 10);
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { password: 'hashed-pw', isFirstLogin: false },
      });
    });

    it('creates all notification preferences (emailEnabled: true) on first login', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 1, isFirstLogin: true });
      bcryptHash.mockResolvedValue('hashed');
      mockPrisma.user.update.mockResolvedValue({});
      mockPrisma.notificationType.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
      mockPrisma.userNotificationPreference.count.mockResolvedValue(0);
      mockPrisma.userNotificationPreference.createMany.mockResolvedValue({});

      await service.changeFirstTimePassword(1, 'newpassword');
      expect(mockPrisma.userNotificationPreference.createMany).toHaveBeenCalledWith({
        data: [
          { userId: 1, notificationTypeId: 1, emailEnabled: true },
          { userId: 1, notificationTypeId: 2, emailEnabled: true },
        ],
        skipDuplicates: true,
      });
    });

    it('skips creating prefs when user already has preferences', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 1, isFirstLogin: true });
      bcryptHash.mockResolvedValue('hashed');
      mockPrisma.user.update.mockResolvedValue({});
      mockPrisma.notificationType.findMany.mockResolvedValue([{ id: 1 }]);
      mockPrisma.userNotificationPreference.count.mockResolvedValue(5);

      await service.changeFirstTimePassword(1, 'newpassword');
      expect(mockPrisma.userNotificationPreference.createMany).not.toHaveBeenCalled();
    });

    it('does not fail if notification preferences init throws', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 1, isFirstLogin: true });
      bcryptHash.mockResolvedValue('hashed');
      mockPrisma.user.update.mockResolvedValue({});
      mockPrisma.notificationType.findMany.mockRejectedValue(new Error('DB error'));

      await expect(service.changeFirstTimePassword(1, 'newpassword')).resolves.toEqual({
        message: 'Password changed successfully',
      });
    });
  });
});
