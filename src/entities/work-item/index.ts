/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added work item entity barrel export
 */

export { WorkItemRepository } from './repositories/work-item-repository';
export {
  WorkItemSchema,
  WorkItemStatusSchema,
  CreateWorkItemInputSchema,
  SUBTASK_STATUSES,
  ACTIVE_SUBTASK_STATUSES,
  TERMINAL_SUBTASK_STATUSES,
  MAX_DECOMPOSITION_DEPTH,
  MAX_ACTIVE_SUBTASKS_PER_PARENT,
  type WorkItem,
  type WorkItemStatus,
  type CreateWorkItemInput,
} from './types';
