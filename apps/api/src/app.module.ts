import { Module } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { AdminLogModule } from './common/admin-log/admin-log.module';
import { BusinessUnitModule } from './modules/business-unit/business-unit.module';
import { DepartmentModule } from './modules/department/department.module';
import { GatewayModule } from './common/gateway/gateway.module';

@Module({
  imports: [
    PrismaModule,
    AdminLogModule,
    BusinessUnitModule,
    DepartmentModule,
    GatewayModule,
  ],
  providers: [
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    },
  ],
})
export class AppModule {}
