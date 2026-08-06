/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added LLM-backed envelope execution handler for real agent work
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Integrated PersonaLayerStore + PersonaLayerComposer for multi-layer prompt composition
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Receive getProvider from composition root — same resolver as the chat orchestrator
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Refactored to use createAgent() runtime hierarchy — agent handles prompt composition and provider dispatch
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Replaced token estimation with real token counts via TokenCapturingProvider proxy
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added routing metadata to fallback profiles after agent-profile schema hardening
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Fixed verification-request prompt assembly so task-manager reviews prior execution output instead of re-implementing work
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Added workspace validation guidance for standalone npm/Vitest tasks in Docker swarm workspaces
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Stopped injecting execution-only RALF handover instructions into verification envelopes to prevent false QA rejections
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Added minimal-workspace execution guidance so tiny ticket runs avoid unnecessary npm/bootstrap churn
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Added consensus-review prompt mode with work-intent review focus so reviewers judge the right evidence class
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Tightened consensus-review prompt format so reviewer outputs carry deterministic verdict, findings, and summary sections
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | Added a MOCK_OIDC stub replacement so direct swarm tickets emit deterministic structured deliverables for localhost validation
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | Extracted mock-oidc deliverable fallback helpers into a dedicated service module to maintain file-size constraints
 * 15 | maintainer@emeraldcoastsystemsgroup.com   | Removed orphaned mock-fallback JSDoc stub after extraction to restore doc consistency and clean compilation
 * 16 | maintainer@emeraldcoastsystemsgroup.com   | Removed live MOCK_OIDC content substitution so swarm execution always returns real provider output or explicit runtime errors
 * 17 | maintainer@emeraldcoastsystemsgroup.com   | Integrated persona context file writing for swarm execution — agents now read role identity from workspace files (legacy pattern)
 * 18 | maintainer@emeraldcoastsystemsgroup.com   | Fixed workspace directory: all bots share parent ticket's workspace folder instead of creating per-session directories
 * 19 | maintainer@emeraldcoastsystemsgroup.com   | Wired SwarmAwarenessPrompt into persona layer assembly — every bot now gets situational context about phase, role, round, and colleagues (legacy parity)
 * 20 | maintainer@emeraldcoastsystemsgroup.com   | Preferred BOT_PERSONA_FILE for filesystem persona loading so architect-bot can execute the spec-driven system-architect persona
 * 21 | maintainer@emeraldcoastsystemsgroup.com   | Included persona system_prompt in fallback prompt embedding when workspace context-file writing fails
 * 22 | maintainer@emeraldcoastsystemsgroup.com   | Updated fallback swarm agent profiles to the current OpenAI Codex default model so execution fallbacks align with the mirrored Cline catalog
 * 23 | maintainer@emeraldcoastsystemsgroup.com   | WS2: Replace file persona layer with review-mode persona for consensus-review-request tasks — prevents planning-SOP PLANNING_BLOCKED failures in Phase 6 review
 * 24 | maintainer@emeraldcoastsystemsgroup.com   | Resolved swarm cost telemetry against the actual response model and shared estimate helper so zero-cost token runs still roll up by model
 * 25 | maintainer@emeraldcoastsystemsgroup.com   | ADR-027: Per-bot task IDs and ticket_task_links creation so swarm cost rollup aggregates all bots
 * 26 | maintainer@emeraldcoastsystemsgroup.com   | IMP-2: Derive executionScopeId and pass through agent.processMessage for child/review context isolation
 * 27 | maintainer@emeraldcoastsystemsgroup.com   | ADR-081: task-layer platform-development override — on a node with OSHAL_DEV_REPO_URL set (the oshal-developer container), the workspace notes name the platform-repo clone (/app/dev-repo) as the sanctioned working directory, so the generic workspace-only framing no longer beats the persona (observed: the ADR-081 live smoke stayed workspace-only and flagged the conflict). (Sat uncommitted until 2026-07-10 — never shipped in an image; adopted and landed with the fix below.)
 * 28 | maintainer@emeraldcoastsystemsgroup.com   | Fix "0 work units" refusals (BACKLOG 2026-07-09): buildTaskLayer announced "Processing ticket … with 0 work unit(s)" for EVERY manifest-worker dispatch (task/oshal-dev/app ticketTypes carry the request as message text, not decomposed workUnits), so the bot concluded there was no implementable scope and did nothing (live: dev-bot handover "ticket payload contains 0 work units", ticket ab985e3a). Zero-workUnits framing now declares the ticket message ITSELF the single work unit and names findings-as-deliverable for query-shaped requests.
 * 29 | maintainer@emeraldcoastsystemsgroup.com   | The DEEPER half of the same bug: buildExecutionUserMessage assembled phase prompt + workspace rules + handovers + workUnits but NEVER included payload.text — on whole-ticket dispatches the actual request was silently dropped from the prompt (live probe 396da4d0: the bot received the framing "the message IS the work unit" but no message, and honestly reported "no concrete request in the ticket body"). Whole-ticket payloads now get a "THE TICKET — YOUR WORK UNIT" section carrying the message text; decomposed dispatches are unchanged.
 * 30 | maintainer@emeraldcoastsystemsgroup.com   | Cost observability (migration 090): CostRecordFn gains optional durationMs and recordCostEvent forwards the handler's already-measured execution wall-clock — the handler timed the run for logging/metrics but the cost ledger never saw it, so trace llm-call spans showed dollars with no latency.
 * 31 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed retired legacy product references (provider name is noop; narration removed)
 * 32 | maintainer@emeraldcoastsystemsgroup.com   | Feedback-carrying build retry: buildExecutionUserMessage renders a "== RETRY" section when payload.retryFeedback is present, naming the previous attempt's verification findings (e.g. deliverables-directory-empty) with a corrective imperative — converts the blind re-roll into a self-heal (docs/backlog/test-lab.md #2). Non-retry prompts are byte-identical.
 * 33 | maintainer@emeraldcoastsystemsgroup.com   | Docs-only: completed JSDoc on exported members that were missing tags — assemblePromptForAnyBot gained @param/@returns and buildHandoverLayers gained the @param scopeId that had drifted from its signature. No logic change (additive comments only).
 * 34 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: separate trusted policy/configuration from escaped untrusted ticket, handover, tool, and memory data; append the server-owned user/ticket/tool/scope binding after prompt construction.
 * 35 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 audit: preserve exact envelope subjects and bind memory retrieval to non-operator owner/tenant/workspace context.
 */

import { createChildLogger } from '@/shared/logger';
import { createAgent, type AgentProfile, type AgentProfileRepository } from '@/entities/agent';
import {
  type MeshEnvelope,
  type PersonaLayer,
  type PersonaLayerStore,
  type SwarmMemoryAccessContext,
  type SwarmMemoryService,
} from '@/features/agent-management';
import { LLMService, resolveUsageCost, type TokenUsage, type CostResult, type SendRequestOptions, type LLMResponse } from '@/features/llm-provider';
import type { EnvelopeExecutionResult } from './swarm-agent-worker';
import { loadPersonaFromFile } from './persona-file-loader';
import { RALFHandoverManager } from './ralf-handover-manager';
import { writePersonaContextFile } from '@/app/composition/tool-runtime-context';
import { getPhasePrompt } from './phase-dispatch-prompts';
import { buildSwarmAwarenessPrompt, buildMinimalSwarmAwareness } from './swarm-awareness-prompt';
import { buildPhasePersonaOverride } from './phase-override-layer-builder';
import type { TicketService } from '@/features/ticketing';
import { deriveExecutionScopeId } from './execution-artifact-scope-service';
import {
  assembleContainedPrompt,
  resolvePromptAuthorityBinding,
  type PromptAuthorityBinding,
  type PromptAuthorizationResolver,
  type TrustedPromptConfiguration,
} from './prompt-containment';
import { optionalExactUserSubject } from '@/shared/security/exact-user-subject';

/**
 * @description Proxy wrapper around LLMService that captures token usage from provider responses.
 * This is the bridge between the agent layer (which discards token data) and the cost tracking
 * layer (which needs real token counts). Does not modify provider or agent code.
 */
class TokenCapturingProvider extends LLMService {
  lastUsage: TokenUsage | null = null;
  lastModel: string | null = null;
  private readonly delegate: LLMService;

  constructor(delegate: LLMService) {
    super(delegate.getProviderName(), {});
    this.delegate = delegate;
  }

  async sendRequest(options: SendRequestOptions): Promise<LLMResponse> {
    const response = await this.delegate.sendRequest(options);
    this.lastUsage = response.usage;
    this.lastModel = response.model;
    return response;
  }

  override calculateCost(usage: TokenUsage): CostResult {
    return this.delegate.calculateCost(usage);
  }
}

const logger = createChildLogger({ module: 'llm-execution-handler' });

/**
 * @description Dependencies for the LLM execution handler factory.
 * The resolveProvider closure is the same getProvider() from the composition root —
 * it reads the active provider from persisted config (the dropdown selection) and returns
 * the fully wired LLMService instance. The swarm does not pick its own provider.
 */
/**
 * @description Callback for recording cost events from LLM execution.
 */
export type CostRecordFn = (event: {
  taskId: string; agentId: string; providerId: string; modelId: string;
  inputTokens: number; outputTokens: number; inputCost: number;
  outputCost: number; totalCost: number; currency: string;
  ticketExternalId?: string;
  requestCount?: number;
  /** End-user (OIDC sub) for per-owner budget attribution (Phase 2). */
  ownerSub?: string;
  /** Measured wall-clock duration (ms) of the execution this event bills, when known
   *  (migration 090 observability). Omit rather than fabricate. */
  durationMs?: number;
}) => Promise<void>;

/**
 * @description Callback for recording agent execution events for metrics.
 */
export type MetricsRecordFn = (event: {
  agentId: string; ticketExternalId: string; swarmRunId: string;
  durationMs: number; outcome: 'completed' | 'failed' | 'escalated';
  retryCount: number; verificationAttempts: number;
}) => void;

/**
 * @description Dependency bundle for the LLM execution handler factory. Supplies the
 * composition-root provider resolver (the shared getProvider() that honors the persisted
 * provider selection), the agent-profile repository, and optional collaborators for persona
 * layering, swarm memory, RALF handovers, cost/metrics recording, ticket linking, and
 * per-agent harness overrides.
 */
export interface LLMExecutionHandlerDeps {
  resolveProvider: () => LLMService;
  agentProfileRepository: AgentProfileRepository;
  personaLayerStore?: PersonaLayerStore;
  swarmMemoryService?: SwarmMemoryService;
  handoverManager?: RALFHandoverManager;
  personaDir?: string;
  recordCost?: CostRecordFn;
  recordMetrics?: MetricsRecordFn;
  ticketService?: TicketService;
  /** Server-side resolver for the workload's currently enabled tool names and scopes. */
  resolvePromptAuthorization?: PromptAuthorizationResolver;
  /**
   * @description Optional per-agent harness override resolver.
   * When provided, the handler calls this before `resolveProvider()`.
   * If it returns a non-null LLMService, that harness is used for this agent's execution.
   * If it returns null, the process-level `resolveProvider()` is used (default behaviour).
   *
   * Wired up from `resolveHarnessForAgent()` in provider-runtime.ts.
   * Powers the "harness-as-bot" framework: each bot can declare its runtime
   * via `harnessType` in SwarmBotDefinition without changing the execution handler.
   */
  resolveAgentHarness?: (agentId: string) => LLMService | null;
}

/**
 * @description Creates an envelope execution handler that uses the runtime class hierarchy.
 * Resolves agent profile → loads persona layers → creates agent via factory →
 * calls processMessage() which delegates to the composition-root provider (any-bot).
 * @param deps - Provider resolver, agent profile repository, and optional persona layer store
 * @returns Pluggable handler for SwarmAgentWorker
 */
export function createLLMExecutionHandler(
  deps: LLMExecutionHandlerDeps,
): (envelope: MeshEnvelope) => Promise<EnvelopeExecutionResult> {
  return async (envelope: MeshEnvelope): Promise<EnvelopeExecutionResult> => {
    const { resolveProvider, agentProfileRepository, personaLayerStore, swarmMemoryService, handoverManager, personaDir, recordCost, recordMetrics, ticketService, resolveAgentHarness, resolvePromptAuthorization } = deps;
    const agentId = envelope.toAgentId;
    const payload = envelope.payload as Record<string, unknown> | undefined;
    const workspaceTaskId = payload?.workspaceTaskId ? String(payload.workspaceTaskId) : undefined;
    const originalTicket = typeof payload?.originalTicket === 'object' && payload?.originalTicket !== null
      ? payload.originalTicket as Record<string, unknown>
      : undefined;
    const ticketExternalId = payload?.externalId ? String(payload.externalId) : undefined;
    const originalExternalId = typeof originalTicket?.externalId === 'string' ? originalTicket.externalId : undefined;
    const parentExternalId = typeof originalTicket?.parentExternalId === 'string' ? originalTicket.parentExternalId : undefined;
    const ownerSub = resolveEnvelopeOwnerSub(payload, originalTicket);
    const tenantId = resolveEnvelopeTenantId(payload, originalTicket);
    const baseTaskId = workspaceTaskId || originalExternalId || ticketExternalId || `swarm-${envelope.correlationId}`;
    // Filesystem operations use baseTaskId (root workspace folder).
    // Cost/metrics tracking uses taskId with agent suffix for per-agent attribution.
    const taskId = `${baseTaskId}::${agentId}`;
    const workspaceFolderId = baseTaskId;

    // IMP-2: Derive execution scope for child/review ticket context isolation
    const reviewRound = payload?.round ? Number(payload.round) : undefined;
    const isReview = payload?.type === 'verification-request' || payload?.type === 'review-request';
    const executionScopeId = deriveExecutionScopeId(
      ticketExternalId || '',
      parentExternalId || workspaceTaskId,
      isReview ? reviewRound : undefined,
    );
    const execStart = Date.now();

    try {
      const profile = await agentProfileRepository.getAgentProfile(agentId);
      const personaLayers = await loadPersonaLayers(agentId, envelope, personaLayerStore);

      // Persona injection — for review tasks use review-mode layer to prevent planning SOP
      // misbinding (WS2 fix); for all other tasks use the normal filesystem persona.
      const agentDisplayName = profile?.name || agentId;
      const payloadType = payload?.type ? String(payload.type) : '';
      const reviewRole = payload?.role ? String(payload.role) : 'reviewer';
      const filePersonaLayer = buildPhasePersonaOverride(payloadType, agentId, agentDisplayName, reviewRole)
        ?? buildFilePersonaLayer(agentId, agentDisplayName, workspaceFolderId, personaDir);
      if (filePersonaLayer) personaLayers.unshift(filePersonaLayer);

      // Swarm memory injection — cross-ticket learnings
      personaLayers.push(...await buildSwarmMemoryLayers(envelope, swarmMemoryService, {
        userSub: ownerSub ?? '', tenantId, workspaceId: workspaceFolderId,
        isOperator: false, allowPublic: true,
      }));

      // RALF handover injection — wet-edge context from previous rounds (scope-aware for IMP-2)
      const handoverLayers = buildHandoverLayers(envelope, agentId, handoverManager, executionScopeId);
      personaLayers.push(...handoverLayers);

      // Swarm awareness injection — situational context (legacy SwarmAwarenessPrompt.js)
      const awarenessLayer = buildSwarmAwarenessLayer(envelope, agentId);
      if (awarenessLayer) personaLayers.push(awarenessLayer);

      const userMessage = buildUserMessage(envelope);
      const providerId = profile?.providerId || 'unknown';
      const modelId = (profile?.metadata as Record<string, unknown>)?.modelId as string || 'unknown';
      const promptAuthority = await resolvePromptAuthorityBinding({
        userSub: ownerSub ?? null,
        ticketId: ticketExternalId ?? workspaceFolderId,
        workloadId: agentId,
        executionScope: executionScopeId,
        layers: personaLayers,
        resolver: resolvePromptAuthorization,
      });
      const containedPrompt = assemblePromptForAnyBot(personaLayers, userMessage, promptAuthority);

      // Local execution via agent.processMessage() — used by the PM bot
      // on the swarm controller. Worker bots consume their own envelopes
      // via SwarmAgentWorker on bot-node containers (they never reach here).
      const agentHarness = resolveAgentHarness ? resolveAgentHarness(agentId) : null;
      const baseProvider = agentHarness ?? resolveProvider();
      if (agentHarness) {
        logger.info({ agentId, providerName: agentHarness.getProviderName() }, 'Using per-bot harness override (legacy path)');
      }

      // Wrap provider to capture real token usage from the LLM response
      const capturingProvider = new TokenCapturingProvider(baseProvider);

      const agent = await createAgent({
        profile: profile || buildFallbackProfile(agentId, envelope),
        getProvider: () => capturingProvider,
        personaLayers: [{ layerType: 'platform', priority: 0, promptFragment: containedPrompt }],
        topology: 'localhost',
        role: 'worker',
      });

      logger.info(
        { correlationId: envelope.correlationId, agentId, taskId, agentType: agent.constructor.name, layerCount: personaLayers.length },
        'Invoking agent for envelope execution (legacy local path)',
      );

      const rawContent = await agent.processMessage(
        'Execute the contained ticket data under the final server authority binding.',
        workspaceFolderId,
        executionScopeId,
      );
      const content = rawContent;
      const durationMs = Date.now() - execStart;

      logger.info(
        { correlationId: envelope.correlationId, agentId, taskId, contentLength: content.length, durationMs },
        'Agent execution completed (legacy local path)',
      );

      // Token finalization now happens inside sendRequest() — the provider reads
      // Cline session artifacts and returns real tokens in response.usage.
      // The capturingProvider.lastUsage already has real session totals.
      await recordCostEvent(recordCost, taskId, agentId, providerId, modelId, ticketExternalId, capturingProvider, ownerSub, durationMs);

      // Link this bot's task to the ticket so cost rollup can find it (ADR-027)
      await linkSwarmTaskToTicket(ticketService, ticketExternalId, taskId, agentId);

      // Auto-record agent execution metrics
      recordMetricsEvent(recordMetrics, agentId, ticketExternalId || taskId, envelope.correlationId, durationMs);

      return {
        success: true,
        output: { agentId, taskId, content },
      };
    } catch (error) {
      const durationMs = Date.now() - execStart;
      logger.error(
        { err: error, correlationId: envelope.correlationId, agentId, taskId },
        'Agent execution failed',
      );

      // Record failure metrics
      const payload = envelope.payload as Record<string, unknown> | undefined;
      recordMetricsEvent(recordMetrics, agentId, payload?.externalId ? String(payload.externalId) : taskId, envelope.correlationId, durationMs, 'failed');

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown agent execution error',
      };
    }
  };
}

/**
 * @description Loads persona layers from the store when available, adding a task layer.
 * @param agentId - Agent ID for layer lookup
 * @param envelope - Mesh envelope with task context
 * @param store - Optional persona layer store
 * @returns Array of persona layers for agent initialization
 */
export async function loadPersonaLayers(
  agentId: string,
  envelope: MeshEnvelope,
  store: PersonaLayerStore | undefined,
): Promise<PersonaLayer[]> {
  const taskLayer = buildTaskLayer(envelope);
  if (!store) {
    return [taskLayer];
  }
  try {
    const dbLayers = await store.getLayersForAgent(agentId);
    logger.info({ agentId, dbLayerCount: dbLayers.length }, 'Persona layers loaded from store');
    return [...dbLayers, taskLayer];
  } catch (error) {
    logger.warn({ err: error, agentId }, 'Failed to load persona layers; using task layer only');
    return [taskLayer];
  }
}

/**
 * @description Builds a dynamic task layer from the envelope payload.
 * @param envelope - Mesh envelope with work unit context
 * @returns Task-scoped persona layer
 */
export function buildTaskLayer(envelope: MeshEnvelope): PersonaLayer {
  const payload = envelope.payload as Record<string, unknown> | undefined;
  const externalId = payload?.externalId ? String(payload.externalId) : 'unknown';
  const workUnits = payload?.workUnits as Array<Record<string, unknown>> | undefined;
  const unitCount = workUnits?.length ?? 0;
  const criteria = workUnits
    ?.flatMap((u) => (u.acceptanceCriteria as string[]) ?? [])
    .filter((c) => c.length > 0) ?? [];

  // Manifest-worker dispatches (task / oshal-dev / app ticketTypes) send the WHOLE request
  // as message text with no decomposed workUnits. Announcing "0 work unit(s)" made bots
  // conclude there was no implementable scope and refuse (live: the dev bot's "ticket
  // payload contains 0 work units" handovers). With no units, the message IS the unit.
  const parts = unitCount > 0
    ? [`Task context: Processing ticket ${externalId} with ${unitCount} work unit(s).`]
    : [
        `Task context: Processing ticket ${externalId}, dispatched WHOLE.`,
        'The request in the ticket message IS the single work unit — execute it directly.',
        'Never report "0 work units" or wait for a decomposed payload. If the request is a',
        'question, investigation, or audit, the DELIVERABLE is your written findings (a report',
        'in the workspace plus your final reply) — not code.',
      ];
  if (criteria.length > 0) {
    parts.push('Acceptance criteria to satisfy:');
    for (const c of criteria) {
      parts.push(`- ${c}`);
    }
  }
  appendWorkspaceExecutionNotes(parts, workUnits);

  return {
    layerType: 'task',
    priority: 40,
    promptFragment: parts.join('\n'),
    metadata: { promptTrust: 'untrusted-content', contentSource: 'ticket-task-context' },
  };
}

/**
 * @description Adds Docker workspace execution guidance for common standalone validation pitfalls.
 * @param parts - Prompt sections being assembled for the task layer.
 */
function appendWorkspaceExecutionNotes(
  parts: string[],
  workUnits: Array<Record<string, unknown>> | undefined,
): void {
  parts.push('Workspace execution notes:');
  parts.push('- Work happens inside an isolated /app/workspace task folder, but the container also has repo-level config files under /app.');
  parts.push('- If you create a standalone Vitest project, add a local vitest.config.ts and run `vitest run --config vitest.config.ts` so /app/vite.config.ts does not interfere.');
  parts.push('- If devDependencies are required for validation, prefer `npm install --include=dev` in this container so production omit settings do not skip test tooling.');
  // ADR-081: on a node that maintains the platform-repo clone (only the oshal-developer
  // container sets OSHAL_DEV_REPO_URL), the clone — not the task workspace — is the
  // sanctioned working directory for platform-change tickets. Without this override the
  // generic workspace-only framing above beats the persona and the bot refuses to touch
  // its own clone (observed on the ADR-081 live smoke).
  const devRepoDir = (process.env.OSHAL_DEV_REPO_URL || '').trim()
    ? (process.env.OSHAL_DEV_REPO_DIR || '/app/dev-repo')
    : null;
  if (devRepoDir) {
    parts.push('Platform-development override (this node owns a platform-repo clone):');
    parts.push(`- Your sanctioned working directory for platform-change tickets is ${devRepoDir} — the platform repo clone. Work THERE: git pull --rebase first, edit, run the quality gate, commit small, push to main.`);
    parts.push('- Use the task workspace only for run artifacts (handover/report files) — never copy platform source into it.');
  }
  if (!isMinimalWorkspaceTask(workUnits)) {
    return;
  }
  parts.push('Minimal workspace policy:');
  parts.push('- This ticket is intentionally small. Do not bootstrap a full project unless the acceptance criteria explicitly require it.');
  parts.push('- Do not run `npm init` when a direct `package.json` edit or creation is sufficient.');
  parts.push('- Create only the files required to satisfy the work unit and validation steps. Avoid extra scaffolding that does not move acceptance criteria forward.');
  parts.push('- Prefer predictable standalone smoke layouts such as `src/*.ts`, `tests/*.test.ts`, `README.md`, and `vitest.config.ts` when tests are requested.');
  parts.push('- Stop once the requested artifact, validation evidence, and handover are complete; do not expand scope with optional hardening.');
}

/**
 * @description Detects small standalone artifact tickets that benefit from a no-bootstrap reminder.
 * @param workUnits - Optional work units from the ticket payload.
 * @returns True when the task reads like a minimal smoke/artifact unit.
 */
function isMinimalWorkspaceTask(workUnits: Array<Record<string, unknown>> | undefined): boolean {
  if (!workUnits || workUnits.length === 0) {
    return false;
  }
  const taskText = workUnits
    .flatMap((unit) => {
      const criteria = Array.isArray(unit.acceptanceCriteria) ? unit.acceptanceCriteria as string[] : [];
      return [String(unit.title || ''), String(unit.description || ''), ...criteria];
    })
    .join(' ')
    .toLowerCase();

  const indicators = [
    'tiny',
    'minimal',
    'small',
    'standalone',
    'smoke artifact',
    'smoke test',
    'formatter',
    'single function',
    'matching vitest test',
  ];

  return indicators.some((indicator) => taskText.includes(indicator));
}

/**
 * @description Builds a minimal fallback AgentProfile when the DB lookup returns null.
 * @param agentId - Agent ID from the envelope
 * @param envelope - Mesh envelope for context
 * @returns Minimal AgentProfile suitable for agent construction
 */
export function buildFallbackProfile(agentId: string, envelope: MeshEnvelope): AgentProfile {
  return {
    agentId,
    name: `agent-${agentId.slice(0, 8)}`,
    status: 'active',
    providerId: 'openai-codex',
    modelId: 'gpt-5.3-codex',
    persona: { systemPrompt: `You are agent "${envelope.toAgentId}". Complete assigned work.` },
    baseCapabilities: [],
    selectorDescriptor: '',
    routingKeywords: [],
    metadata: {},
    projectUrl: '',
    selectorSkillsText: '',
    avatarUrl: '',
    themePreference: 'midnight',
    excludeFromBulkConfig: false,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * @description Assembles persona layers and the user message into a single prompt
 * for dispatch to a any-bot node. The any-bot receives everything as one text block
 * and handles execution end-to-end via its own provider stack.
 *
 * Layer composition order (highest priority first):
 *   platform (identity) → session (handovers, memory) → task (work units, criteria)
 * @param personaLayers - Composed persona layers classified by server-owned layer type/metadata.
 * @param userMessage - Raw ticket/user request, always encoded as bounded untrusted data.
 * @param authority - Final server-derived user, ticket, tool, and scope binding.
 * @param trustedConfiguration - Optional server-resolved configuration added before untrusted data.
 * @returns The trust-separated prompt with the immutable authority record last.
 */
export function assemblePromptForAnyBot(
  personaLayers: PersonaLayer[],
  userMessage: string,
  authority?: PromptAuthorityBinding,
  trustedConfiguration: TrustedPromptConfiguration[] = [],
): string {
  return assembleContainedPrompt(personaLayers, userMessage, authority, trustedConfiguration);
}

/**
 * @description Records a cost event from LLM execution using real token counts
 * captured from the provider response via TokenCapturingProvider. The measured
 * execution duration rides along so the ledger row carries per-call latency
 * (migration 090) — the handler already timed the run for its own logging.
 */
async function recordCostEvent(
  recordCost: CostRecordFn | undefined,
  taskId: string, agentId: string, providerId: string, modelId: string,
  ticketExternalId: string | undefined, capturingProvider: TokenCapturingProvider,
  ownerSub?: string, durationMs?: number,
): Promise<void> {
  if (!recordCost) return;
  try {
    const usage = capturingProvider.lastUsage;
    if (!usage) {
      logger.debug({ taskId }, 'No token usage captured — skipping cost recording');
      return;
    }
    const resolvedModelId = capturingProvider.lastModel?.trim() || modelId;
    const cost = resolveUsageCost({
      providerCost: capturingProvider.calculateCost(usage),
      usage,
      providerId,
      modelId: resolvedModelId,
    });
    // Read real API call count from the provider when available
    const delegate = (capturingProvider as unknown as { delegate: unknown }).delegate as { getLastSessionApiCalls?: () => number };
    const realRequestCount = typeof delegate?.getLastSessionApiCalls === 'function' ? delegate.getLastSessionApiCalls() : 0;

    await recordCost({
      taskId, agentId, providerId, modelId: resolvedModelId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      inputCost: cost.inputCost,
      outputCost: cost.outputCost,
      totalCost: cost.totalCost,
      currency: cost.currency,
      ticketExternalId,
      requestCount: realRequestCount > 0 ? realRequestCount : 1,
      ownerSub,
      durationMs,
    });
  } catch (err) {
    logger.warn({ err, taskId }, 'Cost recording failed — non-blocking');
  }
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveEnvelopeOwnerSub(
  payload: Record<string, unknown> | undefined,
  originalTicket: Record<string, unknown> | undefined,
): string | undefined {
  const candidates = [
    payload?.userSub, payload?.ownerSub, originalTicket?.ownerSub, originalTicket?.owner_sub,
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null) {
      return optionalExactUserSubject(candidate, 'swarm envelope ownerSub');
    }
  }
  return undefined;
}

function resolveEnvelopeTenantId(
  payload: Record<string, unknown> | undefined,
  originalTicket: Record<string, unknown> | undefined,
): string | undefined {
  const candidate = payload?.tenantId ?? payload?.tenant_id
    ?? originalTicket?.tenantId ?? originalTicket?.tenant_id;
  if (candidate === undefined || candidate === null) return undefined;
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 512
    || /[\u0000-\u001f\u007f-\u009f]/.test(candidate)) {
    throw new TypeError('swarm envelope tenantId must be exact and control-free');
  }
  return candidate;
}

/**
 * @description Links a swarm bot's task to the parent ticket so cost rollup queries can find it.
 * Creates a ticket_task_links entry with role 'swarm-execution'. Non-blocking — failures are
 * logged but do not affect execution outcome.
 * @param ticketService - Optional ticket service for creating the link
 * @param ticketExternalId - External ticket ID from the envelope payload
 * @param taskId - Per-bot task ID used in chat_tasks
 * @param agentId - Agent ID for logging
 */
async function linkSwarmTaskToTicket(
  ticketService: TicketService | undefined,
  ticketExternalId: string | undefined,
  taskId: string,
  agentId: string,
): Promise<void> {
  if (!ticketService || !ticketExternalId) return;
  // Extract canonical ticket UUID from synthetic IDs:
  //   "verify:UUID" → UUID
  //   "review:UUID:r1" → UUID
  //   plain UUID → UUID
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let canonicalId = ticketExternalId;
  if (!uuidPattern.test(canonicalId)) {
    // Try to extract UUID from synthetic patterns like "verify:UUID" or "review:UUID:r1"
    const uuidMatch = canonicalId.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (uuidMatch) {
      canonicalId = uuidMatch[1];
      logger.info({ ticketExternalId, canonicalId, taskId }, 'Extracted canonical ticket ID from synthetic external ID');
    } else {
      logger.debug({ ticketExternalId, taskId }, 'Skipping ticket link — cannot extract UUID from external ID');
      return;
    }
  }
  try {
    await ticketService.linkTask(canonicalId, taskId, 'swarm-execution');
    logger.info({ ticketExternalId, taskId, agentId }, 'Linked swarm task to ticket for cost rollup');
  } catch (err) {
    logger.warn({ err, ticketExternalId, taskId, agentId }, 'Failed to link swarm task to ticket — cost rollup may be incomplete');
  }
}

/**
 * @description Records an agent execution event for metrics tracking.
 */
function recordMetricsEvent(
  recordMetrics: MetricsRecordFn | undefined,
  agentId: string, ticketExternalId: string, swarmRunId: string,
  durationMs: number, outcome: 'completed' | 'failed' = 'completed',
): void {
  if (!recordMetrics) return;
  try {
    recordMetrics({ agentId, ticketExternalId, swarmRunId, durationMs, outcome, retryCount: 0, verificationAttempts: 1 });
  } catch (err) {
    logger.warn({ err, agentId }, 'Metrics recording failed — non-blocking');
  }
}

/**
 * @description Loads the bot's persona YAML from the filesystem, writes the context file,
 * and builds a high-priority persona layer that instructs the agent to read the file.
 * This follows the legacy pattern: small system prompt + file-based identity loading.
 * @param agentId - Agent ID for logging and file writing
 * @param agentName - Agent name used to resolve the YAML file
 * @param taskId - Task ID for workspace-scoped context file writing
 * @param personaDir - Optional directory override for persona files
 * @returns Persona layer instructing agent to read context file, or null if not found
 */
export function buildFilePersonaLayer(
  agentId: string,
  agentName: string,
  taskId: string,
  personaDir?: string,
): PersonaLayer | null {
  try {
    const personaLookupTarget = resolveFilesystemPersonaLookupTarget(agentName);
    const persona = loadPersonaFromFile(personaLookupTarget, personaDir);
    if (!persona || !persona.perspective) return null;

    // Write persona context file to workspace (legacy pattern)
    const contextFileName = `${persona.name || agentId}-context.md`;
    const fileWritten = writePersonaContextFile(agentId, persona, contextFileName, taskId);

    if (fileWritten) {
      // Minimal system prompt — agent reads full identity from file
      logger.info({ agentId, personaName: persona.name, contextFileName, taskId }, 'Wrote persona context file for swarm execution');
      return {
        layerType: 'platform',
        priority: 5, // Highest priority — bot identity comes first
        promptFragment: [
          `# YOUR IDENTITY`,
          `You are **${persona.name || agentId}** — ${persona.role || 'AI assistant'}.`,
          '',
          `IMPORTANT: Before responding to ANY message, you MUST first read the file \`${contextFileName}\` using the read_file tool.`,
          `This file contains your complete identity, role description, perspective, and behavioral guidelines.`,
          `Read it first, internalize it, then respond to the user's message in character.`,
        ].join('\n'),
        metadata: {
          serverAuthored: true,
          contentSource: 'persona-policy',
          allowedTools: persona.allowedTools,
          authorizedScopes: [persona.scope, ...Object.keys(persona.authorizations)],
        },
      };
    }

    // Fallback: embed full persona in prompt when file write fails
    logger.warn({ agentId, personaName: persona.name }, 'Failed to write persona context file — embedding full persona in system prompt');
    const promptSections = [`## Bot Identity: ${persona.role}`, '', persona.perspective];
    if (persona.systemPrompt && persona.systemPrompt.trim().length > 0) {
      promptSections.push('', '## Required Operating Procedure', '', persona.systemPrompt.trim());
    }
    return {
      layerType: 'platform',
      priority: 5,
      promptFragment: promptSections.join('\n'),
      metadata: {
        serverAuthored: true,
        contentSource: 'persona-policy',
        allowedTools: persona.allowedTools,
        authorizedScopes: [persona.scope, ...Object.keys(persona.authorizations)],
      },
    };
  } catch (err) {
    logger.debug({ err, agentName }, 'No filesystem persona found — using DB persona only');
    return null;
  }
}

/**
 * @description Resolves the preferred filesystem persona lookup target for the current runtime.
 * Uses BOT_PERSONA_FILE when present so containers can bind an exact persona file, otherwise
 * falls back to the agent name for legacy name-based lookup.
 * @param agentName - Agent name used for the legacy filename lookup.
 * @returns Absolute persona file path or agent name lookup key.
 */
function resolveFilesystemPersonaLookupTarget(agentName: string): string {
  const configuredPersonaFile = typeof process.env.BOT_PERSONA_FILE === 'string'
    ? process.env.BOT_PERSONA_FILE.trim()
    : '';
  return configuredPersonaFile.length > 0 ? configuredPersonaFile : agentName;
}

/**
 * @description Builds handover context layers from previous rounds' work.
 * Reads workspace handovers (the "wet edge") and injects:
 * 1. QM executive summary of all previous handovers
 * 2. Handover writing instructions for the current agent
 * @param envelope - Mesh envelope with task context
 * @param agentId - Current agent identifier
 * @param handoverManager - Optional handover manager
 * @param scopeId - Optional IMP-2 execution scope; when set, reads/writes handovers under a scope-prefixed filename so parallel child/review scopes on the same workspace never cross-contaminate each other's context.
 * @returns Array of persona layers (may be empty if no handover manager)
 */
export function buildHandoverLayers(
  envelope: MeshEnvelope, agentId: string,
  handoverManager: RALFHandoverManager | undefined, scopeId?: string,
): PersonaLayer[] {
  if (!handoverManager) return [];
  const layers: PersonaLayer[] = [];
  const payload = envelope.payload as Record<string, unknown> | undefined;
  const workspaceTaskId = payload?.workspaceTaskId ? String(payload.workspaceTaskId) : undefined;
  const phase = payload?.phase ? Number(payload.phase) : 1;
  const round = payload?.round ? Number(payload.round) : 1;
  const isVerification = payload?.type === 'verification-request';
  // IMP-2: Build scoped handover prefix for child/review isolation
  const scopePrefix = scopeId ? `${scopeId}--` : '';
  const scopedHandoverFilename = scopeId
    ? `${scopeId}--${agentId}_PHASE_${phase}_ROUND_${round}.md`
    : undefined;

  if (workspaceTaskId) {
    try {
      const handovers = handoverManager.readScopedHandovers(workspaceTaskId, scopePrefix);
      const ticketTitle = payload?.externalId ? String(payload.externalId) : 'unknown';
      if (handovers.length > 0) {
        const summary = handoverManager.generateSummary(handovers, ticketTitle, phase, round);
        layers.push({
          layerType: 'session', priority: 30, promptFragment: summary,
          metadata: { promptTrust: 'untrusted-content', contentSource: 'other-agent-handover' },
        });
        const previousHandover = handoverManager.readAgentHandover(agentId, workspaceTaskId);
        if (previousHandover) {
          const recall = handoverManager.generateContextRecall(previousHandover, agentId);
          layers.push({
            layerType: 'session', priority: 31, promptFragment: recall,
            metadata: { promptTrust: 'untrusted-content', contentSource: 'prior-agent-output' },
          });
        }
      }
    } catch (err) {
      logger.warn({ err, workspaceTaskId }, 'Failed to read handovers — continuing without context');
    }
  }

  if (!isVerification) {
    const instructions = handoverManager.getHandoverInstructions(agentId, phase, round, scopedHandoverFilename);
    layers.push({
      layerType: 'task', priority: 45, promptFragment: instructions,
      metadata: {
        serverAuthored: true,
        promptTrust: 'trusted-configuration',
        contentSource: 'handover-write-policy',
      },
    });
  }
  return layers;
}

/**
 * @description Builds a swarm awareness persona layer from envelope metadata.
 * Ported from the legacy SwarmAwarenessPrompt.js — gives every bot situational context
 * about their phase, role, round, and colleagues.
 * @param envelope - Mesh envelope with phase/round context
 * @param agentId - Current agent identifier
 * @returns Persona layer with swarm awareness, or null for non-swarm envelopes
 */
export function buildSwarmAwarenessLayer(
  envelope: MeshEnvelope,
  agentId: string,
): PersonaLayer | null {
  const payload = envelope.payload as Record<string, unknown> | undefined;
  if (!payload) return null;

  const phase = payload.phase ? Number(payload.phase) : 0;
  const round = payload.round ? Number(payload.round) : 1;
  const maxRounds = payload.maxRounds ? Number(payload.maxRounds) : 2;
  const role = payload.role ? String(payload.role) : 'participant';
  const ticketTitle = payload.externalId ? String(payload.externalId) : 'unknown';
  const complexity = payload.complexity ? String(payload.complexity) : 'medium';
  const isSubtask = payload.depth ? Number(payload.depth) >= 1 : false;

  // Subtasks get minimal awareness to save context budget
  if (isSubtask || phase === 0) {
    const minimal = buildMinimalSwarmAwareness(agentId, ticketTitle);
    return {
      layerType: 'platform', priority: 8, promptFragment: minimal,
      metadata: {
        serverAuthored: true,
        promptTrust: 'untrusted-content',
        contentSource: 'envelope-derived-swarm-awareness',
      },
    };
  }

  const prompt = buildSwarmAwarenessPrompt({
    agentId,
    currentPhase: phase,
    currentRound: round,
    maxRounds,
    role,
    colleagues: [],
    ticketName: ticketTitle,
    complexity,
  });

  return {
    layerType: 'platform', priority: 8, promptFragment: prompt,
    metadata: {
      serverAuthored: true,
      promptTrust: 'untrusted-content',
      contentSource: 'envelope-derived-swarm-awareness',
    },
  };
}

/**
 * @description Queries swarm memory and preserves its durable trust classification as
 * separate persona layers before prompt containment.
 * @param envelope - Mesh envelope with ticket context.
 * @param swarmMemoryService - Optional swarm memory service.
 * @param access - Exact server-derived caller/workspace retrieval boundary.
 * @returns Zero or more trust-separated memory layers.
 */
export async function buildSwarmMemoryLayers(
  envelope: MeshEnvelope,
  swarmMemoryService: SwarmMemoryService | undefined,
  access?: SwarmMemoryAccessContext,
): Promise<PersonaLayer[]> {
  if (!swarmMemoryService) return [];
  try {
    const payload = envelope.payload as Record<string, unknown> | undefined;
    const externalId = payload?.externalId ? String(payload.externalId) : '';
    const workUnits = payload?.workUnits as Array<Record<string, unknown>> | undefined;
    const title = workUnits?.[0]?.title ? String(workUnits[0].title) : externalId;
    const description = workUnits?.map((u) => String(u.description || '')).join(' ') || '';
    const context = await swarmMemoryService.queryRelevantContext(title, description, 3, access);
    if (!context.hasContent) return [];
    logger.info({
      correlationId: envelope.correlationId,
      memoryCount: context.memoryCount,
      trustedCount: context.trustedCount,
      untrustedCount: context.untrustedCount,
    }, 'Injecting trust-separated swarm memory context');
    return memoryContextLayers(context);
  } catch (error) {
    logger.warn({ err: error, correlationId: envelope.correlationId }, 'Swarm memory query failed — continuing without context');
    return [];
  }
}

/**
 * @description Compatibility adapter for callers that still expect one memory layer. Mixed
 * trust content is deliberately downgraded to untrusted data at this legacy boundary.
 * @param envelope - Mesh envelope with ticket context.
 * @param swarmMemoryService - Optional swarm memory service.
 * @returns One conservative memory layer, or null when memory is unavailable.
 */
export async function buildSwarmMemoryLayer(
  envelope: MeshEnvelope,
  swarmMemoryService: SwarmMemoryService | undefined,
): Promise<PersonaLayer | null> {
  const layers = await buildSwarmMemoryLayers(envelope, swarmMemoryService);
  if (layers.length === 0) return null;
  if (layers.length === 1) return layers[0];
  return memoryLayer(layers.map((layer) => layer.promptFragment).join('\n\n'), 35, false);
}

function memoryContextLayers(context: {
  trustedPromptBlock: string;
  untrustedPromptBlock: string;
}): PersonaLayer[] {
  const layers: PersonaLayer[] = [];
  if (context.trustedPromptBlock) layers.push(memoryLayer(context.trustedPromptBlock, 34, true));
  if (context.untrustedPromptBlock) layers.push(memoryLayer(context.untrustedPromptBlock, 35, false));
  return layers;
}

function memoryLayer(promptFragment: string, priority: number, trusted: boolean): PersonaLayer {
  return {
    layerType: 'session',
    priority,
    promptFragment,
    metadata: trusted
      ? {
        serverAuthored: true,
        promptTrust: 'trusted-configuration',
        contentSource: 'validated-operational-memory',
      }
      : { promptTrust: 'untrusted-data', contentSource: 'prior-agent-memory' },
  };
}

/**
 * @description Builds a user message from the envelope payload work units.
 * @param envelope - Mesh envelope containing work units
 * @returns Formatted user message
 */
export function buildUserMessage(envelope: MeshEnvelope): string {
  const payload = envelope.payload as Record<string, unknown> | undefined;
  if (!payload) {
    return 'No work units provided. Please describe what needs to be done.';
  }

  if (payload.type === 'consensus-review-request') {
    return buildConsensusReviewUserMessage(payload);
  }

  if (payload.type === 'verification-request') {
    return buildVerificationUserMessage(payload);
  }

  return buildExecutionUserMessage(payload);
}

/**
 * @description Builds the phase-aware execution prompt from ticket work units.
 * Ported from the legacy implementation: the phase prompt tells the agent exactly what its role is,
 * what input to read, what to produce, and what NOT to do. Without this,
 * agents just "wing it" with generic instructions.
 *
 * @param payload - Envelope payload containing work units and phase context.
 * @returns Phase-aware execution request for the agent.
 */
function buildExecutionUserMessage(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  const phase = payload.phase ? Number(payload.phase) : undefined;
  const round = payload.round ? Number(payload.round) : 1;
  const agentId = payload.agentId ? String(payload.agentId) : 'unknown';
  const ticketDepth = Number((payload as Record<string, unknown>).ticketDepth ?? 0);
  const workspaceTaskId = payload.workspaceTaskId ? String(payload.workspaceTaskId) : undefined;

  // Phase-specific role instructions (legacy parity: TicketPhaseManager.getPhasePrompt)
  // Labels come from the work units (ticket labels propagated at dispatch time)
  const phaseWorkUnits = Array.isArray(payload.workUnits) ? payload.workUnits as Array<Record<string, unknown>> : [];
  const labels = phaseWorkUnits.flatMap((wu) => Array.isArray(wu.labels) ? wu.labels as string[] : []);
  const phasePrompt = getPhasePrompt(phase, agentId, round, ticketDepth, labels);
  if (phasePrompt) {
    parts.push(phasePrompt);
  }

  // Build-retry feedback (blind re-roll fix, docs/backlog/test-lab.md #2): when the
  // policy runner re-dispatches after a failed verification, the payload carries the
  // verifier's exact findings. Render them FIRST-class and imperative so the agent
  // corrects the specific miss instead of re-planning or repeating the same output.
  const retryFeedback = typeof payload.retryFeedback === 'string' ? payload.retryFeedback.trim() : '';
  if (retryFeedback) {
    parts.push(`== RETRY — YOUR PREVIOUS ATTEMPT FAILED VERIFICATION ==

The verifier found: ${retryFeedback}

This is a RETRY of work you (or a prior attempt) already started. Fix EXACTLY what the verifier flagged:
- If the finding says deliverables are missing or empty, write the required source file(s) to deliverables/src/ and matching test file(s) to deliverables/tests/ NOW.
- Do NOT re-plan, do NOT start over, and do NOT produce only a README or handover.
- Before ending your turn, list the deliverables directory and confirm the flagged files exist on disk.
`);
  }

  // Whole-ticket dispatches (manifest-worker: task / oshal-dev / app ticketTypes) carry
  // the ENTIRE request as message text with NO decomposed workUnits. This section is the
  // only place that text enters the prompt — without it the actual ask never reached the
  // bot at all (live 2026-07-10: the dev bot investigated ticket 396da4d0 and honestly
  // reported "no concrete request in the ticket body" while the 549-char request sat in
  // payload.text). Decomposed dispatches keep their workUnits framing instead.
  const messageText = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (messageText && phaseWorkUnits.length === 0) {
    parts.push(`== THE TICKET — YOUR WORK UNIT ==

${messageText}
`);
  }

  // Workspace boundary enforcement — prevents bots from wandering into /app/src
  const wsRoot = process.env.SHARED_WORKSPACE_ROOT
    || (require('fs').existsSync('/app/workspace') ? '/app/workspace' : require('path').resolve(process.cwd(), 'workspace-shared'));
  const workspacePath = workspaceTaskId ? require('path').join(wsRoot, workspaceTaskId) : wsRoot;
  parts.push(`== WORKSPACE RULES (MANDATORY) ==

Your workspace directory is: ${workspacePath}
ALL files you create MUST go inside this workspace directory.
- Place deliverables in ${workspacePath}/deliverables/
- Place source code in ${workspacePath}/deliverables/src/
- Place tests in ${workspacePath}/deliverables/tests/
- Write your handover to ${workspacePath}/developer-handovers/

⛔ FORBIDDEN ACTIONS:
- Do NOT explore, read, or modify files in /app/src/ — that is the host application code, NOT your workspace.
- Do NOT navigate to directories outside your workspace unless reading workspace context files.
- Do NOT treat /app/src/ as your project — your project lives in your workspace.
- If you find yourself reading source code from /app/src/, STOP. You are in the wrong directory.

Your workspace may already contain README.md, ARCHITECTURE.md, PROJECT-PLAN.md, and previous handovers. READ THOSE FIRST.
`);

  // Process chain awareness
  parts.push(`== PROCESS CHAIN AWARENESS ==

You are NOT working alone. You are one agent in a relay chain:
1. The Queue Manager assigns this ticket to you
2. You do YOUR work and write a DEVELOPER HANDOVER
3. Your output is saved — the next agent reads it before starting
4. The chain continues until the ticket is fully resolved

YOUR OUTPUT = THE NEXT AGENT'S INPUT. Write accordingly.
`);

  // Previous work injection (legacy parity: QueueManagerService.js:2317-2340)
  // Read developer handovers from workspace so agents see what prior phases produced.
  const previousWork = buildPreviousWorkSection(workspaceTaskId);
  if (previousWork) {
    parts.push(previousWork);
  }

  // Child ticket context: inject this child's specific acceptance criteria from work units
  if (ticketDepth >= 1) {
    const workUnits = payload.workUnits as Array<Record<string, unknown>> | undefined;
    const childAC: string[] = [];
    const childDesc: string[] = [];
    if (workUnits) {
      for (const wu of workUnits) {
        if (wu.description && typeof wu.description === 'string') childDesc.push(wu.description);
        if (Array.isArray(wu.acceptanceCriteria)) {
          for (const ac of wu.acceptanceCriteria) {
            if (typeof ac === 'string' && ac.trim()) childAC.push(ac);
          }
        }
      }
    }
    // Also check metadata for acceptance criteria from PM decomposition
    const rawPayload = (payload as Record<string, unknown>).originalTicket as Record<string, unknown> | undefined;
    const meta = (rawPayload?.metadata ?? payload.metadata) as Record<string, unknown> | undefined;
    if (Array.isArray(meta?.acceptanceCriteria)) {
      for (const ac of meta.acceptanceCriteria as unknown[]) {
        if (typeof ac === 'string' && ac.trim() && !childAC.includes(ac)) childAC.push(ac);
      }
    }

    if (childDesc.length > 0 || childAC.length > 0) {
      parts.push('== YOUR SPECIFIC TASK ==\n');
      for (const d of childDesc) parts.push(d + '\n');
      if (childAC.length > 0) {
        parts.push('ACCEPTANCE CRITERIA (you MUST satisfy ALL of these):');
        for (const ac of childAC) parts.push(`  - ${ac}`);
        parts.push('');
      }
    }

    // Sibling awareness (legacy parity: _buildChildTaskBrief siblingInfo)
    const siblingSection = buildSiblingSection(payload);
    if (siblingSection) {
      parts.push(siblingSection);
    }
  }

  parts.push(`Ticket: ${String(payload.externalId || 'unknown')}`);

  const workUnits = payload.workUnits as Array<Record<string, unknown>> | undefined;
  appendWorkUnits(parts, workUnits);

  // Phase-appropriate closing instruction
  if (phase === 2) {
    parts.push('\nProduce your planning deliverable with the ## SUBTASK DECOMPOSITION section. Write it to the deliverables/ folder.');
  } else if (ticketDepth >= 1) {
    parts.push(buildChildClosingInstruction());
  } else if (phase === 4) {
    parts.push('\nRead the planning deliverables, then execute the work. Produce real output, not outlines. Write to deliverables/ and create a developer handover.');
  } else if (phase === 5) {
    parts.push('\nTest the execution deliverables against the ticket requirements. Provide your verdict: PASS or FAIL with specific findings.');
  } else if (phase === 6) {
    parts.push('\nReview the full workspace for quality. Provide your verdict: APPROVED or NEEDS REVISION with specific issues.');
  } else {
    parts.push('\nComplete all work units above. Write deliverables to the deliverables/ folder and create a developer handover.');
  }

  return parts.join('\n');
}

// ── Previous Work + Sibling + Focus Chain helpers ──────────────────────

/**
 * @description Reads developer handovers from workspace and builds a "Previous Agent Work"
 * section so agents see what prior phases/rounds produced. This is the equivalent of the legacy
 * implementation injecting the last 5 Plane comments into the prompt (QueueManagerService.js:2317-2340).
 */
function buildPreviousWorkSection(workspaceTaskId: string | undefined): string | null {
  if (!workspaceTaskId) return null;

  const wsRoot = process.env.SHARED_WORKSPACE_ROOT
    || (require('fs').existsSync('/app/workspace') ? '/app/workspace' : require('path').resolve(process.cwd(), 'workspace-shared'));
  const handoverDir = require('path').join(wsRoot, workspaceTaskId, 'developer-handovers');

  try {
    if (!require('fs').existsSync(handoverDir)) return null;
    const files = require('fs').readdirSync(handoverDir) as string[];
    const mdFiles = files.filter((f: string) => f.endsWith('.md')).sort();
    if (mdFiles.length === 0) return null;

    const handoverTexts: string[] = [];
    for (const file of mdFiles.slice(-5)) { // Last 5 handovers
      const content = require('fs').readFileSync(require('path').join(handoverDir, file), 'utf-8') as string;
      // Truncate each handover to 2000 chars to keep context reasonable
      handoverTexts.push(`--- ${file} ---\n${content.slice(0, 2000)}`);
    }

    return `== PREVIOUS AGENT WORK ==

Other agents have already worked on this ticket. Review their handovers below and BUILD ON their work — do NOT repeat what's already been done.

${handoverTexts.join('\n\n')}

*Read the above carefully before starting your work.*
`;
  } catch {
    return null;
  }
}

/**
 * @description Builds a sibling awareness section for child tickets.
 * legacy parity: _buildChildTaskBrief passes siblingInfo so each child knows its siblings.
 */
function buildSiblingSection(payload: Record<string, unknown>): string | null {
  const siblings = payload.siblingTitles as string[] | undefined;
  if (!siblings || siblings.length === 0) return null;

  const siblingList = siblings.map((t, i) => `${i + 1}. **${t}**`).join('\n');
  return `== SIBLING SUBTASKS (Parallel Work) ==

Other agents are working on these related subtasks simultaneously.
**Do NOT duplicate their work.** Focus ONLY on your assigned task.

${siblingList}

*Your deliverable will be combined with sibling results on the parent ticket.*
`;
}

/**
 * @description Closing instruction for child tickets — includes focus chain pattern.
 * legacy parity: _buildChildTaskBrief teaches partial completion + re-queue.
 */
function buildChildClosingInstruction(): string {
  return `
Execute this subtask directly. Produce real deliverables — code, documents, analysis.
Write to the deliverables/ folder and create a developer handover in developer-handovers/.

== SESSION CONTINUITY (Focus Chain) ==

If this task is too large to complete in one session, use the **focus chain** pattern:
1. Do as much work as you can in this session
2. Write a Developer Handover summarizing what you accomplished
3. Mark your status as **Partial** in the handover
4. The next agent session will read your handover and continue where you left off

Do NOT produce empty stubs or outlines just to "complete" — do real work or mark Partial.
`;
}

/**
 * @description Builds a verification-only prompt so the task-manager judges existing output.
 * @param payload - Envelope payload containing original ticket context and execution output.
 * @returns Formatted verification request for the agent.
 */
function buildVerificationUserMessage(payload: Record<string, unknown>): string {
  const originalTicket = readRecord(payload.originalTicket);
  const originalExternalId = readText(originalTicket?.externalId) || readText(payload.externalId) || 'unknown';
  const originalTitle = readText(originalTicket?.title);
  const originalDescription = readText(originalTicket?.description);
  const executionOutput = formatExecutionOutput(payload.executionOutput);
  const workUnits = payload.workUnits as Array<Record<string, unknown>> | undefined;

  const parts = [
    `Verification Ticket: ${String(payload.externalId || `verify:${originalExternalId}`)}`,
    `Original Ticket: ${originalExternalId}`,
  ];

  if (originalTitle) {
    parts.push(`Original Title: ${originalTitle}`);
  }
  if (originalDescription) {
    parts.push('\nOriginal Ticket Description:');
    parts.push(originalDescription);
  }

  appendWorkUnits(parts, workUnits);

  if (executionOutput) {
    parts.push('\nExecution Output To Review:');
    parts.push('```text');
    parts.push(executionOutput);
    parts.push('```');
  }

  parts.push('\nYou are performing verification only. Review the provided execution output against the work units and acceptance criteria.');
  parts.push('Do not re-implement the ticket or bootstrap a new project unless the execution output is missing or unusable.');
  parts.push('Return a concise QA verdict using exactly one of: Verdict: APPROVED, Verdict: REJECTED, or Verdict: NEEDS REVISION.');
  parts.push('Include evidence-backed findings that cite the provided output.');
  return parts.join('\n');
}

/**
 * @description Builds a consensus-review prompt so reviewers judge existing output from the intended evidence angle.
 * @param payload - Envelope payload containing original ticket context, review focus, and execution output.
 * @returns Formatted consensus review request for the agent.
 */
function buildConsensusReviewUserMessage(payload: Record<string, unknown>): string {
  const originalTicket = readRecord(payload.originalTicket);
  const originalExternalId = readText(originalTicket?.externalId) || readText(payload.externalId) || 'unknown';
  const originalTitle = readText(originalTicket?.title);
  const originalDescription = readText(originalTicket?.description);
  const executionOutput = formatExecutionOutput(payload.executionOutput);
  const workUnits = payload.workUnits as Array<Record<string, unknown>> | undefined;
  const reviewFocus = readText(payload.reviewFocus);
  const reviewerRole = readText(payload.role);
  const round = readText(payload.round);

  const parts = [
    `Consensus Review Ticket: ${String(payload.externalId || `review:${originalExternalId}`)}`,
    `Original Ticket: ${originalExternalId}`,
  ];

  if (originalTitle) parts.push(`Original Title: ${originalTitle}`);
  if (reviewerRole) parts.push(`Reviewer Role: ${reviewerRole}`);
  if (round) parts.push(`Review Round: ${round}`);
  if (reviewFocus) parts.push(`Review Focus: ${reviewFocus}`);
  if (originalDescription) {
    parts.push('\nOriginal Ticket Description:');
    parts.push(originalDescription);
  }

  appendWorkUnits(parts, workUnits);

  if (executionOutput) {
    parts.push('\nExecution Output To Review:');
    parts.push('```text');
    parts.push(executionOutput);
    parts.push('```');
  }

  parts.push('\nYou are participating in consensus review only. Judge the provided execution output against the work units, acceptance criteria, and review focus.');
  parts.push('Do not re-implement the ticket or invent missing artifacts unless the provided output is unusable.');
  parts.push('Return a concise review verdict using exactly one of: Verdict: APPROVED, Verdict: REJECTED, or Verdict: NEEDS REVISION.');
  parts.push('Use this exact structure: Verdict: <...>, Findings:, - <finding>, Summary: <one-line conclusion>.');
  parts.push('Call out evidence and gaps that match the review focus, especially for testing, documentation, review, integration, or analysis work.');
  return parts.join('\n');
}

/**
 * @description Appends work unit details to a prompt section list.
 * @param parts - Prompt sections being assembled.
 * @param workUnits - Optional work units from the envelope payload.
 */
function appendWorkUnits(parts: string[], workUnits: Array<Record<string, unknown>> | undefined): void {
  if (!workUnits || workUnits.length === 0) {
    return;
  }
  parts.push(`\nWork Units (${workUnits.length}):`);
  for (const unit of workUnits) {
    parts.push(`\n## ${String(unit.title || 'Untitled')}`);
    if (unit.workType) {
      parts.push(`Work Type: ${String(unit.workType)}`);
    }
    if (unit.description) {
      parts.push(String(unit.description));
    }
    const criteria = unit.acceptanceCriteria as string[] | undefined;
    if (criteria && criteria.length > 0) {
      parts.push('Acceptance Criteria:');
      for (const ac of criteria) {
        parts.push(`- ${ac}`);
      }
    }
  }
}

/**
 * @description Reads a loose record value when the payload field contains an object.
 * @param value - Candidate payload field.
 * @returns Normalized record or null.
 */
function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

/**
 * @description Reads a trimmed text value from an unknown payload field.
 * @param value - Candidate payload value.
 * @returns Trimmed text or an empty string.
 */
function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @description Formats execution output for prompt injection without dumping unbounded payloads.
 * @param value - Execution output returned by the worker.
 * @returns Normalized output text capped for prompt safety.
 */
function formatExecutionOutput(value: unknown): string {
  const raw = extractExecutionOutputText(value);
  if (!raw) {
    return '';
  }
  return raw.length > 4000 ? `${raw.slice(0, 4000)}\n...[truncated]` : raw;
}

/**
 * @description Extracts the most useful execution output string from a worker result payload.
 * @param value - Execution output returned by the worker.
 * @returns Text for verification review, or an empty string when unavailable.
 */
function extractExecutionOutputText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  const record = readRecord(value);
  if (record && typeof record.content === 'string') {
    return record.content.trim();
  }
  if (record) {
    try {
      return JSON.stringify(record, null, 2);
    } catch (error) {
      logger.warn({ err: error }, 'Failed to stringify execution output for verification prompt');
      return '';
    }
  }
  return '';
}
