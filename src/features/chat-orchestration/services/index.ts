/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Barrel export for chat-orchestration services (chatService, useDebugStream)
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Exported swarm debug panel hook and client-side debug logger for the chat debug window
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | WS5: Exported TicketInteractionService and related types for canonical ticket intent separation
 */

export { postChatMessage } from "./chatService";
export { resolveProjectManagerTicketExecutionContext } from './project-manager-ticket-intake';
export { useDebugStream } from "./useDebugStream";
export { useSwarmDebugPanel } from './useSwarmDebugPanel';
export { reportClientDebugError } from './debug-client-log';
export {
  TicketInteractionService,
  type TicketInteractionIntent,
  type TicketInteractionInput,
  type TicketInteractionResult,
  type TicketInteractionDeps,
} from './ticket-interaction-service';
