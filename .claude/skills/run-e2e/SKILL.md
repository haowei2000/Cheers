---
name: run-e2e
description: Launch and drive the Cheers frontend against the in-cluster gateway (kind + Helm stack) with headless Chrome, for screenshots or E2E verification of UI changes. Use when asked to run, screenshot, or verify the chat UI end-to-end without rebuilding images.
---

# Run the Cheers UI end-to-end (dev inner loop)

Verified recipe (2026-07-02, macOS): local Vite dev server proxying to the
in-cluster gateway via port-forward, driven by `playwright-core` using the
system Chrome (`channel: "chrome"` — no browser download needed).

This is the fast path for verifying frontend changes in the real app
**without** `docker build` + `kind load` + rollout. The gateway/DB are the
cluster's; only the frontend code is yours.

## Prerequisites

- kind cluster `cheers` running: `kubectl get pods -n cheers` shows
  `cheers-gateway-*` and `cheers-postgres-0` Ready.
- Google Chrome installed (`/Applications/Google Chrome.app`).
- Login: `admin` / `admin12345`.

## 1. Port-forward the gateway

The gateway is ClusterIP-only; Vite's proxy targets `http://localhost:8000`
(`/api`, `/ws`, `/docs`, `/health` — see `frontend/vite.config.ts`).

```bash
SCRATCH=$(mktemp -d)
kubectl port-forward -n cheers svc/cheers-gateway 8000:8000 >"$SCRATCH/pf.log" 2>&1 &
echo $! > "$SCRATCH/pf.pid"
# macOS has no `timeout` — poll with a loop:
for i in {1..10}; do curl -sf http://localhost:8000/health >/dev/null && break; sleep 1; done
```

## 2. Start Vite

```bash
npm --prefix frontend run dev >"$SCRATCH/vite.log" 2>&1 &
echo $! > "$SCRATCH/vite.pid"
for i in {1..30}; do curl -sf http://localhost:5173 >/dev/null && break; sleep 1; done
```

Port matters: the gateway's dev CORS/Origin allowlist only has
5173/5174/30080. On the default 5173 you're fine; a random `autoPort`
port breaks the **resource WebSocket** (REST still works through the
proxy, so it fails half-open: data loads, sockets don't).

## 3. Drive with headless Chrome

Install the driver dep in a temp dir (never in `frontend/`):

```bash
cd "$SCRATCH" && npm init -y >/dev/null && npm i playwright-core --no-audit --no-fund
```

Then adapt [driver-example.mjs](driver-example.mjs) (`node driver.mjs`).
It logs in, opens a channel, and screenshots — trim/extend for the flow
under test. Screenshots land next to the script; **look at them** — a
blank frame means the launch failed.

### Gotchas (each cost real debugging time)

- **Login redirect is async.** `goto("/")` then checking for the password
  field races the client-side redirect and silently skips login. Go
  straight to `/login` and `waitFor` the password input.
- **The login API field is `login`, not `username`:**
  `{"login":"admin","password":"admin12345"}`. Sanity-check auth with
  `curl -X POST http://localhost:5173/api/v1/auth/login` before blaming
  the driver.
- **Click channels by name** (`getByText("claude-smoke", { exact: true })`).
  Generic sidebar selectors + `.first()` hit the workspace rail or the
  section collapse toggle.
- **UI state persists.** The ViewBoard drawer restores open/minimal/tab
  from localStorage — start flows from a known state (close it, reopen)
  instead of assuming a fresh UI.
- **Websocket app: `waitForLoadState("networkidle")` never settles.**
  `waitFor` the element you actually need.
- **The port-forward dies silently** between runs (pod roll, idle drop).
  Symptom: login returns **500** through the Vite proxy. Re-check
  `curl http://localhost:8000/health` and re-establish before each run.

## 4. Cleanup

```bash
kill $(cat "$SCRATCH/pf.pid" "$SCRATCH/vite.pid")
```

Stale processes from a previous run cause `EADDRINUSE` (Vite) or a dead
forward on 8000 — `pkill -f 'vite'` / `pkill -f 'port-forward.*cheers-gateway'`
if the pid files are gone.

## When NOT to use this

- Verifying **gateway/server** changes → rebuild + `./scripts/redeploy.sh gateway`
  (this recipe runs the *cluster's* gateway, not your local server code).
- Verifying the production build / nginx routing → use the NodePort UI at
  <http://localhost:30080> after `./scripts/redeploy.sh frontend`.
