/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Barrel export for RAG feature module
 */

export { RagService, type RagSearchResult, type RagIngestResult } from './services/rag-service';
export { chunkText, type ChunkerConfig } from './services/chunker';
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
