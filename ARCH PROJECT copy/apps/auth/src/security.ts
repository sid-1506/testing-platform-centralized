import { Request, Response, NextFunction } from 'express';
import { logAuthEvent } from './logger';

export const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3003',
  'http://localhost:3004',
];

export const DEFAULT_REDIRECT_URI = 'http://localhost:3000';

export const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: false, // Local HTTP development on localhost
  sameSite: 'lax' as const,
  path: '/',
};

/**
 * Resolves the explicit CORS / redirect origin allowlist from env or defaults.
 */
export function getAllowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw || raw.trim() === '') {
    return DEFAULT_ALLOWED_ORIGINS;
  }
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * Loads and validates JWT_SECRET. Fails fast if missing or placeholder.
 */
export function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret || secret === 'generate_with_openssl_rand_hex_32') {
    console.error(
      '[AUTH SERVICE FATAL] Missing or unconfigured JWT_SECRET environment variable. ' +
        'Set a shared secret in apps/auth/.env before starting the Auth Service.'
    );
    process.exit(1);
  }
  return secret;
}

/**
 * Validates redirect_uri against the explicit origin allowlist to prevent open redirects.
 * Returns the validated URL string, or fallback when missing/invalid.
 */
export function validateRedirectUri(
  rawUri: unknown,
  fallback: string = DEFAULT_REDIRECT_URI
): { valid: boolean; url: string } {
  if (typeof rawUri !== 'string' || rawUri.trim() === '') {
    return { valid: false, url: fallback };
  }

  try {
    const parsed = new URL(rawUri.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, url: fallback };
    }
    if (parsed.username || parsed.password) {
      return { valid: false, url: fallback };
    }
    const allowedOrigins = getAllowedOrigins();
    if (!allowedOrigins.includes(parsed.origin)) {
      return { valid: false, url: fallback };
    }
    return { valid: true, url: parsed.toString() };
  } catch {
    return { valid: false, url: fallback };
  }
}

/**
 * Strict CORS middleware for approved localhost frontend origins.
 * Never uses wildcard '*' when credentials are enabled.
 */
export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (!origin) {
    next();
    return;
  }

  const host = req.get('host');
  const selfOrigin = host ? `${req.protocol}://${host}` : null;
  if (selfOrigin && origin === selfOrigin) {
    next();
    return;
  }

  const allowedOrigins = getAllowedOrigins();
  if (!allowedOrigins.includes(origin)) {
    logAuthEvent({
      event: 'CORS_REJECTED',
      request_id: (req as any).requestId,
      status_code: 403,
      origin,
      method: req.method,
      route: req.originalUrl,
    });
    res.status(403).json({ error: 'CORS origin not allowed' });
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-request-id');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
}
