/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the Kalshi live-order gate reaching the api. The gate reads process.env.KALSHI_LIVE_ENABLED, and compose does not forward .env, so a flag set on the host never reached the container: the operator's validated LIVE key had every order refused as "disabled" (2026-09-04). Pins the passthrough in x-bot-env with a FALSE default, the api service inheriting that env, and the exact name + literal-'true' read on the code side. Static compose text is the scoped double here; the real companion is `docker compose -f docker-compose.oshal-local.yml config` showing KALSHI_LIVE_ENABLED on the api service, run at merge (see docs/governance/real-boundary-regression-audit.md).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const compose = read('docker-compose.oshal-local.yml');
const portfolio = read('src/features/prediction-markets/services/kalshi-portfolio.ts');

/** The shared bot env anchor: from `x-bot-env:` to the first top-level `services:` key. */
function sharedBotEnv(): string {
  const start = compose.indexOf('x-bot-env:');
  const end = compose.indexOf('\nservices:');
  expect(start, 'x-bot-env anchor missing').toBeGreaterThanOrEqual(0);
  return compose.slice(start, end === -1 ? undefined : end);
}

/** The api service block: from its container_name to the next service key at two-space indent. */
function apiService(): string {
  const start = compose.indexOf('container_name: oshal-local-api');
  expect(start, 'api service missing').toBeGreaterThanOrEqual(0);
  const rest = compose.slice(start);
  const next = rest.search(/\r?\n {2}[\w-]+:\s*\r?\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('Kalshi live-order gate: the flag the code reads is the flag compose forwards', () => {
  it('forwards KALSHI_LIVE_ENABLED into the shared env, defaulting FALSE', () => {
    // Real money never opens by itself: the default must stay false, and the name must match
    // the process.env read below — a rename on either side is exactly the silent no-op this guards.
    expect(sharedBotEnv()).toMatch(/KALSHI_LIVE_ENABLED: \$\{KALSHI_LIVE_ENABLED:-false\}/);
  });

  it('forwards the two order caps so a host-side cap is not silently the code default', () => {
    const env = sharedBotEnv();
    expect(env).toMatch(/KALSHI_MAX_CONTRACTS: \$\{KALSHI_MAX_CONTRACTS:-\}/);
    expect(env).toMatch(/KALSHI_MAX_ORDER_COST_DOLLARS: \$\{KALSHI_MAX_ORDER_COST_DOLLARS:-\}/);
  });

  it('the api service (where the Kalshi routes mount) inherits the shared env', () => {
    expect(apiService()).toContain('<<: *bot-env');
  });

  it('the gate reads that exact name and opens only on the literal string true', () => {
    expect(portfolio).toMatch(/process\.env\.KALSHI_LIVE_ENABLED === 'true'/);
    // An empty passthrough must fall through to the code defaults, not to a zero cap.
    expect(portfolio).toMatch(/Number\(process\.env\.KALSHI_MAX_CONTRACTS\) \|\| \d+/);
    expect(portfolio).toMatch(/Number\(process\.env\.KALSHI_MAX_ORDER_COST_DOLLARS\) \|\| \d+/);
  });
});
