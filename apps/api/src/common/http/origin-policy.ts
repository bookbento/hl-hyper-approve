/**
 * Origin policy for /api — ported from backend/src/app.ts (incl. 0dc6d6f).
 *
 * 1. Production no-origin filter: an /api request with no Origin header is
 *    rejected (403 CORS_NOT_ALLOWED) unless the browser marks it same-origin /
 *    same-site, its Referer is an allowed origin, or it is a public endpoint
 *    (/api/health, the one-click email link).
 * 2. CORS allow-list with credentials: a request from an Origin that is not in
 *    the list gets 403 CORS_NOT_ALLOWED. The email link skips CORS entirely.
 *
 * Allowed origins: CORS_ORIGIN, FRONTEND_URL, APP_BASE_URL, FRONT_BASE_URL
 * (comma-separated), the production host, and localhost:5173/3001 outside production.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import * as cors from 'cors';

const CORS_ERROR_MESSAGE = 'Not allowed by CORS';
const PRODUCTION_ORIGIN = 'https://e-approval.hylifeconnect.com';

export function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin.trim().replace(/\/$/, '');
  }
}

function readOrigins(value?: string): string[] {
  return (value ?? '')
    .split(',')
    .map((o) => o.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
    .map(normalizeOrigin);
}

export function allowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const isProduction = env['NODE_ENV'] === 'production';
  return Array.from(
    new Set(
      [
        ...readOrigins(env['CORS_ORIGIN']),
        ...readOrigins(env['FRONTEND_URL']),
        ...readOrigins(env['APP_BASE_URL']),
        ...readOrigins(env['FRONT_BASE_URL']),
        PRODUCTION_ORIGIN,
        ...(!isProduction ? ['http://localhost:5173', 'http://localhost:3001'] : []),
      ].map(normalizeOrigin),
    ),
  );
}

const isApiRequest = (req: Request) => req.path === '/api' || req.path.startsWith('/api/');
const isEmailActionRequest = (req: Request) =>
  req.method === 'GET' && req.path === '/api/memos/action/email';
const isPublicNoOriginRequest = (req: Request) =>
  req.path === '/api/health' || isEmailActionRequest(req);

function rejectCors(res: Response): void {
  res.status(403).json({ message: CORS_ERROR_MESSAGE, error: 'CORS_NOT_ALLOWED' });
}

/** Middlewares to mount (in order) before Nest's routes. */
export function originPolicy(env: NodeJS.ProcessEnv = process.env): RequestHandler[] {
  const isProduction = env['NODE_ENV'] === 'production';
  const allowed = allowedOrigins(env);

  const isTrustedBrowserNoOrigin = (req: Request) => {
    const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (fetchSite === 'same-origin' || fetchSite === 'same-site') return true;
    const referer = req.get('referer');
    return Boolean(referer && allowed.includes(normalizeOrigin(referer)));
  };

  const noOriginFilter: RequestHandler = (req, res, next) => {
    if (
      !isProduction ||
      !isApiRequest(req) ||
      req.get('origin') ||
      isPublicNoOriginRequest(req) ||
      isTrustedBrowserNoOrigin(req)
    ) {
      return next();
    }
    rejectCors(res);
  };

  const corsHandler = cors({
    // No Origin → allowed here; production no-origin requests were filtered above.
    origin: (origin, cb) => cb(null, !origin || allowed.includes(normalizeOrigin(origin))),
    credentials: true,
  });

  const corsWithReject: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    if (isEmailActionRequest(req)) return next();
    const origin = req.get('origin');
    if (origin && !allowed.includes(normalizeOrigin(origin))) return rejectCors(res);
    return corsHandler(req, res, next);
  };

  return [noOriginFilter, corsWithReject];
}
