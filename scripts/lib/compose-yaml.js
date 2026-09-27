/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | The one js-yaml loader for this repository's own compose files (CommonJS twin of src/shared/config/compose-yaml.ts, for the scripts that run before or outside the TypeScript build). js-yaml 4.3.2 charges one unit per merged source mapping and one per key it copies through `<<:`, and refuses past 10000 by default. docker-compose.oshal-local.yml merges its bot anchors into about 40 services, and #869's four x-bot-env keys took it to 10040 - the image build died at `RUN node scripts/gen-dist-compose.js`. Every caller now passes one explicit, finite bound instead of the library default; tests/unit/compose-yaml-merge-key-budget.spec.ts pins the callers to this loader and fails at 80% of the bound.
 */
'use strict';

const yaml = require('js-yaml');

/**
 * Merge-key budget for the repository's own, reviewed compose files. The library default (10000)
 * is a denial-of-service bound for untrusted input and sits right at the size of the real stack
 * file, so it cannot stay the effective limit. The bound stays FINITE on purpose (never -1): a
 * runaway anchor - a merge of a merge fanned out across every service - still fails the parse. At
 * the time it was chosen docker-compose.oshal-local.yml measured 10040; the budget guard goes red
 * at 80% of this value, well before a build could reach it.
 */
const COMPOSE_MAX_TOTAL_MERGE_KEYS = 100000;

/** Upper end of the measuring search: far above the bound, so an over-budget file is still sized. */
const MEASURE_CEILING = COMPOSE_MAX_TOTAL_MERGE_KEYS * 10;

/**
 * @description Parse a trusted repository compose file with the repository's merge-key budget.
 * Anchors and `<<:` merges resolve exactly as they do for docker compose, so callers read the
 * environment each container actually receives.
 * @param {string} text Raw YAML text of a compose file tracked in this repository.
 * @returns {unknown} The parsed document (callers narrow it to the compose shape they read).
 */
function loadComposeYaml(text) {
  return yaml.load(text, { maxTotalMergeKeys: COMPOSE_MAX_TOTAL_MERGE_KEYS });
}

/**
 * @description Whether js-yaml parses the text within a given merge-key allowance. Any failure
 * other than the merge-key limit is a real defect in the file and is rethrown.
 * @param {string} text Raw YAML text.
 * @param {number} allowance maxTotalMergeKeys to parse with (never -1).
 * @returns {boolean} True when the parse completes within the allowance.
 */
function parsesWithin(text, allowance) {
  try {
    yaml.load(text, { maxTotalMergeKeys: allowance });
    return true;
  } catch (error) {
    if (error instanceof yaml.YAMLException && /maxTotalMergeKeys/.test(error.reason || '')) return false;
    throw error;
  }
}

/**
 * @description Measure the merge work js-yaml charges for a compose file, using the library's own
 * counter (a parse succeeds exactly when its total is within the allowance, so a binary search over
 * the allowance finds the total). This is what the budget guard compares against the bound, so the
 * number can never drift from what the loader enforces.
 * @param {string} text Raw YAML text of a compose file.
 * @returns {number} The total merge-key charge, or Infinity when it exceeds ten times the bound.
 */
function measureComposeMergeKeys(text) {
  if (!parsesWithin(text, MEASURE_CEILING)) return Number.POSITIVE_INFINITY;
  let low = 0;
  let high = MEASURE_CEILING;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (parsesWithin(text, middle)) high = middle;
    else low = middle + 1;
  }
  return low;
}

module.exports = { COMPOSE_MAX_TOTAL_MERGE_KEYS, loadComposeYaml, measureComposeMergeKeys };
