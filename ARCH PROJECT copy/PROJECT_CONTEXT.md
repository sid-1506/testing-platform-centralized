# PROJECT_CONTEXT.md — Source of Truth

> **CRITICAL FOR AI CODING AGENTS:**
> - Treat `PROJECT_CONTEXT.md` as the **project-level source of truth**.
> - **Read this file completely** before starting any future implementation task.
> - **Update this file** whenever architecture, implementation status, ports, or project decisions change.
> - **Never invent existing features.** Clearly distinguish verified facts from assumptions or future plans.
> - **Do not replace working architecture unnecessarily.** Prefer reusing existing services and infrastructure.
> - Keep the implementation simple and understandable. Do not introduce unnecessary dependencies or microservices.
> - Do not implement features outside the manager's requirements. If something is unclear, ask before making architectural decisions.

---

## 1. Project Overview & Manager Requirements

### Project Name
**Scalable Multi-Application Architecture with Centralized Authentication and Logging**

### Manager Business Requirements (Target State)
The manager requires **ONE centralized authentication service** and **THREE independent web applications** sharing that single authentication identity, with **centralized structured logging** into the existing Grafana Loki + Alloy stack:

1. **Application 1 — Node.js Notes Web App**
   - Built using **Node.js and Express**.
   - Simple Notes Web App with basic **Create, Read, Update, and Delete (CRUD)** operations.
2. **Application 2 — Next.js E-Commerce App**
   - Built using **Next.js**.
   - Simple e-commerce application with **exactly 3 products**, basic product listing, and **cart functionality**.
3. **Application 3 — Hybrid Application**
   - **Next.js frontend** + **separate Node.js + Express backend**.
   - Simple application / dashboard functionality.
4. **Centralized Authentication (Highest Priority)**
   - **One independent central Auth Service** (`apps/auth`).
   - A user logs in **once** and accesses all three applications without logging in separately.
   - JWT-based authentication stored in **secure `HttpOnly` cookies**.
   - All three applications verify the same authentication identity **statelessly** (avoiding unnecessary DB/HTTP calls to the Auth Service on every request).
   - Proper logout and unauthorized access handling across all apps.
5. **Centralized Logging**
   - Every meaningful user action and API request across all three applications and Auth Service generates **structured JSON logs** (`logs/*.log`), ingested into **Grafana Loki** via **Grafana Alloy**, and visualized in **Grafana** with end-to-end `x-request-id` correlation.

---

## 2. Verified Existing Architecture

> **Audit Note:** Verified directly from source code and configuration files. Note that `LAST_README.md` contains outdated references (e.g., Prometheus, `/metrics`, `registry.ts`, `healthcheck.ts`, `test-phase2.sh`) that do **not** exist in the current codebase.

The repository is an **npm workspaces TypeScript monorepo** (`package.json`, `tsconfig.base.json`) containing:
- **7 workspace packages**:
  - `@arch/auth` (`apps/auth`, Port `3001`) — Independent Auth Service + static HTML Login/Signup UI.
  - `@arch/web` (`apps/web`, Port `3000`) — Application 2: Next.js 16 E-Commerce Storefront fetching 3 products via API Gateway (`:5001`), with persistent per-user shopping cart (`cart_items` in `next_app.db`), stateless JWT verification, and structured logging (`logs/web.log`).
  - `@arch/notes` (`apps/notes`, Port `3003`) — Application 1: Independent Node.js + Express Notes Web App with CRUD, isolated `notes.db`, stateless JWT cookie verification, and `logs/notes.log`.
  - `@arch/hybrid-frontend` (`apps/hybrid/frontend`, Port `3004`) — Application 3 Frontend: Next.js 16 Task Manager UI calling Express backend (`:3005`) with `credentials: 'include'`.
  - `@arch/hybrid-backend` (`apps/hybrid/backend`, Port `3005`) — Application 3 Backend: Express 5 REST API (`/api/tasks`), isolated `hybrid.db` (WAL), stateless JWT verification, strict CORS (`http://localhost:3004`), and `logs/hybrid.log`.
  - `@arch/gateway` (`apps/gateway`, Port `5001`) — Express 5 reverse proxy API Gateway with Round-Robin load balancing, active health checking, fault injection admin endpoint, and 503/502 handling.
  - `@arch/product-service` (`apps/services/product-service`, Ports `6001`, `6002`, `6003`) — Single shared Express 5 codebase run as 3 horizontal replicas backed by a shared SQLite WAL database (`products.db`) auto-seeded with 3 products.
- **Observability Stack (`monitoring/`)**:
  - Docker Compose running **Grafana Loki 3.0.0** (`:3100`), **Grafana Alloy v1.1.0** (`:12345`), and **Grafana latest** (`:3002`).
  - All services append newline-delimited JSON logs to root `./logs/*.log`, which Alloy tails and pushes to Loki.

---

## 3. Existing Folder Structure

```text
ARCH PROJECT/
├── package.json                       # npm workspaces & root scripts
├── package-lock.json
├── tsconfig.base.json                 # Shared strict ES2022/NodeNext TS config
├── README.md                          # Project documentation
├── LAST_README.md                     # Outdated Hinglish presentation guide (contains stale Prometheus refs)
├── PROJECT_CONTEXT.md                 # This source-of-truth document
│
├── apps/
│   ├── auth/                          # @arch/auth (:3001)
│   │   ├── .env / .env.example
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── data/auth.db               # SQLite WAL (users table)
│   │   ├── public/
│   │   │   ├── login.html             # Supports redirect_uri propagation & auto-redirect
│   │   │   └── signup.html            # Supports redirect_uri propagation to /login
│   │   └── src/
│   │       ├── db.ts
│   │       ├── logger.ts
│   │       ├── security.ts            # CORS allowlist, redirect_uri validation, JWT_SECRET guard
│   │       └── server.ts
│   │
│   ├── gateway/                       # @arch/gateway (:5001)
│   │   ├── .env / .env.example
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── loadbalancer.ts        # Instance registry, Round-Robin, 5s health checker
│   │       ├── logger.ts
│   │       └── server.ts              # Reverse proxy /api/v1/products -> /products
│   │
│   ├── services/
│   │   └── product-service/           # @arch/product-service (:6001, :6002, :6003)
│   │       ├── .env / .env.example
│   │       ├── package.json
│   │       ├── tsconfig.json
│   │       ├── data/products.db       # Shared SQLite WAL (products table, 3 seeded items)
│   │       └── src/
│   │           ├── db.ts
│   │           ├── logger.ts
│   │           └── server.ts
│   │
│   ├── notes/                         # @arch/notes (:3003) — App 1: Express Notes App
│   │   ├── .env / .env.example
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── data/notes.db              # SQLite WAL (notes table, scoped by user_id)
│   │   ├── public/index.html          # Notes CRUD UI
│   │   └── src/
│   │       ├── auth.ts                # Stateless JWT middleware & same-origin CSRF guard
│   │       ├── db.ts                  # notes.db CRUD helpers
│   │       ├── logger.ts              # Structured JSON logger -> logs/notes.log
│   │       └── server.ts              # Express server & API routes
│   │
│   ├── hybrid/                        # App 3: Hybrid Task Manager
│   │   ├── frontend/                  # @arch/hybrid-frontend (:3004)
│   │   │   ├── .env.local / .env.example
│   │   │   ├── next.config.js / package.json / tsconfig.json
│   │   │   └── src/
│   │   │       ├── app/ (page.tsx, layout.tsx, api/health/route.ts)
│   │   │       ├── components/TaskManager.tsx
│   │   │       └── lib/ (auth.ts, logger.ts)
│   │   └── backend/                   # @arch/hybrid-backend (:3005)
│   │       ├── .env / .env.example / package.json / tsconfig.json
│   │       ├── data/hybrid.db         # SQLite WAL (tasks table, indexed on user_id)
│   │       └── src/ (auth.ts, db.ts, logger.ts, server.ts)
│   │
│   └── web/                           # @arch/web (:3000) — App 2: Next.js E-Commerce Store
│       ├── .env.local / .env.example
│       ├── AGENTS.md
│       ├── next.config.js
│       ├── package.json
│       ├── tsconfig.json
│       ├── data/next_app.db           # SQLite WAL (preferences & cart_items tables)
│       └── src/
│           ├── app/
│           │   ├── layout.tsx
│           │   ├── page.tsx           # Auth gate (307 -> :3001) + EcommerceStore
│           │   └── api/
│           │       ├── health/route.ts
│           │       ├── cart/route.ts
│           │       ├── cart/[id]/route.ts
│           │       ├── preferences/route.ts
│           │       └── products/route.ts
│           ├── components/
│           │   ├── EcommerceStore.tsx # 3-product storefront + shopping cart UI
│           │   ├── PreferencesForm.tsx
│           │   └── ProductsCatalog.tsx
│           └── lib/
│               ├── auth.ts            # Stateless jwt.verify() from HttpOnly cookie
│               ├── db.ts              # next_app.db helpers & transactional cart ops
│               └── logger.ts
│
├── logs/                              # Mounted read-only into Alloy (/var/log/app)
│   ├── auth.log
│   ├── gateway.log
│   ├── product-service.log
│   └── web.log
│
├── monitoring/
│   ├── docker-compose.yml             # loki (:3100), alloy (:12345), grafana (:3002)
│   ├── alloy/config.alloy             # Tails /var/log/app/*.log -> Loki
│   ├── loki/loki-config.yml           # Local TSDB storage, 168h retention
│   └── grafana/provisioning/
│       ├── datasources/loki.yml       # Default Loki datasource
│       └── dashboards/
│           ├── dashboards.yml
│           └── definitions/logs-dashboard.json
│
└── scripts/
    ├── runner.js                      # Spawns all 6 app processes
    ├── start-all.sh / stop-all.sh
    ├── start-monitoring.sh / stop-monitoring.sh / status-monitoring.sh
    └── test-all.sh                    # E2E verification script
```

---

## 4. Current Services, Ports & Responsibilities

| Service / Component | Workspace / Path | Port | Status | Responsibilities |
| :--- | :--- | :--- | :--- | :--- |
| **Auth Service** | `@arch/auth` (`apps/auth`) | `3001` | Running/Implemented | Signup, login, logout, verify, static login/signup HTML, issues JWT in `HttpOnly` cookie |
| **Next.js Web App** | `@arch/web` (`apps/web`) | `3000` | Running/Implemented | App 2: 3-product E-Commerce Storefront via Gateway (`:5001`), persistent Cart (`next_app.db`), stateless JWT auth |
| **Notes Web App** | `@arch/notes` (`apps/notes`) | `3003` | Running/Implemented | App 1: Express Notes CRUD (`notes.db`), stateless JWT auth, same-origin CSRF guard, `logs/notes.log` |
| **Hybrid Frontend** | `@arch/hybrid-frontend` (`apps/hybrid/frontend`) | `3004` | Running/Implemented | App 3 Frontend: Next.js Task Manager UI, stateless JWT gate, calls `:3005` with credentials |
| **Hybrid Backend** | `@arch/hybrid-backend` (`apps/hybrid/backend`) | `3005` | Running/Implemented | App 3 Backend: Express Tasks CRUD (`hybrid.db`), stateless JWT auth, CORS `:3004`, `logs/hybrid.log` |
| **API Gateway** | `@arch/gateway` (`apps/gateway`) | `5001` | Running/Implemented | Reverse proxy for `/api/v1/products`, Round-Robin LB, 5s health checks, fault injection, `x-request-id` |
| **Product Replica 1** | `@arch/product-service` | `6001` | Running/Implemented | Product CRUD API + health check (`INSTANCE_ID=product-1`) |
| **Product Replica 2** | `@arch/product-service` | `6002` | Running/Implemented | Product CRUD API + health check (`INSTANCE_ID=product-2`) |
| **Product Replica 3** | `@arch/product-service` | `6003` | Running/Implemented | Product CRUD API + health check (`INSTANCE_ID=product-3`) |
| **Grafana UI** | `monitoring/docker-compose.yml` | `3002` | Running/Implemented | Visualizes centralized logs (`arch-centralized-logs`, `admin`/`admin`) |
| **Grafana Loki** | `monitoring/docker-compose.yml` | `3100` | Running/Implemented | Log ingestion & TSDB storage (168h retention) |
| **Grafana Alloy** | `monitoring/docker-compose.yml` | `12345` | Running/Implemented | Tails `./logs/*.log` and pushes parsed JSON logs to Loki |

---

## 5. Existing Authentication Flow (Phase 2 Hardened)

Verified in `apps/auth/src/server.ts`, `apps/auth/src/security.ts`, `apps/auth/public/*.html`, and `apps/web/src/lib/auth.ts`:
1. **Required `JWT_SECRET` Guard**: Both `apps/auth` (`requireJwtSecret()`) and `apps/web` (`getJwtSecret()`) fail clearly when `JWT_SECRET` is missing or unconfigured—no hardcoded fallback secret exists.
2. **Strict CORS Allowlist (`corsMiddleware`)**: `apps/auth` allows `http://localhost:3000`, `http://localhost:3003`, and `http://localhost:3004` (configurable via `ALLOWED_ORIGINS`) with `Access-Control-Allow-Credentials: true`, handles `OPTIONS` preflight (`204`), and rejects unapproved origins (`403` + `CORS_REJECTED` log).
3. **Signup (`POST http://localhost:3001/api/auth/signup`)**: Validates email/password (`>= 6` chars), hashes password with `bcryptjs` (10 rounds), inserts into `auth.db`, validates optional `redirect_uri` against the allowlist, and returns `redirectUrl` + `loginUrl` preserving `redirect_uri`.
4. **Login (`POST http://localhost:3001/api/auth/login`)**: Verifies password with `bcrypt.compare()`, signs JWT `{ userId, email, role }` (`expiresIn: '1h'`), sets `HttpOnly` cookie (`token`, `SameSite=Lax`, `Path=/`, `secure: false` for local HTTP), validates `redirect_uri` against the allowlist (safe fallback `http://localhost:3000`), and returns `redirectUrl` without exposing the JWT in the JSON body.
5. **Dynamic UI Redirects**: `login.html` and `signup.html` read `redirect_uri` from query params, preserve it across `/login` <-> `/signup` links, and `login.html` redirects to the server-validated `redirectUrl` after login. `apps/web/src/app/page.tsx` links unauthenticated users to `http://localhost:3001/login?redirect_uri=http%3A%2F%2Flocalhost%3A3000`.
6. **Stateless Verification (`apps/web/src/lib/auth.ts`)**: `getSessionUser()` reads `cookies().get('token')?.value` and calls `jwt.verify(token, JWT_SECRET)` in-memory. Zero queries to `auth.db` or `apps/auth`.
7. **Verify Endpoint (`GET /api/auth/verify`)**: Supports cookie or `Authorization: Bearer <token>`.
8. **Centralized Logout (`POST /api/auth/logout`)**: Clears the `token` cookie with matching `{ httpOnly: true, secure: false, sameSite: 'lax', path: '/' }` options, supports cross-origin `fetch(..., { credentials: 'include' })` from approved origins, and returns `redirectUrl` (`http://localhost:3001/login?redirect_uri=...`).
9. **Planned Future Integrations**: Ports `3003` (Notes App) and `3004` (Hybrid App) are pre-authorized in the CORS and redirect allowlists, but those applications are not yet built.

---

## 6. Existing Database Architecture

Strict **database-per-service isolation** using SQLite (`better-sqlite3`) in `WAL` mode with `busy_timeout = 5000`:

| Database File | Owner | Schema |
| :--- | :--- | :--- |
| `apps/auth/data/auth.db` | `@arch/auth` only | `users (id, email UNIQUE, password_hash, role, created_at)` |
| `apps/web/data/next_app.db` | `@arch/web` only | `preferences (id, user_id UNIQUE, theme, notes, updated_at)` and `cart_items (id, user_id, product_id, product_name, unit_price, quantity, created_at, updated_at, UNIQUE(user_id, product_id))` |
| `apps/notes/data/notes.db` | `@arch/notes` only | `notes (id, user_id, title, content, created_at, updated_at)` — indexed on `user_id` |
| `apps/hybrid/backend/data/hybrid.db` | `@arch/hybrid-backend` only | `tasks (id, user_id, title, description, status, created_at, updated_at)` — indexed on `user_id` |
| `apps/services/product-service/data/products.db` | `@arch/product-service` (all 3 replicas) | `products (id, name, price, stock, created_at)` — auto-seeded with 3 items: `MacBook Pro M3` (\$1999.99), `Mechanical Keyboard` (\$129.50), `UltraWide 4K Monitor` (\$649.00) |

- `@arch/gateway` is stateless (no database).
- No service queries another service's SQLite file.

---

## 7. Existing Logging & Monitoring Architecture

- **Log Format**: Newline-delimited JSON appended asynchronously to `./logs/<service>.log`.
- **Standard Fields**: `service`, `event`, `timestamp` (UTC ISO), `timestamp_ist` (`+05:30`), `request_id`, `status_code`, `duration_ms`, plus context (`user_id`, `route`, `method`, `instance_id`, `operation`, masked `email`).
- **Alloy Pipeline (`monitoring/alloy/config.alloy`)**:
  - Matches `/var/log/app/*.log` (`job="arch-applications"`).
  - Extracts JSON fields and promotes `service`, `event`, `status_code`, `instance_id` to Loki labels (`request_id` remains in log payload to avoid high-cardinality label explosion).
- **Grafana (`monitoring/grafana/provisioning/dashboards/definitions/logs-dashboard.json`)**:
  - UID: `arch-centralized-logs`, dark theme, timezone `Asia/Kolkata`, refresh `2s`, 22 panels across 5 rows (Overview & Health Summary, Centralized Authentication Monitoring, Three Applications Activity, API Gateway / Product Replicas / Errors, and Request ID Correlation & Unified Live Log Stream).
  - Filterable by `$service` (`auth-service`, `notes-app`, `web-app`, `hybrid-frontend`, `hybrid-backend`, `api-gateway`, `product-service`), `$event`, `$request_id`, and `$search`.

---

## 8. Three Target Applications & Requirements

1. **App 1 — Node.js + Express Notes Web App** (New workspace, e.g. `apps/notes`, suggested port e.g. `3003`)
   - Server-rendered or Express-served HTML/JS UI + Express REST API (`/api/notes`).
   - Isolated SQLite DB (e.g. `apps/notes/data/notes.db`) with `notes (id, user_id, title, content, created_at, updated_at)` scoped by `user_id` from JWT.
   - Full CRUD: Create, Read (list user's notes), Update, Delete.
   - Protected by centralized JWT `HttpOnly` cookie verification.

2. **App 2 — Next.js E-Commerce App** (Reuse & evolve `apps/web` on Port `3000`)
   - **Exactly 3 products** (already seeded in `products.db` via API Gateway `:5001/api/v1/products`).
   - Product listing page fetching via API Gateway (preserving Round-Robin & `x-request-id`).
   - **Cart functionality**: Add to cart, update quantity, remove item, view cart total, clear/checkout cart—persisted per `user_id` in `apps/web/data/next_app.db` (e.g. `cart_items` table) via authenticated Next.js API routes (`/api/cart`).
   - Protected by centralized JWT `HttpOnly` cookie verification.

3. **App 3 — Hybrid Application** (New workspaces: Next.js frontend e.g. `apps/hybrid-web` on port `3004` + separate Node.js/Express backend e.g. `apps/hybrid-api` on port `4001`)
   - Next.js frontend serves the UI and proxies/calls the separate Express backend (forwarding cookie/JWT and `x-request-id`).
   - Separate Express backend owns its own SQLite DB (e.g. `apps/hybrid-api/data/hybrid.db`), verifies the same JWT statelessly, and provides simple application/dashboard functionality (e.g., tasks/activity/KPI summary items CRUD).

---

## 9. Centralized Authentication Design Goals & Cookie Constraints

### Browser Cookie Behavior on `localhost`
- **RFC 6265 Rule**: Cookies are scoped by **host/domain and path**, **NOT by port**. A host-only cookie (`token`, `Path=/`, no `Domain` attribute) set by `http://localhost:3001` **is automatically sent** by the browser to `http://localhost:3000`, `http://localhost:3003`, `http://localhost:3004`, `http://localhost:4001`, etc.
- **Critical Constraints**:
  1. **Strict `localhost` consistency**: Every app, redirect, and link must use `localhost` (never mix `127.0.0.1` with `localhost`, as cookies are not shared between them).
  2. **CORS for cross-port `fetch()`**: Different ports on `localhost` are *same-site* (`SameSite=Lax` allows cookies on top-level navigation and same-site requests) but **different origins**. Any client-side `fetch(..., { credentials: 'include' })` from `:3000`/`:3003`/`:3004` to `:3001` (e.g., logout) **requires** `apps/auth` to configure CORS with an explicit origin allowlist and `credentials: true` (never `Access-Control-Allow-Origin: *`).
  3. **Return-to / `redirect_uri` flow**: When an unauthenticated user visits any of the 3 apps, they should be redirected (or linked) to `http://localhost:3001/login?redirect_uri=<encoded_app_url>`. `apps/auth` must validate `redirect_uri` against an allowlist of known app URLs to prevent open-redirect vulnerabilities.
  4. **Stateless Verification Everywhere**: All 3 apps (and the Hybrid Express backend) verify the `token` cookie in-memory using the shared `JWT_SECRET` (`jsonwebtoken`). No per-request DB/HTTP calls to `:3001`.
  5. **Logout**: Clearing the cookie via `POST /api/auth/logout` (with CORS) or `GET /logout?redirect_uri=...` on `:3001` clears `token` for all `localhost` apps simultaneously.
  6. **No insecure fallback secrets**: Fail fast or warn loudly if `JWT_SECRET` is unset rather than silently falling back to a hardcoded string in production/multi-app setups.

---

## 10. Centralized Logging Requirements

- Every app/backend must write structured JSON logs to `logs/<service>.log` using the existing schema (`service`, `event`, `timestamp`, `timestamp_ist`, `request_id`, `status_code`, `duration_ms`, `user_id`, `route`, `method`).
- **Required logged events**:
  - Auth: `SIGNUP_SUCCESS/FAILED`, `LOGIN_SUCCESS/FAILED`, `LOGOUT`, `VERIFY_SUCCESS/FAILED` (mask emails, never log passwords/JWTs).
  - App Access: `APP_ACCESS` / `AUTH_UNAUTHORIZED` on protected page/API access.
  - Notes App: `NOTES_LIST`, `NOTE_CREATED`, `NOTE_UPDATED`, `NOTE_DELETED`, plus errors.
  - E-Commerce App: `PRODUCTS_LISTED`, `CART_VIEWED`, `CART_ITEM_ADDED`, `CART_ITEM_UPDATED`, `CART_ITEM_REMOVED`, `CART_CHECKOUT` / `CART_CLEARED`, plus Gateway/Product Service correlation.
  - Hybrid App: Frontend API proxy logs + Express Backend request/DB logs with preserved `x-request-id`.
- **End-to-End Request ID Correlation**: Generate `x-request-id` at the entry point if missing, forward it across every HTTP hop (Browser/Frontend -> Backend -> API Gateway -> Product Service), and return it in response headers.
- **Grafana**: Update `logs-dashboard.json` `$service` variable and panels so all services are filterable and visually provable in Grafana (`:3002`).

---

## 11. Implementation Roadmap (Phased)

- **Phase 1 (Complete)**: Full Repository Audit & `PROJECT_CONTEXT.md` creation.
- **Phase 2 (Complete)**: Centralized Auth Hardening (`apps/auth` CORS allowlist, validated `redirect_uri` on login/signup/logout, `JWT_SECRET` fail-fast guard in `apps/auth` and `apps/web`).
- **Phase 3 (Complete)**: App 1 — Node.js + Express Notes App (`apps/notes`, Port `3003`, `notes.db` WAL, CRUD APIs, stateless JWT middleware, same-origin CSRF guard, `logs/notes.log`).
- **Phase 4 (Complete)**: App 2 — Next.js E-Commerce App (`apps/web`, Port `3000`, `cart_items` in `next_app.db`, `/api/cart` CRUD + checkout, Gateway product validation, `EcommerceStore.tsx`, `logs/web.log`).
- **Phase 5 (Complete)**: App 3 — Hybrid Task Manager (`apps/hybrid/frontend` on `:3004` + `apps/hybrid/backend` on `:3005`, `hybrid.db` WAL, Tasks CRUD + status toggle, strict CORS `:3004`, `logs/hybrid.log`).
- **Phase 6 (Complete)**: Monitoring, Scripts & End-to-End Verification — updated `logs-dashboard.json` (22 panels, dark theme, all 7 services), fixed and expanded `scripts/test-all.sh` (all 9 health endpoints, 3-app SSO, CRUD, security, and Loki request ID correlation passing).
  - Create workspace, Express server, SQLite `notes.db` (WAL), JWT cookie middleware, CRUD endpoints + UI, structured logger (`logs/notes.log`).
- **Phase 4: App 2 — Next.js E-Commerce App (`apps/web`)**:
  - Evolve existing Next.js app into a clean 3-product e-commerce storefront with Cart (`next_app.db` `cart_items` table, `/api/cart`), preserving Gateway Round-Robin product fetching and adding structured action logging.
- **Phase 5: App 3 — Hybrid App (`apps/hybrid-web` + `apps/hybrid-api`)**:
  - Create separate Express backend (`hybrid-api` + `hybrid.db` + JWT middleware + `logs/hybrid-api.log`) and Next.js frontend (`hybrid-web` + `logs/hybrid-web.log`) with simple dashboard functionality and `x-request-id` propagation.
- **Phase 6: Monitoring, Scripts & End-to-End Verification**:
  - Update `scripts/runner.js`, `scripts/stop-all.sh`, `package.json`, `logs-dashboard.json`, and `scripts/test-all.sh` to cover all apps, SSO cookie flow, and Loki log ingestion checks.

---

## 12. Completed vs Pending Features

| Feature | Status | Notes |
| :--- | :--- | :--- |
| Monorepo & TypeScript setup | **Completed** | `npm run typecheck` passes across all 4 existing workspaces |
| Auth Service (`:3001`) signup/login/logout/verify | **Completed (Phase 2 Hardened)** | `auth.db`, `HttpOnly` JWT cookie, CORS allowlist, `redirect_uri` validation, `JWT_SECRET` guard |
| Cross-app SSO redirect & CORS logout | **Completed (Verified for `:3000`; `:3003`/`:3004` pre-allowed)** | Tested with `:3000`; `:3003` and `:3004` await Phase 3 & Phase 5 apps |
| API Gateway (`:5001`) Round-Robin & Health Check | **Completed** | Proxies `/api/v1/products` to 3 replicas |
| Product Service (`:6001-6003`) & 3 seeded products | **Completed** | Shared `products.db` in WAL mode |
| Grafana + Loki + Alloy logging pipeline | **Completed (Phase 6)** | All 7 services ingested in Loki; `arch-centralized-logs` (22 panels, dark theme) verified |
| End-to-End Test Suite (`scripts/test-all.sh`) | **Completed (Phase 6)** | Typecheck, 9 health checks, 3-app SSO, CRUD, security & Loki trace correlation passing |
| Next.js E-Commerce App (`:3000`) | **Completed (Phase 4)** | 3 products via Gateway, persistent Cart CRUD + checkout, user isolation, SSO with `:3003`, `logs/web.log` |
| Node.js Express Notes App (`:3003`) | **Completed (Phase 3)** | CRUD verified, user isolation verified, SSO with `:3000` verified, `logs/notes.log` verified |
| Hybrid App (Next.js `:3004` + Express `:3005`) | **Completed (Phase 5)** | Tasks CRUD + status toggle, user isolation, CORS `:3004`, 3-app SSO verified, `logs/hybrid.log` |

---

## 13. Important Constraints & Do-Not-Change Rules

- **Do NOT** replace SQLite (`better-sqlite3` WAL) with external databases unless explicitly requested.
- **Do NOT** change existing working ports (`3000`, `3001`, `3002`, `3100`, `5001`, `6001`, `6002`, `6003`, `12345`) without updating `runner.js`, `stop-all.sh`, `.env`, and `PROJECT_CONTEXT.md`.
- **Do NOT** return JWTs in JSON response bodies or store them in `localStorage`/`sessionStorage`; keep them strictly in `HttpOnly` cookies.
- **Do NOT** allow any application to connect to `auth.db` or maintain its own user/login table.
- **Do NOT** introduce Prometheus or extra monitoring containers; reuse the existing Alloy + Loki + Grafana stack.
- **Do NOT** expose PII (passwords, raw JWTs, unmasked emails) in logs.

---

## 14. Testing & Verification Requirements

- `npm run typecheck` must pass with 0 errors across all workspaces.
- Single login at `:3001` must grant authenticated access to all 3 apps without re-login; unauthenticated requests must be rejected (`401` on APIs, redirect/prompt on UI).
- Logout must clear the session across all 3 apps.
- All CRUD/cart/dashboard actions must persist in their respective isolated SQLite databases.
- `scripts/test-all.sh` and manual browser verification must confirm:
  - Round-Robin distribution across `product-1`, `product-2`, `product-3`.
  - End-to-end `x-request-id` correlation in `logs/*.log` and **Grafana (`http://localhost:3002`)** proving user actions trigger real API requests.
