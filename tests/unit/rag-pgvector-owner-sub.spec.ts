/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the rag_chunks owner_sub fix (BACKLOG security burn-down): migration 070's RLS policies compare the owner_sub COLUMN to the identity GUCs, but the pgvector engine wrote every chunk with the column NULL (ACL only in metadata JSONB) through a private UNWRAPPED pool — so the database-layer backstop was inert for every engine-written row. This spec drives the REAL engine against an injected pool and asserts the two halves that make RLS bite: (1) addChunks lifts metadata.owner_sub into the owner_sub INSERT column (and leaves shared-corpus chunks NULL); (2) the engine pool is GUC-wrapped — a user-identity ingest stamps oshal.current_sub on the SAME connection BEFORE the INSERT and resets it after, and a SYSTEM-sentinel (background sweep) ingest stamps operator. Remove the column population or unwrap the pool and this file goes red exactly the way the live WITH CHECK / read policies would.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  runWithRequestIdentity,
  runWithSystemIdentity,
} from '../../src/shared/services/database/request-identity';
import {
  PgvectorRagEngine,
  _setRagPoolForTests,
} from '../../src/features/rag/services/pgvector-rag-engine';

const ENV_KEYS = ['OSHAL_DB_GUC', 'OSHAL_DB_GUC_STRICT'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  _setRagPoolForTests(null);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Captures every statement the engine's (wrapped) pool runs, in order, per connection. */
function capturingPool() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params: params ?? [] });
      return { rows: [], rowCount: 0 };
    },
    release(_destroy?: unknown) { /* no-op */ },
  };
  const pool = {
    calls,
    async connect() { return client; },
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params: params ?? [] });
      return { rows: [], rowCount: 0 };
    },
  };
  return pool as unknown as Pool & { calls: typeof calls };
}

function callIndex(calls: Array<{ sql: string }>, needle: string): number {
  return calls.findIndex((c) => c.sql.includes(needle));
}

describe('pgvector rag engine: owner_sub reaches the COLUMN and identity reaches the CONNECTION', () => {
  it('a user-identity ingest stamps oshal.current_sub before the INSERT, writes owner_sub from metadata, and resets after', async () => {
    const pool = capturingPool();
    _setRagPoolForTests(pool);
    const engine = new PgvectorRagEngine();

    await runWithRequestIdentity({ sub: 'user-a', isOperator: false }, () =>
      engine.addChunks(
        'notes',
        ['c1', 'c2', 'c3'],
        ['private doc', 'shared doc', 'blank-owner doc'],
        [{ owner_sub: 'user-a' }, {}, { owner_sub: '   ' }],
        null,
      ));

    const calls = pool.calls;
    const setIdx = callIndex(calls, 'set_config');
    const insertIdx = callIndex(calls, 'INSERT INTO rag_chunks');
    const resetIdx = callIndex(calls, 'RESET oshal.current_sub');

    // (2) the pool is GUC-wrapped: identity BEFORE the insert, reset AFTER — on the same client.
    expect(setIdx, 'no identity GUC was stamped — the engine pool is no longer wrapped').toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeGreaterThan(setIdx);
    expect(resetIdx).toBeGreaterThan(insertIdx);
    expect(calls[setIdx].params).toEqual(['user-a', 'off']); // the caller's sub, not operator

    // (1) the INSERT names the owner_sub column and carries the per-chunk owner values.
    const insert = calls[insertIdx];
    expect(insert.sql).toContain('owner_sub');
    // 6 params per chunk: chunk_id, collection, document, metadata, embedding, owner_sub.
    expect(insert.params.length).toBe(18);
    expect(insert.params[5]).toBe('user-a'); // metadata.owner_sub → column
    expect(insert.params[11]).toBeNull();    // no ACL → shared corpus (NULL)
    expect(insert.params[17]).toBeNull();    // whitespace ACL → NULL, never an empty-string owner
    // The metadata JSONB still carries the ACL for the app-side permission filter.
    expect(String(insert.params[3])).toContain('"owner_sub":"user-a"');
  });

  it('a SYSTEM-sentinel (background sweep) ingest is stamped operator, so FORCE-RLS keeps accepting it', async () => {
    const pool = capturingPool();
    _setRagPoolForTests(pool);
    const engine = new PgvectorRagEngine();

    await runWithSystemIdentity(() =>
      engine.addChunks('feeds', ['f1'], ['feed doc'], [{ owner_sub: 'user-b' }], null));

    const calls = pool.calls;
    const setIdx = callIndex(calls, 'set_config');
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(calls[setIdx].sql).toContain("set_config('oshal.is_operator', 'on', false)");
    const insert = calls[callIndex(calls, 'INSERT INTO rag_chunks')];
    expect(insert.params[5]).toBe('user-b'); // the sweep still attributes the row to its owner
  });

  it('search rides the same wrapped pool — the read leg carries the caller identity too', async () => {
    const pool = capturingPool();
    _setRagPoolForTests(pool);
    const engine = new PgvectorRagEngine();

    await runWithRequestIdentity({ sub: 'user-c', isOperator: false }, () =>
      engine.search('notes', 'find my doc', null, 5));

    const calls = pool.calls;
    const setIdx = callIndex(calls, 'set_config');
    expect(setIdx, 'search ran identity-less — owned rows would be invisible to their own user').toBeGreaterThanOrEqual(0);
    expect(calls[setIdx].params).toEqual(['user-c', 'off']);
  });
});
