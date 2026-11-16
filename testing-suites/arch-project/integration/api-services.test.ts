import { describe, it, expect } from 'vitest';

const AUTH_URL = process.env.AUTH_URL || 'http://localhost:3001';
const WEB_URL = process.env.WEB_URL || 'http://localhost:3000';
const NOTES_URL = process.env.NOTES_URL || 'http://localhost:3003';
const HYBRID_FE_URL = process.env.HYBRID_FE_URL || 'http://localhost:3004';
const HYBRID_BE_URL = process.env.HYBRID_BE_URL || 'http://localhost:3005';
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:5001';

async function signupAndLogin(prefix: string): Promise<string> {
  const email = `${prefix}_${Date.now()}_${Math.floor(Math.random() * 10000)}@example.com`;
  const password = 'Password123!';

  const signupRes = await fetch(`${AUTH_URL}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, redirect_uri: WEB_URL }),
  });
  expect(signupRes.status).toBe(201);

  const loginRes = await fetch(`${AUTH_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, redirect_uri: WEB_URL }),
  });
  expect(loginRes.status).toBe(200);
  const body = (await loginRes.json()) as Record<string, unknown>;
  expect('token' in body).toBe(false); // JWT must stay in HttpOnly cookie

  const setCookie = loginRes.headers.get('set-cookie') || '';
  expect(setCookie).toContain('HttpOnly');
  return setCookie.split(';')[0];
}

describe('ARCH PROJECT Integration & API Verification', () => {
  it('verifies all core service health endpoints return HTTP 200', async () => {
    const endpoints = [
      `${AUTH_URL}/health`,
      `${WEB_URL}/api/health`,
      `${NOTES_URL}/health`,
      `${HYBRID_FE_URL}/api/health`,
      `${HYBRID_BE_URL}/health`,
      `${GATEWAY_URL}/health`,
      'http://localhost:6001/health',
      'http://localhost:6002/health',
      'http://localhost:6003/health',
    ];

    for (const url of endpoints) {
      const res = await fetch(url);
      expect(res.status, `${url} should return 200`).toBe(200);
    }
  });

  it('rejects unauthenticated requests to protected APIs with 401', async () => {
    for (const url of [`${WEB_URL}/api/cart`, `${NOTES_URL}/api/notes`, `${HYBRID_BE_URL}/api/tasks`]) {
      const res = await fetch(url);
      expect(res.status).toBe(401);
    }
  });

  it('enforces Notes CRUD and cross-user isolation on :3003', async () => {
    const cookieA = await signupAndLogin('notesA');
    const cookieB = await signupAndLogin('notesB');

    const createRes = await fetch(`${NOTES_URL}/api/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieA },
      body: JSON.stringify({ title: 'Integration Note', content: 'Created by Vitest' }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { note: { id: number } };

    // User B must not modify User A's note
    const hackRes = await fetch(`${NOTES_URL}/api/notes/${created.note.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookieB },
      body: JSON.stringify({ title: 'Tampered', content: 'Tampered' }),
    });
    expect(hackRes.status).toBe(404);

    // Cleanup by User A
    const delRes = await fetch(`${NOTES_URL}/api/notes/${created.note.id}`, {
      method: 'DELETE',
      headers: { Cookie: cookieA },
    });
    expect(delRes.status).toBe(200);
  });

  it('enforces Hybrid Tasks CRUD and cross-user isolation on :3005', async () => {
    const cookieA = await signupAndLogin('tasksA');
    const cookieB = await signupAndLogin('tasksB');

    const createRes = await fetch(`${HYBRID_BE_URL}/api/tasks`, {
      method: 'POST',
      headers: { Origin: HYBRID_FE_URL, 'Content-Type': 'application/json', Cookie: cookieA },
      body: JSON.stringify({ title: 'Integration Task', description: 'Verify hybrid backend' }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { task: { id: number } };

    const hackRes = await fetch(`${HYBRID_BE_URL}/api/tasks/${created.task.id}`, {
      method: 'DELETE',
      headers: { Origin: HYBRID_FE_URL, Cookie: cookieB },
    });
    expect(hackRes.status).toBe(404);

    const delRes = await fetch(`${HYBRID_BE_URL}/api/tasks/${created.task.id}`, {
      method: 'DELETE',
      headers: { Origin: HYBRID_FE_URL, Cookie: cookieA },
    });
    expect(delRes.status).toBe(200);
  });

  it('routes product requests via Gateway Round-Robin across all 3 replicas', async () => {
    const cookieA = await signupAndLogin('gwA');
    const handledBy = new Set<string>();

    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${WEB_URL}/api/products`, {
        headers: { Cookie: cookieA },
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { handledBy: string; products: unknown[] };
      expect(data.products.length).toBe(3);
      handledBy.add(data.handledBy);
    }

    expect(handledBy.has('product-1')).toBe(true);
    expect(handledBy.has('product-2')).toBe(true);
    expect(handledBy.has('product-3')).toBe(true);
  });
});
