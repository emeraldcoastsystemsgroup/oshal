import { describe, expect, it } from 'vitest';
import { emitToolAudit } from '../../src/app/routes/internal-tool-bridge-routes';

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

describe('emitToolAudit', () => {
  it('records a successful tool execution as a tool.execute allow event', async () => {
    const pool = fakePool();
    const ok = await emitToolAudit(pool as never, 'user-1', 'career_database', 'agent-abc', 'ok');
    expect(ok).toBe(true);
    const insert = pool.queries.find((q) => /INSERT INTO access_audit_log/i.test(q.sql));
    expect(insert?.params?.slice(1, 5)).toEqual(['tool.execute', 'tool', 'career_database', 'allow']);
    expect(insert?.params?.[5]).toContain('agent-abc');
  });

  it('records a failed execution with decision info', async () => {
    const pool = fakePool();
    await emitToolAudit(pool as never, 'user-2', 'gmail_send', 'agent-xyz', 'error');
    const insert = pool.queries.find((q) => /INSERT INTO access_audit_log/i.test(q.sql));
    expect(insert?.params?.[1]).toBe('tool.execute');
    expect(insert?.params?.[4]).toBe('info');
    expect(insert?.params?.[5]).toContain('error');
  });

  it('no-ops without a pool', async () => {
    expect(await emitToolAudit(null, 'u', 'x', 'a', 'ok')).toBe(false);
  });
});
