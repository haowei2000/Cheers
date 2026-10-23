# Real browser integration tests

These Playwright tests exercise the React app against a real isolated gateway and
PostgreSQL database. They do not mock HTTP, WebSockets, Tauri, or authentication,
and do not pre-create the test user, Personal workspace, or workspace membership.

`personal-channels.e2e.ts` covers:

1. Register through the actual page, including **Send code** and email verification.
2. Sign out and sign back in through the actual login page. Check both responses
   and the authenticated profile identify the same ordinary `member` user.
3. Select **Personal**, open **New channel**, and submit both **Public** and
   **Private** channels. Check the actual request's workspace and visibility.
4. Reload after each creation, checking the gateway's persisted list and the
   visible, selected channel. Both channels must remain visible at the end.

## Fixture contract

Install frontend dependencies and Chromium, then run the complete fixture from
the repository root with `DATABASE_URL` pointing to a local development Postgres
role that can create databases:

```sh
pnpm --dir frontend install --frozen-lockfile
pnpm --dir frontend exec playwright install chromium
make test-e2e
```

The fixture applies migrations to a fresh sqlx test database, starts the current
source-built gateway, and assigns frontend and gateway ports. To reuse an
installed local Google Chrome instead of downloading Chromium, run
`E2E_BROWSER_CHANNEL=chrome make test-e2e`.

The owning gateway integration fixture must provision an isolated database and
gateway process, enable open registration, and leave email-provider credentials
unset. The real request-code endpoint generates and hashes the verification code;
the test reads only the new dev-delivery log block for its unique email address.
No verification code is injected or accepted by a test-only API.

Provide these environment variables to Playwright:

| Variable | Required value |
| --- | --- |
| `INTEGRATION_BASE_URL` | An unused `http://127.0.0.1:<port>` for the frontend |
| `E2E_GATEWAY_URL` | The fixture's real HTTP loopback gateway origin, on a different port |
| `E2E_USER_LOGIN` | A fresh, valid username that does not exist yet |
| `E2E_USER_PASSWORD` | A fresh password of at least 12 characters |
| `E2E_USER_EMAIL` | A unique, unregistered email address for this run |
| `CHEERS_E2E_GATEWAY_LOG` | The fixture's private log file; enable the `cheers=info` target |
| `E2E_BROWSER_CHANNEL` | Optional: `chrome` to use locally installed Chrome; unset uses Playwright Chromium |
| `E2E_USER_ID` | Optional expected UUID; otherwise the real registration response supplies it |

The official Playwright `webServer` fixture starts Vite with the gateway proxy
addresses and stops it after the run. It refuses reuse of an existing frontend
process. Both service URLs are restricted to loopback; there is no production
endpoint or shared-account fallback. The gateway fixture owns gateway/DB cleanup.

The gateway integration target `browser_e2e` owns the opt-in test
`ordinary_user_registration_and_personal_channels_in_real_browser`, which starts
the isolated gateway and supplies this environment. It also verifies the final
ordinary-user, Personal owner-membership, and Public/Private channel rows in PG.

With the fixture environment set and dependencies/browser installed, its browser
command is:

```sh
pnpm --dir frontend exec playwright test --config playwright.config.ts
```

The default Vitest suite does not discover `*.e2e.ts`. A missing browser, service,
registration code, or required environment variable fails this suite; there are no
automatic skips or API-only substitutes.

Failure screenshots and traces are saved in `frontend/test-results`, with the HTML
report in `frontend/playwright-report`. CI retains failure diagnostics for seven
days; these runs use only temporary test accounts. The isolated database is disposed
by its owning fixture rather than deleting channels in the browser teardown,
preserving failed-run evidence for that fixture to inspect.

The companion desktop contract tests run in the normal connector test suite. They consume
`fixtures/desktop-onboarding/gateway-codex.json`, whose contents are verified
against the real gateway renderer, and pass it through the same disk writer as
desktop IPC and the real connector loader. All files are temporary. Regenerate
that fixture explicitly after renderer changes:

```sh
UPDATE_DESKTOP_ONBOARDING_FIXTURE=1 cargo test --manifest-path server/Cargo.toml \
  --locked --features integration --test browser_e2e \
  desktop_onboarding_fixture_matches_gateway_renderer -- --exact
```

`desktop_onboarding_smoke` additionally runs the real connector executable with a
temporary initialize-only ACP fixture and an authenticated loopback bridge. It
checks the runtime's Ready message and correlated configuration acknowledgment,
and verifies that the original malformed `token_file` configuration is rejected.
It never launches an installed agent or connects to a production gateway. The
desktop release workflow runs it against the actual signed bundle sidecar before
publishing assets; `CHEERS_CONNECTOR_SMOKE_BINARY` selects that explicit binary.
