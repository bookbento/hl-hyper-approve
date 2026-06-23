import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { LoaManagementController } from './loa-management.controller';
import { LoaManagementService } from './loa-management.service';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env['JWT_SECRET'] ?? 'changeme',
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [LoaManagementController],
  providers: [LoaManagementService, JwtAuthGuard, Reflector],
  exports: [LoaManagementService],
})
export class LoaManagementModule {}
