/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added agent-profile request/response schemas for dedicated persisted chat-agent personalization
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added optional routing metadata fields so swarm selection can preserve seeded capabilities and keywords
 */

import { z } from 'zod';

/**
 * @description Canonical persisted agent-profile payload used by the standalone chat runtime.
 * This keeps bot identity and lightweight personalization scoped to one `agentId` instead of the global config blob.
 */
export const AgentProfileSchema = z.object({
  agentId: z.string().uuid(),
  name: z.string().min(1).max(255),
  status: z.string().min(1),
  providerId: z.string().min(1),
  modelId: z.string().optional(),
  persona: z.record(z.string(), z.unknown()).optional().default({}),
  baseCapabilities: z.array(z.string()).optional().default([]),
  selectorDescriptor: z.string().optional().default(''),
  routingKeywords: z.array(z.string()).optional().default([]),
  projectUrl: z.string().optional().default(''),
  selectorSkillsText: z.string().optional().default(''),
  avatarUrl: z.string().optional().default(''),
  themePreference: z.string().optional().default('midnight'),
  excludeFromBulkConfig: z.boolean().optional().default(false),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
  updatedAt: z.string(),
});

/**
 * @description Persisted agent-profile response payload.
 */
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

/**
 * @description Lightweight agent list item used by scheduling and cross-bot selection UIs.
 */
export const AgentSummarySchema = AgentProfileSchema.pick({
  agentId: true,
  name: true,
  status: true,
  providerId: true,
  modelId: true,
  baseCapabilities: true,
  selectorDescriptor: true,
  routingKeywords: true,
  projectUrl: true,
  avatarUrl: true,
  themePreference: true,
  excludeFromBulkConfig: true,
  updatedAt: true,
});

/**
 * @description Lightweight agent list item used by scheduling and cross-bot selection UIs.
 */
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

/**
 * @description Partial update payload for narrow chat-agent profile writes.
 * Empty strings are allowed so callers can intentionally clear optional fields.
 */
export const AgentProfileUpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  status: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  modelId: z.string().optional(),
  projectUrl: z.string().optional(),
  selectorSkillsText: z.string().optional(),
  avatarUrl: z.string().optional(),
  themePreference: z.string().optional(),
  excludeFromBulkConfig: z.boolean().optional(),
});

/**
 * @description Narrow partial update for agent-profile persistence.
 */
export type AgentProfileUpdateInput = z.infer<typeof AgentProfileUpdateSchema>;

/**
 * @description HTTP request body for `PUT /api/agents/:agentId/profile`.
 */
export const UpdateAgentProfileRequestSchema = z.object({
  profile: AgentProfileUpdateSchema,
});

/**
 * @description Bot profile fields that make sense to propagate in bulk from one template bot.
 * Identity-specific fields like name/avatar are intentionally excluded.
 */
export const AgentBulkProfileTemplateSchema = z.object({
  status: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  modelId: z.string().optional(),
  projectUrl: z.string().optional(),
  selectorSkillsText: z.string().optional(),
  themePreference: z.string().optional(),
});

/**
 * @description HTTP request body for bulk bot profile configuration actions.
 */
export const BulkAgentProfileRequestSchema = z.object({
  profile: AgentBulkProfileTemplateSchema.refine(
    (profile) => Object.keys(profile).length > 0,
    'Provide at least one bulk profile field',
  ),
  includeExcluded: z.boolean().optional().default(false),
});

/**
 * @description Lightweight bulk-config status for one bot in the swarm.
 */
export const AgentBulkConfigStatusSchema = z.object({
  agentId: z.string().uuid(),
  name: z.string().min(1),
  status: z.string().min(1),
  providerId: z.string().min(1),
  modelId: z.string().optional(),
  projectUrlConfigured: z.boolean(),
  selectorSkillsConfigured: z.boolean(),
  excludeFromBulkConfig: z.boolean(),
  updatedAt: z.string(),
});

/**
 * @description Summary payload returned by bulk bot profile configuration actions.
 */
export const AgentBulkConfigResultSchema = z.object({
  mode: z.enum(['all', 'unset']),
  includeExcluded: z.boolean(),
  requestedFieldCount: z.number().int().nonnegative(),
  updatedAgents: z.array(z.string().uuid()),
  skippedAgents: z.array(z.object({
    agentId: z.string().uuid(),
    reason: z.string().min(1),
  })),
});

/**
 * @description Parsed request payload for agent-profile update endpoints.
 */
export type UpdateAgentProfileRequest = z.infer<typeof UpdateAgentProfileRequestSchema>;
/**
 * @description Inferred type for the bulk-propagatable subset of bot profile fields.
 */
export type AgentBulkProfileTemplate = z.infer<typeof AgentBulkProfileTemplateSchema>;
/**
 * @description Inferred type for the bulk bot profile configuration request body.
 */
export type BulkAgentProfileRequest = z.infer<typeof BulkAgentProfileRequestSchema>;
/**
 * @description Inferred type for a single bot's bulk-config status entry.
 */
export type AgentBulkConfigStatus = z.infer<typeof AgentBulkConfigStatusSchema>;
/**
 * @description Inferred type for the summary result of a bulk bot profile configuration action.
 */
export type AgentBulkConfigResult = z.infer<typeof AgentBulkConfigResultSchema>;
