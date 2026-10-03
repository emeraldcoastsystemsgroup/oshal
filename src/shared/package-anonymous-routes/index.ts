/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Validate exact opt-in anonymous reads without widening a public mount or manufacturing a principal.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Reject ambiguous same-mount anonymous owners without bypassing intervening private guards.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Add key-order-agnostic sameAnonymousPackageRoutes equality helper.
 */

/** A mount-relative, explicitly named read operation; GET does not imply HEAD. */
export interface AnonymousPackageRoute { method: 'GET' | 'HEAD'; path: string }
/** Immutable routing identity used to keep an opt-in bound to its own mounted module. */
export interface AnonymousPackageMount {
  module: string; factory: string; mountPath: string; anonymousRoutes: AnonymousPackageRoute[];
}
interface ManifestShape {
  authorization?: unknown; uses?: readonly string[];
  routes?: readonly { module: string; factory: string; mountPath: string; auth?: string;
    requiresAuth?: boolean; callbackVerifier?: string; anonymousRoutes?: unknown }[];
}

const LITERAL = /^[A-Za-z0-9_-][A-Za-z0-9._~-]*$/;
const PARAMETER = /^:[A-Za-z][A-Za-z0-9_]*$/;

function canonicalSegments(value: unknown): string[] | null {
  if (typeof value !== 'string' || value.length > 256 || !value.startsWith('/')) return null;
  const segments = value.slice(1).split('/');
  return segments.every(segment => LITERAL.test(segment) || PARAMETER.test(segment)) ? segments : null;
}

function readRoute(value: unknown): AnonymousPackageRoute {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('anonymousRoutes entry must be an object');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !['method', 'path'].includes(key))
    || (row.method !== 'GET' && row.method !== 'HEAD')) throw new Error('anonymousRoutes requires only method GET/HEAD and path');
  const segments = canonicalSegments(row.path);
  const parameters = segments?.filter(segment => PARAMETER.test(segment));
  if (!segments || !segments.some(segment => LITERAL.test(segment))
    || new Set(parameters).size !== parameters?.length) {
    throw new Error('anonymousRoutes path must be an exact literal/named-segment route, not a root, wildcard or parameter-only path');
  }
  return { method: row.method, path: row.path as string };
}

/**
 * @description Refuse malformed declarations before activation; catalog and callback permissions never become anonymous.
 * @param manifest Parsed manifest, also revalidated by the runtime before taking its detached snapshot.
 * @returns Detached per-module opt-ins; missing declarations preserve the existing guard.
 */
export function readAnonymousPackageMounts(manifest: ManifestShape): AnonymousPackageMount[] {
  const mounts: AnonymousPackageMount[] = [];
  for (const route of manifest.routes ?? []) {
    if (route.anonymousRoutes === undefined) continue;
    const mount = canonicalSegments(route.mountPath);
    if (route.auth !== 'public' || route.requiresAuth === true || route.callbackVerifier !== undefined
      || manifest.authorization !== undefined || !manifest.uses?.includes('package-anonymous-routes')
      || !mount || mount.length < 2 || mount[0] !== 'api' || mount.some(segment => !LITERAL.test(segment))) {
      throw new Error('anonymousRoutes requires an explicit literal auth: public mount under /api, package-anonymous-routes capability, no catalog and no callbackVerifier');
    }
    if (!Array.isArray(route.anonymousRoutes) || !route.anonymousRoutes.length || route.anonymousRoutes.length > 32) {
      throw new Error('anonymousRoutes must be a non-empty array with at most 32 named reads');
    }
    if (mounts.some(existing => existing.mountPath === route.mountPath)) {
      throw new Error('anonymousRoutes supports only one declaring module/factory per mount; combine reads in that handler or use distinct mounts');
    }
    const declarations = route.anonymousRoutes.map(readRoute);
    if (new Set(declarations.map(row => row.method + ' ' + row.path)).size !== declarations.length) {
      throw new Error('anonymousRoutes contains duplicate method/path declarations');
    }
    mounts.push({ module: route.module, factory: route.factory, mountPath: route.mountPath, anonymousRoutes: declarations });
  }
  return mounts;
}

/**
 * @description Match the raw canonical pathname segment-by-segment, without regex paths, decoding or prefix widening.
 * @param mount Validated declaration for this exact factory.
 * @param method Actual HTTP verb; no implied HEAD or OPTIONS.
 * @param pathname Raw request path with no query string.
 * @returns True only for an explicitly declared method and complete path.
 */
export function matchesAnonymousPackageRoute(mount: AnonymousPackageMount, method: string, pathname: string): boolean {
  if (!pathname.startsWith(mount.mountPath + '/')) return false;
  const actual = pathname.slice(mount.mountPath.length + 1).split('/');
  return mount.anonymousRoutes.some(route => {
    const expected = route.path.slice(1).split('/');
    return route.method === method && expected.length === actual.length
      && expected.every((segment, index) => PARAMETER.test(segment) ? LITERAL.test(actual[index]) : segment === actual[index]);
  });
}

/**
 * @description Compare declared anonymous route sets item-by-item without key-order sensitivity.
 */
export function sameAnonymousPackageRoutes(
  a?: readonly AnonymousPackageRoute[] | null,
  b?: readonly AnonymousPackageRoute[] | null,
): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((route, index) => route.method === b[index]?.method && route.path === b[index]?.path);
}
