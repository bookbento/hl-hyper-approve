import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { MemotypeController } from './memotype.controller';
import { MemotypeService } from './memotype.service';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env['JWT_SECRET'] ?? 'changeme',
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [MemotypeController],
  providers: [MemotypeService, JwtAuthGuard, Reflector],
})
export class MemotypeModule {}
