import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { ExpressProxyMiddleware } from './express-proxy.middleware';

/**
 * GatewayModule wires the catch-all proxy onto every route that Nest
 * does not own natively.
 *
 * Currently migrated to Nest (native handlers — NOT proxied):
 *   - /api/business-units  (all methods)
 *   - /api/departments     (all methods)
 *   - /api/types           (GET only — public)
 *
 * Everything else under /api/* is forwarded to EXPRESS_TARGET.
 */
@Module({
  providers: [ExpressProxyMiddleware],
})
export class GatewayModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(ExpressProxyMiddleware)
      .exclude(
        { path: 'api/business-units', method: RequestMethod.ALL },
        { path: 'api/business-units/(.*)', method: RequestMethod.ALL },
        { path: 'api/departments', method: RequestMethod.ALL },
        { path: 'api/departments/(.*)', method: RequestMethod.ALL },
        { path: 'api/types', method: RequestMethod.ALL },
        { path: 'api/types/(.*)', method: RequestMethod.ALL },
      )
      .forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
