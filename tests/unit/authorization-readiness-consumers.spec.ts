/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove the readiness the authorization wiring HANDS OUT recovers from a real lost pool acquire, and that an authenticated ticket creation survives the attempt that loses it.
 */
/**
 * Disposable local PostgreSQL only. Never consumes DATABASE_URL, oshal-local-db, or any
 * deployment credential.
 *
 * The defect these cases exist for is the one createSchemaReady fixed, reproduced one level out.
 * The bootstrap thunk is re-requestable, but the readiness the wiring RETURNS was derived from it
 * once with .then(), so it kept the first attempt rejection forever. Four modules chain off that
 * value, and the consequential one is queued-principal capture: TicketService.createTicket calls
 * it unconditionally AFTER the ticket row is already inserted, so a single lost acquire at boot
 * made every authenticated ticket creation throw for the life of the process - with the row
 * committed, the caller told it failed, and the api still reporting healthy.
 *
 * Both cases cross the boundary that actually fails: a real pg Pool with a real acquire timeout
 * against real PostgreSQL running the real DDL, driving the real wiring. Nothing about the pool,
 * the timeout, the schema or the capture path is doubled. The tool catalog, the application
 * registry and the ticket row store are the collaborators on the far side of that boundary and
 * are the only stubs - the ticket store is never what fails here, and substituting it is what
 * lets the case assert on the capture rather than on ticket persistence.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolConfig } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplicationAuthorizationWiring } from '../../src/app/composition/application-authorization-wiring';
import { createQueuedApplicationPrincipalWiring } from '../../src/app/composition/queued-application-principal-wiring';
import { configureQueuedApplicationPrincipals } from '../../src/shared/queued-application-principal';
import { runWithApplicationAuthorizationActor } from '../../src/shared/application-authorization-context';
import { runWithRequestIdentity } from '../../src/shared/services/database/request-identity';
import { TicketService } from '../../src/features/ticketing';
import { wrapPoolWithGuc } from '../../src/shared/services/database/guc-pool';
import type { AppContext } from '../../src/app/composition/app-context';
import type { AppAccessService, SwarmAppService } from '../../src/features/swarm-apps';

const container = `oshal-authz-consumers-${randomUUID().slice(0, 8)}`;
const password = randomUUID();
/** Deliberately not the local-auth issuer, so no case depends on a session lookup. */
const ISSUER = 'https://fixture.invalid/';
const SUBJECT = 'fixture-initiator';
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
/**
 * Ask the readiness the wiring hands out for an answer NOW.
 *
 * These cases assert on behaviour - asking again after a failure gets a fresh attempt - not on
 * the shape of the value, so this deliberately accepts either shape. That is what lets the same
 * spec run unchanged against the commit before the fix, where the value is a promise derived once
 * and a second ask returns the same cached rejection, and against the fix, where it is a thunk.
 */
function ask(ready: unknown): Promise<unknown> {
  return typeof ready === 'function' ? (ready as () => Promise<unknown>)() : (ready as Promise<unknown>);
}
/** Only the tool catalog and application registry are stubbed; the pool below is real. */
function context(pool: Pool, seeded: string[] = [], descriptors: { count: number } = { count: 0 }): AppContext {
  return {
    pool,
    toolRegistryService: { seedAuthorizationTool: async (tool: { name?: string }) => { seeded.push(tool?.name ?? 'unnamed'); } },
    dynamicToolExecutorRegistry: { registerAuthorizationDescriptors: () => { descriptors.count += 1; }, listAll: () => [] },
  } as unknown as AppContext;
}
const appAccess = { resolve: async () => ({ tier: 'deny', source: 'default' }) } as unknown as AppAccessService;
const apps = { getApp: () => undefined } as unknown as SwarmAppService;

beforeAll(async () => {
  docker(['run', '--detach', '--rm', '--name', container, '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data',
    '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=authz_consumer_fixture', 'postgres:16-alpine']);
  started = true;
  port = Number(docker(['port', container, '5432/tcp']).split(':').pop());
  admin = new Pool({ ...connection('authz_consumer_fixture'), max: 2, connectionTimeoutMillis: 1_000 });
  let live = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    try { await admin.query('SELECT 1'); live = true; break; } catch { await new Promise(wait => setTimeout(wait, 200)); }
  }
  if (!live) throw new Error('Disposable authorization consumer PostgreSQL did not become ready');
  await prepare('ticket_capture_fixture');
  await prepare('returned_ready_fixture');
}, 180_000);

afterAll(async () => {
  configureQueuedApplicationPrincipals(undefined);
  for (const owner of owners.values()) await owner.end().catch(() => undefined);
  if (admin) await admin.end().catch(() => undefined);
  if (started) docker(['rm', '--force', container]);
});

describe('consumers of the readiness the authorization wiring hands out', () => {
  it('creates an authenticated ticket through the bootstrap attempt that loses the acquire, and captures the initiator on the next one', async () => {
    const owner = owners.get('ticket_capture_fixture')!;
    // One client and a short acquire timeout: the production shape, scaled down. While this test
    // holds the only client the bootstrap cannot get one, so it fails the way it fails on a busy
    // box - a lost acquire - rather than through an injected error.
    const pool = new Pool({ ...connection('ticket_capture_fixture'), max: 1, connectionTimeoutMillis: 500 });
    const held = await pool.connect();
    let releasedHeldClient = false;
    const release = () => { if (!releasedHeldClient) { releasedHeldClient = true; held.release(); } };
    try {
      const ctx = context(wrapPoolWithGuc(pool));
      const wiring = createApplicationAuthorizationWiring(ctx, appAccess, () => apps, Promise.resolve());
      // The composition the controller performs at server.ts:1059 - it installs the real Postgres
      // capture store against the readiness above.
      createQueuedApplicationPrincipalWiring(ctx, wiring.ready as never);

      const rows: Array<Record<string, unknown>> = [];
      const ticketStore = { create: async (input: Record<string, unknown>) => {
        const row = { ...input, ticketId: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        rows.push(row);
        return row;
      } };
      const tickets = new TicketService(ticketStore as never);
      const actor = { sub: SUBJECT, issuer: ISSUER, isActive: true, isSwarmAdmin: false };
      const create = (title: string) => runWithApplicationAuthorizationActor(actor, () =>
        runWithRequestIdentity({ sub: SUBJECT, principalIssuer: ISSUER, isOperator: false }, () =>
          tickets.createTicket({ title, ticketType: 'build', ownerSub: SUBJECT } as never)));

      // The capture runs AFTER the row is inserted. A readiness failure must not hand the caller
      // an error for a ticket the store has already accepted - that is the reported symptom,
      // tickets not getting pushed through, with a committed row sitting behind it.
      const first = await create('created while the bootstrap could not get a client');
      expect(first.ticketId).toBeTruthy();
      expect(rows).toHaveLength(1);
      // Nothing was captured, because the schema does not exist yet. Degrading invents no
      // authority: with no provenance row a later protected dispatch refuses.
      expect(await tableExists(owner, 'oshal_queued_application_principals')).toBe(false);

      release();
      // The next creation must run the bootstrap again rather than inherit the earlier rejection,
      // and must actually record the initiator - a capture that is swallowed but never recovers
      // would leave this table empty forever.
      const second = await create('created once the acquire is available again');
      expect(await tableExists(owner, 'oshal_queued_application_principals')).toBe(true);
      const captured = await owner.query<{ actor: { sub: string; issuer: string } }>(
        'SELECT actor FROM oshal_queued_application_principals WHERE ticket_id=$1', [second.ticketId]);
      expect(captured.rows[0]?.actor?.sub).toBe(SUBJECT);
      expect(captured.rows[0]?.actor?.issuer).toBe(ISSUER);
    } finally {
      release();
      configureQueuedApplicationPrincipals(undefined);
      await pool.end();
    }
  }, 180_000);

  it('registers the authorization tools on a later ask instead of serving the first boot rejection forever', async () => {
    const owner = owners.get('returned_ready_fixture')!;
    const pool = new Pool({ ...connection('returned_ready_fixture'), max: 1, connectionTimeoutMillis: 500 });
    const held = await pool.connect();
    let releasedHeldClient = false;
    const release = () => { if (!releasedHeldClient) { releasedHeldClient = true; held.release(); } };
    try {
      const seeded: string[] = []; const descriptors = { count: 0 };
      const wiring = createApplicationAuthorizationWiring(
        context(wrapPoolWithGuc(pool), seeded, descriptors), appAccess, () => apps, Promise.resolve());
      await expect(ask(wiring.ready)).rejects.toThrow(/timeout exceeded when trying to connect/i);
      expect(seeded).toEqual([]);
      expect(descriptors.count).toBe(0);

      release();
      // A second ask must start a fresh attempt. Before the fix this returned the same rejected
      // promise, so the tools were never registered and every module chaining off this value -
      // the user directory, Jarvis briefings, Test Lab runs - stayed dead while the api reported
      // healthy and the bootstrap underneath had already recovered.
      await ask(wiring.ready);
      expect(seeded).toHaveLength(2);
      expect(descriptors.count).toBe(1);
      expect(await tableExists(owner, 'oshal_verified_principals')).toBe(true);
    } finally {
      release();
      await pool.end();
    }
  }, 180_000);
});
