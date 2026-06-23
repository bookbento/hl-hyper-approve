import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { MemoCcController } from './memocc.controller';
import { MemoCcService } from './memocc.service';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env['JWT_SECRET'] ?? 'changeme',
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [MemoCcController],
  providers: [MemoCcService, JwtAuthGuard, Reflector],
  exports: [MemoCcService],
})
export class MemoCcModule {}
