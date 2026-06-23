import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { FileServingController } from './file-serving.controller';
import { FileServingService } from './file-serving.service';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env['JWT_SECRET'] ?? 'changeme',
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [FileServingController],
  providers: [FileServingService, JwtAuthGuard, Reflector],
})
export class FileServingModule {}
