/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Move the existing pure operation-binding resolver to the shared contract, preserving its exact ambiguity and canonical-path behavior.
 */
import type { AuthorizationCatalog, AuthorizationOperation } from './types';
/**
 * @description Resolve one unambiguous named operation using the existing catalog binding rules.
 * @param app Catalog and registered mount paths.
 * @param input Current operation identity and canonical path.
 * @returns Exact permission IDs, an empty list for a catalog-less application, or null for an unbound or ambiguous operation.
 */
export function resolveOperationPermissions<T extends { catalog?: AuthorizationCatalog | null; mountPaths?: string[] }>(app: T, input: AuthorizationOperation): string[] | null {
  if (!app.catalog) return [];
  if (input.permission) return Object.prototype.hasOwnProperty.call(app.catalog.permissions, input.permission) ? [input.permission] : null;
  const kind = input.kind ?? 'http'; const bindings = app.catalog.bindings[kind] ?? [];
  if (kind !== 'http') return bindings.find(binding => binding.id === input.operation)?.allOf ?? null;
  const pathname = input.path;
  if (!pathname || pathname.includes('?') || pathname.includes('#') || /[%\\]/.test(pathname) || pathname.includes('//')) return null;
  const paths = [pathname, ...(app.mountPaths ?? []).filter(mount => pathname.startsWith(`${mount}/`) || pathname === mount).map(mount => pathname.slice(mount.length) || '/')];
  const method = (input.method ?? '').toUpperCase();
  const matches = bindings.filter(binding => binding.method === method && paths.some(candidate => {
    const expected = binding.path!.split('/'); const actual = candidate.split('/');
    return actual.length === expected.length && expected.every((part, i) => part === actual[i] || (part.startsWith(':') && Boolean(actual[i]) && actual[i] !== '.' && actual[i] !== '..'));
  }));
  return matches.length === 1 ? matches[0].allOf : null;
}
