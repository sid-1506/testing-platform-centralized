import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import path from 'path';
import dotenv from 'dotenv';
import { createUser, findUserByEmail, findUserById } from './db';
import { logAuthEvent, maskEmail } from './logger';
import {
  COOKIE_OPTIONS,
  corsMiddleware,
  requireJwtSecret,
  validateRedirectUri,
} from './security';

// Load environment variables from apps/auth/.env if present
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = requireJwtSecret();

// Built-in middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Request Tracing & Correlation ID Middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const incomingReqId = req.headers['x-request-id'] as string;
  const requestId = incomingReqId || `req_${Date.now()}_auth_${Math.random().toString(36).substring(2, 6)}`;
  res.setHeader('x-request-id', requestId);
  (req as any).requestId = requestId;
  (req as any).startTime = process.hrtime();
  next();
});

// Strict CORS allowlist for approved frontend origins
app.use(corsMiddleware);

// Serve static HTML/CSS files from public/
const publicDir = path.resolve(__dirname, '../public');
app.use(express.static(publicDir));

// --- 1. Health Check Endpoint ---
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'auth-service',
    port: PORT,
    timestamp: new Date().toISOString()
  });
});

// Helper to calculate request duration in milliseconds
function getDuration(req: Request): number {
  if (!(req as any).startTime) return 0;
  const diff = process.hrtime((req as any).startTime);
  return Math.round((diff[0] * 1000 + diff[1] / 1e6) * 100) / 100;
}

// --- 2. Signup Endpoint ---
app.post('/api/auth/signup', async (req: Request, res: Response) => {
  const reqId = (req as any).requestId;
  try {
    const { email, password } = req.body;

    // Validate presence and format of required fields
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      logAuthEvent({
        event: 'SIGNUP_FAILED',
        request_id: reqId,
        status_code: 400,
        reason: 'Invalid email address',
        duration_ms: getDuration(req),
      });
      res.status(400).json({ error: 'A valid email address is required' });
      return;
    }

    if (!password || typeof password !== 'string' || password.length < 6) {
      logAuthEvent({
        event: 'SIGNUP_FAILED',
        request_id: reqId,
        status_code: 400,
        reason: 'Password too short (< 6 chars)',
        email: maskEmail(email),
        duration_ms: getDuration(req),
      });
      res.status(400).json({ error: 'Password must be at least 6 characters long' });
      return;
    }

    // Normalize email to lowercase
    const normalizedEmail = email.trim().toLowerCase();

    // Check if user already exists
    const existing = findUserByEmail(normalizedEmail);
    if (existing) {
      logAuthEvent({
        event: 'SIGNUP_FAILED',
        request_id: reqId,
        status_code: 409,
        reason: 'Email is already registered',
        email: maskEmail(normalizedEmail),
        duration_ms: getDuration(req),
      });
      res.status(409).json({ error: 'Email is already registered' });
      return;
    }

    // Hash password with bcrypt (salt rounds = 10)
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Save user to auth.db
    const newUserId = createUser(normalizedEmail, passwordHash, 'user');

    const redirectCheck = validateRedirectUri(req.body?.redirect_uri ?? req.query?.redirect_uri);

    logAuthEvent({
      event: 'SIGNUP_SUCCESS',
      request_id: reqId,
      status_code: 201,
      user_id: newUserId,
      email: maskEmail(normalizedEmail),
      duration_ms: getDuration(req),
    });

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      redirectUrl: redirectCheck.url,
      loginUrl: `/login?redirect_uri=${encodeURIComponent(redirectCheck.url)}`,
      user: {
        id: newUserId,
        email: normalizedEmail,
        role: 'user'
      }
    });
  } catch (error: any) {
    console.error('Error during signup:', error);
    logAuthEvent({
      event: 'SIGNUP_ERROR',
      request_id: reqId,
      status_code: 500,
      error: error?.message || 'Internal server error',
      duration_ms: getDuration(req),
    });
    res.status(500).json({ error: 'Internal server error during signup' });
  }
});

// --- 3. Login Endpoint ---
app.post('/api/auth/login', async (req: Request, res: Response) => {
  const reqId = (req as any).requestId;
  try {
    const { email, password } = req.body;

    // Validate presence of required fields
    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      logAuthEvent({
        event: 'LOGIN_FAILED',
        request_id: reqId,
        status_code: 400,
        reason: 'Missing email or password',
        duration_ms: getDuration(req),
      });
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    // Normalize email for lookup
    const normalizedEmail = email.trim().toLowerCase();

    // Look up user by email
    const user = findUserByEmail(normalizedEmail);
    if (!user) {
      logAuthEvent({
        event: 'LOGIN_FAILED',
        request_id: reqId,
        status_code: 401,
        reason: 'User not found',
        email: maskEmail(normalizedEmail),
        duration_ms: getDuration(req),
      });
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    // Verify password against stored bcrypt hash
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      logAuthEvent({
        event: 'LOGIN_FAILED',
        request_id: reqId,
        status_code: 401,
        reason: 'Password mismatch',
        email: maskEmail(normalizedEmail),
        duration_ms: getDuration(req),
      });
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    // Generate JWT (valid for 1 hour)
    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        role: user.role
      },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    // Set token EXCLUSIVELY in an HttpOnly cookie
    res.cookie('token', token, {
      ...COOKIE_OPTIONS,
      maxAge: 60 * 60 * 1000 // 1 hour in milliseconds
    });

    const redirectCheck = validateRedirectUri(req.body?.redirect_uri ?? req.query?.redirect_uri);

    logAuthEvent({
      event: 'LOGIN_SUCCESS',
      request_id: reqId,
      status_code: 200,
      user_id: user.id,
      email: maskEmail(user.email),
      duration_ms: getDuration(req),
    });

    // SECURITY: The JWT is NEVER returned in the JSON response body.
    // It resides exclusively inside the HttpOnly cookie.
    res.json({
      success: true,
      message: 'Login successful',
      redirectUrl: redirectCheck.url,
      user: {
        id: user.id,
        email: user.email,
        role: user.role
      }
    });
  } catch (error: any) {
    console.error('Error during login:', error);
    logAuthEvent({
      event: 'LOGIN_ERROR',
      request_id: reqId,
      status_code: 500,
      error: error?.message || 'Internal server error',
      duration_ms: getDuration(req),
    });
    res.status(500).json({ error: 'Internal server error during login' });
  }
});

// --- 4. Logout Endpoint ---
app.post('/api/auth/logout', (req: Request, res: Response) => {
  const reqId = (req as any).requestId;
  res.clearCookie('token', COOKIE_OPTIONS);

  const rawRedirect = req.body?.redirect_uri ?? req.query?.redirect_uri;
  const redirectCheck = validateRedirectUri(rawRedirect);
  const redirectUrl = redirectCheck.valid
    ? `/login?redirect_uri=${encodeURIComponent(redirectCheck.url)}`
    : '/login';

  logAuthEvent({
    event: 'LOGOUT',
    request_id: reqId,
    status_code: 200,
    duration_ms: getDuration(req),
  });
  res.json({
    success: true,
    message: 'Logged out successfully',
    redirectUrl: `http://localhost:${PORT}${redirectUrl}`,
  });
});

// --- 5. JWT Verify Endpoint ---
app.get('/api/auth/verify', (req: Request, res: Response) => {
  const reqId = (req as any).requestId;
  // Check cookie first, then fallback to Authorization: Bearer <token>
  let token = req.cookies?.token;
  if (!token && req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      token = parts[1];
    }
  }

  if (!token) {
    logAuthEvent({
      event: 'VERIFY_FAILED',
      request_id: reqId,
      status_code: 401,
      reason: 'No token provided',
      duration_ms: getDuration(req),
    });
    res.status(401).json({ authenticated: false, error: 'No token provided' });
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    logAuthEvent({
      event: 'VERIFY_SUCCESS',
      request_id: reqId,
      status_code: 200,
      user_id: decoded.userId,
      email: maskEmail(decoded.email),
      duration_ms: getDuration(req),
    });
    res.json({
      authenticated: true,
      user: decoded
    });
  } catch (err: any) {
    logAuthEvent({
      event: 'VERIFY_FAILED',
      request_id: reqId,
      status_code: 401,
      reason: 'Invalid or expired token',
      duration_ms: getDuration(req),
    });
    res.status(401).json({ authenticated: false, error: 'Invalid or expired token' });
  }
});

// --- 6. HTML Page Navigation ---
app.get('/login', (_req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, 'login.html'));
});

app.get('/signup', (_req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, 'signup.html'));
});

app.get('/', (_req: Request, res: Response) => {
  res.redirect('/login');
});

// Start the server
export const server = app.listen(PORT, () => {
  console.log(`[AUTH SERVICE] Running independently on http://localhost:${PORT}`);
  console.log(`[AUTH SERVICE] Login UI available at http://localhost:${PORT}/login`);
  console.log(`[AUTH SERVICE] Signup UI available at http://localhost:${PORT}/signup`);
});

export default app;
