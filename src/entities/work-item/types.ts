/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added work item entity schemas for internal swarm work unit persistence
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added 2-level hierarchical decomposition: parent_id, depth, subtask statuses
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Session 140: Added routing_failed status for orphan work-item detection (C2)
 */

import { z } from 'zod';

/**
 * @description Valid work item lifecycle statuses.
 */
export const WorkItemStatusSchema = z.enum([
  'pending',
  'assigned',
  'executing',
  'completed',
  'failed',
  'escalated',
  'in-review',
  'subtask-pending',
  'subtask-assigned',
  'subtask-executing',
  'subtask-completed',
  'subtask-failed',
  'routing_failed',
]);

/**
 * @description Subtask-specific statuses — work items in these states are excluded from the main queue.
 */
export const SUBTASK_STATUSES: WorkItemStatus[] = [
  'subtask-pending',
  'subtask-assigned',
  'subtask-executing',
  'subtask-completed',
  'subtask-failed',
];

/**
 * @description Statuses that count as "active" children for the per-parent cap.
 */
export const ACTIVE_SUBTASK_STATUSES: WorkItemStatus[] = [
  'subtask-pending',
  'subtask-assigned',
  'subtask-executing',
];

/**
 * @description Statuses that count as "done" children — freeing slots for new subtasks.
 */
export const TERMINAL_SUBTASK_STATUSES: WorkItemStatus[] = [
  'subtask-completed',
  'subtask-failed',
];

/**
 * @description Maximum decomposition depth (0 = root, 1 = subtask, no deeper).
 */
export const MAX_DECOMPOSITION_DEPTH = 1;

/**
 * @description Maximum active (non-terminal) children per parent work item.
 */
export const MAX_ACTIVE_SUBTASKS_PER_PARENT = 5;

/**
 * @description Work item status key.
 */
export type WorkItemStatus = z.infer<typeof WorkItemStatusSchema>;

/**
 * @description Persistent work item record created from a decomposed work unit.
 */
export const WorkItemSchema = z.object({
  workItemId: z.string().uuid(),
  swarmRunId: z.string().min(1),
  externalId: z.string().min(1),
  provider: z.string().min(1),
  unitId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(''),
  acceptanceCriteria: z.array(z.string()).default([]),
  labels: z.array(z.string()).default([]),
  priority: z.string().optional(),
  assignedAgentId: z.string().optional(),
  parentId: z.string().uuid().nullable().default(null),
  depth: z.number().int().min(0).max(1).default(0),
  status: WorkItemStatusSchema.default('pending'),
  executionOutput: z.unknown().optional(),
  verificationResult: z.unknown().optional(),
  metadata: z.record(z.unknown()).default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * @description Persistent work item record type.
 */
export type WorkItem = z.infer<typeof WorkItemSchema>;

/**
 * @description Input for creating a new work item from a decomposed work unit.
 */
export const CreateWorkItemInputSchema = z.object({
  swarmRunId: z.string().min(1),
  externalId: z.string().min(1),
  provider: z.string().min(1),
  unitId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(''),
  acceptanceCriteria: z.array(z.string()).default([]),
  labels: z.array(z.string()).default([]),
  priority: z.string().optional(),
  parentId: z.string().uuid().nullable().optional(),
  depth: z.number().int().min(0).max(1).default(0),
});

/**
 * @description Input type for creating a work item.
 */
export type CreateWorkItemInput = z.infer<typeof CreateWorkItemInputSchema>;
