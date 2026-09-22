/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for the failure shape "a manifest pins a bot id owned by a different app, and the integrity check does not notice". Two live packages carried exactly that — `brand-graphics` declaring a bot named brand-graphics under drone-operator's b00f0000-...-0001, and `trading` declaring trading-analyst under identity-advisor's a0000000-...-0045 — and scripts/swarm-app-bot-integrity-check.sh reported neither, because it read only agent_ids[1] of apps WHERE status='active' and both apps are inactive. The other half of the shape is the false positive that made the old output unreadable: `agents.metadata.manifestApp <> sa.name` is not a defect signal, because agent_ids is an ASSOCIATION column and is many-to-many by design (13 live associations are deliberate shares). This spec asserts both directions — red on a wrong pin, silent on a deliberate share — and asserts the exit contract stays "1 only for BROKEN". It runs the REAL script against a PostgreSQL it starts itself, carrying the REAL migrations (022's UUID[] agent_ids and JSONB manifest, 001's stamped agents), because the whole subject is SQL the script issues over that schema: a doubled query would assert the fixture, not the guard. Nothing here can reach a deployment — the fixture invents its own address and the script is pointed at the fixture's container by name.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DisposablePostgres } from '../helpers/disposable-postgres';

/**
 * A PostgreSQL this file owns. The script talks to a container by NAME (`docker exec`), which is
 * how it reaches the live database in production — so pointing it at this fixture's container
 * exercises the real psql/SQL path rather than a stand-in, and there is no DSN anywhere for it to
 * fall back onto the operator's stack.
 */
const database = new DisposablePostgres({
  purpose: 'swarm-app-bot-integrity',
  database: 'app_bot_integrity_fixture',
  max: 2,
  connectionTimeoutMillis: 5_000,
  statementTimeoutMs: 30_000,
  // The real schema: 022 owns agent_ids UUID[] + manifest JSONB, 001 owns the agents table whose
  // metadata carries the loader's one-owner-per-agent `manifestApp` stamp the check arbitrates on.
  migrations: ['022-swarm-applications.sql', '001-multi-agent-foundation.sql'],
});

const SCRIPT = resolve(__dirname, '../../scripts/swarm-app-bot-integrity-check.sh');

/** `owner-app`'s own bot. Also the id a mispinned manifest points at under the wrong name. */
const OWNER_BOT = 'c0de0000-0000-0000-0000-0000000000a1';
/** `share-owner-app`'s bot, deliberately associated by two other apps. */
const SHARED_BOT = 'c0de0000-0000-0000-0000-0000000000a2';
/** Registered but INACTIVE: an active app associating it has dead routing. */
const DEAD_BOT = 'c0de0000-0000-0000-0000-0000000000a3';
/** Active, and deliberately at agent_ids[1] so the dead one sits at [2]. */
const HEALTHY_BOT = 'c0de0000-0000-0000-0000-0000000000a4';

let pool: Pool;

/** Stamp an agent exactly as the loader's `upsertManifestBot` does: one scalar `manifestApp`. */
async function seedAgent(agentId: string, name: string, stamp: string, status: string): Promise<void> {
  await pool.query(
    `INSERT INTO agents (agent_id, name, api_provider_id, status, metadata)
     VALUES ($1::uuid, $2, 'noop', $3, $4::jsonb)
     ON CONFLICT (agent_id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status`,
    [agentId, name, status, JSON.stringify({ role: '', manifestApp: stamp })],
  );
}

/**
 * An application row in the shape `swarm-app-repository.upsert` really writes: the association
 * array AND the manifest it was loaded from, because the wrong-pin signal lives in the manifest.
 */
async function seedApp(
  name: string,
  status: string,
  agentIds: readonly string[],
  declaredBots: ReadonlyArray<{ name: string; agentId: string }>,
): Promise<void> {
  await pool.query(
    `INSERT INTO swarm_applications (name, display_name, status, manifest_path, agent_ids, manifest)
     VALUES ($1, $1, $2, $3, $4::uuid[], $5::jsonb)
     ON CONFLICT (name) DO UPDATE SET status = EXCLUDED.status,
       agent_ids = EXCLUDED.agent_ids, manifest = EXCLUDED.manifest`,
    [name, status, `deployed-apps/${name}/oshal-app.yaml`, agentIds,
      JSON.stringify(declaredBots.length ? { bots: declaredBots } : {})],
  );
}

interface CheckRun { stdout: string; status: number }

/** Run the REAL script against the fixture container, capturing output and exit status. */
function runCheck(): CheckRun {
  const connection = database.connection;
  try {
    const stdout = execFileSync('bash', [SCRIPT], {
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        DB_CONTAINER: database.containerName,
        PGUSER: connection.user,
        PGDATABASE: connection.database,
        MSYS_NO_PATHCONV: '1',
        SHOW_SHARES: '1',
      },
    });
    return { stdout, status: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; status?: number; message?: string };
    if (typeof failure.status !== 'number') throw error;
    return { stdout: failure.stdout ?? '', status: failure.status };
  }
}

/** The advisory block that names a wrong pin, or '' when the script printed none. */
function mispinnedSection(stdout: string): string {
  const start = stdout.indexOf('MISPINNED');
  if (start < 0) return '';
  const end = stdout.indexOf('SHARED:', start);
  return stdout.slice(start, end < 0 ? undefined : end);
}

describe('swarm-app bot integrity check: a wrong pin is found, a deliberate share is not', () => {
  beforeAll(async () => {
    pool = await database.start();

    await seedAgent(OWNER_BOT, 'owner-bot', 'owner-app', 'active');
    await seedAgent(SHARED_BOT, 'shared-bot', 'share-owner-app', 'active');
    await seedAgent(DEAD_BOT, 'dead-bot', 'broken-app', 'inactive');
    await seedAgent(HEALTHY_BOT, 'healthy-bot', 'broken-app', 'active');

    // Clean: an app that owns the bot it declares.
    await seedApp('owner-app', 'active', [OWNER_BOT], [{ name: 'owner-bot', agentId: OWNER_BOT }]);
    await seedApp('share-owner-app', 'active', [SHARED_BOT], [{ name: 'shared-bot', agentId: SHARED_BOT }]);

    // Deliberate share, shape 1 — `workflow.workerBot` resolved BY NAME by the loader, which is
    // why there is no `bots:` block here. This is what a published Workflow Studio workflow and
    // every carved rider app look like, and it must never be reported as a defect.
    await seedApp('borrower-app', 'active', [SHARED_BOT], []);

    // Deliberate share, shape 2 — the app DOES declare the bot, under its real name. Proves the
    // discriminator is the name matching the live agent, not the absence of a declaration.
    await seedApp('declaring-sharer-app', 'active', [SHARED_BOT], [{ name: 'shared-bot', agentId: SHARED_BOT }]);

    // THE DEFECT. Inactive, so the old active-only check could not see it, and the declared name
    // does not match the agent that id really is. Exactly brand-graphics and trading.
    await seedApp('mispinned-app', 'inactive', [OWNER_BOT], [{ name: 'mispinned-bot', agentId: OWNER_BOT }]);
  }, 180_000);

  // The whole server is destroyed, so no cleanup SQL runs anywhere.
  afterAll(async () => { await database.stop(); });

  it('reports the wrong pin on an INACTIVE app, naming the bot the manifest asked for and the one it got', () => {
    const { stdout } = runCheck();
    const section = mispinnedSection(stdout);
    expect(section).toContain('mispinned-app');
    expect(section).toContain('mispinned-bot');
    expect(section).toContain('owner-bot');
    expect(section).toContain(OWNER_BOT);
  });

  it('stays quiet about a deliberate share, in both shapes', () => {
    const { stdout } = runCheck();
    const section = mispinnedSection(stdout);
    expect(section).not.toContain('borrower-app');
    expect(section).not.toContain('declaring-sharer-app');
    expect(section).not.toContain('shared-bot');
  });

  it('counts the deliberate shares apart from the wrong pin, so the two categories are disjoint', () => {
    const { stdout } = runCheck();
    expect(stdout).toContain('SHARED: 2 association(s)');
    expect(stdout).toContain('borrower-app');
    expect(stdout).toContain('declaring-sharer-app');
  });

  it('does not fail the run for a wrong pin alone — the exit contract is BROKEN only', () => {
    const { status, stdout } = runCheck();
    expect(status).toBe(0);
    expect(stdout).toContain('RESULT: PASS');
  });

  it('fails the run for an ACTIVE app whose bot at agent_ids[2] is inactive', async () => {
    // Position 2 on purpose: reading agent_ids[1] finds only the healthy bot and passes.
    await seedApp('broken-app', 'active', [HEALTHY_BOT, DEAD_BOT], [
      { name: 'healthy-bot', agentId: HEALTHY_BOT },
      { name: 'dead-bot', agentId: DEAD_BOT },
    ]);

    const { status, stdout } = runCheck();
    expect(status).toBe(1);
    expect(stdout).toContain('RESULT: FAIL');
    expect(stdout).toContain('broken-app');
    expect(stdout).toContain('agent_ids[2]');
    expect(stdout).toContain('dead-bot');

    // The wrong pin is still reported alongside the outage, not swallowed by it.
    expect(mispinnedSection(stdout)).toContain('mispinned-app');

    await pool.query('DELETE FROM swarm_applications WHERE name = $1', ['broken-app']);
  }, 180_000);
});
