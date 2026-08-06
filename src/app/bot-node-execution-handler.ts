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
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Comment accuracy at the owner-stamping call: it claimed ADR-060's per-user path layout ("the bot writes into <root>/users/<sub>/<taskId>"), which was reverted — the dir is flat <root>/<taskId>. Restated why the stamp is load-bearing regardless: assertExistingTaskOwner has nothing to compare against on the NEXT dispatch if userSub is dropped, and TaskController's forceTaskId branch carries no owner assert of its own. Behavior unchanged; the check is now pinned by tests/unit/bot-node-workspace-owner-binding.spec.ts.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Preserve exact owners and canonicalize every envelope-derived workspace identifier before TaskController lookup or forceTaskId use; security refusals cannot fall back to a different workspace.
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: use the trust-separated prompt builder for direct and layered calls, with the exact server user/ticket/tool/scope binding appended last.
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 audit: bind bot-node memory retrieval to the exact non-operator user, tenant, and canonical workspace.
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 audit: keep connector credentials in deterministic server-side brokers; autonomous model execution receives only the exact caller subject.
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: reject unbrokered Cline, Claude Code, and Codex providers in preflight before task lookup/creation; only deterministic intents, BYO hosted inference, or a hosted/brokered provider may accept work.
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | Security hardening: reject every generic credential carrier, consume credentials only in validated deterministic provider intents, and finish those intents before persona/memory/task creation so no model-visible work or hidden task side effect occurs.
 * 15 | maintainer@emeraldcoastsystemsgroup.com   | Enforce authoritative dispatch pins fail-closed: refuse missing records/seams and concurrent mismatches before task creation, and report the effective config source/action/version in every successful result.
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
  buildSwarmMemoryLayers,
  buildFallbackProfile,
  buildPhasePersonaOverride,
  resolvePromptAuthorityBinding,
  deriveExecutionScopeId,
  RALFHandoverManager,
  type EnvelopeExecutionResult,
  type CostRecordFn,
  type PromptAuthorizationResolver,
} from '@/features/swarm-orchestration';
import type { TicketService } from '@/features/ticketing';
import {
  canonicalBotWorkspaceId,
  normalizeBotNodeUserSub,
  sanitizeBotNodeCreds,
} from './bot-node-request-scope';
import {
  executeTrustedProviderIntent,
  parseTrustedProviderIntent,
  type TrustedProviderExecutionResult,
} from './bot-node-provider-intent';
import {
  AuthoritativeDispatchConfigError,
  dispatchConfigMatchesActive,
  parseCarriedDispatchConfig,
  reconcileDispatchProviderConfig,
  type DispatchConfigReconciliation,
  type DispatchConfigRuntime,
} from './bot-node-dispatch-config';

const logger = createChildLogger({ module: 'bot-node-execution-handler' });
const UNBROKERED_AUTONOMOUS_PROVIDERS = new Set([
  'cline', 'cline-cli', 'claude', 'claude-code', 'codex', 'codex-cli', 'openai-codex',
]);

/**
 * @description Refuse autonomous CLI harnesses before a task/workspace is accepted. These
 * providers own an internal tool loop, can read their credential home, and cannot revalidate
 * OSHAL's exact handler generation/scopes. A deterministic provider intent and a caller's BYO
 * hosted endpoint bypass the local CLI entirely and are therefore admissible.
 */
export function assertUnattendedProviderPreflight(input: {
  providerName: unknown;
  deterministicIntent?: boolean;
  byoHostedInference?: boolean;
}): void {
  if (input.deterministicIntent === true || input.byoHostedInference === true) return;
  const providerName = typeof input.providerName === 'string'
    ? input.providerName.trim().toLowerCase() : '';
  if (!UNBROKERED_AUTONOMOUS_PROVIDERS.has(providerName)) return;
  const error = new Error(
    `${providerName} is an unbrokered autonomous CLI; unattended execution requires a hosted provider or audited brokered sandbox`,
  );
  (error as Error & { code?: string }).code = 'UNBROKERED_AUTONOMOUS_PROVIDER';
  throw error;
}

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
  /** Server-owned enabled-tool and scope resolver for the final prompt authority block. */
  resolvePromptAuthorization?: PromptAuthorizationResolver;
  /** The active provider name from the any-bot runtime (e.g. 'cline-cli', 'claude-code') */
  providerName: string;
  /** The active model from the any-bot runtime */
  modelName: string;
  /**
   * ADR-034 gap-b push-on-dispatch (bot half): the live provider seam
   * (bot-node-runtime's getActiveProvider/setActiveProvider). When present, a dispatch
   * that carried an authoritative provider/model record is reconciled against the active
   * provider BEFORE executing — a drifted bot self-corrects. Absent → the runtime is never
   * touched (legacy execution). A carried/required authority that cannot be enforced is
   * refused before task creation.
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
    // Exact authenticated owner identity. This binds memory, workspaces, and audited
    // server operations; it is not authority to place connector secrets in a CLI.
    const userSub = normalizeBotNodeUserSub(payload?.userSub);
    const tenantId = optionalExactContextId(payload?.tenantId ?? payload?.tenant_id, 'tenantId');
    // Credentials are parsed only for the deterministic provider-intent executor below.
    // They are never passed to TaskController, a child environment, or a workspace.
    const creds = sanitizeBotNodeCreds(payload?.creds);
    const hasCredentialCarrier = Boolean(payload && Object.prototype.hasOwnProperty.call(payload, 'creds'));
    const hasProviderIntent = Boolean(payload && Object.prototype.hasOwnProperty.call(payload, 'providerIntent'));
    const providerIntent = parseTrustedProviderIntent(payload?.providerIntent);
    // Bring-Your-Own-LLM: the caller's own OpenAI-compatible endpoint+key+model,
    // resolved by the controller (getUserLlmConnection). When present, inference for
    // this request runs on the user's endpoint (any-bot TaskController routes through
    // an OpenAIProvider) instead of the bot's configured provider.
    const byoLlmConnection = (payload?.byoLlmConnection && typeof payload.byoLlmConnection === 'object')
      ? (payload.byoLlmConnection as { baseUrl: string; apiKey: string; model: string }) : undefined;
    const workspaceTaskId = readOptionalWorkspaceSource(payload, 'workspaceTaskId');
    const originalTicket = typeof payload?.originalTicket === 'object' && payload?.originalTicket !== null
      ? payload.originalTicket as Record<string, unknown> : undefined;
    const ticketExternalId = readOptionalWorkspaceSource(payload, 'externalId');
    const originalExternalId = readOptionalWorkspaceSource(originalTicket, 'externalId');
    const parentExternalId = readOptionalWorkspaceSource(originalTicket, 'parentExternalId');
    const baseTaskId = workspaceTaskId ?? originalExternalId ?? ticketExternalId
      ?? `swarm-${envelope.correlationId}`;
    const workspaceFolderId = canonicalBotWorkspaceId(baseTaskId);
    const taskId = `${workspaceFolderId}::${agentId}`;
    const providerConfigRequired = payload?.providerConfigRequired === true;
    const carriedConfig = parseCarriedDispatchConfig(payload);
    let configReconciliation: DispatchConfigReconciliation = { action: 'absent' };
    const providerConfigSource = providerIntent
      ? 'deterministic-intent' as const
      : byoLlmConnection
        ? 'byo-request' as const
        : carriedConfig
          ? 'authoritative-dispatch' as const
          : 'runtime-default' as const;

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
      if (hasCredentialCarrier && !providerIntent) {
        throw new Error('Connector credentials require a validated deterministic provider intent');
      }
      // Reconcile and preflight provider selection before persona/memory retrieval and, critically,
      // before task lookup/creation. A denied autonomous CLI leaves no accepted work behind.
      if (providerConfigRequired && !carriedConfig) {
        throw new AuthoritativeDispatchConfigError(
          'Authoritative provider config was required but no actionable record was available',
        );
      }
      if (carriedConfig && !deps.dispatchConfigRuntime) {
        throw new AuthoritativeDispatchConfigError(
          'Authoritative provider config cannot be enforced because the runtime seam is unavailable',
        );
      }
      if (carriedConfig && deps.dispatchConfigRuntime) {
        if (activeExecutions <= 1) {
          configReconciliation = reconcileDispatchProviderConfig(
            carriedConfig,
            deps.dispatchConfigRuntime,
            { taskId },
          );
        } else {
          const active = deps.dispatchConfigRuntime.getActiveProvider();
          if (!dispatchConfigMatchesActive(carriedConfig, active)) {
            logger.warn(
              {
                taskId,
                activeExecutions,
                carriedProvider: carriedConfig.providerId,
                carriedModel: carriedConfig.model ?? null,
                activeProvider: active.provider,
                activeModel: active.model,
              },
              'ADR-034: concurrent dispatch requires a different provider config — refusing instead of switching a running task',
            );
            throw new AuthoritativeDispatchConfigError(
              'Authoritative provider config cannot be applied while another execution is in flight',
            );
          }
          configReconciliation = { action: 'match', active };
        }
      }
      const selectedProvider = deps.dispatchConfigRuntime?.getActiveProvider().provider
        ?? deps.providerName;
      assertUnattendedProviderPreflight({
        providerName: selectedProvider,
        deterministicIntent: Boolean(providerIntent),
        byoHostedInference: Boolean(byoLlmConnection),
      });
      if (providerIntent) {
        // Deterministic provider reads bypass persona/memory/prompt/task construction entirely.
        // This is both a credential boundary and a no-hidden-side-effect completion boundary.
        const providerResult = await (deps.executeProviderIntent ?? executeTrustedProviderIntent)(
          providerIntent,
          { userSub, creds },
        );
        const durationMs = Date.now() - execStart;
        logger.info(
          { correlationId: envelope.correlationId, agentId, taskId, durationMs },
          'Deterministic provider intent completed outside the model runtime',
        );
        return {
          success: true,
          output: {
            agentId,
            taskId,
            content: providerResult.completion,
            response: providerResult.completion,
            providerRecords: providerResult.providerRecords.slice(0, 8),
            cost: 0,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            model: 'none',
            provider: 'deterministic-provider',
            providerConfigSource,
            providerConfigAction: configReconciliation.action,
            providerConfigVersion: carriedConfig?.configVersion ?? null,
          },
        };
      }
      // ── Prompt assembly ──
      // Direct/interactive reasoning: pass ONLY the caller's text. The provider
      // loads the bot's (lean) persona itself, so we add no swarm persona layers,
      // no file-persona "read your context" scaffolding, and no phase/handover
      // execution framing — all of which a reasoner reads as out-of-place noise
      // (it flags them as a prompt injection against its real role).
      const profile = !direct && deps.agentProfileRepository
        ? await deps.agentProfileRepository.getAgentProfile(agentId) : null;
      const personaLayers = direct
        ? []
        : await loadPersonaLayers(agentId, envelope, deps.personaLayerStore);
      if (!direct) {
        const agentDisplayName = profile?.name || agentId;
        const payloadType = payload?.type ? String(payload.type) : '';
        const reviewRole = payload?.role ? String(payload.role) : 'reviewer';
        const filePersonaLayer = buildPhasePersonaOverride(payloadType, agentId, agentDisplayName, reviewRole)
          ?? buildFilePersonaLayer(agentId, agentDisplayName, workspaceFolderId, deps.personaDir);
        if (filePersonaLayer) personaLayers.unshift(filePersonaLayer);
        personaLayers.push(...await buildSwarmMemoryLayers(envelope, deps.swarmMemoryService, {
          userSub: userSub ?? '', tenantId, workspaceId: workspaceFolderId,
          isOperator: false, allowPublic: true,
        }));
        personaLayers.push(...buildHandoverLayers(
          envelope, agentId, deps.handoverManager, executionScopeId,
        ));
        const awarenessLayer = buildSwarmAwarenessLayer(envelope, agentId);
        if (awarenessLayer) personaLayers.push(awarenessLayer);
      }
      const promptAuthority = await resolvePromptAuthorityBinding({
        userSub: userSub ?? null,
        ticketId: ticketExternalId ?? workspaceFolderId,
        workloadId: agentId,
        executionScope: executionScopeId,
        layers: personaLayers,
        resolver: deps.resolvePromptAuthorization,
      });
      const skillProfilePattern = typeof payload?.pattern === 'string' ? payload.pattern.trim() : '';
      const assembledPrompt = assemblePromptForAnyBot(
        personaLayers,
        direct ? String(payload?.text ?? '') : buildUserMessage(envelope),
        promptAuthority,
        skillProfilePattern ? [{ source: 'resolved-skill-profile', content: skillProfilePattern }] : [],
      );
      const layerCount = personaLayers.length;

      logger.info(
        { correlationId: envelope.correlationId, agentId, taskId, direct, layerCount, promptLength: assembledPrompt.length },
        'Executing envelope via any-bot provider (in-process)',
      );

      // ── LLM execution (any-bot JavaScript — in-process, no HTTP) ──
      // NOTE: the model-gateway gate is NOT here. It lives at the any-bot
      // provider layer (generateResponse → llmGate pre-flight to the controller's
      // /api/llm-governance/check), so it covers EVERY any-bot LLM path (this
      // handler, the AgenticController loop, and the app.js one-shot ticket path)
      // at one chokepoint — and gating here too would double-count quota.
      const effectiveTaskId = workspaceFolderId;
      let task: { id: string };
      try {
        const existing = await deps.anyBotTaskController.getTask(effectiveTaskId);
        if (existing) {
          assertExistingTaskOwner(existing, userSub);
          task = { id: effectiveTaskId };
        } else {
          // Stamp the owner on the new task record. ADR-060's per-user PATH layout was reverted
          // (the dir stays flat <root>/<taskId>), so this binding — not the path — is what stops
          // the NEXT dispatch for a different user from being handed this workspace: the
          // assertExistingTaskOwner above has nothing to compare against if userSub is dropped
          // here. TaskController's forceTaskId branch has no owner assert of its own.
          // Pinned by tests/unit/bot-node-workspace-owner-binding.spec.ts.
          task = await deps.anyBotTaskController.createTask(`Swarm execution for ${agentId}`, 'act', { forceTaskId: effectiveTaskId, userSub });
          if (task.id !== effectiveTaskId) throw taskWorkspaceMismatchError();
        }
      } catch (error) {
        if (isTaskSecurityBoundaryError(error)) throw error;
        task = await deps.anyBotTaskController.createTask(`Swarm execution for ${agentId}`, 'act', { userSub });
      }

      // Honor the requested mode (was hardcoded true). A direct reasoning request
      // (e.g. summarize/draft) passes agenticMode:false to skip the tool loop —
      // which otherwise non-deterministically emits an unparseable tool call.
      const agenticMode = payload?.agenticMode !== undefined ? Boolean(payload.agenticMode) : true;
      const result = await deps.anyBotTaskController.processMessage(task.id, { text: assembledPrompt }, {
          agenticMode,
          autoApprove: { 'use_mcp_tool': true },
          source: 'swarm-dispatch',
          allowedTools: [...promptAuthority.allowedTools],
          authorizedScopes: [...promptAuthority.scopes],
          byoLlmConnection, // caller's own endpoint drives inference when present
          // Connector tokens remain in executeProviderIntent's deterministic server-side broker.
          // Passing OSHAL_CRED_* here would expose them to model-readable env/workspace files.
          extraEnv: userSub ? { OSHAL_USER_SUB: userSub } : undefined,
      });

      const durationMs = Date.now() - execStart;
      // Runtime accountability is structured out-of-band data from TaskController.
      // Request payload fields and assistant text never participate in this choice.
      const runtimeIdentity = result as { provider?: unknown; model?: unknown };
      const enforcedRuntimeIdentity = configReconciliation.active
        ?? deps.dispatchConfigRuntime?.getActiveProvider();
      const actualProvider = normalizeRuntimeIdentity(runtimeIdentity.provider, 128)
        ?? enforcedRuntimeIdentity?.provider
        ?? deps.providerName;
      const actualModel = normalizeRuntimeIdentity(runtimeIdentity.model, 256)
        ?? enforcedRuntimeIdentity?.model
        ?? deps.modelName;
      if (carriedConfig && !byoLlmConnection
        && !dispatchConfigMatchesActive(carriedConfig, {
          provider: actualProvider,
          model: actualModel,
        })) {
        throw new AuthoritativeDispatchConfigError(
          'Execution reported a provider/model different from the authoritative dispatch record',
        );
      }

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
        providerConfigSource,
        providerConfigAction: configReconciliation.action,
        providerConfigVersion: carriedConfig?.configVersion ?? null,
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

function isTaskSecurityBoundaryError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return ['TASK_OWNER_MISMATCH', 'UNSAFE_TASK_WORKSPACE', 'INVALID_USER_SUBJECT'].includes(
    String((error as { code?: unknown }).code ?? ''),
  );
}

function taskWorkspaceMismatchError(): Error {
  const error = new Error('TaskController returned a non-canonical workspace id') as Error & { code?: string };
  error.code = 'UNSAFE_TASK_WORKSPACE';
  return error;
}

function readOptionalWorkspaceSource(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (!record || !Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError(`${key} must be a string`);
  return value;
}

function optionalExactContextId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 512
    || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new TypeError(`${field} must be exact, non-empty, and control-free`);
  }
  return value;
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
