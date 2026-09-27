/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | AUTH-07 pure catalog diff classifier. Two validated catalogs in, a classified change list out: an installation may carry existing assignments onto the next catalog revision only when no existing grant's meaning changed; anything that widens or breaks a grant is returned for review.
 */
/**
 * The rule this module enforces is that an existing assignment keeps its meaning:
 * - every operation the previous catalog bound must still require at least the permissions it
 *   required, or become unbound;
 * - an operation the previous catalog did not bind may be bound only to permissions the previous
 *   catalog already defined (that is how a release adds a route without an operator present);
 * - resources may be added; permissions and roles may not be added, removed or changed, and a
 *   resource's scopes and field sets may not change, without review.
 * HTTP operations are compared by the requests they can match, not by binding id, using the same
 * segment grammar as the runtime matcher and every candidate path a package mount can produce, so
 * renaming or re-pathing a binding cannot lower what an existing request requires unnoticed.
 */
import type {
  AuthorizationBindingKind, AuthorizationCatalog, AuthorizationCatalogChange, AuthorizationCatalogChangeEffect,
  AuthorizationCatalogDiff, AuthorizationTier,
} from '@/shared/application-authorization';
import { canonical } from './policy';

type Catalog = AuthorizationCatalog;
type Resource = Catalog['resources'][string];
type Permission = Catalog['permissions'][string];
type Role = Catalog['roles'][string];
interface HttpRoute { id: string; method: string; parts: string[]; allOf: string[] }
const TIERS: AuthorizationTier[] = ['deny', 'viewer', 'editor', 'admin'];
const NAMED_KINDS: AuthorizationBindingKind[] = ['tools', 'bots', 'jobs', 'artifactActions'];
const has = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every(item => b.includes(item));
const covers = (next: readonly string[], previous: readonly string[]): boolean => previous.every(item => next.includes(item));

/**
 * @description Classify the difference between the catalog existing assignments were granted
 * under and the catalog an installation is activating.
 * @param previous - Catalog the assignments are stamped with; null for a catalog-less (app-admin) package.
 * @param next - Catalog being installed; null for a catalog-less package.
 * @param options - Package mount paths (previous and next); they decide which request paths the
 * runtime matcher compares with each binding.
 * @returns Every difference with its effect, and the overall classification.
 */
export function diffAuthorizationCatalogs(previous: Catalog | null, next: Catalog | null,
  options: { mountPaths?: readonly string[] } = {}): AuthorizationCatalogDiff {
  const changes: AuthorizationCatalogChange[] = [];
  if (!previous || !next) {
    if (previous || next) changes.push({ area: 'catalog', id: 'catalog', change: previous ? 'removed' : 'added', effect: 'breaking',
      detail: previous ? 'The package no longer declares a permission catalog, so every named-role grant loses its meaning.'
        : 'The package now declares a permission catalog, so fallback app-admin grants lose their meaning.' });
    return summarize(changes);
  }
  diffRecords('resource', previous.resources, next.resources, resourceEffect, 'additive', changes);
  diffRecords('permission', previous.permissions, next.permissions, permissionEffect, 'widening', changes);
  diffRecords('role', previous.roles, next.roles, roleEffect, 'widening', changes);
  diffHttpBindings(previous, next, stripDeltas(options.mountPaths ?? []), changes);
  for (const kind of NAMED_KINDS) diffNamedBindings(kind, previous, next, changes);
  return summarize(changes);
}

/** @description Overall classification: any breaking change wins, then any widening one. */
function summarize(changes: AuthorizationCatalogChange[]): AuthorizationCatalogDiff {
  const classification = changes.some(item => item.effect === 'breaking') ? 'breaking'
    : changes.some(item => item.effect === 'widening') ? 'widening' : changes.length ? 'non-widening' : 'unchanged';
  return { classification, changes };
}

/** @description Added, removed and changed named declarations of one catalog section. */
function diffRecords<T>(area: 'resource' | 'permission' | 'role', before: Record<string, T>, after: Record<string, T>,
  changed: (previous: T, next: T) => AuthorizationCatalogChangeEffect | null, added: AuthorizationCatalogChangeEffect,
  out: AuthorizationCatalogChange[]): void {
  for (const id of Object.keys(before).sort()) {
    if (!has(after, id)) {
      out.push({ area, id, change: 'removed', effect: 'breaking', detail: `The ${area} ${id} was removed; grants that relied on it need a reviewed mapping.` });
      continue;
    }
    const effect = changed(before[id], after[id]);
    if (effect) out.push({ area, id, change: 'changed', effect, detail: effect === 'widening'
      ? `The ${area} ${id} changed so an existing grant can do more.` : `The ${area} ${id} changed so an existing grant loses part of its meaning.` });
  }
  for (const id of Object.keys(after).sort()) {
    if (!has(before, id)) out.push({ area, id, change: 'added', effect: added, detail: added === 'additive'
      ? `The ${area} ${id} is new and no existing grant reaches it.` : `The ${area} ${id} is new; a reviewer confirms what it grants before existing assignments carry over.` });
  }
}

/** @description A resource may only change under review: gaining scope or fields widens, losing them breaks. */
function resourceEffect(before: Resource, after: Resource): AuthorizationCatalogChangeEffect | null {
  const fields = (resource: Resource) => Object.fromEntries(Object.entries(resource.fieldSets ?? {}).map(([name, list]) => [name, [...list].sort()]));
  if (canonical([[...before.scopes].sort(), fields(before)]) === canonical([[...after.scopes].sort(), fields(after)])) return null;
  const kept = covers(after.scopes, before.scopes) && Object.entries(before.fieldSets ?? {})
    .every(([name, list]) => Boolean(after.fieldSets && has(after.fieldSets, name) && covers(after.fieldSets[name], list)));
  return kept ? 'widening' : 'breaking';
}

/** @description A lower tier floor or a different effect widens; a moved resource or a higher floor breaks. */
function permissionEffect(before: Permission, after: Permission): AuthorizationCatalogChangeEffect | null {
  if (canonical(before) === canonical(after)) return null;
  if (before.resource !== after.resource) return 'breaking';
  if (before.effect !== after.effect || TIERS.indexOf(after.minimumTier) < TIERS.indexOf(before.minimumTier)) return 'widening';
  return 'breaking';
}

/** @description A role that gains a grant, a tier or loses its sensitivity widens; any other change breaks. */
function roleEffect(before: Role, after: Role): AuthorizationCatalogChangeEffect | null {
  const grants = (role: Role) => role.grants.map(grant => canonical({ permission: grant.permission, scope: grant.scope, fields: grant.fields ?? null })).sort();
  if (before.tier === after.tier && Boolean(before.sensitive) === Boolean(after.sensitive) && sameSet(grants(before), grants(after))) return null;
  const gained = !covers(grants(before), grants(after)) || TIERS.indexOf(after.tier) > TIERS.indexOf(before.tier)
    || (Boolean(before.sensitive) && !after.sensitive);
  return gained ? 'widening' : 'breaking';
}

/** @description Named (non-HTTP) bindings resolve by exact id, so compare them id by id. */
function diffNamedBindings(kind: AuthorizationBindingKind, previous: Catalog, next: Catalog, out: AuthorizationCatalogChange[]): void {
  const before = new Map((previous.bindings[kind] ?? []).map(binding => [binding.id, binding.allOf]));
  const after = new Map((next.bindings[kind] ?? []).map(binding => [binding.id, binding.allOf]));
  for (const [id, allOf] of before) {
    const current = after.get(id);
    if (!current) out.push({ area: 'binding', kind, id, change: 'removed', effect: 'narrowing', detail: `The ${kind} operation ${id} is no longer bound and is refused.` });
    else if (!sameSet(allOf, current)) out.push(requirementChange(kind, id, allOf, current));
  }
  for (const [id, allOf] of after) if (!before.has(id)) out.push(addedBinding(kind, id, allOf, previous));
}

/** @description An operation that keeps every permission it required narrows; one that drops any widens. */
function requirementChange(kind: AuthorizationBindingKind, id: string, before: string[], after: string[]): AuthorizationCatalogChange {
  const kept = covers(after, before);
  return { area: 'binding', kind, id, change: 'changed', effect: kept ? 'narrowing' : 'widening',
    detail: kept ? `${id} now requires ${after.join(' + ')} (previously ${before.join(' + ')}).`
      : `${id} no longer requires ${before.filter(item => !after.includes(item)).join(', ')}.` };
}

/** @description A new operation is additive only when every permission it requires already existed. */
function addedBinding(kind: AuthorizationBindingKind, id: string, allOf: string[], previous: Catalog): AuthorizationCatalogChange {
  const unknown = allOf.filter(permission => !has(previous.permissions, permission));
  return { area: 'binding', kind, id, change: 'added', effect: unknown.length ? 'widening' : 'additive',
    detail: unknown.length ? `${id} requires ${unknown.join(', ')}, which the previous catalog did not define.`
      : `${id} is a new operation bound to existing permissions ${allOf.join(' + ')}.` };
}

/**
 * @description HTTP bindings compared by the requests they can share, never by id. A request
 * reachable before this release was matched by exactly one previous binding. If a next binding has
 * the same shape as a previous one, every request it matches was matched by that one, so only that
 * pair decides. Otherwise it is compared with every previous binding it can share a request with,
 * except one whose shape survives in the next catalog: that twin keeps matching the request, so the
 * request stays ambiguous and refused rather than reachable with fewer permissions.
 */
function diffHttpBindings(previous: Catalog, next: Catalog, deltas: string[][], out: AuthorizationCatalogChange[]): void {
  const before = httpRoutes(previous); const after = httpRoutes(next);
  const twin = (routes: HttpRoute[], route: HttpRoute) => routes.find(item => item.method === route.method && shape(item.parts) === shape(route.parts));
  const compared = new Set<HttpRoute>();
  for (const route of after) {
    const same = twin(before, route);
    if (same) {
      compared.add(same);
      if (!sameSet(same.allOf, route.allOf)) out.push(pairChange(same, route));
      continue;
    }
    const related = before.filter(old => old.method === route.method && !twin(after, old) && mayShareRequest(old.parts, route.parts, deltas));
    if (!related.length) out.push(addedBinding('http', label(route), route.allOf, previous));
    for (const old of related) { compared.add(old); out.push(pairChange(old, route)); }
  }
  for (const old of before.filter(item => !compared.has(item))) {
    out.push({ area: 'binding', kind: 'http', id: label(old), change: 'removed', effect: 'narrowing', detail: `${label(old)} is no longer bound and is refused.` });
  }
}

/** @description One previous/next HTTP binding pair that can serve the same request. */
function pairChange(old: HttpRoute, route: HttpRoute): AuthorizationCatalogChange {
  const kept = covers(route.allOf, old.allOf);
  return { area: 'binding', kind: 'http', id: label(route), change: 'changed', effect: kept ? 'narrowing' : 'widening',
    detail: kept ? `${label(route)} requires at least what ${label(old)} required for the requests they share.`
      : `${label(route)} can serve requests ${label(old)} served, without ${old.allOf.filter(item => !route.allOf.includes(item)).join(', ')}.` };
}

function httpRoutes(catalog: Catalog): HttpRoute[] {
  return (catalog.bindings.http ?? []).map(binding => ({ id: binding.id, method: String(binding.method).toUpperCase(),
    parts: String(binding.path).split('/'), allOf: binding.allOf }));
}
const label = (route: HttpRoute): string => `${route.method} ${route.parts.join('/') || '/'}`;
const shape = (parts: string[]): string => parts.map(part => part.startsWith(':') ? ':' : part).join('/');
const isParam = (part: string): boolean => part.startsWith(':');
/** Two pattern segments can match one request segment. */
const segmentsOverlap = (a: string[], b: string[]): boolean => a.length === b.length && a.every((part, i) => part === b[i] || isParam(part) || isParam(b[i]));

/**
 * @description Whether some request can be matched by both patterns under any candidate path pair
 * the runtime compares: the path itself, or the path with one package mount prefix stripped (and
 * a mount path itself resolving to `/`).
 */
function mayShareRequest(a: string[], b: string[], deltas: string[][]): boolean {
  if (segmentsOverlap(a, b)) return true;
  return deltas.some(delta => crossOverlap(a, b, delta) || crossOverlap(b, a, delta));
}

/** @description `long` matches a candidate that equals `delta` + a request `short` matches. */
function crossOverlap(long: string[], short: string[], delta: string[]): boolean {
  const root = short.length === 2 && short[1] === '';
  if (root) return segmentsOverlap(long, delta);
  if (long.length !== delta.length + short.length - 1) return false;
  return segmentsOverlap(long.slice(0, delta.length), delta) && segmentsOverlap(long.slice(delta.length), short.slice(1));
}

/**
 * @description Every prefix difference between two candidate paths: each mount, and each part of a
 * longer mount beyond a shorter mount it extends. Returned as leading-empty segment arrays.
 */
function stripDeltas(mountPaths: readonly string[]): string[][] {
  const mounts = [...new Set(mountPaths.map(mount => mount.replace(/\/+$/, '')).filter(mount => mount.startsWith('/') && mount.length > 1))];
  const deltas = new Set(mounts);
  for (const shorter of mounts) for (const longer of mounts) if (longer.startsWith(`${shorter}/`)) deltas.add(longer.slice(shorter.length));
  return [...deltas].map(delta => delta.split('/'));
}
