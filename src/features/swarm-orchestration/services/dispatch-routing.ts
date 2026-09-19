/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted WorkflowDefinition + WORKFLOW_PIPELINES + chooseDispatchPath from queue-manager-service.ts (2377-line file → first piece of decomposition per audit P0)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | WorkflowDefinition.autoStart — carried from the manifest so the queue manager can auto-approve tickets of an auto-start workflow.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-083: 'task' workflow default workerBot project-manager → general-bot. The owner is now chosen by the knowledge-owner call-out (task-call-out.ts); the workflow default is only the last resort, and it must be a tool-capable DOER, not the PM planner (whose claude-code 401s escalated task tickets).
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Comment corrections only. The pipeline doc block said 'staged' is "Executed by dispatch-staged-worker" - no such file exists - and the built-in list advertised it, in the same file whose chooseDispatchPath records the executor as retired and has no branch for it. A manifest declaring pipeline: staged silently becomes a single-bot manifest-worker run with every approval gate dropped.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | A fifth site in this file implied 'staged' is live: the workerBot doc said it is "informational only" for 'staged'/'graph'. For a manifest declaring the retired 'staged' pipeline the opposite is true - it falls through to manifest-worker and workerBot is the ONLY bot that runs.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | chooseDispatchPath routes `pipeline: graph` to the graph worker whether or not a processDefinition is present (CKR-11 / D4). The old `&& workflow.processDefinition` degraded a graph workflow missing its definition into a single-bot manifest-worker run with every authored approval gate dropped and nothing logged - the defer arm warns, that arm did not. dispatchGraphTicket already escalates this shape with reason 'graph_workflow_definition_missing'; that branch was simply unreachable, because routing never sent anything to it. The entry point is a hand-authored manifest - Publish cannot produce the shape, since all three of its modes emit a processDefinition unconditionally.
 */

/**
 * @description Defines a swarm workflow pipeline.
 * Each ticketType maps to exactly one workflow — no overlap between bots or pipelines.
 * Add new ticket types here as new workflows are created.
 *
 * Pipeline types:
 *   'incident-rca'  — 1-bot loop: worker persona embeds quality gate (Mode A/B/C,
 *                     citation rules, 5-section HANDOVER). reviewerBot/maxRevisions
 *                     are opt-in via manifest; default is one-and-done.
 *   'swarm'         — 7-phase swarm pipeline: PM decomposes, specialists build,
 *                     parent assembles. FIXED phases, DYNAMIC bot selection.
 *   'staged'        — RETIRED. There is no dispatch-staged-worker and no dispatcher
 *                     reads `stages`; chooseDispatchPath has no 'staged' branch, so a
 *                     manifest declaring it falls through to 'manifest-worker' and runs
 *                     only workerBot, dropping every approval gate. Authored multi-bot
 *                     workflows compile to 'graph' instead (workflow-publish-compiler).
 */
export interface WorkflowStageDefinition {
  /** Existing bot persona name, pinned to this stage (resolved via agent registry). */
  bot: string;
  /** Optional human-readable stage name (used in handoff context + logs). */
  name?: string;
  /** When true, the ticket PAUSES at approval_required after this stage; an operator
   *  must approve (→ approved) for the workflow to advance to the next stage. */
  approvalAfter?: boolean;
}

export interface WorkflowDefinition {
  /** Matches ticket.ticketType */
  ticketType: string;
  /** Human-readable workflow name */
  name: string;
  /** Which pipeline handler processes this ticket type. Built-ins: 'incident-rca' | 'swarm' | 'graph' ('staged' is retired — see the pipeline notes above). Apps may contribute labels; unknown values fall through to the default 'swarm' dispatcher. */
  pipeline: string;
  /** Worker bot persona name (resolved via agent registry). For a 'graph' workflow this is
   *  informational only (the compiled processDefinition drives execution); set it to the first node's
   *  bot. It is NOT informational for a manifest declaring the retired 'staged' pipeline — that falls
   *  through to manifest-worker and this is the only bot that runs. */
  workerBot: string;
  /** Reviewer bot persona name — opt-in. When set the incident-rca pipeline runs Phase 2 review. Default omitted = one-and-done. */
  reviewerBot?: string;
  /** Max revision cycles before completing anyway. Default 1. */
  maxRevisions?: number;
  /** Ordered stages for a 'staged' workflow. VESTIGIAL: no dispatcher reads this field on any
   *  pipeline. The publish compiler builds its own local stage list and emits a processDefinition. */
  stages?: WorkflowStageDefinition[];
  /** Compiled ProcessDefinition (nodeGraph) for a 'graph' workflow — executed by the
   *  ProcessDefinitionExecutionEngine. Carried inline so the graph runs via the existing
   *  queue-manager dispatch (no separate loader/router). Ignored by other pipelines.
   *  Typed loosely here to avoid a swarm-orchestration -> workflow-studio type dependency;
   *  the graph dispatcher validates/uses it. */
  processDefinition?: Record<string, unknown>;
  /** When true, tickets of this ticketType auto-approve on arrival (skip the front backlog gate)
   *  so the workflow runs immediately — any human-in-the-loop lives in the graph's own
   *  approval-gate nodes. Opt-in per published workflow; default omitted = manual approval. */
  autoStart?: boolean;
}

/**
 * @description Configurable workflow registry.
 * ticketType = workflow type. Each entry is a distinct pipeline with distinct bots.
 * The swarm entry catches all untyped/default tickets via the 'build' fallback.
 *
 * App manifests in swarm-apps/*.yaml extend this at runtime via
 * WorkflowPipelineRegistry.registerFromApp() — built-ins always win on
 * collision (an app cannot override 'incident' or 'build').
 */
export const WORKFLOW_PIPELINES: WorkflowDefinition[] = [
  {
    ticketType: 'incident',
    name: 'Incident RCA Pipeline',
    pipeline: 'incident-rca',
    workerBot: 'rca-specialist',
    // Architectural default: each ticket-type workflow is ONE bot whose
    // persona embeds its own quality gate (Mode A/B/C classification,
    // citation rules, structured artifact set, 5-section HANDOVER).
    // The persona IS the swarm — no external reviewer phase. Domain
    // workflows that genuinely need a separate audit pass can opt in by
    // declaring reviewerBot in their manifest; defense-in-depth is no
    // longer the default.
    //
    // (Historical note: this entry used to declare reviewerBot=queue-bot
    // + maxRevisions=2. It cost ~30% extra tokens per ticket for a
    // review pass that almost always rubber-stamped the worker's output
    // because the worker persona already enforced the same rules.)
  },
  {
    ticketType: 'build',
    name: 'Software Build Swarm',
    pipeline: 'swarm',
    workerBot: 'system-architect',
  },
  {
    // Jarvis/voice "do this for me" work (summarize emails, check the calendar, etc.).
    // These are SINGLE-bot assistant tasks, NOT software builds — they must NOT run the
    // 7-phase 'swarm' decompose pipeline (wrong + expensive). The manifest-worker path
    // hands the whole ticket to one bot that owns it end-to-end.
    //
    // ADR-083: the owner is chosen by CALL-OUT — the queue manager broadcasts a
    // BID_REQUEST to online knowledge owners and the AgentRouter cascade decides
    // (dispatch-manifest-worker + task-call-out.ts). The free-text regex pin
    // (resolveTaskBotAgentId / metadata.targetAgentId) is deleted. workerBot here is
    // the LAST-RESORT default when the call-out machinery is absent or every owner
    // (including the general fallback) is offline: general-bot, a tool-capable doer —
    // never project-manager (a planner; its claude-code 401s escalated task tickets).
    ticketType: 'task',
    name: 'Jarvis Assistant Task',
    pipeline: 'manifest-worker',
    workerBot: 'general-bot',
  },
];

/**
 * @description Pure routing decision for the dispatcher.
 *
 * Returns:
 * - 'defer' when an app-contributed ticketType isn't yet in the registry
 *   (startup race between queueManager.start() and swarmAppService.autoLoadAll()).
 * - 'incident-rca' for the single-bot RCA pipeline.
 * - 'manifest-worker' for app-contributed single-worker workflows
 *   (e.g. Little Monsters education → lecture-scribe).
 * - 'swarm' for the default build/decompose pipeline (catches built-in
 *   'build' tickets and untyped tickets).
 *
 * Pure function — no I/O, no side effects. Easy to test (see
 * tests/dispatch-routing.spec.ts).
 *
 * @param ticketType - ticket.ticketType, default 'build'.
 * @param workflow - registry.resolve(ticketType), undefined if no match.
 * @param builtInTicketTypes - the set of framework built-in ticketTypes (from WORKFLOW_PIPELINES).
 */
export function chooseDispatchPath(
  ticketType: string,
  workflow: WorkflowDefinition | undefined,
  builtInTicketTypes: Set<string>,
): 'defer' | 'incident-rca' | 'manifest-worker' | 'swarm' | 'graph' {
  if (!workflow && !builtInTicketTypes.has(ticketType)) return 'defer';
  if (workflow?.pipeline === 'incident-rca') return 'incident-rca';
  // Authored workflow — runs the compiled ProcessDefinition graph via the engine
  // (linear AND branching). This is the canonical authored-workflow runtime; the earlier
  // interim 'staged' executor has been retired in favour of it.
  // Routed on the DECLARED pipeline, not on whether the definition happens to be present.
  // Requiring processDefinition here sent a graph workflow missing its definition on to the
  // manifest-worker arm, which runs workerBot alone and logs nothing - every approval gate the
  // author wrote silently dropped. dispatchGraphTicket has escalated that exact shape since it
  // was written ('graph_workflow_definition_missing'); this condition was what made that branch
  // unreachable. An author who declares 'graph' now gets a graph run or an escalated ticket.
  if (workflow?.pipeline === 'graph') return 'graph';
  if (ticketType !== 'build' && workflow?.workerBot && workflow.pipeline !== 'swarm') {
    return 'manifest-worker';
  }
  return 'swarm';
}

/**
 * @description Convenience: the set of built-in ticketTypes a caller passes
 * to chooseDispatchPath. Built once at module load so callers don't
 * recompute it per dispatch.
 */
export const BUILT_IN_TICKET_TYPES: ReadonlySet<string> = new Set(
  WORKFLOW_PIPELINES.map((w) => w.ticketType),
);
