/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Define the kernel-owned RAG namespace guard shared by generic API, tool, and package teardown boundaries.
 */

/** Collections whose lifecycle is owned by kernel services, never arbitrary tools/packages. */
export const KERNEL_RESERVED_RAG_COLLECTIONS = Object.freeze([
  'swarm-memory',
  'swarm-tickets',
  'swarm-messages',
  'swarm-knowledge',
] as const);

const RESERVED_COLLECTION_SET = new Set<string>(KERNEL_RESERVED_RAG_COLLECTIONS);

/** Stable failure raised when a generic boundary targets kernel-owned RAG state. */
export class ReservedRagCollectionError extends Error {
  /** Machine-readable error code for route/tool adapters. */
  readonly code = 'RESERVED_RAG_COLLECTION';

  /** @param collection Kernel-owned collection that was refused. */
  constructor(collection: string) {
    super(`RAG collection is reserved for kernel-owned lifecycle: ${collection}`);
    this.name = 'ReservedRagCollectionError';
  }
}

/**
 * @description Tests the exact canonical collection name. Collection identifiers are storage
 * keys, so aliases/case folding must never redirect one namespace into another.
 * @param collection Candidate collection identifier.
 * @returns True only for an exact kernel-owned namespace.
 */
export function isKernelReservedRagCollection(collection: unknown): boolean {
  return typeof collection === 'string' && RESERVED_COLLECTION_SET.has(collection);
}

/**
 * @description Fails closed at generic ingest/delete boundaries. Kernel services use their
 * dedicated direct API; authenticated operators may be admitted explicitly by the route layer.
 * @param collection Candidate collection identifier.
 * @throws ReservedRagCollectionError when the name is kernel-owned.
 */
export function assertGenericRagCollection(collection: string): void {
  if (isKernelReservedRagCollection(collection)) throw new ReservedRagCollectionError(collection);
}
