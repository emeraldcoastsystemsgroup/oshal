/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for the silent Jarvis outage of 2026-09-11..14: `swarm_applications.agent_ids` is UUID[] (migration 022) but the ownership reader binds the executable name as text, so `$1=ANY(agent_ids)` raised `operator does not exist: text = uuid` for every kind:'bots' read. readApplicationExecutionOwnership converted that to ApplicationOwnershipUnavailableError, canReadProtectedResult swallowed it to `false`, and POST /api/jarvis/ask answered 404 session_not_found with nothing logged. This crosses the real boundary that failed: the real reader against a real PostgreSQL carrying the real UUID[] column, never a doubled query.
 */

import type { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readApplicationExecutionOwnership, ApplicationOwnershipUnavailableError } from '@/app/application-execution-ownership';
import { DisposableAlertPostgres } from '../helpers/disposable-alert-postgres';

const database = new DisposableAlertPostgres();
/** The kernel Jarvis bot: the agent id whose ownership read gates every Jarvis conversation. */
const JARVIS_AGENT_ID = 'a0000000-0000-0000-0000-000000000050';
const PROTECTED_AGENT_ID = 'a0000000-0000-0000-0000-0000000009f1';
const TOOL_NAME = 'ownership-spec-tool';

let pool: Pool;

/** Real schema only: migration 022 owns the UUID[] column, the authorization store owns the TEXT[] one. */
async function applyRealSchema(target: Pool): Promise<void> {
  await target.query(readFileSync(resolve(__dirname, '../../scripts/migrations/022-swarm-applications.sql'), 'utf8'));
  await target.query(`CREATE TABLE IF NOT EXISTS oshal_authorization_applications (app_name TEXT PRIMARY KEY,
    protected BOOLEAN NOT NULL, agent_ids TEXT[] NOT NULL DEFAULT '{}', tool_names TEXT[] NOT NULL DEFAULT '{}')`);
}

/** One unprotected kernel app and one protected package, shaped exactly as the loader writes them. */
async function seedApplications(target: Pool): Promise<void> {
  await target.query(`INSERT INTO swarm_applications (name, display_name, manifest_path, agent_ids, tool_names, manifest)
    VALUES ('jarvis','Jarvis','swarm-apps/jarvis.yaml',$1::uuid[],$2::text[],'{}'::jsonb)
    ON CONFLICT (name) DO NOTHING`, [[JARVIS_AGENT_ID], [TOOL_NAME]]);
  await target.query(`INSERT INTO swarm_applications (name, display_name, manifest_path, agent_ids, tool_names, manifest)
    VALUES ('guarded-pkg','Guarded','deployed-apps/guarded-pkg/oshal-app.yaml',$1::uuid[],'{}'::text[],'{}'::jsonb)
    ON CONFLICT (name) DO NOTHING`, [[PROTECTED_AGENT_ID]]);
}

beforeAll(async () => {
  pool = await database.start();
  await applyRealSchema(pool);
  await seedApplications(pool);
}, 240_000);

afterAll(async () => { await database.stop(); });

describe('readApplicationExecutionOwnership against the real UUID[] ownership column', () => {
  it('resolves a kernel bot instead of throwing, so canReadProtectedResult can allow the conversation', async () => {
    const ownership = await readApplicationExecutionOwnership(pool, { kind: 'bots', id: JARVIS_AGENT_ID, mode: 'enforce' });
    expect(ownership).toEqual({ app: 'jarvis', protected: false });
  });

  it('still reports a packaged bot as protected — the guard is intact, not relaxed', async () => {
    const ownership = await readApplicationExecutionOwnership(pool, { kind: 'bots', id: PROTECTED_AGENT_ID, mode: 'enforce' });
    expect(ownership).toEqual({ app: 'guarded-pkg', protected: true });
  });

  it('reports no owner for an unknown bot rather than failing closed on a SQL error', async () => {
    const ownership = await readApplicationExecutionOwnership(pool, { kind: 'bots', id: '00000000-0000-0000-0000-0000000000ff', mode: 'enforce' });
    expect(ownership).toBeUndefined();
  });

  it('resolves a tool name through the TEXT[] column unchanged', async () => {
    const ownership = await readApplicationExecutionOwnership(pool, { kind: 'tools', id: TOOL_NAME, mode: 'enforce' });
    expect(ownership).toEqual({ app: 'jarvis', protected: false });
  });

  it('still refuses an unusable pool with the unavailable error', async () => {
    await expect(readApplicationExecutionOwnership(null, { kind: 'bots', id: JARVIS_AGENT_ID, mode: 'enforce' }))
      .rejects.toBeInstanceOf(ApplicationOwnershipUnavailableError);
  });
});
