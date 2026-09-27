/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | AUTH-07 fixture catalogs shaped like Little Monsters 1.4.3 (store fcad9f4) and its 1.4.4 revision (store f149395): the same resources, permission names, sensitive teacher role, bot/artifact-action bindings and the exact 1.4.4 addition (POST /import-artifact and the class-material artifact action over existing permissions), reduced to what the catalog migration reads.
 */
import { validateAuthorizationCatalog, type AuthorizationAppRegistration, type AuthorizationCatalog } from '@/shared/application-authorization';

export const CLASSROOM_APP = 'little-monsters';
export const CLASSROOM_SOURCE = 'store:little-monsters';
export const CLASSROOM_MOUNTS = ['/api/education', '/api/little-monsters/review', '/api/little-monsters/home-summary'];

/** Little Monsters 1.4.3 shape. */
export const CLASSROOM_143: AuthorizationCatalog = validateAuthorizationCatalog({
  version: 1,
  resources: { learner: { scopes: ['own'] }, teaching: { scopes: ['own'] } },
  permissions: {
    'app.open': { resource: 'learner', effect: 'read', minimumTier: 'viewer' },
    'study.read': { resource: 'learner', effect: 'read', minimumTier: 'viewer' },
    'material.create': { resource: 'learner', effect: 'write', minimumTier: 'editor' },
    'material.share': { resource: 'learner', effect: 'write', minimumTier: 'editor' },
    'tutor.execute': { resource: 'learner', effect: 'execute', minimumTier: 'editor' },
    'class.change': { resource: 'teaching', effect: 'write', minimumTier: 'editor' },
  },
  roles: {
    student: { tier: 'editor', grants: [{ permission: 'app.open', scope: 'own' }, { permission: 'study.read', scope: 'own' }, { permission: 'tutor.execute', scope: 'own' }] },
    teacher: { tier: 'editor', sensitive: true, grants: [{ permission: 'app.open', scope: 'own' }, { permission: 'material.create', scope: 'own' },
      { permission: 'material.share', scope: 'own' }, { permission: 'class.change', scope: 'own' }] },
    reviewer: { tier: 'viewer', grants: [{ permission: 'app.open', scope: 'own' }, { permission: 'study.read', scope: 'own' }] },
  },
  bindings: {
    http: [
      { id: 'get-study', method: 'GET', path: '/study', allOf: ['app.open', 'study.read'] },
      { id: 'get-record', method: 'GET', path: '/records/:id', allOf: ['app.open', 'study.read'] },
      { id: 'post-materials', method: 'POST', path: '/materials', allOf: ['app.open', 'material.create'] },
    ],
    bots: [{ id: 'ed000000-0000-0000-0000-000000000002', allOf: ['app.open', 'tutor.execute'] }],
    artifactActions: [{ id: 'tutor', allOf: ['app.open', 'tutor.execute'] }],
  },
});

/**
 * @description A validated copy of a catalog with one edit applied.
 * @param edit Mutation applied to the copy. @param base Catalog to copy (default 1.4.3).
 * @returns The edited, validated catalog.
 */
export function editedCatalog(edit: (catalog: AuthorizationCatalog) => void, base: AuthorizationCatalog = CLASSROOM_143): AuthorizationCatalog {
  const catalog = structuredClone(base); edit(catalog); return validateAuthorizationCatalog(catalog);
}

/** Little Monsters 1.4.4 shape: the File into a class hand-off over permissions 1.4.3 already defines. */
export const CLASSROOM_144: AuthorizationCatalog = editedCatalog(catalog => {
  catalog.bindings.http!.push({ id: 'post-import-artifact', method: 'POST', path: '/import-artifact', allOf: ['app.open', 'material.create', 'material.share'] });
  catalog.bindings.artifactActions!.push({ id: 'class-material', allOf: ['app.open', 'material.create', 'material.share'] });
});

/**
 * @description An installer-shaped registration for the fixture package.
 * @param catalog Catalog to register. @param version Package version. @param source Installation source.
 * @returns The registration, with allow-all fixture adapters for both resources.
 */
export function classroomRegistration(catalog: AuthorizationCatalog, version: string, source = CLASSROOM_SOURCE): AuthorizationAppRegistration {
  const allow = { authorize: async () => true };
  return { app: CLASSROOM_APP, source, version, catalog, mode: 'enforce', mountPaths: [...CLASSROOM_MOUNTS], adapters: { learner: allow, teaching: allow } };
}
