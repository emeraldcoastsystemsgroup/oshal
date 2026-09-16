/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | New. The no-fix control for the in-image case. Dockerfile.oshal copies src/features/ into the image, so once this fix is deployed the image's OWN local-embedding-service calls the strip — and a control that relied on "the image predates the fix" would go permanently red on the first deploy, which is a guard that expires. Mounting this over the guards module instead gives the control a real unfixed runtime at any image age: the same three exports, a strip that removes nothing and reports nothing removed. The defect then reproduces from the runtime itself rather than from the absence of a file.
 */

/** Mirrors ProcessGuardSnapshot without importing it — this file stands alone in the image. */
export type ProcessGuardSnapshot = Record<'unhandledRejection' | 'uncaughtException', Function[]>;

/** Mirrors StripResult. */
export interface StripResult {
  removed: Record<'unhandledRejection' | 'uncaughtException', number>;
  kept: Record<'unhandledRejection' | 'uncaughtException', number>;
}

/**
 * @description The real classifier's signature, always false — nothing is rethrow-shaped
 * as far as this control is concerned.
 * @returns False.
 */
export function isRethrowListener(): boolean {
  return false;
}

/**
 * @description Snapshots nothing. The control never compares against it.
 * @returns Empty listener lists.
 */
export function snapshotProcessGuards(): ProcessGuardSnapshot {
  return { unhandledRejection: [], uncaughtException: [] };
}

/**
 * @description Removes nothing, so the ONNX runtime's rethrow pair survives the load
 * and the stray rejection is fatal — the defect this fix exists to close.
 * @returns Zero counts.
 */
export function stripRethrowGuards(): StripResult {
  return {
    removed: { unhandledRejection: 0, uncaughtException: 0 },
    kept: { unhandledRejection: 0, uncaughtException: 0 },
  };
}
