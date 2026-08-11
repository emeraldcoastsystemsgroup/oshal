/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — task lifecycle types ported from any-bot
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Zod v4 compatibility: refactored all .default() to .optional().default(); fixed Change Log author/timestamp
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added optional taskId to task creation input for deterministic task identity across chat orchestration flow
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added waiting_for_input completion type for follow-up question pause/resume flow
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added persistent usage telemetry schemas for per-model token and cost aggregation on tasks
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added optional ticketId to ProcessMessageOptions for ticket→task linking
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Added optional ticketContext note so orchestrated ticket-linked chats can tell the active agent about the canonical internal ticket record
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Added paused task status so cockpit fallback task-backed tickets can honor pause lifecycle controls consistently
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Permit trusted in-process reason-only callers to supply an explicit system prompt without filesystem persona discovery.
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Security hardening: remove the generic connector-credential carrier from ProcessMessageOptions; model requests keep owner identity only.
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | ADR-127 inline hosted brain: typed byoLlmConnection on ProcessMessageOptions (baseUrl+apiKey+model — the user-brain ladder result) so the orchestrator can honor a caller-resolved hosted endpoint instead of the callers smuggling it through an `as any` cast the orchestrator never read.
 */

import { z } from 'zod';

/**
 * @description Task lifecycle status values.
 * Ported from any-bot's TaskStore status tracking.
 */
export const TaskStatusSchema = z.enum([
  'created',
  'active',
  'processing',
  'waiting_for_input',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);

/**
 * @description Task lifecycle status.
 */
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/**
 * @description Processing mode for a task.
 * In any-bot, tasks can use agentic mode (multi-turn) or direct mode (single response).
 */
export const ProcessingModeSchema = z.enum([
  'agentic',
  'direct',
]);

/**
 * @description Task processing mode.
 */
export type ProcessingMode = z.infer<typeof ProcessingModeSchema>;

/**
 * @description Per-model usage and cost aggregation tracked at task scope.
 */
export const ModelUsageStatsSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional().default(0),
  outputTokens: z.number().int().nonnegative().optional().default(0),
  totalTokens: z.number().int().nonnegative().optional().default(0),
  inputCost: z.number().nonnegative().optional().default(0),
  outputCost: z.number().nonnegative().optional().default(0),
  totalCost: z.number().nonnegative().optional().default(0),
  requestCount: z.number().int().nonnegative().optional().default(0),
});

/**
 * @description Task usage aggregate for one orchestration request.
 */
export type ModelUsageStats = z.infer<typeof ModelUsageStatsSchema>;

/**
 * @description Aggregated request-level usage/cost summary across one provider interaction flow.
 */
export const TaskUsageSummarySchema = z.object({
  inputTokens: z.number().int().nonnegative().optional().default(0),
  outputTokens: z.number().int().nonnegative().optional().default(0),
  totalTokens: z.number().int().nonnegative().optional().default(0),
  inputCost: z.number().nonnegative().optional().default(0),
  outputCost: z.number().nonnegative().optional().default(0),
  totalCost: z.number().nonnegative().optional().default(0),
  currency: z.string().optional().default('USD'),
  requestCount: z.number().int().nonnegative().optional().default(0),
  byModel: z.record(z.string(), ModelUsageStatsSchema).optional().default({}),
});

/**
 * @description Request-level usage/cost summary data.
 */
export type TaskUsageSummary = z.infer<typeof TaskUsageSummarySchema>;

/**
 * @description Schema for a stored task record.
 */
export const StoredTaskSchema = z.object({
  taskId: z.string(),
  title: z.string().optional().default(''),
  status: TaskStatusSchema.optional().default('created'),
  processingMode: ProcessingModeSchema.optional().default('agentic'),
  agentId: z.string().optional(),
  providerId: z.string().optional(),
  messageCount: z.number().int().nonnegative().optional().default(0),
  turnCount: z.number().int().nonnegative().optional().default(0),
  totalInputTokens: z.number().int().nonnegative().optional().default(0),
  totalOutputTokens: z.number().int().nonnegative().optional().default(0),
  totalTokens: z.number().int().nonnegative().optional().default(0),
  totalInputCost: z.number().nonnegative().optional().default(0),
  totalOutputCost: z.number().nonnegative().optional().default(0),
  totalCost: z.number().nonnegative().optional().default(0),
  totalRequests: z.number().int().nonnegative().optional().default(0),
  costCurrency: z.string().optional().default('USD'),
  usageByModel: z.record(z.string(), ModelUsageStatsSchema).optional().default({}),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
  /** End-user (OIDC sub) this task's LLM spend is attributable to, for per-owner
   *  budget enforcement (model-gateway Phase 2). Undefined for system tasks. */
  ownerSub: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/**
 * @description A persisted task record.
 */
export type StoredTask = z.infer<typeof StoredTaskSchema>;

/**
 * @description Schema for creating a new task.
 * `taskId` is optional; when provided by caller (chat UI flow), stores should
 * persist using that identifier to keep route/orchestrator/store traceability aligned.
 */
export const CreateTaskSchema = z.object({
  taskId: z.string().optional(),
  title: z.string().optional().default(''),
  processingMode: ProcessingModeSchema.optional().default('agentic'),
  agentId: z.string().optional(),
  providerId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
  /** End-user (OIDC sub) for per-owner budget attribution (Phase 2). */
  ownerSub: z.string().optional(),
});

/**
 * @description Input for creating a new task.
 */
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;

/**
 * @description Canonical ticket context note injected into orchestration prompts when a conversation is backed by an internal ticket.
 */
export const ProcessTicketContextSchema = z.object({
  ticketId: z.string().uuid(),
  title: z.string().min(1),
  status: z.string().min(1),
  projectName: z.string().min(1),
  createdFromIntake: z.boolean().optional().default(false),
});

/**
 * @description Canonical ticket context carried into orchestration prompt composition.
 */
export type ProcessTicketContext = z.infer<typeof ProcessTicketContextSchema>;

/**
 * @description Options passed when processing a user message.
 * Ported from any-bot's TaskController processMessage options.
 */
export const ProcessMessageOptionsSchema = z.object({
  agenticMode: z.boolean().optional().default(true),
  autoApprove: z.boolean().optional().default(false),
  source: z.string().optional().default('dashboard'),
  agentId: z.string().optional(),
  images: z.array(z.string()).optional(),
  files: z.array(z.string()).optional(),
  ticketId: z.string().optional(),
  ticketContext: ProcessTicketContextSchema.optional(),
  /** Authenticated caller's OIDC sub — scopes the bot's per-user data access
   *  (e.g. which connected Gmail it may read). Threaded to the harness workspace. */
  userSub: z.string().optional(),
  /** Trusted in-process direct-mode prompt. Route handlers must never copy this from an HTTP body. */
  systemPromptOverride: z.string().min(1).max(50000).optional(),
  /** Caller-resolved hosted OpenAI-compatible endpoint for THIS turn's reasoning (ADR-127
   *  user-brain ladder). Resolved server-side (never copied from an HTTP body); when present
   *  the orchestrator runs the turn on it instead of the registry/process provider. */
  byoLlmConnection: z.object({
    baseUrl: z.string().min(1),
    apiKey: z.string().min(1),
    model: z.string().min(1),
  }).optional(),
});

/**
 * @description Options for processing a user message.
 */
export type ProcessMessageOptions = z.infer<typeof ProcessMessageOptionsSchema>;

/**
 * @description Result from processing a message through the agentic loop.
 */
export const ProcessResultSchema = z.object({
  success: z.boolean(),
  response: z.string().optional(),
  turnCount: z.number().int().nonnegative().optional().default(0),
  toolsUsed: z.array(z.string()).optional().default([]),
  usageSummary: TaskUsageSummarySchema.optional(),
  error: z.string().optional(),
  completionType: z.enum(['natural', 'tool_limit', 'error', 'user_cancel', 'waiting_for_input']).optional(),
});

/**
 * @description Result from message processing.
 */
export type ProcessResult = z.infer<typeof ProcessResultSchema>;
