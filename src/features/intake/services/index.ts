/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added intake-service barrel exports
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Exported crash-safe materializing reconciliation contracts
 */

export type {
  PullWorkItemsInput,
  PullWorkItemsResult,
  WorkItemFeedAdapter,
} from './work-item-feed-adapter';
export {
  InMemoryIntakeCursorStore,
  PostgresIntakeCursorStore,
  type WorkItemCursorStore,
} from './intake-cursor-store';
export {
  IntakeService,
  type IntakePullResult,
  type IntakeReconcileResult,
  type IntakeWorkItemMaterializer,
} from './intake-service';
export {
  IntakeL1ProcessorService,
  type IntakeL1Assessment,
  type IntakeL1Input,
} from './intake-l1-processor-service';
