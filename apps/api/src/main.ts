import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import * as cookieParser from 'cookie-parser';
import { assertConfig } from './common/config/assert-config';

async function bootstrap(): Promise<void> {
  // Fail before DI with one readable list of everything that's misconfigured.
  assertConfig();

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Trust exactly the number of proxies in front of us (nginx = 1) so req.ip is
  // the real client. Never `true`: that trusts any X-Forwarded-For a client sends.
  // Default 0 (off) for local dev where nothing sits in front.
  const trustProxyHops = Number(process.env['TRUST_PROXY_HOPS'] ?? 0);
  if (trustProxyHops > 0) {
    app.set('trust proxy', trustProxyHops);
  }

  // Run onApplicationShutdown on SIGTERM/SIGINT (pm2 restart) so PrismaModule
  // can close the connection pool.
  app.enableShutdownHooks();

  app.use(cookieParser());

  const port = process.env['PORT'] ?? 3002;
  await app.listen(port);
  console.log(`NestJS app running on http://localhost:${port}`);
}

bootstrap();
