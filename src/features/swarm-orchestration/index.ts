/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added swarm-orchestration feature barrel exports
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Exported Postgres-backed swarm run store for durable orchestration bindings
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Exported ticket write-back contracts and Plane adapter for provider lifecycle feedback
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Exported ticket-state projection service for canonical ticket workflow enforcement
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Exported swarm retry policy and verification services for controller and test wiring
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Exported Postgres-backed escalation store for durable escalation routing
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Exported SwarmAgentWorker for consuming and executing mesh envelopes from Redis Streams
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Exported SubtaskLifecycleService and types for 2-level subtask state tracking
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Re-exported mesh-support helpers and in-memory transport through the feature barrel for extension safety
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Exported QueueManagerService — background polling loop that feeds approved tickets into the swarm pipeline
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Exported DeadLetterService (+ types, readQmMaxAttempts) — persisted queue DLQ / poison-ticket policy (migration 081)
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Exported idempotent external-ticket materialization for extension composition
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | FSD deep-import burn-down: re-exported service members consumers were reaching via deep paths (rca-mode, prompt-layer builders, phase/queue/failure/metrics services, trace analyzer, workflow-pipeline registry, comment formatter, TicketTraceReport). All within the barrel's pre-existing service subgraph — no new import cycle.
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | Exported SEC-05 prompt containment and authority-binding contracts.
 */

export { SwarmOrchestrationController } from './controllers';
export { PlaneTicketWritebackAdapter, GitHubTicketWritebackAdapter } from './providers';
export {
  SWARM_TICKET_CYCLE_ORDER,
  InMemorySwarmRunStore,
  PostgresSwarmEscalationStore,
  PostgresSwarmRunStore,
  SwarmTicketProcessingService,
  SwarmRuntimeUnavailableError,
  TicketCycleStateMachine,
  TicketDecompositionService,
  type SwarmProcessingInput,
  type SwarmProcessingResult,
  type SwarmRuntimeReadiness,
  type SwarmRuntimeReadinessProbe,
  type SwarmProcessedTicketResult,
  type SwarmRunRecord,
  type SwarmRunStatus,
  type SwarmRunStore,
  type SwarmTicketCycle,
  type SwarmTicketCycleRecord,
  type SwarmTicketCycleStatus,
  type SwarmTicketLifecycleSnapshot,
  TicketStateProjectionService,
  type DecomposedWorkUnit,
  type TicketWritebackAdapter,
  type TicketWritebackStatus,
  type TicketWritebackUpdate,
  type SwarmEscalationStore,
  type SwarmEscalationQuery,
  SwarmAgentWorker,
  type EnvelopeExecutionHandler,
  type EnvelopeExecutionResult,
  type DirectMessageHandler,
  type SwarmAgentWorkerOptions,
  createLLMExecutionHandler,
  type LLMExecutionHandlerDeps,
  SwarmVerificationService,
  SubtaskLifecycleService,
  type TrackedSubtask,
  type ParentWithSubtasks,
  type SubtaskRollupResult,
  RALFHandoverManager,
  type HandoverDocument,
  PhaseRoundOrchestrator,
  type PhaseRoundState,
  type RoundContext,
  type RoundAssignment,
  type RoundCompletionResult,
  loadPersonaFromFile,
  type BotPersona,
  SWARM_PHASE_ORDER,
  InMemoryMeshTransport,
  type SwarmPhase,
  type PhaseGateConfig,
  type TicketComplexity,
  ConsensusReviewService,
  type ReviewerVerdict,
  type ConsensusReviewOutcome,
  SwarmEscalationError,
  buildExecutionEnvelope,
  normalizeCandidates,
  type SwarmOnlineAgentIdsResolver,
  QueueManagerService,
  type QueueManagerOptions,
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
  MultiRoundDispatchService,
  type MultiRoundDispatchDeps,
  type AgentSelectorFn,
  type PhaseDispatchResult,
  type RoundExecutionResult,
  ensureInternalTicketForWorkItem,
} from './services';

// FSD deep-import burn-down (2026-07-24): members consumers were reaching via deep
// service paths, surfaced through the slice barrel. These modules already live in the
// barrel's module graph via the './services' re-export above — adding named forwards
// here introduces no new import cycle.
export { readRcaMode, INCIDENT_MODE_DISPOSITION } from './services/rca-mode';
export {
  buildUserMessage,
  loadPersonaLayers,
  assemblePromptForAnyBot,
  buildFilePersonaLayer,
  buildHandoverLayers,
  buildSwarmAwarenessLayer,
  buildSwarmMemoryLayer,
  buildSwarmMemoryLayers,
  buildFallbackProfile,
  type CostRecordFn,
} from './services/llm-execution-handler';
export { buildPhasePersonaOverride } from './services/phase-override-layer-builder';
export { deriveExecutionScopeId } from './services/execution-artifact-scope-service';
export {
  assembleContainedPrompt,
  buildAuthorityRebind,
  containPersonaLayers,
  resolvePromptAuthorityBinding,
  wrapUntrustedPromptContent,
  type PromptAuthorityBinding,
  type PromptAuthorityInput,
  type PromptAuthorizationResolver,
  type PromptAuthorizationSnapshot,
  type TrustedPromptConfiguration,
} from './services/prompt-containment';
export { TaskFolderService } from './services/task-folder-service';
export {
  QueueGovernanceService,
  InMemoryGovernanceStore,
  PostgresGovernanceStore,
} from './services/queue-governance-service';
export { PhaseRegressionService } from './services/phase-regression-service';
export { FailureGovernanceService } from './services/failure-governance-service';
export { SwarmMetricsCollector } from './services/swarm-metrics-collector';
export { PhaseRoutingService } from './services/phase-routing-service';
export { buildTaskCallOutResolver } from './services/task-call-out';
export { PostgresSubtaskLifecycleStore } from './services/postgres-subtask-lifecycle-store';
export { RuntimeTraceAnalyzerService } from './services/runtime-trace-analyzer-service';
export { WorkflowPipelineRegistry } from './services/workflow-pipeline-registry';
export { CommentFormatter } from './services/comment-formatter';
export type { TicketTraceReport } from './services';

// Multi-app planner (SEAM D): NL plan → ordered ProcessDefinition on the existing 'graph' rail.
export {
  MultiAppPlanSchema,
  MultiAppPlanStepSchema,
  parseMultiAppPlan,
  isMultiAppPlan,
  extractPlanDirective,
  stripPlanDirective,
  describePlan,
  type MultiAppPlan,
  type MultiAppPlanStep,
} from './services/multi-app-plan';
export {
  compilePlanToProcessDefinition,
  buildPlanWorkflowDefinition,
  newPlanTicketType,
  type CompiledPlanProcessDefinition,
} from './services/multi-app-plan-compiler';
export {
  PLAN_STEP_NODE_TYPE,
  registerPlanStepExecutor,
  createPlanStepExecutor,
  substitutePlanVariables,
  type AgentPromptDispatchConfig,
  type AgentPromptDispatchResult,
  type AgentPromptDispatcher,
} from './services/plan-step-executor';
