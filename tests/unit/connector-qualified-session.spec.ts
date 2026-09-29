/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise actual qualified session + request ALS + GUC pool wrapper with a named physical-client/SQL double. Prove identity refusal, transaction cleanup and reset-before-reuse; not PostgreSQL/RLS proof.
 */
import { Duplex } from 'node:stream';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  withQualifiedConnectorSession as session, QualifiedConnectorSessionError, type QualifiedConnectorSessionClient,
} from '@/app/routes/connector-qualified-session';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { wrapPoolWithRuntimeDdlGuard } from '@/shared/services/database/schema-bootstrap-policy';
import { runWithRequestIdentity, runWithSystemIdentity } from '@/shared/services/database/request-identity';

const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/shared/logger', () => ({ createChildLogger: () => logger }));
const A = { sub: 'session-owner-sentinel', principalIssuer: 'https://session.example.com' };
const B = { ...A, principalIssuer: 'https://another-session.example.com' };
const code = (value: string) => ({ name: 'QualifiedConnectorSessionError', code: value });

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Only the physical pg client is doubled. Actual production GUC proxy stamps/resets identity from real ALS. */
function fixture() {
  const events: string[] = [], released = deferred<void>();
  const hooks: { before?: (sql: string) => void | Promise<void>; after?: (sql: string) => void | Promise<void> } = {};
  const rawRelease = vi.fn((destroy?: unknown) => { events.push(destroy === true ? 'discard' : 'reuse'); released.resolve(); });
  const physical = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      events.push(sql); await hooks.before?.(sql);
      if (sql.startsWith('SELECT set_config')) expect(values).toEqual([A.sub, A.principalIssuer, 'off']);
      await hooks.after?.(sql);
      return { rows: [] };
    }),
    release: rawRelease,
  };
  const raw = { connect: vi.fn(async () => physical) };
  const db = wrapPoolWithGuc(raw as unknown as Pool);
  const run = <T>(work: Parameters<typeof session<T>>[2], signal?: AbortSignal) =>
    runWithRequestIdentity({ ...A, isOperator: false }, () => session(db, A, work, { signal }));
  return { events, released, hooks, physical, rawRelease, raw, db, run };
}

describe('qualified owner session: real GUC/ALS plumbing, physical SQL double only', () => {
  it('uses the existing exact non-operator GUC stamp, commits and resets before client reuse', async () => {
    const f = fixture();
    const result = await f.run(async client => { await client.query('SELECT work_sentinel'); return { safe: true }; });
    await f.released.promise;
    expect(result).toEqual({ safe: true });
    expect(f.events).toEqual([
      "SELECT set_config('oshal.current_sub', $1, false), set_config('oshal.current_issuer', $2, false), set_config('oshal.is_operator', $3, false)",
      'BEGIN ISOLATION LEVEL READ COMMITTED', 'SELECT work_sentinel', 'COMMIT',
      'RESET oshal.current_sub; RESET oshal.current_issuer; RESET oshal.is_operator', 'reuse',
    ]);
    expect(f.raw.connect).toHaveBeenCalledOnce();
    expect(f.rawRelease).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('rejects matching owner operator sessions, system, anonymous and wrong issuer/sub before pool acquisition', async () => {
    const f = fixture(), work = vi.fn(async () => true);
    await expect(session(f.db, A, work)).rejects.toMatchObject(code('not_authorized'));
    await expect(runWithSystemIdentity(() => session(f.db, A, work))).rejects.toMatchObject(code('not_authorized'));
    for (const id of [{ ...A, isOperator: true }, { ...B, isOperator: false },
      { ...A, sub: null, isOperator: false }, { ...A, sub: 'other-owner-sentinel', isOperator: false },
      { ...A, principalIssuer: null, isOperator: false }]) {
      await expect(runWithRequestIdentity(id, () => session(f.db, A, work))).rejects.toMatchObject(code('not_authorized'));
    }
    expect(f.raw.connect).not.toHaveBeenCalled(); expect(work).not.toHaveBeenCalled();
  });

  it.each([{ ...A, sub: ' padded' }, { ...A, principalIssuer: '' }, { ...A, sub: '\ud800' }])('rejects malformed owner %j without normalizing', async who => {
    const f = fixture();
    await expect(runWithRequestIdentity({ ...who, isOperator: false }, () => session(f.db, who, async () => true))).rejects.toMatchObject(code('not_authorized'));
    expect(f.raw.connect).not.toHaveBeenCalled();
  });

  it('keeps the supplied principal snapshot immutable across checkout', async () => {
    const f = fixture(), who = { ...A };
    f.hooks.after = sql => { if (sql.startsWith('SELECT set_config')) who.principalIssuer = B.principalIssuer; };
    expect(await runWithRequestIdentity({ ...A, isOperator: false }, () => session(f.db, who, async () => 'ok'))).toBe('ok');
    await f.released.promise;
    expect(f.events).toContain('COMMIT');
  });

  it.each(['stamp', 'begin', 'work'])('detects request replacement after %s and rolls back/discards', async phase => {
    const f = fixture(), identity = { ...A, isOperator: false };
    f.hooks.after = sql => {
      if ((phase === 'stamp' && sql.startsWith('SELECT set_config')) || (phase === 'begin' && sql.startsWith('BEGIN'))) identity.principalIssuer = B.principalIssuer;
    };
    await expect(runWithRequestIdentity(identity, () => session(f.db, A, async () => {
      if (phase === 'work') identity.isOperator = true; return 'not-returned';
    }))).rejects.toMatchObject(code('not_authorized'));
    await f.released.promise;
    expect(f.events).not.toContain('COMMIT'); expect(f.events).toContain('ROLLBACK');
    expect(f.rawRelease).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('rolls back before propagating caller-owned typed business refusal without logging its contents', async () => {
    const f = fixture(), refusal = Object.assign(new Error('business-detail-token-sentinel'), { code: 'conflict' });
    await expect(f.run(async client => { await client.query('SELECT work_sentinel'); throw refusal; })).rejects.toBe(refusal);
    await f.released.promise;
    expect(f.events.indexOf('ROLLBACK')).toBeLessThan(f.events.indexOf('discard'));
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('business-detail-token-sentinel');
    for (const [fields] of logger.error.mock.calls) expect(fields.err.cause).toBeUndefined();
  });

  it.each(['stamp', 'BEGIN', 'COMMIT'])('sanitizes %s lifecycle failure and discards the physical client', async phase => {
    const f = fixture();
    f.hooks.before = sql => { if (phase === 'stamp' ? sql.startsWith('SELECT set_config') : sql.startsWith(phase)) throw new Error('driver-detail-token-sentinel'); };
    await expect(f.run(async () => 'not-returned')).rejects.toMatchObject(code('storage_failure'));
    await f.released.promise;
    expect(f.rawRelease).toHaveBeenCalledExactlyOnceWith(true);
    for (const [fields] of logger.error.mock.calls) expect(fields.err.message).not.toContain('driver-detail-token-sentinel');
  });

  it('does not leak a client when checkout rejects', async () => {
    const f = fixture(); f.raw.connect.mockRejectedValueOnce(new Error('checkout-detail-token-sentinel'));
    await expect(f.run(async () => true)).rejects.toMatchObject(code('storage_failure'));
    expect(f.rawRelease).not.toHaveBeenCalled();
  });

  it('discards on failed rollback and failed reset instead of returning dirty context to the pool', async () => {
    const f = fixture();
    f.hooks.before = sql => { if (sql === 'ROLLBACK' || sql.startsWith('RESET')) throw new Error('cleanup-detail-token-sentinel'); };
    const refusal = new Error('safe callback refusal');
    await expect(f.run(async () => { throw refusal; })).rejects.toBe(refusal);
    await f.released.promise;
    expect(f.rawRelease).toHaveBeenCalledExactlyOnceWith(true);
    expect(f.events).not.toContain('reuse');
  });

  it('waits for the existing GUC reset before the raw pool client can be reused', async () => {
    const f = fixture(), resetStarted = deferred<void>(), reset = deferred<void>();
    f.hooks.before = sql => { if (sql.startsWith('RESET')) { resetStarted.resolve(); return reset.promise; } };
    expect(await f.run(async () => 'committed')).toBe('committed');
    await resetStarted.promise;
    try { expect(f.rawRelease).not.toHaveBeenCalled(); }
    finally { reset.resolve(); }
    await f.released.promise;
    expect(f.rawRelease).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('aborts before acquisition without work or identity fallback', async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await expect(f.run(async () => true, controller.signal)).rejects.toMatchObject(code('aborted'));
    expect(f.raw.connect).not.toHaveBeenCalled();
  });

  it.each(['checkout', 'work', 'commit'])('handles abort during %s without returning the result', async phase => {
    const f = fixture(), controller = new AbortController();
    f.hooks.after = sql => {
      if ((phase === 'checkout' && sql.startsWith('SELECT set_config')) || (phase === 'commit' && sql === 'COMMIT')) controller.abort();
    };
    await expect(f.run(async () => { if (phase === 'work') controller.abort(); return 'not-returned'; }, controller.signal)).rejects.toMatchObject(code('aborted'));
    await f.released.promise;
    expect(f.rawRelease).toHaveBeenCalledExactlyOnceWith(true);
    if (phase === 'commit') { expect(f.events).toContain('COMMIT'); expect(f.events).not.toContain('ROLLBACK'); }
    else { expect(f.events).not.toContain('COMMIT'); } // abort physically discards; do not queue rollback behind blocked work
  });

  it('sanitizes synchronous release failure even after a successful commit', async () => {
    const client = { query: vi.fn(async (_sql: string) => ({ rows: [] })), release: vi.fn(() => { throw new Error('release-detail-token-sentinel'); }) };
    await expect(runWithRequestIdentity({ ...A, isOperator: false }, () => session({ connect: async () => client }, A, async () => true)))
      .rejects.toMatchObject(code('storage_failure'));
    expect(client.query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(false);
    expect(new QualifiedConnectorSessionError('storage_failure').cause).toBeUndefined();
  });
});

/** No sockets: startup bytes only, while the installed pg client owns the query queue and cancellation. */
class HeldSessionTransport extends Duplex {
  readonly statements: string[] = [];
  _read() { /* no database answers */ }
  connect() { queueMicrotask(() => this.emit('connect')); return this; }
  setNoDelay() { return this; }
  _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    if (chunk[0] === 0) queueMicrotask(() => this.push(Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 0, 90, 0, 0, 0, 5, 73])));
    else if (chunk[0] === 81) this.statements.push(chunk.subarray(5, -1).toString());
    done();
  }
}

/** Real installed pg pool + production GUC/DDL wrappers. Successful SQL is explicitly doubled. */
function heldSessionPool(blockedSql: string) {
  const started = deferred<void>(), removed = deferred<void>();
  const wires: HeldSessionTransport[] = [], rejections: string[] = [], clientErrors: string[] = [];
  const pool = new Pool({ host: 'fixture.invalid', user: 'fixture', password: 'fixture', database: 'fixture',
    ssl: false, max: 1, idleTimeoutMillis: 0, connectionTimeoutMillis: 0,
    stream: () => { const wire = new HeldSessionTransport(); wires.push(wire); return wire; } });
  const releaseEvent = vi.fn();
  pool.on('release', releaseEvent); pool.on('remove', () => removed.resolve());
  pool.on('connect', client => {
    // The fixture owns checked-out-client errors, including deliberate transport teardown in red controls.
    client.on('error', error => clientErrors.push(String(error.message)));
    const raw = client.query.bind(client);
    Object.assign(client, { query(sql: string) {
      if (sql === blockedSql || sql.startsWith('RESET ')) {
        const pending = raw(sql);
        void pending.catch(error => rejections.push(String(error.message)));
        if (sql === blockedSql) started.resolve();
        return pending;
      }
      return Promise.resolve({ rows: [], rowCount: 0, fields: [], command: '', oid: 0 });
    } });
  });
  return { pool, db: wrapPoolWithRuntimeDdlGuard(wrapPoolWithGuc(pool)), started, removed, wires, rejections, clientErrors, releaseEvent };
}

describe('qualified session installed-pg physical disposal, in-memory transport (not PostgreSQL)', () => {
  it.each(['BEGIN ISOLATION LEVEL READ COMMITTED', 'SELECT held_work_sentinel', 'COMMIT'])(
    'aborts hung %s, rejects queued RESET and physically evicts the real client', async blocked => {
      vi.stubEnv('OSHAL_SCHEMA_BOOTSTRAP', 'validate-only');
      const f = heldSessionPool(blocked), controller = new AbortController();
      const work = vi.fn(async (client: QualifiedConnectorSessionClient) => { await client.query('SELECT held_work_sentinel'); return 'never-returned'; });
      try {
        const pending = runWithRequestIdentity({ ...A, isOperator: false },
          () => session(f.db, A, work, { signal: controller.signal }));
        const rejected = expect(pending).rejects.toMatchObject(code('aborted'));
        await f.started.promise;
        expect(f.pool.totalCount).toBe(1);
        controller.abort();
        await rejected;
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(f.wires[0].destroyed).toBe(true);
        await f.removed.promise;
        expect(f.pool.totalCount).toBe(0); expect(f.pool.idleCount).toBe(0);
        expect(f.wires[0].statements).toEqual([blocked]); // RESET cannot enter the held transport
        expect(f.rejections.length).toBeGreaterThanOrEqual(2);
        expect(f.rejections.every(message => /Connection terminated|Client was closed/.test(message))).toBe(true);
        expect(f.releaseEvent).toHaveBeenCalledOnce();
        expect(f.releaseEvent.mock.calls[0][0]).toBe(true);
        expect(f.clientErrors).toEqual([]);
        expect(work).toHaveBeenCalledTimes(blocked.startsWith('BEGIN') ? 0 : 1);
      } finally {
        controller.abort();
        for (const wire of f.wires) if (!wire.destroyed) wire.destroy(); // deterministic cleanup even for a red control
        await f.pool.end();
      }
    });

  it('bounds hung rollback then physically evicts without trusting wrapped release alone', async () => {
    vi.stubEnv('OSHAL_SCHEMA_BOOTSTRAP', 'validate-only');
    const f = heldSessionPool('ROLLBACK'), refusal = new Error('safe work refusal');
    try {
      const pending = runWithRequestIdentity({ ...A, isOperator: false },
        () => session(f.db, A, async () => { throw refusal; }));
      const rejected = expect(pending).rejects.toBe(refusal);
      await f.started.promise; await rejected;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(f.wires[0].destroyed).toBe(true);
      await f.removed.promise;
      expect(f.pool.totalCount).toBe(0); expect(f.pool.idleCount).toBe(0);
      expect(f.wires[0].destroyed).toBe(true); expect(f.wires[0].statements).toEqual(['ROLLBACK']);
    } finally {
      for (const wire of f.wires) if (!wire.destroyed) wire.destroy();
      await f.pool.end();
    }
  });

  it('disposes a late checkout after cancellation and never invokes work', async () => {
    const f = fixture(), held = deferred<QualifiedConnectorSessionClient>(), controller = new AbortController();
    const work = vi.fn(async () => true);
    const pending = runWithRequestIdentity({ ...A, isOperator: false },
      () => session({ connect: () => held.promise }, A, work, { signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toMatchObject(code('aborted'));
    held.resolve(f.physical); await f.released.promise;
    expect(f.rawRelease).toHaveBeenCalledExactlyOnceWith(true); expect(work).not.toHaveBeenCalled();
  });
});

