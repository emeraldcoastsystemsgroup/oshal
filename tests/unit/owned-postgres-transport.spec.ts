/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise real transport/DisposablePostgres control flow with explicitly doubled filesystem, PostgreSQL wire/client and Docker seams. Refusal/order/redaction guards only; NOT real server, mount, RLS or runtime proof.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fx = vi.hoisted(() => ({
  raw: '', os: 'linux', mount: '', symlink: '', mode: 0o100600, size: 0, claimed: false,
  malformedFile: false, marker: {} as Record<string, unknown>, fresh: {} as Record<string, unknown>,
  connectError: '', queryError: '', poolError: '', clock: 1_000_000,
  controls: [] as Array<Record<string, unknown>>, pools: [] as Array<Record<string, unknown>>,
  events: [] as string[], handlers: [] as Array<() => void>,
  writes: [] as Array<{ path: string; data: string }>,
  controlEnd: vi.fn(), poolEnd: vi.fn(), docker: vi.fn(), release: vi.fn(),
}));
vi.mock('node:os', async actual => ({ ...await actual<typeof import('node:os')>(), platform: () => fx.os }));
vi.mock('node:fs', async actual => {
  const real = await actual<typeof import('node:fs')>();
  return { ...real,
    lstatSync: (name: string) => ({ isSymbolicLink: () => name === fx.symlink }),
    fstatSync: () => ({ isFile: () => !fx.malformedFile, size: fx.size || Buffer.byteLength(fx.raw), mode: fx.mode }),
    openSync: (name: string) => {
      if (name.endsWith('.claim')) { if (fx.claimed) throw new Error('EEXIST'); fx.claimed = true; }
      return 33;
    },
    closeSync: vi.fn(),
    readFileSync: (name: string | number) => {
      if (name === '/proc/self/mountinfo') return fx.mount;
      if (name === 33) return fx.raw;
      if (String(name).includes('scripts')) return 'SELECT fixture_migration';
      throw new Error('Unexpected filesystem read');
    },
    writeFileSync: (name: string, data: string) => { fx.writes.push({ path: name, data }); },
  };
});
vi.mock('node:child_process', () => ({ execFileSync: (...args: unknown[]) => fx.docker(...args) }));
vi.mock('../helpers/fixture-slots', () => ({ acquireFixtureSlot: async () => ({ release: fx.release }) }));
vi.mock('pg', () => ({
  Client: class {
    constructor(options: Record<string, unknown>) { fx.controls.push(options); }
    on(_event: string, handler: () => void) { fx.handlers.push(handler); }
    async connect() { fx.events.push('connect'); if (fx.connectError) throw new Error(fx.connectError); }
    async query(sql: string) {
      fx.events.push(sql);
      if (fx.queryError) throw new Error(fx.queryError);
      return { rows: [sql.includes('current_database()') ? fx.marker : fx.fresh] };
    }
    async end() { fx.events.push('control-end'); await fx.controlEnd(); }
  },
  Pool: class {
    constructor(options: Record<string, unknown>) { fx.pools.push(options); }
    async query(sql: string) {
      fx.events.push(sql); if (fx.poolError) throw new Error(fx.poolError); return { rows: [] };
    }
    async end() { fx.events.push('pool-end'); await fx.poolEnd(); }
  },
}));
import { claimOwnedPostgres } from '../helpers/owned-postgres-transport';
import { DisposablePostgres } from '../helpers/disposable-postgres';

const SPEC = 'tests/unit/location-device-actions-postgres.spec.ts';
const expected = { purpose: 'location-l8-actions', database: 'oshal_fixture', requestedImage: 'postgres:16-alpine' };
const contract = () => ({ protocol: 'owned-postgres-v1', runId: 'l8-pg-' + 'a'.repeat(16),
  containerId: 'b'.repeat(64), network: 'l8-pg-' + 'a'.repeat(16) + '-internal', ...expected,
  spec: SPEC, imageId: 'sha256:' + 'c'.repeat(64), host: 'fixture-pg', port: 5432, user: 'postgres',
  password: 'd'.repeat(48), nonce: 'e'.repeat(48), expiresAt: fx.clock + 60_000 });
const set = (patch: Record<string, unknown>) => { fx.raw = JSON.stringify({ ...contract(), ...patch }); };
const fixture = () => new DisposablePostgres({ purpose: expected.purpose, roles: ['oshal_app'], migrations: ['synthetic.sql'] });

beforeEach(() => {
  vi.clearAllMocks(); vi.spyOn(Date, 'now').mockImplementation(() => fx.clock);
  fx.os = 'linux'; fx.clock = 1_000_000; fx.size = 0; fx.mode = 0o100600; fx.symlink = '';
  fx.malformedFile = false; fx.claimed = false; fx.connectError = ''; fx.queryError = ''; fx.poolError = '';
  fx.controls.length = 0; fx.pools.length = 0; fx.events.length = 0; fx.writes.length = 0; fx.handlers.length = 0;
  fx.controlEnd.mockResolvedValue(undefined); fx.poolEnd.mockResolvedValue(undefined);
  fx.mount = '51 20 0:1 / /contract ro,relatime - tmpfs tmpfs rw\n';
  set({});
  fx.marker = { database: 'oshal_fixture', username: 'postgres', version: '160004',
    run_id: contract().runId, nonce: contract().nonce };
  fx.fresh = { claimed: true, empty_public: true, empty_schemas: true, fresh_roles: true };
  vi.stubEnv('OSHAL_OWNED_PG_CONTRACT', '/contract/access.json'); vi.stubEnv('OSHAL_OWNED_PG_SPEC', SPEC);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('owned endpoint admission — I/O doubles, no real PG/mount proof', () => {
  it('absent opt-in keeps the existing local Docker fixture behavior', async () => {
    vi.stubEnv('OSHAL_OWNED_PG_CONTRACT', undefined);
    expect(await claimOwnedPostgres(expected)).toBeNull();
    fx.docker.mockImplementation((_file, args: string[]) => args[0] === 'port' ? '127.0.0.1:54321' : 'owned-container');
    const db = new DisposablePostgres({ purpose: 'default-path' });
    await db.start(); await db.stop();
    expect(fx.docker.mock.calls.map(c => c[1][0])).toEqual(['run', 'port', 'rm']);
    expect(fx.controls).toEqual([]);
  });
  it('the real first query verifies exact startup marker before any role/migration', async () => {
    const db = fixture(); await db.start();
    expect(fx.events[1]).toContain("current_setting('oshal.fixture_run_id', true)");
    expect(fx.events[1]).toContain("current_setting('oshal.fixture_nonce', true)");
    expect(fx.events[1]).toContain('current_database()');
    expect(fx.events[1]).toContain('current_user');
    const marker = fx.events.findIndex(s => s.includes('current_database()'));
    const freshness = fx.events.findIndex(s => s.includes('pg_try_advisory_lock'));
    const role = fx.events.findIndex(s => s.includes('CREATE ROLE'));
    const migration = fx.events.indexOf('SELECT fixture_migration');
    expect(marker).toBeLessThan(freshness); expect(freshness).toBeLessThan(role); expect(role).toBeLessThan(migration);
    expect(fx.events[role]).toContain('NOSUPERUSER NOBYPASSRLS');
    expect(fx.pools[0]).toMatchObject({ host: 'fixture-pg', port: 5432, password: contract().password });
    await db.stop(); await db.stop();
    expect(fx.docker).not.toHaveBeenCalled(); expect(fx.release).toHaveBeenCalledOnce();
    expect(fx.events.join('\n')).not.toMatch(/DROP|DELETE|TRUNCATE/);
    expect(JSON.parse(fx.writes.at(-1)!.data)).toMatchObject({ claims: 1, released: true, verifiedFresh: true });
    expect(JSON.stringify(fx.writes)).not.toContain(contract().password);
    expect(JSON.stringify(fx.writes)).not.toContain(contract().nonce);
  });
  it.each([
    ['protocol', 'other'], ['host', '127.0.0.1'], ['port', 5433], ['user', 'operator'],
    ['database', 'live'], ['purpose', 'other'], ['requestedImage', 'other'],
    ['spec', 'tests/unit/other.spec.ts'], ['runId', 'foreign'], ['network', 'existing'],
    ['containerId', 'short'], ['imageId', 'postgres:latest'], ['password', 'weak'], ['nonce', 'weak'],
    ['expiresAt', 0], ['expiresAt', 1_700_001], ['expiresAt', '1060000'], ['unknownField', true],
  ])('refuses invalid %s before opening any client', async (key, value) => {
    set({ [key]: value }); await expect(fixture().start()).rejects.toThrow('setup refused');
    expect(fx.controls).toEqual([]); expect(fx.pools).toEqual([]); expect(fx.docker).not.toHaveBeenCalled();
    expect(fx.release).toHaveBeenCalledOnce();
  });
  it.each(['DATABASE_URL','PGHOST','PGPASSWORD','PGOPTIONS','BOOTSTRAP_DATABASE_URL','OSHAL_TEST_APP_DSN'])('refuses inherited %s', async key => {
    vi.stubEnv(key, 'synthetic-private-sentinel');
    await expect(claimOwnedPostgres(expected)).rejects.toThrow('verification_failed');
    expect(fx.controls).toEqual([]);
  });
  it.each(['win32','darwin'])('refuses unsupported platform %s', async os => {
    fx.os = os; await expect(claimOwnedPostgres(expected)).rejects.toThrow(); expect(fx.controls).toEqual([]);
  });
  it.each(['/tmp/contract.json','', '/contract/../access.json'])('refuses arbitrary contract path %s', async name => {
    vi.stubEnv('OSHAL_OWNED_PG_CONTRACT', name);
    await expect(fixture().start()).rejects.toThrow(); expect(fx.docker).not.toHaveBeenCalled();
  });
  it.each(['/contract','/contract/access.json'])('refuses symlink %s', async name => {
    fx.symlink = name; await expect(claimOwnedPostgres(expected)).rejects.toThrow(); expect(fx.controls).toEqual([]);
  });
  it.each(['', '51 20 0:1 / /contract rw - tmpfs tmpfs rw',
    '51 20 0:1 / /contract ro - tmpfs tmpfs rw\n52 20 0:2 / /contract/access.json rw - tmpfs tmpfs rw'])('refuses absent/writable overriding mount', async mount => {
    fx.mount = mount; await expect(claimOwnedPostgres(expected)).rejects.toThrow(); expect(fx.controls).toEqual([]);
  });
  it.each(['oversized','world-readable','not-file','malformed','array','null'])('refuses %s raw contract without exposing secrets', async mode => {
    if (mode === 'oversized') fx.size = 8193;
    if (mode === 'world-readable') fx.mode = 0o100644;
    if (mode === 'not-file') fx.malformedFile = true;
    if (mode === 'malformed') fx.raw = '{' + contract().password + contract().nonce;
    if (mode === 'array') fx.raw = '[]';
    if (mode === 'null') fx.raw = 'null';
    const failure = await claimOwnedPostgres(expected).catch(error => error as Error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(contract().password); expect(String(failure)).not.toContain(contract().nonce);
    expect(fx.controls).toEqual([]);
  });
});

describe('actual helper control flow with doubled pg client, never RLS evidence', () => {
  it.each(['database','username','run_id','nonce','version'])('wrong first-read %s yields zero initializer SQL and no fallback', async field => {
    fx.marker[field] = 'wrong';
    await expect(fixture().start()).rejects.toThrow('setup refused');
    expect(fx.events.filter(s => s.startsWith('SELECT'))).toHaveLength(1);
    expect(fx.pools).toEqual([]); expect(fx.docker).not.toHaveBeenCalled(); expect(fx.controlEnd).toHaveBeenCalledOnce();
  });
  it.each(['claimed','empty_public','empty_schemas','fresh_roles'])('refuses false %s freshness/claim', async field => {
    fx.fresh[field] = false; await expect(fixture().start()).rejects.toThrow();
    expect(fx.pools).toEqual([]); expect(fx.writes).toEqual([]); expect(fx.docker).not.toHaveBeenCalled();
  });
  it.each(['connect','query','initializer'])('redacts raw contract credentials in %s failure', async phase => {
    const raw = fx.raw;
    if (phase === 'connect') fx.connectError = raw;
    if (phase === 'query') fx.queryError = raw;
    if (phase === 'initializer') fx.poolError = raw;
    const error = await fixture().start().catch(e => e as Error);
    expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain(contract().password);
    expect(String(error)).not.toContain(contract().nonce); expect(fx.docker).not.toHaveBeenCalled();
    expect(fx.release).toHaveBeenCalledOnce();
  });
  it('refuses a second claim even after release', async () => {
    const one = await claimOwnedPostgres(expected); await one!.release();
    await expect(claimOwnedPostgres(expected)).rejects.toThrow(); expect(fx.controlEnd).toHaveBeenCalledTimes(2);
  });
  it('rechecks expiry and client liveness before handing authority to initializer', async () => {
    const live = await claimOwnedPostgres(expected);
    fx.clock += 60_001; expect(() => live!.assertActive()).toThrow('expired');
    await live!.release();
    expect(() => live!.assertActive()).toThrow('released');
  });
  it('a lost control connection invalidates the lease', async () => {
    const live = await claimOwnedPostgres(expected); fx.handlers[0]();
    expect(() => live!.assertActive()).toThrow('lost'); await live!.release();
  });
});
