import { describe, it, expect, vi } from 'vitest';
import { gucEnabled, wrapPoolWithGuc } from '../../src/shared/services/database/guc-pool';
import { runWithRequestIdentity, runWithSystemIdentity } from '../../src/shared/services/database/request-identity';

/** Minimal fake PoolClient that records every query() it receives. */
function makeFakeClient() {
  const calls: Array<{ text: unknown; params?: unknown }> = [];
  return {
    calls,
    query: vi.fn(async (text: unknown, params?: unknown) => {
      calls.push({ text, params });
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
}

/** Minimal fake Pool whose connect() hands out a given client. */
function makeFakePool(client: ReturnType<typeof makeFakeClient>) {
  return {
    connect: vi.fn(async () => client),
    query: vi.fn(async () => ({ rows: ['raw-pool-query'] })),
    end: vi.fn(async () => undefined),
    totalCount: 7,
  };
}

describe('wrapPoolWithGuc', () => {
  it('enables GUC stamping by default and accepts explicit rollback flags', () => {
    const previous = process.env.OSHAL_DB_GUC;
    try {
      delete process.env.OSHAL_DB_GUC;
      expect(gucEnabled()).toBe(true);
      process.env.OSHAL_DB_GUC = 'off';
      expect(gucEnabled()).toBe(false);
      process.env.OSHAL_DB_GUC = 'false';
      expect(gucEnabled()).toBe(false);
      process.env.OSHAL_DB_GUC = 'on';
      expect(gucEnabled()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.OSHAL_DB_GUC;
      else process.env.OSHAL_DB_GUC = previous;
    }
  });

  it('denies (anonymous non-operator) when there is no request identity — deny-by-default', async () => {
    const client = makeFakeClient();
    const wrapped = wrapPoolWithGuc(makeFakePool(client) as never);

    await (wrapped as { query: (t: string) => Promise<unknown> }).query('SELECT 1');

    // set GUCs -> real query -> reset, all on the SAME checked-out client.
    expect(client.calls).toHaveLength(3);
    expect(String(client.calls[0].text)).toContain('set_config');
    // OSHAL_DB_GUC_STRICT now defaults to deny: an identity-less connection is stamped
    // anonymous non-operator (RLS scopes it to zero rows), NOT fail-open-to-operator.
    // Trusted background work opts in explicitly via runWithSystemIdentity (next test).
    expect(String(client.calls[0].text)).toContain("'off'");
    expect(String(client.calls[0].text)).not.toContain("'on'");
    expect(client.calls[1]).toEqual({ text: 'SELECT 1', params: undefined });
    expect(String(client.calls[2].text)).toContain('RESET');
    // reset succeeded => connection returned to the pool clean (no destroy flag).
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it('stamps operator context under the runWithSystemIdentity sentinel', async () => {
    const client = makeFakeClient();
    const wrapped = wrapPoolWithGuc(makeFakePool(client) as never);

    await runWithSystemIdentity(() =>
      (wrapped as { query: (t: string) => Promise<unknown> }).query('SELECT background_sweep'),
    );

    // The positive trusted-system marker is stamped operator regardless of strict mode —
    // this is the explicit opt-in that replaces the old absent-identity fail-open.
    const stamp = `${String(client.calls[0].text)} ${JSON.stringify(client.calls[0].params ?? [])}`;
    expect(stamp).toMatch(/['"]on['"]/); // 'on' inline or "on" as a param — either form
    expect(stamp).not.toMatch(/['"]off['"]/);
    expect(client.calls[1]).toEqual({ text: 'SELECT background_sweep', params: undefined });
  });

  it('stamps the caller sub + operator flag from the request identity', async () => {
    const client = makeFakeClient();
    const wrapped = wrapPoolWithGuc(makeFakePool(client) as never);

    await runWithRequestIdentity({ sub: 'user-123', isOperator: false }, () =>
      (wrapped as { query: (t: string) => Promise<unknown> }).query('SELECT 2'),
    );

    expect(client.calls[0].params).toEqual(['user-123', 'off']);
    expect(client.calls[1]).toEqual({ text: 'SELECT 2', params: undefined });
  });

  it('stamps anonymous request identity as non-operator, distinct from background system work', async () => {
    const client = makeFakeClient();
    const wrapped = wrapPoolWithGuc(makeFakePool(client) as never);

    await runWithRequestIdentity({ sub: null, isOperator: false }, () =>
      (wrapped as { query: (t: string) => Promise<unknown> }).query('SELECT public_route_read'),
    );

    expect(client.calls[0].params).toEqual(['', 'off']);
    expect(client.calls[1]).toEqual({ text: 'SELECT public_route_read', params: undefined });
  });

  it('stamps trusted service-secret requests as operator without requiring a user sub', async () => {
    const client = makeFakeClient();
    const wrapped = wrapPoolWithGuc(makeFakePool(client) as never);

    await runWithRequestIdentity({ sub: null, isOperator: true }, () =>
      (wrapped as { query: (t: string) => Promise<unknown> }).query('SELECT internal_service_read'),
    );

    expect(client.calls[0].params).toEqual(['', 'on']);
    expect(client.calls[1]).toEqual({ text: 'SELECT internal_service_read', params: undefined });
  });

  it('destroys the connection if the GUC reset fails (no identity leak to the pool)', async () => {
    const client = makeFakeClient();
    client.query.mockImplementation(async (text: unknown) => {
      if (String(text).includes('RESET')) throw new Error('reset boom');
      return { rows: [], rowCount: 0 };
    });
    const wrapped = wrapPoolWithGuc(makeFakePool(client) as never);

    await (wrapped as { query: (t: string) => Promise<unknown> }).query('SELECT 1');

    expect(client.release).toHaveBeenCalledWith(true); // destroy, don't reuse
  });

  it('delegates non-intercepted members untouched', async () => {
    const pool = makeFakePool(makeFakeClient());
    const wrapped = wrapPoolWithGuc(pool as never);

    expect((wrapped as unknown as { totalCount: number }).totalCount).toBe(7);
    await (wrapped as unknown as { end: () => Promise<void> }).end();
    expect(pool.end).toHaveBeenCalled();
  });

  it('passes callback-style query() straight through (no GUC stamping)', async () => {
    const pool = makeFakePool(makeFakeClient());
    const wrapped = wrapPoolWithGuc(pool as never);
    const cb = vi.fn();

    (wrapped as unknown as { query: (t: string, cb: () => void) => unknown }).query('SELECT 1', cb);

    expect(pool.query).toHaveBeenCalled(); // delegated to the raw pool, not connect()
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
