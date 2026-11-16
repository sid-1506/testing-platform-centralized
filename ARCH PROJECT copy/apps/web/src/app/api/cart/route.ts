import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import {
  addOrIncrementCartItem,
  clearUserCart,
  getCartItems,
} from '@/lib/db';
import { logWebEvent } from '@/lib/logger';

const GATEWAY_URL = process.env.API_GATEWAY_URL || 'http://localhost:5001';
const ALLOWED_ORIGIN = 'http://localhost:3000';

function getRequestId(req: Request): string {
  return (
    req.headers.get('x-request-id') ||
    `req_${Date.now()}_cart_${Math.random().toString(36).substring(2, 6)}`
  );
}

function isCrossOriginMutation(req: Request): boolean {
  const origin = req.headers.get('origin');
  return Boolean(origin && origin !== ALLOWED_ORIGIN);
}

function summarizeCart(items: ReturnType<typeof getCartItems>) {
  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);
  const totalAmount = Math.round(
    items.reduce((sum, item) => sum + item.unit_price * item.quantity, 0) * 100
  ) / 100;
  return { items, itemCount, totalAmount };
}

export async function GET(req: Request) {
  const startTime = Date.now();
  const requestId = getRequestId(req);
  const session = await getSessionUser();

  if (!session.authenticated || !session.user) {
    logWebEvent({
      event: 'AUTH_UNAUTHORIZED',
      request_id: requestId,
      route: '/api/cart',
      method: 'GET',
      status_code: 401,
      duration_ms: Date.now() - startTime,
    });
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'x-request-id': requestId } }
    );
  }

  const items = getCartItems(session.user.userId);
  const summary = summarizeCart(items);

  logWebEvent({
    event: 'CART_VIEWED',
    request_id: requestId,
    user_id: session.user.userId,
    route: '/api/cart',
    method: 'GET',
    status_code: 200,
    item_count: summary.itemCount,
    duration_ms: Date.now() - startTime,
  });

  return NextResponse.json(
    { success: true, requestId, ...summary },
    { headers: { 'x-request-id': requestId } }
  );
}

export async function POST(req: Request) {
  const startTime = Date.now();
  const requestId = getRequestId(req);
  const session = await getSessionUser();

  if (!session.authenticated || !session.user) {
    logWebEvent({
      event: 'AUTH_UNAUTHORIZED',
      request_id: requestId,
      route: '/api/cart',
      method: 'POST',
      status_code: 401,
      duration_ms: Date.now() - startTime,
    });
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'x-request-id': requestId } }
    );
  }

  if (isCrossOriginMutation(req)) {
    logWebEvent({
      event: 'REQUEST_FAILED',
      request_id: requestId,
      user_id: session.user.userId,
      route: '/api/cart',
      method: 'POST',
      status_code: 403,
      reason: 'Cross-origin mutation blocked',
      duration_ms: Date.now() - startTime,
    });
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const body = await req.json();
    const productId = Number(body?.product_id);
    const quantity = body?.quantity === undefined ? 1 : Number(body.quantity);

    if (!Number.isInteger(productId) || productId <= 0) {
      logWebEvent({
        event: 'REQUEST_FAILED',
        request_id: requestId,
        user_id: session.user.userId,
        route: '/api/cart',
        method: 'POST',
        status_code: 400,
        reason: 'Invalid product_id',
        duration_ms: Date.now() - startTime,
      });
      return NextResponse.json({ error: 'Valid product_id is required' }, { status: 400 });
    }

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      logWebEvent({
        event: 'REQUEST_FAILED',
        request_id: requestId,
        user_id: session.user.userId,
        route: '/api/cart',
        method: 'POST',
        status_code: 400,
        reason: 'Invalid quantity',
        duration_ms: Date.now() - startTime,
      });
      return NextResponse.json(
        { error: 'Quantity must be an integer between 1 and 99' },
        { status: 400 }
      );
    }

    // Validate product against authoritative catalog via API Gateway
    const gwRes = await fetch(`${GATEWAY_URL}/api/v1/products`, {
      headers: { 'x-request-id': requestId, 'Content-Type': 'application/json' },
      cache: 'no-store',
    });

    if (!gwRes.ok) {
      logWebEvent({
        event: 'REQUEST_FAILED',
        request_id: requestId,
        user_id: session.user.userId,
        route: '/api/cart',
        method: 'POST',
        status_code: 502,
        reason: 'Gateway product lookup failed',
        duration_ms: Date.now() - startTime,
      });
      return NextResponse.json(
        { error: 'Could not verify product with Gateway' },
        { status: 502, headers: { 'x-request-id': requestId } }
      );
    }

    const gwData = await gwRes.json();
    const products = Array.isArray(gwData.data) ? gwData.data : [];
    const product = products.find((p: any) => Number(p.id) === productId);

    if (!product) {
      logWebEvent({
        event: 'REQUEST_FAILED',
        request_id: requestId,
        user_id: session.user.userId,
        route: '/api/cart',
        method: 'POST',
        status_code: 404,
        reason: 'Product not found',
        duration_ms: Date.now() - startTime,
      });
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

    const item = addOrIncrementCartItem(
      session.user.userId,
      product.id,
      String(product.name),
      Number(product.price),
      quantity
    );

    const summary = summarizeCart(getCartItems(session.user.userId));

    logWebEvent({
      event: 'CART_ITEM_ADDED',
      request_id: requestId,
      user_id: session.user.userId,
      product_id: product.id,
      quantity,
      route: '/api/cart',
      method: 'POST',
      status_code: 201,
      duration_ms: Date.now() - startTime,
    });

    return NextResponse.json(
      { success: true, requestId, item, ...summary },
      { status: 201, headers: { 'x-request-id': requestId } }
    );
  } catch (err: any) {
    logWebEvent({
      event: 'REQUEST_FAILED',
      request_id: requestId,
      user_id: session.user.userId,
      route: '/api/cart',
      method: 'POST',
      status_code: 400,
      error: err?.message || 'Invalid request',
      duration_ms: Date.now() - startTime,
    });
    return NextResponse.json({ error: 'Invalid request payload' }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const startTime = Date.now();
  const requestId = getRequestId(req);
  const session = await getSessionUser();

  if (!session.authenticated || !session.user) {
    logWebEvent({
      event: 'AUTH_UNAUTHORIZED',
      request_id: requestId,
      route: '/api/cart',
      method: 'DELETE',
      status_code: 401,
      duration_ms: Date.now() - startTime,
    });
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'x-request-id': requestId } }
    );
  }

  if (isCrossOriginMutation(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const url = new URL(req.url);
  const isCheckout = url.searchParams.get('action') === 'checkout';
  const removedCount = clearUserCart(session.user.userId);

  logWebEvent({
    event: isCheckout ? 'CART_CHECKOUT' : 'CART_CLEARED',
    request_id: requestId,
    user_id: session.user.userId,
    route: '/api/cart',
    method: 'DELETE',
    status_code: 200,
    removed_count: removedCount,
    duration_ms: Date.now() - startTime,
  });

  return NextResponse.json(
    {
      success: true,
      requestId,
      message: isCheckout ? 'Order placed! Thank you for shopping.' : 'Cart cleared',
      items: [],
      itemCount: 0,
      totalAmount: 0,
    },
    { headers: { 'x-request-id': requestId } }
  );
}
