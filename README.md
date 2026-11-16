# Centralized Testing Platform (`TESTING-PLATFORM`)

> **Status:** MVP Implemented — Ready for Local Execution  
> **Related Docs:** [ARCHITECTURE.md](./ARCHITECTURE.md) | [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)

---

## 1. Project Overview & Purpose

`TESTING-PLATFORM` is a centralized testing platform designed to analyze software applications, recommend tailored testing strategies based on the **Testing Pyramid**, manage test cases **externally** from the application's source code, trigger **real test execution** from a central dashboard, and display unified execution statuses and reports.

A core principle of the platform is **non-invasiveness**: client and internal applications can be tested without modifying their original source repositories or coupling test suites to the application codebase.

### Component Responsibilities
- **`testing-dashboard/`** — Centralized React + Vite + TypeScript UI (`frontend/`) and Node.js + Express + TypeScript execution & analysis backend (`backend/`). Stores local run history and sanitized logs under `.runs/`.
- **`testing-suites/`** — Externally maintained test suites (`vitest` for Unit and Integration/API; `@playwright/test` for browser E2E) and test dependencies, completely decoupled from target applications.
- **`ARCH PROJECT copy/`** — Read-only sample target application. Never modified by the platform.

---

## 2. Installation & Startup Instructions

### Prerequisites
- Node.js (v20+) and `npm`

### 1. Install Dependencies
Install dependencies in `testing-suites/` and `testing-dashboard/` (never inside `ARCH PROJECT copy/`):

```bash
cd testing-suites && npm install && npx playwright install chromium
cd ../testing-dashboard/backend && npm install
cd ../frontend && npm install
```

### 2. Start the Platform
In two terminals (or background processes) from `testing-dashboard/`:

```bash
# Terminal 1: Start Backend Execution Service (http://localhost:4000)
cd testing-dashboard && npm run dev:backend

# Terminal 2: Start Dashboard Frontend (http://localhost:5173)
cd testing-dashboard && npm run dev:frontend
```

### URLs
- **Dashboard UI:** `http://localhost:5173`
- **Backend API:** `http://localhost:4000` (Health: `GET http://localhost:4000/api/health`)

---

## 3. Application Registration, Test Execution & Reports

### Registering an Application
Applications are registered in [apps.registry.json](./testing-dashboard/apps.registry.json), mapping:
- `sourcePath`: Read-only path to the target application.
- `suitePath`: Path to the external test suite folder in `testing-suites/`.
- `startup`: Startup command, fixed ports, health URLs, and startup timeout.
- `testEnv`: Explicit test-only environment variables (never blindly copies `.env` files).
- `suites`: Registered Unit, Integration, and E2E suites.

### Running Tests
1. Open `http://localhost:5173` and select the target application (`ARCH PROJECT`).
2. Review the **Application Architecture** inspection and **Testing Pyramid** recommendations.
3. Choose the **Runtime Mode**:
   - **Isolated Temp Copy (Default):** Copies source and dependencies to `/tmp/testing-platform-runs/<runId>/app`, checks port availability, starts services, runs tests, and cleans up platform-owned PIDs + temp workspace.
   - **Attach to Running Local Services:** Verifies health endpoints on already-running local services without spawning or terminating any app processes.
4. Click **Run** on an individual suite, a Testing Pyramid layer, or **Run All Tests**.

### Viewing Results & History
- Live execution logs (with secrets/tokens redacted) and normalized test results (`total`, `passed`, `failed`, `skipped`, duration, and failure stacks) appear in the **Execution Report & Logs** panel.
- All runs are persisted under `testing-dashboard/.runs/<runId>/result.json` and `run.log` and listed in **Historical Test Runs**.

### Troubleshooting
- **Port conflict in Isolated Temp Copy mode:** If ports `3000–3005`, `5001`, or `6001–6003` are already occupied by pre-existing local processes, the platform refuses to start or kill them. Either stop the external processes or switch Runtime Mode to **Attach to Running Local Services**.
- **Playwright browser missing:** Run `cd testing-suites && npx playwright install chromium`.

### Public GitHub Repository Execution

Public repositories are registered under **Public Repositories** in the dashboard, must be **trusted** once (their npm scripts and test code run on this machine with your user permissions), and are then run through `POST /api/runs {appId: <repoId>}` — the same path the Run button uses.

**Pipeline** (`testing-dashboard/backend/src/services/externalExecutor.ts`):
1. **Fetch** — shallow fetch + checkout of the configured branch into `.platform/repos/<id>` (git runs with a minimal env, HTTPS only).
2. **Install** — `npm ci` (or `npm install` without a lockfile) into a per-lockfile cache `.platform/deps/<id>/<hash>`; reused until `package.json`/lockfile/Node version change.
3. **Browsers** — `playwright install --dry-run` decides whether Chromium for the repo's Playwright version is already present; it is downloaded only when missing.
4. **Workspace** — the exact commit is exported to `.platform/workspaces/<runId>/repo` and the cached `node_modules` are cloned into it.
5. **Discover** — `playwright test --list` seeds the live progress queue.
6. **Execute** — the repository's own test command (`npm test`, or the script configured in the repo settings) runs headless with `CI=1`, in its own process group, with live stdout/stderr streamed to the terminal panel.
7. **Collect** — reports are copied into `.runs/<runId>/` and parsed (see below). Process groups, the workspace and the run's temp directory are always cleaned up, also after failures, timeouts and cancellation.

**Temporary directory handling.** Every spawned process (`npm`, `playwright`, the test command and everything it spawns) gets `TMPDIR`, `TMP` and `TEMP` pointing at a fresh private (`0700`) directory such as `/private/tmp/tp-AbC123`. It is intentionally **not** inside the workspace: tools like `tsx` create a Unix-domain socket at `<tmpdir>/tsx-<uid>/<pid>.pipe`, and `bind(2)` rejects socket paths longer than 103 characters on macOS (107 on Linux) with `listen EINVAL`. The previous layout (`.platform/workspaces/<runId>/tmp`) produced 134-character paths, so every repository whose `npm test` runs `tsx` crashed before the first test. The platform now:
- picks the first writable base that leaves room for a socket (`PLATFORM_TMP_BASE` → OS temp dir → `/tmp` → `/var/tmp`; `PLATFORM_TMP_BASE` must be a short local path),
- creates the directory before the first child starts and **proves it by binding a probe socket** — if that fails the run stops with an infrastructure error naming the real cause,
- removes it at the end of the run (only directories carrying the platform's marker file, owned by the current user and not symlinks are ever deleted) and sweeps orphans left by a killed backend on the next start.

**Report parsing.** Per run the platform understands, in priority order:
1. *Layer reports* — `reports/<unit|integration|e2e>/results.json` (`schemaVersion: 1`, upper-case statuses, optional `runnerError`) with `junit.xml`/`execution.log` and `reports/summary.json`. Preserved as `results.<layer>.json`, `junit.<layer>.xml`, `execution.<layer>.log`, `summary.json`; `junit.xml` is used when a layer's JSON is unreadable. `ERROR` tests count as failed (their original status is kept); the runner's own `[runner] …` placeholder entry is not counted as a test.
2. Playwright JSON (`results.json`, `test-results/results.json`, …), then 3. JUnit XML.

**Failure classification.** `status: "error"` with `failureKind: "infrastructure"` (shown as *Infra error*) means the pipeline or runner could not produce a verdict: a stage failed (fetch/install/browsers/temp dir), the runner crashed before any test result existed (0/0 — also when the exit code is 0), or a layer reported `runnerError`. The real exit code, the full log and the last lines of the failing command are kept. Assertion failures remain `failed`; a run is `passed` only with results, exit code 0 and no failures.

**Runtime requirements.** macOS or Linux, Node.js 20.12+ (tested on 26.9), `git` and `npm` on `PATH`, outbound HTTPS to GitHub/npm/target sites, a local Chromium for the repository's Playwright version (`playwright install chromium`; Linux may need `--with-deps`). npm only (no yarn/pnpm/bun) and `@playwright/test` must be a dependency. Windows is untested.

**Limitations.** Repository code runs with your user permissions (hardening, not a sandbox). One external run at a time. The temp directory is world-reachable only by you, but lives outside the workspace, so a repository that writes huge temp files affects `/tmp`. Repositories whose own runner wipes `reports/` or writes layer reports elsewhere than `reports/`, `test-reports/` or `report/` fall back to Playwright JSON/JUnit or show 0 results (reported as an infrastructure error). Integration/E2E results of repositories that test public sites depend on those sites being reachable.

**Regression tests.** `cd testing-dashboard/backend && npm test` runs `tests/`: a deeply nested workspace reproduces `listen EINVAL` with the old layout (control) and proves `tsx` starts with the platform's TMPDIR, plus temp-dir cleanup safety, layer-report parsing and outcome classification.

---

## 2. Confirmed Manager Requirements

The following requirements are **confirmed** from the manager's specification:

1. **Centralized Application Selection:** A centralized dashboard where users can select different applications/software projects.
2. **Application Structure Analysis & Strategy Recommendation:** The platform must understand the selected application's structure and recommend suitable testing strategies.
3. **Testing Pyramid Guidance:** Recommendations must use Testing Pyramid principles to suggest an appropriate distribution of testing effort across layers (such as Unit, Integration, and E2E tests).
4. **External Test Maintenance:** Test cases must be maintained separately from the actual application's source code.
5. **Real Execution via Run Button:** Users must be able to trigger actual test execution through a **Run** button on the dashboard (not mocked or hardcoded results).
6. **Centralized Reporting:** The dashboard must display test execution status, results, and reports centrally.
7. **Zero Modification to Target Apps:** The platform must support testing client/customer applications without requiring changes to their original source repositories.
8. **Initial Local Scope:** Initial execution scope is local-machine execution.
9. **Multi-Application Extensibility:** The architecture must allow support for multiple applications in the future.

---

## 3. Expected Folder & Repository Structure

The workspace is structured into three distinct top-level directories, which are intended to become **separate repositories**:

```text
TESTING-PLATFORM/
├── ARCH PROJECT copy/      # Sample target application (read-only reference; do not modify)
├── testing-dashboard/      # Centralized dashboard UI and backend execution service (planned)
└── testing-suites/         # Externally maintained test suites, decoupled from app repos (planned)
```

### Architectural Rules
- **Strict Separation:** Do not merge `testing-dashboard/`, `testing-suites/`, and target application source code into a single project.
- **Read-Only Application Source:** Do not modify, delete, rename, or generate files inside target application repositories (`ARCH PROJECT copy/` or future client apps) to accommodate the testing platform.
- **External Test Suites:** All test cases live in `testing-suites/` outside the target application repository.
- **Backend-Driven Execution:** Test execution must be handled by a backend execution service, never directly from browser-side code.
- **Isolated Workspace:** When test runs require building, running, or writing state (e.g., databases, logs), consider using a temporary isolated workspace for checking out or copying application code and external test suites rather than mutating the original source directory.
- **Framework Agnosticism:** Do not assume every application uses the same testing framework; framework compatibility must be investigated and handled via adapters.

---

## 4. Initial Sample Application Inspection (`ARCH PROJECT copy/`)

An inspection of `ARCH PROJECT copy/` was conducted without modifying any files. Below are the **verified facts** from the codebase.

### 4.1 Technology Stack & Package Management
- **Monorepo / Package Manager:** `npm` workspaces (`package.json`, `package-lock.json`).
- **Language & Tooling:** TypeScript (`^5.4.5`), `@types/node` (`^20.14.0`), `tsx` (`^4.23.15`) for TypeScript execution in Node services.
- **Databases:** SQLite via `better-sqlite3` (`^13.0.3`), isolated per service/app (`auth.db`, `next_app.db`, `notes.db`, `hybrid.db`, `products.db`).
- **Authentication:** `jsonwebtoken` (`^9.0.3`), `bcryptjs` (`^3.0.3`), `cookie-parser` (`^1.4.7`) using `HttpOnly` JWT cookies.
- **Observability Stack (`monitoring/docker-compose.yml`):** Grafana Loki (`:3100`), Grafana Alloy (`:12345`), and Grafana (`:3002`) tailing `logs/*.log`.

### 4.2 Workspaces, Services & Entry Points
`ARCH PROJECT copy/package.json` defines **7 workspaces**:

| Workspace | Path | Framework / Tech | Entry Point / Port |
| :--- | :--- | :--- | :--- |
| `@arch/auth` | `apps/auth` | Express `^5.3.0`, `better-sqlite3`, `bcryptjs`, `jsonwebtoken` | `src/server.ts` (`:3001`) |
| `@arch/web` | `apps/web` | Next.js `^16.4.5`, React `^18.3.1`, `better-sqlite3` | Next.js app (`:3000`) |
| `@arch/notes` | `apps/notes` | Express `^5.3.0`, `better-sqlite3`, `jsonwebtoken` | `src/server.ts` (`:3003`) |
| `@arch/hybrid-frontend` | `apps/hybrid/frontend` | Next.js `^16.4.5`, React `^18.3.1`, `jsonwebtoken` | Next.js app (`:3004`) |
| `@arch/hybrid-backend` | `apps/hybrid/backend` | Express `^5.3.0`, `better-sqlite3`, `jsonwebtoken` | `src/server.ts` (`:3005`) |
| `@arch/gateway` | `apps/gateway` | Express `^5.3.0` | `src/server.ts` (`:5001`) |
| `@arch/product-service` | `apps/services/product-service` | Express `^5.3.0`, `better-sqlite3` | `src/server.ts` (`:6001`, `:6002`, `:6003`) |

### 4.3 Existing Testing Setup
- **No dedicated unit, integration, or browser E2E testing framework** (such as Jest, Vitest, Mocha, Playwright, or Cypress) is installed in the root or any of the 7 workspaces.
- **Existing verification consists of:**
  - `npm run typecheck` (`tsc --noEmit` across all 7 workspaces).
  - `scripts/test-all.sh`: A custom Bash + inline Node.js (`fetch` + `assert`) end-to-end verification script that checks `/health` endpoints, auth signup/login/logout, JWT/CORS/CSRF security, CRUD & user isolation, gateway round-robin routing, and Loki log correlation.

### 4.4 Candidate Features for Initial Testing Examples
Based on the inspected codebase, `ARCH PROJECT copy/` provides clear candidates across all Testing Pyramid layers:
- **Unit Test Candidates:**
  - `apps/auth/src/security.ts` (validation/security helpers, redirect URI checks).
  - `apps/gateway/src/loadbalancer.ts` (round-robin selection and health state logic).
  - JWT verification/auth helper modules (`apps/*/src/auth.ts` and `apps/*/src/lib/auth.ts`).
- **Integration / API Test Candidates:**
  - Auth service endpoints (`:3001`): signup, login, logout, `HttpOnly` cookie flags, CORS allowlist, invalid/expired JWT rejection.
  - Notes API (`:3003/api/notes`): CRUD operations and cross-user isolation.
  - Hybrid Backend API (`:3005/api/tasks`): CRUD, status updates, CORS, and user isolation.
  - E-Commerce APIs (`:3000/api/products`, `/api/cart`): gateway proxying, round-robin distribution across `:6001–:6003`, cart & checkout.
- **End-to-End (E2E) Browser Test Candidates:**
  - Centralized SSO login/redirect flow from `:3000`, `:3003`, or `:3004` to `:3001` and back.
  - E-commerce browsing, cart addition, and checkout flow on `:3000`.
  - Task manager UI workflows on `:3004` backed by `:3005`.

---

## 5. How the Centralized Platform Is Expected to Work

1. **Select Application:** The user selects a registered application (initially `ARCH PROJECT copy/`) in `testing-dashboard/`.
2. **Inspect & Analyze Structure:** A backend analyzer inspects the application's directory layout, package manifests (`package.json`, etc.), services/ports, entry points, and existing test configurations in read-only mode.
3. **Recommend Strategy (Testing Pyramid):** Based on the detected architecture (e.g., multi-service APIs, frontend UIs, utility modules), the platform recommends an appropriate Testing Pyramid distribution and concrete test targets.
4. **Connect External Test Suites:** The platform maps the selected application to its external test suite directory in `testing-suites/`.
5. **Trigger Execution (`Run`):** Clicking **Run** on the dashboard sends a request to the backend execution service, which prepares an isolated execution context if needed, runs the real test suite(s), and captures live status and output.
6. **Collect & Display Reports:** Execution results, pass/fail counts, timings, logs, and failure details are collected by the backend and displayed centrally in the dashboard.

---

## 6. Testing Pyramid Explanation & Intended Use

The **Testing Pyramid** models how testing effort should be balanced across different levels of granularity:

- **Base — Unit Tests:** Fast, isolated tests for pure functions, business logic, and individual modules. Cheap to run and maintain.
- **Middle — Integration / API Tests:** Tests verifying interactions between components, HTTP endpoints, databases, authentication boundaries, and service-to-service communication.
- **Top — End-to-End (E2E) Tests:** Slower, higher-cost tests exercising full user workflows across UI, backend, and infrastructure.

**Intended Use in This Platform:**
- The platform uses Testing Pyramid principles to **recommend** a balanced effort distribution tailored to the application's actual structure (for example, an API-heavy microservice project may warrant a larger Integration/API layer than a pure library).
- **No Fixed Ratio Rule:** The platform does **not** hardcode a mandatory ratio (such as 70/20/10); distributions are contextual recommendations.

---

## 7. Connecting Applications & External Test Suites

- Each target application will be represented by a metadata/registry entry (path or repository reference, detected stack, health/startup details, and linked external test suite path).
- External test suites in `testing-suites/` will be organized per application (e.g., `testing-suites/<app-id>/unit`, `integration`, `e2e`) and executed against the target application without placing test files or test dependencies inside the application's repository.

---

## 8. Test Execution Flow (`Run` Button) & Results Collection

### Triggering Real Execution
1. User clicks **Run** (for all suites, a pyramid layer, or a specific suite) in the dashboard UI.
2. The dashboard sends an API request to the **backend execution service**.
3. The backend execution service:
   - Resolves the target application and its linked external test suite.
   - Optionally prepares a temporary isolated workspace (so target source files remain untouched and database/log side effects are contained).
   - Starts or verifies required local target services (if applicable for integration/E2E tests).
   - Spawns the appropriate test runner process(es) locally.
4. **Browser-side code never executes tests or shell commands directly.**

### Collecting & Displaying Results
- Test runners output structured machine-readable reports (e.g., JSON or JUnit XML) alongside stdout/stderr logs.
- The backend parses these outputs into a normalized result schema (run ID, timestamp, status, duration, layer, passed/failed/skipped counts, error messages/stack traces) and serves them to the dashboard for historical and live viewing.

---

## 9. Initial Local Scope vs. Future Multi-Application Support

- **Initial Scope (Phase 1):**
  - Runs on the developer's/QA engineer's local machine.
  - Uses `ARCH PROJECT copy/` as the primary reference application.
  - Focuses on proving end-to-end orchestration: app inspection -> strategy recommendation -> external suite execution -> centralized reporting.
- **Future Multi-Application Support:**
  - Pluggable **Project Analyzers** (to inspect Node.js, Python, Java, Go, etc.).
  - Pluggable **Runner Adapters** (to execute different test frameworks uniformly and normalize their reports).
  - Support for cloning remote Git repositories into temporary isolated workspaces before execution.

---

## 10. Proposed Architecture & Technology Choices

> **Note:** Everything in this section is a **technical proposal**, not a confirmed manager requirement. Final choices require team/manager validation.

- **Proposed Dashboard Frontend (`testing-dashboard/`):** React / Next.js or Vite + TypeScript for selecting projects, viewing Testing Pyramid recommendations, triggering runs, and inspecting reports.
- **Proposed Backend Execution Service (`testing-dashboard/`):** Node.js + TypeScript service (Express or Fastify) responsible for:
  - Read-only filesystem/AST/manifest analysis of target apps.
  - Process spawning (`child_process`) for test runners and local service lifecycle management.
  - Report parsing (normalized JSON schema) and local run history persistence (e.g., SQLite or JSON file store).
- **Proposed Initial Test Runners (`testing-suites/`):**
  - **Unit & API/Integration:** Vitest or Jest (or Node's built-in test runner) for external TypeScript/JavaScript tests against `ARCH PROJECT copy/`.
  - **E2E Browser Tests:** Playwright for driving real browser SSO and UI flows.
- **Proposed Framework Compatibility Approach:**
  - Define an **Adapter Interface** (`detect()`, `run()`, `parseReport()`) so each framework/language can be added incrementally without rewriting the dashboard or core runner.

---

## 11. Proposed Development Phases & Milestones

> **Note:** Proposed roadmap subject to manager confirmation.

1. **Phase 1 — Discovery & Design (Current):**
   - Document requirements, inspect `ARCH PROJECT copy/`, finalize open architectural questions.
2. **Phase 2 — Core Backend Execution & Analyzer Prototype:**
   - Build read-only application analyzer for Node.js/npm-workspace apps.
   - Build backend execution service with isolated workspace support and normalized report storage.
3. **Phase 3 — External Test Suites for `ARCH PROJECT copy/`:**
   - Author initial Unit, Integration/API, and E2E suites in `testing-suites/` without touching `ARCH PROJECT copy/`.
4. **Phase 4 — Centralized Dashboard UI:**
   - Build project selector, Testing Pyramid recommendation view, `Run` triggers, and live/historical report viewer in `testing-dashboard/`.
5. **Phase 5 — Multi-Application & Multi-Framework Expansion:**
   - Add onboarding flow for additional apps and adapter support for additional stacks/frameworks.

---

## 12. Security & Isolation Considerations

- **Read-Only Target Source:** Target application directories must never be modified by the platform or test runners.
- **Workspace Isolation:** Integration/E2E runs against `ARCH PROJECT copy/` mutate SQLite databases (`*.db`) and logs (`logs/*.log`). Running from a temporary isolated copy prevents polluting the original application state.
- **Controlled Execution:** The backend must only execute registered, allowlisted runner commands—never arbitrary user-supplied shell strings from the browser.
- **Secret Handling:** Target applications like `ARCH PROJECT copy/` rely on `.env` files (e.g., `JWT_SECRET`). Test execution must handle environment configuration securely without exposing secrets in dashboard UI logs.
- **Port & Process Hygiene:** Local multi-service apps occupy specific ports (`3000–3005`, `5001`, `6001–6003`); the execution service must cleanly start, health-check, and tear down processes to avoid port conflicts.

---

## 13. Out-of-Scope Items (Initial Phase)

- Cloud/CI-CD distributed runner orchestration (Kubernetes, GitHub Actions workers, remote agents).
- Multi-tenant authentication/RBAC for the testing dashboard itself.
- Supporting every language and testing framework from day one.
- Automated AI test-case generation/self-healing (unless explicitly added in a later phase).

---

## 14. Separation of Facts, Proposals, Assumptions & Open Questions

### Confirmed Requirements
- Centralized dashboard for selecting applications.
- Application structure analysis and Testing Pyramid-based strategy recommendations.
- External test suites separate from application source code.
- Real test execution triggered via a **Run** button, handled by a backend service.
- Centralized display of status, results, and reports.
- Non-invasive testing of client apps (no changes to original source).
- Local-machine initial scope; extensible to multiple applications.

### Technical Recommendations (Proposals)
- Node.js/TypeScript backend execution service + React/Next.js dashboard in `testing-dashboard/`.
- Normalized report schema with framework-specific runner adapters.
- Temporary isolated workspace copying for stateful local runs.
- Initial runner stack (e.g., Vitest + Playwright) for `ARCH PROJECT copy/`.

### Assumptions
- Local machine has Node.js, npm, and (if testing Loki/Grafana correlation) Docker available when running `ARCH PROJECT copy/`.
- External test suites can import or invoke target app modules (for unit tests) from a read-only path or isolated copy without needing test dependencies installed inside the target app's `package.json`.

### Open Questions Requiring Manager Confirmation
1. **Dashboard & Backend Tech Stack:** Do you have a preferred tech stack for `testing-dashboard/` (e.g., Next.js + Express/Fastify, or something else)?
2. **Preferred Test Frameworks:** Which initial test frameworks should we standardize on for `testing-suites/` (e.g., Vitest vs. Jest, Playwright vs. Cypress)?
3. **Service Lifecycle Management:** When clicking **Run** for integration/E2E tests, should the platform automatically start/stop the target application's services (e.g., via an isolated copy), or expect them to already be running locally?
4. **Strategy Recommendation Format:** Should Testing Pyramid recommendations be rule-based/heuristic (based on static codebase inspection), AI-assisted, or both?
5. **External Repo Input:** Beyond local folders, how soon do you want support for pointing the dashboard at a remote Git repository URL?
6. **Report Retention & Format:** Do you need downloadable reports (HTML/PDF/JUnit XML) or only in-dashboard viewing for Phase 1?
