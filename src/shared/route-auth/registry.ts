/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 D2: the route auth-mode contract as DATA. Lives in shared/ (a leaf layer) so the mounter (@/app), the manifest loader (@/features/swarm-apps) and the security scanner (@/features/security) can all import it without violating FSD — and because src/shared/** is in tsconfig.server.json's `include`, so it is unconditionally built into dist, unlike src/features/** which only lands via the import graph (the D8 lesson).
 */

/**
 * @description How a package-contributed route is authenticated (ADR-085 D2).
 *
 * Auth in this codebase is **opt-in per route** (`express-openid-connect` runs with
 * `authRequired: false`), so an Express route is publicly callable unless something wraps it.
 * A carved app's routes are mounted dynamically by the framework rather than by hand in
 * `server.ts`, so the manifest has to say which posture the route needs — and the framework has to
 * apply it. Before this existed the mounter knew exactly one posture (plain OIDC), which is why
 * `serviceSecretOr` apps could not carve: carving one would have re-authed it and 401'd every bot
 * node, the headless CLI, and its own in-container tools.
 *
 * The five modes are not a design; they are an inventory of what `server.ts` actually does today:
 *
 * - `oidc` — plain `requiresAuth`. **The default, applied on omission.** A route must never become
 *   anonymous by forgetting a field.
 * - `service-or-oidc` — `serviceSecretOr(requiresAuth)`: a valid `X-Service-Secret` passes, else fall
 *   back to an OIDC session. This is how bot nodes and the headless CLI reach app routes. Note the
 *   bypass does not exist when `SWARM_SERVICE_SECRET` is unset — it simply falls through to OIDC.
 * - `service` — the secret is **required**; there is no OIDC fallback. Machine-to-machine ingest
 *   callbacks (`/api/apply`, `/api/lora` ingest). Distinct from `service-or-oidc`: a browser session
 *   must NOT reach these.
 * - `operator` — `requiresAuth` + `requiresOperator`. Operator-only surfaces (`/api/security`).
 * - `public` — genuinely anonymous; the router MUST self-guard (a token/HMAC inside it). Rare and
 *   loudly warned about. `/api/world` is the real example (WORLD_INGEST_TOKEN inside the router).
 *
 * Collapsing `service` into `public` — as a four-mode enum would force — would re-create the exact
 * lie this field exists to kill: a mode meaning both "genuinely anonymous" and "guarded by a secret
 * I promise is in there" is no better than the `requiresAuth: false` it replaces.
 */
export type SwarmAppRouteAuthMode = 'oidc' | 'service-or-oidc' | 'service' | 'operator' | 'public';

/** @description Every valid mode, for validation and error messages. */
export const ROUTE_AUTH_MODES: readonly SwarmAppRouteAuthMode[] = [
  'oidc',
  'service-or-oidc',
  'service',
  'operator',
  'public',
];

/** @description The mode applied when a manifest declares no `auth:`. Safe by omission. */
export const DEFAULT_ROUTE_AUTH_MODE: SwarmAppRouteAuthMode = 'oidc';

/**
 * @description Narrow an arbitrary manifest string to a known auth mode.
 * @param value - Candidate from a manifest's `routes[].auth`.
 * @returns True when it names a real mode.
 */
export function isRouteAuthMode(value: unknown): value is SwarmAppRouteAuthMode {
  return typeof value === 'string' && (ROUTE_AUTH_MODES as readonly string[]).includes(value);
}

/** @description The shape this resolver needs — a route declaration's two auth-bearing fields. */
export interface RouteAuthDeclaration {
  auth?: string;
  /** @deprecated Legacy boolean. `auth` wins; kept so pre-D2 manifests keep working. */
  requiresAuth?: boolean;
}

/**
 * @description Resolve a route declaration to exactly one auth mode. **The only place this
 * precedence lives** — the mounter, the loader, the validator and the tests all call it.
 *
 * Every branch fails SAFE. In particular an `auth:` the loader would have rejected resolves to
 * `oidc`, never `public`: `readManifest` throws on an unknown mode, so reaching here with one means
 * a manifest arrived by some other path, and the answer to "I don't understand this" is to demand
 * a login, not to open the door.
 *
 * @param decl - The route declaration.
 * @returns The resolved mode.
 */
export function resolveRouteAuthMode(decl: RouteAuthDeclaration): SwarmAppRouteAuthMode {
  if (decl.auth !== undefined) {
    return isRouteAuthMode(decl.auth) ? decl.auth : DEFAULT_ROUTE_AUTH_MODE;
  }
  // Legacy manifests: `requiresAuth: false` was the only way to say "anonymous".
  if (decl.requiresAuth === false) return 'public';
  return DEFAULT_ROUTE_AUTH_MODE;
}

/**
 * @description Do `auth:` and the legacy `requiresAuth:` contradict each other?
 *
 * Ambiguity in an auth declaration is an author bug, not something to silently resolve — the
 * loader throws on it rather than picking a winner.
 *
 * @param decl - The route declaration.
 * @returns True when the two fields disagree.
 */
export function routeAuthContradicts(decl: RouteAuthDeclaration): boolean {
  if (decl.auth === undefined || decl.requiresAuth === undefined) return false;
  const anonymous = decl.auth === 'public';
  return anonymous !== (decl.requiresAuth === false);
}
