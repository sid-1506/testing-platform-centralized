import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { getUserPreferences, saveUserPreferences } from '@/lib/db';
import { logWebEvent } from '@/lib/logger';

export async function GET(req: Request) {
  const startTime = Date.now();
  const requestId = req.headers.get('x-request-id') || `req_${Date.now()}_pref_${Math.random().toString(36).substring(2, 6)}`;
  const session = await getSessionUser();

  if (!session.authenticated || !session.user) {
    logWebEvent({
      event: 'PREFERENCES_UNAUTHORIZED',
      request_id: requestId,
      route: '/api/preferences',
      method: 'GET',
      status_code: 401,
      duration_ms: Date.now() - startTime,
    });
    return NextResponse.json(
      { error: 'Unauthorized. Please login at the Auth service (:3001).' },
      { status: 401 }
    );
  }

  const prefs = getUserPreferences(session.user.userId) || {
    user_id: session.user.userId,
    theme: 'light',
    notes: '',
    updated_at: new Date().toISOString(),
  };

  logWebEvent({
    event: 'PREFERENCES_FETCHED',
    request_id: requestId,
    route: '/api/preferences',
    method: 'GET',
    user_id: session.user.userId,
    status_code: 200,
    duration_ms: Date.now() - startTime,
  });

  return NextResponse.json({
    success: true,
    user: session.user,
    preferences: prefs,
  });
}

export async function POST(req: Request) {
  const startTime = Date.now();
  const requestId = req.headers.get('x-request-id') || `req_${Date.now()}_pref_${Math.random().toString(36).substring(2, 6)}`;
  const session = await getSessionUser();

  if (!session.authenticated || !session.user) {
    logWebEvent({
      event: 'PREFERENCES_UNAUTHORIZED',
      request_id: requestId,
      route: '/api/preferences',
      method: 'POST',
      status_code: 401,
      duration_ms: Date.now() - startTime,
    });
    return NextResponse.json(
      { error: 'Unauthorized. Please login at the Auth service (:3001).' },
      { status: 401 }
    );
  }

  try {
    const body = await req.json();
    const theme = typeof body.theme === 'string' ? body.theme : 'light';
    const notes = typeof body.notes === 'string' ? body.notes : '';

    saveUserPreferences(session.user.userId, theme, notes);

    const updated = getUserPreferences(session.user.userId);

    logWebEvent({
      event: 'PREFERENCES_SAVED',
      request_id: requestId,
      route: '/api/preferences',
      method: 'POST',
      user_id: session.user.userId,
      status_code: 200,
      theme,
      duration_ms: Date.now() - startTime,
    });

    return NextResponse.json({
      success: true,
      message: 'Preferences saved to next_app.db',
      preferences: updated,
    });
  } catch (err: any) {
    logWebEvent({
      event: 'PREFERENCES_ERROR',
      request_id: requestId,
      route: '/api/preferences',
      method: 'POST',
      status_code: 400,
      error: err?.message || 'Invalid request payload',
      duration_ms: Date.now() - startTime,
    });
    return NextResponse.json(
      { error: 'Invalid request payload' },
      { status: 400 }
    );
  }
}
