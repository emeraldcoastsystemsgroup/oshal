/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted application context interface from the oversized composition root
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added dedicated agent-profile controller to application context
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added intake controller dependency to application context
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Replaced direct intake controller dependency with swarm extension bindings
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added TicketService and WorkspaceService to application context for internal ticketing
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added PlaneSyncService to application context for Plane sync REST API
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Added TicketProjectAssignmentService to application context for root-ticket project moves
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | WS5: Added TicketInteractionService to application context for canonical ticket update/chat/intake intent separation
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Track B S6: Added DynamicToolExecutorRegistry to application context
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Normalized historical Change Log attribution to the mandated project author identifier
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 D10: added optional appPackageDir — the manifest route mounter hands every PACKAGE route factory a context carrying its own package directory, replacing request-time reads of the process-global OSHAL_APP_PACKAGE_DIR env var (last-mounted app won; multi-app reloads served cross-app assets).
 */

import type { Pool } from 'pg';
import type { InMemoryTaskStore } from '@/entities/task';
import type { InMemoryMessageStore } from '@/entities/message';
import type { StreamManager } from '@/features/streaming';
import type { TaskOrchestrator, TicketInteractionService } from '@/features/chat-orchestration';
import type { LLMService } from '@/features/llm-provider';
import type { ToolController, ToolRegistryService, DynamicToolExecutorRegistry, RuntimeToolRegistrationService } from '@/features/tool-registry';
import type { AgentProfileController } from '@/features/agent-profile';
import type { AgentToolController, SwitchFrameworkService } from '@/features/tool-switch';
import type { SelectorCompositionService } from '@/features/selector-composition';
import type { VerificationController, VerificationScheduler } from '@/features/tool-verification';
import type { MemoryLayerService } from '@/features/memory';
import type { WorkspaceBootstrapService } from '@/features/workspace-bootstrap';
import type { SwarmExtensionBindings } from '@/app/extensions';
import type {
  TicketService,
  TicketProjectAssignmentService,
  WorkspaceService,
  PlaneSyncService,
} from '@/features/ticketing';
import type { ConnectorSpecToolService } from '@/app/connectors/runtime/spec-tools';
import type { ConnectorMarketplaceService } from '@/app/connectors/runtime/marketplace';

/**
 * @description Application context holding all wired dependencies.
 * Created by the composition root and passed to route handlers.
 */
export interface AppContext {
  taskStore: InMemoryTaskStore;
  messageStore: InMemoryMessageStore;
  streamManager: StreamManager;
  orchestrator: TaskOrchestrator;
  provider: LLMService;
  getProvider: () => LLMService;
  pool: Pool;
  toolController: ToolController;
  agentProfileController: AgentProfileController;
  agentToolController: AgentToolController;
  swarm: SwarmExtensionBindings;
  toolRegistryService: ToolRegistryService;
  dynamicToolExecutorRegistry: DynamicToolExecutorRegistry;
  runtimeToolRegistrationService: RuntimeToolRegistrationService;
  connectorMarketplaceService: ConnectorMarketplaceService;
  connectorSpecToolService: ConnectorSpecToolService;
  switchFrameworkService: SwitchFrameworkService;
  selectorCompositionService: SelectorCompositionService;
  verificationController: VerificationController;
  verificationScheduler: VerificationScheduler;
  memoryService: MemoryLayerService;
  workspaceBootstrapService: WorkspaceBootstrapService;
  ticketService: TicketService;
  ticketProjectAssignmentService: TicketProjectAssignmentService;
  workspaceService: WorkspaceService;
  planeSyncService: PlaneSyncService;
  ticketInteractionService: TicketInteractionService;
  /**
   * @description Absolute path of the installed app package this context was built FOR.
   * Populated ONLY on the per-package context the manifest route mounter passes to a
   * package's route factory (ADR-085) — undefined for all framework-internal consumers.
   * Package code must capture it at factory time (e.g. into a closure) instead of reading
   * process.env.OSHAL_APP_PACKAGE_DIR at request time: the env var is a load-time-only
   * channel and points at whichever package was required LAST.
   */
  appPackageDir?: string;
}
