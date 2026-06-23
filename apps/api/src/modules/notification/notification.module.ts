import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env['JWT_SECRET'] ?? 'changeme',
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [NotificationController],
  providers: [NotificationService, JwtAuthGuard, Reflector],
  exports: [NotificationService],
})
export class NotificationModule {}
