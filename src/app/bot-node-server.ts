/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Token broker: /api/swarm-execute forwards body.creds (caller's short-lived per-user access tokens) into the envelope payload so the execution handler can write them to the task workspace as .oshal-cred-<provider> files.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Renamed the controller service to oshal-api (the legacy-branded name was a leftover mistake); the controller fallback URL is now http://oshal-api:5000 to match the renamed compose service / DNS alias.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Hardening-backlog #3: bot-node DB connect now retries the SELECT 1 probe (BOT_DB_CONNECT_ATTEMPTS, default 10×2s) instead of a single try, so a transient cold-start timeout no longer strands the bot DB-less for its lifetime; still degrades gracefully to no-DB after retries are exhausted.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Hardening-backlog #12: codex sandboxMode fallback danger-full-access → read-only (least privilege). Compose sets CODEX_SANDBOX_MODE explicitly for the swarm so the live deployment is unchanged.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | ADR-081: CodexProvider timeoutMs honors CODEX_INACTIVITY_TIMEOUT_MS first (the wrapper now refreshes the timer on child output, so this bounds SILENCE, not total runtime); legacy CODEX_TIMEOUT_MS kept as fallback.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | ADR-083: (1) SwarmAgentWorker gains the shared mesh bid responder as directHandler — nodes received BID_REQUESTs over Redis and dropped them (responded: 0); (2) profile seeding now uses the shared agent-profile-boot-seeder, which upserts under the RUNTIME agent id and reads persona selector/keywords — the old repo.createAgent path auto-generated uuids and minted ghost rows that never matched the heartbeat id (made the general fallback unreachable).
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Security-audit (bot-node /api/swarm-execute unauthenticated + host-published): the LLM-execution endpoints (/api/swarm-execute, /api/token-chase/replay-call) now pass through authorizeBotNodeCall — an OPTIONAL shared-secret gate that enforces the SWARM_SERVICE_SECRET (via the shared hasValidServiceSecret) ONLY when it is configured, and is a no-op otherwise (fail-open so it cannot break existing controller→bot dispatch until the secret is rolled out). Pairs with BotNodeClient now sending serviceSecretHeaders() on those calls. Defense-in-depth: the bot-node accepts caller creds + runs cost, and its port is host-published on 127.0.0.1; this stops anything on the host loopback that isn't the controller from triggering runs / submitting creds.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Security-audit follow-through: the fail-open posture is now LOUD — logBotNodeAuthPosture() emits a startup WARN (naming the backlog item) when SWARM_SERVICE_SECRET is unset, and both execution gates WARN per allowed unauthenticated request. /api/token-chase/replay-call moved from the silent shared requireServiceSecretWhenConfigured to authorizeBotNodeInternalCall (same 401 semantics, warned fail-open). Pairs with compose de-publishing the bot-node host ports (127.0.0.1:30xx:5000 → expose-only).
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | BACKLOG "Bot-endpoint privilege model": /api/swarm-execute now runs the execute-time entitlement gate (bot-node-execute-entitlement.ts) AFTER the shared-secret gate — the secret authenticates the machine, the gate authorizes the END CALLER (userSub + direct:true interactive delegation) against the target bot via ADR-087 accessRoles + the operator allowlist. Internal/queue dispatch is untouched. Mode env OSHAL_EXECUTE_ENTITLEMENT: off default | warn | enforce; posture logged at startup next to the auth posture.
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Ran the /api/swarm-execute execution under runWithSystemIdentity (this process has no request-identity middleware): recordCost writes chat_tasks (FORCE-RLS), which the deny default would starve. Matches the SwarmAgentWorker path already systemized.
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Privilege-model rollout (BACKLOG "Bot-endpoint privilege model"): the entitlement gate's default mode flipped off → WARN in bot-node-execute-entitlement.ts (OSHAL_EXECUTE_ENTITLEMENT was wired nowhere, so 'off default' meant the built gate never ran anywhere) — comments here updated to match; no wiring change in this file. The warn→enforce flip stays an explicit operator env act.
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | ADR-034 gap close: mounted PUT /api/llm-provider (bot-node-llm-provider-route.ts) behind authorizeBotNodeCall — the endpoint BotNodeClient.switchProvider always targeted but which 404'd on every bot-node worker (ConfigSyncService.pushToBot returned pushed:false fleet-wide). A non-push change broadcasts up on swarm.config-change (X-Config-Source: oshal-push suppresses — echo-loop guard). Provider/model reporting (/api/health, swarm-execute + replay-call attribution defaults, startup logs) now reads the runtime's LIVE getActiveProvider() instead of boot-time consts, so a switch is immediately visible.
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | ADR-034 gap-b LIVE WIRING: /api/swarm-execute now forwards the carried providerId/model/configVersion (the controller's push-on-dispatch stamp) into the envelope payload so the execution handler reconciles the runtime before executing. Additive + type-guarded — absent/malformed fields are simply not forwarded (the handler's parseCarriedDispatchConfig then treats it as the legacy absent path). No behavior change unless the controller stamps them (OSHAL_PUSH_ON_DISPATCH).
 * 15 | maintainer@emeraldcoastsystemsgroup.com   | Added GET /metrics (Prometheus text exposition, @/shared/observability). The 2026-08-01 container-kill drill proved cAdvisor emits zero series for any docker container on Docker Desktop's containerd/overlayfs image store, so every container_last_seen rule matched nothing and SwarmContainerDown was a target-less standing false alarm. Each worker now IS a labelled scrape target, so `up == 0` identifies the exact container that went down and the restart/memory/CPU rules key on the process's own gauges.
 * 16 | maintainer@emeraldcoastsystemsgroup.com   | LIVE FIX (ADR-119 A2 drill, 2026-08-02): mounted POST /api/self-heal/apply. The endpoint was registered only from any-bot/server/app.js (BOT_RUNTIME=any-bot, which nothing in compose runs), so on the real self-healing node the controller's A2 remediation seam hit an HTML 404 and every unattended apply would have escalated apply-failed. Same registrar, second host — never a re-typed copy of a container-restarting endpoint.
 * 17 | maintainer@emeraldcoastsystemsgroup.com   | Require and consume single-use Ed25519 delegation tokens on /api/swarm-execute when public keys are configured, bind the signed identity to the local agent/body/task, and prohibit unsigned mesh execution in that posture.
 * 18 | maintainer@emeraldcoastsystemsgroup.com   | Route authorized HTTP execution through an import-safe system-identity seam so strict-RLS behavior can be exercised without importing the auto-starting server entrypoint.
 * 19 | maintainer@emeraldcoastsystemsgroup.com   | Reject invalid exact caller subjects and canonicalize HTTP task/workspace identifiers before constructing an execution envelope, keeping hostile path syntax out of logs and TaskController force paths.
 * 20 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: bot-node startup and every execution/control route now fail closed unless SWARM_SERVICE_SECRET is configured and exactly presented.
 * 21 | maintainer@emeraldcoastsystemsgroup.com   | Security hardening: authenticate every non-health request before JSON parsing, gate Claude auth status/import with strict machine auth, hide credential filesystem paths, and accept connector credentials only with a validated deterministic provider intent.
 * 22 | maintainer@emeraldcoastsystemsgroup.com   | Retire bot self-registration of UI tools because a fleet-wide service secret is not bot-bound authority for dynamic controller mutations; BOT_UI_* now emits a one-time operator/manifest-registration warning.
 * 23 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: Token Chase replay remains tool-free and now explicitly disables auto-approval so future tool additions cannot silently inherit approval authority.
 * 24 | maintainer@emeraldcoastsystemsgroup.com   | Forward the signed providerConfigRequired authority marker into swarm execution so missing provider records are distinguishable from intentional legacy dispatches and fail closed before task creation.
 * 25 | maintainer@emeraldcoastsystemsgroup.com   | Forward the validated app/capability/pattern prompt carrier from /api/swarm-execute into the execution envelope; malformed trusted configuration now fails closed at the HTTP boundary.
 */

/**
 * Bot Node Server — slim TypeScript entrypoint for swarm worker containers.
 *
 * Each bot node is a first-class swarm participant:
 *   - Consumes its own Redis envelopes via SwarmAgentWorker
 *   - Publishes heartbeats to oshal:runtime-agent:{agentId}
 *   - Executes LLM work via any-bot providers (ClineProvider, ClaudeCodeProvider)
 *   - Reports results back via work item updates
 *
 * Does NOT run: cockpit UI, OIDC, Plane sync, voice, queue manager, swagger.
 * Compiles to dist/app/bot-node-server.js via the existing tsconfig.server.json build.
 */

import express from 'express';
import { createChildLogger } from '@/shared/logger';
import { installProcessCrashGuards } from '@/shared/services/process-crash-guards';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { PROMETHEUS_CONTENT_TYPE, renderRuntimeMetrics } from '@/shared/observability';
import {
  RedisMeshTransport,
  AgentRuntimeRegistryService,
  MESH_CHANNELS,
  createMeshBidResponder,
} from '@/features/agent-management';
import { SwarmAgentWorker } from '@/features/swarm-orchestration';
import { getActiveRegistry } from '@/app/extensions/swarm/swarm-bot-registry';
import { seedAgentProfile } from '@/app/extensions/swarm/agent-profile-boot-seeder';
import { type AgentProfile } from '@/entities/agent';
import { createBotNodeRuntime } from './bot-node-runtime';
import { buildBotNodeHttpResponse } from './bot-node-http-response';
import {
  canonicalBotWorkspaceId,
  normalizeBotNodeUserSub,
  parseBotNodePromptCarrier,
  sanitizeBotNodeCreds,
} from './bot-node-request-scope';
import {
  authorizeBotNodeExecutionCall,
  authorizeBotNodeInternalCall,
  authorizeBotNodeBeforeBody,
  logBotNodeAuthPosture,
} from './bot-node-request-auth';
import {
  createExecuteEntitlementGate,
  logExecuteEntitlementPosture,
} from './bot-node-execute-entitlement';
import { parseTrustedProviderIntent } from './bot-node-provider-intent';
import { registerBotNodeLlmProviderRoute } from './bot-node-llm-provider-route';
import { registerBotNodeSelfHealRoute } from './bot-node-self-heal-route';
import { registerBotNodeClaudeAuthRoutes } from './bot-node-claude-auth-routes';
import {
  createBotNodeDelegationRuntime,
  getVerifiedDelegationClaims,
  prohibitUnsignedMeshExecution,
} from './bot-node-delegation';
import { runBotNodeExecutionWithSystemIdentity } from './bot-node-request-identity';

const logger = createChildLogger({ module: 'bot-node-server' });

// Optional shared-secret gate for the bot-node's privileged LLM-execution endpoints
// (bot-node-request-auth.ts, wrapping the shared authz middleware). Enforces
// SWARM_SERVICE_SECRET is mandatory: missing configuration fails startup/requests closed,
// while a missing or invalid caller credential returns 401.
// The controller's BotNodeClient sends the matching header via serviceSecretHeaders().
const authorizeBotNodeCall = authorizeBotNodeInternalCall;

async function start(): Promise<void> {
  // Before anything async runs. This runtime owns all LLM execution — CLI subprocesses, provider
  // HTTP, streams — so it has strictly more sources of stray rejections than the controller, which
  // has had these guards for far longer. Without them a bot node dies with no log line at all and
  // the restart policy hides it.
  installProcessCrashGuards('bot-node');
  logger.info('Starting bot node server...');
  // Security assertion: throws before worker/network setup if service auth is unconfigured.
  logBotNodeAuthPosture();
  // Execute-time entitlement posture (BACKLOG "Bot-endpoint privilege model"):
  // warn (default — log-only denial soak) | off (explicit opt-out) | enforce,
  // via OSHAL_EXECUTE_ENTITLEMENT.
  logExecuteEntitlementPosture();

  // ── Shared bot-node runtime ─────────────────────────────────────
  // Identity, Postgres (+GUC/RLS wrapper), repositories, the any-bot LLM provider
  // stack and the envelope execution handler all come from ONE construction path,
  // shared with the one-shot batch runner (bot-node-batch.ts, ADR-078 §1).
  const runtime = await createBotNodeRuntime();
  const {
    agentId, botName, pool, agentProfileRepository, workItemRepository,
    costTrackingService, ticketService, executionHandler, agenticController,
  } = runtime;
  // ADR-034: provider/model are LIVE — a PUT /api/llm-provider switch (controller
  // push-down or local change) must be visible immediately in /api/health and in every
  // response's provider/model attribution, so read through getActiveProvider() instead
  // of freezing the boot-time values into consts.
  const activeLlm = (): { provider: string; model: string } => runtime.getActiveProvider();

  // ── Redis mesh transport ────────────────────────────────────────
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const delegationRuntime = createBotNodeDelegationRuntime({ localAgentId: agentId, redisUrl });

  const meshTransport = new RedisMeshTransport({ redisUrl });

  // ── Agent registry (heartbeat) ──────────────────────────────────
  const registryService = new AgentRuntimeRegistryService({ redisUrl, ttlSeconds: 90 });

  // Seed agent profile in Postgres if available — via the SHARED boot seeder, which
  // upserts under this bot's RUNTIME agent id and reads selector_descriptor /
  // routing_keywords from the persona YAML (ADR-083). The old inline path used
  // repo.createAgent, which lets Postgres auto-generate the uuid — that minted ghost
  // rows that never matched the heartbeat id (observed live: two duplicate
  // general-bot rows, making the call-out's general fallback unreachable).
  let persistedProfile: AgentProfile | null = null;
  if (agentProfileRepository) {
    try {
      await seedAgentProfile(pool, runtime.identity);
      // System identity: this boot path has no request-identity middleware, and the day the
      // agents table gains an RLS policy a bare read here would be deny-stamped to nothing
      // (guc-strict fail-closed), silently blanking every bot's heartbeat role/capabilities.
      // seedAgentProfile is already wrapped; this follow-up read must be too (2026-07-24 review).
      persistedProfile = await runWithSystemIdentity(
        () => agentProfileRepository.getAgentProfile(agentId),
      ).catch(() => null);
    } catch (err) {
      logger.warn({ err, agentId }, 'Agent profile seed failed — non-blocking');
    }
  }

  const heartbeatRole = resolveHeartbeatRole(runtime.role, persistedProfile);
  const heartbeatCapabilities = resolveHeartbeatCapabilities(runtime.capabilities, persistedProfile);
  // ── Ticket terminal check ───────────────────────────────────────
  const isTicketTerminal = pool
    ? async (ticketId: string): Promise<boolean> => {
        const result = await pool!.query('SELECT status FROM tickets WHERE ticket_id = $1 LIMIT 1', [ticketId]);
        const status = result.rows[0]?.status as string | undefined;
        return status === 'complete' || status === 'escalated';
      }
    : undefined;

  // ── Swarm agent worker ──────────────────────────────────────────
  const primaryChannel = MESH_CHANNELS.agentDirect(agentId);
  const additionalChannels = [
    MESH_CHANNELS.broadcast,
    MESH_CHANNELS.capabilities,
    // Subscribe to bot name alias if different from agentId
    ...(botName !== agentId ? [MESH_CHANNELS.agentDirect(botName)] : []),
  ];

  const agentWorker = new SwarmAgentWorker({
    transport: meshTransport,
    channel: primaryChannel,
    consumerId: agentId,
    consumerGroup: 'swarm-execution',
    handler: prohibitUnsignedMeshExecution(delegationRuntime.enforcementEnabled, executionHandler),
    workItemRepository,
    additionalChannels,
    // ADR-083: ANSWER the queue manager's call-out. Without this, BID_REQUEST envelopes
    // hit the default direct handler and were silently dropped (responded: 0 on every
    // broadcast) — the node was registered on the mesh but mute. The responder
    // self-scores the ticket text against THIS bot's declared routing keywords +
    // capabilities and replies with a BID_RESPONSE on the requester's channel.
    directHandler: createMeshBidResponder({
      meshTransport,
      agentId,
      agentName: botName,
      capabilities: heartbeatCapabilities,
      personaPath: process.env.BOT_PERSONA_FILE,
    }),
    isTicketTerminal,
    updateTicketStatus: ticketService
      ? (ticketId, status, metadata) => ticketService.updateStatus(ticketId, status, metadata)
      : undefined,
    recordTicketActivity: ticketService
      ? (ticketId, metadata) => ticketService.recordActivity(ticketId, metadata)
      : undefined,
    recordTicketAssignment: ticketService
      ? async (ticketId, assignedAgentId, metadata) => {
          const phase = metadata.phase != null ? `phase-${metadata.phase}` : undefined;
          await Promise.all([
            ticketService.updateTicket(ticketId, { assignedAgentId }),
            ticketService.assignAgent(ticketId, assignedAgentId, 'worker', phase),
          ]);
        }
      : undefined,
  });

  // ── Heartbeat ───────────────────────────────────────────────────
  const publishHeartbeat = async () => {
    try {
      const now = new Date().toISOString();
      await registryService.upsertAgent({
        agentId,
        agentName: botName,
        status: 'online',
        capabilities: heartbeatCapabilities,
        role: heartbeatRole,
        aliases: runtime.identity.aliases,
        endpointUrl: runtime.identity.endpointUrl,
        internalEndpointUrl: runtime.identity.internalEndpointUrl,
        externalPort: runtime.identity.externalPort,
        startedAt: now,
        heartbeatAt: now,
      });
    } catch (err) {
      logger.warn({ err }, 'Heartbeat publish failed');
    }
  };
  await publishHeartbeat();
  const heartbeatInterval = setInterval(publishHeartbeat, 30_000);

  // ── Start worker ────────────────────────────────────────────────
  await agentWorker.start();
  logger.info(
    { agentId, botName, primaryChannel, additionalChannels, provider: activeLlm().provider, model: activeLlm().model },
    'SwarmAgentWorker started — consuming envelopes',
  );

  // ── Express health server ───────────────────────────────────────
  const app = express();
  // Authenticate privileged requests before buffering or parsing their bodies. Exact
  // GET health/metrics probes are the only deliberate public surface.
  app.use(authorizeBotNodeBeforeBody);
  app.use(express.json({ limit: '5mb' }));
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/health', (_req, res) => res.json({
    status: 'ok', runtime: 'bot-node', agentId, botName,
    provider: activeLlm().provider, model: activeLlm().model,
    timestamp: new Date().toISOString(),
  }));
  // Prometheus scrape target — the series the ADR-119 container-health rules key on.
  // Same exposure class as /health (process liveness, start time, CPU, RSS); no persona,
  // no workspace paths, no credentials. cAdvisor cannot see these containers at all on
  // Docker Desktop's containerd image store, so the worker reports its own health.
  app.get('/metrics', (_req, res) => {
    res.type(PROMETHEUS_CONTENT_TYPE).send(
      renderRuntimeMetrics({ runtime: 'bot-node', instance: botName }),
    );
  });

  // ── PUT /api/llm-provider — ADR-034 push-down target + broadcast-up trigger ──
  // The controller's ConfigSyncService.pushToBot → BotNodeClient.switchProvider PUTs
  // here (previously a 404 on every bot-node worker, so push-down was broken for the
  // whole default fleet). Applies via runtime.setActiveProvider (unknown provider →
  // 400, no switch); a change NOT marked X-Config-Source: oshal-push broadcasts up on
  // swarm.config-change so the controller reconciles it into the authoritative record.
  registerBotNodeLlmProviderRoute(app, {
    agentId,
    authorize: authorizeBotNodeCall,
    setActiveProvider: (provider, model) => runtime.setActiveProvider(provider, model),
    meshTransport,
  });

  // ── POST /api/self-heal/apply — ADR-119 A2 remediation seam ─────────────────
  // The controller's auto-apply engine reaches the self-healing node here. Mounted on
  // EVERY bot node deliberately: the handler is fail-closed on the service secret and
  // 403s off the self-healing node, so a visible 403 replaces an HTML 404 the controller
  // would otherwise read as an unreachable remediation arm.
  registerBotNodeSelfHealRoute(app);

  // Controller propagation/status targets. The import-safe registrar applies the strict
  // machine gate on the actual routes and never returns the mounted credential path.
  registerBotNodeClaudeAuthRoutes(app, { botName, agentId, authorize: authorizeBotNodeInternalCall });

  // ── /api/swarm-execute — sync HTTP dispatch from swarm controller ─────
  // The swarm controller's BotNodeClient calls this to push a pre-assembled
  // prompt to a specific bot for execution. We wrap the request in a synthetic
  // mesh envelope and run the same executionHandler the Redis worker uses,
  // then return a BotNodeResponse-shaped result.
  // Middleware order matters: authorizeBotNodeExecutionCall authenticates the
  // MACHINE (service secret); the entitlement gate then authorizes the END
  // CALLER (interactive userSub+direct delegation) against the target bot
  // (ADR-087 accessRoles + operator allowlist; OSHAL_EXECUTE_ENTITLEMENT mode).
  const executeEntitlementGate = createExecuteEntitlementGate({ defaultAgentId: agentId });
  app.post(
    '/api/swarm-execute',
    authorizeBotNodeExecutionCall,
    delegationRuntime.authorize,
    executeEntitlementGate,
    async (req, res) => {
    const startedAt = Date.now();
    const body = req.body as {
      text?: string;
      taskId?: string;
      workspaceFolderId?: string;
      agentId?: string;
      agenticMode?: boolean;
      direct?: boolean;
      userSub?: string;
      principalIssuer?: string;
      creds?: Record<string, string>;
      byoLlmConnection?: { baseUrl: string; apiKey: string; model: string };
      providerIntent?: unknown;
      // ADR-034 gap-b push-on-dispatch: the authoritative provider/model/configVersion and
      // required-authority marker the controller stamped on this dispatch (BotNodeRequest).
      // Forwarded into the envelope so the handler reconciles or refuses before executing.
      providerId?: unknown;
      model?: unknown;
      configVersion?: unknown;
      providerConfigRequired?: unknown;
      // Trusted prompt configuration carried by BotNodeRequest. These are validated before
      // promotion into the envelope; pattern is executable prompt authority, not user content.
      app?: unknown;
      capability?: unknown;
      pattern?: unknown;
    };
    if (!body || typeof body.text !== 'string'
      || typeof body.taskId !== 'string'
      || typeof body.workspaceFolderId !== 'string') {
      res.status(400).json({ success: false, error: 'Missing text/taskId/workspaceFolderId' });
      return;
    }
    const targetAgentId = body.agentId || agentId;
    const verifiedDelegation = getVerifiedDelegationClaims(res);
    let scopedUserSub: string | undefined;
    let canonicalTaskId: string;
    let workspaceScopeId: string;
    let promptCarrier: ReturnType<typeof parseBotNodePromptCarrier>;
    try {
      scopedUserSub = normalizeBotNodeUserSub(verifiedDelegation?.sub ?? body.userSub);
      canonicalTaskId = canonicalBotWorkspaceId(body.taskId);
      workspaceScopeId = canonicalBotWorkspaceId(body.workspaceFolderId);
      promptCarrier = parseBotNodePromptCarrier(body);
    } catch (error) {
      logger.warn({ err: error }, 'Rejected invalid swarm-execute identity, workspace scope, or prompt carrier');
      res.status(400).json({ success: false, error: 'invalid_execution_scope' });
      return;
    }
    const brokeredCreds = sanitizeBotNodeCreds(body.creds);
    const hasCredentialCarrier = Object.prototype.hasOwnProperty.call(body, 'creds');
    const hasProviderIntent = Object.prototype.hasOwnProperty.call(body, 'providerIntent');
    const providerIntent = parseTrustedProviderIntent(body.providerIntent);
    if (hasProviderIntent && !providerIntent) {
      res.status(400).json({ success: false, error: 'Invalid trusted provider intent' });
      return;
    }
    if (hasCredentialCarrier && !providerIntent) {
      res.status(400).json({ success: false, error: 'Connector credentials require a validated deterministic provider intent' });
      return;
    }
    const correlationId = `http-${canonicalTaskId}-${Date.now()}`;
    const envelope = {
      correlationId,
      fromAgentId: 'swarm-controller',
      toAgentId: targetAgentId,
      channel: MESH_CHANNELS.agentDirect(targetAgentId),
      payload: {
        text: body.text,
        workspaceTaskId: workspaceScopeId,
        workspaceFolderId: workspaceScopeId,
        externalId: body.taskId,
        agenticMode: body.agenticMode ?? true,
        direct: body.direct === true,
        userSub: scopedUserSub,
        ...(verifiedDelegation ? { principalIssuer: verifiedDelegation.principal_iss } : {}),
        // The controller is the only authority that resolves app prompt configuration. Preserve
        // the validated block across the HTTP hop so the bot can place it in TRUSTED CONFIGURATION.
        ...promptCarrier,
        // Credentials are accepted only for the schema-bounded deterministic provider
        // handler. They never enter the generic model/CLI environment or workspace.
        ...(providerIntent && Object.keys(brokeredCreds).length > 0 ? { creds: brokeredCreds } : {}),
        ...(providerIntent ? { providerIntent } : {}),
        // ADR-034 gap-b: forward the carried authoritative config plus its explicit required
        // marker. A required request with a blank/malformed providerId is refused as unavailable;
        // only a request without both marker and record is the intentional legacy path.
        ...(typeof body.providerId === 'string' ? { providerId: body.providerId } : {}),
        ...(typeof body.model === 'string' ? { model: body.model } : {}),
        ...(typeof body.configVersion === 'number' ? { configVersion: body.configVersion } : {}),
        ...(body.providerConfigRequired === true ? { providerConfigRequired: true } : {}),
        // Bring-Your-Own-LLM: caller's own OpenAI-compatible endpoint+key+model.
        // When present, the execution handler routes inference to it (cost tracked
        // under provider 'byo-llm') instead of the bot's configured provider.
        byoLlmConnection: body.byoLlmConnection,
      },
      messageType: 'request' as const,
    };
    try {
      // Bot-node HTTP execute is background work (no request identity middleware on this
      // process). Run under the SYSTEM sentinel so recordCost's chat_tasks write (FORCE-RLS)
      // keeps operator visibility once OSHAL_DB_GUC_STRICT denies the identity-less case —
      // matching the SwarmAgentWorker path, which already runs SYSTEM.
      const result = await runBotNodeExecutionWithSystemIdentity(() => executionHandler(envelope));
      const durationMs = Date.now() - startedAt;
      res.json(buildBotNodeHttpResponse(result, {
        durationMs,
        taskId: body.taskId,
        defaultModel: activeLlm().model,
        defaultProvider: activeLlm().provider,
      }));
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      logger.error({ err, taskId: body.taskId }, '/api/swarm-execute handler failed');
      res.status(500).json({
        success: false,
        response: '',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        cost: 0,
        model: activeLlm().model,
        provider: activeLlm().provider,
        durationMs,
        taskId: body.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── /api/token-chase/replay-call — single-call no-edit determinism replay ─────
  // The controller's TokenChaseReplayService calls this to re-fire ONE captured
  // frame's exact prompt (rehydrated history + system prompt) so the determinism
  // gate's LLM call lands here, on the accountable bot node — never on the
  // controller (ADR-046). Runs exactly one generateResponse: no agentic loop, no
  // tools. Cost is recorded under a `::replay` task id so it is attributable
  // without polluting the baseline task's chat_tasks rollup.
  app.post('/api/token-chase/replay-call', authorizeBotNodeCall, async (req, res) => {
    const body = req.body as { history?: unknown[]; systemPrompt?: string | null; taskId?: string; seq?: number; byoLlmConnection?: { baseUrl?: string; apiKey?: string; model?: string }; variantLabel?: string };
    // Live attribution defaults, pinned once per request so a mid-request provider
    // switch cannot mix two configs inside one response.
    const { provider: liveProvider, model: liveModel } = activeLlm();
    if (!Array.isArray(body.history)) {
      res.status(400).json({ success: false, content: '', error: 'Missing history[]', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, cost: 0, model: liveModel, provider: liveProvider, latencyMs: 0 });
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeOs = require('os'); // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodePath = require('path'); // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeFs = require('fs');
    const workspaceDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'tc-replay-'));
    const startedAt = Date.now();
    // Token Chase optimizer (ADR-046 step 3): a variant replay carries a byoLlmConnection so this ONE
    // call fires against a different OpenAI-compatible model — an ephemeral per-call swap (no
    // switchProvider, nothing persisted, safe to run repeatedly). A bare replay uses the bot's own
    // configured provider (the no-edit determinism baseline).
    const byo = body.byoLlmConnection;
    const isVariant = !!(byo && byo.baseUrl && byo.apiKey && byo.model);
    try {
      let provider: { generateResponse: (h: unknown[], o: Record<string, unknown>) => Promise<Record<string, unknown>> };
      if (isVariant) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const OpenAIProvider = require('../../any-bot/server/services/llm/OpenAIProvider');
        provider = new OpenAIProvider({ apiKey: byo!.apiKey, model: byo!.model, baseUrl: byo!.baseUrl });
        logger.info({ model: byo!.model, label: body.variantLabel }, 'Token Chase variant replay — ephemeral BYO provider');
      } else {
        provider = agenticController.getActiveProvider('token-chase-replay');
      }
      const response = await provider.generateResponse(body.history, {
        systemPrompt: body.systemPrompt || undefined,
        tools: [],
        workspaceDir,
        source: 'token-chase-replay',
        agentId,
        autoApprove: false,
      }) as { content?: string; usage?: { inputTokens?: number; outputTokens?: number }; cost?: number; model?: string; provider?: string };
      const latencyMs = Date.now() - startedAt;
      const usage = (response && response.usage) || {};
      const inputTokens = Number(usage.inputTokens || 0);
      const outputTokens = Number(usage.outputTokens || 0);
      // Accountable cost capture — the replay is a real LLM call, so it is recorded like any other.
      // Variant replays are tagged `::replay-variant` so optimizer spend never pollutes the baseline rollup.
      await costTrackingService.recordCost({
        taskId: `${body.taskId || 'token-chase'}::${isVariant ? 'replay-variant' : 'replay'}`,
        agentId,
        providerId: response.provider || liveProvider,
        modelId: response.model || liveModel,
        inputTokens, outputTokens,
        inputCost: 0, outputCost: 0, totalCost: Number(response.cost || 0),
        currency: 'USD', requestCount: 1,
      }).catch((err: unknown) => logger.error({ err }, 'Token Chase replay cost record failed'));
      res.json({
        success: true,
        content: response.content || '',
        usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
        cost: Number(response.cost || 0),
        model: response.model || liveModel,
        provider: response.provider || liveProvider,
        latencyMs,
      });
    } catch (err) {
      logger.error({ err, taskId: body.taskId, seq: body.seq }, '/api/token-chase/replay-call failed');
      res.status(500).json({
        success: false, content: '', error: err instanceof Error ? err.message : String(err),
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, cost: 0,
        model: liveModel, provider: liveProvider, latencyMs: Date.now() - startedAt,
      });
    } finally {
      try { nodeFs.rmSync(workspaceDir, { recursive: true, force: true }); } catch (err) { logger.warn({ err, workspaceDir }, 'Token Chase replay workspace cleanup failed'); }
    }
  });

  const port = parseInt(process.env.PORT || '5000', 10);
  app.listen(port, '0.0.0.0', () => {
    logger.info(`Bot node server running on port ${port}`);
    logger.info(`  Agent: ${botName} (${agentId})`);
    logger.info(`  Provider: ${activeLlm().provider} / ${activeLlm().model}`);
    logger.info(`  Channel: ${primaryChannel}`);

    if (process.env.BOT_UI_LABEL || process.env.BOT_UI_URL) {
      logger.warn(
        'BOT_UI_* self-registration is disabled: register bot UI metadata through an operator-approved manifest',
      );
    }
  });

  // ── Graceful shutdown ───────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down bot node');
    clearInterval(heartbeatInterval);
    await agentWorker.stop();
    await delegationRuntime.close();
    if (pool) await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

function resolveHeartbeatRole(fallbackRole: string, profile: AgentProfile | null): string {
  return readProfileString(profile?.persona?.role)
    ?? readProfileString(profile?.metadata?.role)
    ?? fallbackRole;
}

function resolveHeartbeatCapabilities(fallbackCapabilities: string[], profile: AgentProfile | null): string[] {
  const profileCapabilities = readProfileStringArray(profile?.baseCapabilities);
  return profileCapabilities.length > 0 ? profileCapabilities : fallbackCapabilities;
}

function readProfileString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readProfileStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

start().catch((err) => {
  // eslint-disable-next-line no-console -- standalone-process entrypoint: synchronous stderr crash line before process.exit (pino may not flush)
  console.error('Bot node server failed to start:', err);
  process.exit(1);
});
