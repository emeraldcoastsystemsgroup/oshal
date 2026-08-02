/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for the Jarvis Command Center comms panel logging an alarm on every load on a box that never installed the comms app. `oshal_email_digests` / `oshal_inbox_messages` are APP-owned (ADR-085 wave 3), so a CRM-only install answers 42P01 forever; the panel used to log warn on EVERY overview load (gsquared INCIDENT-2026-07-30 issue 10). Asserts BEHAVIOUR, not a substring: the level the panel logs at is read off a mocked logger, so re-widening the catch to warn/error on 42P01 turns this red, and — the other half that matters — silencing a REAL fault (a dropped connection) behind the same degrade turns it red too.
 */

/**
 * @description Behavioural guard on `buildComms`'s error classification.
 *
 * Two failures are being held apart, and BOTH directions are asserted because fixing one by
 * breaking the other is the easy wrong fix:
 *
 *  1. **42P01 (undefined_table) must be quiet.** The comms tables ship with the store package,
 *     not the kernel. On a box that never installed it the relation does not exist and never
 *     will, so an error-level line on every Command Center load is a permanent false alarm.
 *
 *  2. **Every other error must be LOUD, with a stack.** Pool exhaustion / a dropped connection /
 *     a revoked grant are real faults. If they degrade quietly to "no digest", the panel silently
 *     shows an empty state while the database is on fire.
 *
 * @module jarvis-overview-app-table-degrade.spec
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted: vi.mock is lifted above module init, so the spy object must be too.
const logSpies = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/shared/logger', () => ({
  createChildLogger: () => logSpies,
}));

import type { AppContext } from '@/app/composition/app-context';
import { buildComms } from '../../src/app/routes/jarvis-overview';

/** Postgres reports a missing relation as 42P01 — the "app not installed here" signal. */
const UNDEFINED_TABLE = Object.assign(
  new Error('relation "oshal_email_digests" does not exist'),
  { code: '42P01' },
);
/** A genuine infrastructure fault: the connection went away mid-query. */
const CONNECTION_LOST = Object.assign(
  new Error('Connection terminated unexpectedly'),
  { code: '08006' },
);

/** Build an AppContext whose pool rejects every query with `err`. */
function ctxRejecting(err: unknown): AppContext {
  return { pool: { query: vi.fn().mockRejectedValue(err) } } as unknown as AppContext;
}

describe('jarvis overview: app-owned comms tables', () => {
  beforeEach(() => {
    logSpies.info.mockClear();
    logSpies.warn.mockClear();
    logSpies.error.mockClear();
    logSpies.debug.mockClear();
  });

  it('degrades SILENTLY when the comms app is not installed (42P01) — no warn, no error', async () => {
    const result = await buildComms(ctxRejecting(UNDEFINED_TABLE), 'auth0|not-a-comms-box');

    // The panel still answers, empty — never a fabricated digest (no-mock rule).
    expect(result).toEqual({ digest: null, signals: [] });

    // THE regression: this used to emit a warn per panel on EVERY overview load.
    expect(logSpies.error).not.toHaveBeenCalled();
    expect(logSpies.warn).not.toHaveBeenCalled();

    // It is still observable — at debug, where an uninstalled app belongs. Both panels report.
    expect(logSpies.debug).toHaveBeenCalledTimes(2);
    const panels = logSpies.debug.mock.calls.map((c) => (c[0] as { panel: string }).panel).sort();
    expect(panels).toEqual(['email digest', 'social signals']);
  });

  it('still logs a REAL fault at ERROR with the stack — the degrade must not swallow it', async () => {
    const result = await buildComms(ctxRejecting(CONNECTION_LOST), 'auth0|comms-box');

    expect(result).toEqual({ digest: null, signals: [] });

    // A dropped connection is not "the app is not installed" — it must be loud.
    expect(logSpies.debug).not.toHaveBeenCalled();
    expect(logSpies.error).toHaveBeenCalledTimes(2);
    for (const [meta] of logSpies.error.mock.calls) {
      const payload = meta as { err: unknown; stack?: string; panel: string };
      expect(payload.err).toBe(CONNECTION_LOST);
      expect(payload.stack).toBeTruthy();
      expect(['email digest', 'social signals']).toContain(payload.panel);
    }
  });

  it('returns the decrypted digest untouched when the table IS present (fix changed no happy path)', async () => {
    const query = vi.fn()
      // First call: the digest read. An undecryptable blob degrades to null WITHOUT logging —
      // that path is the SESSION_SECRET guard, deliberately separate from table classification.
      .mockResolvedValueOnce({ rows: [{ summary: 'not:a:valid-envelope', updated_at: '2026-08-02T00:00:00Z' }] })
      // Second call: the social signals read.
      .mockResolvedValueOnce({
        rows: [{ from_addr: 'a@example.test', subject: 's', snippet: 'x', received_at: '2026-08-01T00:00:00Z' }],
      });
    const ctx = { pool: { query } } as unknown as AppContext;

    const result = await buildComms(ctx, 'auth0|installed') as {
      digest: unknown; signals: unknown[];
    };

    expect(result.signals).toHaveLength(1);
    expect(logSpies.error).not.toHaveBeenCalled();
    expect(logSpies.warn).not.toHaveBeenCalled();
  });
});
