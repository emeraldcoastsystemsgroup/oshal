/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | AUTH-07 catalog diff classifier contract: the Little Monsters-shaped 1.4.3 -> 1.4.4 change (one HTTP binding and one artifact action over existing permissions) is non-widening; a new, removed or renamed permission, a changed role mapping and a changed field or record scope are widening or breaking; HTTP bindings are compared by the requests they can share (renames, re-paths, parameter/literal overlap and mount-prefixed candidate paths), never by id.
 */
/** Pure classifier over validated catalogs; no store, no server. */
import { describe, expect, it } from 'vitest';
import { diffAuthorizationCatalogs } from '@/features/application-authorization';
import { CLASSROOM_143 as BASE, CLASSROOM_144, editedCatalog as next } from '../fixtures/authorization-catalog-migration';

const lm144 = () => structuredClone(CLASSROOM_144);
const effects = (diff: ReturnType<typeof diffAuthorizationCatalogs>) => diff.changes.map(change => `${change.area}:${change.id}:${change.change}:${change.effect}`);

describe('AUTH-07 catalog diff classifier', () => {
  it('classifies the Little Monsters 1.4.3 -> 1.4.4 revision as non-widening', () => {
    const diff = diffAuthorizationCatalogs(BASE, lm144(), { mountPaths: ['/api/education'] });
    expect(diff.classification).toBe('non-widening');
    expect(effects(diff)).toEqual(['binding:POST /import-artifact:added:additive', 'binding:class-material:added:additive']);
    expect(diffAuthorizationCatalogs(BASE, structuredClone(BASE)).classification).toBe('unchanged');
    // The rollback direction only unbinds operations, so it narrows.
    expect(diffAuthorizationCatalogs(lm144(), BASE).classification).toBe('non-widening');
    expect(effects(diffAuthorizationCatalogs(lm144(), BASE))).toEqual(['binding:POST /import-artifact:removed:narrowing', 'binding:class-material:removed:narrowing']);
  });

  it('refuses any new permission, even when only a new binding uses it', () => {
    const diff = diffAuthorizationCatalogs(BASE, next(catalog => {
      catalog.permissions['reward.grant'] = { resource: 'learner', effect: 'write', minimumTier: 'editor' };
      catalog.bindings.http!.push({ id: 'post-rewards', method: 'POST', path: '/rewards', allOf: ['app.open', 'reward.grant'] });
    }));
    expect(diff.classification).toBe('widening');
    expect(effects(diff)).toEqual(['permission:reward.grant:added:widening', 'binding:POST /rewards:added:widening']);
  });

  it('treats removed and renamed permissions and roles as breaking', () => {
    const renamed = diffAuthorizationCatalogs(BASE, next(catalog => {
      catalog.permissions['study.view'] = catalog.permissions['study.read']; delete catalog.permissions['study.read'];
      for (const role of Object.values(catalog.roles)) for (const grant of role.grants) if (grant.permission === 'study.read') grant.permission = 'study.view';
      for (const binding of catalog.bindings.http!) binding.allOf = binding.allOf.map(item => item === 'study.read' ? 'study.view' : item);
    }));
    expect(renamed.classification).toBe('breaking');
    expect(effects(renamed)).toContain('permission:study.read:removed:breaking');
    expect(effects(renamed)).toContain('permission:study.view:added:widening');
    const removedRole = diffAuthorizationCatalogs(BASE, next(catalog => { delete catalog.roles.teacher; }));
    expect(removedRole.classification).toBe('breaking');
    expect(effects(removedRole)).toEqual(['role:teacher:removed:breaking']);
  });

  it('refuses every changed role mapping and names its direction', () => {
    const gained = next(catalog => { catalog.roles.student.grants.push({ permission: 'material.create', scope: 'own' }); });
    expect(effects(diffAuthorizationCatalogs(BASE, gained))).toEqual(['role:student:changed:widening']);
    const lost = next(catalog => { catalog.roles.student.grants.pop(); });
    expect(effects(diffAuthorizationCatalogs(BASE, lost))).toEqual(['role:student:changed:breaking']);
    const relaxed = next(catalog => { delete catalog.roles.teacher.sensitive; });
    expect(effects(diffAuthorizationCatalogs(BASE, relaxed))).toEqual(['role:teacher:changed:widening']);
    const added = next(catalog => { catalog.roles.observer = { tier: 'viewer', grants: [{ permission: 'study.read', scope: 'own' }] }; });
    expect(effects(diffAuthorizationCatalogs(BASE, added))).toEqual(['role:observer:added:widening']);
    const reordered = next(catalog => { catalog.roles.student.grants.reverse(); });
    expect(diffAuthorizationCatalogs(BASE, reordered).classification).toBe('unchanged');
  });

  it('refuses changed record scopes and field sets, and admits a new resource', () => {
    const tenantScope = next(catalog => {
      catalog.resources.learner.scopes.push('tenant');
      catalog.roles.teacher.grants[1].scope = 'tenant';
    });
    expect(diffAuthorizationCatalogs(BASE, tenantScope).classification).toBe('widening');
    expect(effects(diffAuthorizationCatalogs(BASE, tenantScope))).toEqual(['resource:learner:changed:widening', 'role:teacher:changed:widening']);
    const fields = (list: string[]) => next(catalog => {
      catalog.resources.teaching.fieldSets = { summary: list };
      catalog.roles.teacher.grants[3].fields = 'summary';
    });
    expect(effects(diffAuthorizationCatalogs(fields(['name']), fields(['name', 'grade'])))).toEqual(['resource:teaching:changed:widening']);
    expect(effects(diffAuthorizationCatalogs(fields(['name', 'grade']), fields(['name'])))).toEqual(['resource:teaching:changed:breaking']);
    const resource = diffAuthorizationCatalogs(BASE, next(catalog => { catalog.resources.archive = { scopes: ['own'] }; }));
    expect(resource).toEqual({ classification: 'non-widening', changes: [expect.objectContaining({ area: 'resource', id: 'archive', effect: 'additive' })] });
  });

  it('refuses a changed permission effect, floor or resource', () => {
    const effect = next(catalog => { catalog.permissions['class.change'].effect = 'export'; });
    expect(effects(diffAuthorizationCatalogs(BASE, effect))).toEqual(['permission:class.change:changed:widening']);
    const raised = next(catalog => { catalog.permissions['study.read'].minimumTier = 'editor'; catalog.roles.reviewer.tier = 'editor'; });
    expect(diffAuthorizationCatalogs(BASE, raised).classification).toBe('breaking');
    expect(effects(diffAuthorizationCatalogs(BASE, raised))).toEqual(['permission:study.read:changed:breaking', 'role:reviewer:changed:widening']);
    const moved = next(catalog => { catalog.permissions['class.change'].resource = 'learner'; });
    expect(effects(diffAuthorizationCatalogs(BASE, moved))).toEqual(['permission:class.change:changed:breaking']);
  });

  it('compares HTTP bindings by the requests they can match, not by id', () => {
    const renamed = next(catalog => { catalog.bindings.http![1].id = 'read-one-record'; catalog.bindings.http![1].path = '/records/:recordId'; });
    expect(diffAuthorizationCatalogs(BASE, renamed).classification).toBe('unchanged');
    const loosened = next(catalog => { catalog.bindings.http![1] = { id: 'renamed', method: 'GET', path: '/records/:recordId', allOf: ['app.open'] }; });
    expect(effects(diffAuthorizationCatalogs(BASE, loosened))).toEqual(['binding:GET /records/:recordId:changed:widening']);
    const tightened = next(catalog => { catalog.bindings.http![1].allOf.push('material.create'); });
    expect(effects(diffAuthorizationCatalogs(BASE, tightened))).toEqual(['binding:GET /records/:id:changed:narrowing']);
    // A parameterised binding replacing a literal one serves the literal's requests with less.
    const literal = next(catalog => { catalog.bindings.http!.push({ id: 'special', method: 'GET', path: '/archive/special', allOf: ['app.open', 'material.create'] }); });
    const general = next(catalog => { catalog.bindings.http!.push({ id: 'any', method: 'GET', path: '/archive/:item', allOf: ['app.open'] }); });
    expect(effects(diffAuthorizationCatalogs(literal, general))).toEqual(['binding:GET /archive/:item:changed:widening']);
    // The reverse only binds one of those requests, and with more: it narrows.
    expect(effects(diffAuthorizationCatalogs(general, literal))).toEqual(['binding:GET /archive/special:changed:narrowing']);
    // Same path, different method: an unrelated operation.
    const method = next(catalog => { catalog.bindings.http!.push({ id: 'put-record', method: 'PUT', path: '/records/:id', allOf: ['app.open', 'study.read'] }); });
    expect(diffAuthorizationCatalogs(BASE, method).classification).toBe('non-widening');
  });

  it('includes mount-stripped candidate paths when deciding which requests two bindings share', () => {
    const before = next(catalog => { catalog.bindings.http!.push({ id: 'full', method: 'GET', path: '/api/education/export', allOf: ['app.open', 'material.create'] }); });
    const after = next(catalog => { catalog.bindings.http!.push({ id: 'relative', method: 'GET', path: '/export', allOf: ['app.open'] }); });
    expect(diffAuthorizationCatalogs(before, after, { mountPaths: ['/api/education'] }).classification).toBe('widening');
    expect(diffAuthorizationCatalogs(before, after, { mountPaths: ['/api/other'] }).classification).toBe('non-widening');
    const root = next(catalog => { catalog.bindings.http!.push({ id: 'root', method: 'GET', path: '/', allOf: ['app.open'] }); });
    const mountPage = next(catalog => { catalog.bindings.http!.push({ id: 'mount', method: 'GET', path: '/api/education', allOf: ['app.open', 'material.create'] }); });
    expect(diffAuthorizationCatalogs(mountPage, root, { mountPaths: ['/api/education'] }).classification).toBe('widening');
  });

  it('classifies named bindings by exact id and permissions the previous catalog defined', () => {
    const tutor = (allOf: string[]) => next(catalog => { catalog.bindings.artifactActions![0].allOf = allOf; });
    expect(effects(diffAuthorizationCatalogs(BASE, tutor(['app.open'])))).toEqual(['binding:tutor:changed:widening']);
    expect(effects(diffAuthorizationCatalogs(BASE, tutor(['app.open', 'tutor.execute', 'study.read'])))).toEqual(['binding:tutor:changed:narrowing']);
    const bot = next(catalog => { catalog.bindings.bots!.push({ id: 'ed000000-0000-0000-0000-000000000003', allOf: ['app.open', 'material.create'] }); });
    expect(effects(diffAuthorizationCatalogs(BASE, bot))).toEqual(['binding:ed000000-0000-0000-0000-000000000003:added:additive']);
  });

  it('treats adding or dropping the whole catalog as breaking', () => {
    expect(diffAuthorizationCatalogs(null, null).classification).toBe('unchanged');
    expect(diffAuthorizationCatalogs(null, BASE).classification).toBe('breaking');
    expect(diffAuthorizationCatalogs(BASE, null).classification).toBe('breaking');
  });
});
