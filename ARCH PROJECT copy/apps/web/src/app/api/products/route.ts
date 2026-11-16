import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { logWebEvent } from '@/lib/logger';

const GATEWAY_URL = process.env.API_GATEWAY_URL || 'http://localhost:5001';

export async function GET(req: Request) {
  const startTime = Date.now();
  const incomingReqId = req.headers.get('x-request-id');
  const requestId = incomingReqId || `req_${Date.now()}_next_${Math.random().toString(36).substring(2, 6)}`;

  // Ensure user is authenticated
  const session = await getSessionUser();
  if (!session.authenticated) {
    logWebEvent({
      event: 'AUTH_UNAUTHORIZED',
      request_id: requestId,
      route: '/api/products',
      method: 'GET',
      status_code: 401,
      duration_ms: Date.now() - startTime,
    });
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Next.js Server calls API Gateway (:5001)
    const gatewayRes = await fetch(`${GATEWAY_URL}/api/v1/products`, {
      headers: {
        'x-request-id': requestId,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    });

    const data = await gatewayRes.json();
    const handledBy = gatewayRes.headers.get('x-handled-by') || data.instanceId || 'unknown';
    const responseReqId = gatewayRes.headers.get('x-request-id') || requestId;

    logWebEvent({
      event: gatewayRes.ok ? 'PRODUCTS_LISTED' : 'REQUEST_FAILED',
      request_id: responseReqId,
      user_id: session.user?.userId,
      route: '/api/products',
      method: 'GET',
      status_code: gatewayRes.status,
      handled_by: handledBy,
      count: Array.isArray(data.data) ? data.data.length : 0,
      duration_ms: Date.now() - startTime,
    });

    return NextResponse.json(
      {
        success: gatewayRes.ok,
        status: gatewayRes.status,
        handledBy,
        requestId: responseReqId,
        products: data.data || [],
        error: data.error,
        message: data.message,
      },
      {
        status: gatewayRes.status,
        headers: { 'x-request-id': responseReqId },
      }
    );
  } catch (err: any) {
    logWebEvent({
      event: 'REQUEST_FAILED',
      request_id: requestId,
      user_id: session.user?.userId,
      route: '/api/products',
      method: 'GET',
      status_code: 502,
      error: err.message,
      duration_ms: Date.now() - startTime,
    });
    return NextResponse.json(
      {
        success: false,
        error: 'Gateway Connection Error',
        message: `Could not reach API Gateway at ${GATEWAY_URL}: ${err.message}`,
        requestId,
      },
      {
        status: 502,
        headers: { 'x-request-id': requestId },
      }
    );
  }
}
