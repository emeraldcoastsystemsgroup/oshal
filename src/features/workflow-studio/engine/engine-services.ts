/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | EngineServices — thin adapter interface for real service calls from node executors
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added optional decideBranch (ai-decision) and runClusterStep (agent-cluster) with their config/result types.
 */

/**
 * @description Thin adapter interface that node executors call through.
 * Each method maps to one service call in the existing swarm orchestration layer.
 *
 * When services are not wired (test mode), the engine uses stub executors.
 * When services ARE wired (production), executors call through this interface.
 *
 * The engine never imports or knows about the concrete service classes.
 * This keeps the engine decoupled from swarm-orchestration internals.
 */
export interface EngineServices {
  /**
   * Decompose a ticket into work units and score complexity.
   * Maps to: TicketDecompositionService.decompose() + resolvePhaseGateConfig()
   */
  intakeAndScore(ticket: EngineTicketContext): Promise<IntakeResult>;

  /**
   * Run PM planning orchestration — decomposition, architect pre-round, artifact gates.
   * Maps to: PlanningRoundOrchestrator.execute()
   */
  runPlanning(ticket: EngineTicketContext, config: PlanningNodeConfig): Promise<PlanningResult>;

  /**
   * Route and dispatch agent execution with multi-round support.
   * Maps to: SwarmExecutionLifecycleService.runExecutionPolicy()
   */
  runExecution(ticket: EngineTicketContext, config: ExecutionNodeConfig, regressionFeedback?: string): Promise<ExecutionResult>;

  /**
   * Run testing/verification with regression evaluation.
   * Maps to: SwarmExecutionLifecycleService.executeTestingWithRegression()
   */
  runTesting(ticket: EngineTicketContext, executionOutcome: unknown): Promise<TestingResult>;

  /**
   * Run review/consensus with regression evaluation.
   * Maps to: SwarmExecutionLifecycleService.executeReviewWithRegression()
   */
  runReview(ticket: EngineTicketContext, executionOutcome: unknown): Promise<ReviewResult>;

  /**
   * Run specialist input phase (domain expert enrichment).
   * Maps to: SwarmRoutingHandler.runSpecialistInput()
   */
  runSpecialistInput(ticket: EngineTicketContext): Promise<SpecialistResult>;

  /**
   * Finalize delivery — writeback, metrics, learnings.
   * Maps to: SwarmExecutionLifecycleService.finalizeTicketProcessing()
   */
  runDelivery(ticket: EngineTicketContext, executionOutcome: unknown): Promise<DeliveryResult>;

  /**
   * Persist an escalation record.
   * Maps to: SwarmEscalationStore.persist()
   */
  escalate(ticket: EngineTicketContext, target: string, severity: string, reason: string): Promise<void>;

  /**
   * Ask the bound bot to choose the next branch at an ai-decision node. Returns the chosen
   * outcome label (matched against the node's outgoing edge labels). Optional: when a service
   * does not implement it, the engine falls back to the node's configured fallbackOutcome.
   */
  decideBranch?(ticket: EngineTicketContext, config: DecisionNodeConfig): Promise<DecisionResult>;

  /**
   * Run an agent-cluster step: dispatch a ranked cluster of agents on the SAME work concurrently,
   * then (optionally) have a reviewer gate the candidates — pass + pick a winner, or fail with
   * feedback. Optional: when unimplemented the engine treats the cluster node as a pass-through.
   */
  runClusterStep?(ticket: EngineTicketContext, config: ClusterStepConfig): Promise<ClusterStepResult>;
}

/** Config for an agent-cluster node: the member agents, an optional reviewer, and work context. */
export interface ClusterStepConfig {
  /** Cluster member agent names/ids — dispatched concurrently on the same step. */
  agents: string[];
  /** Optional reviewer agent that judges the members' candidate outputs (pass + winner, or fail). */
  reviewer?: string;
  /** Work-type label for the dispatched prompt. */
  workType?: string;
  /** Regression feedback to inject into the members on a re-run. */
  feedback?: string;
}

/** Result of an agent-cluster step. */
export interface ClusterStepResult {
  /** Whether the reviewer (or consensus) accepted the cluster's work. */
  passed: boolean;
  /** The winning member's agentId (best candidate) when passed. */
  winnerAgentId?: string;
  /** How many members were dispatched. */
  memberCount: number;
  /** How many members produced output. */
  respondedCount: number;
  /** Reviewer feedback (especially on failure). */
  feedback?: string;
}

/** Config for an ai-decision node's branch dispatch. */
export interface DecisionNodeConfig {
  /** Persona name to resolve to an agentId (when no explicit agentId). */
  agentBinding?: string;
  /** Explicit agentId to ask. */
  agentId?: string;
  /** The allowed outcome labels (must match the outgoing edge labels). */
  outcomes: string[];
  /** Optional decision question; defaults to the node title. */
  prompt?: string;
}

/** Result of an ai-decision branch dispatch. */
export interface DecisionResult {
  /** The chosen outcome label. */
  outcome: string;
}

// ---------------------------------------------------------------------------
// Context and result types (engine-side, decoupled from swarm internals)
// ---------------------------------------------------------------------------

export interface EngineTicketContext {
  externalId: string;
  title: string;
  body?: string;
  labels?: string[];
  provider?: string;
  parentExternalId?: string;
  depth: number;
  /** Raw ticket object for passthrough to services that need the full shape */
  raw?: unknown;
}

export interface PlanningNodeConfig {
  planningMode: string;
  stopAfterPlanning: boolean;
  architecturePreRound: boolean;
}

export interface ExecutionNodeConfig {
  agentBinding: string;
  workType: string;
  primaryRole?: string;
  reviewerRole?: string;
  agentId?: string;
}

export interface IntakeResult {
  complexity: 'low' | 'medium' | 'high';
  complexityScore: number;
  activePhases: string[];
  workUnitCount: number;
}

export interface PlanningResult {
  stopAfterPlanning: boolean;
  workUnits: unknown[];
  routing: unknown;
  planningSource: string;
  agentAssignments?: unknown[];
  planningDecomposition?: unknown[];
}

export interface ExecutionResult {
  outcome: unknown;
  agentId?: string;
  strategy?: string;
}

export interface TestingResult {
  passed: boolean;
  feedback?: string;
  regressionCount?: number;
  escalated?: boolean;
}

export interface ReviewResult {
  passed: boolean;
  feedback?: string;
  regressionCount?: number;
  escalated?: boolean;
}

export interface SpecialistResult {
  agentId?: string;
  enrichmentType?: string;
  contextInjected: boolean;
}

export interface DeliveryResult {
  delivered: boolean;
  result?: unknown;
}
