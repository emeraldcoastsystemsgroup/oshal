/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel export for chat orchestration feature
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Exported ToolExecutorService and ToolExecutionContext for runtime tool execution wiring
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Exported DEFAULT_CHAT_AGENT_ID/NAME through the barrel so consumers stop deep-importing the constant
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | FSD deep-import burn-down: exported TicketInteractionService through the barrel
 */

export { DEFAULT_CHAT_AGENT_ID, DEFAULT_CHAT_AGENT_NAME } from './constants/default-chat-agent';
export { TaskOrchestrator, type TaskOrchestratorDeps } from './services/task-orchestrator';
export {
  resolveProjectManagerTicketExecutionContext,
  type ProjectManagerTicketExecutionContext,
  type ProjectManagerTicketIntakeDeps,
} from './services/project-manager-ticket-intake';
export {
  runAgenticLoop,
  type AgenticLoopConfig,
  type ToolExecutionCallback,
  type ToolExecutionContext,
} from './services/agentic-loop';
export { ToolExecutorService, type ToolExecutorServiceDeps } from './services/tool-executor-service';
export { TicketInteractionService } from './services/ticket-interaction-service';
