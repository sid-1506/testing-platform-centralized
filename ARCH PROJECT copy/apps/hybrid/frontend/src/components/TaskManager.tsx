'use client';

import React, { useState, useEffect, useCallback } from 'react';

interface Task {
  id: number;
  title: string;
  description: string;
  status: 'pending' | 'completed';
  created_at: string;
  updated_at: string;
}

interface Props {
  userEmail: string;
  userId: number;
  backendUrl: string;
  authUrl: string;
}

function generateRequestId(): string {
  return `req_${Date.now()}_hyb_${Math.random().toString(36).substring(2, 6)}`;
}

export default function TaskManager({ userEmail, userId, backendUrl, authUrl }: Props) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [statusMsg, setStatusMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [lastRequestId, setLastRequestId] = useState<string>('None');

  const [editingId, setEditingId] = useState<number | null>(null);
  const [title, setTitle] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);

  const redirectToAuth = useCallback(() => {
    window.location.href = `${authUrl}/login?redirect_uri=${encodeURIComponent('http://localhost:3004')}`;
  }, [authUrl]);

  const callBackend = useCallback(
    async (path: string, options: RequestInit = {}) => {
      const reqId = generateRequestId();
      const res = await fetch(`${backendUrl}${path}`, {
        ...options,
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': reqId,
          ...(options.headers || {}),
        },
      });
      const respReqId = res.headers.get('x-request-id') || reqId;
      setLastRequestId(respReqId);
      if (res.status === 401) {
        redirectToAuth();
        return null;
      }
      const data = await res.json();
      return { ok: res.ok, data };
    },
    [backendUrl, redirectToAuth]
  );

  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const result = await callBackend('/api/tasks');
      if (!result) return;
      if (result.ok) {
        setTasks(result.data.tasks || []);
      } else {
        setStatusMsg({ text: result.data.error || 'Failed to load tasks', err: true });
      }
    } catch (err: any) {
      setStatusMsg({ text: `Express backend unreachable: ${err.message}`, err: true });
    } finally {
      setLoading(false);
    }
  }, [callBackend]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);
    setStatusMsg(null);

    try {
      const isEdit = editingId !== null;
      const result = await callBackend(
        isEdit ? `/api/tasks/${editingId}` : '/api/tasks',
        {
          method: isEdit ? 'PUT' : 'POST',
          body: JSON.stringify({ title, description }),
        }
      );
      if (!result) return;
      if (result.ok) {
        setStatusMsg({ text: isEdit ? 'Task updated!' : 'Task created!' });
        setEditingId(null);
        setTitle('');
        setDescription('');
        await loadTasks();
      } else {
        setStatusMsg({ text: result.data.error || 'Operation failed', err: true });
      }
    } catch {
      setStatusMsg({ text: 'Network error communicating with Express backend', err: true });
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleStatus = async (task: Task) => {
    const nextStatus = task.status === 'completed' ? 'pending' : 'completed';
    setStatusMsg(null);
    const result = await callBackend(`/api/tasks/${task.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: nextStatus }),
    });
    if (!result) return;
    if (result.ok) {
      setStatusMsg({
        text: nextStatus === 'completed' ? 'Task marked completed!' : 'Task reopened.',
      });
      await loadTasks();
    } else {
      setStatusMsg({ text: result.data.error || 'Failed to update status', err: true });
    }
  };

  const handleDelete = async (id: number) => {
    setStatusMsg(null);
    const result = await callBackend(`/api/tasks/${id}`, { method: 'DELETE' });
    if (!result) return;
    if (result.ok) {
      if (editingId === id) {
        setEditingId(null);
        setTitle('');
        setDescription('');
      }
      setStatusMsg({ text: 'Task deleted.' });
      await loadTasks();
    } else {
      setStatusMsg({ text: result.data.error || 'Failed to delete task', err: true });
    }
  };

  const handleLogout = async () => {
    let target = `${authUrl}/login?redirect_uri=${encodeURIComponent('http://localhost:3004')}`;
    try {
      const res = await fetch(`${authUrl}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uri: 'http://localhost:3004' }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.redirectUrl) target = data.redirectUrl;
      }
    } catch {}
    window.location.href = target;
  };

  const pendingTasks = tasks.filter((t) => t.status === 'pending');
  const completedTasks = tasks.filter((t) => t.status === 'completed');

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', color: '#0f172a' }}>
      <nav style={{ background: '#ffffff', borderBottom: '1px solid #e2e8f0', padding: '14px 24px' }}>
        <div
          style={{
            maxWidth: '960px',
            margin: '0 auto',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span
              style={{
                background: '#dcfce7',
                color: '#166534',
                fontSize: '12px',
                fontWeight: 700,
                padding: '4px 10px',
                borderRadius: '999px',
              }}
            >
              App 3: Hybrid (:3004 &rarr; :3005)
            </span>
            <strong style={{ fontSize: '18px' }}>Hybrid Task Manager</strong>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
            <a href="http://localhost:3000" style={{ fontSize: '13px', color: '#4f46e5', textDecoration: 'none', fontWeight: 600 }}>
              Store (:3000)
            </a>
            <a href="http://localhost:3003" style={{ fontSize: '13px', color: '#4f46e5', textDecoration: 'none', fontWeight: 600 }}>
              Notes (:3003)
            </a>
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

      <main style={{ maxWidth: '960px', margin: '24px auto', padding: '0 20px' }}>
        <div
          style={{
            background: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '10px',
            padding: '12px 16px',
            marginBottom: '18px',
            display: 'flex',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '10px',
            fontSize: '13px',
          }}
        >
          <span>
            Pending: <strong>{pendingTasks.length}</strong> &bull; Completed:{' '}
            <strong>{completedTasks.length}</strong>
          </span>
          <span>
            Last Backend Request ID:{' '}
            <code style={{ background: '#f1f5f9', padding: '2px 6px', borderRadius: '4px' }}>
              {lastRequestId}
            </code>
          </span>
        </div>

        {statusMsg && (
          <div
            style={{
              padding: '10px 14px',
              borderRadius: '6px',
              fontSize: '13px',
              marginBottom: '16px',
              background: statusMsg.err ? '#fee2e2' : '#dcfce7',
              color: statusMsg.err ? '#991b1b' : '#166534',
            }}
          >
            {statusMsg.text}
          </div>
        )}

        {/* Create / Edit Task Form */}
        <div
          style={{
            background: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '12px',
            padding: '20px',
            marginBottom: '20px',
          }}
        >
          <h2 style={{ fontSize: '17px', fontWeight: 700, margin: '0 0 12px 0' }}>
            {editingId !== null ? `Edit Task #${editingId}` : 'Create New Task'}
          </h2>
          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: '12px' }}>
              <input
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Task title..."
                style={{
                  width: '100%',
                  padding: '9px 12px',
                  border: '1px solid #cbd5e1',
                  borderRadius: '6px',
                  fontSize: '14px',
                  boxSizing: 'border-box',
                }}
              />
            </div>
            <div style={{ marginBottom: '12px' }}>
              <textarea
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Task description (optional)..."
                style={{
                  width: '100%',
                  padding: '9px 12px',
                  border: '1px solid #cbd5e1',
                  borderRadius: '6px',
                  fontSize: '14px',
                  boxSizing: 'border-box',
                }}
              />
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="submit"
                disabled={submitting}
                style={{
                  padding: '9px 16px',
                  background: '#4f46e5',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '6px',
                  fontSize: '13px',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {submitting ? 'Saving...' : editingId !== null ? 'Update Task' : 'Add Task'}
              </button>
              {editingId !== null && (
                <button
                  type="button"
                  onClick={() => {
                    setEditingId(null);
                    setTitle('');
                    setDescription('');
                  }}
                  style={{
                    padding: '9px 14px',
                    background: '#e2e8f0',
                    color: '#1e293b',
                    border: 'none',
                    borderRadius: '6px',
                    fontSize: '13px',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
        </div>

        {/* Pending & Completed Tasks */}
        {[
          { heading: `Pending Tasks (${pendingTasks.length})`, items: pendingTasks },
          { heading: `Completed Tasks (${completedTasks.length})`, items: completedTasks },
        ].map((group) => (
          <div
            key={group.heading}
            style={{
              background: '#ffffff',
              border: '1px solid #e2e8f0',
              borderRadius: '12px',
              padding: '20px',
              marginBottom: '18px',
            }}
          >
            <h3 style={{ fontSize: '16px', fontWeight: 700, margin: '0 0 12px 0' }}>
              {group.heading}
            </h3>
            {loading ? (
              <p style={{ color: '#64748b', fontSize: '14px', margin: 0 }}>Loading tasks...</p>
            ) : group.items.length === 0 ? (
              <p style={{ color: '#64748b', fontSize: '14px', margin: 0 }}>No tasks in this list.</p>
            ) : (
              group.items.map((t) => (
                <div
                  key={t.id}
                  style={{
                    border: '1px solid #e2e8f0',
                    borderRadius: '8px',
                    padding: '12px 14px',
                    marginBottom: '10px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: '10px',
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontWeight: 600,
                        fontSize: '15px',
                        textDecoration: t.status === 'completed' ? 'line-through' : 'none',
                        color: t.status === 'completed' ? '#64748b' : '#0f172a',
                      }}
                    >
                      {t.title}
                    </div>
                    {t.description && (
                      <div style={{ fontSize: '13px', color: '#475569', marginTop: '3px' }}>
                        {t.description}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      type="button"
                      onClick={() => handleToggleStatus(t)}
                      style={{
                        padding: '6px 10px',
                        background: t.status === 'completed' ? '#e2e8f0' : '#16a34a',
                        color: t.status === 'completed' ? '#1e293b' : '#ffffff',
                        border: 'none',
                        borderRadius: '6px',
                        fontSize: '12px',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      {t.status === 'completed' ? 'Reopen' : 'Complete'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(t.id);
                        setTitle(t.title);
                        setDescription(t.description);
                      }}
                      style={{
                        padding: '6px 10px',
                        background: '#e2e8f0',
                        color: '#1e293b',
                        border: 'none',
                        borderRadius: '6px',
                        fontSize: '12px',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(t.id)}
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
                      Delete
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        ))}
      </main>
    </div>
  );
}
