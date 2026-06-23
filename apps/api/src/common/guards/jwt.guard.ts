import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';

export interface JwtPayload {
  id: number;
  name: string;
  role: string;
  businessUnitId: number;
  teamId?: number;
}

/**
 * Mirrors Express authenticate middleware:
 *  - reads token from cookie refreshToken OR Authorization Bearer header
 *  - verifies JWT
 *  - checks user is not soft-deleted
 *  - attaches decoded payload as request.user
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: JwtPayload; cookies?: Record<string, string> }>();

    const token = this.extractToken(request);
    if (!token) {
      throw new UnauthorizedException('No token provided');
    }

    let decoded: JwtPayload;
    try {
      decoded = this.jwtService.verify<JwtPayload>(token);
    } catch {
      throw new ForbiddenException('ข้อมูลคนอื่นอย่าแอบดูสิจ๊ะ');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: decoded.id },
      select: { deletedAt: true },
    });

    if (!user || user.deletedAt) {
      throw new ForbiddenException('ACCOUNT_ARCHIVED');
    }

    request.user = decoded;
    return true;
  }

  private extractToken(request: Request & { cookies?: Record<string, string> }): string | null {
    const cookieToken = request.cookies?.['refreshToken'];
    if (cookieToken) return cookieToken;

    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }
    return null;
  }
}
