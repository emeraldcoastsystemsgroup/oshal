/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for the shared logger's secret redaction: builds a real pino logger from the SHIPPED LOG_REDACT_OPTIONS (the same object the production singleton uses) against a capturing destination, plants a sentinel at every configured redact path (generated from the config, so a new path is exercised automatically), and asserts the sentinel never reaches serialized output while '[REDACTED]' does. Pins the 2026-07-19 additions (accessToken/access_token/refreshToken/refresh_token/bearer + wildcard variants), the nested req.headers.authorization case, and child-logger inheritance.
 */

import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { LOG_REDACT_OPTIONS } from '@/shared/logger';

/** The credential keys added 2026-07-19 — pinned so a future trim of the list fails loudly. */
const ADDED_KEYS = [
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'bearer',
  '*.accessToken',
  '*.access_token',
  '*.refreshToken',
  '*.refresh_token',
  '*.bearer',
];

/**
 * @description Build a real pino logger over the SHIPPED redact config, writing synchronously
 * into an in-memory buffer (no transports, no worker threads) so tests can assert on the exact
 * serialized output.
 * @returns The logger plus an accessor for everything it has written.
 */
function buildCapturingLogger(): { log: pino.Logger; output: () => string } {
  let buffer = '';
  const destination = { write(chunk: string): void { buffer += chunk; } };
  const log = pino(
    { level: 'debug', redact: LOG_REDACT_OPTIONS, base: undefined },
    destination as pino.DestinationStream,
  );
  return { log, output: () => buffer };
}

/**
 * @description Place a sentinel value at a pino redact path inside a payload object.
 * Wildcard segments materialize as a literal holder key — pino's `*` matches any key at
 * that level, so the holder exercises the wildcard rule.
 * @param target - The payload being built.
 * @param redactPath - A path from LOG_REDACT_OPTIONS.paths (e.g. 'req.headers.cookie', '*.token').
 * @param value - The sentinel to plant.
 */
function plant(target: Record<string, unknown>, redactPath: string, value: string): void {
  const segments = redactPath.split('.').map((s) => (s === '*' ? 'wildcardHolder' : s));
  let cursor = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    cursor[segments[i]] = cursor[segments[i]] ?? {};
    cursor = cursor[segments[i]] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]] = value;
}

/** A unique, grep-able sentinel per redact path. */
function sentinelFor(redactPath: string): string {
  return `leak-${redactPath.replace(/[^a-zA-Z0-9]/g, '_')}-7d1`;
}

describe('shared logger redaction (LOG_REDACT_OPTIONS — the shipped config)', () => {
  it('censors EVERY configured redact path — payload generated from the config itself', () => {
    const { log, output } = buildCapturingLogger();
    const payload: Record<string, unknown> = { requestId: 'req-777', note: 'plain-visible' };
    for (const redactPath of LOG_REDACT_OPTIONS.paths) plant(payload, redactPath, sentinelFor(redactPath));

    log.info(payload, 'redaction sweep');
    const out = output();

    expect(out.length).toBeGreaterThan(0);
    for (const redactPath of LOG_REDACT_OPTIONS.paths) {
      expect(out, `redact path '${redactPath}' leaked its value into serialized output`).not.toContain(sentinelFor(redactPath));
    }
    // One censor mark per planted path, and non-secret fields survive untouched.
    expect((out.match(/\[REDACTED\]/g) ?? []).length).toBeGreaterThanOrEqual(LOG_REDACT_OPTIONS.paths.length);
    expect(out).toContain('plain-visible');
    expect(out).toContain('req-777');
  });

  it('the 2026-07-19 credential keys are IN the shipped list and censor at top level and nested', () => {
    for (const key of ADDED_KEYS) {
      expect(LOG_REDACT_OPTIONS.paths, `'${key}' was trimmed from the redact list`).toContain(key);
    }

    const { log, output } = buildCapturingLogger();
    log.info(
      {
        accessToken: 'leak-at-top-1',
        access_token: 'leak-at-top-2',
        refreshToken: 'leak-rt-top-1',
        refresh_token: 'leak-rt-top-2',
        bearer: 'leak-bearer-top',
        oauth: {
          accessToken: 'leak-at-nested-1',
          access_token: 'leak-at-nested-2',
          refreshToken: 'leak-rt-nested-1',
          refresh_token: 'leak-rt-nested-2',
          bearer: 'leak-bearer-nested',
        },
      },
      'oauth credential exchange',
    );
    const out = output();
    expect(out).not.toContain('leak-at-');
    expect(out).not.toContain('leak-rt-');
    expect(out).not.toContain('leak-bearer-');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts a request-shaped object: req.headers.authorization + cookie never serialize', () => {
    const { log, output } = buildCapturingLogger();
    log.info(
      { req: { url: '/api/tickets', headers: { authorization: 'Bearer leak-super-secret-jwt', cookie: 'session=leak-cookie-abc123' } } },
      'inbound request',
    );
    const out = output();
    expect(out).not.toContain('leak-super-secret-jwt');
    expect(out).not.toContain('leak-cookie-abc123');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('/api/tickets'); // the rest of the request context still logs
  });

  it('child loggers inherit redaction (the createChildLogger mechanism is pino .child)', () => {
    const { log, output } = buildCapturingLogger();
    const child = log.child({ module: 'unit-redaction' });
    child.warn({ token: 'leak-child-token', session: { apiKey: 'leak-child-apikey' } }, 'child log');
    const out = output();
    expect(out).not.toContain('leak-child-token');
    expect(out).not.toContain('leak-child-apikey');
    expect(out).toContain('unit-redaction');
  });

  it('pins the censor marker itself', () => {
    expect(LOG_REDACT_OPTIONS.censor).toBe('[REDACTED]');
  });
});
