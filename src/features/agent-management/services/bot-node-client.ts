/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — thin HTTP client for swarm-to-any-bot dispatch (any-bot-swarm-separation-design.md)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | switchProvider tags pushes with X-Config-Source: oshal-push so the bot does not send them back up as a broadcast (ADR-034)
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Token broker: BotNodeRequest.creds carries the caller's short-lived per-user access tokens (OSHAL_CRED_GOOGLE/OSHAL_CRED_TWITTER) so the bot uses a provided token instead of needing SESSION_SECRET to decrypt the connections table. Forwarded verbatim in the request body.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase step 2: replayCall() re-fires one captured prompt on the owning bot's /api/token-chase/replay-call so the no-edit determinism replay's LLM call lands on an accountable node, not the controller (ADR-046).
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Treat controller-inline registry entries as local-only so BotNodeClient does not POST /api/swarm-execute to the OIDC-protected API container.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Send serviceSecretHeaders() (X-Service-Secret from SWARM_SERVICE_SECRET) on the /api/swarm-execute + /api/token-chase/replay-call dispatches so the bot-node's optional shared-secret gate (authorizeBotNodeCall) accepts controller traffic. No-op when the secret is unset — matches the gate's fail-open default.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | ADR-090 skill-profile GENERAL carrier: BotNodeRequest gains optional app/capability/pattern. The controller resolves the app's domain profile ONCE (resolveSkillProfileByApp) and rides the pre-composed `pattern` block into the request body → envelope.payload → the bot-node handler, which appends it to the assembled prompt (bot holds no registry, ADR-036). All optional + backward-compatible — absent fields make the carrier a no-op. `execute` already JSON.stringify's the whole request, so the new fields ride automatically.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Dispatch timeout default 900000→3900000 (BOT_NODE_DISPATCH_TIMEOUT_MS): must OUTLIVE the bot-side 60-min execution ceiling (operator idle-timeout directive 2026-07-24) or the controller aborts work a bot is still legitimately doing at 15 min.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Idle-timeout follow-up (adversarial review): execute()/replayCall() moved off global fetch onto node:http/https (postJsonNoUndiciCeiling) — undici's ~5-min headersTimeout aborted dispatches at 5 min regardless of the raised 65-min timeoutMs, so a bot working up to the 60-min idle ceiling was cut off. http.request has no inactivity ceiling; the overall timeoutMs timer is the only bound (destroys the request as a TimeoutError). Mirrors postSendMessageNoTimeout in dispatch-manifest-worker.ts.
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Add resolveDisplayOnline(): the single display-layer online rule the cockpit/overview surfaces share. Inline/api-hosted bots (container oshal-api, e.g. dnd/spaces/security-analyst) never publish a heartbeat, so the heartbeat-only online check rendered every one of them OFFLINE even while working (dnd had 122 real runs). resolveDisplayOnline = hasHeartbeat OR (enabled AND isControllerInlineContainer(container)) — classify inline-ness from the LIVE registry container (the same predicate resolveBotNodeUrl dispatches on), NEVER agents.metadata.inlineControllerBot (a stale append-merged copy that mislabels the promoted trading-analyst node as inline). The `enabled` gate (DB status) keeps an operator-disabled inline bot offline so a disable action is honoured everywhere consistently. Routing/eligibility stays heartbeat-only, unchanged.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import { createChildLogger } from '@/shared/logger';
import { serviceSecretHeaders } from '@/shared/middleware/authz';
import type { TrustedProviderIntent } from '@/app/bot-node-provider-intent';
import type { SkillCapabilityId } from '@/shared/skill-profiles';

const logger = createChildLogger({ module: 'bot-node-client' });
const CONTROLLER_INLINE_CONTAINERS = new Set(['oshal-api', 'oshal-local-api']);

/** Minimal response shape from {@link postJsonNoUndiciCeiling}. */
interface RawHttpResponse {
  ok: boolean;
  status: number;
  text: string;
}

/**
 * @description POSTs JSON to a bot node over Node's http/https (NOT global fetch). A dispatch
 * legitimately waits for a bot that can run up to the 60-min harness idle ceiling; global fetch
 * (undici) enforces a ~5-min `headersTimeout` that would abort the wait long before the bot
 * replies (mirrors `postSendMessageNoTimeout` in dispatch-manifest-worker.ts, added for the same
 * reason). The raw http client has no inactivity ceiling, so the single overall `timeoutMs` timer
 * is the ONLY bound — it destroys the request with a `TimeoutError` when it elapses.
 * @param url - Full endpoint URL (http/https, host[:port], path).
 * @param body - JSON string body.
 * @param headers - Request headers (Content-Length is added).
 * @param timeoutMs - Overall runaway backstop; on elapse the request is destroyed.
 * @returns The status + full response text.
 */
function postJsonNoUndiciCeiling(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<RawHttpResponse> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const payload = Buffer.from(body, 'utf8');
    const req = client.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: { ...headers, 'Content-Length': payload.byteLength },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { data += c; });
        res.on('end', () => {
          clearTimeout(timer);
          const status = res.statusCode ?? 0;
          resolve({ ok: status >= 200 && status < 300, status, text: data });
        });
        res.on('error', (err) => { clearTimeout(timer); reject(err); });
      },
    );
    const timer = setTimeout(() => {
      const err = new Error(`bot node request exceeded ${timeoutMs}ms`);
      err.name = 'TimeoutError';
      req.destroy(err);
    }, timeoutMs);
    req.on('error', (err) => { clearTimeout(timer); reject(err); });
    req.write(payload);
    req.end();
  });
}

export function isControllerInlineContainer(container?: string | null): boolean {
  return CONTROLLER_INLINE_CONTAINERS.has((container ?? '').trim());
}

/**
 * @description The display-layer "is this bot online?" rule for cockpit/overview surfaces.
 * A bot is shown online when it has a live runtime heartbeat OR it is an inline/api-hosted bot.
 * Inline bots (container oshal-api/oshal-local-api — dnd, spaces, security-analyst, the drone/sat
 * operators, …) run in-process on THIS api and never publish a heartbeat, so the heartbeat-only
 * check wrongly renders them offline. When one of these handlers is executing, the api is up, so an
 * inline bot is by definition reachable. Classify inline-ness from the LIVE registry `container`
 * (the exact predicate resolveBotNodeUrl dispatches on), never from agents.metadata (a stale copy).
 * This is a DISPLAY rule only — routing/dispatch eligibility stays strictly heartbeat-based.
 * @param hasHeartbeat - Whether the bot has a live runtime-registry heartbeat.
 * @param container - The bot's registry container (from getActiveRegistry(), dynamic-inclusive).
 * @param enabled - Whether the operator has the bot enabled (DB status not inactive/disabled/paused).
 *   Defaults true. It gates ONLY the inline branch: a disabled inline bot reads offline, while a
 *   heartbeating bot always reads online (a disabled dedicated node is stopped, so it has no
 *   heartbeat anyway) — so dedicated-bot behaviour is unchanged and a disable action is honoured.
 * @returns True when the surface should paint the bot online.
 */
export function resolveDisplayOnline(
  hasHeartbeat: boolean,
  container?: string | null,
  enabled = true,
): boolean {
  if (hasHeartbeat) return true;
  return enabled && isControllerInlineContainer(container);
}

/**
 * @description Response shape from the any-bot's /api/swarm-execute endpoint.
 * The any-bot handles all LLM execution (credential management, CLI spawning,
 * token capture) and returns a structured result.
 */
export interface BotNodeResponse {
  success: boolean;
  response: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  cost: number;
  model: string;
  provider: string;
  durationMs: number;
  taskId?: string;
  error?: string;
  /** Post-model records captured by a trusted bot runtime; consumers must validate schemas. */
  providerRecords?: Array<Record<string, unknown>>;
}

/**
 * @description Request payload for any-bot swarm execution.
 */
export interface BotNodeRequest {
  text: string;
  taskId: string;
  workspaceFolderId: string;
  agentId: string;
  agenticMode?: boolean;
  /** Direct/interactive reasoning — skip swarm-ticket scaffolding on the bot. */
  direct?: boolean;
  providerId?: string;
  model?: string;
  /** Authenticated caller's OIDC sub — scopes the bot's per-user data access
   *  (e.g. which connected Gmail it may read) to THIS user. Threaded to the bot's
   *  CLI spawn env as OSHAL_USER_SUB. Omit only for non-user system dispatches. */
  userSub?: string;
  /** Token broker (security fix): short-lived, single-user access tokens the
   *  controller decrypted for THIS caller, as an env-key map (e.g.
   *  { OSHAL_CRED_GOOGLE, OSHAL_CRED_TWITTER }). The bot writes these into its
   *  per-request workspace as `.oshal-cred-<provider>` files and uses them
   *  directly — so it never needs SESSION_SECRET to read the connections table.
   *  Best-effort: a provider omitted here just means the bot's tool falls back to
   *  its existing DB-decrypt path. See connector-token-broker.ts. */
  creds?: Record<string, string>;
  /** Bring-Your-Own-LLM: the caller's own OpenAI-compatible endpoint+key+model
   *  (resolved by getUserLlmConnection). When set, the bot runs THIS request's
   *  inference on the user's endpoint instead of its configured provider; cost is
   *  tracked under provider 'byo-llm'. Omit to use the bot's default provider. */
  byoLlmConnection?: { baseUrl: string; apiKey: string; model: string };
  /** Server-authored, schema-bounded read-only provider operation. Never derived by a worker LLM. */
  providerIntent?: TrustedProviderIntent;
  /** ADR-090 skill-profile GENERAL carrier — the calling app's manifest name. Paired with
   *  `capability`, the controller resolves the app's domain profile (resolveSkillProfileByApp) ONCE
   *  and injects it (the bot never holds the registry — ADR-036). Omit for non-app calls: no-op. */
  app?: string;
  /** The profileable capability this call performs (e.g. `summarize`). With `app`, keys the
   *  controller-side profile resolution. Omit → the carrier is a no-op. */
  capability?: SkillCapabilityId;
  /** The RESOLVED, pre-composed skill-profile block (composeSkillProfilePrompt output). Set by the
   *  controller on the REMOTE path so it rides to the bot node in envelope.payload; the bot-node
   *  execution handler appends it to the assembled prompt in BOTH prompt branches. The inline path
   *  weaves the same block into `text` instead, so this stays unset there. Absent → no append. */
  pattern?: string;
  /** ADR-034 push-on-dispatch (gap b): the config record's version the controller stamped, carried
   *  for drift-logging. The provider/model it pairs with reuse the existing {@link providerId}/{@link model}
   *  fields; the bot-node compares them against its live active provider and self-corrects before
   *  executing (bot-node-dispatch-config.ts). Absent → legacy dispatch, runtime untouched. */
  configVersion?: number;
}

/**
 * @description Payload to re-fire a single captured Token Chase frame on its owning bot node. Carries
 * only the rehydrated prompt — the exact post-truncation history and system prompt that were sent —
 * so the bot reproduces the call without the controller ever touching an LLM.
 */
export interface ReplayCallRequest {
  history: unknown[];
  systemPrompt: string | null;
  taskId?: string;
  seq?: number;
  /** Token Chase optimizer (ADR-046 step 3): when set, the bot re-fires this ONE replay against
   *  the given OpenAI-compatible endpoint+key+model instead of its configured provider — an
   *  ephemeral per-call swap (no switchProvider, nothing persisted) so a captured call can be
   *  priced/graded on a different model. Resolved server-side from the user's encrypted BYO store
   *  (getUserLlmConnection) so the key never reaches the browser. Omit for a no-edit baseline replay. */
  byoLlmConnection?: { baseUrl: string; apiKey: string; model: string };
  /** Human-readable label for the variant lane (e.g. "gpt-5-mini", "local-llama") — returned back for the diff. */
  variantLabel?: string;
}

/**
 * @description Response from a bot node's /api/token-chase/replay-call — the freshly re-fired
 * response plus its accountable usage/cost, which the controller grades against the baseline.
 */
export interface ReplayCallResponse {
  success: boolean;
  content: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  cost: number;
  model: string | null;
  provider: string | null;
  latencyMs: number;
  error?: string;
}

/**
 * @description Resolves a bot node's HTTP endpoint URL from its agent ID.
 * Looks up the SwarmBotRegistry for container hostname and port.
 */
export type BotEndpointResolver = (agentId: string) => string | null;

export interface BotEndpointRegistryEntry {
  agentId?: string;
  name: string;
  port: number;
  container: string;
}

export type BotEndpointRegistryProvider = () => ReadonlyArray<BotEndpointRegistryEntry>;

/**
 * @description Thin HTTP client for dispatching work from the swarm controller
 * to any-bot nodes. This is the correct architecture boundary:
 *
 *   Swarm (orchestrator) → HTTP → Any-bot (execution runtime)
 *
 * The swarm assembles the full prompt (persona layers, handovers, awareness,
 * phase prompts) and sends it as text. The any-bot handles provider resolution,
 * CLI spawning, credential management, and cost capture.
 *
 * Per any-bot-swarm-separation-design.md: the swarm does NOT need
 * ClineHarnessProvider, ClineRuntimeConfigSyncService, or any credential
 * plumbing. The any-bot handles all of that internally.
 */
export class BotNodeClient {
  private readonly resolveEndpoint: BotEndpointResolver;
  private readonly timeoutMs: number;

  constructor(resolveEndpoint: BotEndpointResolver, timeoutMs?: number) {
    this.resolveEndpoint = resolveEndpoint;
    // The dispatch timeout must OUTLIVE the bot-side execution ceiling (60 min as of
    // the 2026-07-24 idle-timeout directive) or the controller aborts work the bot is
    // still legitimately doing. Default: ceiling + 5-min margin. Env override:
    // BOT_NODE_DISPATCH_TIMEOUT_MS.
    this.timeoutMs = timeoutMs
      ?? (process.env.BOT_NODE_DISPATCH_TIMEOUT_MS ? parseInt(process.env.BOT_NODE_DISPATCH_TIMEOUT_MS, 10) : undefined)
      ?? 3_900_000;
  }

  /**
   * @description Dispatches work to a any-bot node and returns the execution result.
   * The swarm sends the pre-assembled prompt; the any-bot executes via its own
   * provider stack (ClineProvider, ClaudeCodeProvider, BedrockProvider).
   *
   * @param agentId - Target bot's agent ID (used to resolve endpoint)
   * @param request - Execution request with assembled prompt
   * @returns Structured response with content, usage, and cost
   * @throws Error when the bot node is unreachable, returns an error, or times out
   */
  async execute(agentId: string, request: BotNodeRequest): Promise<BotNodeResponse> {
    const endpoint = this.resolveEndpoint(agentId);
    if (!endpoint) {
      throw new Error(`No endpoint found for agent ${agentId} — bot node may not be registered`);
    }

    const url = `${endpoint}/api/swarm-execute`;
    logger.info(
      { agentId, url, taskId: request.taskId, textLength: request.text.length },
      'Dispatching work to bot node',
    );

    // node:http, not fetch: undici's ~5-min headersTimeout would abort a dispatch to a bot
    // that legitimately runs up to the 60-min harness idle ceiling. this.timeoutMs is the only bound.
    try {
      const response = await postJsonNoUndiciCeiling(
        url,
        JSON.stringify(request),
        { 'Content-Type': 'application/json', ...serviceSecretHeaders() },
        this.timeoutMs,
      );

      if (!response.ok) {
        throw new Error(`Bot node returned ${response.status}: ${response.text || 'No response body'}`);
      }

      const result = JSON.parse(response.text) as BotNodeResponse;

      logger.info(
        {
          agentId,
          taskId: request.taskId,
          success: result.success,
          durationMs: result.durationMs,
          responseLength: result.response?.length ?? 0,
          cost: result.cost,
          model: result.model,
          provider: result.provider,
        },
        'Bot node execution completed',
      );

      if (!result.success) {
        throw new Error(`Bot node execution failed: ${result.error || 'Unknown error'}`);
      }

      return result;
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error(`Bot node execution timed out after ${this.timeoutMs}ms for agent ${agentId}`);
      }
      throw error;
    }
  }

  /**
   * @description Re-fires one captured prompt on a bot node for the Token Chase determinism gate.
   * The bot runs exactly one `generateResponse` over the rehydrated history+system prompt and returns
   * the fresh response with cost-tracked usage — keeping the replay's LLM call on an accountable node
   * (the controller never gains an LLM call, per ADR-046).
   * @param agentId - The bot that produced the captured frame (resolves the target endpoint).
   * @param request - The rehydrated prompt to re-fire.
   * @returns The fresh response plus usage/cost for grading against the baseline.
   * @throws Error when the bot node is unreachable or the HTTP call fails/times out.
   */
  async replayCall(agentId: string, request: ReplayCallRequest): Promise<ReplayCallResponse> {
    const endpoint = this.resolveEndpoint(agentId);
    if (!endpoint) {
      throw new Error(`No endpoint found for agent ${agentId} — replay must run on an accountable bot node`);
    }
    const url = `${endpoint}/api/token-chase/replay-call`;
    // node:http, not fetch — same undici headersTimeout reason as execute().
    try {
      const response = await postJsonNoUndiciCeiling(
        url,
        JSON.stringify(request),
        { 'Content-Type': 'application/json', ...serviceSecretHeaders() },
        this.timeoutMs,
      );
      if (!response.ok) {
        throw new Error(`Bot node replay returned ${response.status}: ${response.text || 'No response body'}`);
      }
      return JSON.parse(response.text) as ReplayCallResponse;
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error(`Bot node replay timed out after ${this.timeoutMs}ms for agent ${agentId}`);
      }
      throw error;
    }
  }

  /**
   * @description Check whether a remote endpoint exists for this agent.
   * Returns false when the bot is local to the current process (e.g. PM on swarm controller).
   * The caller should fall back to local execution when this returns false.
   */
  hasEndpoint(agentId: string): boolean {
    return this.resolveEndpoint(agentId) !== null;
  }

  /**
   * @description Returns the agent id of any bot node that currently has a resolvable endpoint, or null
   * when none do. Used as a fallback runner: a Token Chase replay needs SOME accountable bot harness to
   * fire on, not specifically the bot that produced the capture (which may be gone or unrecorded).
   * @returns A reachable agent id, or null.
   */
  firstReachableAgentId(): string | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getActiveRegistry } = require('../../../app/extensions/swarm/swarm-bot-registry');
      const registry = getActiveRegistry() as Array<{ agentId?: string }>;
      for (const entry of registry) {
        if (entry.agentId && this.hasEndpoint(entry.agentId)) return entry.agentId;
      }
    } catch {
      // registry unavailable — no fallback node
    }
    return null;
  }

  /**
   * @description Health check for a bot node.
   * @param agentId - Target bot's agent ID
   * @returns True if the node is healthy
   */
  async healthCheck(agentId: string): Promise<boolean> {
    const endpoint = this.resolveEndpoint(agentId);
    if (!endpoint) return false;

    try {
      const response = await fetch(`${endpoint}/api/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * @description Switches the provider/model on a bot node.
   * The any-bot's PUT /api/llm-provider handles all config file writes
   * (buildClineConfig, buildGlobalState, _ensureModelConfig).
   *
   * @param agentId - Target bot's agent ID
   * @param providerId - Provider to switch to
   * @param model - Model to use
   * @param credentials - Optional provider-specific credentials
   */
  async switchProvider(
    agentId: string,
    providerId: string,
    model?: string,
    credentials?: Record<string, string>,
  ): Promise<void> {
    const endpoint = this.resolveEndpoint(agentId);
    if (!endpoint) {
      throw new Error(`No endpoint found for agent ${agentId}`);
    }

    const response = await fetch(`${endpoint}/api/llm-provider`, {
      method: 'PUT',
      // X-Config-Source marks this as an OSHAL-originated push so the bot does NOT
      // broadcast it back up as a local change (ADR-034 feedback-loop guard).
      headers: { 'Content-Type': 'application/json', 'X-Config-Source': 'oshal-push' },
      body: JSON.stringify({ provider: providerId, model, credentials }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`Provider switch failed for ${agentId}: ${response.status} ${errorBody}`);
    }

    logger.info({ agentId, providerId, model }, 'Bot node provider switched');
  }

  /**
   * @description Reads a bot node's current provider/model from its health endpoint. Used by the Token
   * Chase optimizer to capture the live config before a variant switch so it can be restored after the
   * replay — the optimizer must leave the bot exactly as it found it.
   * @param agentId - Target bot's agent ID.
   * @returns The current `{ provider, model }`, or null when the node is unreachable.
   */
  async getProvider(agentId: string): Promise<{ provider: string | null; model: string | null } | null> {
    const endpoint = this.resolveEndpoint(agentId);
    if (!endpoint) return null;
    try {
      const response = await fetch(`${endpoint}/api/health`, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return null;
      const body = await response.json() as { provider?: string; model?: string };
      return { provider: body.provider ?? null, model: body.model ?? null };
    } catch {
      return null;
    }
  }
}

/**
 * @description Creates a BotEndpointResolver from the SwarmBotRegistry.
 * Resolves agent IDs to internal Docker network URLs (http://container:5000)
 * or external localhost URLs depending on topology.
 */
export function createRegistryEndpointResolver(
  getRegistry: BotEndpointRegistryProvider = loadActiveBotEndpointRegistry,
): BotEndpointResolver {
  return (agentId: string): string | null => {
    const registry = getRegistry();

    const entry = registry.find((b) => b.agentId === agentId);
    if (!entry) {
      logger.warn({ agentId }, 'Agent not found in bot registry');
      return null;
    }

    // If this bot is the current process (swarm controller doubles as PM),
    // return null so the execution handler falls back to local execution.
    // The PM bot runs on the same container as the swarm controller — it
    // doesn't have /api/swarm-execute because it runs dist/app/server.js,
    // not any-bot/server/swarm-node.js.
    const currentAgentId = process.env.AGENT_ID?.trim();
    const currentBotName = process.env.BOT_NAME?.trim();
    if (
      (currentAgentId && (entry.agentId === currentAgentId || entry.name === currentAgentId)) ||
      (currentBotName && entry.name === currentBotName)
    ) {
      logger.info({ agentId, botName: entry.name }, 'Bot is local to this process — using legacy local execution path');
      return null;
    }

    // Controller/API containers host inline orchestrator agents, not the
    // standalone any-bot HTTP runtime. They intentionally do not expose
    // /api/swarm-execute, so callers must use the local execution path.
    if (isControllerInlineContainer(entry.container)) {
      logger.info(
        { agentId, botName: entry.name, container: entry.container },
        'Bot is controller-inline - using legacy local execution path',
      );
      return null;
    }

    // In Docker: use internal container hostname.
    // On host: use localhost with mapped port.
    const isDocker = process.env.RUNNING_IN_DOCKER === 'true'
      || require('fs').existsSync('/.dockerenv');

    if (isDocker) {
      return `http://${entry.container}:5000`;
    }

    return `http://localhost:${entry.port}`;
  };
}

function loadActiveBotEndpointRegistry(): ReadonlyArray<BotEndpointRegistryEntry> {
  // Lazy require to avoid circular dependency at module load time.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getActiveRegistry } = require('../../../app/extensions/swarm/swarm-bot-registry');
  return getActiveRegistry() as ReadonlyArray<BotEndpointRegistryEntry>;
}
