# Complete Manual Execution & Testing Guide

This guide provides verified, step-by-step instructions to start, operate, test, and demonstrate the **Scalable Multi-Application Architecture with Centralized Authentication and Logging** from your terminal and Chrome browser.

---

## 1. Project Overview

The system consists of **1 Central Authentication Service**, **3 independent user-facing web applications**, **1 API Gateway**, **3 Product Service replicas**, and a **Docker-based Grafana + Loki + Alloy monitoring stack**:

- **Central Auth (`:3001`)**: Issues `HttpOnly` JWT cookies (`token`, 1h expiry) using `bcryptjs` and SQLite (`apps/auth/data/auth.db`). All 3 applications authenticate users through this single service.
- **Notes App (`:3003`)**: Pure Node.js + Express + TypeScript CRUD app with its own SQLite DB (`apps/notes/data/notes.db`).
- **E-Commerce App (`:3000`)**: Next.js App Router storefront with its own SQLite cart/preferences DB (`apps/web/data/next_app.db`), fetching 3 products through the API Gateway (`:5001`).
- **Hybrid Task Manager (`:3004` + `:3005`)**: Next.js frontend (`:3004`) communicating with an independent Express REST backend (`:3005`) and SQLite DB (`apps/hybrid/backend/data/hybrid.db`).
- **API Gateway (`:5001`) & Product Replicas (`:6001`, `:6002`, `:6003`)**: Round-Robin load balancer forwarding `/api/v1/products` requests with `x-request-id` correlation headers.
- **Centralized Logging (`:3100`, `:12345`, `:3002`)**: Services write structured JSON logs to `./logs/*.log`, Grafana Alloy tails them, Loki indexes labels (`service`, `event`, `status_code`, `instance_id`), and Grafana visualizes everything.

---

## 2. All Application & Service URLs

> **IMPORTANT:** Always use `http://localhost:...` consistently in Chrome. **Never** mix `localhost` and `127.0.0.1`, because browsers treat them as different cookie hosts and SSO will fail.

### User-Facing URLs (Open in Chrome)

| Application | Technology | Browser URL | Purpose |
|---|---|---|---|
| **Central Auth** | Node.js + Express | `http://localhost:3001/login` | Login / Signup UI |
| **Notes App** | Node.js + Express | `http://localhost:3003` | Notes CRUD Web App |
| **E-Commerce** | Next.js | `http://localhost:3000` | 3-Product Storefront + Cart |
| **Hybrid Frontend** | Next.js | `http://localhost:3004` | Task Manager Dashboard UI |
| **Grafana** | Grafana | `http://localhost:3002` | Centralized Logs Dashboard |

### Backend-Only & Infrastructure Services (Do Not Open as Web Apps)

| Service | Technology | URL | Purpose |
|---|---|---|---|
| **Hybrid Backend** | Node.js + Express | `http://localhost:3005` | Task REST APIs (`/api/tasks`) |
| **API Gateway** | Node.js + Express | `http://localhost:5001` | Round-Robin Load Balancer (`/api/v1/products`) |
| **Product Replica 1** | Node.js + Express | `http://localhost:6001` | Product Microservice (`INSTANCE_ID=product-1`) |
| **Product Replica 2** | Node.js + Express | `http://localhost:6002` | Product Microservice (`INSTANCE_ID=product-2`) |
| **Product Replica 3** | Node.js + Express | `http://localhost:6003` | Product Microservice (`INSTANCE_ID=product-3`) |
| **Loki** | Grafana Loki | `http://localhost:3100` | Log aggregation & LogQL API |
| **Alloy** | Grafana Alloy | `http://localhost:12345` | Log shipper tailing `./logs/*.log` |

---

## 3. Exact Startup, Health & Shutdown Commands

Run all commands from the project root directory (the `ARCH PROJECT copy` folder of this repository).

### Terminal Order

Start **Monitoring first** (Docker), then **Applications second** (Node/Next.js):

#### 1. Start Monitoring Stack (Loki, Alloy, Grafana)
```bash
npm run start:monitoring
# or directly: ./scripts/start-monitoring.sh
```

#### 2. Start All Applications & Microservices
```bash
npm run start:all
# or directly: ./scripts/start-all.sh
```
*(Wait ~5–10 seconds for Next.js dev servers on ports `3000` and `3004` to finish compiling.)*

#### 3. Start Individual Applications (If Debugging One Service)
Only use these if you are **not** running `start:all`:
```bash
npm run start:auth              # Port 3001
npm run start:product-1         # Port 6001 (INSTANCE_ID=product-1)
npm run start:product-2         # Port 6002 (INSTANCE_ID=product-2)
npm run start:product-3         # Port 6003 (INSTANCE_ID=product-3)
npm run start:gateway           # Port 5001
npm run start:web               # Port 3000
npm run start:notes             # Port 3003
npm run start:hybrid            # Ports 3004 + 3005 together
npm run start:hybrid:backend    # Port 3005 only
npm run start:hybrid:frontend   # Port 3004 only
```

#### 4. Check Whether Services Are Running
```bash
npm run status:monitoring
lsof -nP -iTCP:3000,3001,3002,3003,3004,3005,5001,6001,6002,6003 -sTCP:LISTEN
```

#### 5. Check All 9 Application Health Endpoints
```bash
for url in \
  http://localhost:3001/health \
  http://localhost:3000/api/health \
  http://localhost:3003/health \
  http://localhost:3004/api/health \
  http://localhost:3005/health \
  http://localhost:5001/health \
  http://localhost:6001/health \
  http://localhost:6002/health \
  http://localhost:6003/health; do
  echo -n "$url -> "
  curl -s -o /dev/null -w "%{http_code}\n" "$url"
done
```
All 9 URLs should return `200`.

#### 6. Run Automated End-to-End Verification
```bash
npm run test:all
# or directly: ./scripts/test-all.sh
```

#### 7. Stop All Services
```bash
npm run stop:all          # Stops all Node/Next.js apps (ports 3000,3001,3003,3004,3005,5001,6001-6003)
npm run stop:monitoring   # Stops Docker containers (loki, alloy, grafana)
```

#### 8. Restart Everything Cleanly
```bash
npm run stop:all && npm run stop:monitoring && npm run start:monitoring && npm run start:all
```

---

## 4. Login and Signup Instructions

- **Login URL:** `http://localhost:3001/login`
- **Signup URL:** `http://localhost:3001/signup`
- **Seed / Default Demo User:** **None exists.** Inspection of `apps/auth/src/db.ts` and `apps/auth/src/server.ts` confirms there is no seed script and no hardcoded default user. You must create your own account first.

### Option A: Create Your Account via Browser UI (Recommended)
1. Open `http://localhost:3001/signup` in Chrome.
2. Enter any valid email (e.g., `demo@example.com`) and a password of **at least 6 characters**.
3. Submit the form. `apps/auth` hashes your password with `bcryptjs` (10 salt rounds) and saves it to `apps/auth/data/auth.db`.
4. You will be redirected to `/login` to sign in.

### Option B: Create a Development-Only User via Terminal (`curl`)
```bash
curl -s -X POST http://localhost:3001/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"dev-demo@example.com","password":"Password123!"}'
```
*(DEVELOPMENT ONLY — uses the official `/api/auth/signup` endpoint and `bcryptjs` hashing. Change the email/password to anything you prefer.)*

---

## 5. Complete Centralized Authentication (SSO) Demonstration

Follow these exact steps in **Google Chrome** using `localhost`:

1. **Open an Incognito Chrome window** (ensures no stale cookies exist).
2. **Open Notes App unauthenticated:** Navigate to `http://localhost:3003`.
   - **Expected:** Immediate redirect to `http://localhost:3001/login?redirect_uri=http%3A%2F%2Flocalhost%3A3003`.
3. **Create an account or log in:** Click **Sign Up** (if you haven't created an account yet) or enter your email and password and click **Login**.
4. **Verify Notes App opens:** After login succeeds, Central Auth automatically redirects you back to `http://localhost:3003` and loads the Notes App with your email shown.
5. **Open E-Commerce in the same Incognito window:** Open a new tab and go to `http://localhost:3000`.
   - **Expected:** Storefront opens immediately **without asking you to log in again**.
6. **Open Hybrid Task Manager in the same Incognito window:** Open a new tab and go to `http://localhost:3004`.
   - **Expected:** Task Manager dashboard opens immediately **without asking you to log in again**.
7. **Verify `HttpOnly` Cookie in Chrome DevTools:**
   - Press `Cmd + Option + I` (Mac) to open DevTools.
   - Go to **Application** -> **Storage** -> **Cookies** -> `http://localhost:3004` (or `3000` / `3003`).
   - Find the cookie named `token`.
   - Verify:
     - **HttpOnly:** `✓` (checked — JavaScript `document.cookie` cannot read it)
     - **SameSite:** `Lax`
     - **Path:** `/`
8. **Sign Out from ONE application:** Click the **Sign Out** button in any app (e.g., Hybrid Task Manager on `:3004`).
   - **Expected:** Calls `POST http://localhost:3001/api/auth/logout`, clears the `token` cookie, and redirects to `http://localhost:3001/login`.
9. **Test the other two applications:** Switch to the Notes (`:3003`) and E-Commerce (`:3000`) tabs and refresh (`Cmd + R`).
   - **Expected:** Both reject unauthenticated access and redirect back to `http://localhost:3001/login`.
10. **Log in again:** Sign in once on `:3001/login` and verify all three apps (`:3003`, `:3000`, `:3004`) work again.

### Why This Works Technically
In browsers, cookies are scoped by **domain (`localhost`) and path (`/`)**, **not by port**. When Central Auth (`localhost:3001`) sets `Set-Cookie: token=<jwt>; HttpOnly; SameSite=Lax; Path=/`, Chrome sends that same `token` cookie to `localhost:3000`, `localhost:3003`, `localhost:3004`, and `localhost:3005`. Each app verifies the JWT signature in-memory using the shared `JWT_SECRET` without ever querying `auth.db`.

---

## 6. Manual Functionality Testing

### A. Notes App — `http://localhost:3003`
1. **Create Note:** Enter a title and content in the form and submit.
   - **Expected:** Note appears immediately in the list (`POST /api/notes` -> `201`).
2. **View Notes:** Refresh the page (`Cmd + R`).
   - **Expected:** Your notes remain visible (persisted in `apps/notes/data/notes.db`).
3. **Update Note:** Click **Edit** on a note, modify the title/content, and save.
   - **Expected:** Updated text and timestamp appear (`PUT /api/notes/:id` -> `200`).
4. **Delete Note:** Click **Delete** on a note.
   - **Expected:** Note disappears from the list and stays deleted after refresh (`DELETE /api/notes/:id` -> `200`).

### B. E-Commerce Storefront — `http://localhost:3000`
1. **View Exact 3 Products:** Load `http://localhost:3000`.
   - **Expected:** Displays **MacBook Pro M3**, **Mechanical Keyboard**, and **UltraWide 4K Monitor** fetched via `GET /api/products` -> API Gateway (`:5001`) -> Product Service (`:6001`–`:6003`).
2. **Add Product to Cart:** Click **Add to Cart** on any product.
   - **Expected:** Cart drawer/section updates with item and total (`POST /api/cart` -> `201`).
3. **Increase Quantity:** Click `+` next to a cart item.
   - **Expected:** Quantity and subtotal increase (`PATCH /api/cart/:id` -> `200`).
4. **Remove Product:** Click **Remove** on an item.
   - **Expected:** Item is removed from cart (`DELETE /api/cart/:id` -> `200`).
5. **Verify Cart Persistence:** Add an item, then refresh (`Cmd + R`).
   - **Expected:** Cart item remains (persisted in `apps/web/data/next_app.db`).
6. **Checkout:** Click **Checkout ($...)**.
   - **Expected:** Shows `"Checkout complete! Your order has been placed."` and clears cart (`DELETE /api/cart?checkout=true`).

#### How to Verify API Gateway Round-Robin Load Balancing
Run 6 consecutive requests directly against the gateway and inspect the `X-Handled-By` response header:
```bash
for i in 1 2 3 4 5 6; do
  curl -s -i http://localhost:5001/api/v1/products | grep -i "x-handled-by"
done
```
**Expected output:** Alternates cleanly across `product-1`, `product-2`, and `product-3`. You can also see `handledBy` in the `/api/products` JSON response and `instance_id` in `logs/gateway.log`.

### C. Hybrid Task Manager — `http://localhost:3004` (Frontend) + `http://localhost:3005` (Backend)
1. **Create Task:** Enter a title and description, then submit.
   - **Expected:** Task appears under **Pending** tasks (`POST http://localhost:3005/api/tasks`).
2. **View Tasks:** Refresh (`Cmd + R`).
   - **Expected:** Tasks remain loaded from `apps/hybrid/backend/data/hybrid.db`.
3. **Update Task:** Edit an existing task's title/description and save (`PUT http://localhost:3005/api/tasks/:id`).
4. **Mark Task Completed:** Click the complete/toggle button on a pending task.
   - **Expected:** Status changes to `completed` and moves to Completed view (`PATCH http://localhost:3005/api/tasks/:id/status`).
5. **Delete Task:** Click Delete on a task (`DELETE http://localhost:3005/api/tasks/:id`).

#### How Next.js (`:3004`) Communicates with Express (`:3005`)
- Next.js Server Component (`apps/hybrid/frontend/src/app/page.tsx`) verifies the `token` cookie server-side and passes `backendUrl` (`http://localhost:3005`) to `<TaskManager />`.
- The browser client sends `fetch('http://localhost:3005/api/tasks', { credentials: 'include', headers: { 'x-request-id': ... } })`.
- Express (`:3005`) accepts cross-origin requests from `http://localhost:3004` with `credentials: true` and verifies the `HttpOnly` `token` cookie in `apps/hybrid/backend/src/auth.ts`.

---

## 7. Grafana Manual Verification

- **Grafana URL:** `http://localhost:3002`
- **Direct Dashboard URL:** `http://localhost:3002/d/arch-centralized-logs`
- **Login Required:** Yes (`GF_USERS_ALLOW_SIGN_UP=false` in `monitoring/docker-compose.yml`)
- **Credentials:** Username `admin` / Password `admin` (configured in `monitoring/docker-compose.yml`)

### Using the Dashboard
1. Open `http://localhost:3002/d/arch-centralized-logs` and sign in with `admin` / `admin`.
2. **Time Range:** Top-right dropdown -> select **Last 15 minutes**.
3. **Auto-Refresh:** Top-right refresh picker -> defaults to `2s` (or click the refresh icon).
4. **Filter by Service:** Use the top **$service** dropdown (`auth-service`, `web-app`, `notes-app`, `hybrid-frontend`, `hybrid-backend`, `api-gateway`, `product-service`).
5. **Filter by Event:** Use the **$event** dropdown (e.g., `LOGIN_SUCCESS`, `CART_ITEM_ADDED`).
6. **Trace by Request ID:** Paste a `request_id` (e.g., `req_...`) into the **$request_id** box to see every hop across services.

### Verified LogQL Queries (Explore -> Loki)
```logql
{service="auth-service"}
{service="auth-service", event="LOGIN_SUCCESS"}
{service="notes-app", event="NOTE_CREATED"}
{service="web-app", event="CART_ITEM_ADDED"}
{service="hybrid-backend", event="TASK_CREATED"}
{service=~".+"} | json | request_id="<paste_request_id_here>"
```

### Browser Action -> Expected Log Event Mapping (Verified from Source Code)

| Browser Action | Service | Expected `event` Label |
|---|---|---|
| Sign up | `auth-service` | `SIGNUP_SUCCESS` |
| Log in | `auth-service` | `LOGIN_SUCCESS` |
| Invalid login | `auth-service` | `LOGIN_FAILED` |
| Sign out | `auth-service` | `LOGOUT` |
| Open Notes / Hybrid | `notes-app` / `hybrid-frontend` | `APP_ACCESS` |
| Create Note | `notes-app` | `NOTE_CREATED` |
| Update Note | `notes-app` | `NOTE_UPDATED` |
| Delete Note | `notes-app` | `NOTE_DELETED` |
| Load Storefront Products | `web-app` / `api-gateway` | `PRODUCTS_LISTED` / `REQUEST_ROUTED` / `RESPONSE_FORWARDED` |
| Add Cart Item | `web-app` | `CART_ITEM_ADDED` |
| Update Cart Quantity | `web-app` | `CART_ITEM_UPDATED` |
| Remove Cart Item | `web-app` | `CART_ITEM_REMOVED` |
| Checkout | `web-app` | `CART_CHECKOUT` |
| Create Task | `hybrid-backend` | `TASK_CREATED` |
| Update Task | `hybrid-backend` | `TASK_UPDATED` |
| Complete Task | `hybrid-backend` | `TASK_COMPLETED` |
| Delete Task | `hybrid-backend` | `TASK_DELETED` |

---

## 8. Terminal-Based Log & Pipeline Inspection

### Tail Live Logs
```bash
tail -f logs/auth.log
tail -f logs/notes.log
tail -f logs/web.log
tail -f logs/gateway.log
tail -f logs/product-service.log
tail -f logs/hybrid.log
```

### Filter Structured JSON Logs by Event or `request_id` (macOS Built-In Tools)
```bash
# Filter by event name
grep '"event":"LOGIN_SUCCESS"' logs/auth.log | tail -n 10

# Trace a single request_id across all log files
grep "req_17" logs/*.log

# Pretty-print the last 5 JSON lines from auth.log using Node.js
tail -n 5 logs/auth.log | node -e '
  const lines = require("fs").readFileSync(0, "utf8").trim().split("\n");
  lines.forEach(l => console.log(JSON.stringify(JSON.parse(l), null, 2)));
'
```

### Verify Alloy & Loki Are Receiving Logs
```bash
# 1. Check Alloy readiness
curl -s http://localhost:12345/ready && echo ""

# 2. Check Loki readiness
curl -s http://localhost:3100/ready && echo ""

# 3. List all services currently indexed in Loki
curl -s "http://localhost:3100/loki/api/v1/label/service/values"
```

---

## 9. Troubleshooting Guide

| Issue | 1. How to Identify | 2. Terminal Command | 3. File to Inspect | 4. Likely Fix |
|---|---|---|---|---|
| **Port already in use** | App exits with `EADDRINUSE` | `lsof -ti :3000,3001,3003,3004,3005,5001,6001,6002,6003` | `scripts/stop-all.sh` | Run `npm run stop:all` then `npm run start:all`. |
| **App not starting** | Health check returns `000` | `cat /tmp/runner_all.log` | `scripts/runner.js`, `apps/*/.env` | Ensure `JWT_SECRET` is set in all `.env`/`.env.local` files and `npm install` was run. |
| **Login failing (401)** | UI shows `"Invalid email or password"` | `tail -n 10 logs/auth.log` | `apps/auth/src/server.ts` | Ensure you signed up first at `http://localhost:3001/signup` (password >= 6 chars). |
| **Invalid JWT / 401 loop** | Logged in, but apps still reject | `grep 'VERIFY_FAILED' logs/auth.log` | `apps/*/.env`, `apps/*/.env.local` | Ensure `JWT_SECRET` is **identical** across `auth`, `web`, `notes`, `hybrid/frontend`, and `hybrid/backend`. |
| **Redirect loop** | Browser bounces between app and `:3001` | `curl -I http://localhost:3003` | `apps/auth/src/security.ts` | Always use `http://localhost:...`, never `127.0.0.1`. Check `ALLOWED_ORIGINS`. |
| **Cookie not appearing** | `token` missing in DevTools Cookies | `curl -i -X POST http://localhost:3001/api/auth/login ...` | `apps/auth/src/security.ts` | Use `http://localhost` (not `127.0.0.1`). `COOKIE_OPTIONS.secure` must stay `false` for local HTTP. |
| **CORS errors** | Browser console shows CORS blocked | `grep 'CORS_REJECTED' logs/auth.log` | `apps/auth/src/security.ts`, `apps/hybrid/backend/src/server.ts` | Access apps only via `http://localhost:3000`, `3003`, `3004`. |
| **Cart not loading** | E-commerce cart empty or 500 error | `tail -n 20 logs/web.log` | `apps/web/src/app/api/cart/route.ts` | Check `apps/web/data/` permissions and verify user is logged in. |
| **Tasks not loading** | Hybrid UI shows network/API error | `curl -s http://localhost:3005/health && tail -n 20 logs/hybrid.log` | `apps/hybrid/frontend/.env.local`, `apps/hybrid/backend/src/server.ts` | Verify `:3005` is running and `NEXT_PUBLIC_BACKEND_URL=http://localhost:3005`. |
| **Grafana shows no logs** | Dashboard panels say "No data" | `./scripts/status-monitoring.sh` | `monitoring/alloy/config.alloy` | Set Grafana time range to **Last 15 minutes** and generate traffic (e.g., load `:3000`). |
| **Loki datasource errors** | Grafana shows red datasource alert | `docker logs arch-loki --tail 20` | `monitoring/grafana/provisioning/datasources/` | Run `npm run stop:monitoring && npm run start:monitoring`. |
| **Alloy not collecting logs** | `./logs/*.log` grows, Loki stays empty | `docker logs arch-alloy --tail 20` | `monitoring/docker-compose.yml` | Ensure `./logs` existed before Docker mounted it (`./scripts/start-monitoring.sh` creates it). |
| **Request IDs missing** | `request_id` blank in logs | `curl -i http://localhost:5001/api/v1/products` | `apps/gateway/src/server.ts`, `apps/web/src/app/api/products/route.ts` | Ensure requests go through Gateway (`:5001`) or app routes that generate `x-request-id`. |

---

## 10. Final Manager Demonstration Checklist

- [ ] `npm run start:monitoring` -> `arch-loki`, `arch-alloy`, `arch-grafana` are UP
- [ ] `npm run start:all` -> All 9 app/service health endpoints return `200`
- [ ] Incognito Chrome -> `http://localhost:3003` redirects to `http://localhost:3001/login`
- [ ] Sign up / Log in once -> Notes App (`:3003`) opens
- [ ] Open `http://localhost:3000` & `http://localhost:3004` -> Both open without a second login
- [ ] DevTools -> `token` cookie has `HttpOnly` checked
- [ ] Demo Notes CRUD (`:3003`), E-Commerce 3 products + Cart + Checkout (`:3000`), Hybrid Tasks (`:3004`)
- [ ] Click **Sign Out** in one app -> Other two apps redirect to login on refresh
- [ ] Open `http://localhost:3002/d/arch-centralized-logs` (`admin` / `admin`) -> Show all 7 services & `$request_id` trace
- [ ] Run `npm run test:all` -> All automated E2E tests pass
