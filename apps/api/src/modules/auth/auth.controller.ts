import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { JwtAuthGuard, JwtPayload } from '../../common/guards/jwt.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ChangeFirstTimePasswordDto } from './dto/change-first-time-password.dto';

/**
 * Mirrors Express /api/auth routes with 100% parity:
 *   POST   /api/auth/login                        public
 *   GET    /api/auth/me                           JwtAuthGuard
 *   POST   /api/auth/refresh-token               public (body.token)
 *   POST   /api/auth/logout                      public (cookie)
 *   GET    /api/auth/sessions                    JwtAuthGuard
 *   POST   /api/auth/change-first-time-password  JwtAuthGuard
 *   GET    /api/me                               JwtAuthGuard (legacy alias)
 *
 * Cookie security (คุณอิเอริ verified parity):
 *   - httpOnly: true           — prevents JS access
 *   - secure: true in prod     — HTTPS only
 *   - sameSite: 'strict'       — prevents CSRF
 *   - path: '/'                — accessible on all paths
 *   - maxAge: 7d (ms)          — explicit expiry (mirrors Express)
 */
@Controller()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('api/auth/login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request & { cookies?: Record<string, string> },
    @Res({ passthrough: true }) res: Response,
  ) {
    const ipAddress =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
      req.ip ??
      null;
    const userAgent = (req.headers['user-agent'] as string) ?? null;

    const { message, isFirstLogin, refreshToken } = await this.authService.login(
      dto.email,
      dto.password,
      ipAddress,
      userAgent,
    );

    const isProduction = process.env['NODE_ENV'] === 'production';
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return { message, isFirstLogin };
  }

  @Get('api/auth/me')
  @UseGuards(JwtAuthGuard)
  getMe(@CurrentUser() user: JwtPayload) {
    return this.authService.getMe(user.id);
  }

  /**
   * Legacy alias: GET /api/me
   * Express registers this directly in app.ts outside /api/auth router.
   * Must also be handled by Nest after migration to avoid gap.
   */
  @Get('api/me')
  @UseGuards(JwtAuthGuard)
  getMeLegacy(@CurrentUser() user: JwtPayload) {
    return this.authService.getMe(user.id);
  }

  @Post('api/auth/refresh-token')
  @HttpCode(HttpStatus.OK)
  refreshToken(@Body() dto: RefreshTokenDto) {
    return this.authService.refreshAccessToken(dto.token);
  }

  @Post('api/auth/logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() req: Request & { cookies?: Record<string, string> },
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = req.cookies?.['refreshToken'];
    await this.authService.logout(token);
    res.clearCookie('refreshToken');
  }

  @Get('api/auth/sessions')
  @UseGuards(JwtAuthGuard)
  getMySessions(@CurrentUser() user: JwtPayload) {
    return this.authService.getMySessions(user.id);
  }

  @Post('api/auth/change-first-time-password')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  changeFirstTimePassword(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ChangeFirstTimePasswordDto,
  ) {
    return this.authService.changeFirstTimePassword(user.id, dto.newPassword);
  }
}
