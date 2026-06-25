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
 *   - /api/notifications                  — Batch 5 (notification)
 *   - /api/approver-lines                 — Batch 5 (LOA management)
 *   - /api/approvers                      — Batch 5 (LOA management)
 *   - /api/approval-lines/:id/update-approvers — Batch 5 (LOA management)
 *   - /api/memos/:id/cc                   — Batch 5 (memocc)
 *   - /api/memos/cc/me                    — Batch 5 (memocc)
 *   - /api/memos                          — Batch 6a (memo-query READ)
 *   - /api/memos/:id                      — Batch 6a (memo-query READ)
 *   - /api/memos/awaiting-approval        — Batch 6a
 *   - /api/memos/current-approvers        — Batch 6a
 *   - /api/memos/search                   — Batch 6a
 *   - /api/memos/search/stats             — Batch 6a
 *   - /api/memos/search-for-reference     — Batch 6a
 *   - /api/memos/users-delegation-info    — Batch 6a
 *   - /api/memos/:id/references           — Batch 6a
 *   - /api/memos/:id/reference-content/:referenceId — Batch 6a
 *
 * Still proxied to Express:
 *   - /api/memos (write: POST/PUT/DELETE and other sub-paths)
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
        { path: 'api/users/:id/signatures', method: RequestMethod.GET },
        { path: 'api/users/:id/signatures', method: RequestMethod.POST },
        { path: 'api/users/:id/default-signature', method: RequestMethod.PUT },
        { path: 'api/users/signatures/:sigId/file', method: RequestMethod.GET },
        { path: 'api/users/signatures/:sigId', method: RequestMethod.DELETE },

        // ── Batch 3: Secure file serving ─────────────────────────────────────
        { path: 'api/secure-uploads', method: RequestMethod.GET },
        { path: 'api/secure-uploads/(.*)', method: RequestMethod.GET },

        // ── Batch 4: Approval Line ────────────────────────────────────────────
        { path: 'api/teams', method: RequestMethod.GET },
        { path: 'api/teams/:id/approval-lines', method: RequestMethod.GET },
        { path: 'api/approval-lines', method: RequestMethod.GET },
        { path: 'api/approval-lines', method: RequestMethod.POST },
        { path: 'api/approval-lines/:id', method: RequestMethod.PUT },
        { path: 'api/approval-lines/:id', method: RequestMethod.DELETE },
        { path: 'api/memos/:id/approvers', method: RequestMethod.GET },
        { path: 'api/memos/:id/approval-line', method: RequestMethod.GET },
        { path: 'api/approval-requests/my', method: RequestMethod.GET },

        // ── Batch 4: Memotype ─────────────────────────────────────────────────
        { path: 'api/memotypes', method: RequestMethod.GET },
        { path: 'api/memotypes', method: RequestMethod.POST },
        { path: 'api/memotypes/count', method: RequestMethod.GET },
        { path: 'api/memotypes/:id', method: RequestMethod.GET },
        { path: 'api/memotypes/:id', method: RequestMethod.PUT },
        { path: 'api/memotypes/:id', method: RequestMethod.DELETE },
        { path: 'api/memotypes/:typeId/files/:fileId', method: RequestMethod.DELETE },

        // ── Batch 5: Notification ─────────────────────────────────────────────
        { path: 'api/notifications', method: RequestMethod.GET },
        { path: 'api/notifications/unread-count', method: RequestMethod.GET },
        { path: 'api/notifications/mark-all-read', method: RequestMethod.PATCH },
        { path: 'api/notifications/clear-read', method: RequestMethod.DELETE },
        { path: 'api/notifications/:id/mark-read', method: RequestMethod.PATCH },

        // ── Batch 5: LOA Management ───────────────────────────────────────────
        { path: 'api/approver-lines', method: RequestMethod.GET },
        { path: 'api/approver-lines/:userId', method: RequestMethod.GET },
        { path: 'api/approver-lines/:lineId/memo-types', method: RequestMethod.GET },
        { path: 'api/approver-lines/:id', method: RequestMethod.PUT },
        { path: 'api/approvers/replace', method: RequestMethod.POST },
        { path: 'api/approvers/bulk-update', method: RequestMethod.POST },
        { path: 'api/approvers/bulk-signature-update', method: RequestMethod.POST },
        { path: 'api/approvers/bulk-reorder', method: RequestMethod.POST },
        { path: 'api/approval-lines/:id/update-approvers', method: RequestMethod.POST },

        // ── Batch 5: MemoCc ───────────────────────────────────────────────────
        // NOTE: /api/memos/cc/me MUST be listed BEFORE /api/memos/:id/cc
        // to avoid :id matching "cc" as a parameter.
        { path: 'api/memos/cc/me', method: RequestMethod.GET },
        { path: 'api/memos/:id/cc', method: RequestMethod.GET },
        { path: 'api/memos/:id/cc', method: RequestMethod.PUT },
        { path: 'api/memos/:id/cc/:userId', method: RequestMethod.POST },
        { path: 'api/memos/:id/cc/:userId', method: RequestMethod.DELETE },

        // ── Batch 6a: Memo READ/query ─────────────────────────────────────────
        // NOTE: static paths (search, awaiting-approval, etc.) are listed in
        // the gateway here for completeness but Nest controller ordering is
        // the authoritative source of path-resolution priority.
        //
        // POST endpoints
        { path: 'api/memos/search', method: RequestMethod.POST },
        { path: 'api/memos/search/stats', method: RequestMethod.POST },
        { path: 'api/memos/users-delegation-info', method: RequestMethod.POST },
        // GET static (must appear before /:id wildcards)
        { path: 'api/memos/awaiting-approval', method: RequestMethod.GET },
        { path: 'api/memos/current-approvers', method: RequestMethod.GET },
        { path: 'api/memos/search-for-reference', method: RequestMethod.GET },
        // GET /api/memos (list)
        { path: 'api/memos', method: RequestMethod.GET },
        // GET /api/memos/:id and sub-routes
        { path: 'api/memos/:id', method: RequestMethod.GET },
        { path: 'api/memos/:id/references', method: RequestMethod.GET },
        { path: 'api/memos/:id/references', method: RequestMethod.PUT },
        { path: 'api/memos/:id/reference-content/:referenceId', method: RequestMethod.GET },
      )
      .forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
