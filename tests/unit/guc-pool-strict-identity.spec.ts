/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Repo-audit (guc-pool fail-open-to-operator): proves OSHAL_DB_GUC_STRICT — default 'off' keeps identity-less work as trusted operator context (is_operator='on'); 'warn' keeps operator but audits each unique fail-open call site once; 'deny' stamps anonymous non-operator (is_operator='off', RLS scopes to nothing). A request WITH identity is always scoped to that identity regardless of the knob.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Deny-by-default flip: the DEFAULT (no env) is now 'deny' — identity-less is stamped anonymous non-operator (is_operator='off'). 'off' is the break-glass that restores operator; unrecognized values fall back to deny (fail-closed). Added: the runWithSystemIdentity sentinel is STILL stamped operator under the deny default (the escape hatch background work uses).
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { wrapPoolWithGuc, gucStrictMode, _resetFailOpenAudit } from '../../src/shared/services/database/guc-pool';
import { runWithRequestIdentity, runWithSystemIdentity } from '../../src/shared/services/database/request-identity';
import type { Pool } from 'pg';

const ENV = 'OSHAL_DB_GUC_STRICT';
let saved: string | undefined;

beforeEach(() => { saved = process.env[ENV]; delete process.env[ENV]; _resetFailOpenAudit(); });
afterEach(() => { if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved; vi.restoreAllMocks(); });

/** A fake pg client that records every set_config call so we can read the stamped is_operator. */
function fakeClient() {
  const setConfigCalls: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    setConfigCalls,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (String(sql).includes('set_config')) setConfigCalls.push({ sql, params });
      return { rows: [] };
    }),
    release: vi.fn(),
  };
}

/** A fake Pool whose connect() yields the given client; wrapPoolWithGuc only uses connect/query. */
function fakePool(client: ReturnType<typeof fakeClient>): Pool {
  return { connect: vi.fn(async () => client) } as unknown as Pool;
}

/**
 * Reads the is_operator the wrapper stamped. The identity branch parameterizes it (last param);
 * the background branch (system/deny) uses a literal `is_operator', 'on'|'off'` in the SQL text.
 */
function stampedIsOperator(client: ReturnType<typeof fakeClient>): string | undefined {
  const stamp = client.setConfigCalls.find((c) => String(c.sql).includes('is_operator'));
  if (!stamp) return undefined;
  if (Array.isArray(stamp.params) && stamp.params.length > 0) return String(stamp.params[stamp.params.length - 1]);
  const m = String(stamp.sql).match(/is_operator',\s*'(on|off)'/);
  return m ? m[1] : undefined;
}

describe('guc-pool fail-open strict mode', () => {
  it('default (deny, no env): identity-less query is stamped anonymous non-operator (is_operator=off)', async () => {
    const client = fakeClient();
    const pool = wrapPoolWithGuc(fakePool(client));
    await pool.query('SELECT 1');
    // Fail-closed by default: a bare identity-less DB access is scoped to nothing under RLS.
    expect(gucStrictMode()).toBe('deny');
    expect(stampedIsOperator(client)).toBe('off');
  });

  it('off (break-glass): identity-less query restores the historical trusted operator (is_operator=on)', async () => {
    process.env[ENV] = 'off';
    const client = fakeClient();
    const pool = wrapPoolWithGuc(fakePool(client));
    await pool.query('SELECT 1');
    expect(gucStrictMode()).toBe('off');
    expect(stampedIsOperator(client)).toBe('on');
  });

  it('unrecognized value falls back to deny (fail-closed)', async () => {
    process.env[ENV] = 'lenient'; // typo / unknown → must NOT relax to operator
    const client = fakeClient();
    const pool = wrapPoolWithGuc(fakePool(client));
    await pool.query('SELECT 1');
    expect(gucStrictMode()).toBe('deny');
    expect(stampedIsOperator(client)).toBe('off');
  });

  it('the SYSTEM sentinel is stamped operator even under the deny default (background escape hatch)', async () => {
    const client = fakeClient();
    const pool = wrapPoolWithGuc(fakePool(client));
    await runWithSystemIdentity(() => pool.query('SELECT 1'));
    expect(gucStrictMode()).toBe('deny');
    expect(stampedIsOperator(client)).toBe('on');
  });

  it('warn: keeps operator behavior (audit-only, does not deny) and does not throw on repeat sites', async () => {
    process.env[ENV] = 'warn';
    expect(gucStrictMode()).toBe('warn');
    const client = fakeClient();
    const pool = wrapPoolWithGuc(fakePool(client));
    await pool.query('SELECT 1');
    await pool.query('SELECT 2'); // same call site → deduped warn, still fine
    // warn is audit-only: identity-less work is still stamped trusted operator (behavior unchanged).
    expect(stampedIsOperator(client)).toBe('on');
  });

  it('deny: identity-less query stamped anonymous non-operator (is_operator=off)', async () => {
    process.env[ENV] = 'deny';
    const client = fakeClient();
    const pool = wrapPoolWithGuc(fakePool(client));
    await pool.query('SELECT 1');
    expect(gucStrictMode()).toBe('deny');
    expect(stampedIsOperator(client)).toBe('off');
  });

  it('a request WITH identity is scoped to that identity regardless of strict mode', async () => {
    for (const mode of ['off', 'warn', 'deny'] as const) {
      process.env[ENV] = mode;
      const client = fakeClient();
      const pool = wrapPoolWithGuc(fakePool(client));
      await runWithRequestIdentity({ sub: 'auth0|alice', isOperator: false }, () => pool.query('SELECT 1'));
      // scoped to the caller: sub set, is_operator off — never fails open to operator
      const stamp = client.setConfigCalls.find((c) => Array.isArray(c.params));
      expect(stamp?.params).toEqual(['auth0|alice', 'off']);
    }
  });

  it('an operator request is stamped operator even under deny (identity present, not fail-open)', async () => {
    process.env[ENV] = 'deny';
    const client = fakeClient();
    const pool = wrapPoolWithGuc(fakePool(client));
    await runWithRequestIdentity({ sub: 'auth0|op', isOperator: true }, () => pool.query('SELECT 1'));
    expect(stampedIsOperator(client)).toBe('on');
  });
});
