# MVP Implementation Plan (`IMPLEMENTATION_PLAN.md`)

> **Status:** Planning Complete — Awaiting Approval Before Writing Application Code  
> **Scope:** Implementation roadmap for `testing-dashboard/` and `testing-suites/`. No code has been written, no dependencies installed, and `ARCH PROJECT copy/` remains untouched.

---

## 1. Completed Work vs. Planned Work

### Completed (Current State)
- Inspected `ARCH PROJECT copy/` (7 npm workspaces, TypeScript, Express 5, Next.js 16, React 18, SQLite/`better-sqlite3`, no existing test frameworks).
- Created [README.md](./README.md) with confirmed manager requirements and repository boundaries.
- Created and updated [ARCHITECTURE.md](./ARCHITECTURE.md) with approved MVP stack decisions and mandatory security/isolation corrections.

### Planned (Upcoming Implementation)
- Build `testing-dashboard/` (React + Vite + TypeScript frontend; Node.js + Express + TypeScript backend).
- Build `testing-suites/` (Vitest for Unit & Integration/API; Playwright for browser E2E).
- Deliver the MVP in 5 small, verifiable milestones, starting with a complete Unit-test vertical slice before adding multi-service startup and browser E2E.

---

## 2. Expected Folder & File Structure

### `testing-dashboard/`
Responsibilities: App registration, read-only codebase inspection, deterministic Testing Pyramid recommendations, isolated execution orchestration, process/port safety, secret redaction, and `.runs/` JSON persistence + React UI.

```text
testing-dashboard/
├── package.json                      # Root scripts to run backend + frontend
├── apps.registry.json                # Registered target apps, ports, health URLs, explicit testEnv
├── .runs/                            # Local JSON run history & sanitized logs (gitignored)
│   └── <runId>/
│       ├── result.json               # NormalizedTestRun output
│       └── run.log                   # Secret-redacted execution log
├── backend/
│   ├── package.json                  # express, cors, tsx, typescript, @types/*
│   ├── tsconfig.json
│   └── src/
│       ├── server.ts                 # Express API server & graceful shutdown cleanup
│       ├── routes/
│       │   ├── apps.ts               # GET /api/apps, GET /api/apps/:id/inspect
│       │   └── runs.ts               # POST /api/runs, GET /api/runs, GET /api/runs/:runId
│       ├── services/
│       │   ├── registry.ts           # Loads & validates apps.registry.json (path canonicalization)
│       │   ├── inspector.ts          # Read-only static analyzer + rule-based Pyramid recommendations
│       │   ├── workspace.ts          # Creates/cleans temp isolated app copies (explicit testEnv, no .env blind copy)
│       │   ├── processManager.ts     # Pre-flight port checks, platform-owned PID tracking & cleanup
│       │   ├── logSanitizer.ts       # Redacts registered secrets, JWTs, Cookie/Auth headers
│       │   └── runStore.ts           # Reads/writes NormalizedTestRun JSON under .runs/
│       ├── adapters/
│       │   ├── types.ts              # RunnerAdapter interface & NormalizedTestRun types
│       │   ├── vitestAdapter.ts      # Runs Vitest with --reporter=json & normalizes output
│       │   └── playwrightAdapter.ts  # Runs Playwright with --reporter=json & normalizes output
│       └── types.ts
└── frontend/
    ├── package.json                  # react, react-dom, vite, typescript
    ├── tsconfig.json
    ├── vite.config.ts                # Proxies /api/* to backend
    └── src/
        ├── App.tsx                   # Main layout: App selector, Inspector view, Run button, Results
        ├── api/client.ts             # Typed fetch wrapper for backend API
        ├── components/
        │   ├── AppSelector.tsx       # Select registered app (ARCH PROJECT copy)
        │   ├── ArchitectureSummary.tsx # Displays detected workspaces, tech stack & existing tests
        │   ├── PyramidRecommendations.tsx # Displays rule-based Unit/Integration/E2E recommendations
        │   ├── RunControls.tsx       # Layer/suite selector + Run button + active status
        │   └── RunResults.tsx        # Normalized pass/fail summary, test cases, errors, sanitized logs
        └── main.tsx
```

### `testing-suites/`
Responsibilities: Externally maintained test cases and test runner dependencies, completely isolated from `ARCH PROJECT copy/`.

```text
testing-suites/
├── package.json                      # vitest, @playwright/test, typescript
├── tsconfig.json
└── arch-project/
    ├── vitest.config.ts              # Resolves TARGET_APP_DIR from env; outputs JSON report
    ├── playwright.config.ts          # Targets local URLs; outputs JSON report
    ├── unit/
    │   └── security.test.ts          # First external unit test (e.g., apps/auth/src/security.ts)
    ├── integration/
    │   └── auth-health.test.ts       # API/integration tests against isolated running services
    └── e2e/
        └── sso-login.spec.ts         # Browser E2E test for SSO login/redirect flow
```

---

## 3. Milestones

### Milestone 1: Project Scaffolding & App Registry
- **Goal:** Create the `testing-dashboard/` (backend + frontend) and `testing-suites/` skeletons and register `ARCH PROJECT copy/`.
- **Deliverables:**
  - `testing-dashboard/backend` Express + TypeScript health endpoint (`GET /api/health`).
  - `testing-dashboard/frontend` React + Vite + TypeScript shell connecting to `/api/health`.
  - `testing-dashboard/apps.registry.json` registering `arch-project` (`ARCH PROJECT copy/` path, `testing-suites/arch-project` path, required ports, health endpoints, and explicit `testEnv` template—no `.env` file path).
  - `testing-suites/package.json` with `vitest` and `@playwright/test` installed locally in `testing-suites/`.
- **Prerequisites:** Node.js & npm available locally; user approval to begin implementation.
- **Risks & Mitigations:**
  - *Risk:* Path resolution issues across spaces in `ARCH PROJECT copy/`. *Mitigation:* Quote/resolve all paths via `path.resolve()` and never pass unquoted paths to shell strings.
- **Manual Verification:**
  1. Start backend and frontend dev servers; confirm `GET /api/health` returns `200` and UI loads.
  2. Confirm `git status` / file timestamps show zero changes inside `ARCH PROJECT copy/`.

---

### Milestone 2: Read-Only Codebase Inspector & Rule-Based Strategy Engine
- **Goal:** Inspect `ARCH PROJECT copy/` in read-only mode and generate deterministic Testing Pyramid recommendations from codebase evidence.
- **Deliverables:**
  - `inspector.ts`: Reads `package.json` workspaces, dependencies, `tsconfig`, existing test scripts (`scripts/test-all.sh`), pure modules (`security.ts`, `loadbalancer.ts`), API servers/routes, and frontend pages.
  - Rule-based recommendation engine: Maps detected evidence to concrete Unit, Integration, and E2E recommendations (no AI, no hardcoded 70/20/10 ratio).
  - `GET /api/apps` and `GET /api/apps/:id/inspect` endpoints + `ArchitectureSummary` and `PyramidRecommendations` UI components.
- **Prerequisites:** Milestone 1 complete.
- **Risks & Mitigations:**
  - *Risk:* Inspector accidentally writes temp files or follows circular symlinks. *Mitigation:* Use read-only `fs.promises.readFile`/`readdir` with depth limits and ignore `node_modules`/`.git`.
- **Manual Verification:**
  1. Open dashboard, select `arch-project`, and verify it accurately lists all 7 workspaces, Express/Next.js/SQLite/TypeScript, and "0 test frameworks installed".
  2. Verify recommendations cite real files from `ARCH PROJECT copy/` (e.g., `apps/auth/src/security.ts`, `apps/gateway/src/loadbalancer.ts`).

---

### Milestone 3: First Working Flow — External Unit Test Execution & Dashboard Display
- **Goal:** Demonstrate the complete end-to-end MVP loop with **one real external Unit test** against `ARCH PROJECT copy/`.
- **Deliverables:**
  - `workspace.ts`: Copies `ARCH PROJECT copy/` source & dependencies into `/tmp/testing-platform-runs/<runId>/app` (excluding `.env` files; injecting explicit `testEnv` only; no mutable `node_modules` symlink).
  - `logSanitizer.ts`: Redacts registered secrets before saving or returning logs.
  - `vitestAdapter.ts`: Executes `testing-suites/arch-project/unit/security.test.ts` via Vitest with `--reporter=json` and `TARGET_APP_DIR` pointing to the temp copy.
  - `runStore.ts`: Saves `NormalizedTestRun` JSON and sanitized `run.log` under `testing-dashboard/.runs/<runId>/`.
  - `POST /api/runs` + `GET /api/runs/:runId` + `RunControls` & `RunResults` UI components.
- **Prerequisites:** Milestone 2 complete.
- **Risks & Mitigations:**
  - *Risk:* Importing TypeScript files from `TARGET_APP_DIR` fails due to module resolution or missing `JWT_SECRET` at import time. *Mitigation:* Configure `vitest.config.ts` alias/env and pass explicit test-only `JWT_SECRET` via `testEnv`.
  - *Risk:* Copying `node_modules` is slow. *Mitigation:* Measure copy time on Milestone 3; for Unit tests that only import pure TS modules with zero external runtime deps, allow targeted workspace copy if needed while still never symlinking mutable `node_modules`.
- **Manual Verification:**
  1. Click **Run (Unit)** in the dashboard for `arch-project`.
  2. Verify Vitest actually executes `security.test.ts` against the temp copy (also test a deliberate failing assertion temporarily to confirm real failure reporting, then restore).
  3. Verify `testing-dashboard/.runs/<runId>/result.json` exists with normalized pass/fail counts and the dashboard displays the real result.
  4. Verify temp workspace is cleaned up and `ARCH PROJECT copy/` is completely unchanged.

---

### Milestone 4: Platform-Managed App Startup, Port Guard & Integration/API Tests
- **Goal:** Support Integration/API tests by safely starting `ARCH PROJECT copy/` services in the isolated temp copy.
- **Deliverables:**
  - `processManager.ts`:
    - Pre-flight port check across `3000, 3001, 3003, 3004, 3005, 5001, 6001–6003` (fails fast if any port is already in use; never kills pre-existing processes).
    - Spawns app services inside the temp copy in detached process groups, tracks only platform-spawned PIDs/PGIDs, polls health endpoints, and guarantees cleanup on finish/cancel/crash.
  - Per-app execution lock (prevents concurrent runs from colliding on fixed ports).
  - `testing-suites/arch-project/integration/auth-health.test.ts` executed via Vitest.
- **Prerequisites:** Milestone 3 complete; required ports free on local machine.
- **Risks & Mitigations:**
  - *Risk:* Child processes leak if Node backend crashes. *Mitigation:* Attach `SIGINT`/`SIGTERM`/`exit` handlers in `server.ts` to terminate all tracked PGIDs.
  - *Risk:* Pre-existing server running on `:3000`. *Mitigation:* Pre-flight check aborts cleanly with a clear "Port 3000 already in use" message in the dashboard.
- **Manual Verification:**
  1. Start a dummy server on port `3001` manually, click **Run (Integration)**, and verify the platform refuses to start with a port-conflict error without killing the dummy server.
  2. Stop the dummy server, click **Run (Integration)**, verify services start from `/tmp/...`, `auth-health.test.ts` passes, all platform-started PIDs exit cleanly, and `ARCH PROJECT copy/apps/*/data/*.db` and `logs/*.log` are untouched.

---

### Milestone 5: Browser E2E Execution (Playwright) & Full Run History UI
- **Goal:** Add Playwright adapter, one real browser E2E test, and complete run history browsing in the dashboard.
- **Deliverables:**
  - `playwrightAdapter.ts`: Runs Playwright with `--reporter=json` and normalizes output to `NormalizedTestRun`.
  - `testing-suites/arch-project/e2e/sso-login.spec.ts` testing real browser login/redirect flow.
  - Dashboard Run History list + detailed failure/log viewer reading from `testing-dashboard/.runs/`.
- **Prerequisites:** Milestone 4 complete; Playwright Chromium browser installed in `testing-suites/`.
- **Risks & Mitigations:**
  - *Risk:* Playwright tests flake if Next.js dev servers take longer to compile first request. *Mitigation:* Wait for health endpoints + configure Playwright `timeout` / `webServer` readiness appropriately.
- **Manual Verification:**
  1. Click **Run (E2E)** in the dashboard.
  2. Confirm Playwright launches headless browser against the isolated local stack, executes `sso-login.spec.ts`, and reports real pass/fail results and duration in the dashboard.
  3. Confirm previous Unit, Integration, and E2E runs remain viewable in Run History after restarting the dashboard.
