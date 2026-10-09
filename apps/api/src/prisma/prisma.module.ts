import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { prisma } from '@hl/database';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [{ provide: PrismaService, useValue: prisma }],
  exports: [PrismaService],
})
export class PrismaModule implements OnApplicationShutdown {
  // The client connects lazily on the first query. Disconnect on shutdown
  // (requires app.enableShutdownHooks() in main.ts) so pm2 restarts don't
  // leave connections hanging on the DB side.
  async onApplicationShutdown(): Promise<void> {
    await prisma.$disconnect();
  }
}
