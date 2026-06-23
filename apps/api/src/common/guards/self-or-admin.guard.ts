import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtPayload } from './jwt.guard';

/**
 * Mirrors Express authorizeSelfOrAdmin middleware:
 *   - Allows if user.id === param :id (self)
 *   - Allows if user.role === "admin"
 *   - Otherwise 403 Forbidden
 *
 * Must run AFTER JwtAuthGuard (requires request.user to be populated).
 */
@Injectable()
export class SelfOrAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: JwtPayload }>();

    const user = request.user;
    if (!user) {
      throw new UnauthorizedException();
    }

    const paramId = Number(request.params['id']);
    const isSelf = user.id === paramId;
    const isAdmin = (user.role ?? '').toLowerCase() === 'admin';

    if (!isSelf && !isAdmin) {
      throw new ForbiddenException();
    }

    return true;
  }
}
