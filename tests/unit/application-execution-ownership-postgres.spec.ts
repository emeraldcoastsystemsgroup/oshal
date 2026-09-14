/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for the silent Jarvis outage of 2026-09-11..14: `swarm_applications.agent_ids` is UUID[] (migration 022) but the ownership reader binds the executable name as text, so `$1=ANY(agent_ids)` raised `operator does not exist: text = uuid` for every kind:'bots' read. readApplicationExecutionOwnership converted that to ApplicationOwnershipUnavailableError, canReadProtectedResult swallowed it to `false`, and POST /api/jarvis/ask answered 404 session_not_found with nothing logged. This crosses the real boundary that failed: the real reader against a real PostgreSQL carrying the real UUID[] column, never a doubled query.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guard the ambiguous-association arbitration: twelve live agent ids are claimed by more than one application because `agent_ids` is an association column, and the ownership read refused every one of them (docs/operations/agent-id-ownership-collisions.md). The reader now arbitrates with the loader-stamped `agents.metadata.manifestApp`. These cases carry the real `agents` table from migration 001 alongside the real UUID[] column, so the stamp, its absence, a stamp naming no application, an inactive agent and the unarbitrable `tools` path are all exercised against real PostgreSQL rather than a doubled query.
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
/** Claimed by a protected package and by a carve-parity app that binds it as `workflow.workerBot`. */
const SHARED_OWNED_ID = 'cb000000-0000-0000-0000-0000000000c1';
/** A kernel bot a protected package also claims: proves arbitration never lowers protection. */
const SHARED_KERNEL_ID = 'a0000000-0000-0000-0000-0000000000c2';
const SHARED_UNSTAMPED_ID = 'a0000000-0000-0000-0000-0000000000c3';
const SHARED_GHOST_STAMP_ID = 'a0000000-0000-0000-0000-0000000000c4';
const SHARED_INACTIVE_ID = 'a0000000-0000-0000-0000-0000000000c5';
const SHARED_NO_AGENT_ID = 'a0000000-0000-0000-0000-0000000000c6';
const SHARED_TOOL_NAME = 'ownership-spec-shared-tool';

let pool: Pool;

/** Real schema only: migration 022 owns the UUID[] column, migration 001 owns the stamped agents table. */
async function applyRealSchema(target: Pool): Promise<void> {
  await target.query(readFileSync(resolve(__dirname, '../../scripts/migrations/022-swarm-applications.sql'), 'utf8'));
  await target.query(readFileSync(resolve(__dirname, '../../scripts/migrations/001-multi-agent-foundation.sql'), 'utf8'));
  await target.query(`CREATE TABLE IF NOT EXISTS oshal_authorization_applications (app_name TEXT PRIMARY KEY,
    protected BOOLEAN NOT NULL, agent_ids TEXT[] NOT NULL DEFAULT '{}', tool_names TEXT[] NOT NULL DEFAULT '{}')`);
}

/** Stamp agents exactly as `upsertManifestBot` does: one scalar `manifestApp` inside metadata. */
async function seedStampedAgents(target: Pool): Promise<void> {
  const stamps: Array<[string, string, string | null, string]> = [
    [SHARED_OWNED_ID, 'shared-owned-bot', 'owner-pkg', 'active'],
    [SHARED_KERNEL_ID, 'shared-kernel-bot', 'kernel-app', 'active'],
    [SHARED_UNSTAMPED_ID, 'shared-unstamped-bot', null, 'active'],
    [SHARED_GHOST_STAMP_ID, 'shared-ghost-bot', 'app-that-does-not-exist', 'active'],
    [SHARED_INACTIVE_ID, 'shared-inactive-bot', 'owner-pkg', 'inactive'],
  ];
  for (const [agentId, name, stamp, status] of stamps) {
    await target.query(`INSERT INTO agents (agent_id, name, api_provider_id, status, metadata)
      VALUES ($1::uuid, $2, 'noop', $3, $4::jsonb) ON CONFLICT (agent_id) DO NOTHING`,
      [agentId, name, status, JSON.stringify(stamp === null ? { role: '' } : { role: '', manifestApp: stamp })]);
  }
}

/** Two claimants per shared id, the many-to-many shape `swarm-app-repository.upsert` really writes. */
async function seedSharedClaims(target: Pool): Promise<void> {
  const apps: Array<[string, string, string[], string[]]> = [
    ['owner-pkg', 'deployed-apps/owner-pkg/oshal-app.yaml', [SHARED_OWNED_ID, SHARED_INACTIVE_ID], [SHARED_TOOL_NAME]],
    ['rider-app', 'swarm-apps/rider-app.yaml', [SHARED_OWNED_ID, SHARED_UNSTAMPED_ID, SHARED_GHOST_STAMP_ID,
      SHARED_INACTIVE_ID, SHARED_NO_AGENT_ID], [SHARED_TOOL_NAME]],
    ['kernel-app', 'swarm-apps/kernel-app.yaml', [SHARED_KERNEL_ID], []],
    ['squatter-pkg', 'deployed-apps/squatter-pkg/oshal-app.yaml', [SHARED_KERNEL_ID, SHARED_UNSTAMPED_ID,
      SHARED_GHOST_STAMP_ID, SHARED_NO_AGENT_ID], []],
  ];
  for (const [name, manifestPath, agentIds, toolNames] of apps) {
    await target.query(`INSERT INTO swarm_applications (name, display_name, manifest_path, agent_ids, tool_names, manifest)
      VALUES ($1,$1,$2,$3::uuid[],$4::text[],'{}'::jsonb) ON CONFLICT (name) DO NOTHING`,
      [name, manifestPath, agentIds, toolNames]);
  }
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
  await seedStampedAgents(pool);
  await seedSharedClaims(pool);
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

describe('arbitrating an agent id that more than one application associates', () => {
  it('attributes a multiply-claimed bot to its loader stamp instead of refusing', async () => {
    const ownership = await readApplicationExecutionOwnership(pool, { kind: 'bots', id: SHARED_OWNED_ID, mode: 'enforce' });
    expect(ownership).toEqual({ app: 'owner-pkg', protected: true });
  });

  it('keeps protection at the OR of every claim, so arbitration never relaxes a protected claim', async () => {
    const ownership = await readApplicationExecutionOwnership(pool, { kind: 'bots', id: SHARED_KERNEL_ID, mode: 'enforce' });
    expect(ownership).toEqual({ app: 'kernel-app', protected: true });
  });

  it('refuses a multiply-claimed bot that carries no loader stamp rather than picking a claimant', async () => {
    await expect(readApplicationExecutionOwnership(pool, { kind: 'bots', id: SHARED_UNSTAMPED_ID, mode: 'enforce' }))
      .rejects.toBeInstanceOf(ApplicationOwnershipUnavailableError);
  });

  it('refuses when the stamp names an application that does not claim the id', async () => {
    await expect(readApplicationExecutionOwnership(pool, { kind: 'bots', id: SHARED_GHOST_STAMP_ID, mode: 'enforce' }))
      .rejects.toBeInstanceOf(ApplicationOwnershipUnavailableError);
  });

  it('refuses when the stamped agent is inactive, because a disabled stamp can name a stale owner', async () => {
    await expect(readApplicationExecutionOwnership(pool, { kind: 'bots', id: SHARED_INACTIVE_ID, mode: 'enforce' }))
      .rejects.toBeInstanceOf(ApplicationOwnershipUnavailableError);
  });

  it('refuses when no agent row exists to arbitrate the claim', async () => {
    await expect(readApplicationExecutionOwnership(pool, { kind: 'bots', id: SHARED_NO_AGENT_ID, mode: 'enforce' }))
      .rejects.toBeInstanceOf(ApplicationOwnershipUnavailableError);
  });

  it('leaves the tools path refusing: a tool name has no stamped agent row to arbitrate it', async () => {
    await expect(readApplicationExecutionOwnership(pool, { kind: 'tools', id: SHARED_TOOL_NAME, mode: 'enforce' }))
      .rejects.toBeInstanceOf(ApplicationOwnershipUnavailableError);
  });

  it('still resolves a uniquely claimed tool name through the TEXT[] column', async () => {
    expect(await readApplicationExecutionOwnership(pool, { kind: 'tools', id: TOOL_NAME, mode: 'enforce' }))
      .toEqual({ app: 'jarvis', protected: false });
  });
});
