/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added canonical ticket-project metadata helpers so default-project assignment and root-ticket project moves share one contract
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | project IS a queue: renamed canonical concept project->queue. Dual-read alias (reads queueId ?? projectId) + writes queue* keys only; legacy project-named exports kept as deprecated aliases so existing callers compile during the migration.
 */

import { z } from 'zod';

/**
 * @description Canonical default queue identifier for new root tickets.
 * The shared "Default" bucket — tickets land here only when no real queue
 * (application) can be derived. Reclassification moves work out of it.
 */
export const DEFAULT_QUEUE_ID = 'default';

/**
 * @description Canonical default queue display name for new root tickets.
 */
export const DEFAULT_QUEUE_NAME = 'Default';

/** @deprecated Use {@link DEFAULT_QUEUE_ID}. Kept as an alias during the project->queue migration. */
export const DEFAULT_PROJECT_ID = DEFAULT_QUEUE_ID;
/** @deprecated Use {@link DEFAULT_QUEUE_NAME}. Kept as an alias during the project->queue migration. */
export const DEFAULT_PROJECT_NAME = DEFAULT_QUEUE_NAME;

/**
 * @description Input schema for assigning or moving a ticket tree to a queue bucket.
 * Accepts both the canonical `queue*` keys and the legacy `project*` keys on input
 * so callers and persisted metadata mid-migration both resolve correctly (dual-read).
 */
export const TicketQueueAssignmentInputSchema = z.object({
  queueId: z.string().trim().min(1).optional(),
  queueName: z.string().trim().min(1).optional(),
  queueIdentifier: z.string().trim().min(1).optional(),
  workspaceSlug: z.string().trim().min(1).optional(),
  // Legacy aliases accepted on input (dual-read) — never written back out.
  projectId: z.string().trim().min(1).optional(),
  projectName: z.string().trim().min(1).optional(),
  projectIdentifier: z.string().trim().min(1).optional(),
});

/**
 * @description Input payload for assigning or moving a ticket tree to a queue bucket.
 */
export type TicketQueueAssignmentInput = z.infer<typeof TicketQueueAssignmentInputSchema>;

/** @deprecated Use {@link TicketQueueAssignmentInputSchema}. */
export const TicketProjectAssignmentInputSchema = TicketQueueAssignmentInputSchema;
/** @deprecated Use {@link TicketQueueAssignmentInput}. */
export type TicketProjectAssignmentInput = TicketQueueAssignmentInput;

/**
 * @description Resolved canonical queue metadata stored on tickets and linked tasks.
 * Carries both the canonical `queue*` fields and the legacy `project*` aliases
 * (same values) so existing readers compile while call sites migrate.
 */
export interface CanonicalTicketQueue {
  /** Queue display name (canonical). */
  queue: string;
  queueName: string;
  queueId: string;
  queueIdentifier: string;
  workspaceSlug: string;
  /** @deprecated alias of {@link queue}. */
  project: string;
  /** @deprecated alias of {@link queueName}. */
  projectName: string;
  /** @deprecated alias of {@link queueId}. */
  projectId: string;
  /** @deprecated alias of {@link queueIdentifier}. */
  projectIdentifier: string;
}

/** @deprecated Use {@link CanonicalTicketQueue}. */
export type CanonicalTicketProject = CanonicalTicketQueue;

/**
 * @description Resolves canonical queue metadata, falling back to the shared `Default`
 * queue when values are missing. Dual-reads `queue*` first, then the legacy `project*`
 * keys, so tickets written under either scheme resolve identically.
 * @param input - Optional raw assignment input or persisted metadata.
 * @returns Canonical queue metadata (with legacy project aliases populated).
 */
export function resolveCanonicalTicketQueue(
  input?: TicketQueueAssignmentInput | Record<string, unknown> | null,
): CanonicalTicketQueue {
  const source = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const rawName =
    readNonEmptyString(source.queueName) ||
    readNonEmptyString(source.queue) ||
    readNonEmptyString(source.projectName) ||
    readNonEmptyString(source.project) ||
    DEFAULT_QUEUE_NAME;
  const queueName = normalizeQueueName(rawName);
  const queueId = normalizeQueueId(
    readNonEmptyString(source.queueId) || readNonEmptyString(source.projectId) || queueName,
  );
  const queueIdentifier =
    readNonEmptyString(source.queueIdentifier) ||
    readNonEmptyString(source.projectIdentifier) ||
    buildQueueIdentifier(queueName);
  const workspaceSlug = normalizeQueueId(readNonEmptyString(source.workspaceSlug) || queueId);

  return {
    queue: queueName,
    queueName,
    queueId,
    queueIdentifier,
    workspaceSlug,
    // Legacy aliases — same values, kept so existing `.project*` readers compile.
    project: queueName,
    projectName: queueName,
    projectId: queueId,
    projectIdentifier: queueIdentifier,
  };
}

/** @deprecated Use {@link resolveCanonicalTicketQueue}. */
export const resolveCanonicalTicketProject = resolveCanonicalTicketQueue;

/**
 * @description Merges canonical queue metadata into a metadata record without
 * discarding unrelated fields. Writes only the canonical `queue*` keys (the legacy
 * `project*` keys are intentionally not written; readers dual-read them).
 * @param metadata - Existing metadata object.
 * @param input - Raw queue assignment input.
 * @returns Metadata object with canonical queue fields applied.
 */
export function mergeTicketQueueMetadata(
  metadata: Record<string, unknown> | null | undefined,
  input?: TicketQueueAssignmentInput | Record<string, unknown> | null,
): Record<string, unknown> {
  const queue = resolveCanonicalTicketQueue(input);
  return {
    ...(metadata && typeof metadata === 'object' ? metadata : {}),
    queue: queue.queue,
    queueName: queue.queueName,
    queueId: queue.queueId,
    queueIdentifier: queue.queueIdentifier,
    workspaceSlug: queue.workspaceSlug,
  };
}

/** @deprecated Use {@link mergeTicketQueueMetadata}. Now writes canonical `queue*` keys. */
export const mergeTicketProjectMetadata = mergeTicketQueueMetadata;

/**
 * @description Reads canonical queue metadata from an existing ticket/task metadata payload.
 * @param metadata - Existing metadata object.
 * @returns Canonical queue metadata.
 */
export function readCanonicalTicketQueue(
  metadata: Record<string, unknown> | null | undefined,
): CanonicalTicketQueue {
  return resolveCanonicalTicketQueue(metadata || {});
}

/** @deprecated Use {@link readCanonicalTicketQueue}. */
export const readCanonicalTicketProject = readCanonicalTicketQueue;

function readNonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function normalizeQueueName(value: string): string {
  return readNonEmptyString(value) || DEFAULT_QUEUE_NAME;
}

function normalizeQueueId(value: string): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || DEFAULT_QUEUE_ID;
}

function buildQueueIdentifier(queueName: string): string {
  const words = queueName.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const identifier = words.slice(0, 3).map((word) => word[0]?.toUpperCase() || '').join('');
  return identifier || DEFAULT_QUEUE_ID.toUpperCase();
}
