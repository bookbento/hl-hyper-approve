import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { JwtPayload } from './jwt.guard';

export const ROLES_KEY = 'roles';

/**
 * Mirrors Express authorizeAdmin / authorizeAdminOrDcc:
 * - reads required roles from @Roles() decorator metadata
 * - checks request.user.role (set by JwtAuthGuard) against allowed roles
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const user = request.user;

    if (!user) {
      throw new UnauthorizedException();
    }

    const userRole = (user.role ?? '').toLowerCase();
    const allowed = requiredRoles.map((r) => r.toLowerCase());

    if (!allowed.includes(userRole)) {
      throw new ForbiddenException();
    }

    return true;
  }
}
