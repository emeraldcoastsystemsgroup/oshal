/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — per-host landing path for themed app subdomains (dnd.oshal.ai, trading.oshal.ai, ...)
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Preserve an explicit application entry through the root redirect.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Resolve deployment landings from the ingress Host rather than caller-supplied forwarded-host values, preserving numeric ports and case normalization.
 */

import type { Request } from 'express';

/**
 * @description Resolve a deployment landing from the ingress Host. The configured tunnel preserves
 * Host; its caller-supplied X-Forwarded-Host is not admission authority. Keep forwarded protocol/IP
 * trust unchanged and apply the existing Host normalization used by enrollment routes.
 * @param hostAppMap - Raw HOST_APP_MAP configuration.
 * @param req - Request carrying the actual Host header.
 * @param fallback - Landing when that Host is not mapped.
 * @param requestedApp - Optional bounded explicit root application selector.
 * @returns The same map/selector decision used by root, shell/profile and guest entry.
 */
export function resolveRequestLandingPath(
  hostAppMap: string | undefined,
  req: Pick<Request, 'get'>,
  fallback: string,
  requestedApp?: unknown,
): string {
  const hostname = (req.get('host') || '').replace(/:\d+$/, '').toLowerCase();
  return resolveHostLandingPath(hostAppMap, hostname, fallback, requestedApp);
}

/**
 * @description Resolves the landing path for a themed app subdomain (e.g. dnd.oshal.ai lands
 * directly on the D&D app instead of the generic ribbon). Mirrors the OIDC_BASE_URLS per-host
 * pattern in src/shared/middleware/oidc.ts: HOST_APP_MAP is a comma-separated
 * `hostname=appName` list matched against the request's hostname. Unset, or a hostname with no
 * entry, falls through to the caller-supplied fallback (LANDING_PATH / the default ribbon) —
 * existing single-host deployments are unaffected.
 * @param hostAppMap - raw HOST_APP_MAP env value, e.g. "dnd.oshal.ai=dnd,trading.oshal.ai=intelligent-trades"
 * @param hostname - The canonical hostname; the request adapter derives it from ingress Host.
 * @param fallback - the path to use when HOST_APP_MAP is unset or has no match for this hostname
 * @param requestedApp - an optional parsed query selector; only one bounded application slug is accepted
 * @returns the resolved landing path
 */
export function resolveHostLandingPath(
  hostAppMap: string | undefined,
  hostname: string | undefined,
  fallback: string,
  requestedApp?: unknown,
): string {
  if (typeof requestedApp === 'string' && /^[a-z0-9][a-z0-9_-]{0,99}$/.test(requestedApp)) {
    return `/cockpit/?app=${encodeURIComponent(requestedApp)}`;
  }
  if (!hostAppMap || !hostname) return fallback;
  for (const entry of hostAppMap.split(',')) {
    const [rawHost, rawApp] = entry.split('=');
    const host = rawHost?.trim();
    const appName = rawApp?.trim();
    if (host && appName && host.toLowerCase() === hostname.toLowerCase()) {
      return `/cockpit/?app=${encodeURIComponent(appName)}`;
    }
  }
  return fallback;
}
