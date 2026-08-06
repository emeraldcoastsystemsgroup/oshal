/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Declare exact Graph/Jarvis method-path scope metadata and canonical request-path validation for durable workload delegation.
 */

/** @description Scope permitting owner-bound graph reads. */
export const GRAPH_READ_SCOPE = 'graph:read';
/** @description Scope permitting owner-bound graph mutations. */
export const GRAPH_WRITE_SCOPE = 'graph:write';
/** @description Scope permitting owner-bound Jarvis reads. */
export const JARVIS_READ_SCOPE = 'jarvis:read';
/** @description Scope permitting owner-bound Jarvis actions. */
export const JARVIS_WRITE_SCOPE = 'jarvis:write';

/** @description One code-owned route template and its exact least-privilege scope. */
export interface WorkloadDelegationRoutePolicy {
  method: string;
  routeTemplate: string;
  requiredScopes: readonly string[];
}

interface CompiledRoutePolicy extends WorkloadDelegationRoutePolicy {
  pattern: RegExp;
}

const POLICIES: readonly CompiledRoutePolicy[] = Object.freeze([
  policy('POST', '/api/graph/query', /^\/api\/graph\/query$/, GRAPH_READ_SCOPE),
  policy('GET', '/api/graph/neighbors', /^\/api\/graph\/neighbors$/, GRAPH_READ_SCOPE),
  policy('GET', '/api/graph/path', /^\/api\/graph\/path$/, GRAPH_READ_SCOPE),
  policy('POST', '/api/graph/nodes', /^\/api\/graph\/nodes$/, GRAPH_WRITE_SCOPE),
  policy('POST', '/api/graph/edges', /^\/api\/graph\/edges$/, GRAPH_WRITE_SCOPE),
  policy('GET', '/api/jarvis/history', /^\/api\/jarvis\/history$/, JARVIS_READ_SCOPE),
  policy('GET', '/api/jarvis/tasks', /^\/api\/jarvis\/tasks$/, JARVIS_READ_SCOPE),
  policy('GET', '/api/jarvis/overview', /^\/api\/jarvis\/overview$/, JARVIS_READ_SCOPE),
  policy('GET', '/api/jarvis/ask/result', /^\/api\/jarvis\/ask\/result$/, JARVIS_READ_SCOPE),
  policy('GET', '/api/jarvis/ask/jobs', /^\/api\/jarvis\/ask\/jobs$/, JARVIS_READ_SCOPE),
  policy('GET', '/api/jarvis/visuals/:artifactId', /^\/api\/jarvis\/visuals\/[^/]{1,256}$/, JARVIS_READ_SCOPE),
  policy('POST', '/api/jarvis/tasks/:id/delivered', /^\/api\/jarvis\/tasks\/[^/]{1,256}\/delivered$/, JARVIS_WRITE_SCOPE),
  policy('POST', '/api/jarvis/ask', /^\/api\/jarvis\/ask$/, JARVIS_WRITE_SCOPE),
  policy('POST', '/api/jarvis/thread/close', /^\/api\/jarvis\/thread\/close$/, JARVIS_WRITE_SCOPE),
  policy('POST', '/api/jarvis/ask/dismiss', /^\/api\/jarvis\/ask\/dismiss$/, JARVIS_WRITE_SCOPE),
]);

/**
 * @description Resolves code-owned route metadata for one exact canonical request path.
 * Unlisted surface/catalog routes return null and remain on ordinary user authentication.
 * @param method - HTTP request method.
 * @param path - Canonical request pathname without query parameters.
 * @returns Matching route metadata or null when the route carries no delegated user authority.
 */
export function resolveWorkloadDelegationRoute(
  method: string,
  path: string,
): WorkloadDelegationRoutePolicy | null {
  const normalizedMethod = canonicalDelegationMethod(method);
  const normalizedPath = canonicalDelegationPath(path);
  const matched = POLICIES.find((entry) => entry.method === normalizedMethod
    && entry.pattern.test(normalizedPath));
  return matched
    ? { method: matched.method, routeTemplate: matched.routeTemplate, requiredScopes: [...matched.requiredScopes] }
    : null;
}

/**
 * @description Canonicalizes an HTTP method to the fixed token representation.
 * @param method - Candidate request method.
 * @returns Exact supported uppercase method.
 */
export function canonicalDelegationMethod(method: string): string {
  const normalized = typeof method === 'string' ? method.toUpperCase() : '';
  if (!/^(?:DELETE|GET|HEAD|OPTIONS|PATCH|POST|PUT)$/.test(normalized)) {
    throw new Error('Delegation request method is invalid');
  }
  return normalized;
}

/**
 * @description Validates one exact request pathname. Query strings are deliberately excluded from
 * route metadata; request bodies remain independently SHA-256 bound. Encoded slashes/backslashes,
 * dot segments, duplicate separators, controls, fragments, and ambiguous percent escapes fail.
 * @param path - Candidate pathname without an origin.
 * @returns Canonical pathname with uppercase percent escapes.
 */
export function canonicalDelegationPath(path: string): string {
  if (
    typeof path !== 'string'
    || path.length === 0
    || path.length > 2_048
    || path[0] !== '/'
    || /[\u0000-\u0020\u007F?#\\]/.test(path)
    || path.includes('//')
    || /%(?![A-Fa-f0-9]{2})/.test(path)
    || /%(?:2f|5c)/i.test(path)
    || hasDotSegment(path)
  ) {
    throw new Error('Delegation request path is invalid');
  }
  return path.replace(/%[A-Fa-f0-9]{2}/g, (escape) => escape.toUpperCase());
}

/**
 * @description Extracts and canonicalizes the pathname from an Express originalUrl value.
 * @param originalUrl - Request target containing an optional query string.
 * @returns Exact canonical pathname used by route metadata and token verification.
 */
export function delegationPathFromOriginalUrl(originalUrl: string): string {
  const queryIndex = originalUrl.indexOf('?');
  return canonicalDelegationPath(queryIndex < 0 ? originalUrl : originalUrl.slice(0, queryIndex));
}

function policy(
  method: string,
  routeTemplate: string,
  pattern: RegExp,
  requiredScope: string,
): CompiledRoutePolicy {
  return Object.freeze({ method, routeTemplate, pattern, requiredScopes: Object.freeze([requiredScope]) });
}

function hasDotSegment(path: string): boolean {
  return path.split('/').some((segment) => {
    const decoded = segment.replace(/%2e/ig, '.');
    return decoded === '.' || decoded === '..';
  });
}
