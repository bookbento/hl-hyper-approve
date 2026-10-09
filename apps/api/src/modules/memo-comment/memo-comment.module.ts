import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { MemoCommentController } from './memo-comment.controller';
import { MemoCommentService } from './memo-comment.service';

/**
 * Batch 7a — memo comments:
 *   GET    /api/memos/:id/comments
 *   POST   /api/memos/:id/comments
 *   DELETE /api/comments/:commentId
 */
@Module({
  imports: [
    JwtModule.register({
      secret: process.env['JWT_SECRET'] ?? 'changeme',
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [MemoCommentController],
  providers: [MemoCommentService, JwtAuthGuard, Reflector],
})
export class MemoCommentModule {}
