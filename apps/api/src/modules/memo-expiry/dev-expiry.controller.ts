import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { MemoExpiryService } from './memo-expiry.service';

/**
 * Dev tools for the expiry sweep. Ported from backend/src/routes/dev-expiry.routes.ts.
 *
 *   POST /api/dev/expiry/set/:memoId   { mode: "expired" | "3d" | "date", date?: "YYYY-MM-DD" }
 *   POST /api/dev/expiry/run           { pretendNow?: ISO string }
 *   POST /api/dev/expiry/reset/:memoId — forget "[expiry:*]" reminders already sent
 *
 * Not registered when NODE_ENV=production (see MemoExpiryModule). Express served
 * these with no auth at all, in production too; here they need an admin login.
 */
@Controller('api/dev/expiry')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class DevExpiryController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly expiry: MemoExpiryService,
  ) {}

  @HttpCode(200)
  @Post('set/:memoId')
  async set(
    @Param('memoId', ParseIntPipe) memoId: number,
    @Body() body: { mode?: string; date?: string },
  ) {
    const mode = String(body?.mode || 'expired');
    const today = new Date();
    const y = today.getUTCFullYear();
    const mo = today.getUTCMonth();
    const d = today.getUTCDate();

    let expiresAt: Date;
    if (mode === '3d') {
      expiresAt = new Date(Date.UTC(y, mo, d + 3, 23, 59, 59, 999));
    } else if (mode === 'date' && body?.date) {
      const [yy, mm, dd] = body.date.split('-').map(Number);
      expiresAt = new Date(Date.UTC(yy, mm - 1, dd, 23, 59, 59, 999));
    } else {
      expiresAt = new Date(Date.UTC(y, mo, d - 1, 23, 59, 59, 999));
    }

    await this.prisma.masterMemo.update({ where: { id: memoId }, data: { expiresAt } });
    return { ok: true, memoId, expiresAt };
  }

  @HttpCode(200)
  @Post('run')
  async run(@Body() body: { pretendNow?: string }) {
    await this.expiry.sweepOnce(body?.pretendNow ? new Date(body.pretendNow) : new Date());
    return { ok: true };
  }

  @HttpCode(200)
  @Post('reset/:memoId')
  async reset(@Param('memoId', ParseIntPipe) memoId: number) {
    await this.prisma.memoHistory.deleteMany({
      where: { memoId, action: { contains: '[expiry:' } },
    });
    return { ok: true };
  }
}
