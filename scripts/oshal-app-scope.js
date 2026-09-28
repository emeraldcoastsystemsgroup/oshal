/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the one app-scope vocabulary that `oshal-app validate` (scripts/oshal-app.js) and the runtime loader (readManifest, through src/shared/app-scope) both apply. A manifest's `scope:` is written into swarm_applications.scope, which a database CHECK (migration 064) limits to person, tenant, public and operator; nothing checked the value before that write, so dev-workspace-index 0.2.0 (`scope: deployment`) passed the store gate and `oshal-app validate` and was then refused by the database mid-install on 2026-09-28. An unknown scope is now refused by name before any database write. Plain CommonJS with no dependencies so the CLI, the loader and a store checkout can all load it.
 */

'use strict';

/**
 * The app visibility scopes: the values swarm_applications.scope accepts (migration 064's CHECK) and the
 * SwarmAppScope type names (src/features/swarm-apps/types.ts). tests/unit/app-scope-contract.spec.ts
 * keeps the three equal.
 */
const APP_SCOPES = Object.freeze(['person', 'tenant', 'public', 'operator']);
/** The error code a refused scope carries. */
const UNKNOWN_APP_SCOPE = 'unknown_app_scope';

/**
 * @description Whether a value is one of the known app scopes.
 * @param {unknown} value - A declared scope.
 * @returns {boolean} True only for an exact member of APP_SCOPES.
 */
function isAppScope(value) {
  return typeof value === 'string' && APP_SCOPES.includes(value);
}

/**
 * @description Refuse a manifest whose declared `scope:` is outside the vocabulary. An absent scope is
 * allowed (the loader then keeps a stored scope or defaults a new row to public); anything else -
 * a misspelling, an invented word, an empty `scope:` (null) - is refused by name.
 * @param {unknown} manifest - A parsed oshal-app.yaml.
 * @returns {string|undefined} The declared scope, or undefined when none is declared.
 * @throws {Error} With code `unknown_app_scope` when the declared scope is not known.
 */
function validateAppScope(manifest) {
  if (!manifest || typeof manifest !== 'object' || !Object.prototype.hasOwnProperty.call(manifest, 'scope')) return undefined;
  const scope = manifest.scope;
  if (scope === undefined || isAppScope(scope)) return scope;
  const shown = typeof scope === 'string' ? `"${scope.slice(0, 64)}"` : String(JSON.stringify(scope)).slice(0, 64);
  throw Object.assign(new Error(
    `scope is not a known app scope: ${shown} (${UNKNOWN_APP_SCOPE}). Known scopes: ${APP_SCOPES.join(', ')}. `
    + 'The scope sets who sees the app and is stored under a database CHECK, so it is refused before anything is written.',
  ), { code: UNKNOWN_APP_SCOPE });
}

module.exports = { APP_SCOPES, UNKNOWN_APP_SCOPE, isAppScope, validateAppScope };
