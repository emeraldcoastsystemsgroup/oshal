/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added intake feature barrel exports
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added GitHub intake adapter export (M5)
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Exported durable cursor storage and GitHub ticket-feed configuration contracts
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Exported materializing reconciliation contracts
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Exported GitHub lifecycle reconciliation contracts through the public feature barrel
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | FSD deep-import burn-down: surfaced FastIntakeService and IntakeAssistantService (not re-exported by the ./services aggregate) through the barrel
 */

export { IntakeController } from './controllers';
export {
  IntakeService,
  InMemoryIntakeCursorStore,
  PostgresIntakeCursorStore,
  IntakeL1ProcessorService,
  type IntakePullResult,
  type IntakeReconcileResult,
  type IntakeWorkItemMaterializer,
  type IntakeL1Assessment,
  type IntakeL1Input,
  type PullWorkItemsInput,
  type PullWorkItemsResult,
  type WorkItemFeedAdapter,
  type WorkItemCursorStore,
} from './services';
export { FastIntakeService } from './services/fast-intake-service';
export { IntakeAssistantService } from './services/intake-assistant-service';
export { PlaneWorkItemFeedAdapter } from './providers';
export {
  GitHubWorkItemFeedAdapter,
  resolveGitHubTicketLifecycleTarget,
  resolveGitHubTicketFeeds,
  readGitHubTicketRouting,
  type GitHubTicketLifecycleSnapshot,
  type GitHubTicketFeedConfig,
  type GitHubTicketRouting,
  type GitHubTicketTokenProvider,
} from './providers';
