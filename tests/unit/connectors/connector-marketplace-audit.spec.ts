import { describe, expect, it } from 'vitest';
import { emitConnectorAudit } from '../../../src/app/routes/connector-marketplace-routes';

/** Records every SQL the audit emitter issues so we can assert the append-only INSERT. */
function fakePool() {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    queries,
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      return { rows: [] };
    },
  };
}

describe('emitConnectorAudit', () => {
  it('writes a connector enable as an access_audit_log row', async () => {
    const pool = fakePool();
    const ok = await emitConnectorAudit(pool as never, 'user-1', 'connector.enable', 'github');

    expect(ok).toBe(true);
    const insert = pool.queries.find((q) => /INSERT INTO access_audit_log/i.test(q.sql));
    expect(insert).toBeTruthy();
    expect(insert?.params?.slice(0, 5)).toEqual(['user-1', 'connector.enable', 'connector', 'github', 'allow']);
    expect(insert?.params?.[5]).toContain('marketplace');
  });

  it('carries the provider as the resource id for disable/remove', async () => {
    const pool = fakePool();
    await emitConnectorAudit(pool as never, 'user-2', 'connector.remove', 'slack');
    const insert = pool.queries.find((q) => /INSERT INTO access_audit_log/i.test(q.sql));
    expect(insert?.params?.[1]).toBe('connector.remove');
    expect(insert?.params?.[3]).toBe('slack');
  });

  it('no-ops (returns false, writes nothing) when no pool is available', async () => {
    expect(await emitConnectorAudit(null, 'user-3', 'connector.disable', 'jira')).toBe(false);
    expect(await emitConnectorAudit(undefined, null, 'connector.enable', 'github')).toBe(false);
  });
});
