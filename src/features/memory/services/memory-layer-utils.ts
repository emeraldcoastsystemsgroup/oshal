/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted non-swarm memory-layer row mapping and snapshot helper functions from the service implementation
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added owner_sub to the knowledge row/document mapping plus classifyKnowledgeScope + knowledgeDocumentVisible (pure permission predicate) and the KnowledgeListOptions/permission-scope types shared by the service and the RAG visibility surface
 */

import { randomUUID } from 'node:crypto';
import { createChildLogger } from '@/shared/logger';
import type {
  AgentMemoryRecord,
  CreateCheckpointInput,
  KnowledgeMemoryDocument,
  RecordKnowledgeMemoryInput,
  StoredMessage,
  StoredTask,
  TaskCheckpoint,
  UpsertAgentMemoryInput,
} from '@/shared/types';

const logger = createChildLogger({ module: 'memory-layer-utils' });

/**
 * @description Raw persistence-layer shape of a task checkpoint as stored in the
 * database, where JSON columns may arrive either pre-parsed or as serialized
 * strings; consumed by mapCheckpointRow to produce a normalized TaskCheckpoint.
 */
export interface TaskCheckpointRow {
  checkpoint_id: string;
  task_id: string;
  agent_id: string | null;
  label: string | null;
  summary: string | null;
  trigger: 'auto' | 'manual' | 'restore';
  message_count: number;
  task_snapshot: Record<string, unknown> | string;
  messages_snapshot: unknown[] | string;
  metadata: Record<string, unknown> | string;
  created_at: string | Date;
}

/**
 * @description Raw persistence-layer shape of an agent memory record, with array
 * and JSON columns that may be either pre-parsed or serialized strings; consumed
 * by mapAgentMemoryRow to produce a normalized AgentMemoryRecord.
 */
export interface AgentMemoryRow {
  memory_id: string;
  agent_id: string;
  task_id: string;
  title: string;
  summary: string;
  last_user_message: string | null;
  last_assistant_message: string | null;
  tool_names: string[] | string;
  keywords: string[] | string;
  message_count: number;
  turn_count: number;
  total_tokens: number;
  total_cost: number;
  cost_currency: string | null;
  source: 'task_result' | 'checkpoint' | 'manual';
  metadata: Record<string, unknown> | string;
  created_at: string | Date;
  updated_at: string | Date;
}

/**
 * @description Raw persistence-layer shape of a knowledge memory document, whose
 * metadata column may be pre-parsed or a serialized string; consumed by
 * mapKnowledgeMemoryRow to produce a normalized KnowledgeMemoryDocument.
 */
export interface KnowledgeMemoryRow {
  knowledge_id: string;
  agent_id: string | null;
  task_id: string | null;
  collection_name: string;
  title: string;
  source: string;
  format: string | null;
  chunk_count: number;
  document_count: number;
  embedding_provider_id: string | null;
  embedding_model_id: string | null;
  owner_sub: string | null;
  metadata: Record<string, unknown> | string;
  created_at: string | Date;
  updated_at: string | Date;
}

/**
 * @description Optional descriptors of a completed task's outcome, supplied when
 * deriving checkpoint and agent-memory records so the caller can attribute the
 * agent, assistant response, tools used, and how the snapshot was triggered.
 */
export interface TaskOutcomeInput {
  agentId?: string;
  assistantResponse?: string;
  toolsUsed?: string[];
  completionType?: string;
  checkpointTrigger?: 'auto' | 'manual' | 'restore';
  source?: 'task_result' | 'checkpoint' | 'manual';
}

/**
 * @description Assembles a new TaskCheckpoint by deep-cloning the task and its
 * messages so the snapshot is isolated from later mutations, generating a fresh
 * checkpoint id, and applying caller-provided label/summary/trigger/metadata.
 * @param task The task whose state is being captured.
 * @param messages The conversation messages to snapshot.
 * @param input Optional checkpoint overrides (label, summary, trigger, metadata).
 * @returns A fully populated TaskCheckpoint snapshot.
 */
export function buildCheckpoint(
  task: StoredTask,
  messages: StoredMessage[],
  input: Partial<CreateCheckpointInput>,
): TaskCheckpoint {
  return {
    checkpointId: randomUUID(),
    taskId: task.taskId,
    agentId: task.agentId,
    label: input.label?.trim() || undefined,
    summary: input.summary?.trim() || undefined,
    trigger: input.trigger || 'manual',
    messageCount: messages.length,
    taskSnapshot: cloneTask(task),
    messagesSnapshot: messages.map(cloneMessage),
    metadata: { ...(input.metadata || {}) },
    createdAt: new Date().toISOString(),
  };
}

/**
 * @description Derives a human-readable checkpoint label from the task title (or
 * a task-id fallback) and a suffix that reflects whether the task is awaiting
 * input or is a routine snapshot.
 * @param task The task to label.
 * @param completionType Completion state; 'waiting_for_input' yields an "awaiting input" suffix.
 * @returns A formatted label string.
 */
export function buildCheckpointLabel(task: StoredTask, completionType?: string): string {
  const prefix = task.title?.trim() || `Task ${task.taskId}`;
  const suffix = completionType === 'waiting_for_input' ? 'awaiting input' : 'snapshot';
  return `${prefix} · ${suffix}`;
}

/**
 * @description Produces a short checkpoint summary, preferring an explicit
 * assistant response and otherwise falling back to the most recent assistant
 * message (or a default), truncated to a fixed length for compact storage.
 * @param messages The conversation messages to scan for a fallback summary.
 * @param assistantResponse Optional explicit response text to prefer.
 * @returns A summary string capped at 240 characters.
 */
export function summarizeCheckpoint(messages: StoredMessage[], assistantResponse?: string): string {
  const response = assistantResponse?.trim();
  if (response) {
    return response.slice(0, 240);
  }
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
  return (lastAssistant?.text || 'Checkpoint snapshot').slice(0, 240);
}

/**
 * @description Distills a completed task and its conversation into an upsert
 * payload for agent memory, extracting the last user/assistant messages,
 * deriving a title and keywords, carrying forward usage metrics, and truncating
 * free-text fields to bounded lengths.
 * @param task The task whose outcome is being recorded.
 * @param messages The conversation messages to mine for user/assistant text.
 * @param agentId The agent the memory belongs to.
 * @param input Outcome descriptors (assistant response, tools used, source, etc.).
 * @returns An UpsertAgentMemoryInput ready to persist.
 */
export function buildAgentMemoryInput(
  task: StoredTask,
  messages: StoredMessage[],
  agentId: string,
  input: TaskOutcomeInput,
): UpsertAgentMemoryInput {
  const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user')?.text;
  const lastAssistantMessage = input.assistantResponse?.trim()
    || [...messages].reverse().find((message) => message.role === 'assistant')?.text
    || '';
  return {
    agentId,
    taskId: task.taskId,
    title: buildMemoryTitle(task, lastUserMessage),
    summary: lastAssistantMessage.slice(0, 4000),
    lastUserMessage: lastUserMessage?.slice(0, 2000),
    lastAssistantMessage: lastAssistantMessage.slice(0, 4000),
    toolNames: uniqueStrings(input.toolsUsed || []),
    keywords: buildKeywords(task, input.toolsUsed || [], lastUserMessage),
    messageCount: task.messageCount,
    turnCount: task.turnCount,
    totalTokens: task.totalTokens,
    totalCost: task.totalCost,
    costCurrency: task.costCurrency || 'USD',
    source: input.source || 'task_result',
    metadata: {
      providerId: task.providerId || '',
      completionType: input.completionType || 'natural',
      latestCheckpointTrigger: input.checkpointTrigger || 'auto',
    },
  };
}

/**
 * @description Reconstructs a live task from a checkpoint's snapshot, cloning it,
 * forcing the status back to active, refreshing timestamps and message count, and
 * stamping metadata to record which checkpoint it was restored from and when.
 * @param checkpoint The checkpoint to restore the task from.
 * @returns A StoredTask rehydrated and marked as restored.
 */
export function buildRestoredTask(checkpoint: TaskCheckpoint): StoredTask {
  const now = new Date().toISOString();
  return {
    ...cloneTask(checkpoint.taskSnapshot),
    status: 'active',
    updatedAt: now,
    messageCount: checkpoint.messagesSnapshot.length,
    metadata: {
      ...(checkpoint.taskSnapshot.metadata || {}),
      restoredFromCheckpointId: checkpoint.checkpointId,
      restoredAt: now,
    },
  };
}

/**
 * @description Builds a persisted AgentMemoryRecord from an upsert input,
 * preserving the existing record's id and creation time on update (or minting
 * new ones on insert), de-duplicating tool/keyword lists, and applying numeric
 * and currency defaults.
 * @param input The upsert payload to materialize.
 * @param existing Optional existing record identifiers reused on update.
 * @returns A complete AgentMemoryRecord with refreshed updatedAt.
 */
export function buildAgentMemoryRecord(
  input: UpsertAgentMemoryInput,
  existing?: Pick<AgentMemoryRecord, 'memoryId' | 'createdAt'>,
): AgentMemoryRecord {
  const now = new Date().toISOString();
  return {
    memoryId: existing?.memoryId || randomUUID(),
    agentId: input.agentId,
    taskId: input.taskId,
    title: input.title,
    summary: input.summary,
    lastUserMessage: input.lastUserMessage,
    lastAssistantMessage: input.lastAssistantMessage,
    toolNames: uniqueStrings(input.toolNames || []),
    keywords: uniqueStrings(input.keywords || []),
    messageCount: input.messageCount || 0,
    turnCount: input.turnCount || 0,
    totalTokens: input.totalTokens || 0,
    totalCost: input.totalCost || 0,
    costCurrency: input.costCurrency || 'USD',
    source: input.source || 'task_result',
    metadata: { ...(input.metadata || {}) },
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

/**
 * @description Materializes a KnowledgeMemoryDocument from a record-knowledge
 * input, minting a fresh id, defaulting the collection and count fields, copying
 * metadata, and stamping creation/update timestamps.
 * @param input The knowledge-recording payload.
 * @returns A complete KnowledgeMemoryDocument ready to persist.
 */
export function buildKnowledgeMemoryDocument(input: RecordKnowledgeMemoryInput): KnowledgeMemoryDocument {
  const now = new Date().toISOString();
  return {
    knowledgeId: randomUUID(),
    agentId: input.agentId,
    taskId: input.taskId,
    ownerSub: input.ownerSub,
    collection: input.collection || 'default',
    title: input.title,
    source: input.source,
    format: input.format,
    chunkCount: input.chunkCount || 0,
    documentCount: input.documentCount || 0,
    embeddingProviderId: input.embeddingProviderId,
    embeddingModelId: input.embeddingModelId,
    metadata: { ...(input.metadata || {}) },
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * @description Converts a raw checkpoint database row into a domain TaskCheckpoint,
 * normalizing nullable columns to undefined, parsing snapshot/metadata JSON, and
 * coercing counts and timestamps into canonical forms.
 * @param row The raw checkpoint row from the database.
 * @returns A normalized TaskCheckpoint.
 */
export function mapCheckpointRow(row: TaskCheckpointRow): TaskCheckpoint {
  return {
    checkpointId: row.checkpoint_id,
    taskId: row.task_id,
    agentId: row.agent_id || undefined,
    label: row.label || undefined,
    summary: row.summary || undefined,
    trigger: row.trigger,
    messageCount: normalizeCount(row.message_count),
    taskSnapshot: parseJsonObject<StoredTask>(row.task_snapshot, {} as StoredTask),
    messagesSnapshot: parseJsonArray<StoredMessage>(row.messages_snapshot),
    metadata: parseJsonObject<Record<string, unknown>>(row.metadata, {}),
    createdAt: toIsoString(row.created_at),
  };
}

/**
 * @description Converts a raw agent-memory database row into a domain
 * AgentMemoryRecord, normalizing nullable text to undefined, parsing array/JSON
 * columns, coercing counts and floats, and defaulting the currency.
 * @param row The raw agent-memory row from the database.
 * @returns A normalized AgentMemoryRecord.
 */
export function mapAgentMemoryRow(row: AgentMemoryRow): AgentMemoryRecord {
  return {
    memoryId: row.memory_id,
    agentId: row.agent_id,
    taskId: row.task_id,
    title: row.title,
    summary: row.summary,
    lastUserMessage: row.last_user_message || undefined,
    lastAssistantMessage: row.last_assistant_message || undefined,
    toolNames: parseStringArray(row.tool_names),
    keywords: parseStringArray(row.keywords),
    messageCount: normalizeCount(row.message_count),
    turnCount: normalizeCount(row.turn_count),
    totalTokens: normalizeCount(row.total_tokens),
    totalCost: normalizeFloat(row.total_cost),
    costCurrency: row.cost_currency || 'USD',
    source: row.source,
    metadata: parseJsonObject<Record<string, unknown>>(row.metadata, {}),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

/**
 * @description Converts a raw knowledge-memory database row into a domain
 * KnowledgeMemoryDocument, normalizing nullable columns to undefined, parsing
 * metadata JSON, and coercing counts and timestamps.
 * @param row The raw knowledge-memory row from the database.
 * @returns A normalized KnowledgeMemoryDocument.
 */
export function mapKnowledgeMemoryRow(row: KnowledgeMemoryRow): KnowledgeMemoryDocument {
  return {
    knowledgeId: row.knowledge_id,
    agentId: row.agent_id || undefined,
    taskId: row.task_id || undefined,
    ownerSub: row.owner_sub || undefined,
    collection: row.collection_name,
    title: row.title,
    source: row.source,
    format: row.format || undefined,
    chunkCount: normalizeCount(row.chunk_count),
    documentCount: normalizeCount(row.document_count),
    embeddingProviderId: row.embedding_provider_id || undefined,
    embeddingModelId: row.embedding_model_id || undefined,
    metadata: parseJsonObject<Record<string, unknown>>(row.metadata, {}),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

/**
 * @description The permission scope a knowledge listing is evaluated against: the caller's sub and
 * whether they are an operator. Operators bypass the owner filter; everyone else sees shared docs
 * plus their own private ones.
 */
export interface KnowledgePermissionScope {
  callerSub: string;
  isOperator: boolean;
}

/**
 * @description Filter/scope options for listing knowledge-memory documents.
 */
export interface KnowledgeListOptions {
  collection?: string;
  agentId?: string;
  limit?: number;
  visibleTo?: KnowledgePermissionScope;
}

/**
 * @description A knowledge document's sharing scope: `private` (owner-scoped, one user), `bot`
 * (tied to one swarm member's collection, shared across that swarm's users), or `swarm` (general
 * shared knowledge every bot can retrieve).
 */
export type KnowledgeScope = 'private' | 'bot' | 'swarm';

/**
 * @description Classify one knowledge document's sharing scope from its owner/agent attribution.
 * An owner makes it private; otherwise an agent makes it bot-scoped; otherwise it is general swarm
 * knowledge. Pure and testable.
 *
 * @param doc - Document owner/agent attribution.
 * @returns The sharing scope label.
 */
export function classifyKnowledgeScope(doc: Pick<KnowledgeMemoryDocument, 'ownerSub' | 'agentId'>): KnowledgeScope {
  if (doc.ownerSub) {
    return 'private';
  }
  if (doc.agentId) {
    return 'bot';
  }
  return 'swarm';
}

/**
 * @description Whether a caller may see one knowledge document under the given listing options.
 * Applies the agent filter and the permission scope (non-operators see shared docs plus their own
 * private docs; operators see everything). Collection filtering is handled by the caller before
 * this predicate. Pure and testable — the in-memory listing path and the guard spec share it.
 *
 * @param doc - The candidate knowledge document.
 * @param options - Active listing filters and permission scope.
 * @returns True when the document is visible to the caller.
 */
export function knowledgeDocumentVisible(doc: KnowledgeMemoryDocument, options: KnowledgeListOptions): boolean {
  if (typeof options.agentId === 'string' && options.agentId.length > 0 && doc.agentId !== options.agentId) {
    return false;
  }
  const scope = options.visibleTo;
  if (!scope || scope.isOperator) {
    return true;
  }
  return !doc.ownerSub || doc.ownerSub === scope.callerSub;
}

/**
 * @description Produces a shallow copy of a task with its usageByModel and
 * metadata objects cloned, so callers can mutate the result without affecting the
 * original task's nested state.
 * @param task The task to clone.
 * @returns A copy with independent usageByModel and metadata maps.
 */
export function cloneTask(task: StoredTask): StoredTask {
  return {
    ...task,
    usageByModel: { ...(task.usageByModel || {}) },
    metadata: { ...(task.metadata || {}) },
  };
}

/**
 * @description Produces a shallow copy of a message with its contentBlocks array
 * and metadata object cloned, isolating the copy from mutations to the original's
 * nested structures.
 * @param message The message to clone.
 * @returns A copy with independent contentBlocks and metadata.
 */
export function cloneMessage(message: StoredMessage): StoredMessage {
  return {
    ...message,
    contentBlocks: [...message.contentBlocks],
    metadata: { ...(message.metadata || {}) },
  };
}

/**
 * @description Appends a value to the list stored under a key in an in-memory
 * multi-map index, creating the list on first use; used to maintain secondary
 * lookup indexes for memory records.
 * @param index The map from key to list of values to mutate.
 * @param key The index key to append under.
 * @param value The value to append.
 */
export function addToIndex(index: Map<string, string[]>, key: string, value: string): void {
  const existing = index.get(key) || [];
  existing.push(value);
  index.set(key, existing);
}

/**
 * @description Removes a value from the list under a key in an in-memory
 * multi-map index, deleting the key entirely when its list becomes empty to keep
 * the index free of stale empty entries.
 * @param index The map from key to list of values to mutate.
 * @param key The index key to remove from.
 * @param value The value to remove.
 */
export function removeFromIndex(index: Map<string, string[]>, key: string, value: string): void {
  const existing = index.get(key) || [];
  const next = existing.filter((entry) => entry !== value);
  if (next.length === 0) {
    index.delete(key);
    return;
  }
  index.set(key, next);
}

/**
 * @description Resolves the knowledge documents belonging to a collection by
 * looking up their ids in the index, returning them in reverse (most-recent-first)
 * order and dropping any ids whose documents are missing.
 * @param index The map from collection name to ordered knowledge ids.
 * @param documents The map from knowledge id to document.
 * @param collection The collection name to gather documents for.
 * @returns The matching documents, newest first, with missing ones filtered out.
 */
export function collectKnowledgeByCollection(
  index: Map<string, string[]>,
  documents: Map<string, KnowledgeMemoryDocument>,
  collection: string,
): KnowledgeMemoryDocument[] {
  const ids = [...(index.get(collection) || [])].reverse();
  return ids
    .map((knowledgeId) => documents.get(knowledgeId))
    .filter((document): document is KnowledgeMemoryDocument => Boolean(document));
}

/**
 * @description Caps an array to a sanitized positive limit, returning the array
 * unchanged when the limit is absent or non-positive; used to bound query result
 * sizes consistently across memory lookups.
 * @param rows The array to potentially truncate.
 * @param limit Optional maximum number of items to keep.
 * @returns The original array or a truncated prefix of it.
 */
export function applyLimit<T>(rows: T[], limit?: number): T[] {
  const normalized = normalizeLimit(limit);
  return normalized ? rows.slice(0, normalized) : rows;
}

/**
 * @description Sanitizes a requested limit into a non-negative integer, returning
 * 0 (meaning "no limit") for non-numeric, non-finite, or non-positive inputs so
 * downstream code can treat 0 as unbounded.
 * @param limit The raw limit value to normalize.
 * @returns A positive integer limit, or 0 when no valid limit was given.
 */
export function normalizeLimit(limit?: number): number {
  if (typeof limit !== 'number') {
    return 0;
  }
  const parsed = Number.parseInt(String(limit), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function buildMemoryTitle(task: StoredTask, lastUserMessage?: string): string {
  const explicitTitle = task.title?.trim();
  if (explicitTitle) {
    return explicitTitle.slice(0, 160);
  }
  return (lastUserMessage?.trim() || `Task ${task.taskId}`).slice(0, 160);
}

function buildKeywords(task: StoredTask, toolsUsed: string[], lastUserMessage?: string): string[] {
  const source = `${lastUserMessage || ''} ${task.providerId || ''}`.toLowerCase();
  const extracted = source
    .split(/[^a-z0-9_-]+/)
    .filter((part) => part.length >= 4)
    .slice(0, 8);
  return uniqueStrings([...toolsUsed, ...extracted]).slice(0, 16);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

function normalizeCount(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? 0), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeFloat(value: unknown): number {
  const parsed = Number.parseFloat(String(value ?? 0));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseJsonObject<T>(value: unknown, fallback: T): T {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as T;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as T;
      }
    } catch (error) {
      logger.error({ err: error }, 'Failed to parse JSON object for memory layer row');
    }
  }
  return fallback;
}

function parseJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed as T[];
      }
    } catch (error) {
      logger.error({ err: error }, 'Failed to parse JSON array for memory layer row');
    }
  }
  return [];
}

function parseStringArray(value: string[] | string): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  }
  return [];
}

function toIsoString(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}
