/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Barrel export for RAG feature module
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export the common kernel-reserved collection policy for generic write/delete boundaries.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Export the pgvector engine singleton and the local embedder for the ADR-100 semantic projection (barrel, not deep import).
 */

export { RagService, type RagSearchResult, type RagIngestResult } from './services/rag-service';
export { chunkText, type ChunkerConfig } from './services/chunker';
export {
  KERNEL_RESERVED_RAG_COLLECTIONS,
  ReservedRagCollectionError,
  assertGenericRagCollection,
  isKernelReservedRagCollection,
} from './services/reserved-rag-collections';
export {
  applyRagPermission,
  canReadRagMetadata,
  filterRagHitsByPermission,
  permissionBasisForRagMetadata,
  type PermissionedRagHit,
  type RagPermissionBasis,
  type RagPermissionContext,
  type RagPermissionMetadata,
} from './services/permission-filter';
export {
  driveFileToSourceAcl,
  slackChannelToSourceAcl,
  githubRepoToSourceAcl,
  sourceAclToRagAcl,
  serializeSourceAcl,
  sourceAclGroupsForCaller,
  PUBLIC_ANYONE_GROUP,
  DOMAIN_GROUP_PREFIX,
  SOURCE_GROUP_PREFIX,
  type RagSourceAcl,
  type DriveFileAcl,
  type DrivePermission,
  type SlackChannelAcl,
  type GithubRepoAcl,
  type SourceAclProvider,
} from './services/source-acl-mapper';

// ADR-100 Phase 3: the person-model slice writes deterministic `pm:<segment_id>` chunks and embeds them
// with the shared MiniLM — exported here so it never deep-imports the engine.
export { PgvectorRagEngine, pgvectorRagEngine } from './services/pgvector-rag-engine';
export { localEmbeddings } from './services/local-embedding-service';
