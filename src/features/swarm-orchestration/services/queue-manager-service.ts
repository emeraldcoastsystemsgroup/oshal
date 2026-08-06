/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Thread shared task/message stores into manifest-worker dispatch so remote bot-node results are visible to Jarvis ticket summarization.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Build-escalation debuggability (eval-wall 2026-06-22): the pipeline_work_items_failed escalation now embeds per-item failure detail (title + assigned agent + the extracted agent/CLI error) via summarizeFailedWorkItems, not just a count — turning "N items failed" into "here is why each failed" in ticket_status_history.metadata. Bounded + secret-free.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | QueueManagerPipelineDeps.workflowRunRecorder: optional run-history recorder threaded into the 'graph' dispatch path so each graph run + its per-node steps land in workflow_runs / workflow_run_steps (studio Runs panel). Telemetry only — never gates a dispatch.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | sweepAutoStartTickets: each poll, promote backlog tickets of an autoStart workflow to approved so published auto-start workflows run on arrival (skips the query when no autoStart workflow is registered).
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Park approved child tickets when their parent is escalated/cancelled so queue polling does not leave non-actionable children approved forever.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Widened WorkflowDefinition.pipeline to string; dispatcher now resolves via WorkflowPipelineRegistry so swarm apps can contribute workflows (ADR 2026-04-20 Phase 1 close)
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Session 97: Hardened duplicate child guard (default-true on failure, per-child idempotent creation, ghost "Step N" title filtering). Fixes 10-instead-of-5 children bug.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Session 98: Re-wire Step 7 — QM creates child tickets from planningDecomposition (LLM-generated titles) returned by processTickets(). Eliminates broken "0 children" state from Session 97 fix.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Initial QueueManagerService — background 60s polling loop that picks up approved tickets and feeds them into the swarm pipeline. Closes the "continuous polling" tech debt item from swarm-orchestration HANDOVER.
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Aligned QueueManagerService with canonical ExternalWorkItem and SwarmProcessingInput contracts so server TypeScript compilation passes.
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Wired TaskFolderService, TicketDecompositionService, SubtaskLifecycleService, and WorkspaceService into the dispatch pipeline. Implements workspace directory creation, ticket decomposition into subtasks with parent_ticket_id linkage, and bot-prefixed output file scaffolding.
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Session 91: Added runtime readiness pre-check before expensive pipeline work, graceful SwarmRuntimeUnavailableError handling (transition to in_process_design without rollback), enhanced diagnostic logging for ticket query results, and dev-mode fast polling.
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | Added ticket status transition to 'complete' after successful swarm pipeline execution
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | Inherited parent project metadata onto child tickets so cockpit project filters preserve the visible hierarchy for decomposed swarm work
 * 15 | maintainer@emeraldcoastsystemsgroup.com   | Fixed child ticket status from backlog→approved so poll loop picks them up for swarm dispatch
 * 16 | maintainer@emeraldcoastsystemsgroup.com   | Added workspace enrichment: task brief, bot context files, routing decisions, agent tracking, deliverable extraction after pipeline completion
 * 17 | maintainer@emeraldcoastsystemsgroup.com   | Wired ParentAssemblyService and CommentFormatter into QM. After child ticket completes, checks if all siblings are done and assembles parent. Ported from the legacy QueueManagerService.js:4539.
 * 18 | maintainer@emeraldcoastsystemsgroup.com   | Session 101: Extracted workspace helpers to queue-manager-workspace-helpers.ts. Added dispatch timeout (MAX_DISPATCH_DURATION_MS), stuck-slot watchdog in pollCycle, and escalation instead of infinite retry loop. Fixes stuck active=3 queue capacity issue.
 * 19 | maintainer@emeraldcoastsystemsgroup.com   | Session 101: Removed dead decomposeAndCreateSubtasks method (replaced by createChildTicketsFromPlanningOutput). Cleaned unused DecomposedWorkUnit import.
 * 20 | maintainer@emeraldcoastsystemsgroup.com   | Stuck-loop fix: escalate non-retryable dispatch failures (pipeline timeout + lifecycle/orchestration state errors) instead of rolling tickets back to approved.
 * 21 | maintainer@emeraldcoastsystemsgroup.com   | Session 109: Added dispatch circuit breaker (MAX_DISPATCH_ATTEMPTS=3) to prevent infinite re-dispatch loops. Tracks per-ticket attempt counts, escalates instead of re-dispatching after 3 failures. See ADR-023.
 * 22 | maintainer@emeraldcoastsystemsgroup.com   | Session 109: Added work item completion cascade — when ticket marked complete, all associated work items cascade to completed. Prevents stale Redis stream claims.
 * 23 | maintainer@emeraldcoastsystemsgroup.com   | Session 140: Queue manager skips paused/cancelled tickets in poll cycle
 * 24 | maintainer@emeraldcoastsystemsgroup.com   | Added routing-failure watchdog integration so stale or over-dispatched work items are marked routing_failed and surfaced to operators
 * 25 | maintainer@emeraldcoastsystemsgroup.com   | Escalation abort chain: subscribe to ticketEvents so externally escalated/cancelled tickets abort mid-flight dispatch immediately.
 * 26 | maintainer@emeraldcoastsystemsgroup.com   | Preserved PM-suggested agent assignments on child tickets so direct specialist execution honors decomposition routing intent
 * 27 | maintainer@emeraldcoastsystemsgroup.com   | Session 20: Added sweepDeferredTickets() — recovers root tickets stuck in in_process_design with no children when runtime becomes ready. Wired QueueGovernanceService for ticket lifecycle initialization.
 * 28 | maintainer@emeraldcoastsystemsgroup.com   | Added resolveAgentIdByName to QueueManagerPipelineDeps and resolveRoleToAgentId() method — child tickets now resolve PM-assigned role to agent UUID via live agent registry at creation time. Increased MAX_DISPATCH_DURATION_MS to 30min to match pipeline timeout.
 * 29 | maintainer@emeraldcoastsystemsgroup.com   | Replaced single-bot self-review with 2-bot RCA pipeline (worker + queue-bot reviewer). Added WORKFLOW_PIPELINES registry — ticketType drives pipeline selection. Each workflow is a distinct array entry; no overlap between bots.
 * 30 | maintainer@emeraldcoastsystemsgroup.com   | Pass ticketId in all send-message bodies so task-orchestrator linkTicketIfRequested creates ticket_task_links — cost rollup was orphaned (chat_tasks had data, ticket_task_links was empty).
 * 31 | maintainer@emeraldcoastsystemsgroup.com   | Fix dedup_key normalization: old regex only matched 3-segment prefixes (env:branch:rule.yaml:) but prod+main keys have fewer segments (config_path.yaml:suffix). Same incident created 2x tickets. Now strips everything up to last ".yaml:" regardless of prefix depth.
 * 32 | maintainer@emeraldcoastsystemsgroup.com   | ADR-083: QueueManagerPipelineDeps.resolveTaskWorker (knowledge-owner call-out for the 'task' lane) threaded into the manifest-worker dispatch, plus promoteToSwarm wired to dispatchTicket so an unclaimed COMPLEX task is promoted to the build/decompose lane — the queue manager has final say on the lane; Jarvis's complexity is a hint.
 * 33 | maintainer@emeraldcoastsystemsgroup.com   | 1000-line cap decomposition (continuing the dispatch-routing/dispatch-manifest-worker pattern): module-level dispatch helpers + child-ticket factory → queue-manager-dispatch-helpers.ts; sweep/recovery/reconciliation loops → queue-manager-sweeps.ts; the legacy staged-item intake + context prefetch → its own module (since deleted); incident 2-bot RCA pipeline → dispatch-incident-worker.ts. All previously-public symbols re-exported here for back-compat; behavior unchanged.
 * 34 | maintainer@emeraldcoastsystemsgroup.com   | Cost-governance pre-dispatch gate: optional BudgetService (setBudgetService) checked per ticket in the batch loop before dispatch — a HARD spend-cap breach or the runaway kill switch skips the ticket for THIS cycle only (stays approved, re-checked next poll). Unset service or any infra gap = unchanged behavior (fail-open).
 * 35 | maintainer@emeraldcoastsystemsgroup.com   | Queue DLQ hooks (dead-letter-service.ts, migration 081): setDeadLetterService + rollbackTicket now records each failed dispatch cycle in the PERSISTED oshal_queue_dlq counter (survives restarts, unlike dispatchCounts) and skips the roll-back-to-approved when the policy quarantines the ticket to terminal 'dead_letter'. Escalation-loop cycles are counted by the service's own ticketEvents subscription — no extra hook here. All new logic lives in the sibling module; unset service = unchanged behavior.
 * 36 | maintainer@emeraldcoastsystemsgroup.com   | Review fix (DLQ requeue): the ticketEvents listener now clears the in-memory dispatchCounts/recoveredTicketIds/abortedTicketIds on a dead_letter → approved transition (the operator requeue). Without this the persisted counter reset by the route-side DeadLetterService was invisible to this QM's circuit breaker, so a requeued ticket was re-escalated on the next poll with zero fresh attempts — requeue was inert until an api restart.
 * 37 | maintainer@emeraldcoastsystemsgroup.com   | Removed the retired legacy OpenSearch staged-item intake: dropped its service field/import/ctor, the env-gated poll hook, and the queue-reset method (+ its cockpit route). There is no OpenSearch; the intake was permanently gated off and its module is deleted. incident-rca dispatch is unaffected — it self-gates without the external alarm feed.
 * 38 | maintainer@emeraldcoastsystemsgroup.com   | Parent-completes-early fix (tracked backlog item, commit 494e90ff): dispatchTicket's unconditional 'complete' write now runs through shouldDeferCompletionToChildren — a dispatched ticket with >=1 non-terminal child is never marked terminal from its own pipeline result. The post-build-gate re-dispatch (existingChildren > 0 → in_process_build entry, no re-planning, planningDecomposition undefined) fell through both Step-7 guards straight to 'complete' while children were still building; and since VALID_TRANSITIONS.complete only allows backlog, the later all-children assembly (→ customer_action) and child-failure escalation rollup both threw and were swallowed — the parent was permanently wedged terminal. The gate delegates to ParentAssemblyService.checkAndAssemble so the existing rollup semantics apply unchanged, and mirrors the SP-8 in_process_build projection from sweepStaleParents while children are in flight.
 * 39 | maintainer@emeraldcoastsystemsgroup.com   | Ran the poll loop + startup orphan recovery under runWithSystemIdentity: the queue manager is background work (no request in scope) that reads/writes the FORCE-RLS tickets table and dispatches into per-user chat_tasks. Stamping SYSTEM keeps it visible once OSHAL_DB_GUC_STRICT denies the identity-less case (before, it relied on the fail-open-to-operator branch that deny removes).
 * 40 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed retired legacy product references (provider name is noop; narration removed)
 * 41 | maintainer@emeraldcoastsystemsgroup.com   | Idle-timeout directive (adversarial-review follow-up): DISPATCH_PIPELINE_TIMEOUT_MS + MAX_DISPATCH_DURATION_MS raised 30min→2h and made env-tunable — the 30-min queue watchdog was killing actively-working pipelines below the 60-min harness idle ceiling. The pair stays coupled (watchdog never fires before the pipeline times out); the real stuck-detector is the harness idle timeout underneath.
 * 42 | maintainer@emeraldcoastsystemsgroup.com   | Docs-only: added the missing JSDoc block to dispatchTicket (the exported class's core swarm/build dispatch path) — every other method already carried one. Explains WHY it is the heavy path (owns child-ticket creation + parent-assembly + failure triage). No logic change (additive comment only).
 * 43 | maintainer@emeraldcoastsystemsgroup.com   | ADR-119 P4 (A2): setAutoApplyGate — the bounded auto-apply hook threaded into the incident-RCA dispatch deps, wired at the app layer exactly like setBudgetService (optional; unset = unchanged Mode-A human gate). The hook is only ever consulted by the incident pipeline's Mode-A finalizer, never by the build/manifest/graph paths.
 * 44 | maintainer@emeraldcoastsystemsgroup.com   | Document the promoted default-on/fail-closed ADR-034 runtime-param rail threaded into manifest and incident dispatches.
 */

import type { InternalTicket } from '@/entities/ticket';
import type { IMessageStore } from '@/entities/message';
import type { ITaskStore } from '@/entities/task';
import type { TicketService } from '@/features/ticketing';
import type { WorkspaceService } from '@/features/ticketing';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { SwarmRuntimeUnavailableError, type SwarmTicketProcessingService, type SwarmProcessingInput } from './swarm-ticket-processing-service';
import { PlanningDecompositionError } from './ticket-decomposition-service';
import type { TaskFolderService } from './task-folder-service';
import type { TicketDecompositionService } from './ticket-decomposition-service';
import type { SubtaskLifecycleService } from './subtask-lifecycle-service';
import type { WorkItemRepository } from '@/entities/work-item';
import { ParentAssemblyService } from './parent-assembly-service';
import { CommentFormatter } from './comment-formatter';
import {
  createTicketWorkspace,
  resolveRootTicketId,
  writeTaskBrief,
  enrichWorkspaceAfterPipeline,
} from './queue-manager-workspace-helpers';
import { WorkItemRoutingWatchdogService } from './work-item-routing-watchdog-service';
import type { QueueGovernanceService } from './queue-governance-service';
import type { DeadLetterService } from './dead-letter-service';
import { BudgetService } from '@/features/cost-governance';
import { ticketEvents } from '@/shared/ticket-events';

const logger = createChildLogger({ module: 'QueueManagerService' });


// Routing types + pure decision function moved to ./dispatch-routing.ts
// to start chipping away at this 2300+ line file (audit P0). The exports
// below are re-exported through queue-manager-service for back-compat —
// callers still importing from here keep working.
export {
  WORKFLOW_PIPELINES,
  chooseDispatchPath,
  BUILT_IN_TICKET_TYPES,
} from './dispatch-routing';
export type { WorkflowDefinition } from './dispatch-routing';
import {
  WORKFLOW_PIPELINES,
  chooseDispatchPath,
  type WorkflowDefinition,
} from './dispatch-routing';
import { dispatchManifestWorkerTicket as dispatchManifestWorkerTicketImpl } from './dispatch-manifest-worker';
import { dispatchGraphTicket as dispatchGraphTicketImpl } from './dispatch-graph-worker';
// Incident 2-bot RCA pipeline moved to ./dispatch-incident-worker.ts
// (1000-line cap decomposition).
import { dispatchIncidentTicket as dispatchIncidentTicketImpl, type IncidentAutoApplyHook } from './dispatch-incident-worker';

// Module-level dispatch helpers (planning-role inference, capability routing maps,
// dispatch entry-state resolution, failed-work-item summarization, child-ticket
// factory) moved to ./queue-manager-dispatch-helpers.ts (1000-line cap
// decomposition). The previously-public helpers are re-exported below for
// back-compat — callers still importing from here keep working.
export {
  inferPlanningUnitSuggestedRole,
  normalizePlanningRole,
  extractWorkItemError,
  summarizeFailedWorkItems,
} from './queue-manager-dispatch-helpers';
export type { FailedWorkItemSummary } from './queue-manager-dispatch-helpers';
import {
  MAX_DISPATCH_ATTEMPTS,
  buildWorkItem,
  createChildTicketsFromPlanningOutput,
  extractErrorMessage,
  isNonRetryableDispatchError,
  resolveDispatchEntryState,
  resolveRootTicketCapabilities,
  resolveSpecialistCapabilities,
  summarizeFailedWorkItems,
} from './queue-manager-dispatch-helpers';

const DEFAULT_POLL_INTERVAL_MS = Number(process.env.QUEUE_POLL_INTERVAL_MS) || (process.env.NODE_ENV === 'development' ? 30_000 : 60_000);
const DEFAULT_MAX_CONCURRENT = 5;
// Idle-timeout directive 2026-07-24 (adversarial-review follow-up): these queue-level
// DURATION bounds sat at 30 min and silently undercut the 60-min harness idle ceiling —
// an actively-working 31-minute pipeline was killed here even though no LLM call was
// stuck. A pipeline chains planning + one or more executions (each now silence-bounded
// up to 60 min) + review, so its coarse runaway backstop must sit ABOVE a single call's
// ceiling. Default 2h (matches the codex max-duration philosophy), env-tunable. The real
// "stuck" detector is the harness idle timeout underneath, not this wall-clock bound.
/** @description Overall timeout for the swarm processing pipeline call within a single dispatch. */
const DISPATCH_PIPELINE_TIMEOUT_MS = Number(process.env.DISPATCH_PIPELINE_TIMEOUT_MS) || 2 * 60 * 60 * 1000; // 2h runaway backstop
/** @description Maximum time a single dispatch can occupy an active slot before being forcibly escalated. Must track DISPATCH_PIPELINE_TIMEOUT_MS so the slot watchdog never kills a dispatch before the pipeline itself times out. */
const MAX_DISPATCH_DURATION_MS = Number(process.env.MAX_DISPATCH_DURATION_MS) || DISPATCH_PIPELINE_TIMEOUT_MS;

// Sweep/recovery loops + the parent-gate moved to ./queue-manager-sweeps.ts
// (1000-line cap decomposition). terminalChildStatusForParentState is
// re-exported for back-compat — callers still importing from here keep working.
export { terminalChildStatusForParentState } from './queue-manager-sweeps';
import {
  type QueueSweepDeps,
  sweepAutoStartTickets as sweepAutoStartTicketsImpl,
  sweepStaleParents as sweepStaleParentsImpl,
  sweepDeferredTickets as sweepDeferredTicketsImpl,
  isDispatchBlockedByParentState as isDispatchBlockedByParentStateImpl,
} from './queue-manager-sweeps';

// The RCA mode contract lives in `rca-mode.ts` so the Argo batch path can read the mode from the
// SAME canonical source (line 1 of RCA-REPORT.md) without importing this whole queue manager into a
// one-shot Job pod. Re-exported here so every existing call site and test is unchanged.
export { INCIDENT_MODE_DISPOSITION, readRcaMode } from './rca-mode';


/**
 * @description Configuration options for the QueueManagerService.
 */
export interface QueueManagerOptions {
  /**
   * How often (in milliseconds) to poll for approved tickets.
   * Defaults to 60000 (60 seconds).
   */
  pollIntervalMs?: number;
  /**
   * Maximum number of tickets to hold in-flight simultaneously.
   * Defaults to 3.
   */
  maxConcurrent?: number;
}

/**
 * @description Pipeline service dependencies injected into QueueManagerService.
 */
export interface QueueManagerPipelineDeps {
  taskFolderService: TaskFolderService;
  decompositionService: TicketDecompositionService;
  subtaskLifecycleService: SubtaskLifecycleService;
  workspaceService: WorkspaceService;
  workItemRepository?: WorkItemRepository;
  /** @description Resolves a persona name (e.g. "code-developer") to agent UUID from the live registry. */
  resolveAgentIdByName?: (name: string) => Promise<string | undefined>;
  /**
   * @description Optional BotNodeClient for HTTP dispatch to any-bot worker nodes.
   * When provided, incident/workflow pipelines dispatch work via HTTP POST to the
   * any-bot's /api/swarm-execute endpoint instead of calling the local /api/send-message.
   *
   * Per any-bot-swarm-separation-design.md: the swarm controller NEVER calls an LLM.
   * It dispatches to bot nodes which handle execution end-to-end.
   */
  botNodeClient?: import('@/features/agent-management').BotNodeClient;
  /** Shared controller stores used to persist dedicated bot-node manifest-worker results. */
  taskStore?: ITaskStore;
  messageStore?: IMessageStore;
  /** Owner-scoped connector credential broker for dedicated manifest workers. */
  resolveBotCreds?: (
    ownerSub: string,
    workerAgentId: string,
    providerIntent?: import('@/app/bot-node-provider-intent').TrustedProviderIntent,
  ) => Promise<Record<string, string>>;
  /**
   * @description Optional run-history recorder for the 'graph' dispatch path
   * (workflow_runs / workflow_run_steps — the studio Runs panel). All recorder
   * methods are non-throwing by contract; recording never gates a dispatch.
   */
  workflowRunRecorder?: import('@/features/workflow-studio').WorkflowRunRecorder;
  /**
   * @description ADR-083 knowledge-owner call-out for the generic 'task' lane: broadcasts
   * a BID_REQUEST to online owners and decides via the AgentRouter cascade. When absent,
   * task tickets fall back to the workflow's declared workerBot (pre-ADR-083 behavior).
   */
  resolveTaskWorker?: import('./task-call-out').TaskCallOutResolver;
  /** Executes a generic task on an exact registered remote-client target before bidding. */
  dispatchExplicitRemoteTask?: import('./dispatch-manifest-worker').ManifestWorkerDispatchDeps['dispatchExplicitRemoteTask'];
  /** Executes a job-application ticket through the browser submission rail. */
  dispatchJobApplicationTask?: import('./dispatch-manifest-worker').ManifestWorkerDispatchDeps['dispatchJobApplicationTask'];
  /**
   * @description ADR-034 gap-b push-on-dispatch resolver: yields a target agent's
   * authoritative provider/model/configVersion record so manifest-worker + incident
   * dispatches can stamp it on the BotNodeClient.execute request (gated by
   * OSHAL_PUSH_ON_DISPATCH, default on). Missing records are marked for bot-side refusal;
   * explicit flag-off restores legacy dispatch.
   */
  runtimeParamsResolver?: import('@/features/agent-management').RuntimeParamsResolver;
}

/**
 * @description Background scheduler that watches the internal ticket store for approved
 * tickets and feeds them into the swarm pipeline automatically.
 *
 * Design mirrors the legacy implementation's QueueManagerService pattern:
 *  - `start()` kicks off a `setInterval` polling loop
 *  - Each cycle claims up to `maxConcurrent` approved tickets
 *  - Tickets are transitioned into a truthful dispatch state before dispatch:
 *      - `in_process_discovery` for structured root tickets
 *      - `in_process_build` for child or direct-execution tickets
 *  - On swarm pipeline failure the ticket is rolled back to `approved` for retry
 *
 * Pipeline wiring (Session 90):
 *  1. Transition ticket into its dispatch entry state
 *  2. Create workspace directory via TaskFolderService
 *  3. Create/link DB workspace via WorkspaceService
 *  4. Decompose ticket into work units via TicketDecompositionService
 *  5. Create child tickets with parent_ticket_id linkage
 *  6. Register parent + subtasks in SubtaskLifecycleService
 *  7. Submit to swarm processing pipeline
 *
 * Only the project-manager bot should instantiate and start this service.
 */
/**
 * @description Background scheduler that polls the internal ticket store for approved tickets
 * and feeds them into the swarm pipeline. Owns concurrency limiting, stuck-slot and circuit-breaker
 * guards, deferred/orphaned ticket recovery, child-ticket creation from PM
 * planning output, and parent assembly after children complete. Only the project-manager bot should
 * instantiate and start this service.
 */
export class QueueManagerService {
  private intervalRef: ReturnType<typeof setInterval> | null = null;
  private readonly activeTicketIds = new Set<string>();
  /** @description Tracks when each active ticket entered dispatch, for stuck-slot detection. */
  private readonly dispatchStartTimes = new Map<string, number>();
  /** @description Tracks how many times each ticket has been dispatched. Circuit breaker for re-dispatch loops. */
  private readonly dispatchCounts = new Map<string, number>();
  /** @description Tickets externally escalated or cancelled while mid-flight. Checked at dispatch phase boundaries to abort processing. */
  private readonly abortedTicketIds = new Set<string>();
  /** @description Tickets already recovered by sweepDeferredTickets — prevents bounce loops. */
  private readonly recoveredTicketIds = new Set<string>();
  private readonly pollIntervalMs: number;
  private readonly maxConcurrent: number;
  private readonly parentAssemblyService: ParentAssemblyService;
  private readonly commentFormatter: CommentFormatter;
  private readonly workItemRoutingWatchdog?: WorkItemRoutingWatchdogService;
  private governanceService?: QueueGovernanceService;

  /**
   * @description Sets the governance service for ticket lifecycle tracking.
   * @param service - QueueGovernanceService instance from composition root
   */
  setGovernanceService(service: QueueGovernanceService): void {
    this.governanceService = service;
    logger.info('QueueGovernanceService wired into QueueManagerService');
  }

  /** @description Cost-governance budget gate (spend caps + runaway kill switch); optional — absent means no budget enforcement. */
  private budgetService?: BudgetService;

  /** @description Persisted poison-ticket policy (oshal_queue_dlq); optional — absent means the legacy in-memory circuit breaker only. */
  private deadLetterService?: DeadLetterService;

  /**
   * @description Sets the DeadLetterService so failed dispatch cycles are tracked in the
   * persisted DLQ counter and poison tickets quarantine to 'dead_letter' instead of cycling.
   * Optional wiring — when unset, dispatch behaves exactly as before (in-memory breaker only).
   * @param service - DeadLetterService instance from the swarm extension composition.
   * @returns void
   */
  setDeadLetterService(service: DeadLetterService): void {
    this.deadLetterService = service;
    logger.info('DeadLetterService wired into QueueManagerService');
  }

  /**
   * @description Sets the cost-governance BudgetService so each poll-cycle dispatch is
   * pre-checked against spend budgets + the runaway-loop kill switch. Optional wiring —
   * when unset, dispatch behaves exactly as before (no budget enforcement).
   * @param service - BudgetService instance from the swarm extension composition
   * @returns void
   */
  setBudgetService(service: BudgetService): void {
    this.budgetService = service;
    logger.info('Cost-governance BudgetService wired into QueueManagerService');
  }

  /** @description ADR-119 P4 (A2): the bounded auto-apply gate for Mode-A incident verdicts; optional — absent means the unchanged human approve gate. */
  private autoApplyGate?: IncidentAutoApplyHook;

  /**
   * @description Sets the ADR-119 A2 auto-apply gate the incident pipeline's Mode-A
   * finalizer consults (same optional-hook wiring shape as setBudgetService). The gate
   * itself owns every A2 bound — kill switch (default OFF), sanctioned classes, the
   * absolute core-infra refusal, once-per-key-per-TTL, the hourly cap, and
   * verification-before-complete. Unset = Mode A always parks at the human gate.
   * @param hook - The auto-apply engine from the swarm extension composition.
   * @returns void
   */
  setAutoApplyGate(hook: IncidentAutoApplyHook): void {
    this.autoApplyGate = hook;
    logger.info('ADR-119 auto-apply gate wired into QueueManagerService (kill switch governs activation)');
  }

  /**
   * @description Creates a QueueManagerService.
   * @param ticketService - Used to query approved tickets and transition their state
   * @param swarmProcessingService - Used to submit tickets to the swarm pipeline
   * @param pipelineDeps - Pipeline services for workspace, decomposition, and subtask lifecycle
   * @param options - Optional configuration overrides
   */
  constructor(
    private readonly ticketService: TicketService,
    private readonly swarmProcessingService: SwarmTicketProcessingService,
    private readonly pipelineDeps?: QueueManagerPipelineDeps,
  ) {
    this.pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
    this.maxConcurrent = DEFAULT_MAX_CONCURRENT;
    this.parentAssemblyService = new ParentAssemblyService(ticketService);
    this.commentFormatter = new CommentFormatter();
    this.workItemRoutingWatchdog = this.pipelineDeps?.workItemRepository
      ? new WorkItemRoutingWatchdogService(
          this.pipelineDeps.workItemRepository,
          undefined,
          (ticketId, status, metadata) => this.ticketService.updateStatus(ticketId, status, metadata),
          async (ticketId) => (await this.ticketService.getTicket(ticketId))?.status ?? null,
        )
      : undefined;

    // ── Escalation abort chain ────────────────────────────────────────
    // When any ticket is escalated or cancelled externally (operator action, cockpit UI),
    // immediately flag it so the next phase boundary check in dispatchTicket() aborts.
    ticketEvents.onStatusChanged(({ ticketId, fromStatus, toStatus }) => {
      if (toStatus === 'escalated' || toStatus === 'cancelled') {
        if (this.activeTicketIds.has(ticketId)) {
          logger.warn(
            { ticketId, toStatus },
            'Active dispatch externally aborted — marking for abort at next phase boundary',
          );
          this.abortedTicketIds.add(ticketId);
          // Release the active slot immediately so the queue can pick up new work
          this.activeTicketIds.delete(ticketId);
          this.dispatchStartTimes.delete(ticketId);
        }
      }
      // ── DLQ requeue release ───────────────────────────────────────────
      // dead_letter → approved is exclusively the operator DLQ requeue (no other transition
      // reaches it). The DeadLetterService resets the PERSISTED attempt counter, but the
      // route-side requeue runs on a separate DeadLetterService instance with no handle on
      // this QM's in-memory circuit breaker. Without clearing it here, the next poll cycle
      // sees a stale dispatchCounts >= MAX and re-escalates the ticket with zero fresh
      // attempts — making requeue inert until an api restart. Clear the in-memory dispatch
      // tracking so the requeued ticket genuinely starts fresh (the requeue contract).
      if (fromStatus === 'dead_letter' && toStatus === 'approved') {
        const hadCount = this.dispatchCounts.delete(ticketId);
        this.recoveredTicketIds.delete(ticketId);
        this.abortedTicketIds.delete(ticketId);
        logger.info(
          { ticketId, clearedInMemoryAttempts: hadCount },
          'DLQ requeue detected (dead_letter → approved) — cleared in-memory dispatch tracking so the circuit breaker starts fresh',
        );
      }
    });
  }

  /**
   * @description Starts the polling loop. Idempotent — safe to call when already running.
   * @returns Nothing
   */
  start(): void {
    if (this.intervalRef !== null) {
      logger.warn('Queue manager is already running');
      return;
    }
    logger.info(
      { pollIntervalMs: this.pollIntervalMs, maxConcurrent: this.maxConcurrent },
      'Queue manager starting',
    );
    // Recover any tickets left in_process_discovery from a previous crash/restart.
    // Their Cline processes were killed — re-queue so they get a fresh dispatch.
    // Background work — run under the SYSTEM sentinel so the tickets/chat_tasks (FORCE-RLS)
    // reads/writes keep operator visibility once OSHAL_DB_GUC_STRICT denies the identity-less case.
    void runWithSystemIdentity(() => this.recoverOrphanedTickets());
    void runWithSystemIdentity(() => this.pollCycle());
    this.intervalRef = setInterval(() => void runWithSystemIdentity(() => this.pollCycle()), this.pollIntervalMs);
    (this.intervalRef as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
    logger.info('Queue manager started');
  }

  /**
   * @description On startup, moves tickets stuck in early dispatch states back to approved.
   * These were orphaned when the process was killed mid-dispatch (no in-flight work survives restart).
   *
   * Covers discovery and design states — both are single-bot phases with no spawned children.
   * Build-phase and later states are handled by sweepDeferredTickets() (15-min grace period)
   * because child tickets in those phases may still be running in separate containers.
   */
  private async recoverOrphanedTickets(): Promise<void> {
    try {
      const [discoveryTickets, designTickets] = await Promise.all([
        this.ticketService.listTickets({ status: 'in_process_discovery' }),
        this.ticketService.listTickets({ status: 'in_process_design' }),
      ]);
      const orphaned = [...discoveryTickets, ...designTickets].filter((t) => !t.parentTicketId);
      if (orphaned.length === 0) return;

      logger.warn({ count: orphaned.length }, 'Startup recovery — re-queuing orphaned pre-build tickets');
      for (const ticket of orphaned) {
        await this.ticketService.updateStatus(ticket.ticketId, 'approved');
        logger.info({ ticketId: ticket.ticketId, title: ticket.title, status: ticket.status }, 'Orphaned ticket re-queued to approved');
      }
    } catch (error) {
      logger.error({ err: error }, 'Startup recovery sweep failed — continuing without recovery');
    }
  }

  /**
   * @description Stops the polling loop. Idempotent — safe to call when not running.
   * @returns Nothing
   */
  stop(): void {
    if (this.intervalRef === null) {
      logger.warn('Queue manager is not running');
      return;
    }
    clearInterval(this.intervalRef);
    this.intervalRef = null;
    logger.info({ activeTickets: this.activeTicketIds.size }, 'Queue manager stopped');
  }

  /**
   * @description Executes one poll cycle: queries for approved tickets and dispatches up to the
   * available concurrency slots.
   * @returns Nothing
   */
  private async pollCycle(): Promise<void> {
    const startedAt = Date.now();
    const available = this.maxConcurrent - this.activeTicketIds.size;

    // ── Stuck-slot watchdog ──────────────────────────────────────────
    // Detect tickets that have been in the active set too long (likely hung dispatch).
    // Forcibly remove them and escalate, freeing the slot for new work.
    const now = Date.now();
    for (const [stuckId, startTime] of this.dispatchStartTimes.entries()) {
      if (now - startTime > MAX_DISPATCH_DURATION_MS) {
        logger.error(
          { ticketId: stuckId, durationMs: now - startTime, maxMs: MAX_DISPATCH_DURATION_MS },
          'Stuck dispatch detected — forcibly releasing slot and escalating ticket',
        );
        void this.workItemRoutingWatchdog?.markTicketRoutingFailures(stuckId, 'dispatch_slot_timeout');
        this.activeTicketIds.delete(stuckId);
        this.dispatchStartTimes.delete(stuckId);
        // Best-effort escalation — don't let this block the poll cycle
        this.ticketService.updateStatus(stuckId, 'escalated', {
          reason: 'dispatch_slot_timeout',
          source: 'queue-manager-stuck-slot-watchdog',
          durationMs: now - startTime,
          maxMs: MAX_DISPATCH_DURATION_MS,
        }).catch((err) => {
          logger.error({ err, ticketId: stuckId }, 'Failed to escalate stuck ticket');
        });
      }
    }

    if (this.workItemRoutingWatchdog) {
      await this.workItemRoutingWatchdog.sweepRecentWorkItems();
      await this.workItemRoutingWatchdog.retryRoutingFailedItems();
    }

    const availableAfterCleanup = this.maxConcurrent - this.activeTicketIds.size;
    if (availableAfterCleanup <= 0) {
      logger.info(
        { active: this.activeTicketIds.size, max: this.maxConcurrent },
        'Queue at capacity — skipping poll cycle',
      );
      return;
    }

    // Promote backlog tickets of auto-start workflows to approved so they run on arrival
    // without a manual gate (human pauses live in the graph's approval-gate nodes).
    await this.sweepAutoStartTickets();

    let approvedTickets: InternalTicket[];
    try {
      approvedTickets = await this.ticketService.listTickets({ status: 'approved' });
    } catch (err) {
      logger.error({ err }, 'Failed to query approved tickets — will retry next cycle');
      return;
    }

    logger.info(
      {
        approvedTotal: approvedTickets.length,
        activeCount: this.activeTicketIds.size,
        available,
        ticketIds: approvedTickets.map((t) => t.ticketId),
        durationMs: Date.now() - startedAt,
      },
      'Poll cycle ticket query completed',
    );

    const candidates = approvedTickets.filter((t) => {
      // Skip paused or cancelled tickets
      if (t.status === 'paused' || t.status === 'cancelled') return false;
      if (this.activeTicketIds.has(t.ticketId)) return false;
      const attempts = this.dispatchCounts.get(t.ticketId) ?? 0;
      if (attempts >= MAX_DISPATCH_ATTEMPTS) {
        logger.warn(
          { ticketId: t.ticketId, attempts, max: MAX_DISPATCH_ATTEMPTS },
          'Circuit breaker: ticket exceeded max dispatch attempts — escalating instead of re-dispatching',
        );
        void this.workItemRoutingWatchdog?.markTicketRoutingFailures(t.ticketId, 'max_dispatch_attempts_exceeded');
        this.ticketService.updateStatus(t.ticketId, 'escalated', {
          reason: 'max_dispatch_attempts_exceeded',
          source: 'queue-manager-circuit-breaker',
          attempts,
          maxAttempts: MAX_DISPATCH_ATTEMPTS,
        }).catch((err) => {
          logger.error({ err, ticketId: t.ticketId }, 'Failed to escalate over-dispatched ticket');
        });
        return false;
      }
      return true;
    });
    const batch: InternalTicket[] = [];

    // ── Deferred ticket recovery ───────────────────────────────────────
    // Root tickets stuck in discovery/design/build with no active execution are deferred —
    // runtime was unavailable when they were dispatched. Roll them back to
    // approved so the next poll cycle retries them.
    await this.sweepDeferredTickets();

    // ── Parent assembly sweep ────────────────────────────────────────
    // Check for parent tickets in active orchestration states whose children are all complete.
    // This handles the race where all children finish between poll cycles and the
    // per-child assembly check ran before the last child was committed.
    if (this.parentAssemblyService) {
      await this.sweepStaleParents();
    }

    for (const candidate of candidates) {
      if (batch.length >= availableAfterCleanup) {
        break;
      }
      const currentCandidate = await this.ticketService.getTicket(candidate.ticketId).catch(() => null);
      if (!currentCandidate || currentCandidate.status !== 'approved') {
        logger.info(
          { ticketId: candidate.ticketId, status: currentCandidate?.status ?? null },
          'Skipping candidate whose status changed during queue sweeps',
        );
        continue;
      }
      if (await this.isDispatchBlockedByParentState(currentCandidate)) {
        continue;
      }
      batch.push(currentCandidate);
    }

    if (batch.length === 0) {
      logger.debug(
        { approvedTotal: approvedTickets.length, activeCount: this.activeTicketIds.size },
        'No unhandled approved tickets available',
      );
      return;
    }

    logger.info(
      { batchSize: batch.length, approvedTotal: approvedTickets.length, activeCount: this.activeTicketIds.size },
      'Dispatching approved ticket batch',
    );

    const { WorkflowPipelineRegistry } = await import('./workflow-pipeline-registry.js');
    const registry = WorkflowPipelineRegistry.getInstance();
    const builtInTicketTypes = new Set(WORKFLOW_PIPELINES.map((w) => w.ticketType));
    for (const ticket of batch) {
      const ticketType = ((ticket as Record<string, unknown>).ticketType as string | undefined) ?? 'build';
      const workflow = registry.resolve(ticketType);
      const decision = chooseDispatchPath(ticketType, workflow, builtInTicketTypes);
      // Cost-governance pre-dispatch gate: a HARD budget breach or the runaway kill switch
      // blocks THIS cycle only — the ticket stays approved and is re-checked next poll, so
      // raising the cap (or the loop cooling off) resumes it without operator surgery.
      const budgetVerdict = this.budgetService
        ? await this.budgetService.checkBudget(ticket.ownerSub ?? null, ticketType, ticket.ticketId)
        : null;
      if (budgetVerdict && !budgetVerdict.allowed) {
        logger.warn(
          { ticketId: ticket.ticketId, reason: budgetVerdict.reason, spend: budgetVerdict.spend, cap: budgetVerdict.cap },
          'Budget governance blocked dispatch — ticket stays approved for re-check next cycle',
        );
        continue;
      }
      switch (decision) {
        case 'defer':
          // Startup race guard: registry hasn't loaded the manifest yet.
          logger.warn(
            { ticketId: ticket.ticketId, ticketType },
            'Workflow not yet registered for app-contributed ticketType — deferring to next poll cycle',
          );
          continue;
        case 'incident-rca':
          void this.dispatchIncidentTicket(ticket, workflow!);
          break;
        case 'manifest-worker':
          void this.dispatchManifestWorkerTicket(ticket, workflow!);
          break;
        case 'graph':
          void this.dispatchGraphTicket(ticket, workflow!);
          break;
        case 'swarm':
          void this.dispatchTicket(ticket);
          break;
      }
    }
  }

  /**
   * @description Assembles the sweep-loop dependency bundle from this service's private state.
   * @returns Deps consumed by the free sweep functions in queue-manager-sweeps.ts.
   */
  private sweepDeps(): QueueSweepDeps {
    return {
      ticketService: this.ticketService,
      parentAssemblyService: this.parentAssemblyService,
      workItemRepository: this.pipelineDeps?.workItemRepository,
      activeTicketIds: this.activeTicketIds,
      recoveredTicketIds: this.recoveredTicketIds,
      dispatchCounts: this.dispatchCounts,
      swarmProcessingService: this.swarmProcessingService,
    };
  }

  /**
   * @description Thin delegator to the extracted auto-start sweep (queue-manager-sweeps.ts).
   * @returns Resolves when the sweep completes.
   */
  private async sweepAutoStartTickets(): Promise<void> {
    return sweepAutoStartTicketsImpl(this.sweepDeps());
  }



  /**
   * @description Thin delegator to the extracted parent-state dispatch gate (queue-manager-sweeps.ts).
   * @param ticket - The approved candidate ticket.
   * @returns True when the child must not dispatch yet.
   */
  private async isDispatchBlockedByParentState(ticket: InternalTicket): Promise<boolean> {
    return isDispatchBlockedByParentStateImpl(ticket, this.sweepDeps());
  }

  /**
   * @description Thin delegator to the extracted stale-parent assembly sweep (queue-manager-sweeps.ts).
   * @returns Resolves when the sweep completes.
   */
  private async sweepStaleParents(): Promise<void> {
    return sweepStaleParentsImpl(this.sweepDeps());
  }

  /**
   * @description Thin delegator to the extracted deferred/orphaned ticket recovery sweep
   * (queue-manager-sweeps.ts).
   * @returns Resolves when the sweep completes.
   */
  private async sweepDeferredTickets(): Promise<void> {
    return sweepDeferredTicketsImpl(this.sweepDeps());
  }


  /**
   * @description Dispatch a ticket whose workflow was contributed by a swarm-app
   * manifest. Implementation moved to ./dispatch-manifest-worker.ts; this
   * method is a thin delegator that wires the QueueManagerService's private
   * state into the free function's deps object.
   */
  private async dispatchManifestWorkerTicket(
    ticket: InternalTicket,
    workflow: WorkflowDefinition,
  ): Promise<void> {
    return dispatchManifestWorkerTicketImpl(ticket, workflow, {
      activeTicketIds: this.activeTicketIds,
      dispatchStartTimes: this.dispatchStartTimes,
      resolveAgentIdByName: this.pipelineDeps?.resolveAgentIdByName,
      botNodeClient: this.pipelineDeps?.botNodeClient,
      ticketService: this.ticketService,
      taskStore: this.pipelineDeps?.taskStore,
      messageStore: this.pipelineDeps?.messageStore,
      resolveBotCreds: this.pipelineDeps?.resolveBotCreds,
      // ADR-083: call-out routing for the 'task' lane + promotion of unclaimed
      // complex tasks into the build/decompose pipeline (the queue manager's
      // final say on the lane — Jarvis's complexity is only a hint).
      resolveTaskWorker: this.pipelineDeps?.resolveTaskWorker,
      dispatchExplicitRemoteTask: this.pipelineDeps?.dispatchExplicitRemoteTask,
      dispatchJobApplicationTask: this.pipelineDeps?.dispatchJobApplicationTask,
      promoteToSwarm: (t) => this.dispatchTicket(t),
      // ADR-034 gap-b push-on-dispatch: carry the authoritative config record per dispatch
      // (default-on OSHAL_PUSH_ON_DISPATCH). An absent resolver becomes an explicit
      // unavailable-authority marker; flag-off is the compatibility rollback.
      runtimeParamsResolver: this.pipelineDeps?.runtimeParamsResolver,
    });
  }

  /**
   * @description Thin delegator that wires this service's private dispatch state
   * into the free dispatchStagedTicket function (the 'staged' authored-workflow
   * pipeline). One call dispatches the ticket's CURRENT stage and advances it.
   */
  /**
   * @description Delegator for the 'graph' path — runs an authored workflow's compiled
   * ProcessDefinition through the engine, reusing this service's dispatch state + bot
   * client. The graph engine supersedes the staged executor (linear + branching).
   */
  private async dispatchGraphTicket(
    ticket: InternalTicket,
    workflow: WorkflowDefinition,
  ): Promise<void> {
    return dispatchGraphTicketImpl(ticket, workflow, {
      activeTicketIds: this.activeTicketIds,
      dispatchStartTimes: this.dispatchStartTimes,
      resolveAgentIdByName: this.pipelineDeps?.resolveAgentIdByName,
      botNodeClient: this.pipelineDeps?.botNodeClient,
      ticketService: this.ticketService,
      runRecorder: this.pipelineDeps?.workflowRunRecorder,
    });
  }


  /**
   * @description Dispatch an incident ticket through the 2-bot RCA pipeline.
   * Implementation moved to ./dispatch-incident-worker.ts; this method is a thin
   * delegator that wires the QueueManagerService's private state into the free
   * function's deps object.
   * @param ticket - The incident ticket to dispatch.
   * @param workflow - The resolved workflow definition.
   * @returns Resolves when the pipeline reaches a terminal outcome.
   */
  private async dispatchIncidentTicket(ticket: InternalTicket, workflow: WorkflowDefinition): Promise<void> {
    return dispatchIncidentTicketImpl(ticket, workflow, {
      activeTicketIds: this.activeTicketIds,
      dispatchStartTimes: this.dispatchStartTimes,
      ticketService: this.ticketService,
      // ADR-034 gap-b push-on-dispatch: same authoritative-config resolver the manifest
      // worker uses; default-on OSHAL_PUSH_ON_DISPATCH fails closed at the bot when
      // authority is unavailable, with an explicit flag-off compatibility rollback.
      runtimeParamsResolver: this.pipelineDeps?.runtimeParamsResolver,
      // ADR-119 P4 (A2): the bounded auto-apply gate for Mode-A verdicts (optional).
      autoApply: this.autoApplyGate,
      pipelineDeps: this.pipelineDeps,
    });
  }

  /**
   * @description The default 'swarm'/'build' dispatch path — the full decompose-and-build pipeline
   * a ticket falls into when no manifest workflow (incident-rca / manifest-worker / graph) claims it.
   * It is deliberately the heaviest path because it owns the two things the lighter delegators do not:
   * PM planning-driven child-ticket creation and parent assembly. Claims a concurrency slot and bumps
   * the circuit-breaker attempt count, transitions the ticket into its truthful dispatch entry state,
   * prepares the workspace, then submits it to the swarm processing pipeline under a runaway timeout.
   * Root tickets get their PM planningDecomposition turned into child tickets and are parked in
   * approval_required behind the build gate; child tickets skip planning and execute directly against
   * resolved specialist capabilities. Completion is gated behind children (shouldDeferCompletionToChildren)
   * so a parent never marks itself terminal while work is still in flight, and failures are triaged by
   * class — runtime-unavailable and children-already-exist leave state intact, planning/non-retryable
   * errors escalate, and everything else rolls back to approved for the next poll to retry.
   * @param ticket - The approved (or post-build-gate re-entry) ticket to run through the swarm pipeline.
   * @returns Resolves when the ticket reaches a terminal state, is parked for the build gate, defers to
   * its children, escalates, or is rolled back; the active slot is always released in the finally block.
   */
  private async dispatchTicket(ticket: InternalTicket): Promise<void> {
    const { ticketId, title } = ticket;
    // Check if this root ticket already has children (was already planned).
    // If so, skip re-planning and go straight to build.
    const existingChildren = !ticket.parentTicketId
      ? await this.ticketService.listTickets({ parentTicketId: ticketId }).catch(() => [])
      : [];
    const dispatchState = resolveDispatchEntryState(ticket, existingChildren.length > 0);
    this.activeTicketIds.add(ticketId);
    this.dispatchStartTimes.set(ticketId, Date.now());
    const attemptNumber = (this.dispatchCounts.get(ticketId) ?? 0) + 1;
    this.dispatchCounts.set(ticketId, attemptNumber);
    logger.info({ ticketId, title, attempt: attemptNumber }, 'Claiming approved ticket for swarm dispatch');

    try {
      // ── Step 0: Governance eligibility check ──────────────────────
      if (this.governanceService) {
        const eligibility = await this.governanceService.checkProcessingEligibility(ticketId);
        if (!eligibility.eligible) {
          logger.info({ ticketId, reason: eligibility.reason }, 'Ticket not eligible for dispatch — skipping');
          return;
        }
      }

      // ── Step 1: Transition into the truthful dispatch entry state ───────────
      await this.ticketService.updateStatus(ticketId, dispatchState);
      logger.info({ ticketId, dispatchState }, 'Ticket transitioned into dispatch state');

      // ── Step 1b: Initialize governance tracking ──────────────────
      if (this.governanceService) {
        await this.governanceService.initializeTicket(ticketId);
      }

      // ── Abort check 1: post-status-transition ─────────────────────
      if (this.abortedTicketIds.has(ticketId)) {
        logger.warn({ ticketId }, 'Dispatch aborted after entering the dispatch state — ticket was externally escalated/cancelled');
        this.abortedTicketIds.delete(ticketId);
        return;
      }

      // ── Step 2–4: Pipeline services (workspace, decomposition, subtask lifecycle) ──
      const workItem = buildWorkItem(ticket);
      let childTicketIds: string[] = [];
      const isChildTicket = !!ticket.parentTicketId;

      if (this.pipelineDeps) {
        // Step 2: Create workspace directory
        const folderResult = await createTicketWorkspace(ticket, {
          taskFolderService: this.pipelineDeps.taskFolderService,
          workspaceService: this.pipelineDeps.workspaceService,
          ticketService: this.ticketService,
        }, dispatchState);
        logger.info({ ticketId, folderPath: folderResult.folderPath, isChild: isChildTicket }, 'Workspace created');

        // Step 3: DECOMPOSITION CUTOFF (legacy parity: QueueManagerService.js:2580-2627)
        // Root tickets (depth 0): PM LLM handles decomposition in processOneTicket Phase 2.
        //   The QM does NOT decompose here — it lets the swarm pipeline's PM agent decide.
        //   After processOneTicket returns, Step 7 below creates child tickets from PM output.
        // Children (depth 1+): MUST execute directly — no decomposition, no PM planning.
        //   They go straight to specialist routing and LLM execution.
        if (isChildTicket) {
          logger.info(
            { ticketId, parentTicketId: ticket.parentTicketId },
            'Child ticket (depth >= 1) — skipping decomposition, routing to specialist for direct execution',
          );
        } else {
          logger.info(
            { ticketId },
            'Root ticket (depth 0) — PM will handle decomposition in Phase 2 planning',
          );
        }
      } else {
        logger.info({ ticketId }, 'Pipeline deps not injected — skipping workspace/decomposition');
      }

      // ── Step 5: Check runtime readiness before submitting ────────
      const readiness = await this.swarmProcessingService.getRuntimeReadiness();
      if (!readiness.ready) {
        logger.warn(
          { ticketId, dependency: readiness.dependency, message: readiness.message, details: readiness.details },
          'Swarm runtime not ready — ticket pipeline completed but execution deferred. Ticket stays in its current dispatch state.',
        );
        // Log deferral details (TicketService does not yet support comments)
        logger.info(
          { ticketId, childCount: childTicketIds.length, readinessMessage: readiness.message },
          'Pipeline preparation complete — swarm execution deferred until runtime is available',
        );
        return; // Do NOT roll back — preparation work is done
      }

      // ── Abort check 2: pre-pipeline-submission ────────────────────
      if (this.abortedTicketIds.has(ticketId)) {
        logger.warn({ ticketId }, 'Dispatch aborted before pipeline submission — ticket was externally escalated/cancelled');
        this.abortedTicketIds.delete(ticketId);
        return;
      }

      // ── Step 6: Submit to swarm pipeline ─────────────────────────
      // For child tickets: pass routing hints so the pipeline routes to the right specialist
      // and skips PM planning. This matches the legacy depth-based routing.
      const metadata = ticket.metadata ?? {};
      let requiredCapabilities = isChildTicket
        ? resolveSpecialistCapabilities(metadata.workType as string | undefined, metadata.pmAssignedRole as string | undefined)
        : resolveRootTicketCapabilities(metadata, ticket.labels ?? []);
      // If child ticket has no routing hints, fall back to the ticket's own labels + title keywords
      if (isChildTicket && (!requiredCapabilities || requiredCapabilities.length === 0)) {
        requiredCapabilities = [...(ticket.labels ?? [])];
        // Extract obvious keywords from title for routing
        const titleLower = (ticket.title ?? '').toLowerCase();
        if (titleLower.includes('script') || titleLower.includes('bash') || titleLower.includes('deploy') || titleLower.includes('infra')) requiredCapabilities.push('infrastructure', 'scripting');
        if (titleLower.includes('test')) requiredCapabilities.push('testing');
        if (titleLower.includes('review')) requiredCapabilities.push('code-review');
        if (titleLower.includes('doc')) requiredCapabilities.push('documentation');
        if (titleLower.includes('rca') || titleLower.includes('incident') || titleLower.includes('root cause')) requiredCapabilities.push('root-cause', 'incident');
        if (titleLower.includes('graph') || titleLower.includes('opensearch') || titleLower.includes('correlation')) requiredCapabilities.push('graph-query', 'correlation');
        if (titleLower.includes('remediation') || titleLower.includes('runbook')) requiredCapabilities.push('remediation', 'runbook');
      }

      // Resolve workspace ID: children share the ROOT ticket's workspace (legacy PHASE_45)
      const rootWorkspaceId = isChildTicket
        ? await resolveRootTicketId(ticket.parentTicketId!, this.ticketService)
        : ticketId;

      const input: SwarmProcessingInput = {
        interactionMode: 'ticket',
        limit: 1,
        ...(requiredCapabilities ? { requiredCapabilities } : {}),
        workspaceTaskId: rootWorkspaceId,
      };

      // ── Step 5b: Write initial task brief (child IDs added after PM planning) ──
      if (this.pipelineDeps) {
        writeTaskBrief(ticket, [], this.pipelineDeps.taskFolderService, rootWorkspaceId, dispatchState);
      }

      logger.info(
        {
          ticketId,
          externalId: workItem.externalId,
          isChild: isChildTicket,
          recommendedPath: metadata.recommendedPath ?? null,
          planningMode: metadata.planningMode ?? null,
          requiredCapabilities: requiredCapabilities ?? [],
        },
        'Submitting ticket to swarm pipeline',
      );

      // ── Pipeline timeout guard ─────────────────────────────────────
      // Prevents a hung pipeline from occupying the active slot indefinitely.
      const pipelinePromise = this.swarmProcessingService.processTickets([workItem], input);
      let timeoutRef: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutRef = setTimeout(
          () => reject(new Error(`Pipeline timeout after ${DISPATCH_PIPELINE_TIMEOUT_MS}ms`)),
          DISPATCH_PIPELINE_TIMEOUT_MS,
        );
        (timeoutRef as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
      });
      let result: Awaited<typeof pipelinePromise>;
      try {
        result = await Promise.race([pipelinePromise, timeoutPromise]);
      } finally {
        if (timeoutRef) {
          clearTimeout(timeoutRef);
        }
      }

      // ── Abort check 3: post-pipeline, pre-child-creation ─────────
      if (this.abortedTicketIds.has(ticketId)) {
        logger.warn({ ticketId }, 'Dispatch aborted after pipeline returned — ticket was externally escalated/cancelled. Skipping child creation and completion.');
        this.abortedTicketIds.delete(ticketId);
        return;
      }

      // ── Step 7: Create child tickets from PM planning decomposition ──
      // processTickets() returns planningDecomposition — LLM-generated work units with proper titles.
      // QM is the single authority for creating child tickets in the DB.
      const processed = result.processed[0];

      // Guard: only root tickets get decomposed (children execute directly)
      if (!isChildTicket && this.pipelineDeps) {
        const hasDecomposition = !!processed?.planningDecomposition?.length;

        if (hasDecomposition) {
          const { childTicketIds: createdChildIds } = await createChildTicketsFromPlanningOutput(
            ticket,
            processed.planningDecomposition!,
            processed.agentAssignments,
            {
              ticketService: this.ticketService,
              resolveAgentIdByName: this.pipelineDeps.resolveAgentIdByName,
              taskFolderService: this.pipelineDeps.taskFolderService,
            },
          );
          childTicketIds = createdChildIds;

          if (childTicketIds.length > 0) {
            await this.ticketService.updateStatus(ticketId, 'approval_required');
            // Update task brief with child IDs now that decomposition is complete
            writeTaskBrief(ticket, childTicketIds, this.pipelineDeps.taskFolderService, rootWorkspaceId, 'approval_required');

            logger.info(
              { ticketId, childCount: childTicketIds.length },
              'Child tickets created from PM planning — parent moved to approval_required and children will wait for the build gate',
            );
            return; // Parent waits in approval_required; children are picked up after build approval
          }
        } else if (processed?.planningDecomposition !== undefined) {
          // BUG-FIX Session 35: PM ran in discovery/design mode and wrote workspace files but
          // did NOT call swarm-create-ticket (empty planningDecomposition array).
          // Without this guard the ticket stays stranded in in_process_design indefinitely.
          // Move it to approval_required so an operator can review and advance it.
          logger.warn(
            { ticketId },
            'PM agent completed with empty planningDecomposition — ticket produced no child work units. Moving to approval_required for operator review.',
          );
          await this.ticketService.updateStatus(ticketId, 'approval_required');
          return;
        }
      }

      // ── Step 8: Enrich workspace with pipeline results ───────────
      if (this.pipelineDeps && result.processed.length > 0 && processed?.selectedAgentId) {
        await enrichWorkspaceAfterPipeline(ticket, {
          selectedAgentId: processed.selectedAgentId!,
          selectedStrategy: processed.selectedStrategy ?? 'unknown',
          workUnitCount: processed.workUnitCount,
        }, this.pipelineDeps.taskFolderService, rootWorkspaceId);
      }

      // Guard: only mark complete if the pipeline produced meaningful output.
      // When Planning or Execution fails (e.g. Cline exit code 1, malformed patch),
      // processed may exist but have no output. Escalate instead of marking complete.
      const hasOutput = processed?.selectedAgentId || processed?.planningDecomposition?.length;
      if (!hasOutput && result.processed.length > 0) {
        const failedItems = this.pipelineDeps?.workItemRepository
          ? await this.pipelineDeps.workItemRepository.findByExternalIdAnyProvider(ticketId)
          : [];
        const failedSummaries = summarizeFailedWorkItems(failedItems);
        const hasFailed = failedItems.some(item => item.status === 'failed');
        if (hasFailed) {
          // Embed the actual per-item failure detail (title + agent + the CLI/agent error),
          // not just a count — this is the "why it escalated" the eval-wall (2026-06-22) found
          // missing. Bounded by summarizeFailedWorkItems so the history row stays small.
          await this.ticketService.updateStatus(ticketId, 'escalated', {
            reason: 'pipeline_work_items_failed',
            source: 'queue-manager-pipeline',
            failedWorkItemCount: failedItems.filter(item => item.status === 'failed').length,
            failedWorkItems: failedSummaries,
          });
          this.dispatchCounts.delete(ticketId);
          logger.warn(
            { ticketId, failedWorkItems: failedSummaries },
            'Pipeline work items failed — ticket escalated instead of marked complete',
          );
          return;
        }
      }

      // ── Completion gate (parent-completes-early fix) ──────────────
      // Invariant: a ticket with >=1 non-terminal child NEVER reaches a terminal state from
      // its own pipeline result — it completes only via parent assembly once all children are
      // terminal, and child failures roll up through the existing escalation semantics.
      // Without this gate the post-build-gate re-dispatch (existingChildren > 0 →
      // in_process_build entry, no re-planning, so planningDecomposition is undefined and both
      // Step-7 early returns are skipped) fell straight through to the unconditional 'complete'
      // below while its children were still building.
      const completionDeferred = await this.shouldDeferCompletionToChildren(ticketId);
      if (!completionDeferred) {
        await this.ticketService.updateStatus(ticketId, 'complete');
        logger.info({ ticketId }, 'Swarm pipeline completed for ticket — ticket marked complete');
      }
      this.dispatchCounts.delete(ticketId);

      // Cascade: mark all associated work items as completed to prevent stale Redis stream re-dispatch
      if (this.pipelineDeps?.workItemRepository) {
        try {
          const items = await this.pipelineDeps.workItemRepository.findByExternalIdAnyProvider(ticketId);
          let cascaded = 0;
          for (const item of items) {
            if (item.status !== 'completed' && item.status !== 'failed') {
              await this.pipelineDeps.workItemRepository.updateStatus(item.workItemId, 'completed');
              cascaded++;
            }
          }
          if (cascaded > 0) {
            logger.info({ ticketId, cascaded }, 'Cascaded ticket completion to work items');
          }
        } catch (err) {
          logger.warn({ err, ticketId }, 'Work item completion cascade failed (non-fatal)');
        }
      }

      // ── Parent Assembly Check (legacy parity) ──────────────────────
      // When a child ticket completes, check if all siblings are done.
      // If so, assemble the parent ticket and move it to customer_action.
      if (isChildTicket && ticket.parentTicketId) {
        try {
          const assemblyResult = await this.parentAssemblyService.checkAndAssemble(ticket.parentTicketId);
          if (assemblyResult.assembled) {
            logger.info(
              { parentTicketId: ticket.parentTicketId, childCount: assemblyResult.totalChildren },
              'Parent assembly triggered — all children complete',
            );
          } else if (!assemblyResult.allChildrenComplete) {
            logger.info(
              { parentTicketId: ticket.parentTicketId, pending: assemblyResult.pendingChildren.length, complete: assemblyResult.completedChildren },
              'Parent assembly deferred — children still in progress',
            );
          }
        } catch (assemblyErr) {
          logger.warn({ err: assemblyErr, parentTicketId: ticket.parentTicketId }, 'Parent assembly check failed — non-fatal');
        }
      }
    } catch (err) {
      // Graceful handling for runtime unavailability — don't roll back preparation work
      if (err instanceof SwarmRuntimeUnavailableError) {
        logger.warn(
          { ticketId, dependency: err.readiness.dependency, message: err.readiness.message },
          'Swarm runtime unavailable during dispatch — ticket stays in its current dispatch state for retry',
        );
        return; // Do NOT roll back
      }

      // PM planning failed to produce parseable decomposition — ESCALATE to operator.
      // This is not a transient error. Something is wrong with the PM output or parser.
      // The ticket goes to 'escalated' so the operator can review the workspace and logs.
      if (err instanceof PlanningDecompositionError) {
        logger.error(
          { ticketId, message: (err as PlanningDecompositionError).message },
          'PM planning decomposition failed — ESCALATING ticket for operator review',
        );
        await this.workItemRoutingWatchdog?.markTicketRoutingFailures(ticketId, 'planning_decomposition_failed');
        try {
          await this.ticketService.updateStatus(ticketId, 'escalated', {
            reason: 'planning_decomposition_failed',
            source: 'queue-manager-dispatch',
            message: extractErrorMessage(err),
          });
        } catch (escErr) {
          logger.error({ err: escErr, ticketId }, 'Failed to escalate ticket');
        }
        return; // Do NOT roll back — leave in escalated state
      }

      if (isNonRetryableDispatchError(err)) {
        logger.error(
          { err, ticketId, reason: extractErrorMessage(err) },
          'Non-retryable dispatch failure detected — escalating ticket instead of retry rollback',
        );
        await this.workItemRoutingWatchdog?.markTicketRoutingFailures(ticketId, 'non_retryable_dispatch_failure');
        try {
          await this.ticketService.updateStatus(ticketId, 'escalated', {
            reason: 'non_retryable_dispatch_failure',
            source: 'queue-manager-dispatch',
            message: extractErrorMessage(err),
          });
        } catch (escErr) {
          logger.error({ err: escErr, ticketId }, 'Failed to escalate non-retryable dispatch failure');
        }
        return;
      }

      // Don't roll back if children already exist — the PM planning may have succeeded
      // even if the pipeline failed later. Rolling back causes duplicate children on retry.
      let hasChildren = false;
      try {
        const all = await this.ticketService.listTickets({});
        hasChildren = all.some((t) => t.parentTicketId === ticketId);
      } catch { /* ignore */ }

      if (hasChildren) {
        logger.warn(
          { err, ticketId },
          'Ticket dispatch failed but children exist — NOT rolling back. Children will execute independently.',
        );
      } else {
        logger.error({ err, ticketId }, 'Ticket dispatch failed — rolling back to approved for retry');
        await this.rollbackTicket(ticketId, extractErrorMessage(err));
      }
    } finally {
      this.activeTicketIds.delete(ticketId);
      this.dispatchStartTimes.delete(ticketId);
      this.abortedTicketIds.delete(ticketId);
      logger.debug({ ticketId, remaining: this.activeTicketIds.size }, 'Ticket released from active set');
    }
  }

  /**
   * @description Completion gate for the swarm dispatch path (parent-completes-early fix).
   * A dispatched ticket that has decomposed children must never be marked 'complete' from its
   * own pipeline result while any child is non-terminal — 'complete' only transitions to
   * 'backlog', so an early-completed parent can never be assembled (customer_action) or pick
   * up a child-failure escalation afterwards. Delegates the child inspection to
   * ParentAssemblyService.checkAndAssemble so the existing rollup semantics apply unchanged:
   * all-terminal children assemble the parent to customer_action, an escalated/dead_letter
   * child escalates the parent, paused children block, and in-flight children leave the parent
   * in the truthful active state (mirrors the SP-8 projection in sweepStaleParents).
   * @param ticketId - Ticket that just finished its own pipeline pass.
   * @returns True when the 'complete' transition must be skipped because children own completion.
   */
  private async shouldDeferCompletionToChildren(ticketId: string): Promise<boolean> {
    const check = await this.parentAssemblyService.checkAndAssemble(ticketId);
    if (check.totalChildren === 0) {
      return false; // Childless ticket — its own pipeline result is the deliverable.
    }
    if (check.assembled) {
      logger.info(
        { ticketId, childCount: check.totalChildren },
        'Completion gate: all children terminal — parent assembled instead of pipeline-completed',
      );
      return true;
    }
    if (check.blockReason) {
      logger.info(
        { ticketId, blockReason: check.blockReason },
        'Completion gate: parent completion blocked by child state — existing rollup applied',
      );
      return true;
    }
    // Children still executing — keep the parent in the truthful active state so the
    // per-child assembly hook / stale-parent sweep completes it when they finish.
    try {
      await this.ticketService.updateStatus(ticketId, 'in_process_build');
    } catch { /* non-fatal — parent state is a projection, not a gate (same as SP-8) */ }
    logger.info(
      { ticketId, pendingChildren: check.pendingChildren.length, totalChildren: check.totalChildren },
      'Completion gate: children still in flight — parent completion deferred to assembly',
    );
    return true;
  }

  /**
   * @description Attempts to roll the ticket back to approved so the next poll cycle can retry it.
   * Before rolling back, records the failed cycle in the persisted dead-letter counter (when the
   * DeadLetterService is wired) — if the policy quarantines the ticket to 'dead_letter', the
   * rollback is skipped so a poison ticket cannot re-enter the approved queue.
   * @param ticketId - ID of the ticket to roll back
   * @param lastError - Sanitized failure detail for the DLQ row (never raw output/prompts)
   * @returns Nothing
   */
  private async rollbackTicket(ticketId: string, lastError?: string): Promise<void> {
    const attempts = this.dispatchCounts.get(ticketId) ?? 0;
    if (attempts < MAX_DISPATCH_ATTEMPTS && this.deadLetterService) {
      // Persisted poison policy (survives restarts — the in-memory breaker below does not).
      // Fail-open by contract: a broken DLQ store returns quarantined=false and we roll back
      // exactly as before. Escalation branches are counted by the service's event listener.
      const verdict = await this.deadLetterService.recordFailureCycle(ticketId, 'dispatch_failure', lastError);
      if (verdict.quarantined) {
        logger.warn(
          { ticketId, attempts: verdict.attempts, reason: verdict.reason },
          'Dead-letter policy quarantined ticket — skipping rollback to approved',
        );
        this.dispatchCounts.delete(ticketId);
        return;
      }
    }
    if (attempts >= MAX_DISPATCH_ATTEMPTS) {
      logger.warn(
        { ticketId, attempts },
        'Circuit breaker: not rolling back to approved — escalating instead after repeated failures',
      );
      await this.workItemRoutingWatchdog?.markTicketRoutingFailures(ticketId, 'rollback_circuit_breaker_escalation');
      try {
        await this.ticketService.updateStatus(ticketId, 'escalated', {
          reason: 'rollback_circuit_breaker_escalation',
          source: 'queue-manager-rollback',
          attempts,
          maxAttempts: MAX_DISPATCH_ATTEMPTS,
        });
      } catch (err) {
        logger.error({ err, ticketId }, 'Failed to escalate over-dispatched ticket on rollback');
      }
      return;
    }
    try {
      await this.ticketService.updateStatus(ticketId, 'approved');
      logger.info({ ticketId, attempt: attempts }, 'Ticket rolled back to approved after dispatch failure');
    } catch (err) {
      logger.error({ err, ticketId }, 'Rollback to approved failed — ticket may be stuck in a dispatch state');
    }
  }
}
