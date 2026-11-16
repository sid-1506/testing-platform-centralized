#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "================================================================================"
echo "       COMPREHENSIVE MASTER END-TO-END VERIFICATION SUITE (ALL 3 APPS)          "
echo "================================================================================"

echo ""
echo ">>> STEP 1: TYPESCRIPT TYPECHECK ACROSS ALL 7 WORKSPACES..."
npm run typecheck
echo "PASSED: All 7 workspaces compiled with 0 TypeScript errors."

echo ""
echo ">>> STEP 2: VERIFY ALL SERVICE HEALTH ENDPOINTS..."
for svc in \
  "Auth Service|http://localhost:3001/health" \
  "E-Commerce Web|http://localhost:3000/api/health" \
  "Notes App|http://localhost:3003/health" \
  "Hybrid Frontend|http://localhost:3004/api/health" \
  "Hybrid Backend|http://localhost:3005/health" \
  "API Gateway|http://localhost:5001/health" \
  "Product Replica 1|http://localhost:6001/health" \
  "Product Replica 2|http://localhost:6002/health" \
  "Product Replica 3|http://localhost:6003/health"
do
  name="${svc%%|*}"
  url="${svc##*|}"
  code=$(curl -s -o /dev/null -w "%{http_code}" "$url")
  if [ "$code" -ne 200 ]; then
    echo "FAILED: $name ($url) returned HTTP $code"
    exit 1
  fi
  echo "  PASSED: $name ($url) -> HTTP 200"
done

echo ""
echo ">>> STEP 3: AUTHENTICATION, SSO, CRUD, SECURITY & LOKI CORRELATION..."
node -e '
const assert = require("assert");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");

async function loginNewUser(prefix) {
  const email = `${prefix}_${Date.now()}_${Math.floor(Math.random()*1000)}@example.com`;
  const password = "Password123!";
  const sRes = await fetch("http://localhost:3001/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, redirect_uri: "http://localhost:3003" })
  });
  assert.strictEqual(sRes.status, 201, "Signup should return 201");

  const lRes = await fetch("http://localhost:3001/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, redirect_uri: "http://localhost:3000" })
  });
  assert.strictEqual(lRes.status, 200, "Login should return 200");
  const lData = await lRes.json();
  assert.ok(!("token" in lData), "JWT must never be in JSON response body");
  assert.strictEqual(lData.redirectUrl, "http://localhost:3000/");

  const setCookie = lRes.headers.get("set-cookie") || "";
  assert.ok(setCookie.includes("HttpOnly"), "Cookie must be HttpOnly");
  return setCookie.split(";")[0];
}

(async () => {
  // --- A. Unauthenticated Redirects & 401s ---
  const r3000 = await fetch("http://localhost:3000/", { redirect: "manual" });
  assert.strictEqual(r3000.status, 307, "Unauth :3000/ must redirect 307");
  assert.ok((r3000.headers.get("location") || "").includes("http://localhost:3001/login"));

  const r3003 = await fetch("http://localhost:3003/", { redirect: "manual" });
  assert.strictEqual(r3003.status, 302, "Unauth :3003/ must redirect 302");

  const r3004 = await fetch("http://localhost:3004/", { redirect: "manual" });
  assert.strictEqual(r3004.status, 307, "Unauth :3004/ must redirect 307");

  for (const apiUrl of [
    "http://localhost:3000/api/cart",
    "http://localhost:3003/api/notes",
    "http://localhost:3005/api/tasks"
  ]) {
    const r = await fetch(apiUrl);
    assert.strictEqual(r.status, 401, `${apiUrl} must return 401 without cookie`);
  }
  console.log("  PASSED: Unauthenticated redirects & 401 protections across all 3 apps");

  // --- E. Security: Invalid JWT, Expired JWT, CORS, Open Redirect, CSRF ---
  const envContent = fs.readFileSync(path.resolve("apps/auth/.env"), "utf8");
  const secret = envContent.match(/^JWT_SECRET=(.*)$/m)[1].trim();
  const expiredToken = jwt.sign({ userId: 1, email: "exp@example.com", role: "user" }, secret, { expiresIn: -10 });

  for (const badCookie of ["token=invalid.jwt.sig", `token=${expiredToken}`]) {
    const r = await fetch("http://localhost:3005/api/tasks", { headers: { Cookie: badCookie } });
    assert.strictEqual(r.status, 401, "Invalid/expired JWT must return 401");
  }

  const badCors = await fetch("http://localhost:3005/api/tasks", { method: "OPTIONS", headers: { Origin: "http://evil.com" } });
  assert.strictEqual(badCors.status, 403, "Unapproved CORS origin must return 403");

  const badAuthCors = await fetch("http://localhost:3001/api/auth/logout", { method: "OPTIONS", headers: { Origin: "http://evil.com" } });
  assert.strictEqual(badAuthCors.status, 403, "Unapproved Auth CORS origin must return 403");

  const cookieA = await loginNewUser("e2eA");
  const cookieB = await loginNewUser("e2eB");

  const badRedirectRes = await fetch("http://localhost:3001/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "nonexistent@example.com", password: "x", redirect_uri: "https://evil.com" })
  });
  assert.strictEqual(badRedirectRes.status, 401);

  const csrfNotes = await fetch("http://localhost:3003/api/notes", {
    method: "POST",
    headers: { Origin: "http://evil.com", "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ title: "CSRF", content: "x" })
  });
  assert.strictEqual(csrfNotes.status, 403, "Cross-origin mutation on Notes must return 403");
  console.log("  PASSED: Invalid/expired JWT, CORS, and CSRF security checks");

  // --- B. Notes App CRUD & User Isolation (:3003) ---
  const nCreate = await fetch("http://localhost:3003/api/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ title: "E2E Note", content: "Hello" })
  });
  assert.strictEqual(nCreate.status, 201);
  const noteId = (await nCreate.json()).note.id;

  const nListA = await (await fetch("http://localhost:3003/api/notes", { headers: { Cookie: cookieA } })).json();
  assert.strictEqual(nListA.notes.length, 1);

  const nUpdA = await fetch(`http://localhost:3003/api/notes/${noteId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ title: "E2E Note Updated", content: "World" })
  });
  assert.strictEqual(nUpdA.status, 200);

  const nUpdB = await fetch(`http://localhost:3003/api/notes/${noteId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookieB },
    body: JSON.stringify({ title: "Hack", content: "Hack" })
  });
  assert.strictEqual(nUpdB.status, 404, "User B must not update User A note");

  const nDelA = await fetch(`http://localhost:3003/api/notes/${noteId}`, { method: "DELETE", headers: { Cookie: cookieA } });
  assert.strictEqual(nDelA.status, 200);
  console.log("  PASSED: Notes App CRUD & user isolation (:3003)");

  // --- C. E-Commerce 3 Products, Round-Robin, Request ID & Cart (:3000) ---
  const traceId = `req_e2e_trace_${Date.now()}`;
  const instances = [];
  let products = [];
  for (let i = 0; i < 3; i++) {
    const pRes = await fetch("http://localhost:3000/api/products", {
      headers: { Cookie: cookieA, "x-request-id": i === 0 ? traceId : `req_rr_${i}` }
    });
    assert.strictEqual(pRes.status, 200);
    const pData = await pRes.json();
    products = pData.products;
    instances.push(pData.handledBy);
  }
  assert.strictEqual(products.length, 3, "Must return exactly 3 products");
  assert.ok(instances.includes("product-1") && instances.includes("product-2") && instances.includes("product-3"), "Round-Robin must hit all 3 replicas");

  const cAdd = await fetch("http://localhost:3000/api/cart", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ product_id: products[0].id, quantity: 2 })
  });
  assert.strictEqual(cAdd.status, 201);
  const cartItemId = (await cAdd.json()).item.id;

  const cPut = await fetch(`http://localhost:3000/api/cart/${cartItemId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ quantity: 3 })
  });
  assert.strictEqual(cPut.status, 200);

  const cDelB = await fetch(`http://localhost:3000/api/cart/${cartItemId}`, { method: "DELETE", headers: { Cookie: cookieB } });
  assert.strictEqual(cDelB.status, 404, "User B must not delete User A cart item");

  const cDelA = await fetch(`http://localhost:3000/api/cart/${cartItemId}`, { method: "DELETE", headers: { Cookie: cookieA } });
  assert.strictEqual(cDelA.status, 200);

  await fetch("http://localhost:3000/api/cart", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ product_id: products[1].id, quantity: 1 })
  });
  const cCheckout = await fetch("http://localhost:3000/api/cart?action=checkout", { method: "DELETE", headers: { Cookie: cookieA } });
  assert.strictEqual(cCheckout.status, 200);
  console.log("  PASSED: E-Commerce 3 products, Round-Robin, Cart & Checkout (:3000)");

  // --- D. Hybrid App Tasks CRUD & User Isolation (:3004 / :3005) ---
  const hPage = await fetch("http://localhost:3004/", { headers: { Cookie: cookieA }, redirect: "manual" });
  assert.strictEqual(hPage.status, 200, "Authenticated user must access :3004/");

  const tCreate = await fetch("http://localhost:3005/api/tasks", {
    method: "POST",
    headers: { Origin: "http://localhost:3004", "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ title: "E2E Task", description: "Verify hybrid" })
  });
  assert.strictEqual(tCreate.status, 201);
  const taskId = (await tCreate.json()).task.id;

  const tComp = await fetch(`http://localhost:3005/api/tasks/${taskId}/status`, {
    method: "PATCH",
    headers: { Origin: "http://localhost:3004", "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ status: "completed" })
  });
  assert.strictEqual(tComp.status, 200);

  const tDelB = await fetch(`http://localhost:3005/api/tasks/${taskId}`, {
    method: "DELETE",
    headers: { Origin: "http://localhost:3004", Cookie: cookieB }
  });
  assert.strictEqual(tDelB.status, 404, "User B must not delete User A task");

  const tDelA = await fetch(`http://localhost:3005/api/tasks/${taskId}`, {
    method: "DELETE",
    headers: { Origin: "http://localhost:3004", Cookie: cookieA }
  });
  assert.strictEqual(tDelA.status, 200);
  console.log("  PASSED: Hybrid App Tasks CRUD, complete & user isolation (:3004/:3005)");

  // --- A2. Centralized Logout ---
  const outRes = await fetch("http://localhost:3001/api/auth/logout", {
    method: "POST",
    headers: { Origin: "http://localhost:3004", "Content-Type": "application/json", Cookie: cookieA },
    body: JSON.stringify({ redirect_uri: "http://localhost:3004" })
  });
  assert.strictEqual(outRes.status, 200);
  const clearedCookie = (outRes.headers.get("set-cookie") || "").split(";")[0];

  for (const apiUrl of [
    "http://localhost:3000/api/cart",
    "http://localhost:3003/api/notes",
    "http://localhost:3005/api/tasks"
  ]) {
    const r = await fetch(apiUrl, { headers: { Cookie: clearedCookie } });
    assert.strictEqual(r.status, 401, `${apiUrl} must return 401 after logout`);
  }
  console.log("  PASSED: Centralized logout invalidates all 3 apps");

  // --- F. Loki Ingestion & Request ID Correlation ---
  await new Promise(r => setTimeout(r, 2500));
  const lokiTraceUrl = `http://localhost:3100/loki/api/v1/query_range?query=${encodeURIComponent(`{job="arch-applications"} |= "${traceId}"`)}`;
  const lokiTraceRes = await (await fetch(lokiTraceUrl)).json();
  const matchedStreams = (lokiTraceRes.data?.result || []).map(s => s.stream.service);
  assert.ok(matchedStreams.includes("web-app"), "Loki trace must include web-app");
  assert.ok(matchedStreams.includes("api-gateway"), "Loki trace must include api-gateway");
  assert.ok(matchedStreams.includes("product-service"), "Loki trace must include product-service");
  console.log("  PASSED: Loki Request ID correlation across:", [...new Set(matchedStreams)].join(" -> "));
})();
'

echo ""
echo ">>> STEP 4: VERIFY LOKI, GRAFANA & ALL 7 SERVICE LABELS..."
LOKI_READY=$(curl -s http://localhost:3100/ready || true)
echo "$LOKI_READY" | grep -iq "ready" || { echo "FAILED: Loki not ready"; exit 1; }

GRAFANA_DASH=$(curl -s -u admin:admin http://localhost:3002/api/search | grep "arch-centralized-logs" || true)
[ -n "$GRAFANA_DASH" ] || { echo "FAILED: Grafana dashboard arch-centralized-logs missing"; exit 1; }

SERVICES_JSON=$(curl -s http://localhost:3100/loki/api/v1/label/service/values)
for svc in auth-service web-app notes-app hybrid-frontend hybrid-backend api-gateway product-service; do
  echo "$SERVICES_JSON" | grep -q "\"$svc\"" || { echo "FAILED: Missing service '$svc' in Loki"; exit 1; }
done
echo "  PASSED: All 7 services verified in Loki & Grafana dashboard loaded."

echo ""
echo "================================================================================"
echo "    CONGRATULATIONS! ALL END-TO-END VERIFICATION TESTS PASSED!                  "
echo "================================================================================"
