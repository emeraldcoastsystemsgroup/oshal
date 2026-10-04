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
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Decide on the CANONICAL path, not the raw one. Express 5 routes and express.static match case-insensitively, and the static mount decodes the path and collapses dot segments, so /Cockpit/, /cockpit/js/../index.html, /cockpit// and /%63ockpit/ served the operator document to a non-operator while the exact-string list never matched. canonicalSurfacePath decodes (a malformed escape under a surface root is decided as a surface), collapses doubled slashes and dot segments, strips a trailing index.html and lowercases; operatorSurfaceKind covers /experience/*.html too (index, nexus, simple and the legacy pages). Only the cockpit document keeps the focused ?app= exemption: /portal, /nexus, /simple and the experience pages are not an application's shell, so ?app= no longer lets a non-operator through to them.
 */

import path from 'path';

/** The same selector rule host-app-map applies to a requested application name. */
const APP_NAME = /^[a-z0-9][a-z0-9_-]{0,99}$/;

/**
 * Operator surfaces: the plain cockpit document and every experience entry page the cockpit
 * header links to, in canonical form plus the trailing-slash and index.html spellings. The guard
 * decides on {@link operatorSurfaceKind}, which canonicalises a request path before it compares;
 * this list is the source of the surface roots. Asset paths under `/cockpit/` and `/experience/`
 * are not surfaces; a focused `/cockpit/?app=<name>` request is the application's own business.
 */
export const OPERATOR_SURFACES: readonly string[] = [
  '/cockpit', '/cockpit/', '/cockpit/index.html',
  '/experience', '/experience/', '/portal', '/portal/',
  '/homebase', '/homebase/', '/nexus', '/nexus/', '/studio', '/studio/', '/jarvis', '/jarvis/',
  '/orbit', '/orbit/', '/commons', '/commons/', '/simple', '/simple/',
  '/little-monsters', '/little-monsters/',
];

/** First path segments that name an operator surface, derived from the list above. */
const SURFACE_ROOTS: ReadonlySet<string> = new Set(OPERATOR_SURFACES.map((surface) => surface.split('/')[1]));

/** What an operator surface is: the cockpit document (an application may focus it) or an experience page. */
export type OperatorSurfaceKind = 'cockpit' | 'experience';

export interface ShellLockInput {
  /** Operator status from the swarm_roles snapshot or the break-glass allowlist. */
  operator: boolean;
  /** The deployment's resolved landing path for this request (host map, then LANDING_PATH). */
  landingPath: string;
  /** The requested pathname, without query, exactly as the request carried it (not yet decoded). */
  pathname: string;
  /** `?app=` (or the legacy `?profile=`) on the request, when present. */
  requestedApp?: unknown;
}

/**
 * @description Collapse a path the way the static mount resolves it: backslashes read as slashes,
 * doubled slashes and dot segments collapsed, a trailing index.html and trailing slashes dropped,
 * lowercased (Express routing is case-insensitive).
 * @param decoded - A percent-decoded path (or a raw one whose encoding could not be decoded).
 * @returns The canonical path; `/` for the root.
 */
function collapse(decoded: string): string {
  let canonical = path.posix.normalize(`/${decoded}`.replace(/\\/g, '/')).toLowerCase().replace(/\/+$/, '');
  if (canonical.endsWith('/index.html')) canonical = canonical.slice(0, -'/index.html'.length);
  return canonical.replace(/\/+$/, '') || '/';
}

/**
 * @description The canonical form of a request path for the surface decision: what the document
 * routes and express.static would actually serve for it. `/COCKPIT//index.html`,
 * `/cockpit/js/../index.html` and `/%63ockpit/` all become `/cockpit`.
 * @param pathname - The raw request path (Express `req.path`, which is not decoded).
 * @returns The canonical path, or null when its percent-encoding is malformed.
 */
export function canonicalSurfacePath(pathname: string): string | null {
  try {
    return collapse(decodeURIComponent(String(pathname ?? '')));
  } catch {
    return null;
  }
}

/**
 * @description Whether a request path is an operator surface, and which kind. The cockpit
 * document is the only kind an application selector may focus; every experience entry page,
 * including any `/experience/*.html`, is an experience surface. A path whose encoding is malformed
 * is decided by its raw first segment, so a broken escape under a surface root is still a surface.
 * @param pathname - The raw request path.
 * @returns 'cockpit', 'experience', or null when the path is not a surface (assets, APIs, others).
 */
export function operatorSurfaceKind(pathname: string): OperatorSurfaceKind | null {
  const canonical = canonicalSurfacePath(pathname);
  if (canonical === null) return SURFACE_ROOTS.has(collapse(String(pathname ?? '')).split('/')[1]) ? 'experience' : null;
  if (canonical === '/cockpit') return 'cockpit';
  const root = canonical.split('/')[1];
  if (canonical === `/${root}` && SURFACE_ROOTS.has(root)) return 'experience';
  return root === 'experience' && canonical.endsWith('.html') ? 'experience' : null;
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
 * a request for the cockpit document that already names an application (the profile route then
 * decides what that application shows this caller, and refuses a name it cannot serve).
 * @param input - The caller, the deployment's landing and the request.
 * @returns The landing path to redirect to, or null.
 */
export function shellRedirectFor(input: ShellLockInput): string | null {
  if (input.operator) return null;
  if (!focusedLandingApp(input.landingPath)) return null;
  const kind = operatorSurfaceKind(input.pathname);
  if (!kind) return null;
  if (kind === 'cockpit' && typeof input.requestedApp === 'string' && APP_NAME.test(input.requestedApp)) return null;
  return input.landingPath;
}
