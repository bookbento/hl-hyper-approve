/**
 * MemoLifecycleModule (Batch 6b)
 *
 * Provides Nest-native handlers for memo WRITE/lifecycle endpoints:
 *   POST   /api/memos
 *   PUT    /api/memos/:id
 *   DELETE /api/memos/:id
 *   DELETE /api/memos/:id/force
 *   POST   /api/memos/:id/renew-expiry
 *   POST   /api/memos/:id/upload-main
 *
 * Imports MemoQueryModule to consume MemoAccessService if needed by
 * future sub-operations (e.g. authorizing renewExpiry via canViewMemo).
 */

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { MemoLifecycleController } from './memo-lifecycle.controller';
import { MemoLifecycleService } from './memo-lifecycle.service';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { MemoQueryModule } from '../memo-query/memo-query.module';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env['JWT_SECRET'] ?? 'changeme',
      signOptions: { expiresIn: '7d' },
    }),
    MemoQueryModule,
  ],
  controllers: [MemoLifecycleController],
  providers: [MemoLifecycleService, JwtAuthGuard, Reflector],
  exports: [MemoLifecycleService],
})
export class MemoLifecycleModule {}
