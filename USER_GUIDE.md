# Centralized Testing Platform — User Guide

This guide explains how to start, operate, and manually test applications using `TESTING-PLATFORM`.

---

## 1. Project Structure

```text
TESTING-PLATFORM/
├── ARCH PROJECT copy/              # Read-only sample target application (never modified by the platform)
├── testing-dashboard/              # Centralized Dashboard UI + Backend Execution Service
│   ├── apps.registry.json          # Registered target apps, ports, health URLs, explicit testEnv, and suites
│   ├── package.json                # Root scripts (dev:backend, dev:frontend, build/typecheck)
│   ├── .runs/                      # Persisted test run history (result.json & sanitized run.log per run)
│   ├── backend/                    # Node.js + Express + TypeScript API & execution engine (:4000)
│   │   └── src/
│   │       ├── server.ts           # Express server + graceful shutdown cleanup
│   │       ├── routes/             # /api/apps and /api/runs endpoints
│   │       ├── services/           # registry, inspector, workspace, processManager, logSanitizer, runStore, executor
│   │       └── adapters/           # vitestAdapter.ts and playwrightAdapter.ts
│   └── frontend/                   # React + Vite + TypeScript dashboard UI (:5173)
│       └── src/
│           ├── App.tsx             # Hero header, navigation tabs, and state coordination
│           ├── api/client.ts       # Typed fetch calls to /api/*
│           └── components/         # OverviewKpis, ArchitectureSummary, PyramidRecommendations, RunControls, RunResults
├── testing-suites/                 # Externally maintained test suites & runner dependencies
│   ├── package.json                # vitest, @playwright/test, typescript
│   └── arch-project/
│       ├── vitest.config.ts        # Resolves @target to TARGET_APP_DIR
│       ├── playwright.config.ts
│       ├── unit/                   # security.test.ts, loadbalancer.test.ts
│       ├── integration/            # api-services.test.ts
│       └── e2e/                    # sso-workflow.spec.ts
├── README.md                       # Project overview & setup
├── ARCHITECTURE.md                 # Approved technical architecture
├── IMPLEMENTATION_PLAN.md          # MVP milestones
└── USER_GUIDE.md                   # This guide
```

---

## 2. How to Start the Platform

### Prerequisites
- Node.js (v20+) and `npm`
- Dependencies installed in `testing-suites/`, `testing-dashboard/backend/`, and `testing-dashboard/frontend/` (plus Chromium via `npx playwright install chromium` in `testing-suites/`).

### Start Commands
Open two terminals inside `TESTING-PLATFORM/testing-dashboard/`:

```bash
# Terminal 1: Start Backend Execution Service
cd testing-dashboard && npm run dev:backend

# Terminal 2: Start Dashboard Frontend
cd testing-dashboard && npm run dev:frontend
```

### URLs
- **Dashboard UI:** `http://localhost:5173`
- **Backend API:** `http://localhost:4000`
- **Backend Health Check:** `GET http://localhost:4000/api/health`

---

## 3. Dashboard Navigation & Controls

### Left Sidebar Navigation
- **Overview:** Minimal, uncluttered dashboard showing the selected target application summary, key metric cards (Total Tests, Passed, Failed, Last Duration), 3 quick-launch testing category cards, and recent execution runs.
- **Unit Testing:** Dedicated section showing project selector folder cards and Unit Test suites only (`unit/security.test.ts`, `unit/loadbalancer.test.ts`) with individual "Run Suite" buttons and a "Run All Unit Tests" action.
- **Integration Testing:** Dedicated section showing project selector folder cards and Integration/API test suites only (`integration/api-services.test.ts`) with "Run Suite" and "Run All Integration Tests" actions.
- **E2E Testing:** Dedicated section showing project selector folder cards and browser E2E test suites only (`e2e/sso-workflow.spec.ts`) with "Run Suite" and "Run All E2E Tests" actions.
- **Test History:** Full searchable and filterable table of past test runs with expandable test case details.

### Top Header Controls
- **Repository selector dropdown:** Switches between registered applications (e.g., `ARCH PROJECT (Multi-App Architecture)`) and demo preview projects.
- **Runtime Mode selector dropdown:**
  - `Isolated Temp Copy` (`isolated`): Automatically prepares a clean temporary copy of the application in `/tmp/testing-platform-runs/`, verifies port availability, starts services if needed, runs tests, and cleans up.
  - `Attach to Local Services` (`attach`): Verifies health of services already running on localhost and runs tests against them without starting or stopping any processes.
- **Run All Tests / Cancel Run button:**
  - When idle: Executes all registered test suites across all categories in sequence.
  - When running: Turns into a red "Cancel Run" button that immediately terminates the active test execution.

### Right-Side Execution Terminal
- Dedicated persistent terminal panel on the right side of the workspace.
- **Live Output:** Streams real stdout/stderr logs from the backend runner process in real time.
- **Live Status Badge:** Shows `IDLE`, `RUNNING` (with pulsing indicator), `PASSED`, `FAILED`, or `CANCELLED`.
- **Mini Stats Bar:** Shows layer, passed/failed/total counts, and duration in seconds.
- **Controls:** `Auto-scroll: ON/OFF` toggle, `Copy` logs to clipboard, and `Clear` log window.

---

## 4. How to Perform Manual Testing

### A. Running Unit Tests
1. In **Test Execution Center**, set **Runtime Mode** to `Isolated Temp Copy (Default)` (Unit tests are standalone and do **not** require target services running).
2. Click **Run Unit Tests** (or **Run Suite** on `Auth Security Helpers (Unit)` / `Gateway Load Balancer (Unit)`).
3. **What happens internally:** Backend copies source files (excluding `.env` and `node_modules`) into `/tmp/testing-platform-runs/<runId>/app`, sets `TARGET_APP_DIR`, runs `vitest` with `--reporter=json`, parses results, and deletes the temp folder.
4. **Expected result:** Status badge becomes `passed`; KPI cards show `9` total, `9` passed, `0` failed, `0` skipped.

### B. Running Integration / API Tests
1. Decide which **Runtime Mode** fits your machine right now:
   - **If ports `3000–3005, 5001, 6001–6003` are free:** Select `Isolated Temp Copy (Default)`. The backend will copy the app + `node_modules`, start `node scripts/runner.js` in the temp workspace, wait for all 9 health endpoints, run Vitest, and shut down its own processes.
   - **If `ARCH PROJECT copy/` is already running on those ports:** Select `Attach to Running Local Services`. (If you leave `Isolated Temp Copy` selected while ports are occupied, the platform will safely abort with a port-conflict error without killing your running services.)
2. Click **Run Integration Tests**.
3. **Expected result:** Status becomes `passed`; `api-services.test.ts` reports `5` passed (`0` failed).

### C. Running E2E Browser Tests
1. Use the same **Runtime Mode** rule as Integration tests (`Isolated Temp Copy` if ports are free, or `Attach to Running Local Services` if the app stack is already running).
2. Click **Run E2E Tests**.
3. **What happens internally:** Backend verifies service health, runs headless Playwright (`sso-workflow.spec.ts`), parses Playwright's JSON report, and cleans up.
4. **Expected result:** Status becomes `passed`; `sso-workflow.spec.ts` reports `1` passed (`0` failed).

### D. Running All Tests
1. Ensure **Runtime Mode** matches your port state (`Isolated Temp Copy` when ports are free; `Attach to Running Local Services` when the target stack is already running).
2. Click **Run All Tests**.
3. **Expected result:** Executes Unit, Integration, and E2E suites sequentially and reports combined totals (`15` passed, `0` failed, `0` skipped).

### E. Viewing Failures, Logs & History
- Open **Execution Results & Logs** to inspect per-case status, assertion error messages/stack traces, and the **Sanitized Execution Log**.
- Open **Test History** (or the **Test History** tab) and click any past run to reload its report and logs from `testing-dashboard/.runs/<runId>/`.

---

## 5. How Test Execution Works

```text
Dashboard UI (Browser :5173)
  ──(POST /api/runs)──▶ Backend API (Express :4000)
                          ├── isolated mode: Temp Copy (/tmp/...) + Port Check + Start App + Health Poll
                          └── attach mode:   Health Poll on already-running local services
                                │
                                ▼
                     External Test Suite (testing-suites/arch-project/)
                       ├── Vitest Adapter (Unit & Integration/API)
                       └── Playwright Adapter (Browser E2E)
                                │
                                ▼
                     Raw JSON Report ──▶ NormalizedTestRun (.runs/<runId>/result.json)
                                │
                                ▼
                     Dashboard UI polls GET /api/runs/:runId & displays results + sanitized logs
```

---

## 6. Important Safety Notes & Current Limitations

- **Original Application Protection:** `ARCH PROJECT copy/` is treated as strictly read-only. Temp workspaces never blindly copy `.env` files and never symlink `node_modules` back to the original repo.
- **Secret Redaction:** `testEnv` secrets, JWT strings, and `Authorization`/`Cookie` headers are redacted before logs are saved or displayed.
- **Port Conflicts & Process Safety:** The backend only tracks and terminates PIDs/PGIDs it spawned. It never kills pre-existing processes on your machine; if required ports are occupied in `isolated` mode, it fails fast with a clear error.
- **Report Storage:** All run results and logs are stored locally as JSON/log files under `testing-dashboard/.runs/`.
- **Not Implemented Yet:** Adding new apps via the UI (must be added in `testing-dashboard/apps.registry.json`), remote Git repository cloning, and downloadable PDF/CSV report exports.

---

## Quick Manual Testing Checklist

1. [ ] Start backend (`cd testing-dashboard && npm run dev:backend`) and frontend (`cd testing-dashboard && npm run dev:frontend`).
2. [ ] Open `http://localhost:5173` and confirm `ARCH PROJECT` is selected and `7 Workspaces` are detected.
3. [ ] Click **Run Unit Tests** in `Isolated Temp Copy (Default)` mode → verify `9/9` passed.
4. [ ] Check if target app ports (`3000–3005, 5001, 6001–6003`) are already running; choose `Isolated Temp Copy` (if free) or `Attach to Running Local Services` (if running).
5. [ ] Click **Run Integration Tests** → verify `5/5` passed.
6. [ ] Click **Run E2E Tests** → verify `1/1` passed.
7. [ ] Click a row in **Test History** → verify saved report and sanitized execution log load properly.
