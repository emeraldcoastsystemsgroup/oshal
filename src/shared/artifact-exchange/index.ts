/**
 * Artifact exchange — barrel (ADR-139 Stage 1).
 *
 * The swarm-wide "Send to…" spine: declaration types + the fail-closed manifest validator
 * (read by the swarm-app loader), the in-memory action registry (written on app activate,
 * read by the menu route), and the owner-bound short-TTL handle store (the only thing that
 * ever crosses an app boundary — a locator, never bytes).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel.
 *
 * @module shared/artifact-exchange
 */

export {
  ARTIFACT_ACTION_MODES,
  isValidArtifactTypeGlob,
  matchesArtifactType,
  validateArtifactActionsDeclaration,
} from './types';
export type {
  ArtifactActionMode,
  ArtifactAcceptDeclaration,
  ArtifactProvideDeclaration,
  ArtifactActionsDeclaration,
} from './types';
export {
  registerAppArtifactActions,
  unregisterAppArtifactActions,
  artifactActionsForType,
  registeredArtifactActionApps,
} from './registry';
export type { ArtifactMenuAction } from './registry';
export {
  mintArtifactHandle,
  resolveArtifactHandle,
  artifactSourcePathError,
  artifactHandleCount,
} from './handles';
export type { ArtifactHandleRecord } from './handles';
