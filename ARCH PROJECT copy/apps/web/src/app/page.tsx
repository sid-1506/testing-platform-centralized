import React from 'react';
import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth';
import { getCartItems } from '@/lib/db';
import { logWebEvent } from '@/lib/logger';
import EcommerceStore from '@/components/EcommerceStore';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const session = await getSessionUser();

  if (!session.authenticated || !session.user) {
    logWebEvent({
      event: 'AUTH_UNAUTHORIZED',
      route: '/',
      method: 'GET',
      status_code: 307,
    });
    redirect('http://localhost:3001/login?redirect_uri=http%3A%2F%2Flocalhost%3A3000');
  }

  const cartItems = getCartItems(session.user.userId);
  const itemCount = cartItems.reduce((sum, item) => sum + item.quantity, 0);
  const totalAmount =
    Math.round(
      cartItems.reduce((sum, item) => sum + item.unit_price * item.quantity, 0) * 100
    ) / 100;

  return (
    <EcommerceStore
      userEmail={session.user.email}
      userId={session.user.userId}
      initialCartItems={cartItems}
      initialTotalAmount={totalAmount}
      initialItemCount={itemCount}
    />
  );
}
