'use client';

import React, { useState, useEffect, useCallback } from 'react';

interface Product {
  id: number;
  name: string;
  price: number;
  stock: number;
}

interface CartItem {
  id: number;
  product_id: number;
  product_name: string;
  unit_price: number;
  quantity: number;
}

interface Props {
  userEmail: string;
  userId: number;
  initialCartItems: CartItem[];
  initialTotalAmount: number;
  initialItemCount: number;
}

export default function EcommerceStore({
  userEmail,
  userId,
  initialCartItems,
  initialTotalAmount,
  initialItemCount,
}: Props) {
  const [products, setProducts] = useState<Product[]>([]);
  const [handledBy, setHandledBy] = useState<string>('Loading...');
  const [requestId, setRequestId] = useState<string>('None');
  const [loadingProducts, setLoadingProducts] = useState<boolean>(false);
  const [productsError, setProductsError] = useState<string | null>(null);

  const [cartItems, setCartItems] = useState<CartItem[]>(initialCartItems);
  const [totalAmount, setTotalAmount] = useState<number>(initialTotalAmount);
  const [itemCount, setItemCount] = useState<number>(initialItemCount);
  const [cartStatus, setCartStatus] = useState<{ msg: string; err?: boolean } | null>(null);
  const [busyProductId, setBusyProductId] = useState<number | null>(null);
  const [busyCartId, setBusyCartId] = useState<number | null>(null);

  const fetchProducts = useCallback(async () => {
    setLoadingProducts(true);
    setProductsError(null);
    try {
      const res = await fetch('/api/products', { cache: 'no-store' });
      if (res.status === 401) {
        window.location.href = 'http://localhost:3001/login?redirect_uri=http%3A%2F%2Flocalhost%3A3000';
        return;
      }
      const data = await res.json();
      if (res.ok && data.success) {
        setProducts(data.products || []);
        setHandledBy(data.handledBy || 'unknown');
        setRequestId(data.requestId || 'None');
      } else {
        setProductsError(data.message || data.error || 'Failed to load products');
      }
    } catch (err: any) {
      setProductsError(`Gateway connection error: ${err.message}`);
    } finally {
      setLoadingProducts(false);
    }
  }, []);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  const applyCartSummary = (data: any) => {
    setCartItems(data.items || []);
    setTotalAmount(Number(data.totalAmount || 0));
    setItemCount(Number(data.itemCount || 0));
  };

  const handleAddToCart = async (product: Product) => {
    setBusyProductId(product.id);
    setCartStatus(null);
    try {
      const res = await fetch('/api/cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_id: product.id, quantity: 1 }),
      });
      if (res.status === 401) {
        window.location.href = 'http://localhost:3001/login?redirect_uri=http%3A%2F%2Flocalhost%3A3000';
        return;
      }
      const data = await res.json();
      if (res.ok && data.success) {
        applyCartSummary(data);
        setCartStatus({ msg: `Added "${product.name}" to cart.` });
      } else {
        setCartStatus({ msg: data.error || 'Failed to add item', err: true });
      }
    } catch {
      setCartStatus({ msg: 'Network error adding item to cart', err: true });
    } finally {
      setBusyProductId(null);
    }
  };

  const handleUpdateQty = async (item: CartItem, newQty: number) => {
    if (newQty < 1) {
      await handleRemoveItem(item.id);
      return;
    }
    setBusyCartId(item.id);
    setCartStatus(null);
    try {
      const res = await fetch(`/api/cart/${item.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantity: newQty }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        applyCartSummary(data);
      } else {
        setCartStatus({ msg: data.error || 'Failed to update quantity', err: true });
      }
    } catch {
      setCartStatus({ msg: 'Network error updating cart', err: true });
    } finally {
      setBusyCartId(null);
    }
  };

  const handleRemoveItem = async (id: number) => {
    setBusyCartId(id);
    setCartStatus(null);
    try {
      const res = await fetch(`/api/cart/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok && data.success) {
        applyCartSummary(data);
        setCartStatus({ msg: 'Item removed from cart.' });
      } else {
        setCartStatus({ msg: data.error || 'Failed to remove item', err: true });
      }
    } catch {
      setCartStatus({ msg: 'Network error removing item', err: true });
    } finally {
      setBusyCartId(null);
    }
  };

  const handleClearOrCheckout = async (checkout: boolean) => {
    setCartStatus(null);
    try {
      const url = checkout ? '/api/cart?action=checkout' : '/api/cart';
      const res = await fetch(url, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok && data.success) {
        applyCartSummary(data);
        setCartStatus({
          msg: checkout
            ? 'Checkout complete! Your order has been placed.'
            : 'Cart cleared.',
        });
      } else {
        setCartStatus({ msg: data.error || 'Failed to clear cart', err: true });
      }
    } catch {
      setCartStatus({ msg: 'Network error clearing cart', err: true });
    }
  };

  const handleLogout = async () => {
    let targetUrl = 'http://localhost:3001/login?redirect_uri=http%3A%2F%2Flocalhost%3A3000';
    try {
      const res = await fetch('http://localhost:3001/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uri: 'http://localhost:3000' }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.redirectUrl) targetUrl = data.redirectUrl;
      }
    } catch { }
    window.location.href = targetUrl;
  };

  const getBadgeStyle = (instance: string) => {
    if (instance.includes('product-1')) return { bg: '#dbeafe', color: '#1e40af' };
    if (instance.includes('product-2')) return { bg: '#f3e8ff', color: '#6b21a8' };
    if (instance.includes('product-3')) return { bg: '#dcfce7', color: '#166534' };
    return { bg: '#f1f5f9', color: '#475569' };
  };
  const badge = getBadgeStyle(handledBy);

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', color: '#0f172a' }}>
      {/* Top Navigation Bar */}
      <nav
        style={{
          background: '#ffffff',
          borderBottom: '1px solid #e2e8f0',
          padding: '14px 24px',
        }}
      >
        <div
          style={{
            maxWidth: '1040px',
            margin: '0 auto',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span
              style={{
                background: '#eef2ff',
                color: '#4338ca',
                fontSize: '12px',
                fontWeight: 700,
                padding: '4px 10px',
                borderRadius: '999px',
              }}
            >
              App 2: Next.js Store (:3000)
            </span>
            <strong style={{ fontSize: '18px' }}>TechStore</strong>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
            <a
              href="http://localhost:3003"
              style={{ fontSize: '13px', color: '#4f46e5', textDecoration: 'none', fontWeight: 600 }}
            >
              Notes App (:3003) &rarr;
            </a>
            <span
              style={{
                background: '#f1f5f9',
                padding: '5px 10px',
                borderRadius: '999px',
                fontSize: '13px',
                fontWeight: 600,
              }}
            >
              Cart: {itemCount}
            </span>
            <span style={{ fontSize: '13px', color: '#475569' }}>
              {userEmail} (#{userId})
            </span>
            <button
              type="button"
              onClick={handleLogout}
              style={{
                padding: '7px 14px',
                background: '#ef4444',
                color: '#ffffff',
                border: 'none',
                borderRadius: '6px',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Sign Out
            </button>
          </div>
        </div>
      </nav>

      <main style={{ maxWidth: '1040px', margin: '28px auto', padding: '0 20px' }}>
        {/* Gateway & Round-Robin Status Bar */}
        <div
          style={{
            background: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '10px',
            padding: '14px 18px',
            marginBottom: '20px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '13px', color: '#64748b' }}>Gateway Load Balancer:</span>
            <span
              style={{
                padding: '3px 10px',
                borderRadius: '999px',
                fontSize: '12px',
                fontWeight: 700,
                background: badge.bg,
                color: badge.color,
              }}
            >
              {handledBy}
            </span>
            <code style={{ fontSize: '12px', background: '#f1f5f9', padding: '3px 6px', borderRadius: '4px' }}>
              {requestId}
            </code>
          </div>
          <button
            type="button"
            onClick={fetchProducts}
            disabled={loadingProducts}
            style={{
              padding: '7px 14px',
              background: '#4f46e5',
              color: '#ffffff',
              border: 'none',
              borderRadius: '6px',
              fontSize: '13px',
              fontWeight: 600,
              cursor: loadingProducts ? 'not-allowed' : 'pointer',
            }}
          >
            {loadingProducts ? 'Refreshing...' : 'Refresh Catalog (Test Round-Robin)'}
          </button>
        </div>

        {productsError && (
          <div
            style={{
              background: '#fee2e2',
              color: '#991b1b',
              padding: '12px 16px',
              borderRadius: '8px',
              marginBottom: '20px',
              fontSize: '13px',
            }}
          >
            {productsError}
          </div>
        )}

        {/* 3-Product Storefront Grid */}
        <h2 style={{ fontSize: '20px', fontWeight: 700, marginBottom: '14px' }}>
          Featured Products ({products.length})
        </h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: '16px',
            marginBottom: '28px',
          }}
        >
          {products.map((p) => (
            <div
              key={p.id}
              style={{
                background: '#ffffff',
                border: '1px solid #e2e8f0',
                borderRadius: '12px',
                padding: '20px',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: '14px',
              }}
            >
              <div>
                <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '4px' }}>
                  Product #{p.id}
                </div>
                <h3 style={{ fontSize: '17px', fontWeight: 700, margin: '0 0 8px 0' }}>{p.name}</h3>
                <div style={{ fontSize: '20px', fontWeight: 700, color: '#0f766e' }}>
                  ${p.price.toFixed(2)}
                </div>
                <div style={{ fontSize: '13px', color: '#475569', marginTop: '4px' }}>
                  In Stock: {p.stock} units
                </div>
              </div>
              <button
                type="button"
                disabled={busyProductId === p.id || p.stock <= 0}
                onClick={() => handleAddToCart(p)}
                style={{
                  width: '100%',
                  padding: '10px',
                  background: '#2563eb',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '14px',
                  fontWeight: 600,
                  cursor: busyProductId === p.id ? 'not-allowed' : 'pointer',
                }}
              >
                {busyProductId === p.id ? 'Adding...' : 'Add to Cart'}
              </button>
            </div>
          ))}
        </div>

        {/* Shopping Cart Section */}
        <div
          style={{
            background: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '12px',
            padding: '22px',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '10px',
              marginBottom: '14px',
            }}
          >
            <h2 style={{ fontSize: '19px', fontWeight: 700, margin: 0 }}>
              Shopping Cart ({itemCount} {itemCount === 1 ? 'item' : 'items'})
            </h2>
            {cartItems.length > 0 && (
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  onClick={() => handleClearOrCheckout(false)}
                  style={{
                    padding: '8px 14px',
                    background: '#e2e8f0',
                    color: '#1e293b',
                    border: 'none',
                    borderRadius: '6px',
                    fontSize: '13px',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Clear Cart
                </button>
                <button
                  type="button"
                  onClick={() => handleClearOrCheckout(true)}
                  style={{
                    padding: '8px 16px',
                    background: '#16a34a',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '6px',
                    fontSize: '13px',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Checkout (${totalAmount.toFixed(2)})
                </button>
              </div>
            )}
          </div>

          {cartStatus && (
            <div
              style={{
                padding: '10px 14px',
                borderRadius: '6px',
                fontSize: '13px',
                marginBottom: '14px',
                background: cartStatus.err ? '#fee2e2' : '#dcfce7',
                color: cartStatus.err ? '#991b1b' : '#166534',
              }}
            >
              {cartStatus.msg}
            </div>
          )}

          {cartItems.length === 0 ? (
            <p style={{ color: '#64748b', fontSize: '14px', margin: 0 }}>
              Your cart is empty. Add products from the catalog above.
            </p>
          ) : (
            <div>
              {cartItems.map((item) => (
                <div
                  key={item.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: '12px',
                    padding: '12px 0',
                    borderBottom: '1px solid #f1f5f9',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '15px' }}>{item.product_name}</div>
                    <div style={{ fontSize: '13px', color: '#64748b' }}>
                      ${item.unit_price.toFixed(2)} each
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <button
                      type="button"
                      disabled={busyCartId === item.id}
                      onClick={() => handleUpdateQty(item, item.quantity - 1)}
                      style={{
                        width: '30px',
                        height: '30px',
                        border: '1px solid #cbd5e1',
                        borderRadius: '6px',
                        background: '#fff',
                        cursor: 'pointer',
                        fontWeight: 700,
                      }}
                    >
                      -
                    </button>
                    <span style={{ minWidth: '24px', textAlign: 'center', fontWeight: 600 }}>
                      {item.quantity}
                    </span>
                    <button
                      type="button"
                      disabled={busyCartId === item.id}
                      onClick={() => handleUpdateQty(item, item.quantity + 1)}
                      style={{
                        width: '30px',
                        height: '30px',
                        border: '1px solid #cbd5e1',
                        borderRadius: '6px',
                        background: '#fff',
                        cursor: 'pointer',
                        fontWeight: 700,
                      }}
                    >
                      +
                    </button>
                    <div style={{ minWidth: '80px', textAlign: 'right', fontWeight: 700 }}>
                      ${(item.unit_price * item.quantity).toFixed(2)}
                    </div>
                    <button
                      type="button"
                      disabled={busyCartId === item.id}
                      onClick={() => handleRemoveItem(item.id)}
                      style={{
                        padding: '6px 10px',
                        background: '#fee2e2',
                        color: '#991b1b',
                        border: 'none',
                        borderRadius: '6px',
                        fontSize: '12px',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  paddingTop: '14px',
                  fontSize: '18px',
                  fontWeight: 700,
                }}
              >
                Total: ${totalAmount.toFixed(2)}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
