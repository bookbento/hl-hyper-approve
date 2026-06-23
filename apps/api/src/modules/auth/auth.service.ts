import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { JwtPayload } from '../../common/guards/jwt.guard';

export interface LoginResult {
  message: string;
  isFirstLogin: boolean;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * Mirrors Express login handler:
   * - validates email+password
   * - checks deletedAt (deactivated)
   * - issues refreshToken (7d)
   * - records LoginSession with IP + userAgent
   * - returns { message, isFirstLogin, refreshToken }
   *
   * Security (คุณอิเอริ):
   * - bcrypt.compare prevents timing side-channel via constant-time compare
   * - deletedAt check prevents login for archived accounts
   * - JWT signed with JWT_SECRET env var (validated at module init)
   * - refreshToken is 7d; accessToken issued separately is 1h
   */
  async login(
    email: string,
    password: string,
    ipAddress: string | null,
    userAgent: string | null,
  ): Promise<LoginResult> {
    if (!email || !password) {
      throw new BadRequestException('Email and password are required');
    }

    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.deletedAt) {
      throw new ForbiddenException(
        'Your account has been deactivated. Please contact support.',
      );
    }

    const payload: JwtPayload = {
      id: user.id,
      name: user.name,
      role: user.role,
      businessUnitId: user.businessUnitId ?? 0,
    };

    const refreshToken = this.jwtService.sign(payload, { expiresIn: '7d' });

    // Record login session
    await this.prisma.loginSession.create({
      data: { userId: user.id, ipAddress, userAgent },
    });

    return { message: 'Login successful', isFirstLogin: user.isFirstLogin, refreshToken };
  }

  /**
   * Mirrors Express refreshToken handler:
   * - verifies a token passed in request body
   * - issues new short-lived accessToken (1h)
   *
   * Security: strips JWT metadata (iat, exp) before re-signing
   */
  refreshAccessToken(token: string): { accessToken: string } {
    let decoded: JwtPayload;
    try {
      decoded = this.jwtService.verify<JwtPayload>(token);
    } catch {
      throw new ForbiddenException('Invalid or expired token');
    }

    // Strip JWT metadata fields before re-signing
    const { id, name, role, businessUnitId } = decoded;
    const accessToken = this.jwtService.sign(
      { id, name, role, businessUnitId },
      { expiresIn: '1h' },
    );
    return { accessToken };
  }

  /**
   * Mirrors Express logout handler:
   * - reads refreshToken from cookie
   * - looks up open LoginSession for the user
   * - sets logoutAt timestamp
   * - silently handles invalid/expired tokens (still clears cookie)
   */
  async logout(refreshTokenCookie: string | undefined): Promise<void> {
    if (!refreshTokenCookie) return;

    try {
      const decoded = this.jwtService.verify<JwtPayload>(refreshTokenCookie);
      const userId = decoded?.id;

      if (userId) {
        const session = await this.prisma.loginSession.findFirst({
          where: { userId, logoutAt: null },
          orderBy: { loginAt: 'desc' },
        });

        if (session) {
          await this.prisma.loginSession.update({
            where: { id: session.id },
            data: { logoutAt: new Date() },
          });
        }
      }
    } catch {
      // Token expired or invalid — still clear the cookie (mirrors Express behavior)
    }
  }

  /**
   * Mirrors Express /api/auth/me handler.
   * Returns user profile without password field.
   */
  async getMe(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        lastname: true,
        nickname: true,
        email: true,
        role: true,
        department: { select: { id: true, name: true } },
        businessUnit: { select: { id: true, name: true } },
        profileImagePath: true,
        isFirstLogin: true,
        defaultSignatureText: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  /**
   * Mirrors Express getMySessions handler.
   * Returns last 50 sessions for the authenticated user.
   */
  async getMySessions(userId: number) {
    const sessions = await this.prisma.loginSession.findMany({
      where: { userId },
      orderBy: { loginAt: 'desc' },
      take: 50,
      select: {
        id: true,
        loginAt: true,
        logoutAt: true,
        ipAddress: true,
        userAgent: true,
      },
    });

    return { sessions };
  }

  /**
   * Mirrors Express changeFirstTimePassword handler:
   * - validates newPassword length >= 6
   * - validates user.isFirstLogin === true
   * - hashes password with bcrypt 10 rounds
   * - sets isFirstLogin = false
   * - initializes all notification preferences (emailEnabled: true)
   * - non-throwing: notification init failure does not fail the request
   */
  async changeFirstTimePassword(userId: number, newPassword: string): Promise<{ message: string }> {
    if (!newPassword || newPassword.trim().length < 6) {
      throw new BadRequestException('Password must be at least 6 characters long');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (!user.isFirstLogin) {
      throw new BadRequestException('This endpoint is only for first-time password changes');
    }

    const hashedPassword = await bcrypt.hash(newPassword.trim(), 10);

    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword, isFirstLogin: false },
    });

    // Initialize notification preferences on first password change (non-throwing)
    try {
      const notificationTypes = await this.prisma.notificationType.findMany();
      const existingPrefsCount = await this.prisma.userNotificationPreference.count({
        where: { userId },
      });

      if (existingPrefsCount === 0) {
        const defaultPreferences = notificationTypes.map((type: { id: number }) => ({
          userId,
          notificationTypeId: type.id,
          emailEnabled: true,
        }));

        await this.prisma.userNotificationPreference.createMany({
          data: defaultPreferences,
          skipDuplicates: true,
        });

        this.logger.log(
          `[First Login] Created ${defaultPreferences.length} notification preferences for user ${userId}`,
        );
      }
    } catch (prefError: unknown) {
      this.logger.error('Failed to initialize notification preferences on first login', prefError);
    }

    return { message: 'Password changed successfully' };
  }
}
