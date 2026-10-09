import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { MemoQueryModule } from '../memo-query/memo-query.module';
import { MemoPdfController } from './memo-pdf.controller';
import { MemoPdfService } from './memo-pdf.service';

/** Batch 8a — memo PDF downloads (see MemoPdfController). */
@Module({
  imports: [
    MemoQueryModule,
    JwtModule.register({
      secret: process.env['JWT_SECRET'] ?? 'changeme',
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [MemoPdfController],
  providers: [MemoPdfService, JwtAuthGuard, Reflector],
  exports: [MemoPdfService],
})
export class MemoPdfModule {}
