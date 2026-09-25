/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard ADR-143 default-off stream controls through the shared compose environment.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const compose = read('docker-compose.oshal-local.yml');
const stream = read('src/features/trading/services/market-data-stream.ts');

function sharedBotEnv(): string {
  const start = compose.indexOf('x-bot-env:');
  const end = compose.indexOf('\nservices:');
  expect(start).toBeGreaterThanOrEqual(0);
  return compose.slice(start, end === -1 ? undefined : end);
}

function apiService(): string {
  const start = compose.indexOf('container_name: oshal-local-api');
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = compose.slice(start);
  const next = rest.search(/\r?\n {2}[\w-]+:\s*\r?\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('ADR-143 stream compose gate', () => {
  it('forwards the display stream controls and leaves arming false', () => {
    const env = sharedBotEnv();
    expect(env).toMatch(/TRADING_STREAM_ENABLED: \$\{TRADING_STREAM_ENABLED:-false\}/);
    expect(env).toContain('ALPACA_STREAM_URL: ${ALPACA_STREAM_URL:-}');
    expect(env).toContain('TRADING_STREAM_MAX_SYMBOLS: ${TRADING_STREAM_MAX_SYMBOLS:-}');
    expect(env).toContain('TRADING_STREAM_STALE_SEC: ${TRADING_STREAM_STALE_SEC:-}');
  });

  it('keeps the api on the shared environment and reads the same literal true', () => {
    expect(apiService()).toContain('<<: *bot-env');
    expect(stream).toContain("process.env.TRADING_STREAM_ENABLED === 'true'");
  });
});
