import { Module } from '@nestjs/common';
import { BusinessUnitController } from './business-unit.controller';
import { BusinessUnitService } from './business-unit.service';
import { AdminLogService } from '../../common/admin-log/admin-log.service';
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
  controllers: [BusinessUnitController],
  providers: [BusinessUnitService, AdminLogService, JwtAuthGuard, RolesGuard, Reflector],
})
export class BusinessUnitModule {}
