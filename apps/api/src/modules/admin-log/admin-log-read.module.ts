import { Module } from '@nestjs/common';
import { AdminLogController } from './admin-log.controller';
import { AdminLogReadService } from './admin-log-read.service';
import { JwtModule } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env['JWT_SECRET'] ?? 'changeme',
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [AdminLogController],
  providers: [AdminLogReadService, JwtAuthGuard, RolesGuard, Reflector],
})
export class AdminLogReadModule {}
