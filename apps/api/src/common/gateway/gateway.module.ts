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
 *   - /api/users/:id/signatures           — Batch 3 (userSignature)
 *   - /api/users/:id/default-signature    — Batch 3
 *   - /api/users/signatures/:sigId/file   — Batch 3
 *   - /api/users/signatures/:sigId        — Batch 3
 *   - /api/secure-uploads                 — Batch 3 (file serving)
 *   - /api/approval-lines                 — Batch 4 (approval-line)
 *   - /api/teams                          — Batch 4 (approval-line)
 *   - /api/memos/:id/approvers            — Batch 4 (approval-line)
 *   - /api/memos/:id/approval-line        — Batch 4 (approval-line)
 *   - /api/approval-requests/my           — Batch 4 (approval-line)
 *   - /api/memotypes                      — Batch 4 (memotype)
 *
 * Still proxied to Express:
 *   - /api/memos (non-approver/approval-line sub-paths), /api/notifications, etc.
 *   - everything else under /api/*
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

        // ── Batch 3: UserSignature ────────────────────────────────────────────
        // Note: "signatures/:sigId" paths must also be excluded so Nest handles them.
        // "signatures" is a static segment — cannot match as :id — so listing both
        // static and dynamic forms is intentional (explicit over wildcard policy).
        { path: 'api/users/:id/signatures', method: RequestMethod.GET },
        { path: 'api/users/:id/signatures', method: RequestMethod.POST },
        { path: 'api/users/:id/default-signature', method: RequestMethod.PUT },
        { path: 'api/users/signatures/:sigId/file', method: RequestMethod.GET },
        { path: 'api/users/signatures/:sigId', method: RequestMethod.DELETE },

        // ── Batch 3: Secure file serving ─────────────────────────────────────
        { path: 'api/secure-uploads', method: RequestMethod.GET },
        { path: 'api/secure-uploads/(.*)', method: RequestMethod.GET },

        // ── Batch 4: Approval Line ────────────────────────────────────────────
        // GET /api/teams
        { path: 'api/teams', method: RequestMethod.GET },
        // GET /api/teams/:id/approval-lines
        { path: 'api/teams/:id/approval-lines', method: RequestMethod.GET },
        // /api/approval-lines CRUD
        { path: 'api/approval-lines', method: RequestMethod.GET },
        { path: 'api/approval-lines', method: RequestMethod.POST },
        { path: 'api/approval-lines/:id', method: RequestMethod.PUT },
        { path: 'api/approval-lines/:id', method: RequestMethod.DELETE },
        // Memo approval sub-paths (explicit — /api/memos/* still goes to Express for other paths)
        { path: 'api/memos/:id/approvers', method: RequestMethod.GET },
        { path: 'api/memos/:id/approval-line', method: RequestMethod.GET },
        // My approval requests
        { path: 'api/approval-requests/my', method: RequestMethod.GET },

        // ── Batch 4: Memotype ─────────────────────────────────────────────────
        { path: 'api/memotypes', method: RequestMethod.GET },
        { path: 'api/memotypes', method: RequestMethod.POST },
        { path: 'api/memotypes/count', method: RequestMethod.GET },
        { path: 'api/memotypes/:id', method: RequestMethod.GET },
        { path: 'api/memotypes/:id', method: RequestMethod.PUT },
        { path: 'api/memotypes/:id', method: RequestMethod.DELETE },
        { path: 'api/memotypes/:typeId/files/:fileId', method: RequestMethod.DELETE },
      )
      .forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
