import { cookies } from 'next/headers';
import jwt from 'jsonwebtoken';

export interface AuthUser {
  userId: number;
  email: string;
  role: string;
}

export interface AuthResult {
  authenticated: boolean;
  user?: AuthUser;
  error?: string;
}

import path from 'path';
import fs from 'fs';

function getJwtSecret(): string {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.trim() !== '') {
    return process.env.JWT_SECRET.trim();
  }
  try {
    const cwd = process.cwd();
    const envPath = path.resolve(cwd.endsWith('web') ? cwd : path.resolve(cwd, 'apps/web'), '.env.local');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const match = content.match(/^JWT_SECRET=(.*)$/m);
      if (match && match[1] && match[1].trim() !== '') {
        return match[1].trim();
      }
    }
  } catch (e) {}
  throw new Error(
    '[WEB AUTH CONFIG ERROR] Missing required JWT_SECRET environment variable. Set JWT_SECRET in apps/web/.env.local.'
  );
}

/**
 * Verifies user session from the HttpOnly cookie.
 * 
 * IMPORTANT ARCHITECTURAL RULE:
 * This function performs STATELESS verification in memory.
 * It NEVER connects to or queries auth.db.
 */
export async function getSessionUser(): Promise<AuthResult> {
  const cookieStore = await cookies();
  const token = cookieStore.get('token')?.value;

  let secret: string;
  try {
    secret = getJwtSecret();
  } catch (err: any) {
    console.error(err.message);
    return { authenticated: false, error: 'Authentication service configuration error' };
  }

  if (!token) {
    return { authenticated: false, error: 'No authentication token found in cookies' };
  }

  try {
    const decoded = jwt.verify(token, secret) as unknown as AuthUser;
    return {
      authenticated: true,
      user: {
        userId: decoded.userId,
        email: decoded.email,
        role: decoded.role,
      },
    };
  } catch (err) {
    return { authenticated: false, error: 'Invalid or expired authentication token' };
  }
}
