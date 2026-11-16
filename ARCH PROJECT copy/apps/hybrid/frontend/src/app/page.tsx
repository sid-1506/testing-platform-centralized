import React from 'react';
import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth';
import { logHybridFrontendEvent } from '@/lib/logger';
import TaskManager from '@/components/TaskManager';

export const dynamic = 'force-dynamic';

export default async function HybridHomePage() {
  const session = await getSessionUser();
  const authUrl = process.env.NEXT_PUBLIC_AUTH_URL || 'http://localhost:3001';
  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3005';

  if (!session.authenticated || !session.user) {
    logHybridFrontendEvent({
      event: 'AUTH_UNAUTHORIZED',
      route: '/',
      method: 'GET',
      status_code: 307,
    });
    redirect(`${authUrl}/login?redirect_uri=http%3A%2F%2Flocalhost%3A3004`);
  }

  logHybridFrontendEvent({
    event: 'APP_ACCESS',
    user_id: session.user.userId,
    route: '/',
    method: 'GET',
    status_code: 200,
  });

  return (
    <TaskManager
      userEmail={session.user.email}
      userId={session.user.userId}
      backendUrl={backendUrl}
      authUrl={authUrl}
    />
  );
}
