/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Inbound A2A gateway routes (BACKLOG Plan F). Three surfaces: (1) GET /.well-known/agent-card.json — PUBLIC by A2A spec design but a hard 404 no-op unless A2A_GATEWAY_ENABLED=true, skills curated from the registry via ADR-087 isBotAccessibleTo(id,'jarvis'); (2) /api/a2a/agents — credential management, requiresAuth + OPERATOR-only (mirrors budget-routes authz), mint returns the plaintext token exactly once; (3) POST /api/a2a — the JSON-RPC 2.0 endpoint with A2A-native per-agent Bearer auth (NOT OIDC, per the spec's securitySchemes), failure-rate-limited, also 404 unless enabled. The RPC layer files real tickets through the injected TicketService — the controller never names a bot and never calls an LLM.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Fix (review finding, CRITICAL): the RPC handler ran under the global RLS request-identity mounted before this route in server.ts, so every message/send hit the FORCE RLS WITH CHECK on tickets as anonymous sub '' and failed to insert, tasks/get|cancel always saw zero rows, and the fail-closed inbound-ceiling COUNT was silently neutralized to 0. Re-enter runWithRequestIdentity with the authenticated agent's synthetic 'a2a:<agentId>' sub around rpc.handle — same pattern chat-channel-routes.ts already uses for its own post-auth identity re-entry.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Fix (security review LOW, BACKLOG "A2A auth-failure limiter keyed on spoofable req.ip"): server.ts sets `trust proxy` true, so req.ip is the client-supplied leftmost X-Forwarded-For entry — a caller could mint a fresh limiter bucket per request by rotating that header, defeating the failure limiter entirely. The bucket key is now the TRANSPORT peer (socket.remoteAddress) via a2aLimiterKey(); req.ip stays in the warn log for observability only. Accepted tradeoff (documented on the helper): behind cloudflared all external callers share the connector's socket and therefore one failure bucket — fine, because this limiter throttles FAILED authentications only.
 */

import { Router, type Express, type Request, type RequestHandler, type Response } from 'express';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { isOperator } from '@/shared/middleware/authz';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import {
  A2A_AGENT_CARD_PATH,
  A2A_TOKEN_PREFIX,
  A2aAuthFailureLimiter,
  A2aCredentialsService,
  A2aRpcService,
  buildAgentCard,
  isA2aGatewayEnabled,
  ownerSubForA2aAgent,
  type A2aMessageReader,
  type A2aTicketRails,
  type A2ACardBotInput,
} from '@/features/a2a-gateway';
import { getActiveRegistry, isBotAccessibleTo } from '@/app/extensions/swarm/swarm-bot-registry';

const logger = createChildLogger({ module: 'a2a-routes' });

/** @description Dependencies for the A2A gateway routes; every collaborator is injectable for tests. */
export interface A2aRoutesDeps {
  pool: Pool | null;
  ticketService: A2aTicketRails;
  messageStore: A2aMessageReader;
  env?: NodeJS.ProcessEnv;
  /** Bot definitions for card curation; defaults to the live registry. */
  getBots?: () => ReadonlyArray<A2ACardBotInput>;
  /** ADR-087 accessibility predicate; defaults to isBotAccessibleTo(id, 'jarvis'). */
  isAccessible?: (agentId?: string) => boolean;
  /** Credential store; defaults to a pool-backed A2aCredentialsService. */
  credentials?: A2aCredentialsService;
  /** Bearer failure limiter; defaults to 10 failures / minute / transport peer. */
  limiter?: A2aAuthFailureLimiter;
}

/**
 * @description Rate-limiter bucket key for one caller: the TRANSPORT peer
 * (socket.remoteAddress), deliberately never req.ip. server.ts sets `trust proxy`
 * true, so req.ip is the client-supplied leftmost X-Forwarded-For entry — keying on
 * it lets a caller mint a fresh bucket per request by rotating that header, which
 * defeats the limiter entirely (security review 2026-07-19). Accepted tradeoff:
 * behind a reverse proxy / cloudflared every external caller shares the connector's
 * socket address and therefore ONE failure bucket — acceptable because this limiter
 * throttles FAILED authentications only (successful auth never counts against it),
 * while direct LAN/localhost callers keep honest per-peer buckets. req.ip still
 * appears in the warn log for observability; it just never keys the bucket.
 * @param req - The Express request.
 * @returns The bucket key (socket remote address, or 'unknown' when absent).
 */
export function a2aLimiterKey(req: Request): string {
  return req.socket?.remoteAddress || 'unknown';
}

/** Resolves the env bag once so every handler honors injected test environments. */
function envOf(deps: Pick<A2aRoutesDeps, 'env'>): NodeJS.ProcessEnv {
  return deps.env ?? process.env;
}

/**
 * @description GET handler for the spec well-known agent card. Public (A2A discovery is
 * anonymous by design) but a hard 404 unless A2A_GATEWAY_ENABLED=true, so a deployment
 * that never opted in exposes nothing — not even the swarm's existence.
 * @param deps - Route dependencies (env, bot source, accessibility predicate).
 * @returns An Express handler.
 */
export function createAgentCardHandler(deps: A2aRoutesDeps): RequestHandler {
  return (req: Request, res: Response) => {
    const env = envOf(deps);
    if (!isA2aGatewayEnabled(env)) { res.status(404).json({ error: 'not_found' }); return; }
    const startedAt = Date.now();
    const baseUrl = String(env.A2A_PUBLIC_BASE_URL ?? '').trim()
      || `${req.protocol}://${req.get('host') ?? 'localhost'}`;
    const card = buildAgentCard({
      baseUrl,
      version: String(env.npm_package_version ?? '1.0.0'),
      bots: deps.getBots ? deps.getBots() : getActiveRegistry(),
      isAccessible: deps.isAccessible ?? ((agentId?: string) => isBotAccessibleTo(agentId, 'jarvis')),
    });
    logger.info({ skillCount: card.skills.length, durationMs: Date.now() - startedAt }, 'GET agent card');
    res.json(card);
  };
}

/**
 * @description Credential management router (mount: /api/a2a/agents). requiresAuth +
 * operator-only — minting an external agent credential is an operator act (mirrors the
 * budget-routes authz split). Available even while the gateway is disabled so the
 * operator can stage credentials before flipping A2A_GATEWAY_ENABLED.
 * @param requiresAuth - The app-level OIDC auth middleware (sanctioned param pattern).
 * @param deps - Route dependencies (credential store / pool).
 * @returns The configured Express router.
 */
export function createA2aAgentManagementRouter(requiresAuth: RequestHandler, deps: A2aRoutesDeps): Router {
  const router = Router();
  const credentials = deps.credentials ?? new A2aCredentialsService(deps.pool);
  router.use(requiresAuth);
  router.use((req: Request, res: Response, next) => {
    if (!isOperator(req)) { res.status(403).json({ success: false, error: 'Operator privilege required' }); return; }
    next();
  });

  // Mint — the plaintext token appears in this response ONCE and is never stored.
  router.post('/', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { name?: unknown; scopes?: unknown; ownerNote?: unknown };
      if (typeof body.name !== 'string' || !body.name.trim()) {
        res.status(400).json({ success: false, error: 'name is required' }); return;
      }
      const minted = await credentials.mint({
        name: body.name, scopes: body.scopes, ownerNote: typeof body.ownerNote === 'string' ? body.ownerNote : undefined,
      });
      if (!minted) { res.status(503).json({ success: false, error: 'Credential store unavailable' }); return; }
      res.status(201).json({ success: true, agent: minted });
    } catch (err) {
      logger.error({ err }, 'POST /api/a2a/agents mint failed');
      const invalid = err instanceof Error && err.message === 'invalid_mint_input';
      res.status(invalid ? 400 : 500).json({ success: false, error: invalid ? 'Invalid name/scopes' : 'Mint failed' });
    }
  });

  // List — metadata only; hashes and plaintext never leave the server.
  router.get('/', async (_req: Request, res: Response) => {
    try {
      res.json({ success: true, agents: await credentials.list() });
    } catch (err) {
      logger.error({ err }, 'GET /api/a2a/agents failed');
      res.status(500).json({ success: false, error: 'Failed to list agents' });
    }
  });

  // Revoke — idempotent; a repeat revoke reports revoked:false.
  router.post('/:id/revoke', async (req: Request, res: Response) => {
    try {
      const revoked = await credentials.revoke(String(req.params.id));
      res.json({ success: true, revoked });
    } catch (err) {
      logger.error({ err }, 'POST /api/a2a/agents/:id/revoke failed');
      res.status(500).json({ success: false, error: 'Revoke failed' });
    }
  });

  return router;
}

/**
 * @description POST handler for the single JSON-RPC endpoint (/api/a2a). A2A-native
 * auth: per-agent Bearer (never OIDC — external agents have no browser session), with
 * an in-memory failure limiter in front so credential guessing gets 429s. 404 unless
 * A2A_GATEWAY_ENABLED=true.
 *
 * IDENTITY (fixed 2026-07-18): server.ts mounts the global RLS request-identity
 * middleware BEFORE this route (load-bearing order per docs/governance/RLS-RUNBOOK.md),
 * so by the time this handler runs the AsyncLocalStorage context already holds the
 * OIDC/TV/guest identity for the request — which for an external bearer caller is
 * anonymous (sub ''), never this agent. Under FORCE RLS that anonymous identity reads
 * back ZERO rows on every ticket-scoped query (createTicket's owner_sub WITH CHECK,
 * getTicket's owner filter, the inbound-ceiling COUNT), so message/send would fail to
 * insert and tasks/get|cancel would never see the agent's own tickets. Mirrors the exact
 * fix in chat-channel-routes.ts's dispatchToSwarm: re-enter runWithRequestIdentity with
 * the AUTHENTICATED agent's synthetic sub for the rest of the request, scoped to exactly
 * this agent, never operator.
 * @param deps - Route dependencies.
 * @returns An Express handler.
 */
export function createA2aRpcHandler(deps: A2aRoutesDeps): RequestHandler {
  const credentials = deps.credentials ?? new A2aCredentialsService(deps.pool);
  const limiter = deps.limiter ?? new A2aAuthFailureLimiter();
  const rpc = new A2aRpcService({
    pool: deps.pool, tickets: deps.ticketService, messages: deps.messageStore, env: deps.env,
  });
  return async (req: Request, res: Response) => {
    const startedAt = Date.now();
    try {
      if (!isA2aGatewayEnabled(envOf(deps))) { res.status(404).json({ error: 'not_found' }); return; }
      const callerKey = a2aLimiterKey(req);
      if (limiter.isLimited(callerKey)) {
        logger.warn({ callerKey, forwardedIp: req.ip }, 'a2a bearer failure limit hit');
        res.status(429).json({ error: 'too_many_failed_authentications' });
        return;
      }
      const agent = await authenticateBearer(req, credentials);
      if (!agent) {
        limiter.recordFailure(callerKey);
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const outcome = await runWithRequestIdentity(
        { sub: ownerSubForA2aAgent(agent.agentId), isOperator: false },
        () => rpc.handle(req.body, agent),
      );
      logger.info(
        { agentId: agent.agentId, httpStatus: outcome.httpStatus, durationMs: Date.now() - startedAt },
        'POST /api/a2a handled',
      );
      res.status(outcome.httpStatus).json(outcome.body);
    } catch (err) {
      logger.error({ err }, 'POST /api/a2a failed');
      res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } });
    }
  };
}

/** Extracts + authenticates the per-agent bearer; null on anything short of a live credential. */
async function authenticateBearer(
  req: Request, credentials: A2aCredentialsService,
): Promise<Awaited<ReturnType<A2aCredentialsService['authenticate']>>> {
  const auth = String(req.headers.authorization ?? '');
  if (!auth.toLowerCase().startsWith('bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token.startsWith(A2A_TOKEN_PREFIX)) return null;
  return credentials.authenticate(token);
}

/**
 * @description Registers the full A2A gateway surface on the app. Mount order/paths:
 * the spec well-known card at the root, credential management under /api/a2a/agents
 * (registered BEFORE the /api/a2a POST so path resolution stays unambiguous), and the
 * JSON-RPC endpoint at POST /api/a2a.
 * @param app - The Express app.
 * @param requiresAuth - The app-level OIDC auth middleware (management routes only).
 * @param deps - Pool + ticket rails + message reader (+ test injectables).
 */
export function registerA2aGatewayRoutes(app: Express, requiresAuth: RequestHandler, deps: A2aRoutesDeps): void {
  const shared: A2aRoutesDeps = { ...deps, credentials: deps.credentials ?? new A2aCredentialsService(deps.pool) };
  app.get(A2A_AGENT_CARD_PATH, createAgentCardHandler(shared));
  app.use('/api/a2a/agents', createA2aAgentManagementRouter(requiresAuth, shared));
  app.post('/api/a2a', createA2aRpcHandler(shared));
  logger.info({ enabled: isA2aGatewayEnabled(envOf(deps)) }, 'A2A gateway routes registered');
}
