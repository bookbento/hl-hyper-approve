import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { ApprovalLineController } from './approval-line.controller';
import { ApprovalLineService } from './approval-line.service';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env['JWT_SECRET'] ?? 'changeme',
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [ApprovalLineController],
  providers: [ApprovalLineService, JwtAuthGuard, Reflector],
  exports: [ApprovalLineService],
})
export class ApprovalLineModule {}
