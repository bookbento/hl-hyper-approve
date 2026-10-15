import { Controller, Get } from '@nestjs/common';

/** GET /api/health — was served by Express; used by pm2/nginx/deploy health checks. */
@Controller('api/health')
export class HealthController {
  @Get()
  check() {
    return { ok: true, time: new Date().toISOString() };
  }
}
