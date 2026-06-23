import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { SelfOrAdminGuard } from '../../common/guards/self-or-admin.guard';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env['JWT_SECRET'] ?? 'changeme',
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [UserController],
  providers: [UserService, JwtAuthGuard, SelfOrAdminGuard, Reflector],
})
export class UserModule {}
