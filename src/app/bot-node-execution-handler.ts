/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Token broker: merge payload.creds (caller's short-lived per-user access tokens, OSHAL_CRED_*) into the CLI spawn extraEnv alongside OSHAL_USER_SUB so the workspace writer drops them as .oshal-cred-<provider> files — the bot uses a provided token instead of decrypting oshal_connections with SESSION_SECRET.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Cost observability (migration 090): pass the already-measured execution durationMs into deps.recordCost so the per-call cost ledger row carries latency — the handler logged the duration but never billed it through, leaving trace llm-call spans cost-only.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-090 skill-profile GENERAL carrier: append payload.pattern (the controller-resolved, pre-composed profile block — the bot holds no registry, ADR-036) to the assembled prompt in BOTH branches. The direct/verbatim branch builds from payload.text; the LAYERED branch builds from persona layers + buildUserMessage(envelope), NOT payload.text — so pre-composing into `text` never reached the layered branch, which is exactly why the carrier ships the block separately. Newline-separated, no-op when absent.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Renamed the task-controller bridge parameter to anyBotTaskController: the identifier still carried the retired pre-OSHAL product name, contradicting the rename rollout the docs describe. Pure rename, no behavior change.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | ADR-034 gap-b LIVE WIRING (bot half): BEFORE executing, parse the optional provider/model/configVersion the controller stamped on this dispatch (parseCarriedDispatchConfig) and reconcile it against the live active provider (reconcileDispatchProviderConfig) through the injected dispatchConfigRuntime seam (bot-node-runtime's getActiveProvider/setActiveProvider). A drifted bot self-corrects before running; an un-switchable carried provider fails open. Absent seam OR absent carried config = the runtime is never touched (byte-identical legacy execution).
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Adversarial-review fix: the gap-b reconcile switched the SHARED active provider unconditionally, but the any-bot AgenticController resolves the provider live per-turn, so a concurrent dispatch could switch a running task mid-loop (silent provider swap + cost mis-attribution). Added an activeExecutions in-flight counter: the reconcile now only switches when this is the sole in-flight execution; otherwise it defers (logs) and runs on the current provider.
 */

/**
 * Bot Node Execution Handler — bridges OSHAL TypeScript envelope processing
 * to any-bot JavaScript LLM providers.
 *
 * This handler is used by bot node containers (BOT_RUNTIME=bot-node).
 * It reuses the prompt assembly functions from llm-execution-handler.ts
 * and delegates LLM execution to the any-bot TaskController in-process.
 *
 * Per any-bot-swarm-separation-design.md:
 *   - Prompt assembly (persona layers, handovers, awareness) = OSHAL TS
 *   - LLM execution (CLI spawning, credentials, cost capture) = any-bot JS
 */

import { createChildLogger } from '@/shared/logger';
import type { AgentProfileRepository } from '@/entities/agent';
import type { MeshEnvelope, PersonaLayerStore, SwarmMemoryService } from '@/features/agent-management';
import {
  buildUserMessage,
  loadPersonaLayers,
  assemblePromptForAnyBot,
  buildFilePersonaLayer,
  buildHandoverLayers,
  buildSwarmAwarenessLayer,
  buildSwarmMemoryLayer,
  buildFallbackProfile,
  buildPhasePersonaOverride,
  deriveExecutionScopeId,
  RALFHandoverManager,
  type EnvelopeExecutionResult,
  type CostRecordFn,
} from '@/features/swarm-orchestration';
import type { TicketService } from '@/features/ticketing';
import { normalizeBotNodeUserSub, sanitizeBotNodeCreds } from './bot-node-request-scope';
import {
  executeTrustedProviderIntent,
  parseTrustedProviderIntent,
  type TrustedProviderExecutionResult,
} from './bot-node-provider-intent';
import {
  parseCarriedDispatchConfig,
  reconcileDispatchProviderConfig,
  type DispatchConfigRuntime,
} from './bot-node-dispatch-config';

const logger = createChildLogger({ module: 'bot-node-execution-handler' });

/**
 * Count of executions currently in flight on THIS bot-node process. Read by the ADR-034 gap-b
 * reconcile to avoid switching the shared active provider while a concurrent task is mid-loop
 * (the any-bot AgenticController resolves the provider live per-turn). Single-threaded event loop,
 * so ++/-- around the async body is a correct concurrency counter.
 */
let activeExecutions = 0;

/**
 * @description Dependency bundle injected into the bot-node execution handler.
 * It carries the in-process any-bot TaskController plus the optional OSHAL
 * services needed to assemble prompts (profiles, persona layers, swarm memory,
 * handovers), capture cost, and link work to tickets — so a single handler can
 * run an envelope end-to-end without reaching out over HTTP. The required
 * provider/model fields identify which any-bot runtime is active for logging,
 * cost attribution, and prompt assembly decisions.
 */
export interface BotNodeExecutionDeps {
  /** Any-bot TaskController instance (JavaScript, loaded via require()) */
  anyBotTaskController: {
    getTask(taskId: string): Promise<{ id: string; userSub?: string | null } | null>;
    createTask(title: string, mode: string, opts?: { forceTaskId?: string; userSub?: string }): Promise<{ id: string }>;
    processMessage(taskId: string, msg: { text: string }, opts: Record<string, unknown>): Promise<{
      messages?: Array<{ say: string; text?: string }>;
      apiMetrics?: { totalCost?: number; totalTokens?: number };
      /** Actual provider/model reported by the provider response for the final turn. */
      provider?: string | null;
      model?: string | null;
      /** Post-model provider evidence captured from trusted runtime command events. */
      providerRecords?: Array<Record<string, unknown>>;
    }>;
  };
  agentProfileRepository?: AgentProfileRepository;
  personaLayerStore?: PersonaLayerStore;
  swarmMemoryService?: SwarmMemoryService;
  handoverManager?: RALFHandoverManager;
  personaDir?: string;
  recordCost?: CostRecordFn;
  ticketService?: TicketService;
  /** The active provider name from the any-bot runtime (e.g. 'cline-cli', 'claude-code') */
  providerName: string;
  /** The active model from the any-bot runtime */
  modelName: string;
  /**
   * ADR-034 gap-b push-on-dispatch (bot half): the live provider seam
   * (bot-node-runtime's getActiveProvider/setActiveProvider). When present, a dispatch
   * that carried an authoritative provider/model record is reconciled against the active
   * provider BEFORE executing — a drifted bot self-corrects. Absent → the runtime is never
   * touched (legacy execution); the reconciliation is otherwise fail-open.
   */
  dispatchConfigRuntime?: DispatchConfigRuntime;
  /** Test seam for the bounded, model-independent provider executor. */
  executeProviderIntent?: (
    intent: unknown,
    context: { userSub?: string; creds: Record<string, string> },
  ) => Promise<TrustedProviderExecutionResult>;
}

/**
 * Creates an envelope execution handler that uses the any-bot provider stack.
 * Reuses all OSHAL prompt assembly logic; delegates LLM execution to any-bot TaskController.
 */
export function createBotNodeExecutionHandler(
  deps: BotNodeExecutionDeps,
): (envelope: MeshEnvelope) => Promise<EnvelopeExecutionResult> {
  return async (envelope: MeshEnvelope): Promise<EnvelopeExecutionResult> => {
    const agentId = envelope.toAgentId;
    const payload = envelope.payload as Record<string, unknown> | undefined;
    // Direct/interactive reasoning call (not a swarm ticket): skip the swarm
    // orchestration layers (handover / awareness / swarm-memory). A lean reasoner
    // persona correctly treats that ticket scaffolding as out-of-place noise.
    const direct = payload?.direct === true;
    // Per-user scoping: the authenticated caller's OIDC sub. Threaded into the
    // CLI spawn env (OSHAL_USER_SUB) so shelled-out tools (oshal-gmail.js) act
    // ONLY for this user's own connected accounts — never another user's.
    const userSub = normalizeBotNodeUserSub(payload?.userSub);
    // Token broker: short-lived per-user access tokens the controller decrypted for this
    // caller (e.g. { OSHAL_CRED_GOOGLE, OSHAL_CRED_TWITTER }). Threaded through extraEnv so
    // the workspace writer drops them as .oshal-cred-<provider> files; the bot's tool reads
    // the file and skips DB decryption — removing its need for SESSION_SECRET.
    const creds = sanitizeBotNodeCreds(payload?.creds);
    const hasProviderIntent = Boolean(payload && Object.prototype.hasOwnProperty.call(payload, 'providerIntent'));
    const providerIntent = parseTrustedProviderIntent(payload?.providerIntent);
    // Bring-Your-Own-LLM: the caller's own OpenAI-compatible endpoint+key+model,
    // resolved by the controller (getUserLlmConnection). When present, inference for
    // this request runs on the user's endpoint (any-bot TaskController routes through
    // an OpenAIProvider) instead of the bot's configured provider.
    const byoLlmConnection = (payload?.byoLlmConnection && typeof payload.byoLlmConnection === 'object')
      ? (payload.byoLlmConnection as { baseUrl: string; apiKey: string; model: string }) : undefined;
    const workspaceTaskId = payload?.workspaceTaskId ? String(payload.workspaceTaskId) : undefined;
    const originalTicket = typeof payload?.originalTicket === 'object' && payload?.originalTicket !== null
      ? payload.originalTicket as Record<string, unknown> : undefined;
    const ticketExternalId = payload?.externalId ? String(payload.externalId) : undefined;
    const originalExternalId = typeof originalTicket?.externalId === 'string' ? originalTicket.externalId : undefined;
    const parentExternalId = typeof originalTicket?.parentExternalId === 'string' ? originalTicket.parentExternalId : undefined;
    const baseTaskId = workspaceTaskId || originalExternalId || ticketExternalId || `swarm-${envelope.correlationId}`;
    const taskId = `${baseTaskId}::${agentId}`;
    const workspaceFolderId = baseTaskId;

    const reviewRound = payload?.round ? Number(payload.round) : undefined;
    const isReview = payload?.type === 'verification-request' || payload?.type === 'review-request';
    const executionScopeId = deriveExecutionScopeId(
      ticketExternalId || '', parentExternalId || workspaceTaskId, isReview ? reviewRound : undefined,
    );
    const execStart = Date.now();

    // ADR-034 gap-b concurrency guard: count this invocation as in-flight so the reconcile below
    // only switches the SHARED active provider when nothing else is executing on this bot node
    // (the any-bot AgenticController resolves the provider live per-turn, so a mid-flight switch by
    // a concurrent dispatch would silently change a running task's provider + mis-attribute its cost).
    activeExecutions += 1;
    try {
      if (hasProviderIntent && !providerIntent) throw new Error('Invalid trusted provider intent');
      // ── Prompt assembly ──
      // Direct/interactive reasoning: pass ONLY the caller's text. The provider
      // loads the bot's (lean) persona itself, so we add no swarm persona layers,
      // no file-persona "read your context" scaffolding, and no phase/handover
      // execution framing — all of which a reasoner reads as out-of-place noise
      // (it flags them as a prompt injection against its real role).
      let assembledPrompt: string;
      let layerCount = 0;
      if (direct) {
        assembledPrompt = String(payload?.text ?? '');
      } else {
        const profile = deps.agentProfileRepository
          ? await deps.agentProfileRepository.getAgentProfile(agentId) : null;
        const personaLayers = await loadPersonaLayers(agentId, envelope, deps.personaLayerStore);

        const agentDisplayName = profile?.name || agentId;
        const payloadType = payload?.type ? String(payload.type) : '';
        const reviewRole = payload?.role ? String(payload.role) : 'reviewer';
        const filePersonaLayer = buildPhasePersonaOverride(payloadType, agentId, agentDisplayName, reviewRole)
          ?? buildFilePersonaLayer(agentId, agentDisplayName, workspaceFolderId, deps.personaDir);
        if (filePersonaLayer) personaLayers.unshift(filePersonaLayer);

        const swarmMemoryLayer = await buildSwarmMemoryLayer(envelope, deps.swarmMemoryService);
        if (swarmMemoryLayer) personaLayers.push(swarmMemoryLayer);

        const handoverLayers = buildHandoverLayers(envelope, agentId, deps.handoverManager, executionScopeId);
        personaLayers.push(...handoverLayers);

        const awarenessLayer = buildSwarmAwarenessLayer(envelope, agentId);
        if (awarenessLayer) personaLayers.push(awarenessLayer);

        const userMessage = buildUserMessage(envelope);
        assembledPrompt = assemblePromptForAnyBot(personaLayers, userMessage);
        layerCount = personaLayers.length;
      }

      // ADR-090 skill-profile GENERAL carrier: the controller resolved this app's domain profile for
      // the capability and shipped the pre-composed block as payload.pattern (the bot holds no
      // skill-profile registry — resolution is controller-side, ADR-036). Append it to the assembled
      // prompt in BOTH branches. The layered branch above builds from persona layers + the envelope's
      // user message, NEVER from payload.text — so pre-composing the profile into `text` would never
      // reach it, which is the whole reason the carrier ships the block on its own field. No-op absent.
      const skillProfilePattern = typeof payload?.pattern === 'string' ? payload.pattern.trim() : '';
      if (skillProfilePattern) {
        assembledPrompt = `${assembledPrompt}\n${skillProfilePattern}`;
      }

      logger.info(
        { correlationId: envelope.correlationId, agentId, taskId, direct, layerCount, promptLength: assembledPrompt.length },
        'Executing envelope via any-bot provider (in-process)',
      );

      // ── ADR-034 gap-b push-on-dispatch reconciliation (BEFORE any LLM work) ──
      // The controller may have stamped this dispatch with the authoritative
      // provider/model/configVersion (bot-node-server forwards them into the payload).
      // Compare against the live active provider and self-correct a divergent bot before
      // executing. No seam OR no carried config → the runtime is never touched (legacy);
      // an un-switchable carried provider fails open (logged, executes self-resolved).
      if (deps.dispatchConfigRuntime) {
        const carriedConfig = parseCarriedDispatchConfig(payload);
        if (carriedConfig) {
          // Only reconcile when THIS is the sole in-flight execution (activeExecutions === 1, our own):
          // switching the shared provider while another task is mid-loop would corrupt it. When busy,
          // run on the current provider and log the deferral rather than risk a concurrent-task switch.
          if (activeExecutions <= 1) {
            reconcileDispatchProviderConfig(carriedConfig, deps.dispatchConfigRuntime, { taskId });
          } else {
            logger.warn(
              { taskId, activeExecutions, carriedProvider: carriedConfig.providerId },
              'ADR-034: deferring dispatch provider reconcile — another execution is in flight on this bot node',
            );
          }
        }
      }

      // ── LLM execution (any-bot JavaScript — in-process, no HTTP) ──
      // NOTE: the model-gateway gate is NOT here. It lives at the any-bot
      // provider layer (generateResponse → llmGate pre-flight to the controller's
      // /api/llm-governance/check), so it covers EVERY any-bot LLM path (this
      // handler, the AgenticController loop, and the app.js one-shot ticket path)
      // at one chokepoint — and gating here too would double-count quota.
      const effectiveTaskId = workspaceFolderId || taskId;
      let task: { id: string };
      try {
        const existing = await deps.anyBotTaskController.getTask(effectiveTaskId);
        if (existing) {
          assertExistingTaskOwner(existing, userSub);
          task = { id: effectiveTaskId };
        } else {
          // ADR-060: thread the owner so the bot writes into <root>/users/<sub>/<taskId>.
          task = await deps.anyBotTaskController.createTask(`Swarm execution for ${agentId}`, 'act', { forceTaskId: effectiveTaskId, userSub });
          if (task.id !== effectiveTaskId) task.id = effectiveTaskId;
        }
      } catch (error) {
        if (isTaskOwnerMismatch(error)) throw error;
        task = await deps.anyBotTaskController.createTask(`Swarm execution for ${agentId}`, 'act', { userSub });
      }

      // Honor the requested mode (was hardcoded true). A direct reasoning request
      // (e.g. summarize/draft) passes agenticMode:false to skip the tool loop —
      // which otherwise non-deterministically emits an unparseable tool call.
      const agenticMode = payload?.agenticMode !== undefined ? Boolean(payload.agenticMode) : true;
      // Provider-bound Jarvis handoffs are exact read operations, not reasoning tasks. Execute the
      // server-authored operation directly and return a deterministic completion. This removes the
      // worker LLM (and its quota/failover state) from the trusted-record path entirely.
      const providerResult = providerIntent
        ? await (deps.executeProviderIntent ?? executeTrustedProviderIntent)(providerIntent, { userSub, creds })
        : undefined;
      const result = providerResult
        ? {
          messages: [{ say: 'completion_result', text: providerResult.completion }],
          apiMetrics: { totalCost: 0, totalTokens: 0 },
          providerRecords: providerResult.providerRecords,
          provider: 'deterministic-provider',
          model: 'none',
        }
        : await deps.anyBotTaskController.processMessage(task.id, { text: assembledPrompt }, {
          agenticMode,
          autoApprove: { 'use_mcp_tool': true },
          source: 'swarm-dispatch',
          byoLlmConnection, // caller's own endpoint drives inference when present
          extraEnv: (userSub || Object.keys(creds).length)
            ? { ...creds, ...(userSub ? { OSHAL_USER_SUB: userSub } : {}) }
            : undefined,
        });

      const durationMs = Date.now() - execStart;
      // Runtime accountability is structured out-of-band data from TaskController.
      // Request payload fields and assistant text never participate in this choice.
      const runtimeIdentity = result as { provider?: unknown; model?: unknown };
      const actualProvider = normalizeRuntimeIdentity(runtimeIdentity.provider, 128) ?? deps.providerName;
      const actualModel = normalizeRuntimeIdentity(runtimeIdentity.model, 256) ?? deps.modelName;

      // Extract response — the LATEST turn's output only. A reused session task (Jarvis's continuous
      // thread) accumulates every turn's messages, and processMessage returns the FULL list; joining
      // them all made each reply re-read + concatenate the whole conversation. Take the last
      // completion (or last text) so each turn shows just its own answer; the prior turns still live
      // in the task for the model's context.
      let content = '';
      if (result.messages && result.messages.length > 0) {
        // Any non-empty completion/text message is a real answer (noise has other `say` values like
        // api_req_started/reasoning). Don't length-filter, or short replies ("Yes.", "PELICAN") get
        // dropped to the "Execution completed." fallback.
        const completions = result.messages.filter(m => m.say === 'completion_result' && m.text && m.text.trim().length > 0);
        if (completions.length > 0) {
          content = completions[completions.length - 1].text!;
        } else {
          const textMsgs = result.messages.filter(m => m.say === 'text' && m.text && m.text.trim().length > 0);
          content = textMsgs.length > 0 ? textMsgs[textMsgs.length - 1].text! : 'Execution completed.';
        }
      }

      logger.info(
        { correlationId: envelope.correlationId, agentId, taskId, contentLength: content.length, durationMs, provider: actualProvider, model: actualModel },
        'Any-bot execution completed',
      );

      // Record cost — the bot owns cost capture (HTTP callers must NOT double-record).
      const apiMetrics = result.apiMetrics || {};
      if (deps.recordCost) {
        try {
          await deps.recordCost({
            taskId, agentId,
            providerId: actualProvider,
            modelId: actualModel,
            inputTokens: apiMetrics.totalTokens || 0, outputTokens: 0,
            inputCost: 0, outputCost: 0, totalCost: apiMetrics.totalCost || 0,
            currency: 'USD', ticketExternalId,
            ownerSub: userSub, // per-owner budget attribution (Phase 2)
            durationMs, // measured above — lands per-call latency on the 090 ledger columns
          });
        } catch (err) {
          logger.warn({ err, taskId }, 'Cost recording failed — non-blocking');
        }
      }

      // Link task to ticket for cost rollup (ADR-027) — only when the UUID is a REAL persisted ticket.
      // The Jarvis simple-work flow (jarvis-work-*) deliberately runs WITHOUT a ticket, so its
      // externalId UUID has no row in `tickets`; linking it would throw a (caught but noisy) FK
      // violation on ticket_task_links_ticket_id_fkey for no gain. Guard with an existence check.
      if (deps.ticketService && ticketExternalId) {
        try {
          const uuidMatch = ticketExternalId.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
          if (uuidMatch && (await deps.ticketService.getTicket(uuidMatch[1]))) {
            await deps.ticketService.linkTask(uuidMatch[1], taskId, 'swarm-execution');
          }
        } catch (err) {
          logger.warn({ err, taskId }, 'Ticket link failed — non-blocking');
        }
      }

      // Expose response/cost/usage/provider so the /api/swarm-execute HTTP wrapper
      // (BotNodeResponse) relays them — previously only `content` was set, leaving
      // every HTTP caller with an empty response + cost 0.
      const output = {
        agentId,
        taskId,
        content,
        response: content,
        providerRecords: Array.isArray(result.providerRecords)
          ? result.providerRecords.filter((record) => record && typeof record === 'object').slice(0, 8)
          : [],
        cost: apiMetrics.totalCost || 0,
        usage: {
          inputTokens: apiMetrics.totalTokens || 0,
          outputTokens: 0,
          totalTokens: apiMetrics.totalTokens || 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        model: actualModel,
        provider: actualProvider,
      };
      const providerFailure = detectProviderFailure(content);
      if (providerFailure) {
        return {
          success: false,
          error: providerFailure,
          output,
        };
      }

      return {
        success: true,
        output,
      };
    } catch (error) {
      const durationMs = Date.now() - execStart;
      logger.error(
        { err: error, correlationId: envelope.correlationId, agentId, taskId, durationMs },
        'Bot node execution failed',
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown execution error',
      };
    } finally {
      activeExecutions -= 1;
    }
  };
}

function assertExistingTaskOwner(
  task: { userSub?: string | null },
  requestedUserSub: string | undefined,
): void {
  const taskOwner = normalizeBotNodeUserSub(task.userSub);
  if (taskOwner === requestedUserSub) return;
  const error = new Error('Task owner mismatch') as Error & { code?: string };
  error.code = 'TASK_OWNER_MISMATCH';
  throw error;
}

function normalizeRuntimeIdentity(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) return undefined;
  return normalized;
}

function isTaskOwnerMismatch(error: unknown): boolean {
  return Boolean(error && typeof error === 'object'
    && (error as { code?: unknown }).code === 'TASK_OWNER_MISMATCH');
}

function detectProviderFailure(content: string): string | undefined {
  for (const pattern of PROVIDER_FAILURE_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      return match[0];
    }
  }
  return undefined;
}

const PROVIDER_FAILURE_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:Claude Code|Cline|Codex|Gemini)[\w\s-]*CLI encountered an error[:\w\s-]*/i,
  /(?:Claude Code|Cline|Codex|Gemini)[\w\s-]*CLI error[:\w\s-]*/i,
  /CLI stalled[\w\s-]*/i,
  /INACTIVITY CIRCUIT BREAKER/i,
  /Command failed with exit code \d+/i,
  /runtime failed before completion[:\w\s-]*/i,
  /401 Unauthorized|403 Forbidden|unauthorized|failed to connect to websocket/i,
  /429|too many requests|rate[-\s]?limit|quota|throttl\w*|ResourceExhausted|ThrottlingException/i,
];
