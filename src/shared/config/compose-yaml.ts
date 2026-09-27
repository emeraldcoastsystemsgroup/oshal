/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The one js-yaml loader for this repository's own compose files, for TypeScript callers (runtime and specs). js-yaml 4.3.2 refuses a document past 10000 merge-key units by default, and docker-compose.oshal-local.yml reached 10040 when #869 added four keys to the x-bot-env anchor that about 40 services merge - the image build and every compose-reading spec died on the library default. The bound here is explicit and finite and MUST equal scripts/lib/compose-yaml.js (the CommonJS twin the image build runs); tests/unit/compose-yaml-merge-key-budget.spec.ts asserts the two agree, that every compose parse goes through a loader, and that the real file stays under 80% of the bound.
 */

import yaml, { type LoadOptions } from 'js-yaml';

/**
 * Merge-key budget for the repository's own, reviewed compose files. The library default (10000)
 * is a denial-of-service bound for untrusted input and sits at the size of the real stack file.
 * Finite on purpose (never -1): a runaway anchor still fails the parse. Keep equal to
 * COMPOSE_MAX_TOTAL_MERGE_KEYS in scripts/lib/compose-yaml.js.
 */
export const COMPOSE_MAX_TOTAL_MERGE_KEYS = 100_000;

/** js-yaml 4.3's merge-key allowance, which the published LoadOptions typings predate. */
type ComposeLoadOptions = LoadOptions & { maxTotalMergeKeys: number };

const COMPOSE_LOAD_OPTIONS: ComposeLoadOptions = { maxTotalMergeKeys: COMPOSE_MAX_TOTAL_MERGE_KEYS };

/**
 * @description Parse a trusted repository compose file (or a compose file this platform generated)
 * with the repository's merge-key budget. Anchors and `<<:` merges resolve as docker compose
 * resolves them, so callers read what each container actually receives.
 * @param text Raw YAML text of the compose file.
 * @returns The parsed document; callers narrow it to the compose shape they read.
 */
export function loadComposeYaml(text: string): unknown {
  return yaml.load(text, COMPOSE_LOAD_OPTIONS);
}
