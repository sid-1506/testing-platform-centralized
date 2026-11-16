import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { logHybridBackendEvent } from './logger';

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
      '[HYBRID BACKEND FATAL] Missing or unconfigured JWT_SECRET environment variable.'
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

/**
 * Strict CORS middleware allowing only the Hybrid Next.js frontend (:3004) with credentials.
 */
export function createCorsMiddleware(allowedOrigin: string) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (!origin) {
      next();
      return;
    }

    if (origin !== allowedOrigin) {
      logHybridBackendEvent({
        event: 'REQUEST_FAILED',
        request_id: req.requestId,
        route: req.originalUrl,
        method: req.method,
        status_code: 403,
        reason: 'CORS origin not allowed',
        origin,
        duration_ms: getDuration(req),
      });
      res.status(403).json({ error: 'CORS origin not allowed' });
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-request-id');
    res.setHeader('Access-Control-Expose-Headers', 'x-request-id');
    res.setHeader('Vary', 'Origin');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  };
}

/**
 * Stateless JWT verification middleware reading the shared HttpOnly `token` cookie.
 */
export function createRequireAuthApi(jwtSecret: string) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const token = req.cookies?.token;
    if (!token || typeof token !== 'string') {
      logHybridBackendEvent({
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

    try {
      const decoded = jwt.verify(token, jwtSecret) as unknown as AuthUser;
      if (!decoded || typeof decoded.userId !== 'number') {
        throw new Error('Invalid token payload');
      }
      req.user = {
        userId: decoded.userId,
        email: decoded.email,
        role: decoded.role,
      };
      next();
    } catch {
      logHybridBackendEvent({
        event: 'AUTH_UNAUTHORIZED',
        request_id: req.requestId,
        route: req.originalUrl,
        method: req.method,
        status_code: 401,
        duration_ms: getDuration(req),
      });
      res.status(401).json({ error: 'Invalid or expired authentication token' });
    }
  };
}

/**
 * CSRF protection for state-changing requests (POST, PUT, PATCH, DELETE).
 */
export function createOriginGuard(allowedOrigin: string) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    const referer = req.headers.referer;

    if (origin && origin !== allowedOrigin) {
      logHybridBackendEvent({
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
