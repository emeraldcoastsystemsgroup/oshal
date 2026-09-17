/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard the "configure by package" grant plan against the REAL PostgreSQL policy store and the real authorization service: the required closure resolves, a cycle and a self-reference terminate, an uninstalled or inactive prerequisite is reported rather than granted, an application outside the closure is never touched, and the plan itself writes nothing.
 */
/** Disposable local PostgreSQL only. Never consumes DATABASE_URL or deployment credentials. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ApplicationAuthorizationService, PostgresAuthorizationStore, type PackageDependencyFacts,
} from '../../src/features/application-authorization';
import { wrapPoolWithGuc } from '../../src/shared/services/database/guc-pool';
import type { AuthorizationActor, AuthorizationCatalog } from '../../src/shared/application-authorization';

const container = `oshal-package-plan-${randomUUID().slice(0, 8)}`;
const password = randomUUID();
const ISSUER = 'https://identity.fixture.test';
let started = false; let owner: Pool; let runtime: Pool; let service: ApplicationAuthorizationService;

const admin: AuthorizationActor = { sub: 'fixture-admin', issuer: ISSUER, isActive: true, isSwarmAdmin: true };
const subject: AuthorizationActor = { sub: 'fixture-child', issuer: ISSUER, isActive: true, isSwarmAdmin: false };
const dormantSubject: AuthorizationActor = { sub: 'fixture-closed', issuer: ISSUER, isActive: false, isSwarmAdmin: false };
/** Holds management read on the root package only — every prerequisite must stay opaque to them. */
const narrowAdmin: AuthorizationActor = {
  sub: 'fixture-narrow', issuer: ISSUER, isActive: true, isSwarmAdmin: false,
  managementScopes: [{ app: 'monsters', permissions: ['read', 'assign'] }],
};

const CATALOG: AuthorizationCatalog = {
  version: 1, resources: { files: { scopes: ['own'] } },
  permissions: { 'files.read': { resource: 'files', effect: 'read', minimumTier: 'viewer' } },
  roles: { reader: { tier: 'viewer', grants: [{ permission: 'files.read', scope: 'own' }] },
    keeper: { tier: 'admin', grants: [{ permission: 'files.read', scope: 'own' }] } },
  bindings: { http: [{ id: 'read-files', method: 'GET', path: '/files', allOf: ['files.read'] }] },
};

/** The installed packages the plan reads dependency declarations from. */
const packages = new Map<string, PackageDependencyFacts>();
function installed(app: string, required: string[] = [], extra: Partial<PackageDependencyFacts> = {}): void {
  packages.set(app, { required: { apps: required, tools: [], connectors: [], ...extra.required },
    optional: { apps: [], ...extra.optional } });
}

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim();
}

beforeAll(async () => {
  docker(['run', '--detach', '--rm', '--name', container, '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data',
    '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=package_plan_fixture', 'postgres:16-alpine']);
  started = true;
  const port = Number(docker(['port', container, '5432/tcp']).split(':').pop());
  owner = new Pool({ host: '127.0.0.1', port, user: 'postgres', password, database: 'package_plan_fixture', connectionTimeoutMillis: 500 });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await owner.query('SELECT 1'); ready = true; break; } catch { await new Promise(done => setTimeout(done, 200)); }
  }
  if (!ready) throw new Error('Disposable package-plan PostgreSQL did not become ready');
  await owner.query(readFileSync(resolve('scripts/migrations/127-application-authorization.sql'), 'utf8'));
  await owner.query("CREATE ROLE package_plan_runtime LOGIN PASSWORD 'fixture-only' NOSUPERUSER NOBYPASSRLS");
  await owner.query('GRANT USAGE ON SCHEMA public TO package_plan_runtime');
  await owner.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO package_plan_runtime');
  runtime = wrapPoolWithGuc(new Pool({ host: '127.0.0.1', port, user: 'package_plan_runtime', password: 'fixture-only', database: 'package_plan_fixture' }));
}, 90_000);

afterAll(async () => {
  if (runtime) await runtime.end();
  if (owner) await owner.end();
  if (started) docker(['rm', '--force', container]);
});

beforeEach(async () => {
  await owner.query('TRUNCATE oshal_authorization_assignments,oshal_authorization_previews,oshal_authorization_audit,oshal_authorization_applications');
  await owner.query('UPDATE oshal_authorization_state SET revision=0');
  packages.clear();
  service = new ApplicationAuthorizationService(new PostgresAuthorizationStore(runtime), {
    resolveActor: async (sub, issuer) => [subject, dormantSubject, admin, narrowAdmin]
      .find(actor => actor.sub === sub && actor.issuer === issuer) ?? null,
    resolvePackage: async app => packages.get(app) ?? null,
  });
  // monsters -> office -> archive (catalogued); monsters also requires the never-installed `ledger`.
  installed('monsters', ['office'], { required: { apps: ['office', 'ledger'], tools: ['deck_render'], connectors: ['gmail'] },
    optional: { apps: ['photos'] } });
  installed('office', ['archive']);
  installed('archive');
  installed('dormant');
  installed('photos');
  installed('outside');
  for (const app of ['monsters', 'office', 'outside']) {
    await service.registerApp({ app, source: `source-${app}`, version: '1.0.0', catalog: null, mode: 'enforce' });
  }
  await service.registerApp({ app: 'archive', source: 'source-archive', version: '1.0.0', catalog: CATALOG, mode: 'enforce',
    adapters: { files: { authorize: async () => true } } });
});

const plan = (actor: AuthorizationActor, app = 'monsters', target = subject) =>
  service.packageGrantPlan(actor, { app, targetSub: target.sub, targetIssuer: target.issuer });
const entry = (rows: Awaited<ReturnType<typeof plan>>['entries'], app: string) => rows.find(row => row.app === app)!;
const assignmentCount = async (): Promise<number> =>
  Number((await owner.query('SELECT count(*)::int AS total FROM oshal_authorization_assignments')).rows[0].total);
const revision = async (): Promise<number> =>
  Number((await owner.query('SELECT revision FROM oshal_authorization_state')).rows[0].revision);

describe('package grant plan against the real PostgreSQL policy store', () => {
  it('resolves the transitive required set, keeps optional apps as offers and leaves outsiders out', async () => {
    const result = await plan(admin);
    expect(result.entries.map(row => row.app)).toEqual(['monsters', 'office', 'ledger', 'archive']);
    expect(entry(result.entries, 'archive').requiredBy).toEqual(['office', 'monsters']);
    expect(entry(result.entries, 'monsters').depth).toBe(0);
    expect(entry(result.entries, 'archive').depth).toBe(2);
    expect(result.offers).toEqual([{ app: 'photos', offeredBy: 'monsters' }]);
    expect(result.declaredNeeds).toEqual([
      { kind: 'tool', id: 'deck_render', declaredBy: 'monsters' },
      { kind: 'connector', id: 'gmail', declaredBy: 'monsters' },
    ]);
    expect(result.entries.some(row => row.app === 'outside')).toBe(false);
    expect(result.entries.some(row => row.app === 'photos')).toBe(false);
  });

  it('classifies each application into the one change /access would make for it', async () => {
    await service.registerApp({ app: 'office', source: 'source-office', version: '1.0.0', catalog: null, mode: 'legacy' });
    const result = await plan(admin);
    expect(entry(result.entries, 'monsters').action).toBe('grant-app-admin');
    expect(entry(result.entries, 'monsters').candidateRoles).toEqual(['@app-admin']);
    expect(entry(result.entries, 'office').action).toBe('no-grant-required');
    expect(entry(result.entries, 'ledger').action).toBe('blocked-not-installed');
    expect(entry(result.entries, 'archive').action).toBe('choose-role');
    expect(entry(result.entries, 'archive').candidateRoles).toEqual(['reader', 'keeper']);
    expect(result.actionable).toBe(2);
  });

  it('terminates on a dependency cycle and on a self-reference, reporting each cycle once', async () => {
    installed('monsters', ['office']);
    installed('office', ['archive']);
    installed('archive', ['monsters']);
    installed('selfie', ['selfie']);
    const cyclic = await plan(admin);
    expect(cyclic.entries.map(row => row.app)).toEqual(['monsters', 'office', 'archive']);
    expect(cyclic.cycles).toEqual([['monsters', 'office', 'archive']]);
    await service.registerApp({ app: 'selfie', source: 'source-selfie', version: '1.0.0', catalog: null, mode: 'enforce' });
    const self = await plan(admin, 'selfie');
    expect(self.entries.map(row => row.app)).toEqual(['selfie']);
    expect(self.cycles).toEqual([['selfie']]);
  });

  it('reports an uninstalled or inactive prerequisite instead of granting access to something absent', async () => {
    installed('monsters', ['office'], { required: { apps: ['office', 'ledger', 'dormant'], tools: [], connectors: [] } });
    const result = await plan(admin);
    expect(entry(result.entries, 'ledger').action).toBe('blocked-not-installed');
    expect(entry(result.entries, 'ledger').status).toBeUndefined();
    expect(entry(result.entries, 'dormant').action).toBe('blocked-inactive');
    expect(entry(result.entries, 'dormant').candidateRoles).toBeUndefined();
    for (const app of ['ledger', 'dormant']) {
      await expect(service.effective(admin, { app, targetSub: subject.sub, targetIssuer: subject.issuer }))
        .rejects.toMatchObject({ code: 'authorization_app_unavailable' });
    }
  });

  it('writes nothing: no assignment, no revision bump, and every application still denied afterwards', async () => {
    const before = { rows: await assignmentCount(), revision: await revision() };
    await plan(admin); await plan(admin);
    expect(await assignmentCount()).toBe(before.rows);
    expect(await revision()).toBe(before.revision);
    for (const app of ['monsters', 'office', 'archive', 'outside']) {
      const access = await service.effective(admin, { app, targetSub: subject.sub, targetIssuer: subject.issuer });
      expect({ app, tier: access.tier, roles: access.roles }).toEqual({ app, tier: 'deny', roles: [] });
    }
  });

  it('describes exactly the change /access then makes, and never touches an application outside the set', async () => {
    const before = await plan(admin);
    expect(entry(before.entries, 'monsters').action).toBe('grant-app-admin');
    const preview = await service.previewChange(admin, { action: 'grant', app: 'monsters', targetSub: subject.sub,
      targetIssuer: subject.issuer, role: '@app-admin', reason: 'configure by package', expectedRevision: before.revision });
    await service.applyChange(admin, { previewId: preview.previewId, idempotencyKey: randomUUID() });
    const after = await plan(admin);
    expect(entry(after.entries, 'monsters').action).toBe('already-granted');
    expect(entry(after.entries, 'monsters').currentTier).toBe('admin');
    expect(entry(after.entries, 'office').action).toBe('grant-app-admin');
    const outside = await service.effective(admin, { app: 'outside', targetSub: subject.sub, targetIssuer: subject.issuer });
    expect({ tier: outside.tier, roles: outside.roles }).toEqual({ tier: 'deny', roles: [] });
    expect(await assignmentCount()).toBe(1);
  });

  it('reports an explicit deny rather than proposing a grant that would not take effect', async () => {
    const current = (await plan(admin)).revision;
    const preview = await service.previewChange(admin, { action: 'deny', app: 'office', targetSub: subject.sub,
      targetIssuer: subject.issuer, reason: 'restricted', expectedRevision: current });
    await service.applyChange(admin, { previewId: preview.previewId, idempotencyKey: randomUUID() });
    const result = await plan(admin);
    expect(entry(result.entries, 'office').action).toBe('blocked-explicit-deny');
    expect(result.actionable).toBe(2);
  });

  it('surrenders nothing about a prerequisite this caller may not administer', async () => {
    const result = await plan(narrowAdmin);
    expect(entry(result.entries, 'monsters').action).toBe('grant-app-admin');
    for (const app of ['office', 'ledger', 'archive']) {
      expect(entry(result.entries, app)).toEqual({ app, depth: expect.any(Number),
        requiredBy: expect.any(Array), action: 'blocked-management-denied' });
    }
    await expect(service.packageGrantPlan(narrowAdmin, { app: 'archive', targetSub: subject.sub, targetIssuer: subject.issuer }))
      .rejects.toMatchObject({ code: 'authorization_management_denied' });
  });

  it('refuses to describe a grant to a closed account as anything but blocked', async () => {
    const result = await plan(admin, 'monsters', dormantSubject);
    expect(result.entries.map(row => row.action)).toEqual([
      'blocked-subject-inactive', 'blocked-subject-inactive', 'blocked-not-installed', 'blocked-subject-inactive']);
    expect(result.actionable).toBe(0);
  });

  it('counts an assignment the running installation no longer matches instead of reading it as access', async () => {
    const current = (await plan(admin)).revision;
    const preview = await service.previewChange(admin, { action: 'grant', app: 'monsters', targetSub: subject.sub,
      targetIssuer: subject.issuer, role: '@app-admin', reason: 'before reinstall', expectedRevision: current });
    await service.applyChange(admin, { previewId: preview.previewId, idempotencyKey: randomUUID() });
    // A reinstall from a different origin: same package name, new installation source.
    await owner.query('UPDATE oshal_authorization_assignments SET payload=jsonb_set(payload,\'{source}\',\'"source-monsters-old"\')');
    const result = await plan(admin);
    expect(entry(result.entries, 'monsters').action).toBe('grant-app-admin');
    expect(entry(result.entries, 'monsters').inertAssignments).toBe(1);
    expect(entry(result.entries, 'office').inertAssignments).toBeUndefined();
  });

  it('refuses a dependency chain past its bound rather than returning a plan that looks complete', async () => {
    for (let depth = 0; depth <= 40; depth++) installed(`chain-${depth}`, [`chain-${depth + 1}`]);
    await service.registerApp({ app: 'chain-0', source: 'source-chain', version: '1.0.0', catalog: null, mode: 'enforce' });
    await expect(service.packageGrantPlan(admin, { app: 'chain-0', targetSub: subject.sub, targetIssuer: subject.issuer }))
      .rejects.toMatchObject({ code: 'authorization_package_plan_too_large' });
  });
});
