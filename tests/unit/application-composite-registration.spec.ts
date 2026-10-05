/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove native application templates survive real catalog import, manifest validation and runtime registration without granting users access.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { ApplicationAuthorizationRuntime } from '@/app/composition/application-authorization-runtime';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '@/features/application-authorization';
import { readManifest } from '@/features/swarm-apps/services/swarm-app-loader';
import type { SwarmAppManifest, SwarmApplicationRecord } from '@/features/swarm-apps';
import { loadApplicationAuthorization, type AuthorizationActor, type AuthorizationCatalog } from '@/shared/application-authorization';

const roots: string[] = [];
const admin: AuthorizationActor = { sub: 'fixture-admin', issuer: 'https://native.fixture.invalid', isActive: true, isSwarmAdmin: true };
const catalog: AuthorizationCatalog = { version: 1, resources: { own: { scopes: ['own'] } },
  permissions: { 'app.open': { resource: 'own', effect: 'read', minimumTier: 'viewer' } },
  roles: { student: { tier: 'viewer', grants: [{ permission: 'app.open', scope: 'own' }] } },
  bindings: { http: [{ id: 'entry', method: 'GET', path: '/app', allOf: ['app.open'] }] } };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'oshal-native-composite-')); roots.push(root);
  writeFileSync(join(root, 'authorization.yaml'), yaml.dump(catalog));
  const manifest: SwarmAppManifest = { name: 'little-monsters', displayName: 'Little Monsters', version: '1.0.0',
    uses: ['application-authorization', 'experience-roles', 'app-dependencies'],
    dependencies: { required: { apps: ['presentations', 'circuit-lab'] }, optional: { apps: [] } },
    authorization: { version: 1, catalog: 'authorization.yaml', roleTemplates: [{ id: 'student', version: 1, label: 'Student',
      members: [{ app: 'little-monsters', role: 'student' }, { app: 'presentations', role: '@app-admin' }, { app: 'circuit-lab', role: '@app-admin' }] }] } };
  const path = join(root, 'oshal-app.yaml'); writeFileSync(path, yaml.dump(manifest));
  return { root, manifest, path };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('native composite package activation', () => {
  it('imports the shared catalog and registers native role templates without installation grants', async () => {
    const { root, path } = fixture(), manifest = readManifest(path);
    expect(loadApplicationAuthorization(root, manifest)).toEqual(catalog);
    const store = new MemoryAuthorizationStore(), service = new ApplicationAuthorizationService(store);
    const runtime = new ApplicationAuthorizationRuntime(service, async () => admin);
    const record: SwarmApplicationRecord = { appId: 'native-fixture', name: manifest.name, displayName: manifest.displayName,
      description: '', version: '1.0.0', status: 'active', manifestPath: path, manifest, agentIds: [], toolNames: [],
      scope: 'public', ownerSub: null, tenantId: null, guestTierApproved: null, loadedAt: new Date(), updatedAt: new Date() };
    await runtime.prepare(manifest, path); await runtime.start(record); runtime.complete(record);
    const listed = await service.listCompositeRoles(admin);
    expect(listed.experiences).toHaveLength(1);
    expect(listed.experiences[0].templates).toEqual(manifest.authorization!.roleTemplates);
    const review = await service.previewCompositeRole(admin, { action: 'assign', app: manifest.name, template: 'student',
      targetSub: admin.sub, targetIssuer: admin.issuer, reason: 'Native prerequisite registration proof', expectedRevision: listed.revision });
    expect(review.members.map(member => member.app)).toEqual(['little-monsters', 'presentations', 'circuit-lab']);
    expect(review.ready).toBe(false); expect(review.previewId).toBeUndefined();
    expect((await store.read()).assignments).toEqual([]); expect(listed.assignments).toEqual([]);
  });
  it('the CLI importer and runtime reader both reject native templates without the lifecycle floor', () => {
    const { root, manifest, path } = fixture(); manifest.uses = ['application-authorization', 'app-dependencies'];
    writeFileSync(path, yaml.dump(manifest));
    expect(() => loadApplicationAuthorization(root, manifest)).toThrow(/experience-roles/);
    expect(() => readManifest(path)).toThrow(/experience-roles/);
  });
  it('the CLI importer refuses undeclared component roles and competing template owners', () => {
    const { root, manifest } = fixture();
    manifest.authorization!.roleTemplates![0].members.push({ app: 'foreign-application', role: '@app-admin' });
    expect(() => loadApplicationAuthorization(root, manifest)).toThrow(/declared dependency/);
    manifest.authorization!.roleTemplates![0].members.pop();
    manifest.experience = { version: 1, entry: '/app', shell: 'page', skin: 'classroom', label: 'Classroom',
      roleTemplates: manifest.authorization!.roleTemplates };
    expect(() => loadApplicationAuthorization(root, manifest)).toThrow(/one declaration owner/);
  });
});
