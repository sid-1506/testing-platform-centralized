import { test, expect } from '@playwright/test';

const AUTH_URL = process.env.AUTH_URL || 'http://localhost:3001';
const WEB_URL = process.env.WEB_URL || 'http://localhost:3000';
const NOTES_URL = process.env.NOTES_URL || 'http://localhost:3003';
const HYBRID_FE_URL = process.env.HYBRID_FE_URL || 'http://localhost:3004';

test.describe('ARCH PROJECT Browser SSO & Navigation E2E', () => {
  test('redirects unauthenticated user to Auth login and completes SSO into Web, Notes & Hybrid apps', async ({
    page,
    request,
  }) => {
    const email = `e2e_pw_${Date.now()}@example.com`;
    const password = 'Password123!';

    // Create test user via Auth API
    const signupRes = await request.post(`${AUTH_URL}/api/auth/signup`, {
      data: { email, password, redirect_uri: WEB_URL },
    });
    expect(signupRes.status()).toBe(201);

    // Visit protected Web App (:3000) -> should redirect to Auth App (:3001/login)
    await page.goto(WEB_URL);
    await expect(page).toHaveURL(/http:\/\/localhost:3001\/login/);
    await expect(page.locator('h1')).toHaveText('Sign In');

    // Fill login form and submit
    await page.fill('#email', email);
    await page.fill('#password', password);
    await page.click('#submitBtn');

    // Should redirect back to :3000/ as authenticated user
    await page.waitForURL(`${WEB_URL}/**`, { timeout: 15000 });
    await expect(page.locator('body')).toContainText(email);

    // SSO cookie should grant immediate access to Notes (:3003) and Hybrid Frontend (:3004)
    const notesRes = await page.goto(NOTES_URL);
    expect(notesRes?.status()).toBe(200);
    await expect(page).toHaveURL(/http:\/\/localhost:3003/);

    const hybridRes = await page.goto(HYBRID_FE_URL);
    expect(hybridRes?.status()).toBe(200);
    await expect(page).toHaveURL(/http:\/\/localhost:3004/);
  });
});
