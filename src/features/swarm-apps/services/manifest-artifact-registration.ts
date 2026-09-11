/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Extract the stateless artifact registration primitive to keep lifecycle orchestration within its module size limit.
 */
import { createChildLogger } from '@/shared/logger';
import { registerAppArtifactActions, unregisterAppArtifactActions } from '@/shared/artifact-exchange';
import type { SwarmApplicationRecord } from '../types';

const logger = createChildLogger({ module: 'swarm-app-service' });

/** @description Replace an activated app's artifact declarations, retracting absent declarations on reload. */
export function applyArtifactActions(record: SwarmApplicationRecord): void {
  const decl = record.manifest.artifacts;
  const empty = !decl || ((decl.accepts?.length ?? 0) === 0 && (decl.provides?.length ?? 0) === 0);
  if (empty) {
    unregisterAppArtifactActions(record.name);
    return;
  }
  try {
    registerAppArtifactActions(record.name, decl);
  } catch (err) {
    logger.error({ err, app: record.name }, 'Artifact-action registration failed (non-fatal)');
  }
}
