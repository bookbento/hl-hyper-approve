import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { MemoQueryController } from './memo-query.controller';
import { MemoQueryService } from './memo-query.service';
import { MemoSearchNestService } from './memo-search.service';
import { MemoReferenceNestService } from './memo-reference.service';
import { MemoAccessService } from './memo-access.service';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';

/**
 * MemoQueryModule
 *
 * Handles Batch 6a READ/query endpoints:
 *   GET  /api/memos
 *   GET  /api/memos/:id
 *   GET  /api/memos/awaiting-approval
 *   GET  /api/memos/current-approvers
 *   POST /api/memos/search
 *   POST /api/memos/search/stats
 *   GET  /api/memos/search-for-reference
 *   GET  /api/memos/:id/references
 *   PUT  /api/memos/:id/references
 *   GET  /api/memos/:id/reference-content/:referenceId
 *   POST /api/memos/users-delegation-info
 *
 * Exports MemoAccessService so future memo sub-batch modules can reuse it
 * without re-implementing canViewMemo/canViewMemoSimple.
 */
@Module({
  imports: [
    JwtModule.register({
      secret: process.env['JWT_SECRET'] ?? 'changeme',
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [MemoQueryController],
  providers: [
    MemoQueryService,
    MemoSearchNestService,
    MemoReferenceNestService,
    MemoAccessService,
    JwtAuthGuard,
    Reflector,
  ],
  exports: [MemoAccessService, MemoQueryService],
})
export class MemoQueryModule {}
