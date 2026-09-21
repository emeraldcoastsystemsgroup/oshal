/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | THE one bridge from the CommonJS schema-docs generator into the data-model feature slice. The catalog SQL, the RLS row-scope classifier and the static CREATE TABLE parser used to exist twice - once as CommonJS under scripts/schema-docs/, once as TypeScript behind the explorer - held together by a parity spec, which only tells you AFTER one side has already drifted. The copies are gone and the slice is the only implementation; this file is where the generator reaches it. The slice is TypeScript, so when the process has no TypeScript resolver yet (a plain `node scripts/generate-schema-docs.js`, or a vitest spec requiring a generator module as externalised CommonJS) the tsx require hook is registered on demand - which keeps the documented generator command working unchanged. Failure is loud and by name: a generator that cannot reach the slice must stop, never fall back to a second copy.
 */

'use strict';

const SPECIFIER = '@/features/data-model';

/**
 * @description Load the data-model feature slice from CommonJS, registering tsx's require hook
 * first if the current process cannot resolve TypeScript yet. Kept in one place so every
 * schema-docs module reaches exactly one implementation.
 * @returns {object} the slice's barrel exports
 */
function loadSlice() {
  try {
    return require(SPECIFIER);
  } catch (first) {
    try {
      require('tsx/cjs');
    } catch (hookError) {
      throw new Error(`Cannot load ${SPECIFIER} (${first.message}) and the tsx require hook is unavailable (${hookError.message}). `
        + 'The schema-docs generator reads the TypeScript data-model slice; run it from a checkout with dev dependencies installed.');
    }
    return require(SPECIFIER);
  }
}

const slice = loadSlice();

const { CATALOG_SQL, HYPERTABLE_SQL, foldCatalog, summarizeRowAccess, classifyPolicy, parseCreateTable } = slice;

for (const [name, value] of Object.entries({ CATALOG_SQL, HYPERTABLE_SQL, foldCatalog, summarizeRowAccess, classifyPolicy, parseCreateTable })) {
  if (value === undefined) {
    throw new Error(`${SPECIFIER} no longer exports ${name}. The schema-docs generator and the data-model explorer are one implementation; `
      + 'restore the export rather than reintroducing a copy under scripts/schema-docs/.');
  }
}

/** Absolute path of the slice module this generator actually loaded; the one-implementation spec asserts it. */
const SLICE_PATH = require.resolve(SPECIFIER);

module.exports = { CATALOG_SQL, HYPERTABLE_SQL, foldCatalog, summarizeRowAccess, classifyPolicy, parseCreateTable, SLICE_PATH };
