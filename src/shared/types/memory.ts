/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added non-swarm memory layer schemas for checkpoints, per-agent memory, and knowledge memory persistence
 */

import { z } from 'zod';
import { StoredTaskSchema } from './task';
import { StoredMessageSchema } from './message';

/**
 * @description Trigger that created a checkpoint snapshot.
 */
export const CheckpointTriggerSchema = z.enum(['auto', 'manual', 'restore']);

/**
 * @description Checkpoint trigger type.
 */
export type CheckpointTrigger = z.infer<typeof CheckpointTriggerSchema>;

/**
 * @description Persisted checkpoint snapshot for one task.
 */
export const TaskCheckpointSchema = z.object({
  checkpointId: z.string().uuid(),
  taskId: z.string(),
  agentId: z.string().optional(),
  label: z.string().optional(),
  summary: z.string().optional(),
  trigger: CheckpointTriggerSchema.optional().default('manual'),
  messageCount: z.number().int().nonnegative().optional().default(0),
  taskSnapshot: StoredTaskSchema,
  messagesSnapshot: z.array(StoredMessageSchema).optional().default([]),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
  createdAt: z.string().datetime(),
});

/**
 * @description Persisted task checkpoint.
 */
export type TaskCheckpoint = z.infer<typeof TaskCheckpointSchema>;

/**
 * @description Request payload for creating a checkpoint.
 */
export const CreateCheckpointInputSchema = z.object({
  label: z.string().optional(),
  summary: z.string().optional(),
  trigger: CheckpointTriggerSchema.optional().default('manual'),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

/**
 * @description Checkpoint creation input.
 */
export type CreateCheckpointInput = z.infer<typeof CreateCheckpointInputSchema>;

/**
 * @description Persisted agent-local memory distilled from one task.
 */
export const AgentMemoryRecordSchema = z.object({
  memoryId: z.string().uuid(),
  agentId: z.string(),
  taskId: z.string(),
  title: z.string(),
  summary: z.string(),
  lastUserMessage: z.string().optional(),
  lastAssistantMessage: z.string().optional(),
  toolNames: z.array(z.string()).optional().default([]),
  keywords: z.array(z.string()).optional().default([]),
  messageCount: z.number().int().nonnegative().optional().default(0),
  turnCount: z.number().int().nonnegative().optional().default(0),
  totalTokens: z.number().int().nonnegative().optional().default(0),
  totalCost: z.number().nonnegative().optional().default(0),
  costCurrency: z.string().optional().default('USD'),
  source: z.enum(['task_result', 'checkpoint', 'manual']).optional().default('task_result'),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/**
 * @description Agent memory record.
 */
export type AgentMemoryRecord = z.infer<typeof AgentMemoryRecordSchema>;

/**
 * @description Input for upserting per-agent local memory.
 */
export const UpsertAgentMemoryInputSchema = z.object({
  agentId: z.string(),
  taskId: z.string(),
  title: z.string(),
  summary: z.string(),
  lastUserMessage: z.string().optional(),
  lastAssistantMessage: z.string().optional(),
  toolNames: z.array(z.string()).optional().default([]),
  keywords: z.array(z.string()).optional().default([]),
  messageCount: z.number().int().nonnegative().optional().default(0),
  turnCount: z.number().int().nonnegative().optional().default(0),
  totalTokens: z.number().int().nonnegative().optional().default(0),
  totalCost: z.number().nonnegative().optional().default(0),
  costCurrency: z.string().optional().default('USD'),
  source: z.enum(['task_result', 'checkpoint', 'manual']).optional().default('task_result'),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

/**
 * @description Agent memory upsert payload.
 */
export type UpsertAgentMemoryInput = z.infer<typeof UpsertAgentMemoryInputSchema>;

/**
 * @description Persisted knowledge-memory document metadata for RAG ingestion.
 */
export const KnowledgeMemoryDocumentSchema = z.object({
  knowledgeId: z.string().uuid(),
  agentId: z.string().optional(),
  taskId: z.string().optional(),
  /** Owner sub for private (per-user) knowledge; undefined = shared (general swarm or bot). */
  ownerSub: z.string().optional(),
  collection: z.string(),
  title: z.string(),
  source: z.string(),
  format: z.string().optional(),
  chunkCount: z.number().int().nonnegative().optional().default(0),
  documentCount: z.number().int().nonnegative().optional().default(0),
  embeddingProviderId: z.string().optional(),
  embeddingModelId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/**
 * @description Knowledge-memory document metadata.
 */
export type KnowledgeMemoryDocument = z.infer<typeof KnowledgeMemoryDocumentSchema>;

/**
 * @description Input for recording one knowledge-memory document.
 */
export const RecordKnowledgeMemoryInputSchema = z.object({
  agentId: z.string().optional(),
  taskId: z.string().optional(),
  /** Owner sub to scope this document to one user; omit for shared (swarm/bot) knowledge. */
  ownerSub: z.string().optional(),
  collection: z.string().optional().default('default'),
  title: z.string(),
  source: z.string(),
  format: z.string().optional(),
  chunkCount: z.number().int().nonnegative().optional().default(0),
  documentCount: z.number().int().nonnegative().optional().default(0),
  embeddingProviderId: z.string().optional(),
  embeddingModelId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

/**
 * @description Knowledge-memory write payload.
 */
export type RecordKnowledgeMemoryInput = z.infer<typeof RecordKnowledgeMemoryInputSchema>;
