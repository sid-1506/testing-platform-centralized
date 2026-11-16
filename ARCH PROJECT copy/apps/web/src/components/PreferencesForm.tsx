'use client';

import React, { useState } from 'react';

interface Props {
  initialTheme: string;
  initialNotes: string;
}

export default function PreferencesForm({ initialTheme, initialNotes }: Props) {
  const [theme, setTheme] = useState(initialTheme || 'light');
  const [notes, setNotes] = useState(initialNotes || '');
  const [status, setStatus] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setStatus(null);

    try {
      const res = await fetch('/api/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme, notes }),
      });

      const data = await res.json();
      if (res.ok) {
        setStatus('Saved to next_app.db successfully!');
      } else {
        setStatus(`Error: ${data.error || 'Failed to save'}`);
      }
    } catch (err) {
      setStatus('Network error saving preferences');
    } finally {
      setIsSaving(false);
    }
  };

  const handleLogout = async () => {
    let targetUrl = 'http://localhost:3001/login?redirect_uri=http%3A%2F%2Flocalhost%3A3000';
    try {
      // Call Auth service logout endpoint to clear cookie
      const res = await fetch('http://localhost:3001/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uri: 'http://localhost:3000' }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.redirectUrl) {
          targetUrl = data.redirectUrl;
        }
      }
    } catch (e) {
      console.error('Logout request failed', e);
    }
    // Redirect to Auth service login page
    window.location.href = targetUrl;
  };

  return (
    <div
      style={{
        background: '#ffffff',
        padding: '24px',
        borderRadius: '12px',
        border: '1px solid #e2e8f0',
        boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
        marginTop: '20px',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '16px',
        }}
      >
        <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>
          Local Database (next_app.db) - User Preferences
        </h3>
        <button
          type="button"
          onClick={handleLogout}
          style={{
            padding: '8px 14px',
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

      <p style={{ fontSize: '14px', color: '#64748b', margin: '0 0 16px 0' }}>
        This data is stored purely inside Next.js&apos;s own SQLite database (<code>next_app.db</code>).
        The Auth service cannot see this, and Next.js does not touch <code>auth.db</code>.
      </p>

      {status && (
        <div
          style={{
            padding: '10px 14px',
            borderRadius: '6px',
            fontSize: '13px',
            marginBottom: '16px',
            background: status.includes('Error') ? '#fee2e2' : '#dcfce7',
            color: status.includes('Error') ? '#991b1b' : '#166534',
          }}
        >
          {status}
        </div>
      )}

      <form onSubmit={handleSave}>
        <div style={{ marginBottom: '14px' }}>
          <label
            style={{
              display: 'block',
              fontSize: '13px',
              fontWeight: 500,
              color: '#334155',
              marginBottom: '6px',
            }}
          >
            Dashboard Color Theme
          </label>
          <select
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            style={{
              width: '100%',
              padding: '8px 12px',
              borderRadius: '6px',
              border: '1px solid #cbd5e1',
              fontSize: '14px',
              backgroundColor: '#ffffff',
            }}
          >
            <option value="light">Light Theme (Default)</option>
            <option value="slate">Slate Professional</option>
            <option value="indigo">Indigo Modern</option>
            <option value="emerald">Emerald Data</option>
          </select>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <label
            style={{
              display: 'block',
              fontSize: '13px',
              fontWeight: 500,
              color: '#334155',
              marginBottom: '6px',
            }}
          >
            Private Dashboard Notes (Stored in next_app.db)
          </label>
          <textarea
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Type any private note or preference here..."
            style={{
              width: '100%',
              padding: '8px 12px',
              borderRadius: '6px',
              border: '1px solid #cbd5e1',
              fontSize: '14px',
              boxSizing: 'border-box',
            }}
          />
        </div>

        <button
          type="submit"
          disabled={isSaving}
          style={{
            padding: '10px 18px',
            background: '#2563eb',
            color: '#ffffff',
            border: 'none',
            borderRadius: '6px',
            fontSize: '14px',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {isSaving ? 'Saving...' : 'Save to next_app.db'}
        </button>
      </form>
    </div>
  );
}
