/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Real-store guard for the RLS-hidden experience refusal. A person-scoped experience row is invisible to another non-operator under migrations 060/063 (FORCE RLS, public-read policy), so getApp returns null and the profile route used to wave the request through to the built-in "Default full-operator profile" with a 200. Here the REAL SwarmAppRepository and SwarmAppService run over a disposable PostgreSQL as the NOSUPERUSER NOBYPASSRLS oshal_app role, through the production GUC pool and request identity, behind the real createUiProfileRoutes: the hidden row answers 404 experience_unavailable with exactly the lock fields, a public experience row reaches the app.open gate (403), and the landing application synthesises from its row (200).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Pool } from 'pg';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import { wrapPoolWithGuc } from '@/shared/services/database';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { createUiProfileRoutes, type UiProfileDiscoveryPorts } from '@/app/routes/ui-profile-routes';
import { SwarmAppService } from '@/features/swarm-apps';
import { SwarmAppRepository } from '@/features/swarm-apps/services/swarm-app-repository';
import { UIProfileService } from '@/features/ui-profile';
import { DisposablePostgres } from '../helpers/disposable-postgres';

/** The production least-privilege role: NOSUPERUSER NOBYPASSRLS, so the 060/063 policies really filter it. */
const ENFORCING_ROLE = 'oshal_app';
const LANDING = 'intelligent-sales';
const OWNER = 'auth0|fixture-experience-owner';
const MEMBER = 'auth0|fixture-sales-member';

const database = new DisposablePostgres({
  purpose: 'ui-profile-rls-hidden-experience', database: 'ui_profile_rls_fixture',
  migrations: ['022-swarm-applications.sql', '054-swarm-app-scope.sql', '060-platform-rls-tenancy.sql',
    '063-swarm-apps-public-read.sql', '064-swarm-app-operator-scope.sql', '076-app-guest-tier-approval.sql'],
  memory: '256m', max: 4, connectionTimeoutMillis: 10_000, statementTimeoutMs: 30_000,
  roles: [{ name: ENFORCING_ROLE, max: 4 }],
});

let admin: Pool;
let gucPool: Pool;
let repository: SwarmAppRepository;
let server: Server;
let base = '';

/** Rows written as the fixture superuser, past RLS: the landing app, a person-scoped and a public experience. */
async function seed(): Promise<void> {
  const insert = `INSERT INTO swarm_applications (name, display_name, manifest_path, manifest, scope, owner_sub)
    VALUES ($1, $2, '/dev/null', $3::jsonb, $4, $5)`;
  const experience = (name: string) => JSON.stringify({ name, displayName: name,
    experience: { version: 1, entry: `/api/${name}/app`, shell: 'rail', label: name } });
  await admin.query(insert, [LANDING, 'Synthetic Sales', JSON.stringify({ name: LANDING, displayName: 'Synthetic Sales' }), 'public', null]);
  await admin.query(insert, ['hidden-experience', 'Hidden', experience('hidden-experience'), 'person', OWNER]);
  await admin.query(insert, ['public-experience', 'Public', experience('public-experience'), 'public', null]);
  await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ENFORCING_ROLE}`);
}

/** The identity middleware exactly as server.ts mounts it: the chain runs inside the caller's store. */
function requestIdentity(req: Request, _res: Response, next: NextFunction): void {
  runWithRequestIdentity({ sub: String(req.get('x-fixture-sub')), isOperator: false }, () => next());
}

/** Discovery admits every row the caller can read; app.open refuses, so a visible experience stops at 403. */
const discovery: UiProfileDiscoveryPorts = {
  resolveActor: async (req) => ({ sub: String(req.get('x-fixture-sub')), issuer: 'https://fixture.invalid', isActive: true, isSwarmAdmin: false } as never),
  runtime: { canDiscover: async () => true, canNavigateHttpPath: async () => false },
};

beforeAll(async () => {
  admin = await database.start();
  await seed();
  gucPool = wrapPoolWithGuc(database.rolePool(ENFORCING_ROLE));
  repository = new SwarmAppRepository(gucPool);
  const apps = new SwarmAppService(gucPool, repository, {} as never);
  const app = express();
  app.use(requestIdentity);
  app.use('/api/ui', createUiProfileRoutes(new UIProfileService(), apps, discovery, { landingApp: () => LANDING, isOperator: () => false }));
  await new Promise<void>((done) => { server = app.listen(0, '127.0.0.1', () => done()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ui/profile`;
}, 180_000);

afterAll(async () => {
  if (server) await new Promise<void>((done) => server.close(() => done()));
  await database.stop();
}, 60_000);

const asCaller = (sub: string, path = '') => fetch(`${base}${path}`, { headers: { 'x-fixture-sub': sub } });

describe('an experience row the caller cannot read, against the enforcing role and schema', () => {
  it('the fixture enforces: the route pool is neither superuser nor RLS-bypassing', async () => {
    const who = await database.rolePool(ENFORCING_ROLE).query(
      'SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS s,'
      + ' (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS b');
    expect(who.rows[0]).toEqual({ u: ENFORCING_ROLE, s: false, b: false });
  });

  it('RLS is what hides the row: the owner reads it, another member does not, the public rows are read by both', async () => {
    const read = (sub: string, name: string) => runWithRequestIdentity({ sub, isOperator: false }, () => repository.findByName(name));
    expect((await read(OWNER, 'hidden-experience'))?.name).toBe('hidden-experience');
    expect(await read(MEMBER, 'hidden-experience')).toBeNull();
    expect((await read(MEMBER, 'public-experience'))?.name).toBe('public-experience');
    expect((await read(MEMBER, LANDING))?.name).toBe(LANDING);
  });

  it('refuses the hidden experience 404 with exactly the lock fields, never the built-in profile', async () => {
    const res = await asCaller(MEMBER, '?name=hidden-experience');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'experience_unavailable', landingApp: LANDING, operator: false });
  });

  it('a public experience row reaches the app.open gate instead (403 with the lock fields)', async () => {
    const res = await asCaller(MEMBER, '?name=public-experience');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'experience_navigation_refused', landingApp: LANDING, operator: false });
  });

  it('with no name the member gets the landing application synthesised from its row', async () => {
    const res = await asCaller(MEMBER);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ requested: LANDING, source: 'swarm-app', landingApp: LANDING, operator: false });
    expect(body.profile.name).toBe(LANDING);
  });
});
