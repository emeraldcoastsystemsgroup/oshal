/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of agent metadata types and Zod schemas
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Zod v4 compatibility: refactored all .default() to .optional().default(); fixed Change Log author/timestamp
 */

import { z } from 'zod';
import { ApiProviderSchema } from './api-provider';

/**
 * @description Zod schema for agent status values.
 */
export const AgentStatusSchema = z.enum([
  'active',
  'inactive',
  'error',
  'provisioning',
  'maintenance',
]);

/**
 * @description Agent lifecycle status.
 */
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/**
 * @description Zod schema for agent persona configuration.
 * Defines the agent's identity, behavioral constraints, and capabilities.
 */
export const PersonaConfigSchema = z.object({
  systemPrompt: z.string().min(1, 'System prompt is required'),
  role: z.string().min(1, 'Role is required'),
  capabilities: z.array(z.string()).optional().default([]),
  constraints: z.array(z.string()).optional().default([]),
  description: z.string().optional(),
});

/**
 * @description Agent persona configuration.
 */
export type PersonaConfig = z.infer<typeof PersonaConfigSchema>;

/**
 * @description Zod schema for agent provider link.
 * Connects an agent to an API provider configuration with optional overrides.
 */
export const AgentProviderSchema = z.object({
  apiProviderId: ApiProviderSchema,
  modelId: z.string().optional(),
  overrides: z.record(z.string(), z.unknown()).optional().default({}),
});

/**
 * @description Agent-to-provider binding with optional overrides.
 */
export type AgentProvider = z.infer<typeof AgentProviderSchema>;

/**
 * @description Zod schema for config source tracking.
 */
export const ConfigSourceSchema = z.enum(['central', 'local', 'merged']);

/**
 * @description Origin of the current configuration state.
 */
export type ConfigSource = z.infer<typeof ConfigSourceSchema>;

/**
 * @description Zod schema for creating a new agent.
 * Used for POST /api/agents requests.
 */
export const CreateAgentSchema = z.object({
  name: z.string().min(1, 'Agent name is required').max(255),
  provider: AgentProviderSchema,
  persona: PersonaConfigSchema,
  tools: z.array(z.string().uuid()).optional().default([]),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

/**
 * @description Input for creating a new agent.
 */
export type CreateAgentInput = z.infer<typeof CreateAgentSchema>;

/**
 * @description Zod schema for updating an existing agent.
 * All fields optional — partial updates allowed.
 */
export const UpdateAgentSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  status: AgentStatusSchema.optional(),
  provider: AgentProviderSchema.optional(),
  persona: PersonaConfigSchema.optional(),
  tools: z.array(z.string().uuid()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * @description Input for updating an existing agent.
 */
export type UpdateAgentInput = z.infer<typeof UpdateAgentSchema>;

/**
 * @description Zod schema for full agent configuration record.
 * Represents a complete agent as stored in the database.
 */
export const AgentConfigSchema = z.object({
  agentId: z.string().uuid(),
  name: z.string().min(1).max(255),
  status: AgentStatusSchema.optional().default('active'),
  provider: AgentProviderSchema,
  persona: PersonaConfigSchema,
  tools: z.array(z.string().uuid()).optional().default([]),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
  configVersion: z.number().int().nonnegative().optional().default(1),
  configSource: ConfigSourceSchema.optional().default('central'),
  lastSyncAt: z.string().datetime().nullable().optional().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/**
 * @description Full agent configuration record.
 */
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/**
 * @description Zod schema for agent heartbeat payload.
 * Sent by agents on interval to report health.
 */
export const AgentHeartbeatSchema = z.object({
  agentId: z.string().uuid(),
  status: AgentStatusSchema,
  configVersion: z.number().int().nonnegative(),
  toolCount: z.number().int().nonnegative(),
  lastTaskAt: z.string().datetime().nullable().optional(),
  uptime: z.number().nonnegative().optional(),
  memoryUsageMb: z.number().nonnegative().optional(),
});

/**
 * @description Agent heartbeat payload.
 */
export type AgentHeartbeat = z.infer<typeof AgentHeartbeatSchema>;