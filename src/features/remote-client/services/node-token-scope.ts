/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — per-node worker-plane token scoping (docs/backlog/hardening.md #7, retiring the swarm-wide shared secret). Pure decisions only: decideNodeTokenScope confines a NODE-BOUND credential to its own device's plane (plus the two enrollment-handshake paths), sharedSecretRetired reads the fail-closed switch, and nodeTokenBindingMatches is the route-level body check for /register. No Express, no DB — so the guard spec drives the same functions the runtime does.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-175: package node rails. A mount declared `auth: node` registers its path here, and a node-bound token is admitted beneath a registered rail (reason `package-node-rail`) as well as on its own worker plane. The route still binds the device it speaks for to the token's clientId.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-175 amendment 1 (security review): a rail registers only beneath its own app's namespace (/api/<app>/<segment>...), so a package cannot open core or another app's routes to node credentials; and a node-bound token is admitted on a rail only when its clientId names that app (`<app>-...`), else refused `foreign-app`, so a desktop worker credential or another app's device is not an identity on this rail.
 */

/**
 * Per-node token scoping for the remote-client (worker) plane.
 *
 * WHY THIS EXISTS. Until now a worker node authenticated with
 * `REMOTE_CLIENT_SHARED_SECRET` — ONE swarm-wide value that (a) is machine trust, so it
 * skips the per-device ownership gate entirely, (b) is identical on every node, so one
 * leaked copy reaches every person's desktop, and (c) cannot be rotated per node. The
 * hardening backlog (#7) asks for HMAC/JWT/mTLS before the A2A surface goes public.
 *
 * The replacement reuses the proven PAT rail rather than inventing a credential format:
 * `/api/join/enroll` mints an `oshal_pat_…` token that is **bound to one clientId**
 * (`oshal_cli_tokens.node_client_id`), and the global CLI-token middleware only stamps an
 * authenticated identity for such a token on the paths this module admits. The token is
 * therefore NOT a general-purpose account credential the way an unbound PAT is: a copy
 * lifted off an edge machine can drive that one device's plane and nothing else — not
 * `/api/content`, not `/api/cli-tokens` minting, not another user's device.
 *
 * Rotation + revocation come for free from the same store (`revoked_at`, `expires_at`),
 * which is what the shared secret never had.
 *
 * @module features/remote-client/services/node-token-scope
 */

/** Router base the whole worker plane lives under (mounted in server.ts). */
export const REMOTE_CLIENT_PLANE_PREFIX = '/api/remote-clients';

/**
 * Paths a node-bound token may call that are NOT under its own `/:clientId` segment:
 *  - `/api/cli-tokens/whoami` — the enrollment handshake: the node exchanges the token for
 *    a SERVER-VERIFIED sub before it registers, so ownership is proven, never asserted.
 *  - `/api/remote-clients/register` — first contact; there is no `/:clientId` segment yet, so
 *    the body's clientId is checked instead (see {@link nodeTokenBindingMatches}).
 */
export const NODE_TOKEN_HANDSHAKE_PATHS: readonly string[] = [
  '/api/cli-tokens/whoami',
  `${REMOTE_CLIENT_PLANE_PREFIX}/register`,
];

/** Why a node-bound token was admitted, or refused, on a given path. */
export type NodeTokenScopeDecision =
  | { allowed: true; reason: 'handshake' | 'own-device-plane' | 'package-node-rail' }
  | { allowed: false; reason: 'foreign-device' | 'off-plane' | 'foreign-app' };

/** Package node rails by app: mounts declared `auth: node` (ADR-175), as decoded path segments. */
const packageNodeRails = new Map<string, string[][]>();

/**
 * @description Register an `auth: node` mount so a node-bound token of this app is admitted beneath it.
 * Called by the manifest route mounter after the app's routes mount. A rail must sit beneath the
 * app's own namespace, `/api/<appName>/<segment>...`: anything else (core routes, another app, the
 * app root) is refused and nothing is registered, so the node guard there admits no one.
 * @param appName - Owning package; its rails are dropped together on unmount and remount.
 * @param mountPath - The declared mount, e.g. `/api/embodied/nodes`.
 * @returns Whether the rail was registered.
 */
export function registerPackageNodeRail(appName: string, mountPath: string): boolean {
  const segments = segmentsOf(mountPath);
  if (segments.length < 3 || segments[0] !== 'api' || segments[1] !== appName) return false;
  const rails = packageNodeRails.get(appName) ?? [];
  rails.push(segments);
  packageNodeRails.set(appName, rails);
  return true;
}

/**
 * @description Drop every node rail an app registered (unmount / reload).
 * @param appName - Owning package.
 */
export function unregisterPackageNodeRails(appName: string): void {
  packageNodeRails.delete(appName);
}

/**
 * @description Whether a request path sits at or beneath a registered package node rail.
 * Segment-wise on decoded segments, so `/api/embodied/nodesX` is not beneath `/api/embodied/nodes`.
 * @param path - Request path.
 * @returns True when a node-bound token may authenticate it.
 */
export function isPackageNodeRailPath(path: string): boolean {
  return packageNodeRailApp(path) !== null;
}

/**
 * @description The app whose registered node rail a request path sits at or beneath.
 * @param path - Request path.
 * @returns The owning app's name, or null when no rail covers the path.
 */
export function packageNodeRailApp(path: string): string | null {
  const request = segmentsOf(path);
  for (const [appName, rails] of packageNodeRails) {
    if (rails.some((rail) => rail.every((segment, index) => request[index] === segment))) return appName;
  }
  return null;
}

/** Input to {@link decideNodeTokenScope} — the token's binding plus the request path. */
export interface NodeTokenScopeInput {
  /** The clientId the token is bound to (`oshal_cli_tokens.node_client_id`). */
  boundClientId: string;
  /** Full request path as Express reports it (`req.path`), query already stripped. */
  path: string;
}

/**
 * @description Splits a path into decoded, non-empty segments. Decoding matters: a
 * percent-encoded clientId (`gabe%2Dpc`) must compare equal to its decoded form, and a
 * malformed escape must NOT throw — it simply fails to match, which fails closed.
 * @param path - Request path.
 * @returns Decoded path segments.
 */
function segmentsOf(path: string): string[] {
  return String(path ?? '')
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

/**
 * @description Decides whether a NODE-BOUND token may authenticate this request.
 *
 * A node-bound token is admitted only on:
 *   1. the two enrollment-handshake paths ({@link NODE_TOKEN_HANDSHAKE_PATHS}),
 *   2. a registered package node rail (an `auth: node` mount, ADR-175) of the app its clientId names
 *      (`<app>-...`; another app's rail is `foreign-app`), and
 *   3. its OWN device's plane — `/api/remote-clients/<boundClientId>` and anything beneath it.
 *
 * Everything else is refused: a sibling device's plane (`foreign-device` — this is the
 * property the swarm-wide secret could never have) and every non-plane route
 * (`off-plane` — so an edge machine's credential is not an account credential).
 *
 * Fails closed on an empty binding: a row whose `node_client_id` is blank is not a
 * node token and must never be handled by this path.
 *
 * @param input - The token's bound clientId and the request path.
 * @returns The scope decision with the reason (logged on refusal; never a secret).
 */
export function decideNodeTokenScope(input: NodeTokenScopeInput): NodeTokenScopeDecision {
  const bound = String(input.boundClientId ?? '').trim();
  const path = String(input.path ?? '');
  if (bound.length === 0) return { allowed: false, reason: 'off-plane' };

  // Compare on decoded segments so a trailing slash / encoded id / repeated separators
  // cannot smuggle a different device past a prefix string compare.
  const normalized = `/${segmentsOf(path).join('/')}`;
  if (NODE_TOKEN_HANDSHAKE_PATHS.includes(normalized)) {
    return { allowed: true, reason: 'handshake' };
  }
  const railApp = packageNodeRailApp(path);
  if (railApp !== null) {
    // A device credential is an identity only on rails of the app its clientId names (`embodied-plant` on embodied).
    return bound.startsWith(`${railApp}-`) ? { allowed: true, reason: 'package-node-rail' } : { allowed: false, reason: 'foreign-app' };
  }

  const planeSegments = segmentsOf(REMOTE_CLIENT_PLANE_PREFIX);
  const requestSegments = segmentsOf(path);
  const onPlane = planeSegments.every((segment, index) => requestSegments[index] === segment);
  if (!onPlane) return { allowed: false, reason: 'off-plane' };

  const clientSegment = requestSegments[planeSegments.length];
  if (clientSegment === undefined) return { allowed: false, reason: 'off-plane' };
  return clientSegment === bound
    ? { allowed: true, reason: 'own-device-plane' }
    : { allowed: false, reason: 'foreign-device' };
}

/**
 * @description Route-level check for the one path where the device identity travels in the
 * BODY rather than the URL (`POST /api/remote-clients/register`). The handshake branch of
 * {@link decideNodeTokenScope} lets a node-bound token reach that route at all; this is what
 * stops it registering — and therefore taking delivery of work for — a different clientId.
 * @param boundClientId - The clientId the presented token is bound to.
 * @param bodyClientId - The clientId the registration body declares.
 * @returns True when they name the same device.
 */
export function nodeTokenBindingMatches(
  boundClientId: string | null | undefined,
  bodyClientId: unknown,
): boolean {
  const bound = String(boundClientId ?? '').trim();
  const declared = typeof bodyClientId === 'string' ? bodyClientId.trim() : '';
  return bound.length > 0 && declared.length > 0 && bound === declared;
}

/**
 * @description Whether the swarm-wide shared secret is RETIRED on this deployment — the
 * fail-closed posture. Default is `false` (the deprecated secret is still accepted) because
 * enrolled nodes in the field must keep working until they are re-enrolled onto per-node
 * tokens; flipping `REMOTE_CLIENT_REQUIRE_NODE_TOKEN=true` refuses the secret branch outright,
 * leaving per-node tokens + browser sessions as the only ways onto the worker plane.
 *
 * Deliberately NOT default-true: silently rejecting every field node's credential on a
 * container recreate would take the desktop fleet offline with no operator act. The
 * deprecation is loud instead (one warn per boot + `x-oshal-shared-secret-deprecated` on
 * every response it admits) so re-enrollment progress is observable before the flip.
 *
 * @param env - Environment map (process.env by default; injectable for tests).
 * @returns True when the shared-secret branch must be refused.
 */
export function sharedSecretRetired(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.REMOTE_CLIENT_REQUIRE_NODE_TOKEN ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes';
}
