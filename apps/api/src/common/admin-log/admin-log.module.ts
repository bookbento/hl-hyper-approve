import { Global, Module } from '@nestjs/common';
import { AdminLogService } from './admin-log.service';

/**
 * Global module so AdminLogService can be injected anywhere
 * without explicitly importing AdminLogModule in each feature module.
 */
@Global()
@Module({
  providers: [AdminLogService],
  exports: [AdminLogService],
})
export class AdminLogModule {}
