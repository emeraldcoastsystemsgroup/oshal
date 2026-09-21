/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                   | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | The render-node lease ACQUIRE, executed for real. Every nightly recap since the lease landed on 2026-08-06 died at this call - first behind "returned no JSON" (the host ate the argument's quotes, fixed in #611) and then, on 2026-09-17 and 2026-09-18 with the quotes intact, with 'column reference "resource_key" is ambiguous' from PostgreSQL itself: RETURNS TABLE makes resource_key a PL/pgSQL variable and the plain ON CONFLICT (resource_key) target is resolved through it. Neither existing guard could see that - node-resource-lease.spec.ts doubles the Pool and reads the migration's TEXT, and the Playwright proof needs DATABASE_URL and has never run on a gate. This one drives the real scripts/oshal-node-lease.js, argv for argv as run-daily-recap.ps1 sends it, against a disposable postgres:16-alpine that ran 097, 120 and 150 as shipped, connected as a NOSUPERUSER NOBYPASSRLS role the way the container's app role is - so the plpgsql resolution, the operator stamp under FORCE RLS, contention, expired-only takeover, renewal and exact-token release are measured, not read off a string. Docker is required; a missing engine fails loudly and never skips.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { Pool } from 'pg';
import {
  afterAll, beforeAll, describe, expect, it,
} from 'vitest';
import { DisposablePostgres } from '../helpers/disposable-postgres';

/** The role the CLI connects as: not the fixture superuser, so FORCE RLS is really consulted. */
const ROLE = 'oshal_app_fixture';
const cli = join(__dirname, '..', '..', 'scripts', 'oshal-node-lease.js');
const NODE = 'oshal-chat-fixture-render-node';
/** What vidsNodeResourceKey() derives for that node, spelled as run-daily-recap.ps1 spells it. */
const RESOURCE = `vids-render-node:${NODE}`;
const RECAP_HOLDER = 'daily-recap:2026-09-21:fixture-run';
const PUMP_HOLDER = 'joke-pump:show-fixture';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const fixture = new DisposablePostgres({
  purpose: 'node-lease-acquire',
  migrations: [
    '097-video-pump.sql',
    '120-shared-node-resource-leases.sql',
    '150-node-lease-acquire-unambiguous.sql',
  ],
  roles: [ROLE],
});

let owner: Pool;
let databaseUrl = '';
/** The capability the recap's acquire minted; later cases contend with, expire and retire it. */
let recapLease: { lease_id: string; holder: string } = { lease_id: '', holder: '' };

beforeAll(async () => {
  owner = await fixture.start();
  // The lease functions are not SECURITY DEFINER, so the calling role needs the table itself:
  // this is the grant set the container's app role carries.
  await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON oshal_node_resource_leases TO ${ROLE}`);
  await owner.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${ROLE}`);
  const c = fixture.roleConnection(ROLE);
  databaseUrl = `postgresql://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password)}`
    + `@${c.host}:${c.port}/${c.database}`;
}, 180_000);

afterAll(async () => { await fixture.stop(); }, 60_000);

interface CliRun { status: number | null; record: Record<string, unknown> | null; stderr: string }

/** @description Run the real lease CLI the way the nightly does: argv in, one JSON line out. */
function leaseCli(args: string[]): CliRun {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  const line = String(result.stdout).split('\n').find((candidate) => candidate.trim().startsWith('{'));
  return { status: result.status, record: line ? JSON.parse(line) : null, stderr: String(result.stderr) };
}

/** @description The exact acquire argv Enter-SharedNodeLease builds for one nightly run. */
function acquireArgs(holder: string, metadata: Record<string, string>): string[] {
  return [
    'acquire', '--resource', RESOURCE, '--holder', holder, '--purpose', 'daily-recap-build-publish',
    '--ttl-seconds', '21600', '--metadata-json', JSON.stringify(metadata),
  ];
}

/** @description The exact-token argv the runner's heartbeat and release use. */
function tokenArgs(command: 'renew' | 'release', lease: { lease_id: string; holder: string }): string[] {
  const args = [command, '--resource', RESOURCE, '--holder', lease.holder, '--lease-id', lease.lease_id];
  return command === 'renew' ? [...args, '--ttl-seconds', '21600'] : args;
}

/** @description How many lease rows the superuser (who bypasses RLS) can see. */
async function rowsVisibleToOwner(): Promise<number> {
  const result = await owner.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM oshal_node_resource_leases');
  return Number(result.rows[0].n);
}

describe('the render-node lease acquire, on a real PostgreSQL as the app role', () => {
  it('the fixture enforces: the CLI role is neither superuser nor RLS-bypassing', async () => {
    const who = await fixture.rolePool(ROLE).query<{ u: string; s: boolean; b: boolean }>(
      'SELECT current_user AS u,'
      + ' (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS s,'
      + ' (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS b',
    );
    expect(who.rows[0]).toEqual({ u: ROLE, s: false, b: false });
  });

  it("the nightly's acquire lands on a free node and echoes its metadata back", () => {
    const run = leaseCli(acquireArgs(RECAP_HOLDER, { requestedDate: '2026-09-21', nodeClientId: NODE }));
    expect(run.stderr, run.stderr).not.toMatch(/ambiguous/i);
    expect(run.status, run.stderr).toBe(0);
    expect(run.record).toMatchObject({
      acquired: true,
      resource_key: RESOURCE,
      holder: RECAP_HOLDER,
      purpose: 'daily-recap-build-publish',
      metadata: { requestedDate: '2026-09-21', nodeClientId: NODE },
    });
    expect(String(run.record?.lease_id)).toMatch(UUID);
    recapLease = { lease_id: String(run.record?.lease_id), holder: RECAP_HOLDER };
  });

  it('a held node answers a second claimant with the incumbent, not a second capability', () => {
    const run = leaseCli(acquireArgs(PUMP_HOLDER, { show: 'fixture' }));
    expect(run.status, run.stderr).toBe(3);
    expect(run.record).toMatchObject({ acquired: false, lease_id: recapLease.lease_id, holder: RECAP_HOLDER });
  });

  it('only the operator stamp the CLI sets lets the app role through FORCE RLS', async () => {
    const bare = await fixture.rolePool(ROLE).query('SELECT resource_key FROM oshal_node_resource_leases');
    expect(bare.rows).toEqual([]);
    expect(await rowsVisibleToOwner()).toBe(1);
  });

  it('the exact token renews; a random one does not', () => {
    const renewed = leaseCli(tokenArgs('renew', recapLease));
    expect(renewed.status, renewed.stderr).toBe(0);
    expect(renewed.record).toMatchObject({ renewed: true, lease_id: recapLease.lease_id });

    const stale = leaseCli(tokenArgs('renew', { ...recapLease, lease_id: '00000000-0000-4000-8000-000000000000' }));
    expect(stale.status, stale.stderr).toBe(3);
    expect(stale.record).toMatchObject({ renewed: false });
  });

  it('an expired lease is taken over atomically and the old token can no longer release it', async () => {
    await owner.query(
      `UPDATE oshal_node_resource_leases
          SET acquired_at = NOW() - INTERVAL '3 minutes', heartbeat_at = NOW() - INTERVAL '2 minutes',
              expires_at = NOW() - INTERVAL '1 minute'
        WHERE resource_key = $1 AND lease_id = $2`,
      [RESOURCE, recapLease.lease_id],
    );
    const takeover = leaseCli(acquireArgs(PUMP_HOLDER, { show: 'fixture' }));
    expect(takeover.status, takeover.stderr).toBe(0);
    expect(takeover.record).toMatchObject({ acquired: true, holder: PUMP_HOLDER });
    expect(takeover.record?.lease_id).not.toBe(recapLease.lease_id);
    const pumpLease = { lease_id: String(takeover.record?.lease_id), holder: PUMP_HOLDER };

    const staleRelease = leaseCli(tokenArgs('release', recapLease));
    expect(staleRelease.status, staleRelease.stderr).toBe(3);
    expect(staleRelease.record).toMatchObject({ released: false });
    expect(await rowsVisibleToOwner()).toBe(1);

    const release = leaseCli(tokenArgs('release', pumpLease));
    expect(release.status, release.stderr).toBe(0);
    expect(release.record).toMatchObject({ released: true });
    expect(await rowsVisibleToOwner()).toBe(0);
  });
});
