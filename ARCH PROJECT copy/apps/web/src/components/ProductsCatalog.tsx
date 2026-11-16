'use client';

import React, { useState, useEffect } from 'react';

interface Product {
  id: number;
  name: string;
  price: number;
  stock: number;
}

export default function ProductsCatalog() {
  const [products, setProducts] = useState<Product[]>([]);
  const [handledBy, setHandledBy] = useState<string>('Not fetched yet');
  const [requestId, setRequestId] = useState<string>('None');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [requestCount, setRequestCount] = useState<number>(0);

  const fetchProducts = async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/products');
      const data = await res.json();

      if (res.ok && data.success) {
        setProducts(data.products || []);
        setHandledBy(data.handledBy || 'Unknown');
        setRequestId(data.requestId || 'None');
        setRequestCount(prev => prev + 1);
      } else {
        setError(data.message || data.error || 'Failed to fetch from Gateway');
      }
    } catch (err: any) {
      setError(`Network error connecting to Next.js API: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProducts();
  }, []);

  // Determine badge color based on instance name
  const getInstanceBadgeColor = (instance: string) => {
    if (instance.includes('product-1')) return { bg: '#dbeafe', color: '#1e40af', border: '#93c5fd' };
    if (instance.includes('product-2')) return { bg: '#f3e8ff', color: '#6b21a8', border: '#d8b4fe' };
    if (instance.includes('product-3')) return { bg: '#dcfce7', color: '#166534', border: '#86efac' };
    return { bg: '#f1f5f9', color: '#475569', border: '#cbd5e1' };
  };

  const badgeStyle = getInstanceBadgeColor(handledBy);

  return (
    <div
      style={{
        background: '#ffffff',
        padding: '24px',
        borderRadius: '12px',
        border: '1px solid #e2e8f0',
        boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
        marginTop: '24px',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '12px',
          marginBottom: '16px',
        }}
      >
        <div>
          <h2 style={{ fontSize: '18px', fontWeight: 700, margin: '0 0 4px 0', color: '#0f172a' }}>
            Live Product Catalog (via API Gateway :5001)
          </h2>
          <p style={{ fontSize: '13px', color: '#64748b', margin: 0 }}>
            Traffic Path: Next.js (:3000) &rarr; API Gateway (:5001) &rarr; Load Balanced Instance &rarr; products.db
          </p>
        </div>

        <button
          type="button"
          onClick={fetchProducts}
          disabled={loading}
          style={{
            padding: '9px 16px',
            background: '#4f46e5',
            color: '#ffffff',
            border: 'none',
            borderRadius: '6px',
            fontSize: '13px',
            fontWeight: 600,
            cursor: loading ? 'not-allowed' : 'pointer',
            boxShadow: '0 1px 2px rgba(79, 70, 229, 0.2)',
          }}
        >
          {loading ? 'Routing Request...' : 'Trigger Next Request (Test Round-Robin)'}
        </button>
      </div>

      {/* Instance Attribution & Request Tracing Live Banner */}
      <div
        style={{
          display: 'flex',
          gap: '12px',
          flexWrap: 'wrap',
          padding: '12px 16px',
          backgroundColor: '#f8fafc',
          border: '1px solid #e2e8f0',
          borderRadius: '8px',
          marginBottom: '18px',
          alignItems: 'center',
        }}
      >
        <div>
          <span style={{ fontSize: '12px', color: '#64748b', marginRight: '6px' }}>Handled By Instance:</span>
          <span
            style={{
              display: 'inline-block',
              padding: '4px 10px',
              borderRadius: '999px',
              fontSize: '12px',
              fontWeight: 700,
              backgroundColor: badgeStyle.bg,
              color: badgeStyle.color,
              border: `1px solid ${badgeStyle.border}`,
            }}
          >
            {handledBy}
          </span>
        </div>

        <div>
          <span style={{ fontSize: '12px', color: '#64748b', marginRight: '6px' }}>Request ID:</span>
          <code style={{ fontSize: '12px', background: '#e2e8f0', padding: '3px 6px', borderRadius: '4px' }}>
            {requestId}
          </code>
        </div>

        {requestCount > 0 && (
          <div style={{ marginLeft: 'auto', fontSize: '12px', color: '#94a3b8' }}>
            Requests Sent: <strong>{requestCount}</strong>
          </div>
        )}
      </div>

      {error && (
        <div
          style={{
            padding: '12px',
            backgroundColor: '#fee2e2',
            color: '#991b1b',
            borderRadius: '6px',
            fontSize: '13px',
            marginBottom: '16px',
          }}
        >
          <strong>Gateway Error:</strong> {error}
        </div>
      )}

      {/* Products Table */}
      <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '14px' }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #e2e8f0', color: '#475569' }}>
            <th style={{ padding: '10px 8px' }}>ID</th>
            <th style={{ padding: '10px 8px' }}>Product Name</th>
            <th style={{ padding: '10px 8px' }}>Price</th>
            <th style={{ padding: '10px 8px' }}>Stock</th>
          </tr>
        </thead>
        <tbody>
          {products.length === 0 && !loading && (
            <tr>
              <td colSpan={4} style={{ padding: '16px', textAlign: 'center', color: '#94a3b8' }}>
                No products found or Gateway offline.
              </td>
            </tr>
          )}
          {products.map(p => (
            <tr key={p.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
              <td style={{ padding: '10px 8px', color: '#64748b' }}>#{p.id}</td>
              <td style={{ padding: '10px 8px', fontWeight: 600, color: '#1e293b' }}>{p.name}</td>
              <td style={{ padding: '10px 8px', color: '#0f766e', fontWeight: 600 }}>${p.price.toFixed(2)}</td>
              <td style={{ padding: '10px 8px', color: '#475569' }}>{p.stock} units</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
