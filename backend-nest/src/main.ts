import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as cookieParser from 'cookie-parser';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.use(cookieParser());

  const port = process.env['PORT'] ?? 3002;
  await app.listen(port);
  console.log(`NestJS app running on http://localhost:${port}`);
}

bootstrap();
