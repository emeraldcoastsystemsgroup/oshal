/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Extract the stateless artifact registration primitive to keep lifecycle orchestration within its module size limit.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | retractArtifactActions: the deactivate-time retraction moves here beside applyArtifactActions (same non-fatal ERROR log and message), keeping swarm-app-service.ts inside its 1000 code-line cap after the bot-persona hooks landed.
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

/**
 * @description Retract a toggled-off app's "Send to..." artifact actions: a deactivated app must hold
 * zero live menu entries. Idempotent and non-fatal, like the other deactivate-time retractions.
 * @param app - The application being deactivated.
 * @returns Nothing; a registry failure is logged at ERROR and swallowed so deactivation continues.
 */
export function retractArtifactActions(app: string): void {
  try {
    unregisterAppArtifactActions(app);
  } catch (err) {
    logger.error({ err, app }, 'Artifact-action deregistration failed (non-fatal)');
  }
}
