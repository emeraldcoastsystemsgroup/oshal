/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial Playwright configuration for localhost browser testing
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Updated webServer command to run the Express server entrypoint
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Normalized config header formatting for Phase 10 chat validation
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added configurable Playwright test port and disabled implicit server reuse by default
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Prevented Playwright webServer from inheriting generic PORT so mock-oidc test runs do not hijack the operator runtime on 3456
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Default the test webServer to FORCE_LLM_PROVIDER=noop: without it the server boots the claude-code provider and throws an uncaught "no ANTHROPIC_API_KEY / OAuth session" at boot on a keyless box (CI), so the webServer exits 1 and every e2e spec fails before it runs. noop needs no vendor creds; override still honored.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | MOCK_OIDC runs get a deterministic SESSION_SECRET when none is configured: a clean checkout has no .env, MOCK_OIDC boots without a session secret, and every HMAC-minting path (TV pairing approve, guest cookies) 500s "TV pairing requires SESSION_SECRET" — the 2026-07-09 firetv-tv-pairing quarantine. Same keyless-CI class as the noop default above; real values always win, and non-mock runs are untouched.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | BASE_URL pins the IPv4 loopback 127.0.0.1 instead of the hostname "localhost": on this host a stale wslrelay squats ::1 ports (docs/runbooks/localhost-wedge-wslrelay.md), so clients resolving localhost→::1 got ECONNREFUSED ::1:3456 (258 hits in the 2026-07-23 ci-local --head e2e run) while the webServer stayed reachable over IPv4. ci-local's NODE_OPTIONS=--dns-result-order=ipv4first mitigation demonstrably did not cover Playwright's request contexts or Chromium; naming the IPv4 address removes name resolution from the failure surface entirely. tests/helpers/test-origins.ts moves in the same change so URL-host waits keep matching.
 */

import { defineConfig } from '@playwright/test';

const MOCK_OIDC_ENABLED = ['true', '1', 'yes'].includes((process.env.MOCK_OIDC ?? '').toLowerCase().trim());
// The webServer env below defaults MOCK_OIDC to 'true' when unset, so the server can run
// mock even when MOCK_OIDC_ENABLED (raw shell env, drives the port choice) is false.
const WEB_SERVER_MOCK_OIDC = ['true', '1', 'yes'].includes((process.env.MOCK_OIDC ?? 'true').toLowerCase().trim());
const DEFAULT_PLAYWRIGHT_PORT = MOCK_OIDC_ENABLED ? 4458 : 3456;
const PLAYWRIGHT_PORT = parseInt(process.env.PLAYWRIGHT_PORT ?? String(DEFAULT_PLAYWRIGHT_PORT), 10);
// IPv4 loopback, NOT "localhost": localhost can resolve to ::1 where a stale wslrelay squats the
// port (ECONNREFUSED ::1:3456 across 61 specs, 2026-07-23 --head run). The webServer listens on
// IPv4; naming 127.0.0.1 makes every client — browser and node request context — hit it directly.
const BASE_URL = `http://127.0.0.1:${PLAYWRIGHT_PORT}`;
const REUSE_EXISTING_SERVER = process.env.PLAYWRIGHT_REUSE_SERVER === 'true';

/**
 * @description Playwright configuration for OSHAL browser validation against the local Express server.
 */
const config = defineConfig({
  testDir: './tests',
  testIgnore: ['tests/unit/**'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npx ts-node --project tsconfig.json -r tsconfig-paths/register src/app/server.ts',
    port: PLAYWRIGHT_PORT,
    reuseExistingServer: REUSE_EXISTING_SERVER,
    env: {
      ...process.env,
      PORT: String(PLAYWRIGHT_PORT),
      MOCK_OIDC: process.env.MOCK_OIDC ?? 'true',
      // MOCK_OIDC needs no session secret to boot, but the HMAC-minting paths (TV pairing
      // approve, guest cookies) fail-loud without one — on a keyless box (CI: no .env) the
      // approve-success path 500s "TV pairing requires SESSION_SECRET". Give mock runs a
      // deterministic test secret; a real configured value (env or .env via dotenv) always
      // wins, and non-mock runs are untouched so a prod misconfig still surfaces.
      ...(WEB_SERVER_MOCK_OIDC && !process.env.SESSION_SECRET
        ? { SESSION_SECRET: 'playwright-mock-oidc-session-secret' }
        : {}),
      // ADR-085 D5: load the PERMANENT fixture app. Shared specs used to assert against a real
      // product app (little-monsters, then gov-contracting once LM carved), so every carve broke
      // them and they had to be re-pointed — a treadmill with no end, since the whole point of the
      // store migration is that ANY app can carve. tests/fixtures/swarm-apps/oshal-ci-fixture.yaml
      // is not a product, ships no code, and can never carve. UNSET in production.
      SWARM_APPS_EXTRA_DIRS: process.env.SWARM_APPS_EXTRA_DIRS ?? 'tests/fixtures/swarm-apps',
      // Boot the keyless provider by default so the test server starts on a box with no
      // vendor creds (CI). Without this the default claude-code provider throws at boot
      // (no ANTHROPIC_API_KEY / OAuth) and Playwright reports "webServer was not able to
      // start". Matches the documented `FORCE_LLM_PROVIDER=noop npx playwright test`.
      FORCE_LLM_PROVIDER: process.env.FORCE_LLM_PROVIDER ?? 'noop',
      // Product-path regressions should exercise the cockpit/surface under test,
      // not get diverted into first-run setup. Onboarding-specific specs can opt
      // back in with DISABLE_ONBOARDING_GATE=false.
      DISABLE_ONBOARDING_GATE: process.env.DISABLE_ONBOARDING_GATE ?? (MOCK_OIDC_ENABLED ? 'true' : undefined),
      // Allow self-signed OpenSearch certs in local dev (port-forward from a Kubernetes cluster).
      // Node's built-in fetch rejects self-signed certs by default; this env var disables
      // that check for the test server process only.
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    },
  },
});

export default config;
