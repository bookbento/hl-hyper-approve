import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { MemoQueryModule } from '../memo-query/memo-query.module';
import { MemoExpiryService } from './memo-expiry.service';
import { MemoExpiryScheduler } from './memo-expiry.scheduler';
import { DevExpiryController } from './dev-expiry.controller';

/**
 * Memo expiry sweep (was scheduleMemoExpiry() in the Express backend) plus the
 * /api/dev/expiry tools, which only exist outside production.
 */
@Module({
  imports: [
    ScheduleModule.forRoot(),
    MemoQueryModule,
    JwtModule.register({
      secret: process.env['JWT_SECRET'] ?? 'changeme',
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: process.env['NODE_ENV'] === 'production' ? [] : [DevExpiryController],
  providers: [MemoExpiryService, MemoExpiryScheduler, JwtAuthGuard, RolesGuard, Reflector],
  exports: [MemoExpiryService],
})
export class MemoExpiryModule {}
