import { Request } from 'express';

/** Express 5 types route params as string | string[]; named params are always single strings. */
export function param(req: Request, name: string): string {
  const v = req.params[name] as string | string[] | undefined;
  return Array.isArray(v) ? v.join('/') : String(v ?? '');
}
