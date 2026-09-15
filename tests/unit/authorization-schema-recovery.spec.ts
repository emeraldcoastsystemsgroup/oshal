/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove the authorization schema bootstrap recovers from a real lost pool acquire, and that it asks the pool for one client at a time.
 */
/**
 * Disposable local PostgreSQL only. Never consumes DATABASE_URL, oshal-local-db, or any
 * deployment credential.
 *
 * The defect these cases exist for: the wiring built ONE eagerly created readiness promise and
 * handed it by value to every authorization consumer. Four schema bootstraps ran concurrently
 * inside it, each holding a pool client for a locked DDL transaction, while the controller loaded
 * its manifests against a pool of 8. Losing that acquire rejected the promise once, and every
 * authorization operation then awaited the SAME rejection for the life of the process while the
 * api still reported healthy.
 *
 * Both cases therefore cross the boundary that actually failed: a real pg Pool with a real
 * acquire timeout against real PostgreSQL running the real DDL. Nothing about the pool, the
 * timeout, or the schema is doubled. Only the tool catalog and the application registry - the
 * collaborators on the far side of that boundary - are stubbed.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolConfig } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplicationAuthorizationWiring } from '../../src/app/composition/application-authorization-wiring';
import { wrapPoolWithGuc } from '../../src/shared/services/database/guc-pool';
import type { AppContext } from '../../src/app/composition/app-context';
import type { AppAccessService, SwarmAppService } from '../../src/features/swarm-apps';

const container = `oshal-authz-boot-${randomUUID().slice(0, 8)}`;
const password = randomUUID();
/** An issuer that is deliberately not the local-auth issuer, so targetActor takes the directory read. */
const ISSUER = 'https://fixture.invalid/';
const SUBJECT = 'fixture-nobody';
let started = false; let port = 0; let admin: Pool;
const owners = new Map<string, Pool>();

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }).trim();
}
function connection(database: string): PoolConfig {
  return { host: '127.0.0.1', port, user: 'postgres', password, database };
}
/** The one prerequisite these schemas have that they do not create: external memberships reference it. */
async function prepare(database: string): Promise<Pool> {
  await admin.query(`CREATE DATABASE ${database}`);
  const owner = new Pool({ ...connection(database), max: 2, connectionTimeoutMillis: 5_000 });
  await owner.query('CREATE TABLE oshal_tenants (tenant_id UUID PRIMARY KEY, name TEXT)');
  owners.set(database, owner);
  return owner;
}
async function tableExists(owner: Pool, table: string): Promise<boolean> {
  const result = await owner.query<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [`public.${table}`]);
  return result.rows[0]?.present === true;
}
/** Only the tool catalog and application registry are stubbed; the pool below is real. */
function context(pool: Pool): AppContext {
  return {
    pool,
    toolRegistryService: { seedAuthorizationTool: async () => undefined },
    dynamicToolExecutorRegistry: { registerAuthorizationDescriptors: () => undefined, listAll: () => [] },
  } as unknown as AppContext;
}
const appAccess = { resolve: async () => ({ tier: 'deny', source: 'default' }) } as unknown as AppAccessService;
const apps = { getApp: () => undefined } as unknown as SwarmAppService;

beforeAll(async () => {
  docker(['run', '--detach', '--rm', '--name', container, '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data',
    '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=authz_boot_fixture', 'postgres:16-alpine']);
  started = true;
  port = Number(docker(['port', container, '5432/tcp']).split(':').pop());
  admin = new Pool({ ...connection('authz_boot_fixture'), max: 2, connectionTimeoutMillis: 1_000 });
  let live = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    try { await admin.query('SELECT 1'); live = true; break; } catch { await new Promise(wait => setTimeout(wait, 200)); }
  }
  if (!live) throw new Error('Disposable authorization boot PostgreSQL did not become ready');
  await prepare('recovery_fixture');
  await prepare('serialization_fixture');
}, 120_000);

afterAll(async () => {
  for (const owner of owners.values()) await owner.end().catch(() => undefined);
  if (admin) await admin.end().catch(() => undefined);
  if (started) docker(['rm', '--force', container]);
});

describe('authorization schema readiness after a lost pool acquire', () => {
  it('retries the bootstrap for the next caller instead of serving one boot rejection forever', async () => {
    const owner = owners.get('recovery_fixture')!;
    // One client and a short acquire timeout: the production shape, scaled down. The bootstrap
    // cannot get a client while this test holds the only one, so it fails the way it fails on a
    // busy box rather than through an injected error.
    const pool = new Pool({ ...connection('recovery_fixture'), max: 1, connectionTimeoutMillis: 500 });
    const held = await pool.connect();
    let releasedHeldClient = false;
    const release = () => { if (!releasedHeldClient) { releasedHeldClient = true; held.release(); } };
    try {
      const wiring = createApplicationAuthorizationWiring(context(wrapPoolWithGuc(pool)), appAccess, () => apps, Promise.resolve());
      // The boot attempt loses the acquire, and the first authorization operation refuses with it.
      await expect(wiring.targetActor(SUBJECT, ISSUER)).rejects.toThrow(/timeout exceeded when trying to connect/i);
      expect(await tableExists(owner, 'oshal_verified_principals')).toBe(false);

      release();
      // The next authorization operation must run the bootstrap again rather than inherit that
      // rejection. Resolving to null is only reachable through a directory read against a table
      // this call had to create: a cached rejection rejects, and a skipped bootstrap raises 42P01.
      await expect(wiring.targetActor(SUBJECT, ISSUER)).resolves.toBeNull();
      expect(await tableExists(owner, 'oshal_verified_principals')).toBe(true);
      expect(await tableExists(owner, 'oshal_external_tenant_memberships')).toBe(true);
      expect(await tableExists(owner, 'oshal_application_remote_executions')).toBe(true);
      expect(await tableExists(owner, 'oshal_roster_state')).toBe(true);
    } finally {
      release();
      await pool.end();
    }
  }, 120_000);

  it('holds one pool client at a time while bringing the authorization schemas up', async () => {
    const owner = owners.get('serialization_fixture')!;
    // Four clients are available, so concurrency is possible and the measurement is meaningful.
    const pool = new Pool({ ...connection('serialization_fixture'), max: 4, connectionTimeoutMillis: 5_000 });
    let checkedOut = 0; let peak = 0;
    // pg's own checkout accounting, not a wrapper standing in front of connect().
    pool.on('acquire', () => { checkedOut += 1; peak = Math.max(peak, checkedOut); });
    pool.on('release', () => { checkedOut -= 1; });
    try {
      const wiring = createApplicationAuthorizationWiring(context(wrapPoolWithGuc(pool)), appAccess, () => apps, Promise.resolve());
      await expect(wiring.targetActor(SUBJECT, ISSUER)).resolves.toBeNull();
      expect(await tableExists(owner, 'oshal_verified_principals')).toBe(true);
      // Four concurrent locked DDL transactions were four simultaneous clients out of the same
      // pool the rest of boot competes for. Sequenced, the bootstrap works one client at a time.
      // The bound is two, not one, and that second client is not concurrency: gucConnect()
      // overrides release() to run a RESET on the still-checked-out client and hand it back when
      // that query returns, so a client the previous bootstrap has finished with is still out of
      // the pool while the next one checks its own client in. Concurrent bootstraps put four
      // working clients out at once and measure four here.
      expect(peak).toBeLessThanOrEqual(2);
    } finally {
      await pool.end();
    }
  }, 120_000);
});
