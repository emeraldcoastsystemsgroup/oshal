/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Shared origin resolution for specs: baseOrigin()/apiOrigin() read PLAYWRIGHT_PORT — the SAME source of truth playwright.config.ts uses — replacing the 30+ hardcoded localhost:3456/35457 literals that silently diverged from the harness port whenever a run overrode it (MOCK_OIDC runs boot on 4458, CI-mirror runs pin 3456, live-stack runs pin 35457)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Default hostname moves from "localhost" to the IPv4 loopback 127.0.0.1 — the recommendation this file's own docs already made: on this host a stale wslrelay squats ::1 (docs/runbooks/localhost-wedge-wslrelay.md), so clients resolving localhost→::1 got ECONNREFUSED (258 hits, 2026-07-23 ci-local --head e2e run) while the server stayed reachable over IPv4. Moves in lockstep with playwright.config.ts BASE_URL so URL-host waits keep matching page URLs.
 */

/**
 * WHY TWO ORIGINS (the deliberate distinction, preserved from the literals):
 *
 * - baseOrigin() — the Playwright webServer origin. Mirrors playwright.config.ts
 *   EXACTLY: PLAYWRIGHT_PORT wins when set; otherwise the default is 4458 when
 *   MOCK_OIDC is truthy in the raw shell env, else 3456.
 *
 * - apiOrigin() — the LIVE docker api origin (compose publishes the api on
 *   35457). Live-stack specs run with PLAYWRIGHT_PORT=35457 +
 *   PLAYWRIGHT_REUSE_SERVER=true, so PLAYWRIGHT_PORT still wins when set (and
 *   CI-mirror runs that pin PLAYWRIGHT_PORT=3456 follow it too — unit fixtures
 *   built from apiOrigin() stay internally consistent because every side of a
 *   round-trip reads the same helper); the fallback is 35457, never 3456.
 *
 * - HOSTNAME: every helper defaults to the IPv4 loopback 127.0.0.1, never
 *   "localhost" — the name can resolve to ::1 where a stale wslrelay squats the
 *   port and refuses connections (docs/runbooks/localhost-wedge-wslrelay.md;
 *   proven live by the 2026-07-23 ci-local --head run: 258 ECONNREFUSED ::1
 *   hits). apiOrigin's hostname parameter remains for specs that need a
 *   different host explicitly.
 *
 * DELIBERATELY NOT PARAMETERIZED (semantic literals, do not "fix" them):
 * - tests/session-140-runtime-usability.spec.ts — asserts the DOCS advertise
 *   the canonical http://localhost:3456/cockpit/ operator URL; the literal IS
 *   the assertion subject.
 * - tests/unit/oshal-chat-config-migration.spec.ts — pins the bundled
 *   DEFAULT_CONFIG.controlPlaneUrl product constant in
 *   packages/oshal-chat/src/main/config.ts, not the harness origin.
 *
 * Every function reads process.env at CALL time (no module-load caching), so a
 * spec can override PLAYWRIGHT_PORT mid-file and the helper follows — the guard
 * spec (tests/unit/test-origins.spec.ts) pins that behavior.
 */

/** Truthy spellings accepted for MOCK_OIDC — kept identical to playwright.config.ts. */
const TRUTHY_FLAG_VALUES = ['true', '1', 'yes'];

/**
 * @description Reports whether MOCK_OIDC is truthy in the raw shell env, using the
 * exact parsing playwright.config.ts uses to pick its default port (unset => false).
 * @param env Environment map to read (defaults to process.env; injectable for tests).
 * @returns True when MOCK_OIDC is one of true/1/yes (case/whitespace-insensitive).
 */
function isMockOidcEnabled(env: NodeJS.ProcessEnv): boolean {
  return TRUTHY_FLAG_VALUES.includes((env.MOCK_OIDC ?? '').toLowerCase().trim());
}

/**
 * @description Parses PLAYWRIGHT_PORT with a fallback, tolerating a non-numeric
 * value by falling back (a run with a garbage PLAYWRIGHT_PORT never boots a
 * server anyway; the helper staying usable keeps spec failures pointed at the
 * real misconfiguration instead of a NaN URL).
 * @param env Environment map to read.
 * @param fallback Port to use when PLAYWRIGHT_PORT is unset or non-numeric.
 * @returns The effective port number.
 */
function resolvePort(env: NodeJS.ProcessEnv, fallback: number): number {
  const parsed = parseInt(env.PLAYWRIGHT_PORT ?? String(fallback), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * @description The port the Playwright webServer listens on — the same resolution
 * playwright.config.ts performs: PLAYWRIGHT_PORT wins; default 4458 under a truthy
 * shell MOCK_OIDC, else 3456.
 * @param env Environment map to read (defaults to process.env; injectable for tests).
 * @returns The webServer port.
 */
export function basePort(env: NodeJS.ProcessEnv = process.env): number {
  return resolvePort(env, isMockOidcEnabled(env) ? 4458 : 3456);
}

/**
 * @description The host (hostname:port, no scheme) of the Playwright webServer —
 * for URL-host comparisons and regex construction.
 * @param env Environment map to read (defaults to process.env; injectable for tests).
 * @returns e.g. "127.0.0.1:3456".
 */
export function baseHost(env: NodeJS.ProcessEnv = process.env): string {
  return `127.0.0.1:${basePort(env)}`;
}

/**
 * @description The full origin of the Playwright webServer under test.
 * @param env Environment map to read (defaults to process.env; injectable for tests).
 * @returns e.g. "http://127.0.0.1:3456".
 */
export function baseOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return `http://${baseHost(env)}`;
}

/**
 * @description The port of the live docker api (compose publishes 35457).
 * PLAYWRIGHT_PORT wins when set — live-stack runs pin it to 35457 explicitly —
 * but the FALLBACK is 35457, never the isolated-server 3456.
 * @param env Environment map to read (defaults to process.env; injectable for tests).
 * @returns The live api port.
 */
export function apiPort(env: NodeJS.ProcessEnv = process.env): number {
  return resolvePort(env, 35457);
}

/**
 * @description The host (hostname:port, no scheme) of the live docker api.
 * @param env Environment map to read (defaults to process.env; injectable for tests).
 * @returns e.g. "127.0.0.1:35457".
 */
export function apiHost(env: NodeJS.ProcessEnv = process.env): string {
  return `127.0.0.1:${apiPort(env)}`;
}

/**
 * @description The full origin of the live docker api. Defaults to the IPv4
 * loopback (the wslrelay ::1 wedge dodge — see the header note); accepts a
 * hostname for specs that need a different host explicitly.
 * @param hostname Hostname to use (defaults to "127.0.0.1").
 * @param env Environment map to read (defaults to process.env; injectable for tests).
 * @returns e.g. "http://127.0.0.1:35457".
 */
export function apiOrigin(hostname = '127.0.0.1', env: NodeJS.ProcessEnv = process.env): string {
  return `http://${hostname}:${apiPort(env)}`;
}

/**
 * @description Escapes a string for literal use inside a RegExp — so host-based
 * URL waits (e.g. waitForURL over baseHost()) match the resolved host verbatim
 * instead of treating "." or ":" contexts as metacharacters.
 * @param text The literal text to escape.
 * @returns The regex-safe escaped string.
 */
export function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
