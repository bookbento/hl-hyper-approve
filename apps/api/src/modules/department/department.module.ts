import { Module } from '@nestjs/common';
import { DepartmentController } from './department.controller';
import { DepartmentService } from './department.service';
import { JwtModule } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { SelfOrAdminGuard } from '../../common/guards/self-or-admin.guard';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env['JWT_SECRET'] ?? 'changeme',
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [DepartmentController],
  providers: [
    DepartmentService,
    JwtAuthGuard,
    RolesGuard,
    SelfOrAdminGuard,
    Reflector,
  ],
})
export class DepartmentModule {}
