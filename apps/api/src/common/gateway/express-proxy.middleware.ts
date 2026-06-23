import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware, Options } from 'http-proxy-middleware';
import type { RequestHandler } from 'express';

/**
 * Proxy middleware that forwards un-migrated requests to the legacy
 * Express backend.
 *
 * Security design (คุณอิเอริ):
 * - Authorization header and refreshToken cookie pass through verbatim
 *   so Express `authenticate` middleware can re-validate each request.
 * - changeOrigin: true avoids host mismatch rejections on the target.
 * - xfwd: true propagates X-Forwarded-For so Express can log real IPs
 *   (Express already has `app.set("trust proxy", true)`).
 * - Set-Cookie response headers from Express pass through unchanged so
 *   refresh-token rotation works end-to-end.
 * - No response headers are added or stripped by this proxy layer.
 *
 * Target URL is read from EXPRESS_TARGET env var; defaults to
 * http://localhost:3000 for local development.
 */
@Injectable()
export class ExpressProxyMiddleware implements NestMiddleware {
  private readonly logger = new Logger(ExpressProxyMiddleware.name);
  private readonly proxy: RequestHandler;

  constructor() {
    const target =
      process.env['EXPRESS_TARGET'] ?? 'http://localhost:3000';

    this.logger.log(`Express proxy target: ${target}`);

    const options: Options = {
      target,
      changeOrigin: true,
      xfwd: true,
      logLevel: 'silent',
      onError: (err: Error, _req, res) => {
        this.logger.error(`Proxy error: ${err.message}`);
        const expressRes = res as unknown as Response;
        if (!expressRes.headersSent) {
          expressRes.status(502).json({
            error: 'GATEWAY_ERROR',
            message: 'Upstream Express service unavailable',
          });
        }
      },
    };

    this.proxy = createProxyMiddleware(options);
  }

  use(req: Request, res: Response, next: NextFunction): void {
    this.proxy(req, res, next);
  }
}
