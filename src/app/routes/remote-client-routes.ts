/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added remote-client registry and task dispatch routes
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added bidirectional swarm bridge: runtime presence, direct-channel subscription, and outbound swarm send endpoint
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added POST /:clientId/chat — a bot-reasoned conversational turn delivered back over the swarm-message poll queue
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added scoped per-task workspace sync (GET manifest/file, PUT file) so a remote node can read+write ONLY the shared task folder it currently holds — never the whole workspace volume. Holds-task gated + path-scoped (no traversal); pushes are additive (never delete sibling/handover files).
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Fix empty node chat replies since RLS: run the detached chat turn under the node's asserted user sub (or trusted system context when subless) instead of the request's anonymous identity, which violated the chat_tasks RLS policy on every write
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Per-user device ownership binding (repo-audit 2026-07-05): every /:clientId action surface (enqueue, results, task lifecycle, chat, workspace, swarm queues, heartbeat) now requires a session caller to OWN the device (canAccessResource: owner OR operator; unowned = operator-only fail-closed). Shared-secret machine callers (the node daemon itself + platform dispatchers) are unchanged. Session registrations default ownerSub to the session sub and cannot take over another user's device; session chat turns run under the SESSION sub (payload userSub assertion is machine-trust only). POST /:clientId/owner = operator reassignment.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Close the unconsumed task-result loop: forwardTaskResultToSwarm emitted only a targeted agent.{requester} reply NOTHING subscribed to. It now also publishes a landing event on MESH_CHANNELS.remoteTaskResult (envelopes built by remote-client-task-results.ts, correlation id guaranteed at the sender), and the route factory wires the controller-side subscriber that lands results on the originating work item when a workItemRepository is provided. The mesh swarm.exec conversion now prefers payload.externalId (the ticket id) for the task's correlationId so swarm-dispatched desktop work correlates back to its ticket's work items.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | ADR-036 cost capture for LEAF-NODE LLM tasks (apply / linkedin / any dispatchBrowserTask), which ran off the standard /api/swarm-execute path and billed NOTHING. handleCompleteTask + handleFailTask now meter the codex/claude token+cost the leaf already reports (result.output.usage/cost/provider) into chat_tasks via a new recordCost option, attributed to the task's fromAgentId (the accountable bot) with the ticket as ticketExternalId and userSub→ownerSub for per-owner budgets. buildRemoteTaskCostEvent builds the CostEvent (composite ${ticket}::${bot} key so it never merges a bot-node row; null for non-LLM shell/screen/desktop tasks). The write runs under runWithSystemIdentity — chat_tasks/oshal_cost_events are FORCE-RLS and this shared-secret route is identity-less (mirrors bot-node-server.ts). Non-blocking (runSideEffect) so a cost-write hiccup never fails a user's job application.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Scope the device LIST + single-device read to the caller (closes the documented residual of the 2026-07-09 ownership pass). A device list is a list of real people computers, and it also hands out the clientId that PINS dispatch - so an unscoped list was the discovery half of the cross-user leaf-node dispatch hole closed the same day in device-access.ts. Session callers now see only devices canAccessResource admits (operators still see the fleet); machine callers - the node daemon and the platform dispatchers - are unchanged because they must route work across every device. A denied single read 404s rather than 403s so ids cannot be probed for existence. Guard: tests/unit/remote-client-device-ownership.spec.ts.
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY: close two cross-user execution paths that the owner-scoped DISPATCHER fix (31a51352) does not cover, found by an adversarial design review. (1) MESH TASK INJECTION: the subscribeAgent callback converts an inbound envelope into registry.enqueueTask, and toTaskEnvelope accepts a verbatim embedded payload.task with arbitrary intent/input (codex.exec at danger-full-access). handleSendSwarmMessage is device-gated on the SENDER clientId and then calls sendDirect() on an UNCHECKED body toAgentId - so a user who legitimately owns one node could name another user node and execute on their desktop, bypassing requireDeviceAccess AND the dispatcher gate. New mayInjectTask() guards the CONVERSION (covers direct + broadcast; the sender agent id is server-derived from the authenticated device, never body-supplied): device-to-device traffic must pass canUseDevice, non-device senders are platform traffic and unchanged, and a refused envelope is still delivered as an inert MESSAGE, never as execution. (2) OWNERSHIP TAKEOVER: adopting an EXISTING but unbound device was open to any signed-in user - with OSHAL_ALLOW_LEGACY_UNOWNED on, canAccessResource admits everyone against a null owner and registry.register() lets a supplied ownerSub overwrite, so re-registering someone else clientId made you its permanent owner and every later gate then agreed. Only an operator may adopt an existing unbound device; first-time enrollment registers a NEW clientId, and the node own machine-trust re-registration is unaffected. Guards: tests/unit/remote-client-device-ownership.spec.ts.
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Worker-plane auth hardening (docs/backlog/hardening.md #7, backward compatible — enrolled shared-secret nodes keep working): (1) the swarm-wide shared-secret compare is now constant-time via timingSafeSecretEquals (sha256-digest both sides + crypto.timingSafeEqual) — `===` was a timing oracle on a public origin; (2) a router-LOCAL, flag-gated (OSHAL_RATE_LIMIT_REMOTE_CLIENTS, default OFF = no-op) rate limiter mounts ahead of auth, keyed PER CALLER on the /:clientId path segment (never per shared IP — behind cloudflared/NAT an IP key pools the fleet into one bucket) — closes the operator-action-queue rate-limit item without touching over-cap server.ts; (3) the shared-secret branch is formally DEPRECATED in favour of per-node tokens (`Bearer oshal_pat_…` → the upstream cli-token middleware authenticates the node's OWNER; the session branch + requireDeviceAccess then bind it to its own devices — issue = POST /api/join/enroll or POST /api/cli-tokens, verify = createCliTokenAuthMiddleware): the branch now warns once per boot and stamps x-oshal-shared-secret-deprecated on its responses so re-enrollment progress is observable. Guard: tests/unit/remote-client-auth.spec.ts (worker plane proven on a node token with NO shared secret configured).
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Rate-limiter keying fix (adversarial review): the per-clientId limiter mounted BEFORE auth let an unauthenticated flood mint a fresh bucket per fabricated clientId (bypass) and let a known clientId be 429-starved by anonymous traffic. Moved it AFTER authorizeRemoteClient — the clientId is now proven and unauthenticated floods are rejected before touching a legit node's bucket (the global 1000/min/IP limiter bounds those).
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | SHARED SECRET RETIREMENT (docs/backlog/hardening.md #7). Three legs. (a) FAIL-CLOSED SWITCH: REMOTE_CLIENT_REQUIRE_NODE_TOKEN=true refuses the swarm-wide-secret branch outright (401 code shared_secret_retired) so a deployment can prove no node still depends on it; default false keeps field nodes working, and the branch stays loudly deprecated either way. (b) PER-NODE BINDING ENFORCEMENT: a node-bound token (cli-token-routes node_client_id) is already confined to its own /:clientId plane by the auth middleware, but POST /register carries the device identity in the BODY - handleRegisterClient now refuses a body clientId that is not the presented token's, so a device credential cannot enrol, and take delivery of work for, a sibling machine. (c) ROTATION SURFACE: POST /:clientId/token/rotate mints the successor credential and revokes every prior generation in one call (owner-or-operator session, or the node presenting its own current token). Guard: tests/unit/remote-client-node-token.spec.ts.
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | The per-caller limiter was BUILT but INERT: makeLimiter('remote_clients', …) returns a pass-through unless OSHAL_RATE_LIMIT_REMOTE_CLIENTS is explicitly on, and that flag is set in no compose file, no .env.example and no running container — the live api's boot log carried exactly one 'rate-limit preset enabled' line (limiter=internal). Swapped to createRemoteClientRateLimiter(), which keeps the same key/window/cap and the same env var but defaults ON, so this deliberately-outside-requiresAuth worker plane is bounded per caller on every deployment instead of only where an operator remembered a flag. Guard: tests/unit/remote-client-rate-limit.spec.ts.
 * 15 | maintainer@emeraldcoastsystemsgroup.com   | Preserve verified principal issuer provenance when an owner rotates their own node token; operator rotations for another owner deliberately leave it unset rather than combining the operator's issuer with someone else's subject.
 * 16 | maintainer@emeraldcoastsystemsgroup.com   | Wire production task routes to the PostgreSQL journal with startup readiness gating, owner-aware RLS operations, immediate settlement replay, and atomic outboxId cost deduplication; process memory now retains only registration and swarm-message state.
 * 17 | maintainer@emeraldcoastsystemsgroup.com   | Extract held-task workspace synchronization into a focused route module, retaining machine-vs-session RLS identity and logging every filesystem catch while keeping this route factory within code-line governance.
 * 18 | maintainer@emeraldcoastsystemsgroup.com   | Inject the work-item repository into the durable settlement publisher so landing persistence is acknowledged by the journal outbox rather than by the lossy compatibility mesh consumer.
 * 19 | maintainer@emeraldcoastsystemsgroup.com   | Extract mesh task validation and owner-scoped injection checks into a focused module, keeping this route file below the 1,000-physical-line governance limit.
 */

import { randomUUID } from 'crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { canAccessResource, getCaller, isOperator, requireOperator } from '@/shared/middleware/authz';
import { getAuthenticatedPrincipalIssuer } from '@/shared/middleware/principal-issuer';
import { runWithRequestIdentity, runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { DEFAULT_CHAT_AGENT_ID } from '@/features/chat-orchestration';
import {
  RemoteClientHeartbeatSchema,
  RemoteClientRegistrationSchema,
} from '@/shared/types';
import {
  AgentRuntimeRegistryService,
  MESH_CHANNELS,
  MeshCommunicationService,
  type AgentRuntimeRegistration,
  type MeshSubscription,
} from '@/features/agent-management';
import {
  createRemoteClientRateLimiter,
  sharedSecretRetired,
  nodeTokenBindingMatches,
  PostgresRemoteTaskJournalRepository,
  RemoteClientRegistryService,
  RemoteClientOwnerConflictError,
  RemoteClientOwnerTransitionBusyError,
  RemoteTaskJournalService,
  RemoteTaskJournalUnavailableError,
  RemoteClientSwarmClaimResponseSchema,
  RemoteClientSwarmSendRequestSchema,
  RemoteClientSwarmSendResponseSchema,
  RemoteClientChatRequestSchema,
  RemoteClientChatAcceptResponseSchema,
  RemoteClientNotFoundError,
  runRemoteChatTurn,
  timingSafeSecretEquals,
  type RemoteChatOrchestrator,
  type RemoteChatReplyPayload,
  type RemoteClientRecord,
} from '@/features/remote-client';
import {
  subscribeRemoteTaskResults,
  type RemoteTaskResultLandingRepository,
} from './remote-client-task-results';
import { readNodeTokenBinding, rotateNodeToken } from './cli-token-routes';
import {
  createRemoteTaskOutboxPublisher,
  registerRemoteClientTaskOperations,
  type RecordRemoteTaskCostOnce,
} from './remote-client-task-operations';
import { registerRemoteClientWorkspaceRoutes } from './remote-client-workspace-routes';
import { mayInjectRemoteTask, toRemoteTaskEnvelope } from './remote-client-mesh-task';
export { buildRemoteTaskCostEvent } from './remote-client-task-operations';
export { taskWorkspaceFolder } from './remote-client-workspace-routes';
const logger = createChildLogger({ module: 'remote-client-routes' });
/**
 * @description Answers a poll/heartbeat call whose clientId this process has no registration for.
 *
 * The registry is in-memory, so every api restart drops the whole fleet while the edge daemons
 * keep polling on their own timers. That was answered with 400 + logger.error, which is wrong on
 * both counts: the daemon's request is well-formed (the server forgot, not the caller), and an
 * expected post-restart condition logged at ERROR buries real faults — one orphaned client
 * produced 188 ERROR lines in 24h. Answer 404 with a machine-readable `code` the daemon keys off
 * to re-register itself, and log at WARN.
 *
 * Returns false when the error is anything else, so genuine faults keep their 400 + ERROR.
 *
 * @param error - The thrown value from a registry call.
 * @param res - Response to write the 404 onto.
 * @param clientId - The client the call named.
 * @param operation - Short label for the log line.
 * @returns True when the error was handled as an unregistered client.
 */
function handleUnregisteredClient(
  error: unknown,
  res: Response,
  clientId: string,
  operation: string,
): boolean {
  if (!(error instanceof RemoteClientNotFoundError)) {
    return false;
  }

  logger.warn(
    { clientId, operation },
    'Remote client polled without a registration — telling it to re-register (expected after an api restart)',
  );
  res.status(404).json({ error: 'Remote client not found', code: error.code, clientId });
  return true;
}
/**
 * Shared in-process remote-client registry. Exported so ticket-gated controller dispatchers
 * (e.g. lora-train-dispatch) can enqueue an embedded shell.exec task to the GPU edge worker
 * through the SAME registry the worker polls — the privilege-rule path (ADR-070), no loopback HTTP.
 */
export const remoteClientRegistry = new RemoteClientRegistryService();
const registry = remoteClientRegistry;

interface RemoteClientRouteOptions {
  /** Token store backing per-node credential rotation. Absent -> the rotate route 503s. */
  pool?: Pool;
  meshCommunicationService?: MeshCommunicationService;
  runtimeRegistryService?: AgentRuntimeRegistryService;
  orchestrator?: RemoteChatOrchestrator;
  /** When provided (with a mesh service), remote task results land on the originating work item. */
  workItemRepository?: RemoteTaskResultLandingRepository;
  /** Exactly-once settlement cost sink. Its outbox receipt and cost mutations commit together. */
  recordCostOnce?: RecordRemoteTaskCostOnce;
  /** Explicit test seam; production constructs the PostgreSQL service from pool. */
  taskJournalService?: RemoteTaskJournalService;
}

interface RemoteClientRouteContext {
  pool?: Pool;
  meshCommunicationService?: MeshCommunicationService;
  runtimeRegistryService?: AgentRuntimeRegistryService;
  orchestrator?: RemoteChatOrchestrator;
  workItemRepository?: RemoteTaskResultLandingRepository;
  recordCostOnce?: RecordRemoteTaskCostOnce;
  meshSubscriptionsByClient: Map<string, { agentId: string; subscription: MeshSubscription }>;
  startedAtByClient: Map<string, string>;
}

/** @description Creates remote-client registry and task-dispatch routes. */
export function createRemoteClientRoutes(options: RemoteClientRouteOptions = {}): Router {
  const router = Router();
  const context = createRouteContext(options);
  subscribeTaskResultLanding(options);
  configureTaskJournal(options, context);
  registerRemoteClientSurface(router, context);
  logger.info(
    {
      hasMeshBridge: Boolean(context.meshCommunicationService),
      hasRuntimeRegistry: Boolean(context.runtimeRegistryService),
      hasChatBridge: Boolean(context.orchestrator),
    },
    'Remote client routes registered',
  );
  return router;
}

/** @description Creates per-router state without duplicating infrastructure services. */
function createRouteContext(options: RemoteClientRouteOptions): RemoteClientRouteContext {
  return {
    pool: options.pool,
    meshCommunicationService: options.meshCommunicationService,
    runtimeRegistryService: options.runtimeRegistryService,
    orchestrator: options.orchestrator,
    workItemRepository: options.workItemRepository,
    recordCostOnce: options.recordCostOnce,
    meshSubscriptionsByClient: new Map<string, { agentId: string; subscription: MeshSubscription }>(),
    startedAtByClient: new Map<string, string>(),
  };
}

/** @description Connects durable mesh settlement events to their originating work items. */
function subscribeTaskResultLanding(options: RemoteClientRouteOptions): void {
  if (options.meshCommunicationService && options.workItemRepository) {
    subscribeRemoteTaskResults(options.meshCommunicationService, {
      workItemRepository: options.workItemRepository,
    });
  }
}

/** @description Starts schema verification and outbox replay; task routes fail 503 until ready. */
function configureTaskJournal(
  options: RemoteClientRouteOptions,
  context: RemoteClientRouteContext,
): void {
  let service = options.taskJournalService;
  if (!service && options.pool) {
    service = new RemoteTaskJournalService(new PostgresRemoteTaskJournalRepository(options.pool));
  }
  if (!service) return;
  const publisher = createRemoteTaskOutboxPublisher(context);
  void registry.configureTaskJournal(service, publisher).catch((error) => {
    logger.error({ err: error }, 'Remote task journal startup failed; task routes remain unavailable');
  });
}

/** @description Mounts the authenticated presence, task, workspace, and messaging surface. */
function registerRemoteClientSurface(router: Router, context: RemoteClientRouteContext): void {
  router.use(authorizeRemoteClient);
  // Router-local per-caller rate limit (operator-action-queue 2026-07-18). ON by default —
  // it used to ride the flag-gated hardening preset, which defaults OFF and whose flag no
  // deployment ever set, so the control shipped inert; see remote-client-rate-limit.ts for
  // why this router's limit is required rather than opt-in. Disable with
  // OSHAL_RATE_LIMIT_REMOTE_CLIENTS=off; tune via ..._MAX / ..._WINDOW_MS. Keyed on the
  // /:clientId path segment — a node polls ~35 req/min (2.5s task poll + 10s heartbeat), so
  // the 300/min default leaves ~8x headroom while still bounding a runaway or abusive caller.
  // Mounted AFTER authorizeRemoteClient (2026-07-24 adversarial review): keying on the
  // attacker-controllable /:clientId ahead of auth let an unauthenticated flood mint a fresh
  // bucket per fabricated id (bypass) and let a known clientId be 429-starved by anonymous
  // traffic. Post-auth the clientId is proven and unauthenticated floods are rejected before
  // they can touch a legit node's bucket; the global server limiter (1000/min/IP) bounds those.
  router.use(createRemoteClientRateLimiter());
  router.post('/register', (req, res) => void handleRegisterClient(req, res, context));
  router.get('/', handleListClients);
  router.get('/:clientId', handleGetClient);
  // Every action/result surface below is device-ownership gated for SESSION
  // callers (owner or operator; unowned device = operator-only, fail-closed).
  // Machine callers (shared secret = the node daemon + platform dispatchers)
  // pass through unchanged — that is the pre-existing machine trust boundary.
  router.post('/:clientId/heartbeat', requireDeviceAccess, (req, res) => void handleHeartbeat(req, res, context));
  registerRemoteClientTaskOperations(router, requireDeviceAccess, {
    registry,
    isMachineCaller,
    meshCommunicationService: context.meshCommunicationService,
    workItemRepository: context.workItemRepository,
    recordCostOnce: context.recordCostOnce,
  });
  registerRemoteClientWorkspaceRoutes(router, requireDeviceAccess, { registry, isMachineCaller });
  router.get('/:clientId/swarm/next', requireDeviceAccess, handleClaimNextSwarmMessage);
  router.post('/:clientId/swarm/send', requireDeviceAccess, (req, res) => void handleSendSwarmMessage(req, res, context));
  router.post('/:clientId/chat', requireDeviceAccess, (req, res) => void handleChatTurn(req, res, context));
  router.post('/:clientId/owner', (req, res) => void handleSetOwner(req, res));
  // Per-node credential rotation (hardening #7). requireDeviceAccess already binds a session
  // caller to their own device; a node presenting its OWN current node token passes the same
  // gate as its owner, which is what lets an edge daemon rotate itself unattended.
  router.post('/:clientId/token/rotate', requireDeviceAccess, (req, res) => void handleRotateNodeToken(req, res, context));
}

/** Request stamped with WHICH branch of authorizeRemoteClient admitted it. */
type RemoteAuthedRequest = Request & { remoteClientAuthMode?: 'secret' | 'session' };

/** Once-per-boot latch for the shared-secret deprecation warning (a node heartbeats every 10s — per-request logging would drown the log). */
let sharedSecretDeprecationWarned = false;

/** Logs the shared-secret deprecation exactly once per process. */
function warnSharedSecretDeprecationOnce(): void {
  if (sharedSecretDeprecationWarned) return;
  sharedSecretDeprecationWarned = true;
  logger.warn(
    'remote-client shared-secret auth is DEPRECATED: re-enroll nodes onto per-node tokens (POST /api/join/enroll → Bearer oshal_pat_…). The swarm-wide secret stays accepted until every enrolled node is re-enrolled.',
  );
}

/**
 * @description Allows either a browser-authenticated session or a shared secret header.
 * Stamps the admitting branch on the request: 'secret' = machine trust (the node
 * daemon / a platform dispatcher holding REMOTE_CLIENT_SHARED_SECRET), 'session' =
 * a signed-in user, whose device access is then ownership-gated per route. A
 * per-node token (`Bearer oshal_pat_…`, minted by /api/join/enroll or
 * /api/cli-tokens and verified by the upstream createCliTokenAuthMiddleware)
 * arrives here as an authenticated session for the token's OWNER — that is the
 * sanctioned replacement for the swarm-wide secret, which is DEPRECATED (warned
 * once per boot + x-oshal-shared-secret-deprecated stamped on its responses) but
 * kept until every enrolled node is re-enrolled. Secret compares are constant-time
 * (timingSafeSecretEquals) — `===` was a timing oracle on a public origin.
 * The secret branch is checked FIRST so a machine caller that also happens to ride
 * an authenticated browser context is still treated as machine trust.
 */
function authorizeRemoteClient(req: Request, res: Response, next: NextFunction): void {
  const sharedSecret = (
    process.env.REMOTE_CLIENT_SHARED_SECRET ||
    process.env.REMOTE_CLIENT_CONTROL_PLANE_TOKEN ||
    ''
  ).trim();
  const headerName = (process.env.REMOTE_CLIENT_AUTH_HEADER || 'x-remote-client-key').trim().toLowerCase();
  const bearer = extractBearer(req.header('authorization'));
  const headerValue = req.header(headerName);
  const oidc = (req as Request & { oidc?: { isAuthenticated: () => boolean } }).oidc;

  if (
    sharedSecret.length > 0 &&
    (timingSafeSecretEquals(headerValue, sharedSecret) || timingSafeSecretEquals(bearer, sharedSecret))
  ) {
    // Fail-closed posture: once every node is re-enrolled onto a per-node token, the operator
    // sets REMOTE_CLIENT_REQUIRE_NODE_TOKEN=true and the swarm-wide value stops being a
    // credential at all. Refusing here (rather than deleting the branch) is what makes the
    // retirement provable on a live fleet: flip it, watch for this log line, flip back if a
    // node still needs re-enrolling.
    if (sharedSecretRetired()) {
      logger.warn(
        { path: req.path, method: req.method },
        'refused swarm-wide shared secret: REMOTE_CLIENT_REQUIRE_NODE_TOKEN is on - re-enrol this node (POST /api/join/enroll) for a per-node token',
      );
      res.status(401).json({ error: 'Unauthorized', code: 'shared_secret_retired' });
      return;
    }
    (req as RemoteAuthedRequest).remoteClientAuthMode = 'secret';
    warnSharedSecretDeprecationOnce();
    res.setHeader('x-oshal-shared-secret-deprecated', '1');
    next();
    return;
  }

  if (oidc?.isAuthenticated?.()) {
    (req as RemoteAuthedRequest).remoteClientAuthMode = 'session';
    next();
    return;
  }

  logger.warn({ path: req.path, method: req.method }, 'Remote client unauthorized');
  res.status(401).json({ error: 'Unauthorized' });
}

/** True when the request was admitted by the shared-secret (machine trust) branch. */
function isMachineCaller(req: Request): boolean {
  return (req as RemoteAuthedRequest).remoteClientAuthMode === 'secret';
}

/** @description Crosses RLS as system only after the shared-secret branch authenticated the caller. */
function runAuthorizedMachineIdentity<T>(req: Request, operation: () => Promise<T>): Promise<T> {
  return isMachineCaller(req) ? runWithSystemIdentity(operation) : operation();
}

/** @description Maps durable journal and owner-guard failures without exposing another user's sub. */
function handleOwnerOrJournalError(error: unknown, res: Response): boolean {
  if (error instanceof RemoteTaskJournalUnavailableError) {
    res.status(503).json({ error: error.message, code: error.code });
    return true;
  }
  if (error instanceof RemoteClientOwnerTransitionBusyError) {
    res.status(409).json({ error: error.message, code: error.code });
    return true;
  }
  if (error instanceof RemoteClientOwnerConflictError) {
    res.status(409).json({ error: error.message, code: error.code });
    return true;
  }
  return false;
}

/**
 * @description Device-ownership gate for session callers (repo-audit 2026-07-05:
 * any authenticated user could enqueue shell-exec-class tasks to, and read
 * results/screenshots from, ANY registered device). Machine callers pass through.
 * Session callers must satisfy canAccessResource against the device's ownerSub —
 * owner or operator; an UNOWNED device is operator-only unless the deployment
 * explicitly opts into legacy-unowned access (OSHAL_ALLOW_LEGACY_UNOWNED).
 */
function requireDeviceAccess(req: Request, res: Response, next: NextFunction): void {
  if (isMachineCaller(req)) {
    next();
    return;
  }

  const clientId = normalizeParam(req.params.clientId);
  const client = registry.getClient(clientId);
  if (!client) {
    res.status(404).json({ error: 'Remote client not found' });
    return;
  }

  if (!canAccessResource(req, client.ownerSub ?? null)) {
    logger.warn(
      { clientId, path: req.path, method: req.method, callerSub: getCaller(req).sub, deviceOwned: Boolean(client.ownerSub) },
      'Device access denied: session caller is not the device owner',
    );
    res.status(403).json({ error: 'Forbidden: this device is not bound to your account' });
    return;
  }

  next();
}

/**
 * @description POST /:clientId/owner — rebinds a device to a user (operator
 * reassignment per the ownership model; machine callers may also bind, e.g. a
 * provisioning flow). Body: { ownerSub: string } — empty/absent clears the
 * binding, returning the device to operator-only fail-closed.
 */
async function handleSetOwner(req: Request, res: Response): Promise<void> {
  if (!isMachineCaller(req) && !requireOperator(req, res)) {
    return;
  }

  const clientId = normalizeParam(req.params.clientId);
  const body = (req.body ?? {}) as { ownerSub?: unknown };
  const ownerSub = typeof body.ownerSub === 'string' ? body.ownerSub.trim() : '';

  try {
    const client = await runAuthorizedMachineIdentity(
      req,
      () => registry.setOwner(clientId, ownerSub || null),
    );
    res.json({ client });
  } catch (error) {
    if (handleOwnerOrJournalError(error, res)) return;
    logger.error({ err: error, clientId }, 'Failed to update remote client owner binding');
    res.status(404).json({ error: 'Remote client not found' });
  }
}

/**
 * @description POST /:clientId/token/rotate - issues this device's NEXT worker-plane
 * credential and revokes every prior generation in the same call (hardening #7: the
 * swarm-wide shared secret had no rotation at all, and one leaked copy reached every
 * person's desktop).
 *
 * Who may call it: requireDeviceAccess has already run, so the caller is the device's owner,
 * an operator, or the node itself presenting its OWN current node token (its binding resolves
 * to its owner's identity, which is what lets an edge daemon rotate unattended). A machine
 * caller on the DEPRECATED swarm-wide secret is deliberately refused - letting the credential
 * being retired mint its own replacement would defeat the point.
 *
 * The plaintext successor is returned exactly once. The presenting token is revoked with the
 * rest, so a node must persist the new value before its next poll.
 *
 * @param req - Request (`/:clientId` names the device).
 * @param res - Response carrying the minted token once.
 * @param context - Route context (pool backs the token store).
 */
async function handleRotateNodeToken(
  req: Request,
  res: Response,
  context: RemoteClientRouteContext,
): Promise<void> {
  const clientId = normalizeParam(req.params.clientId);
  if (isMachineCaller(req)) {
    logger.warn({ clientId }, 'Node-token rotation denied: the deprecated shared secret may not mint per-node credentials');
    res.status(403).json({ error: 'Forbidden: rotate with a session or the device own node token', code: 'shared_secret_cannot_rotate' });
    return;
  }
  if (!context.pool) {
    res.status(503).json({ error: 'rotation_unavailable', message: 'This swarm has no database, so it cannot issue per-node tokens.' });
    return;
  }
  const client = registry.getClient(clientId);
  const { sub, email } = getCaller(req);
  // Rotate FOR the device's owner, not for whoever asked: an operator rotating someone's node
  // must not silently re-own its credential. An unowned device (operator-only by
  // requireDeviceAccess) binds to the operator performing the enrolment.
  const ownerSub = (client?.ownerSub ?? '').trim() || (sub ?? '').trim();
  if (!ownerSub) {
    res.status(400).json({ error: 'device_has_no_owner', message: 'Bind an owner (POST /:clientId/owner) before issuing a per-node token.' });
    return;
  }
  try {
    const minted = await rotateNodeToken(context.pool, {
      clientId,
      ownerSub,
      email: ownerSub === sub ? email ?? null : null,
      principalIssuer: ownerSub === sub ? getAuthenticatedPrincipalIssuer(req) : null,
      label: `node ${clientId}`,
    });
    res.status(201).json({
      clientId,
      ownerSub,
      token: minted.token,
      tokenId: minted.id,
      revokedCount: minted.revokedCount,
      expiresAt: minted.expiresAt,
    });
  } catch (error) {
    logger.error({ err: error, clientId }, 'Per-node token rotation failed');
    res.status(500).json({ error: 'rotation_failed' });
  }
}

/**
 * @description Registers a new remote client and binds its direct swarm channel.
 * Ownership at registration: machine callers (the node daemon) self-assert their
 * ownerSub from the node's signed-in config. Session callers get ownerSub pinned
 * to their OWN session sub (operators may bind to anyone), and cannot re-register
 * — i.e. take over — a device bound to someone else.
 */
async function handleRegisterClient(req: Request, res: Response, context: RemoteClientRouteContext): Promise<void> {
  try {
    const registration = RemoteClientRegistrationSchema.parse(req.body);

    // Per-node binding, body edition (hardening #7). Every other worker-plane route carries the
    // device in the URL, so the auth middleware's decideNodeTokenScope already confines a node
    // token to its own /:clientId. /register does not - the identity is in the body - so without
    // this a device credential could enrol a SIBLING clientId and then legitimately receive that
    // machine's dispatched work. The ownership checks below do not catch it: the credential's
    // owner may genuinely own both devices.
    const nodeBinding = readNodeTokenBinding(req);
    if (nodeBinding && !nodeTokenBindingMatches(nodeBinding.clientId, registration.clientId)) {
      logger.warn(
        { boundClientId: nodeBinding.clientId, declaredClientId: registration.clientId },
        'Registration denied: node-bound token named a different device',
      );
      res.status(403).json({ error: 'Forbidden: this token is bound to another device', code: 'node_token_client_mismatch' });
      return;
    }

    if (!isMachineCaller(req)) {
      const existing = registry.getClient(registration.clientId);
      if (existing && !canAccessResource(req, existing.ownerSub ?? null)) {
        res.status(403).json({ error: 'Forbidden: this device is bound to another account' });
        return;
      }
      // ADOPTING an already-registered but UNBOUND device is an ownership-takeover primitive, and
      // the check above does not stop it: with OSHAL_ALLOW_LEGACY_UNOWNED on, canAccessResource
      // admits every signed-in user against a null owner, and registry.register() lets a supplied
      // ownerSub overwrite. So anyone could re-register someone else's unowned clientId, become its
      // permanent owner, and thereafter dispatch to that desktop legitimately. Only an operator may
      // adopt an existing unbound device; genuine first-time enrollment registers a NEW clientId.
      if (existing && !existing.ownerSub && !isOperator(req)) {
        logger.warn(
          { clientId: registration.clientId, callerSub: getCaller(req).sub },
          'Device adoption denied: session caller cannot claim an existing unowned device',
        );
        res.status(403).json({ error: 'Forbidden: this device is not bound to your account' });
        return;
      }
      const { sub } = getCaller(req);
      // Non-operators can only bind a device to themselves; a session
      // registration with no asserted owner defaults to the session user.
      registration.ownerSub = isOperator(req) ? (registration.ownerSub ?? sub ?? undefined) : (sub ?? undefined);
    }

    const client = await runAuthorizedMachineIdentity(req, () => registry.register(registration));

    ensureSwarmSubscription(client, context);
    await runSideEffect(
      'remote-runtime-registration',
      () => publishRuntimePresence(client, client.status, context),
      { clientId: client.clientId, agentId: resolveRemoteAgentId(client) },
    );
    await runSideEffect(
      'remote-presence-broadcast',
      () => broadcastPresence(client, client.status, context),
      { clientId: client.clientId, agentId: resolveRemoteAgentId(client) },
    );

    res.status(201).json({ client, registeredAt: client.registeredAt });
  } catch (error) {
    if (handleOwnerOrJournalError(error, res)) return;
    logger.error({ err: error }, 'Failed to register remote client');
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to register remote client' });
  }
}

/**
 * @description Lists registered remote clients. A device list is a list of real people's computers,
 * so session callers see only the ones they may act on (owner, or operator = whole fleet). Machine
 * callers — the node daemon and the platform dispatchers — still need the full fleet to route work.
 */
async function handleListClients(req: Request, res: Response): Promise<void> {
  const all = registry.listClients();
  const clients = isMachineCaller(req) ? all : all.filter((c) => canAccessResource(req, c.ownerSub ?? null));
  res.json({ clients, count: clients.length });
}

/**
 * @description Returns one client record. Denied lookups 404 rather than 403 so a device id cannot
 * be probed for existence (the object-level rule in shared/middleware/authz).
 */
async function handleGetClient(req: Request, res: Response): Promise<void> {
  const clientId = normalizeParam(req.params.clientId);
  const client = registry.getClient(clientId);

  if (!client) {
    res.status(404).json({ error: 'Remote client not found' });
    return;
  }

  if (!isMachineCaller(req) && !canAccessResource(req, client.ownerSub ?? null)) {
    logger.warn({ clientId, callerSub: getCaller(req).sub }, 'Device read denied: not the owner');
    res.status(404).json({ error: 'Remote client not found' });
    return;
  }

  res.json({ client });
}

/**
 * @description Records a heartbeat from a remote client and refreshes swarm runtime presence.
 */
async function handleHeartbeat(req: Request, res: Response, context: RemoteClientRouteContext): Promise<void> {
  const clientId = normalizeParam(req.params.clientId);

  try {
    const client = registry.recordHeartbeat(clientId, RemoteClientHeartbeatSchema.parse(req.body));
    ensureSwarmSubscription(client, context);
    await runSideEffect(
      'remote-runtime-heartbeat',
      () => publishRuntimePresence(client, client.status, context),
      { clientId: client.clientId, agentId: resolveRemoteAgentId(client), status: client.status },
    );

    if (client.status === 'offline') {
      await runSideEffect(
        'remote-offline-broadcast',
        () => broadcastPresence(client, 'offline', context),
        { clientId: client.clientId, agentId: resolveRemoteAgentId(client) },
      );
    }

    res.json({ client, acceptedAt: new Date().toISOString() });
  } catch (error) {
    if (handleUnregisteredClient(error, res, clientId, 'heartbeat')) {
      return;
    }
    logger.error({ err: error, clientId }, 'Failed to record remote client heartbeat');
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to record heartbeat' });
  }
}

/**
 * @description Claims the next inbound swarm message for a remote client.
 */
async function handleClaimNextSwarmMessage(req: Request, res: Response): Promise<void> {
  const clientId = normalizeParam(req.params.clientId);

  try {
    const message = registry.claimNextSwarmMessage(clientId);
    const response = RemoteClientSwarmClaimResponseSchema.parse({
      claimed: message != null,
      message,
    });

    if (!response.claimed) {
      res.status(204).end();
      return;
    }

    res.json(response);
  } catch (error) {
    if (handleUnregisteredClient(error, res, clientId, 'claim-swarm-message')) {
      return;
    }
    logger.error({ err: error, clientId }, 'Failed to claim remote client swarm message');
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to claim swarm message' });
  }
}

/**
 * @description Publishes a remote-client initiated message to the swarm mesh.
 */
async function handleSendSwarmMessage(req: Request, res: Response, context: RemoteClientRouteContext): Promise<void> {
  const clientId = normalizeParam(req.params.clientId);

  try {
    const client = registry.getClient(clientId);
    if (!client) {
      res.status(404).json({ error: 'Remote client not found' });
      return;
    }

    if (!context.meshCommunicationService) {
      res.status(503).json({ error: 'Swarm mesh bridge not configured' });
      return;
    }

    const payload = RemoteClientSwarmSendRequestSchema.parse(req.body);
    const correlationId = payload.correlationId ?? randomUUID();
    const fromAgentId = resolveRemoteAgentId(client);

    if (payload.mode === 'broadcast') {
      await context.meshCommunicationService.broadcast(fromAgentId, payload.payload, correlationId);
    } else {
      await context.meshCommunicationService.sendDirect(payload.toAgentId!, fromAgentId, payload.payload, correlationId);
    }

    res.json(RemoteClientSwarmSendResponseSchema.parse({
      accepted: true,
      correlationId,
    }));
  } catch (error) {
    logger.error({ err: error, clientId }, 'Failed to publish remote-client swarm message');
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to publish swarm message' });
  }
}

/**
 * @description Accepts a conversational chat turn, processes it on the target bot
 * (so the bot owns reasoning + cost per ADR-036), and delivers the reply back over
 * the swarm-message queue the client polls via GET /:clientId/swarm/next.
 *
 * Returns 202 immediately; the reply arrives asynchronously on the poll queue,
 * keyed by the returned taskId + correlationId.
 */
async function handleChatTurn(req: Request, res: Response, context: RemoteClientRouteContext): Promise<void> {
  const clientId = normalizeParam(req.params.clientId);

  try {
    const client = registry.getClient(clientId);
    if (!client) {
      res.status(404).json({ error: 'Remote client not found' });
      return;
    }

    if (!context.orchestrator) {
      res.status(503).json({ error: 'Chat bridge not configured' });
      return;
    }

    const payload = RemoteClientChatRequestSchema.parse(req.body);
    const agentId = payload.agentId?.trim() || DEFAULT_CHAT_AGENT_ID;
    const taskId = payload.taskId?.trim() || `remote-chat-${clientId}`;
    const correlationId = payload.correlationId?.trim() || randomUUID();
    const orchestrator = context.orchestrator;

    // Reason + reply asynchronously: LLM turns can run long, so we ack now and let
    // the client poll swarm/next for the reply rather than holding the connection.
    //
    // RLS identity: this detached work would otherwise inherit the HTTP request's
    // identity — anonymous for a shared-secret node — and every chat_tasks write
    // dies on the RLS policy (empty reply to the node). Scope it to the node's
    // asserted user sub when present (same caller-asserted trust boundary as the
    // shared secret itself); with no sub, run under the positive SYSTEM sentinel
    // (runWithSystemIdentity) — trusted system context, this machine-authenticated
    // surface's pre-RLS behavior, and deny-by-default-safe (the sentinel always stamps
    // operator, unlike a bare identity-less run which OSHAL_DB_GUC_STRICT=deny starves).
    //
    // The payload userSub assertion is MACHINE-TRUST ONLY: a signed-in session
    // caller always runs under their own session sub — otherwise any user could
    // run bot turns (and land chat_tasks rows) under another user's identity.
    const userSub = isMachineCaller(req)
      ? (payload.userSub?.trim() || '')
      : (getCaller(req).sub ?? '');
    const runTurn = () => runRemoteChatTurn(orchestrator, {
      clientId,
      agentId,
      taskId,
      text: payload.text,
      correlationId,
      userSub: userSub || undefined,
    })
      .then((reply) => deliverChatReply(clientId, client, agentId, reply))
      .catch((error) => {
        logger.error({ err: error, clientId, taskId }, 'Failed to deliver remote chat reply');
      });
    if (userSub) {
      void runWithRequestIdentity({ sub: userSub, isOperator: false }, runTurn);
    } else {
      void runWithSystemIdentity(runTurn);
    }

    res.status(202).json(RemoteClientChatAcceptResponseSchema.parse({
      accepted: true,
      taskId,
      correlationId,
      agentId,
    }));
  } catch (error) {
    logger.error({ err: error, clientId }, 'Failed to accept remote chat turn');
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to accept chat turn' });
  }
}

/**
 * @description Enqueues a finished chat reply onto the remote client's swarm-message
 * queue so the next GET /:clientId/swarm/next poll returns it.
 */
function deliverChatReply(
  clientId: string,
  client: RemoteClientRecord,
  botAgentId: string,
  reply: RemoteChatReplyPayload,
): void {
  const clientAgentId = resolveRemoteAgentId(client);
  registry.enqueueSwarmMessage(clientId, {
    messageId: randomUUID(),
    correlationId: reply.correlationId,
    fromAgentId: botAgentId,
    toAgentId: clientAgentId,
    channel: MESH_CHANNELS.agentDirect(clientAgentId),
    messageType: 'reply',
    payload: reply as unknown as Record<string, unknown>,
    receivedAt: new Date().toISOString(),
  });
  logger.info(
    { clientId, taskId: reply.taskId, success: reply.success },
    'Delivered remote chat reply to swarm-message queue',
  );
}

/**
 * @description Ensures the remote client is subscribed to its direct swarm channel.
 */
function ensureSwarmSubscription(client: RemoteClientRecord, context: RemoteClientRouteContext): void {
  if (!context.meshCommunicationService) {
    return;
  }

  const clientId = client.clientId;
  const agentId = resolveRemoteAgentId(client);
  const existing = context.meshSubscriptionsByClient.get(clientId);

  if (existing && existing.agentId === agentId) {
    return;
  }

  if (existing) {
    existing.subscription.stop();
    context.meshSubscriptionsByClient.delete(clientId);
  }

  const subscription = context.meshCommunicationService.subscribeAgent(
    agentId,
    async (envelope) => {
      try {
        const task = toRemoteTaskEnvelope(envelope, agentId);
        if (task && mayInjectTask(envelope.fromAgentId, clientId)) {
          await runWithSystemIdentity(() => registry.enqueueTask(clientId, task));
          return;
        }
        if (task) {
          // Refused above: fall through and hand it over as an inert MESSAGE, never as execution.
          logger.warn(
            { targetClientId: clientId, fromAgentId: envelope.fromAgentId, correlationId: envelope.correlationId },
            'Mesh task injection refused: sender device may not execute on this device',
          );
        }

        registry.enqueueSwarmMessage(clientId, {
          messageId: randomUUID(),
          correlationId: envelope.correlationId,
          fromAgentId: envelope.fromAgentId,
          toAgentId: envelope.toAgentId,
          channel: envelope.channel,
          messageType: envelope.messageType ?? 'event',
          payload: envelope.payload,
          receivedAt: new Date().toISOString(),
        });
      } catch (error) {
        logger.error(
          { err: error, clientId, agentId, correlationId: envelope.correlationId },
          'Failed to enqueue inbound mesh message for remote client',
        );
      }
    },
  );

  context.meshSubscriptionsByClient.set(clientId, { agentId, subscription });
  logger.info({ clientId, agentId }, 'Bound remote client to swarm direct channel');
}

/**
 * @description Publishes runtime presence for one remote client into the shared runtime registry.
 */
async function publishRuntimePresence(
  client: RemoteClientRecord,
  clientStatus: RemoteClientRecord['status'],
  context: RemoteClientRouteContext,
): Promise<void> {
  if (!context.runtimeRegistryService) {
    return;
  }

  const startedAt = context.startedAtByClient.get(client.clientId) ?? client.registeredAt;
  context.startedAtByClient.set(client.clientId, startedAt);

  const registration: AgentRuntimeRegistration = {
    agentId: resolveRemoteAgentId(client),
    agentName: client.name,
    aliases: uniqueAliases([client.clientId, client.tailnetHostname]),
    role: 'remote-client',
    capabilities: client.capabilities,
    status: clientStatus === 'offline' ? 'offline' : 'online',
    endpointUrl: client.endpointUrl?.trim() ?? '',
    internalEndpointUrl: client.controlPlaneUrl,
    externalPort: null,
    startedAt,
    heartbeatAt: new Date().toISOString(),
  };

  await context.runtimeRegistryService.upsertAgent(registration);
}

/**
 * @description Broadcasts lifecycle status updates for remote clients.
 */
async function broadcastPresence(
  client: RemoteClientRecord,
  status: 'online' | 'degraded' | 'offline',
  context: RemoteClientRouteContext,
): Promise<void> {
  if (!context.meshCommunicationService) {
    return;
  }

  await context.meshCommunicationService.broadcast(resolveRemoteAgentId(client), {
    type: 'remote-client.presence',
    clientId: client.clientId,
    agentId: resolveRemoteAgentId(client),
    name: client.name,
    platform: client.platform,
    status,
    capabilityCount: client.capabilities.length,
    capabilities: client.capabilities,
    timestamp: new Date().toISOString(),
  });
}

/** @description Backward-compatible route export over the isolated mesh execution boundary. */
export function mayInjectTask(fromAgentId: string, targetClientId: string): boolean {
  return mayInjectRemoteTask(registry, fromAgentId, targetClientId);
}

/**
 * @description Runs one non-critical side effect with warning-only failure handling.
 */
async function runSideEffect(
  sideEffect: string,
  runner: () => Promise<void>,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    await runner();
  } catch (error) {
    logger.warn({ err: error, sideEffect, ...context }, 'Remote-client side effect failed');
  }
}

/**
 * @description Extracts a bearer token from Authorization headers.
 */
function extractBearer(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) {
    return null;
  }

  const trimmed = authorizationHeader.trim();
  if (!trimmed.toLowerCase().startsWith('bearer ')) {
    return null;
  }

  return trimmed.slice(7).trim() || null;
}

/**
 * @description Normalizes Express route params into a single string value.
 */
function normalizeParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] || '';
  }

  return typeof value === 'string' ? value : '';
}

/**
 * @description Resolves the swarm agent identity used for direct-channel routing.
 */
function resolveRemoteAgentId(client: RemoteClientRecord): string {
  const normalized = client.agentId?.trim();
  if (normalized && normalized.length > 0) {
    return normalized;
  }
  return client.clientId;
}

/**
 * @description Converts unknown values into records when possible.
 */
function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * @description Returns one non-empty trimmed string value.
 */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * @description Deduplicates aliases while dropping empty values.
 */
function uniqueAliases(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    aliases.push(normalized);
  }
  return aliases;
}
