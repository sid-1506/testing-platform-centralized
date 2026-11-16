import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import {
  getCartItems,
  removeCartItem,
  updateCartItemQuantity,
} from '@/lib/db';
import { logWebEvent } from '@/lib/logger';

const ALLOWED_ORIGIN = 'http://localhost:3000';

function getRequestId(req: Request): string {
  return (
    req.headers.get('x-request-id') ||
    `req_${Date.now()}_cart_${Math.random().toString(36).substring(2, 6)}`
  );
}

function summarizeCart(items: ReturnType<typeof getCartItems>) {
  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);
  const totalAmount = Math.round(
    items.reduce((sum, item) => sum + item.unit_price * item.quantity, 0) * 100
  ) / 100;
  return { items, itemCount, totalAmount };
}

export async function PUT(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const startTime = Date.now();
  const requestId = getRequestId(req);
  const session = await getSessionUser();
  const { id: rawId } = await context.params;
  const itemId = Number(rawId);

  if (!session.authenticated || !session.user) {
    logWebEvent({
      event: 'AUTH_UNAUTHORIZED',
      request_id: requestId,
      route: `/api/cart/${rawId}`,
      method: 'PUT',
      status_code: 401,
      duration_ms: Date.now() - startTime,
    });
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const origin = req.headers.get('origin');
  if (origin && origin !== ALLOWED_ORIGIN) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (!Number.isInteger(itemId) || itemId <= 0) {
    logWebEvent({
      event: 'REQUEST_FAILED',
      request_id: requestId,
      user_id: session.user.userId,
      route: `/api/cart/${rawId}`,
      method: 'PUT',
      status_code: 400,
      reason: 'Invalid cart item ID',
      duration_ms: Date.now() - startTime,
    });
    return NextResponse.json({ error: 'Invalid cart item ID' }, { status: 400 });
  }

  try {
    const body = await req.json();
    const quantity = Number(body?.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      logWebEvent({
        event: 'REQUEST_FAILED',
        request_id: requestId,
        user_id: session.user.userId,
        route: `/api/cart/${rawId}`,
        method: 'PUT',
        status_code: 400,
        reason: 'Invalid quantity',
        duration_ms: Date.now() - startTime,
      });
      return NextResponse.json(
        { error: 'Quantity must be an integer between 1 and 99' },
        { status: 400 }
      );
    }

    const updated = updateCartItemQuantity(itemId, session.user.userId, quantity);
    if (!updated) {
      logWebEvent({
        event: 'REQUEST_FAILED',
        request_id: requestId,
        user_id: session.user.userId,
        cart_item_id: itemId,
        route: `/api/cart/${rawId}`,
        method: 'PUT',
        status_code: 404,
        reason: 'Cart item not found or not owned by user',
        duration_ms: Date.now() - startTime,
      });
      return NextResponse.json({ error: 'Cart item not found' }, { status: 404 });
    }

    const summary = summarizeCart(getCartItems(session.user.userId));
    logWebEvent({
      event: 'CART_ITEM_UPDATED',
      request_id: requestId,
      user_id: session.user.userId,
      cart_item_id: itemId,
      quantity,
      route: `/api/cart/${rawId}`,
      method: 'PUT',
      status_code: 200,
      duration_ms: Date.now() - startTime,
    });

    return NextResponse.json(
      { success: true, requestId, item: updated, ...summary },
      { headers: { 'x-request-id': requestId } }
    );
  } catch {
    return NextResponse.json({ error: 'Invalid request payload' }, { status: 400 });
  }
}

export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const startTime = Date.now();
  const requestId = getRequestId(req);
  const session = await getSessionUser();
  const { id: rawId } = await context.params;
  const itemId = Number(rawId);

  if (!session.authenticated || !session.user) {
    logWebEvent({
      event: 'AUTH_UNAUTHORIZED',
      request_id: requestId,
      route: `/api/cart/${rawId}`,
      method: 'DELETE',
      status_code: 401,
      duration_ms: Date.now() - startTime,
    });
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const origin = req.headers.get('origin');
  if (origin && origin !== ALLOWED_ORIGIN) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (!Number.isInteger(itemId) || itemId <= 0) {
    return NextResponse.json({ error: 'Invalid cart item ID' }, { status: 400 });
  }

  const removed = removeCartItem(itemId, session.user.userId);
  if (!removed) {
    logWebEvent({
      event: 'REQUEST_FAILED',
      request_id: requestId,
      user_id: session.user.userId,
      cart_item_id: itemId,
      route: `/api/cart/${rawId}`,
      method: 'DELETE',
      status_code: 404,
      reason: 'Cart item not found or not owned by user',
      duration_ms: Date.now() - startTime,
    });
    return NextResponse.json({ error: 'Cart item not found' }, { status: 404 });
  }

  const summary = summarizeCart(getCartItems(session.user.userId));
  logWebEvent({
    event: 'CART_ITEM_REMOVED',
    request_id: requestId,
    user_id: session.user.userId,
    cart_item_id: itemId,
    route: `/api/cart/${rawId}`,
    method: 'DELETE',
    status_code: 200,
    duration_ms: Date.now() - startTime,
  });

  return NextResponse.json(
    { success: true, requestId, ...summary },
    { headers: { 'x-request-id': requestId } }
  );
}
