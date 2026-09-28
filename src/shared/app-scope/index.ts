/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - typed runtime view of the shared CLI/runtime app-scope contract (scripts/oshal-app-scope.js), so readManifest refuses the same unknown `scope:` that `oshal-app validate` refuses, before the loader writes swarm_applications (whose CHECK would otherwise refuse it mid-install).
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const contract = createRequire(__filename)(resolve(__dirname, '../../../scripts/oshal-app-scope.js')) as {
  APP_SCOPES: readonly string[];
  UNKNOWN_APP_SCOPE: string;
  isAppScope(value: unknown): boolean;
  validateAppScope(manifest: unknown): string | undefined;
};

/** The app visibility scopes swarm_applications.scope accepts (migration 064's CHECK). */
export const APP_SCOPES: readonly string[] = contract.APP_SCOPES;
/** The error code a refused scope carries. */
export const UNKNOWN_APP_SCOPE: string = contract.UNKNOWN_APP_SCOPE;

/**
 * @description Whether a value is one of the known app scopes.
 * @param value A declared scope.
 * @returns True only for an exact member of APP_SCOPES.
 */
export function isAppScope(value: unknown): boolean {
  return contract.isAppScope(value);
}

/**
 * @description Refuse a manifest whose declared `scope:` is outside the vocabulary; an absent scope is allowed.
 * @param manifest A parsed oshal-app.yaml.
 * @returns The declared scope, or undefined when none is declared. Throws with code unknown_app_scope otherwise.
 */
export function validateAppScope(manifest: unknown): string | undefined {
  return contract.validateAppScope(manifest);
}
