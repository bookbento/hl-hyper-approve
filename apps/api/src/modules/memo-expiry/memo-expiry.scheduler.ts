import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MemoExpiryService } from './memo-expiry.service';

/**
 * Runs the expiry sweep once at boot and then every minute (Asia/Bangkok),
 * like scheduleMemoExpiry() in the Express backend.
 *
 * MEMO_EXPIRY_CRON=off disables it (e.g. a second instance, or local work
 * against a shared DB) — exactly one process must run it or emails go out twice.
 */
@Injectable()
export class MemoExpiryScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(MemoExpiryScheduler.name);
  private running = false;

  constructor(private readonly expiry: MemoExpiryService) {}

  static isEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return (env['MEMO_EXPIRY_CRON'] ?? '').trim().toLowerCase() !== 'off';
  }

  onApplicationBootstrap(): void {
    if (!MemoExpiryScheduler.isEnabled()) {
      this.logger.warn('MEMO_EXPIRY_CRON=off — memo expiry sweep disabled');
      return;
    }
    void this.tick('boot');
  }

  @Cron('* * * * *', { name: 'memo-expiry', timeZone: 'Asia/Bangkok' })
  async onCron(): Promise<void> {
    if (!MemoExpiryScheduler.isEnabled()) return;
    await this.tick('cron');
  }

  /**
   * Skips a tick while the previous sweep is still running, so a slow SMTP
   * server can't stack sweeps that each send the same reminder.
   */
  async tick(source: 'boot' | 'cron'): Promise<void> {
    if (this.running) {
      this.logger.warn(`previous sweep still running — skipping ${source} tick`);
      return;
    }
    this.running = true;
    try {
      await this.expiry.sweepOnce();
    } catch (err) {
      this.logger.error(`${source} sweep failed: ${(err as Error)?.stack ?? err}`);
    } finally {
      this.running = false;
    }
  }
}
