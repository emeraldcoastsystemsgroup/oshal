/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of config sync types and Zod schemas
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Zod v4 compatibility: refactored all .default() to .optional().default(); fixed Change Log author/timestamp
 */

import { z } from 'zod';

/**
 * @description Zod schema for sync direction values.
 */
export const SyncDirectionSchema = z.enum(['push', 'pull']);

/**
 * @description Direction of a config sync operation.
 */
export type SyncDirection = z.infer<typeof SyncDirectionSchema>;

/**
 * @description Zod schema for sync operation status.
 */
export const SyncStatusSchema = z.enum([
  'pending',
  'applied',
  'rejected',
  'conflict',
]);

/**
 * @description Status of a sync operation.
 */
export type SyncStatus = z.infer<typeof SyncStatusSchema>;

/**
 * @description Zod schema for conflict resolution strategies.
 */
export const ConflictResolutionSchema = z.enum([
  'central-wins',
  'local-wins',
  'manual',
]);

/**
 * @description Strategy for resolving config conflicts between controller and agent.
 */
export type ConflictResolution = z.infer<typeof ConflictResolutionSchema>;

/**
 * @description Zod schema for a config sync audit record.
 * Tracks every config distribution event between controller and agents.
 */
export const ConfigSyncRecordSchema = z.object({
  syncId: z.string().uuid(),
  agentId: z.string().uuid(),
  direction: SyncDirectionSchema,
  configVersionBefore: z.number().int().nonnegative(),
  configVersionAfter: z.number().int().nonnegative(),
  changes: z.record(z.string(), z.unknown()).optional().default({}),
  status: SyncStatusSchema.optional().default('pending'),
  conflictResolution: ConflictResolutionSchema.nullable().optional().default(null),
  syncedAt: z.string().datetime(),
});

/**
 * @description Config sync audit record.
 */
export type ConfigSyncRecord = z.infer<typeof ConfigSyncRecordSchema>;

/**
 * @description Zod schema for a config push request from controller to agent(s).
 * Used for POST /api/sync/push requests.
 */
export const ConfigPushRequestSchema = z.object({
  agentIds: z.array(z.string().uuid()).min(1, 'At least one agent ID required'),
  changes: z.record(z.string(), z.unknown()),
  source: z.literal('controller').optional().default('controller'),
  force: z.boolean().optional().default(false),
});

/**
 * @description Input for pushing config from controller to agents.
 */
export type ConfigPushRequest = z.infer<typeof ConfigPushRequestSchema>;

/**
 * @description Zod schema for an agent's local config override report.
 * Used when an agent modifies its own config and reports back.
 */
export const ConfigOverrideRequestSchema = z.object({
  agentId: z.string().uuid(),
  field: z.string().min(1),
  value: z.unknown(),
  reason: z.string().min(1, 'Override reason is required'),
});

/**
 * @description Input for an agent reporting a local config override.
 */
export type ConfigOverrideRequest = z.infer<typeof ConfigOverrideRequestSchema>;

/**
 * @description Zod schema for conflict resolution request.
 * Used for POST /api/sync/resolve/:syncId requests.
 */
export const ConflictResolveRequestSchema = z.object({
  syncId: z.string().uuid(),
  resolution: ConflictResolutionSchema,
  resolvedValue: z.unknown().optional(),
});

/**
 * @description Input for resolving a config conflict.
 */
export type ConflictResolveRequest = z.infer<typeof ConflictResolveRequestSchema>;

/**
 * @description Zod schema for agent bootstrap response.
 * Returned when an agent calls GET /api/agents/:id/bootstrap on startup.
 */
export const AgentBootstrapResponseSchema = z.object({
  agentId: z.string().uuid(),
  name: z.string(),
  configVersion: z.number().int().nonnegative(),
  provider: z.record(z.string(), z.unknown()),
  persona: z.record(z.string(), z.unknown()),
  tools: z.array(z.record(z.string(), z.unknown())),
  metadata: z.record(z.string(), z.unknown()),
  envOverrides: z.record(z.string(), z.string()).optional().default({}),
});

/**
 * @description Agent bootstrap response payload.
 */
export type AgentBootstrapResponse = z.infer<typeof AgentBootstrapResponseSchema>;