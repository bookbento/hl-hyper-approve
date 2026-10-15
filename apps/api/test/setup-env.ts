// The expiry cron would sweep the mocked Prisma at boot of every AppModule e2e.
process.env['MEMO_EXPIRY_CRON'] = 'off';
