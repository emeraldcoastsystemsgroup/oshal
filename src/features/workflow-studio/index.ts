/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Exported the workflow run-history store (runs + step records for the studio Runs panel / run inspector)
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | FSD deep-import burn-down: surfaced the process-definition execution engine, its schema/state contracts, and the engine-services node/result types consumers were deep-importing from ./engine and ./schemas
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Surfaced the NodeExecutor / NodeExecutionResult contract and the EngineState type so the multi-app planner's plan-step executor can register a custom node executor through the barrel (no deep import).
 */

export * from './schemas/workflow-studio-schemas';
export * from './services/workflow-studio-compiler';
export * from './services/workflow-studio-service';
export * from './services/workflow-run-history-store';

// FSD deep-import burn-down (2026-07-24): process-definition engine surface through the barrel.
export { ProcessDefinitionExecutionEngine } from './engine/process-definition-execution-engine';
export type {
  ProcessDefinition,
  ExecutableNode,
  ExecutableEdge,
} from './schemas/process-definition-schema';
export type {
  NodeExecutor,
  NodeExecutionResult,
} from './engine/process-definition-execution-engine';
export type { EngineState, EngineStateSnapshot } from './engine/engine-state';
export type {
  EngineServices,
  EngineTicketContext,
  PlanningNodeConfig,
  ExecutionNodeConfig,
  IntakeResult,
  PlanningResult,
  ExecutionResult,
  TestingResult,
  ReviewResult,
  SpecialistResult,
  DeliveryResult,
  DecisionNodeConfig,
  DecisionResult,
  ClusterStepConfig,
  ClusterStepResult,
} from './engine/engine-services';
