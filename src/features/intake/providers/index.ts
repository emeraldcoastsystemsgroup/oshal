/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added intake provider barrel export
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added GitHub intake adapter export (M5)
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Exported configured GitHub multi-feed and routing contracts
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Exported deterministic release-proof GitHub issue closure policy contracts
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Exported shared GitHub ticket lifecycle projection contracts
 */

export { PlaneWorkItemFeedAdapter } from './plane-work-item-feed-adapter';
export {
  GitHubWorkItemFeedAdapter,
  type GitHubTicketTokenProvider,
  type GitHubWorkItemFeedAdapterOptions,
} from './github-work-item-feed-adapter';
export {
  buildGitHubTicketRouting,
  readGitHubTicketRouting,
  resolveGitHubTicketFeeds,
  type GitHubTicketFeedConfig,
  type GitHubTicketRouting,
} from './github-ticket-provider-config';
export {
  decideGitHubReleaseClosure,
  type GitHubReleaseCloseDecision,
  type GitHubReleaseCloseInput,
  type GitHubReleaseCloseReason,
} from './github-release-close-policy';
export {
  resolveGitHubTicketLifecycleTarget,
  type GitHubTicketLifecycleSnapshot,
} from './github-ticket-lifecycle';
