import { MemoExpiryScheduler } from './memo-expiry.scheduler';

describe('MemoExpiryScheduler', () => {
  let expiry: { sweepOnce: jest.Mock };
  let scheduler: MemoExpiryScheduler;

  beforeEach(() => {
    delete process.env['MEMO_EXPIRY_CRON'];
    expiry = { sweepOnce: jest.fn().mockResolvedValue(undefined) };
    scheduler = new MemoExpiryScheduler(expiry as any);
  });

  it('sweeps once at boot and on every cron tick', async () => {
    scheduler.onApplicationBootstrap();
    await new Promise((r) => setImmediate(r)); // let the boot sweep finish
    await scheduler.onCron();
    expect(expiry.sweepOnce).toHaveBeenCalledTimes(2);
  });

  it('can be switched off with MEMO_EXPIRY_CRON=off', async () => {
    process.env['MEMO_EXPIRY_CRON'] = 'OFF';
    scheduler.onApplicationBootstrap();
    await scheduler.onCron();
    expect(expiry.sweepOnce).not.toHaveBeenCalled();
  });

  it('skips a tick while the previous sweep is still running', async () => {
    let finish!: () => void;
    expiry.sweepOnce.mockReturnValueOnce(new Promise<void>((r) => (finish = r)));
    const first = scheduler.tick('cron');
    await scheduler.tick('cron');
    expect(expiry.sweepOnce).toHaveBeenCalledTimes(1);
    finish();
    await first;
    await scheduler.tick('cron');
    expect(expiry.sweepOnce).toHaveBeenCalledTimes(2);
  });

  it('swallows sweep errors so the cron keeps running', async () => {
    expiry.sweepOnce.mockRejectedValueOnce(new Error('db down'));
    await expect(scheduler.tick('cron')).resolves.toBeUndefined();
    await scheduler.tick('cron');
    expect(expiry.sweepOnce).toHaveBeenCalledTimes(2);
  });
});
