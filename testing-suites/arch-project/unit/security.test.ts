import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the logger inside the target app to avoid any filesystem log side effects during unit tests
vi.mock('@target/apps/auth/src/logger', () => ({
  logAuthEvent: vi.fn(),
  maskEmail: (e: string) => e,
}));

import {
  COOKIE_OPTIONS,
  DEFAULT_ALLOWED_ORIGINS,
  DEFAULT_REDIRECT_URI,
  getAllowedOrigins,
  validateRedirectUri,
} from '@target/apps/auth/src/security';

describe('Auth Security Helpers (apps/auth/src/security.ts)', () => {
  const originalEnv = process.env.ALLOWED_ORIGINS;

  beforeEach(() => {
    delete process.env.ALLOWED_ORIGINS;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ALLOWED_ORIGINS;
    } else {
      process.env.ALLOWED_ORIGINS = originalEnv;
    }
  });

  it('uses HttpOnly and SameSite=lax cookie options', () => {
    expect(COOKIE_OPTIONS.httpOnly).toBe(true);
    expect(COOKIE_OPTIONS.sameSite).toBe('lax');
    expect(COOKIE_OPTIONS.path).toBe('/');
  });

  it('returns default allowed origins when ALLOWED_ORIGINS is unset', () => {
    expect(getAllowedOrigins()).toEqual(DEFAULT_ALLOWED_ORIGINS);
  });

  it('parses comma-separated ALLOWED_ORIGINS from environment', () => {
    process.env.ALLOWED_ORIGINS = 'http://localhost:3000, http://localhost:4000';
    expect(getAllowedOrigins()).toEqual(['http://localhost:3000', 'http://localhost:4000']);
  });

  it('accepts valid allowlisted redirect_uri values', () => {
    const res = validateRedirectUri('http://localhost:3003/notes?tab=all');
    expect(res.valid).toBe(true);
    expect(res.url).toBe('http://localhost:3003/notes?tab=all');
  });

  it('rejects open-redirect attempts to untrusted origins', () => {
    const res = validateRedirectUri('https://evil.example.com/phish');
    expect(res.valid).toBe(false);
    expect(res.url).toBe(DEFAULT_REDIRECT_URI);
  });

  it('rejects javascript: protocol and credential-bearing URLs', () => {
    expect(validateRedirectUri('javascript:alert(1)').valid).toBe(false);
    expect(validateRedirectUri('http://user:pass@localhost:3000/').valid).toBe(false);
  });
});
