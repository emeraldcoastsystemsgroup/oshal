/**
 * Experience shell lock — ADR-164 amendment (2026-10-02): the plain operator cockpit and the
 * experience entry pages are the OPERATOR's experiences. On a deployment whose landing names a
 * focused application (LANDING_PATH / HOST_APP_MAP → `/cockpit/?app=<name>`), a signed-in person
 * who is not an operator is sent to that landing when they ask for an operator surface, instead
 * of a rail of operator tools that answer 403 and a menu of experiences the deployment never
 * chose. A deployment without a focused landing is the generic swarm product and is unchanged.
 *
 * Pure decisions only; the route guard and the ribbon consult them.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Focused-landing shell lock: the pure redirect decision for operator surfaces and the landing-app parser the profile response carries to the ribbon.
 */

/** The same selector rule host-app-map applies to a requested application name. */
const APP_NAME = /^[a-z0-9][a-z0-9_-]{0,99}$/;

/**
 * Operator surfaces: the plain cockpit document and every experience entry page the cockpit
 * header links to. Asset paths under `/cockpit/` and `/experience/` are not surfaces and are not
 * guarded; a focused `/cockpit/?app=<name>` request is the application's own business.
 */
export const OPERATOR_SURFACES: readonly string[] = [
  '/cockpit', '/cockpit/', '/cockpit/index.html',
  '/experience', '/experience/', '/portal', '/portal/',
  '/homebase', '/homebase/', '/nexus', '/nexus/', '/studio', '/studio/', '/jarvis', '/jarvis/',
  '/orbit', '/orbit/', '/commons', '/commons/', '/simple', '/simple/',
  '/little-monsters', '/little-monsters/',
];

export interface ShellLockInput {
  /** Operator status from the swarm_roles snapshot or the break-glass allowlist. */
  operator: boolean;
  /** The deployment's resolved landing path for this request (host map, then LANDING_PATH). */
  landingPath: string;
  /** The requested pathname, without query. */
  pathname: string;
  /** `?app=` (or the legacy `?profile=`) on the request, when present. */
  requestedApp?: unknown;
}

/**
 * @description The application a landing path focuses on, or null for the generic cockpit.
 * @param landingPath - A landing path such as `/cockpit/?app=intelligent-sales`.
 * @returns The validated application name, or null when the landing is not a focused app.
 */
export function focusedLandingApp(landingPath: string): string | null {
  const query = String(landingPath ?? '').split('?')[1];
  if (!query) return null;
  const app = new URLSearchParams(query.split('#')[0]).get('app');
  return app && APP_NAME.test(app) ? app : null;
}

/**
 * @description Where a request for an operator surface should go instead, or null to serve it.
 * Operators are never redirected; neither is anyone on a deployment without a focused landing, nor
 * a request that already names an application.
 * @param input - The caller, the deployment's landing and the request.
 * @returns The landing path to redirect to, or null.
 */
export function shellRedirectFor(input: ShellLockInput): string | null {
  if (input.operator) return null;
  if (!focusedLandingApp(input.landingPath)) return null;
  if (!OPERATOR_SURFACES.includes(input.pathname)) return null;
  if (typeof input.requestedApp === 'string' && APP_NAME.test(input.requestedApp)) return null;
  return input.landingPath;
}
