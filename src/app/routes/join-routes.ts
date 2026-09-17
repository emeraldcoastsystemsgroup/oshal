/**
 * Add-a-computer routes — mint a join code for a new worker node, from the swarm itself.
 *
 * "Go to the swarm to get the key." The Windows installer prints a join code once, at the
 * end of the swarm install. That is fine on day one and useless on day ninety, so this
 * surface mints a fresh one on demand from the same `REMOTE_CLIENT_SHARED_SECRET` the
 * controller already validates against in remote-client-routes.ts.
 *
 * OPERATOR-ONLY, deliberately. A join code embeds the shared secret in plaintext; anyone
 * holding it can register a worker node that receives dispatched tasks. It is exactly as
 * sensitive as the secret itself, so the mount sits behind requiresAuth + requiresOperator —
 * the same gate the Security Center uses, and for the same reason.
 *
 * LAN-only by design. The v2 join code (which carries Headscale credentials so a node on
 * another network can dial in) needs `headscale preauthkeys create` on the *host*, and the
 * controller runs in a container with no business shelling out to the host's Headscale. So
 * off-LAN codes come from `installer\lib\install-swarm.ps1 -OffLan` on the swarm machine.
 * This route emits v1 and says so.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — GET / (surface), GET /code (mint a v1 join code from the request host + REMOTE_CLIENT_SHARED_SECRET).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SELF-SERVICE ENROLLMENT: POST
 *   /enroll lets ANY signed-in user enroll their OWN computer. The v1 join code is operator-only and
 *   embeds the swarm-wide REMOTE_CLIENT_SHARED_SECRET in plaintext forever, so onboarding meant an
 *   operator minting a secret, sending it to the person, and that person pasting it into a CLI — and
 *   the resulting node was bound to NOBODY (`ownerSub` self-asserted from local config, usually
 *   empty). That is the wrong shape now that dispatch is owner-scoped (device-access.ts): an unowned
 *   node is invisible to its own user. /enroll instead mints a SHORT-LIVED, REVOCABLE, per-user
 *   `oshal_pat_` token via insertCliToken — the exact pattern already proven by the Spaces phone
 *   pairing (ADR-111) — so the node exchanges it for a SERVER-VERIFIED sub and registers bound to
 *   that user. No swarm secret is handed to a person, and the binding cannot be spoofed by the node.
 *   The mount relaxes to requiresAuth; the two secret-bearing endpoints self-gate to operator.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | POST /enroll accepts a clientId and mints a token BOUND to that device (hardening #7: cli-token node_client_id). A bound token is not an account credential - it authenticates only on that device's worker plane plus the enrollment handshake - which is what lets an edge machine hold a long-lived worker-plane credential instead of the swarm-wide REMOTE_CLIENT_SHARED_SECRET, and lets it be rotated (POST /api/remote-clients/:clientId/token/rotate) and revoked per node. Bound enrollments also get a longer default TTL, because the token IS the node's steady-state credential rather than a 60-minute handoff. Omitting clientId keeps the previous unbound behaviour verbatim.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Delegate the signed-in user's verified issuer into enrollment and node credentials so derived authentication preserves the complete principal namespace.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Mount GET /node-installer: the same per-device enrollment, delivered as a runnable script with the credential already in it.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | POST /enroll is DEVICE-BOUND by default, and every instruction it prints carries the device id. Seq 3 left the binding opt-in, and no caller could opt in: the id does not exist until something mints one, so the first enrolment of a new machine always took the unbound branch - an account-wide PAT clamped to an hour, sitting on an edge machine, dying under the node it was meant to keep alive. The route mints the id itself when the caller has none (the shape GET /node-installer already used) and returns it beside the token, and existingNode/newInstall now seed OSHAL_CLIENT_ID / -ClientId, without which the node keeps the id it invented for itself and register answers 403 node_token_client_mismatch. An explicit ttlMinutes is still honoured, so a caller that deliberately wants a short handoff still gets one.
 *
 * @module join-routes
 */

import { randomUUID } from 'crypto';
import { Router, type Request, type Response, type RequestHandler } from 'express';
import * as path from 'path';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { getCaller, requireOperator } from '@/shared/middleware/authz';
import { getAuthenticatedPrincipalIssuer } from '@/shared/middleware/principal-issuer';
import { insertCliToken } from '@/app/routes/cli-token-routes';
import { registerNodeInstallerRoute } from '@/app/routes/node-installer-routes';

const logger = createChildLogger({ module: 'join-routes' });

/** Enrollment tokens are for the minutes between "click enroll" and "the node comes up". */
const DEFAULT_ENROLL_TTL_MINUTES = 60;
const MIN_ENROLL_TTL_MINUTES = 5;
const MAX_ENROLL_TTL_MINUTES = 24 * 60;

/**
 * Characters a device id may carry. Narrow because the id is now WRITTEN INTO the commands
 * `/enroll` prints - a `"` or a `&` in it produces a line that does something other than what
 * it reads as. Server-minted ids (`node-<uuid>`) and the node app's own (`oshal-chat-<uuid>`)
 * are well inside it; a caller-supplied id outside it is refused rather than escaped, which is
 * the same call `renderNodeInstaller` makes about the one-click download.
 */
const SAFE_CLIENT_ID = /^[A-Za-z0-9._:-]+$/;

/** Hostnames that only ever resolve back to the controller's own machine. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * @description Serves a static surface file from the api directory.
 * @param apiDir - Directory holding the HTML surfaces.
 * @param file - Filename within that directory.
 * @returns An Express handler that streams the file, 404-ing on failure.
 */
function servePage(apiDir: string, file: string): RequestHandler {
  return (_req, res) => {
    res.sendFile(path.join(apiDir, file), (err) => {
      if (err) {
        logger.error({ err, file }, 'serve add-computer surface failed');
        res.status(404).send('Not found');
      }
    });
  };
}

/**
 * @description Base64url-encodes a UTF-8 string (RFC 4648 §5, padding stripped).
 *
 * Matches `ConvertTo-Base64Url` in installer/lib/common.ps1 so a code minted here decodes in
 * the installer, and vice versa. Node's built-in 'base64url' encoding already strips padding.
 *
 * @param text - The string to encode.
 * @returns The base64url representation.
 */
function toBase64Url(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64url');
}

/**
 * @description Works out the URL a *different* machine should use to reach this controller.
 *
 * The Host header is the only reliable source: the controller runs in a container, so its own
 * network interfaces report a 172.x bridge address that means nothing on the LAN. If the
 * operator is browsing over the LAN, Host is already the LAN address they want. If they are on
 * localhost, no such address exists and we say so rather than minting a code that silently
 * only works on one machine.
 *
 * @param req - The inbound request.
 * @returns The control-plane URL, and whether it is loopback-only.
 */
function resolveControlPlaneUrl(req: Request): { url: string; loopback: boolean } {
  const host = String(req.headers.host || '').trim();
  const hostname = host.replace(/:\d+$/, '').toLowerCase();
  const protocol = req.protocol === 'https' ? 'https' : 'http';

  if (!host) {
    return { url: process.env.APP_URL || 'http://localhost:35457', loopback: true };
  }
  return { url: `${protocol}://${host}`, loopback: LOOPBACK_HOSTS.has(hostname) };
}

/** Clamps a caller-supplied enrollment TTL into the allowed window. */
function clampEnrollTtlMinutes(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ENROLL_TTL_MINUTES;
  return Math.min(MAX_ENROLL_TTL_MINUTES, Math.max(MIN_ENROLL_TTL_MINUTES, Math.floor(n)));
}

/**
 * @description Builds the "add a computer" routes.
 *
 * `POST /enroll` is the SELF-SERVICE path: any signed-in user enrolls their own computer and gets a
 * short-lived per-user token. `GET /` and `GET /code` are the legacy operator path — `/code` mints a
 * v1 join code (`OSJOIN1.<base64url>`) carrying the swarm-wide `REMOTE_CLIENT_SHARED_SECRET`, so
 * both self-gate to operator even though the mount is only requiresAuth. `/code` never generates a
 * secret: if the controller has none, no node could join anyway, so it returns 409 with the one
 * command that fixes it rather than handing out a code that will be rejected.
 *
 * @param apiDir - Directory holding the HTML surfaces.
 * @param pool - Postgres pool backing the per-user enrollment tokens (absent → /enroll 503s).
 * @returns The configured router. Mount behind requiresAuth.
 */
export function createJoinRoutes(apiDir: string, pool?: Pool): Router {
  const router = Router();

  // GET /node-installer — the same enrollment, delivered as something the person can run
  // rather than a token they have to paste. Lives in its own module because rendering a
  // script with a credential in it deserves its own guards.
  registerNodeInstallerRoute(router, pool ?? null);

  /**
   * POST /enroll — enroll a computer as MINE. Deliberately NOT operator-gated: a user attaching
   * their own laptop is not an administrative act, and owner-scoped dispatch means the node is only
   * ever reachable by the person it is bound to. Returns a short-lived `oshal_pat_` token; the node
   * exchanges it (GET /api/cli-tokens/whoami) for a server-verified sub and registers with that as
   * its ownerSub — so ownership is proven by possession of a token minted for that user, never
   * asserted by the node itself. Revoke any time from the same /api/cli-tokens list.
   */
  router.post('/enroll', async (req: Request, res: Response) => {
    const { sub, email } = getCaller(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    if (!pool) { res.status(503).json({ error: 'enrollment_unavailable', message: 'This swarm has no database, so it cannot issue enrollment tokens.' }); return; }

    const body = (req.body ?? {}) as { computerName?: unknown; ttlMinutes?: unknown; clientId?: unknown };
    const computerName = String(body.computerName ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    // A node credential is a DEVICE credential. A caller may name the device it is for - a
    // computer that is already registered knows its own id - but the first enrolment of a new
    // machine cannot, because the id does not exist until something mints one. So the swarm
    // mints it HERE and hands both halves back together. Minting it on the node instead is the
    // shape that failed: the node invented `oshal-chat-<uuid>` on first run and the control
    // plane answered 403 node_token_client_mismatch, and the only way to avoid that was to
    // leave the credential unbound - an account PAT on an edge machine, which is more reach
    // than a node should hold and (clamped to an hour) dies under it.
    const requestedClientId = String(body.clientId ?? '').trim().slice(0, 200);
    if (requestedClientId && !SAFE_CLIENT_ID.test(requestedClientId)) {
      res.status(400).json({
        error: 'unsupported_client_id',
        message: 'A device id may contain letters, digits, and . _ : - only. Leave it out and '
          + 'this swarm will mint one for the computer.',
      });
      return;
    }
    const clientId = requestedClientId || `node-${randomUUID()}`;
    // A DEVICE-bound token is the node's steady-state credential, not a 60-minute handoff, so
    // it does not expire by default: an edge machine that is off for a week must still come back
    // without a human. Its bounds are SCOPE (one device's plane), rotation and revocation - all
    // three of which the swarm-wide secret lacked. An explicit ttlMinutes still wins, which is
    // what keeps the short handoff available to a caller that deliberately asks for one.
    const explicitTtl = body.ttlMinutes !== undefined && body.ttlMinutes !== null;
    const ttlMinutes = explicitTtl ? clampEnrollTtlMinutes(body.ttlMinutes) : 0;
    const { url, loopback } = resolveControlPlaneUrl(req);

    try {
      const minted = await insertCliToken(pool, {
        sub, email,
        principalIssuer: getAuthenticatedPrincipalIssuer(req),
        label: computerName ? `node ${clientId} (${computerName})` : `node ${clientId}`,
        ttlMs: ttlMinutes > 0 ? ttlMinutes * 60 * 1000 : undefined,
        nodeClientId: clientId,
      });
      // The token is the credential — it is returned to its owner exactly once and never logged.
      logger.info(
        { id: minted.id, sub, ttlMinutes, computerName: computerName || null, nodeClientId: minted.nodeClientId },
        'node enrollment token minted',
      );
      res.status(201).json({
        enrollment: {
          id: minted.id,
          token: minted.token,
          expiresAt: minted.expiresAt,
          ttlMinutes: ttlMinutes > 0 ? ttlMinutes : null,
          controlPlaneUrl: url,
          // The device this token is confined to. It is HALF THE CREDENTIAL: a bound token
          // presented by a node registering under any other id is refused 403
          // node_token_client_mismatch, so every instruction below carries the id as well.
          nodeClientId: minted.nodeClientId,
          // Whether the swarm minted the id or the caller named one it already had, so a
          // surface can say "this is your computer's id" instead of echoing a value back.
          clientIdMinted: requestedClientId.length === 0,
        },
        // How the node proves who owns it — no swarm-wide secret involved in THIS step.
        verifyUrl: `${url}/api/cli-tokens/whoami`,
        install: {
          // An already-installed node: BOTH halves. The token on its own leaves the node with
          // the id it minted for itself, which this token was never minted for.
          existingNode: `set OSHAL_CLIENT_ID=${clientId} && set OSHAL_ENROLLMENT_TOKEN=${minted.token} && installer\\Open-Swarm-Node.cmd`,
          // The minted token IS the worker-plane credential: the node sends it as its bearer on
          // every register/heartbeat/claim call, per-device, revocable and rotatable. -ClientId is
          // not decoration - install-node.ps1 seeds OSHAL_CLIENT_ID from it, and without it the
          // node registers as an id this token does not name.
          newInstall: `powershell -ExecutionPolicy Bypass -File installer\\lib\\install-node.ps1 -JoinCode <OSJOIN1...> -EnrollmentToken "${minted.token}" -ClientId "${clientId}"`,
          workerPlaneToken: `set REMOTE_CLIENT_CONTROL_PLANE_TOKEN=${minted.token}`,
          // Nothing needs pasting at all if the person downloads the file instead: the same
          // per-device enrollment, already inside something they can run.
          oneClick: `${url}/api/join/node-installer`,
          note: `This token is bound to one computer. It replaces the swarm-wide shared secret on it, and you can rotate or revoke it without touching any other machine. Both values travel together: the computer registers as ${clientId}, and a computer that registers as anything else is refused.`,
        },
        warning: loopback
          ? 'You are browsing over localhost, so this points at localhost and only works on this machine. Open the cockpit from the swarm machine\'s LAN address and enroll again.'
          : null,
      });
    } catch (err) {
      logger.error({ err, sub }, 'node enrollment mint failed');
      res.status(500).json({ error: 'enrollment_mint_failed' });
    }
  });

  router.get('/', (req: Request, res: Response, next) => {
    if (!requireOperator(req, res)) return;
    servePage(apiDir, 'add-computer.html')(req, res, next);
  });

  router.get('/code', (req: Request, res: Response) => {
    const started = Date.now();
    const caller = getCaller(req);
    // Operator-only even though the mount is not: this code embeds the swarm-wide shared secret.
    if (!requireOperator(req, res)) return;

    const secret = process.env.REMOTE_CLIENT_SHARED_SECRET || '';
    if (!secret) {
      logger.warn({ sub: caller.sub }, 'join code requested but REMOTE_CLIENT_SHARED_SECRET is unset');
      res.status(409).json({
        error: 'no_shared_secret',
        message:
          'This swarm has no REMOTE_CLIENT_SHARED_SECRET, so no computer can join it. ' +
          'Set one in .env and restart, or re-run installer\\lib\\install-swarm.ps1 which mints one for you.',
      });
      return;
    }

    const { url, loopback } = resolveControlPlaneUrl(req);
    const joinCode = `OSJOIN1.${toBase64Url(`${url}|${secret}`)}`;

    logger.info(
      { sub: caller.sub, controlPlaneUrl: url, loopback, durationMs: Date.now() - started },
      'minted a join code',
    );

    res.json({
      joinCode,
      controlPlaneUrl: url,
      version: 1,
      // A loopback code is not wrong, it is just useless anywhere but this machine.
      warning: loopback
        ? 'You are browsing over localhost, so this code points at localhost and only works on this machine. ' +
          'Open the cockpit from the swarm machine\'s LAN address and reload.'
        : null,
      offLanHint:
        'To let a computer on a different network join, run installer\\lib\\install-swarm.ps1 -OffLan ' +
        'on the swarm machine. That mints a Headscale key and emits an OSJOIN2 code.',
    });
  });

  return router;
}
