import { NextFunction, Request, Response } from 'express';
import { ALLOWED_HOSTS, ALLOWED_UI_ORIGINS } from '../config';

/**
 * The API controls code execution on the local machine, so it must only be
 * reachable by the dashboard UI:
 *  - Host allow-list stops DNS-rebinding (a web page resolving evil.com -> 127.0.0.1).
 *  - State-changing requests must come from the dashboard origin or carry no Origin
 *    (curl); this also stops a served test report (same origin as the API) from
 *    calling mutating endpoints.
 */
export function hostGuard(req: Request, res: Response, next: NextFunction): void {
  const host = (req.headers.host || '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    res.status(403).json({ error: 'Forbidden host' });
    return;
  }
  next();
}

export function originGuard(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }
  const origin = req.headers.origin;
  if (origin && !ALLOWED_UI_ORIGINS.includes(origin)) {
    res.status(403).json({ error: 'Forbidden origin' });
    return;
  }
  next();
}
