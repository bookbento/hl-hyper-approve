import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { ExpressProxyMiddleware } from './express-proxy.middleware';

/**
 * GatewayModule wires the catch-all proxy onto every route that Nest
 * does not own natively.
 *
 * Currently migrated to Nest (native handlers — NOT proxied):
 *   - /api/business-units  (all methods)
 *   - /api/departments     (all methods)
 *   - /api/types           (GET)
 *   - /api/admin-logs      (all methods)
 *   - /api/cc-groups       (all methods)
 *   - /api/auth            (all methods) — Batch 2
 *   - /api/me              (GET)         — Batch 2 (legacy alias)
 *   - /api/users           (CRUD + BU/DCC access + delegation + notification prefs) — Batch 2
 *
 * Still proxied to Express:
 *   - /api/users/:id/signatures      — file upload (batch file infra)
 *   - /api/users/:id/default-signature
 *   - /api/users/signatures/:sigId
 *   - everything else under /api/*
 *
 * Path collision analysis (userSignature vs user CRUD):
 *   userSignature paths under /api/users:
 *     GET/POST  /:id/signatures
 *     PUT       /:id/default-signature
 *     GET       /signatures/:sigId/file
 *     DELETE    /signatures/:sigId
 *   These are NOT in the Nest exclude list → still proxy to Express.
 *   Nest user CRUD paths do not overlap with these signature paths.
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
        // ── Batch 1 ─────────────────────────────────────────────────────────
        { path: 'api/business-units', method: RequestMethod.ALL },
        { path: 'api/business-units/(.*)', method: RequestMethod.ALL },
        { path: 'api/departments', method: RequestMethod.ALL },
        { path: 'api/departments/(.*)', method: RequestMethod.ALL },
        { path: 'api/types', method: RequestMethod.ALL },
        { path: 'api/types/(.*)', method: RequestMethod.ALL },
        { path: 'api/admin-logs', method: RequestMethod.ALL },
        { path: 'api/admin-logs/(.*)', method: RequestMethod.ALL },
        { path: 'api/cc-groups', method: RequestMethod.ALL },
        { path: 'api/cc-groups/(.*)', method: RequestMethod.ALL },

        // ── Batch 2: Auth ────────────────────────────────────────────────────
        { path: 'api/auth', method: RequestMethod.ALL },
        { path: 'api/auth/(.*)', method: RequestMethod.ALL },
        // Legacy /api/me alias (was directly in Express app.ts)
        { path: 'api/me', method: RequestMethod.GET },

        // ── Batch 2: User CRUD + access management ────────────────────────────
        // /api/users GET (list) and specific sub-paths
        // Signature paths (:id/signatures, :id/default-signature, signatures/:sigId)
        // are intentionally NOT excluded here — they proxy to Express.
        { path: 'api/users', method: RequestMethod.GET },
        { path: 'api/users', method: RequestMethod.POST },
        { path: 'api/users/check-email', method: RequestMethod.GET },
        { path: 'api/users/search', method: RequestMethod.GET },
        { path: 'api/users/basic-info', method: RequestMethod.GET },
        { path: 'api/users/archived', method: RequestMethod.GET },
        { path: 'api/users/bulk', method: RequestMethod.POST },
        { path: 'api/users/me/notification-preferences', method: RequestMethod.GET },
        { path: 'api/users/me/notification-preferences/bulk', method: RequestMethod.PUT },
        { path: 'api/users/me/notification-preferences/(.*)', method: RequestMethod.PUT },
        // /:id — CRUD
        { path: 'api/users/:id', method: RequestMethod.GET },
        { path: 'api/users/:id', method: RequestMethod.PUT },
        { path: 'api/users/:id', method: RequestMethod.DELETE },
        // /:id sub-resources (CRUD, not signature)
        { path: 'api/users/:id/restore', method: RequestMethod.POST },
        { path: 'api/users/:id/change-password', method: RequestMethod.PUT },
        { path: 'api/users/:id/profile-image', method: RequestMethod.PUT },
        { path: 'api/users/:id/force-password-reset', method: RequestMethod.POST },
        { path: 'api/users/:id/clear-first-login', method: RequestMethod.POST },
        { path: 'api/users/:id/delegation', method: RequestMethod.GET },
        { path: 'api/users/:id/delegation', method: RequestMethod.PUT },
        { path: 'api/users/:id/delegation', method: RequestMethod.DELETE },
        { path: 'api/users/:id/business-unit-access', method: RequestMethod.GET },
        { path: 'api/users/:id/business-unit-access', method: RequestMethod.PUT },
        { path: 'api/users/:id/accessible-business-units', method: RequestMethod.GET },
        { path: 'api/users/:id/dcc-management-access', method: RequestMethod.GET },
        { path: 'api/users/:id/dcc-management-access', method: RequestMethod.PUT },
        { path: 'api/users/:id/manageable-business-units', method: RequestMethod.GET },
      )
      .forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
