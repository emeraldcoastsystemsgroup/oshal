/**
 * Multi-account-per-provider guards (ADR-113 section 4).
 *
 * WHY THIS EXISTS: "two Gmails" has three independent failure points, and each one fails SILENTLY.
 *  1. UNIQUENESS. While `oshal_connections` carried `UNIQUE (user_sub, provider)` the second
 *     connect's ON CONFLICT UPDATED the first row — the user saw "connected", one account, no error.
 *     The guard interprets the real INSERT's ON CONFLICT target against a fake store, so narrowing
 *     the target back to (user_sub, provider) collapses the two accounts and goes red.
 *  2. DETERMINISM. Resolution used to fall back to the first row of an `updated_at DESC` list. A
 *     token refresh rewrites updated_at, so with two accounts and no marked default, "the user's
 *     Gmail token" changed identity between two calls — the worst possible bug shape for a bot that
 *     sends mail. The guard pins that the answer depends only on the marked default and a stable
 *     tiebreak, never on recency or the order rows come back in.
 *  3. DEFAULT SURVIVAL. Removing the default account must promote another, or resolution silently
 *     drops onto the tiebreak.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — two-accounts-same-provider-coexist (schema + upsert semantics), token-resolution-deterministic-with-two-accounts (pure rule + the real getValidAccessToken over a fake pool), default-survives-disconnect, and the account-chooser param table that makes a second Google account reachable at all.
 */
import { describe, expect, it } from 'vitest';
import {
  pickConnection, upsertConnection, ensureTenancySchema, disconnectConnections,
  type ConnectionRow,
} from '@/app/routes/connector-tenancy';
import { additionalAccountAuthParams, ensureConnectionsSchema, getValidAccessToken } from '@/app/routes/connectors-routes';
import { encryptToken } from '@/app/routes/connector-token-crypto';

const SUB = 'auth0|multi-account-user';

/** A personal (tenant_id NULL) connection row, fully populated. */
function row(over: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    connection_id: 'conn-a',
    user_sub: SUB,
    connected_by_sub: null,
    tenant_id: null,
    provider: 'google',
    label: 'work',
    account_key: 'acct-a',
    is_default: false,
    account_email: 'work@example.com',
    account_id: 'acct-a',
    scopes: 'openid',
    access_token: null,
    refresh_token: null,
    expiry: new Date(Date.now() + 3_600_000),
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

/**
 * A fake pool that INTERPRETS the statements under test rather than pattern-matching them:
 * an INSERT's own column list, bind params and `ON CONFLICT (…)` target decide how rows are keyed,
 * exactly as Postgres would with the partial unique indexes. That is what makes the coexistence
 * assertion mutation-proof — the semantics are read out of the SQL, not asserted as a substring.
 */
function fakeStore() {
  const rows: Array<Record<string, unknown>> = [];
  const statements: string[] = [];
  let nextId = 0;
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      statements.push(sql);
      const insert = /INSERT INTO oshal_connections\s*\(([^)]+)\)/i.exec(sql);
      if (insert) {
        const cols = insert[1].split(',').map((c) => c.trim());
        const values = /VALUES\s*\(([^)]+)\)/i.exec(sql);
        const record: Record<string, unknown> = {};
        const placeholders = (values?.[1] ?? '').split(',').map((v) => v.trim());
        cols.forEach((col, i) => {
          const ph = placeholders[i] ?? '';
          const m = /^\$(\d+)$/.exec(ph);
          record[col] = m ? params[Number(m[1]) - 1] : ph.replace(/^'|'$/g, '');
        });
        const target = /ON CONFLICT\s*\(([^)]+)\)/i.exec(sql);
        const keyCols = (target?.[1] ?? '').split(',').map((c) => c.trim()).filter(Boolean);
        const keyOf = (r: Record<string, unknown>) => keyCols.map((c) => String(r[c] ?? '')).join('|');
        const existing = keyCols.length ? rows.find((r) => keyOf(r) === keyOf(record)) : undefined;
        if (existing) Object.assign(existing, record);
        else rows.push({ connection_id: `generated-${nextId++}`, is_default: false, created_at: new Date(2026, 0, rows.length + 1), ...record });
        return { rows: [{ connection_id: (existing ?? rows[rows.length - 1]).connection_id }], rowCount: 1 };
      }
      if (/^\s*SELECT/i.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  };
  return { pool, rows, statements };
}

/** Connect one account of one provider through the real upsert. */
async function connect(pool: { query: (sql: string, params?: unknown[]) => Promise<unknown> }, accountId: string, label: string) {
  await upsertConnection(pool, {
    userSub: SUB, userEmail: 'me@example.com', provider: 'google',
    accountEmail: `${accountId}@example.com`, accountId, scopes: 'openid',
    encAccess: `enc-${accountId}`, encRefresh: null, expiry: null, connectedBySub: SUB, label,
  });
}

describe('two-accounts-same-provider-coexist', () => {
  it('keeps two DIFFERENT accounts of one provider as two rows, and a re-auth of the same account as one', async () => {
    const a = fakeStore();
    await connect(a.pool, 'acct-work', 'work');
    await connect(a.pool, 'acct-home', 'home');
    expect(a.rows).toHaveLength(2);
    expect(a.rows.map((r) => r.label).sort()).toEqual(['home', 'work']);

    const b = fakeStore();
    await connect(b.pool, 'acct-work', 'work');
    await connect(b.pool, 'acct-work', 'work');
    expect(b.rows).toHaveLength(1);
  });

  it('never creates the one-account-per-provider UNIQUE constraint, and creates the per-account indexes instead', async () => {
    const created = fakeStore();
    await ensureConnectionsSchema(created.pool as never);
    // Strip SQL comments first: what matters is the EFFECTIVE DDL, not prose about it.
    const createTable = (created.statements.find((s) => /CREATE TABLE IF NOT EXISTS oshal_connections/i.test(s)) ?? '')
      .replace(/--.*$/gm, '');
    expect(createTable).not.toMatch(/UNIQUE\s*\(\s*user_sub\s*,\s*provider\s*\)/i);

    const tenancy = fakeStore();
    await ensureTenancySchema(tenancy.pool);
    const all = tenancy.statements.join('\n');
    // The legacy constraint is actively retired, and uniqueness is per ACCOUNT in both scopes.
    expect(all).toMatch(/DROP CONSTRAINT IF EXISTS oshal_connections_user_sub_provider_key/i);
    expect(all).toMatch(/oshal_conn_personal_acct_uq[\s\S]*user_sub, provider, account_key/i);
    expect(all).toMatch(/oshal_conn_shared_acct_uq[\s\S]*tenant_id, provider, account_key/i);
  });

  it('makes the FIRST account of a provider the default, and leaves an existing default alone', async () => {
    const s = fakeStore();
    const seeds: string[] = [];
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        if (/SET is_default = TRUE/i.test(sql)) { seeds.push(sql); return { rows: [], rowCount: 1 }; }
        return s.pool.query(sql, params ?? []);
      },
    };
    await connect(pool, 'acct-work', 'work');
    expect(seeds).toHaveLength(1);
    // Conditional by construction: the seed only fires when the scope has NO default yet.
    expect(seeds[0]).toMatch(/NOT EXISTS/i);
  });
});

describe('token-resolution-deterministic-with-two-accounts', () => {
  const work = row({ connection_id: 'c-work', account_key: 'acct-work', label: 'work', account_email: 'work@example.com', created_at: new Date('2026-01-01T00:00:00Z') });
  const home = row({ connection_id: 'c-home', account_key: 'acct-home', label: 'home', account_email: 'home@example.com', created_at: new Date('2026-02-01T00:00:00Z') });

  it('returns the SAME account whichever order the rows arrive in', () => {
    expect(pickConnection([work, home])?.connection_id).toBe('c-work');
    expect(pickConnection([home, work])?.connection_id).toBe('c-work');
  });

  it('ignores recency entirely — refreshing the newer account does not move the answer', () => {
    const refreshedHome = { ...home, expiry: new Date(Date.now() + 7_200_000) };
    expect(pickConnection([refreshedHome, work])?.connection_id).toBe('c-work');
  });

  it('honours the account the user MARKED default over the stable tiebreak', () => {
    const homeDefault = { ...home, is_default: true };
    expect(pickConnection([work, homeDefault])?.connection_id).toBe('c-home');
    expect(pickConnection([homeDefault, work])?.connection_id).toBe('c-home');
  });

  it('breaks a created_at tie on connection_id so the rule is total', () => {
    const twin = { ...home, created_at: work.created_at };
    expect(pickConnection([twin, work])?.connection_id).toBe('c-home'); // 'c-home' < 'c-work'
    expect(pickConnection([work, twin])?.connection_id).toBe('c-home');
  });

  it('resolves an explicit selector exactly, and returns NOTHING when a named selector misses', () => {
    expect(pickConnection([work, home], { label: 'HOME' })?.connection_id).toBe('c-home');
    expect(pickConnection([work, home], { email: 'work@example.com' })?.connection_id).toBe('c-work');
    expect(pickConnection([work, home], { connectionId: 'c-home' })?.connection_id).toBe('c-home');
    // A miss must NOT silently fall back to the default — a bot has to be able to fail visibly.
    expect(pickConnection([work, home], { label: 'holiday' })).toBeNull();
    expect(pickConnection([work, home], { email: 'nobody@example.com' })).toBeNull();
  });

  it('prefers a household connection over a personal one only as a tiebreak, never over a marked default', () => {
    const shared = row({ connection_id: 'c-shared', tenant_id: 'tenant-1', created_at: new Date('2026-03-01T00:00:00Z') });
    expect(pickConnection([work, shared])?.connection_id).toBe('c-shared');
    expect(pickConnection([{ ...work, is_default: true }, shared])?.connection_id).toBe('c-work');
    expect(pickConnection([work, shared], { tenantId: 'personal' })?.connection_id).toBe('c-work');
  });

  it('resolves the real getValidAccessToken to the marked default, not the row the pool returns first', async () => {
    process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'multi-account-guard-secret';
    // Real crypto: the per-user DEK table is served from memory so the encrypt/decrypt round trip
    // is genuine (a stubbed decrypt would not prove the resolved ROW is the one that gets decrypted).
    const deks = new Map<string, string>();
    let connections: Array<Record<string, unknown>> = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        if (/FROM oshal_user_deks/i.test(sql)) {
          const wrapped = deks.get(String(params[0]));
          return { rows: wrapped ? [{ wrapped_dek: wrapped }] : [] };
        }
        if (/INSERT INTO oshal_user_deks/i.test(sql)) {
          if (!deks.has(String(params[0]))) deks.set(String(params[0]), String(params[1]));
          return { rows: [] };
        }
        if (/FROM oshal_tenant_memberships/i.test(sql)) return { rows: [] };
        if (/FROM oshal_connections/i.test(sql)) return { rows: connections };
        return { rows: [] };
      },
    } as never;
    const encWork = await encryptToken(pool, SUB, 'token-for-work');
    const encHome = await encryptToken(pool, SUB, 'token-for-home');
    // The pool deliberately returns the NON-default account FIRST.
    connections = [
      { ...home, is_default: false, access_token: encHome },
      { ...work, is_default: true, access_token: encWork },
    ];
    await expect(getValidAccessToken(pool, SUB, 'google')).resolves.toBe('token-for-work');
    await expect(getValidAccessToken(pool, SUB, 'google', { label: 'home' })).resolves.toBe('token-for-home');
  });
});

describe('a SECOND account of a provider is reachable at all', () => {
  it('forces the provider account chooser once one account is connected', () => {
    expect(additionalAccountAuthParams('google', 1)).toEqual({ prompt: 'select_account consent' });
    expect(additionalAccountAuthParams('microsoft', 2)).toEqual({ prompt: 'select_account' });
  });

  it('leaves a first-time connect untouched', () => {
    expect(additionalAccountAuthParams('google', 0)).toEqual({});
    expect(additionalAccountAuthParams('microsoft', 0)).toEqual({});
  });

  it('honours an explicit ?another=1 with nothing connected yet', () => {
    expect(additionalAccountAuthParams('google', 0, true)).toEqual({ prompt: 'select_account consent' });
  });

  it('does not invent params for a dialect with no account chooser', () => {
    expect(additionalAccountAuthParams('twitter', 3)).toEqual({});
    expect(additionalAccountAuthParams('schwab', 3, true)).toEqual({});
  });
});

describe('multi-account default survives a disconnect', () => {
  it('re-seeds the provider default after the default account is removed', async () => {
    const seeds: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        if (/SET is_default = TRUE/i.test(sql)) seeds.push({ sql, params });
        return { rows: [], rowCount: 1 };
      },
    };
    const removed = await disconnectConnections(pool, SUB, ['c-work'], 'google');
    expect(removed).toBe(1);
    expect(seeds).toHaveLength(1);
    // Promotion is stable (oldest first), never recency-based.
    expect(seeds[0].sql).toMatch(/ORDER BY created_at, connection_id/i);
    expect(seeds[0].params).toContain('google');
  });

  it('deletes ONLY the caller\'s own personal rows', async () => {
    const deletes: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        if (/^\s*DELETE/i.test(sql)) deletes.push({ sql, params });
        return { rows: [], rowCount: 1 };
      },
    };
    await disconnectConnections(pool, SUB, ['c-work', 'c-home'], 'google');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].sql).toMatch(/user_sub = \$2/);
    expect(deletes[0].sql).toMatch(/tenant_id IS NULL/);
    expect(deletes[0].params[1]).toBe(SUB);
  });
});
