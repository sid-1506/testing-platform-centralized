import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { logNotesEvent } from './logger';

export interface AuthUser {
  userId: number;
  email: string;
  role: string;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
  requestId?: string;
  startTime?: [number, number];
}

export function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret || secret === 'must_match_the_secret_generated_for_apps_auth') {
    console.error(
      '[NOTES APP FATAL] Missing or unconfigured JWT_SECRET environment variable. ' +
      'Set JWT_SECRET in apps/notes/.env matching apps/auth/.env.'
    );
    process.exit(1);
  }
  return secret;
}

export function getDuration(req: AuthenticatedRequest): number {
  if (!req.startTime) return 0;
  const diff = process.hrtime(req.startTime);
  return Math.round((diff[0] * 1000 + diff[1] / 1e6) * 100) / 100;
}

function verifyTokenFromCookie(req: Request, jwtSecret: string): AuthUser | null {
  const token = req.cookies?.token;
  if (!token || typeof token !== 'string') {
    return null;
  }
  try {
    const decoded = jwt.verify(token, jwtSecret) as unknown as AuthUser;
    if (!decoded || typeof decoded.userId !== 'number') {
      return null;
    }
    return {
      userId: decoded.userId,
      email: decoded.email,
      role: decoded.role,
    };
  } catch {
    return null;
  }
}

/**
 * Protects browser page routes by redirecting unauthenticated users to Central Auth.
 */
export function createRequireAuthPage(jwtSecret: string, authAppUrl: string, appOrigin: string) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const user = verifyTokenFromCookie(req, jwtSecret);
    if (!user) {
      logNotesEvent({
        event: 'AUTH_UNAUTHORIZED',
        request_id: req.requestId,
        route: req.originalUrl,
        method: req.method,
        status_code: 302,
        duration_ms: getDuration(req),
      });
      const loginUrl = `${authAppUrl}/login?redirect_uri=${encodeURIComponent(appOrigin)}`;
      res.redirect(302, loginUrl);
      return;
    }
    req.user = user;
    next();
  };
}

/**
 * Protects JSON API routes with stateless JWT verification (401 on missing/invalid token).
 */
export function createRequireAuthApi(jwtSecret: string) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const user = verifyTokenFromCookie(req, jwtSecret);
    if (!user) {
      logNotesEvent({
        event: 'AUTH_UNAUTHORIZED',
        request_id: req.requestId,
        route: req.originalUrl,
        method: req.method,
        status_code: 401,
        duration_ms: getDuration(req),
      });
      res.status(401).json({ error: 'Unauthorized. Please log in via Central Auth.' });
      return;
    }
    req.user = user;
    next();
  };
}

/**
 * Protects state-changing API requests (POST, PUT, DELETE) against cross-origin CSRF.
 */
export function createSameOriginGuard(allowedOrigin: string) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    const referer = req.headers.referer;

    if (origin && origin !== allowedOrigin) {
      logNotesEvent({
        event: 'REQUEST_FAILED',
        request_id: req.requestId,
        user_id: req.user?.userId,
        route: req.originalUrl,
        method: req.method,
        status_code: 403,
        reason: 'Cross-origin mutation blocked',
        duration_ms: getDuration(req),
      });
      res.status(403).json({ error: 'Forbidden: Cross-origin request blocked' });
      return;
    }

    if (!origin && referer) {
      try {
        const refOrigin = new URL(referer).origin;
        if (refOrigin !== allowedOrigin) {
          logNotesEvent({
            event: 'REQUEST_FAILED',
            request_id: req.requestId,
            user_id: req.user?.userId,
            route: req.originalUrl,
            method: req.method,
            status_code: 403,
            reason: 'Cross-origin referer blocked',
            duration_ms: getDuration(req),
          });
          res.status(403).json({ error: 'Forbidden: Cross-origin referer blocked' });
          return;
        }
      } catch {
        res.status(403).json({ error: 'Forbidden: Invalid referer' });
        return;
      }
    }

    next();
  };
}
