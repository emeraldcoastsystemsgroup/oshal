/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added swarm-orchestration services barrel exports
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Exported Postgres-backed swarm run store for durable orchestration persistence
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Exported ticket write-back contracts for provider lifecycle updates
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Exported ticket-state projection service for canonical Plane state mapping
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Exported swarm policy and verification services for retry-aware orchestration testing
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Exported escalation target types and support helpers for explicit human-review routing
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Exported retry class, escalation severity, escalation record, and escalation store types for persistent routing
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Exported Postgres-backed escalation store for durable escalation routing
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Exported SubtaskLifecycleService for 2-level subtask state tracking and queue filtering
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Exported SwarmWritebackHandler extracted from processing service for file cap compliance
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Exported SubtaskLifecycleStore, InMemorySubtaskLifecycleStore, and PostgresSubtaskLifecycleStore
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Exported mesh-support helpers through the feature barrel to remove extension deep imports
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | Exported QueueManagerService — background polling loop that feeds approved tickets into the swarm pipeline
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | Exported MultiRoundDispatchService for multi-agent phase dispatch with handover enforcement
 * 15 | maintainer@emeraldcoastsystemsgroup.com   | Exported QueueGovernanceService, InMemoryGovernanceStore, and governance types (Stage 2)
 * 16 | maintainer@emeraldcoastsystemsgroup.com   | Exported PhaseRoutingService, CommentFormatter, SwarmAwarenessPrompt, and ParentAssemblyService — ported from the legacy implementation
 * 17 | maintainer@emeraldcoastsystemsgroup.com   | Exported PlanningRoundOrchestrator and SwarmExecutionLifecycleService from session 100 extraction
 * 18 | maintainer@emeraldcoastsystemsgroup.com   | Governance closeout: documented continued barrel export stewardship after phase-loop stabilization sessions
 * 19 | maintainer@emeraldcoastsystemsgroup.com   | WS2/WS3: Export buildPhasePersonaOverride (review persona fix) and updated ConsensusReviewService (review work-item persistence)
 * 20 | maintainer@emeraldcoastsystemsgroup.com   | Exported DeadLetterService (+ types, readQmMaxAttempts) — persisted queue DLQ / poison-ticket policy (migration 081)
 * 21 | maintainer@emeraldcoastsystemsgroup.com   | Exported provider ticket materialization through the feature boundary
 * 22 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

export {
  TicketCycleStateMachine,
  SWARM_TICKET_CYCLE_ORDER,
  type SwarmTicketCycle,
  type SwarmTicketCycleRecord,
  type SwarmTicketCycleStatus,
  type SwarmTicketLifecycleSnapshot,
} from './ticket-cycle-state-machine';
export { TicketDecompositionService, PlanningDecompositionError, type DecomposedWorkUnit } from './ticket-decomposition-service';
export {
  SWARM_PHASE_ORDER,
  resolvePhaseGateConfig,
  scoreComplexity,
  complexityFromScore,
  isPhaseActive,
  type SwarmPhase,
  type TicketComplexity,
  type PhaseGateConfig,
} from './phase-gate-config';
export {
  SwarmTicketProcessingService,
  SwarmRuntimeUnavailableError,
  type SwarmProcessingInput,
  type SwarmProcessingResult,
  type SwarmRuntimeReadiness,
  type SwarmRuntimeReadinessProbe,
} from './swarm-ticket-processing-service';
export {
  InMemorySwarmRunStore,
  type SwarmRunRecord,
  type SwarmRunStatus,
  type SwarmRunStore,
  type SwarmProcessedTicketResult,
} from './swarm-run-store';
export { PostgresSwarmRunStore } from './postgres-swarm-run-store';
export {
  type TicketWritebackAdapter,
  type TicketWritebackStatus,
  type TicketWritebackUpdate,
} from './ticket-writeback-adapter';
export { TicketStateProjectionService } from './ticket-state-projection-service';
export {
  SwarmCyclePolicyService,
  type SwarmCyclePolicy,
  type SwarmCyclePolicyInput,
  type SwarmEscalationRecord,
  type SwarmEscalationSeverity,
  type SwarmEscalationTarget,
  type SwarmRetryClass,
  type SwarmVerificationAttemptState,
  type SwarmVerificationPolicyDecision,
} from './swarm-cycle-policy';
export {
  InMemorySwarmEscalationStore,
  type SwarmEscalationQuery,
  type SwarmEscalationStore,
} from './swarm-escalation-store';
export { PostgresSwarmEscalationStore } from './postgres-swarm-escalation-store';
export {
  SwarmExecutionPolicyRunner,
  type SwarmExecutionPolicyCallbacks,
  type SwarmExecutionPolicyOutcome,
} from './swarm-execution-policy-runner';
export {
  SwarmVerificationService,
  type SwarmVerificationRegressionTarget,
  type SwarmVerificationResult,
} from './swarm-verification-service';
export {
  InMemoryMeshTransport,
  SwarmEscalationError,
  buildExecutionEnvelope,
  normalizeCandidates,
  type SwarmOnlineAgentIdsResolver,
} from './swarm-ticket-processing-support';
export {
  SwarmAgentWorker,
  type EnvelopeExecutionHandler,
  type EnvelopeExecutionResult,
  type DirectMessageHandler,
  type SwarmAgentWorkerOptions,
} from './swarm-agent-worker';
export {
  createLLMExecutionHandler,
  type LLMExecutionHandlerDeps,
  type CostRecordFn,
  buildUserMessage,
  loadPersonaLayers,
  assemblePromptForAnyBot,
  buildFilePersonaLayer,
  buildHandoverLayers,
  buildSwarmAwarenessLayer,
  buildSwarmMemoryLayer,
  buildFallbackProfile,
} from './llm-execution-handler';
export {
  SubtaskLifecycleService,
  type TrackedSubtask,
  type ParentWithSubtasks,
  type SubtaskRollupResult,
} from './subtask-lifecycle-service';
export { SwarmWritebackHandler } from './swarm-writeback-handler';
export { ensureInternalTicketForWorkItem } from './swarm-internal-ticket-helper';
export {
  type SubtaskLifecycleStore,
  InMemorySubtaskLifecycleStore,
} from './subtask-lifecycle-store';
export { PostgresSubtaskLifecycleStore } from './postgres-subtask-lifecycle-store';
export { RedisSubtaskLifecycleStore } from './redis-subtask-lifecycle-store';
export {
  RALFHandoverManager,
  type HandoverDocument,
  type HandoverSummaryOptions,
} from './ralf-handover-manager';
export {
  PhaseRoundOrchestrator,
  type PhaseRoundState,
  type RoundEntry,
  type RoundContext,
  type RoundAssignment,
  type RoundCompletionResult,
} from './phase-round-orchestrator';
export { loadPersonaFromFile, type BotPersona } from './persona-file-loader';
export {
  ConsensusReviewService,
  type ReviewerVerdict,
  type ConsensusReviewOutcome,
  type ConsensusReviewDeps,
} from './consensus-review-service';
export {
  TaskFolderService,
  type TaskFolderMeta,
  type TaskFolderResult,
} from './task-folder-service';
export {
  QueueManagerService,
  type QueueManagerOptions,
  type QueueManagerPipelineDeps,
} from './queue-manager-service';
export {
  DeadLetterService,
  readQmMaxAttempts,
  DEFAULT_QM_MAX_ATTEMPTS,
  type DeadLetterEntry,
  type DeadLetterFailureKind,
  type DeadLetterNotifier,
  type DeadLetterPg,
  type DeadLetterServiceDeps,
  type FailureCycleVerdict,
  type RequeueResult,
} from './dead-letter-service';
export {
  MultiRoundDispatchService,
  type MultiRoundDispatchDeps,
  type AgentSelectorFn,
  type PhaseDispatchResult,
  type RoundExecutionResult,
} from './multi-round-dispatch-service';

// Queue governance
export {
  QueueGovernanceService,
  InMemoryGovernanceStore,
  type TicketLifecycleState,
  type TicketGovernanceRecord,
  type RerouteRequest,
  type QueueGovernanceConfig,
  type GovernanceStore,
} from './queue-governance-service';

// Phase regression
export {
  PhaseRegressionService,
  type PhaseRegressionConfig,
  type RegressionDecision,
} from './phase-regression-service';

// Workspace artifact enforcement
export {
  WorkspaceArtifactEnforcer,
  type PhaseArtifactRule,
  type ArtifactValidationResult,
  type ContinuationBrief,
  type ArtifactEnforcerConfig,
} from './workspace-artifact-enforcer';

// Failure governance
export {
  FailureGovernanceService,
  type FailureGovernanceConfig,
  type StaleLoopResult,
  type ApprovalCheckResult,
  type ApprovalRequest,
  type StuckAgentResult,
  type WorkspaceRecoveryResult,
} from './failure-governance-service';

// Metrics collector
export {
  SwarmMetricsCollector,
  type TicketProcessingMetrics,
  type PhaseMetric,
  type AggregatedMetrics,
  type AgentPerformanceMetric,
  type MetricsCollectorConfig,
} from './swarm-metrics-collector';

// Parity validation
export {
  ParityValidationChecklist,
  type ParityCheckItem,
  type ParityValidationReport,
  type ParityValidationDeps,
} from './parity-validation-checklist';

// Phase-aware routing (ported from the legacy QueueManagerService.js:1100-1421)
export {
  PhaseRoutingService,
  type PhaseRoutingContext,
  type PhaseRoutingResult,
} from './phase-routing-service';

// Comment formatter (ported from the legacy CommentFormatter.js)
export { CommentFormatter } from './comment-formatter';

// Swarm awareness prompt (ported from the legacy SwarmAwarenessPrompt.js)
export {
  buildSwarmAwarenessPrompt,
  buildMinimalSwarmAwareness,
  type SwarmAwarenessOptions,
  type SwarmColleague,
  type SwarmRosterEntry,
} from './swarm-awareness-prompt';

// Phase-specific dispatch prompts (ported from the legacy TicketPhaseManager.js:168-350)
export { getPhasePrompt } from './phase-dispatch-prompts';

// Parent assembly (ported from the legacy QueueManagerService.js:4539)
export {
  ParentAssemblyService,
  type AssemblyCheckResult,
  type AssemblyBlockReason,
} from './parent-assembly-service';

// Planning round orchestrator (extracted from swarm-ticket-processing-service, session 100)
export {
  PlanningRoundOrchestrator,
  type PlanningRoundOrchestratorDeps,
  type PlanningPhaseExecutionInput,
  type PlanningPhaseExecutionResult,
  type PlanningArtifactPaths,
} from './planning-round-orchestrator';

// Execution lifecycle service (extracted from swarm-ticket-processing-service, session 100)
export {
  SwarmExecutionLifecycleService,
  type SwarmExecutionLifecycleServiceDeps,
  type CycleExecutionResult,
  type RoutedWorkUnitSet,
  type ExecuteCycleFn,
  type TestingRegressionResult,
} from './swarm-execution-lifecycle-service';

// Phase persona override (WS2: review-mode persona to prevent planning SOP misbinding)
export { buildPhasePersonaOverride } from './phase-override-layer-builder';

// Routing failure classifier (IMP-1: intelligent escalation)
export {
  classifyRoutingFailure,
  isReroutable,
  type RoutingFailureType,
  type ClassifiedRoutingFailure,
} from './routing-failure-classifier-service';

// Adaptive reroute (IMP-1: intelligent escalation)
export {
  attemptAdaptiveReroute,
  buildSuccessfulRouteDecision,
  type RoutingDecisionExplanation,
  type CandidateEvaluation,
  type RerouteAttemptInput,
} from './adaptive-reroute-service';

// Execution artifact scope isolation (IMP-2: child/review ticket context isolation)
export {
  deriveExecutionScope,
  deriveExecutionScopeId,
  resolveScopedContextFileName,
  resolveScopedHandoverFileName,
  resolveScopedHandoverPrefix,
  type ExecutionArtifactScope,
} from './execution-artifact-scope-service';

// Runtime trace analyzer (WS1: per-ticket phase/round execution history and anomaly detection)
export {
  RuntimeTraceAnalyzerService,
  type RuntimeTaskTrace,
  type TicketTraceReport,
  type TraceAnomaly,
  type RegressionHandoffRecord,
} from './runtime-trace-analyzer-service';
