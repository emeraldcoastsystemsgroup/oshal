/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify complete fresh-principal application provisioning, transitive coverage refusals and independently revocable component provenance.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApplicationAuthorizationService, MemoryAuthorizationStore, type PackageDependencyFacts } from '@/features/application-authorization';
import type { AuthorizationActor, AuthorizationCatalog, CompositeRoleInput, CompositeRolePreview } from '@/shared/application-authorization';

const ISSUER = 'https://provisioning.fixture.invalid';
const admin: AuthorizationActor = { sub: 'fixture-admin', issuer: ISSUER, isActive: true, isSwarmAdmin: true };
const user: AuthorizationActor = { sub: 'brand-new-person', issuer: ISSUER, isActive: true, isSwarmAdmin: false };
const twin: AuthorizationActor = { ...user, issuer: 'https://other-identity.fixture.invalid' };
const ownCatalog: AuthorizationCatalog = { version: 1, resources: { own: { scopes: ['own'] } }, permissions: {
  'app.open': { resource: 'own', effect: 'read', minimumTier: 'viewer' }, 'study.create': { resource: 'own', effect: 'write', minimumTier: 'editor' },
}, roles: { student: { tier: 'editor', grants: [{ permission: 'app.open', scope: 'own' }, { permission: 'study.create', scope: 'own' }] },
  teacher: { tier: 'admin', grants: [{ permission: 'app.open', scope: 'own' }] } }, bindings: {
    http: [{ id: 'entry', method: 'GET', path: '/app', allOf: ['app.open'] }, { id: 'work', method: 'POST', path: '/work', allOf: ['study.create'] }],
  } };
const member = (app: string, role = '@app-admin') => ({ app, role });
const dependencies = new Map<string, PackageDependencyFacts>();
const facts = (apps: string[], optional: string[] = []): PackageDependencyFacts => ({ required: { apps, tools: [], connectors: [] }, optional: { apps: optional } });
let store: MemoryAuthorizationStore, service: ApplicationAuthorizationService;
async function register(app: string, requiredApps: string[] = [], catalog: AuthorizationCatalog | null = null) {
  await service.registerApp({ app, source: 'fixture-source:' + app, version: '1.0.0', catalog, mode: 'enforce', requiredApps });
  if (catalog) service.registerResourceAdapter(app, 'own', { authorize: async ({ actor, operation }) =>
    actor.issuer === user.issuer && actor.sub === user.sub && operation.resourceId !== 'foreign-record' });
}
async function host(requiredApps: string[], optionalApps: string[], members: Array<{ app: string; role: string }>) {
  await service.registerApp({ app: 'classroom-experience', source: 'fixture-source:classroom', version: '1.0.0', catalog: ownCatalog, mode: 'enforce',
    requiredApps, compositeRoles: { requiredApps, optionalApps, templates: [{ id: 'learner', version: 1, label: 'Learner', members }] } });
  service.registerResourceAdapter('classroom-experience', 'own', { authorize: async ({ actor }) => actor.sub === user.sub && actor.issuer === user.issuer });
  dependencies.set('classroom-experience', facts(requiredApps, optionalApps));
}
async function preview(override: Partial<CompositeRoleInput> = {}) {
  return service.previewCompositeRole(admin, { action: 'assign', app: 'classroom-experience', template: 'learner', targetSub: user.sub,
    targetIssuer: user.issuer, reason: 'Complete fresh-person provisioning fixture', expectedRevision: (await store.read()).revision, ...override });
}
const apply = (review: CompositeRolePreview) => service.applyCompositeRole(admin, { previewId: review.previewId!, idempotencyKey: randomUUID() });
beforeEach(async () => {
  dependencies.clear(); store = new MemoryAuthorizationStore();
  service = new ApplicationAuthorizationService(store, { resolveActor: async (sub, issuer) =>
    [admin, user, twin].find(actor => actor.sub === sub && actor.issuer === issuer) ?? null,
  resolvePackage: async app => dependencies.get(app) ?? null });
  await register('little-monsters', ['presentations', 'circuit-lab'], ownCatalog);
  await register('presentations'); await register('circuit-lab');
  dependencies.set('little-monsters', facts(['presentations', 'circuit-lab']));
  dependencies.set('presentations', facts([])); dependencies.set('circuit-lab', facts([]));
  await host(['little-monsters'], ['presentations', 'circuit-lab'], [member('classroom-experience', 'student'), member('little-monsters', 'student'),
    member('presentations'), member('circuit-lab')]);
});

describe('complete application composites for a fresh principal', () => {
  it('one reviewed assignment includes exact roles for every required component without inherited or portal rights', async () => {
    expect((await store.read()).assignments).toEqual([]); expect(user.isSwarmAdmin).toBe(false);
    for (const app of ['classroom-experience', 'little-monsters', 'presentations', 'circuit-lab']) {
      expect((await service.authorize(user, { app, method: 'GET', path: '/app' })).allowed).toBe(false);
    }
    const review = await preview(); expect(review.ready).toBe(true); expect(review.optionalApps).toEqual([]);
    expect(review.members.map(({ app, role }) => ({ app, role }))).toEqual([member('classroom-experience', 'student'), member('little-monsters', 'student'),
      member('presentations'), member('circuit-lab')]);
    await apply(review);
    for (const app of ['classroom-experience', 'little-monsters', 'presentations', 'circuit-lab']) {
      expect((await service.authorize(user, { app, method: 'POST', path: '/work' })).allowed).toBe(true);
      expect((await service.authorize(twin, { app, method: 'GET', path: '/app' })).allowed).toBe(false);
    }
    const access = await service.effective(admin, { app: 'little-monsters', targetSub: user.sub, targetIssuer: user.issuer });
    expect(access.roles).toEqual(['student']); expect(access.managementRoles).toEqual([]);
    expect((await service.authorize(user, { app: 'little-monsters', method: 'POST', path: '/work', resourceId: 'foreign-record' })).allowed).toBe(false);
    expect((await store.read()).assignments.every(edge => edge.targetIssuer === user.issuer && !edge.role?.startsWith('@access-'))).toBe(true);
  });
  it('refuses a mapped product whose transitive required components have no exact role mappings', async () => {
    await host(['little-monsters'], [], [member('classroom-experience', 'student'), member('little-monsters', 'student')]);
    const review = await preview(); expect(review.ready).toBe(false); expect(review.previewId).toBeUndefined();
    expect(review.members.filter(row => row.blocked).map(row => [row.app, row.blocked])).toEqual([
      ['presentations', 'composite_required_member_unmapped'], ['circuit-lab', 'composite_required_member_unmapped'],
    ]);
    expect((await store.read()).assignments).toEqual([]); expect(store.auditEvents).toEqual([]);
  });
  it.each(['presentations', 'circuit-lab'])('blocks the whole product when required %s is unavailable', async app => {
    service.unregisterApp(app);
    const review = await preview(); expect(review.ready).toBe(false); expect(review.members.find(row => row.app === app)?.blocked).toBe('composite_member_unavailable');
    expect((await store.read()).assignments).toEqual([]);
  });
  it('refuses a nonexistent ordinary Office role without substituting administrative access', async () => {
    await host(['little-monsters'], ['presentations', 'circuit-lab'], [member('classroom-experience', 'student'), member('little-monsters', 'student'),
      member('presentations', 'invented-member'), member('circuit-lab')]);
    const review = await preview(); expect(review.ready).toBe(false);
    expect(review.members.find(row => row.app === 'presentations')?.blocked).toBe('composite_member_role_unavailable');
    expect((await store.read()).assignments).toEqual([]);
  });
  it('does not clear an explicit required-component deny or partially grant the other components', async () => {
    const deny = await service.previewChange(admin, { action: 'deny', app: 'presentations', targetSub: user.sub, targetIssuer: user.issuer,
      reason: 'Explicit Office refusal fixture', expectedRevision: (await store.read()).revision });
    await service.applyChange(admin, { previewId: deny.previewId, idempotencyKey: randomUUID() });
    const review = await preview(); expect(review.ready).toBe(false);
    expect(review.members.find(row => row.app === 'presentations')?.blocked).toBe('composite_member_denied');
    expect((await store.read()).assignments).toHaveLength(1); expect((await store.read()).assignments[0].deny).toBe(true);
  });
  it('a changed transitive prerequisite invalidates the stored review before any grants', async () => {
    const review = await preview(); dependencies.set('little-monsters', facts(['presentations', 'circuit-lab', 'new-component']));
    await expect(apply(review)).rejects.toMatchObject({ code: 'authorization_revision_conflict' });
    expect((await store.read()).assignments).toEqual([]);
  });
  it('a changed registered prerequisite invalidates review even when its source/catalog/version remain equal', async () => {
    const review = await preview(); await register('presentations', ['new-component']);
    await expect(apply(review)).rejects.toMatchObject({ code: 'authorization_revision_conflict' });
    expect((await store.read()).assignments).toEqual([]);
  });
  it('revoke removes only the complete assignment and preserves independently assigned Office rights', async () => {
    const direct = await service.previewChange(admin, { action: 'grant', app: 'presentations', targetSub: user.sub, targetIssuer: user.issuer,
      role: '@app-admin', reason: 'Separate prior Office assignment fixture', expectedRevision: (await store.read()).revision });
    await service.applyChange(admin, { previewId: direct.previewId, idempotencyKey: randomUUID() });
    const receipt = await apply(await preview());
    const revocation = await preview({ action: 'revoke', assignmentId: receipt.assignmentId, template: undefined, targetSub: undefined, targetIssuer: undefined });
    await apply(revocation);
    const edges = (await store.read()).assignments;
    expect(edges).toHaveLength(1); expect(edges[0].app).toBe('presentations'); expect(edges[0].grantSource).toBeUndefined();
    expect((await service.authorize(user, { app: 'presentations', method: 'POST', path: '/work' })).allowed).toBe(true);
    expect((await service.authorize(user, { app: 'little-monsters', method: 'GET', path: '/app' })).allowed).toBe(false);
  });
});
