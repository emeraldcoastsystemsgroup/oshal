/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — per-host landing path for themed app subdomains (dnd.oshal.ai, trading.oshal.ai, ...)
 */

/**
 * @description Resolves the landing path for a themed app subdomain (e.g. dnd.oshal.ai lands
 * directly on the D&D app instead of the generic ribbon). Mirrors the OIDC_BASE_URLS per-host
 * pattern in src/shared/middleware/oidc.ts: HOST_APP_MAP is a comma-separated
 * `hostname=appName` list matched against the request's hostname. Unset, or a hostname with no
 * entry, falls through to the caller-supplied fallback (LANDING_PATH / the default ribbon) —
 * existing single-host deployments are unaffected.
 * @param hostAppMap - raw HOST_APP_MAP env value, e.g. "dnd.oshal.ai=dnd,trading.oshal.ai=intelligent-trades"
 * @param hostname - the incoming request's hostname (Express `req.hostname`)
 * @param fallback - the path to use when HOST_APP_MAP is unset or has no match for this hostname
 * @returns the resolved landing path
 */
export function resolveHostLandingPath(
  hostAppMap: string | undefined,
  hostname: string | undefined,
  fallback: string,
): string {
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
