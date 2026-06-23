import { Module } from '@nestjs/common';
import { CcGroupController } from './cc-group.controller';
import { CcGroupService } from './cc-group.service';
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
  controllers: [CcGroupController],
  providers: [CcGroupService, JwtAuthGuard, RolesGuard, Reflector],
})
export class CcGroupModule {}
