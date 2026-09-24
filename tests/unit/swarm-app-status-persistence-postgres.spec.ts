/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Real-PostgreSQL guard for operator app status surviving a plain boot reload. An opt-in manifest declares inactive, the operator activates its installed row, and the next real repository upsert must preserve active; explicit variant manifests retain their existing override semantics.
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SwarmAppRepository } from '@/features/swarm-apps/services/swarm-app-repository';
import type { SwarmAppManifest } from '@/features/swarm-apps/types';
import { DisposablePostgres } from '../helpers/disposable-postgres';

const database = new DisposablePostgres({
  purpose: 'swarm-app-status-persistence',
  migrations: [
    '022-swarm-applications.sql',
    '054-swarm-app-scope.sql',
    '076-app-guest-tier-approval.sql',
  ],
});

let pool: Pool;
let repository: SwarmAppRepository;

const manifest = (name: string, status: 'active' | 'inactive'): SwarmAppManifest => ({
  name,
  displayName: name,
  version: '1.0.0',
  status,
  bots: [],
});

beforeAll(async () => {
  pool = await database.start();
  repository = new SwarmAppRepository(pool);
}, 240_000);

afterAll(async () => { await database.stop(); });

describe('SwarmAppRepository app-status persistence against real PostgreSQL', () => {
  it('preserves an operator activation when boot reloads an opt-in inactive manifest', async () => {
    const app = manifest('opt-in-active-survives', 'inactive');
    expect((await repository.upsert(app, '/app/deployed-apps/opt-in/oshal-app.yaml', [])).status).toBe('inactive');
    expect((await repository.updateStatus(app.name, 'active'))?.status).toBe('active');

    const reloaded = await repository.upsert(app, '/app/deployed-apps/opt-in/oshal-app.yaml', []);
    const stored = await pool.query<{ status: string }>('SELECT status FROM swarm_applications WHERE name = $1', [app.name]);

    expect(reloaded.status).toBe('active');
    expect(stored.rows[0]?.status).toBe('active');
  });

  it('continues preserving an operator deactivation across a plain manifest reload', async () => {
    const app = manifest('operator-inactive-survives', 'active');
    await repository.upsert(app, '/app/deployed-apps/ordinary/oshal-app.yaml', []);
    await repository.updateStatus(app.name, 'inactive');

    expect((await repository.upsert(app, '/app/deployed-apps/ordinary/oshal-app.yaml', [])).status).toBe('inactive');
  });

  it('continues letting an explicit variant manifest override the stored status', async () => {
    const app = manifest('variant-still-wins', 'active');
    await repository.upsert(app, '/app/swarm-apps/variant-still-wins.yaml', []);
    await repository.updateStatus(app.name, 'inactive');

    expect((await repository.upsert(app, '/app/swarm-apps-build/variant-still-wins.yaml', [])).status).toBe('active');
  });
});
