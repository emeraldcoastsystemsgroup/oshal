/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | One CLI/runtime contract for manifest dependency tiers: `required` (installed with the app, fail-closed, blocks its own removal) and `optional` (offered at install, never blocks). The legacy flat apps/tools/connectors form reads as all-required.
 */
'use strict';

/** Same slug contract as the installer and the App Loader — a dependency must be installable. */
const APP_NAME = /^[a-z0-9][a-z0-9-]{1,63}$/;
/** Tool and connector ids: registry names such as `trading_scan` or `google-search-console`. */
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const KINDS = ['apps', 'tools', 'connectors'];
const TIERS = ['required', 'optional'];
/** The compatibility floor a tiered manifest declares so an older core refuses it (fail closed). */
const DEPENDENCY_TIERS_SKILL = 'app-dependencies';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function emptyLists() {
  return { apps: [], tools: [], connectors: [] };
}

/** Validate one list; returns the entries and pushes every problem found. */
function readList(value, at, kind, problems) {
  if (!Array.isArray(value)) {
    problems.push(`${at} must be a list (use [] for none)`);
    return [];
  }
  const pattern = kind === 'apps' ? APP_NAME : ID;
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string' || !pattern.test(entry)) {
      problems.push(`${at} entry ${JSON.stringify(entry)} is not a valid ${kind === 'apps' ? 'package name' : 'id'}`);
    } else if (seen.has(entry)) {
      problems.push(`${at} repeats "${entry}"`);
    }
    seen.add(entry);
  }
  return value.filter((entry) => typeof entry === 'string');
}

/** Read one `{apps, tools, connectors}` group (a tier, or the legacy flat block). */
function readGroup(value, at, problems) {
  const lists = emptyLists();
  const declared = new Set();
  if (value === null || value === undefined) return { lists, declared };
  if (!isPlainObject(value)) {
    problems.push(`${at} must be a mapping of apps/tools/connectors`);
    return { lists, declared };
  }
  for (const key of Object.keys(value)) {
    if (!KINDS.includes(key)) problems.push(`${at} has unknown key "${key}" (allowed: ${KINDS.join(', ')})`);
  }
  for (const kind of KINDS) {
    if (value[kind] === undefined) continue;
    declared.add(kind);
    lists[kind] = readList(value[kind], `${at}.${kind}`, kind, problems);
  }
  return { lists, declared };
}

/** The tiered form must be read by a core that understands it — or refused by one that does not. */
function tieredFloorProblem(manifest) {
  // A group needs no floor: an older core already refuses a group whose members are not under the
  // legacy dependencies.apps, and ADR-141 forbids `uses:` on a group.
  if (manifest.kind === 'group') return null;
  const uses = Array.isArray(manifest.uses) ? manifest.uses : [];
  if (uses.includes(DEPENDENCY_TIERS_SKILL)) return null;
  return `dependencies.required/optional needs uses: [${DEPENDENCY_TIERS_SKILL}] — an older core would otherwise `
    + 'install the package without its required dependencies and drop its connector allow-list';
}

/** Cross-tier rules: nothing listed twice, and an app never depends on itself. */
function crossTierProblems(manifest, required, optional, problems) {
  for (const kind of KINDS) {
    for (const entry of required[kind]) {
      if (optional[kind].includes(entry)) problems.push(`dependencies lists "${entry}" as both required and optional ${kind}`);
    }
  }
  if (typeof manifest.name === 'string' && [...required.apps, ...optional.apps].includes(manifest.name)) {
    problems.push(`dependencies names the package itself ("${manifest.name}")`);
  }
}

/**
 * @description Read a manifest's `dependencies` block into its two tiers, collecting every problem.
 * @param {object} manifest Parsed oshal-app.yaml.
 * @returns {{ tiered: boolean, required: object, optional: object, connectorAllowList: string[]|null, problems: string[] }}
 *  `connectorAllowList` is null when no `connectors` key is declared anywhere (legacy: unfiltered).
 */
function inspectAppDependencies(manifest) {
  const problems = [];
  const value = manifest ? manifest.dependencies : undefined;
  const result = { tiered: false, required: emptyLists(), optional: emptyLists(), connectorAllowList: null, problems };
  if (value === undefined || value === null) return result;
  if (!isPlainObject(value)) {
    problems.push('dependencies must be a mapping');
    return result;
  }
  const keys = Object.keys(value);
  result.tiered = keys.some((key) => TIERS.includes(key));
  if (result.tiered && keys.some((key) => KINDS.includes(key))) {
    problems.push('dependencies mixes the flat apps/tools/connectors form with required/optional — use one form');
  }
  const unknown = keys.filter((key) => !KINDS.includes(key) && !TIERS.includes(key));
  if (unknown.length) problems.push(`dependencies has unknown key(s): ${unknown.join(', ')} (allowed: required, optional)`);
  const required = result.tiered ? readGroup(value.required, 'dependencies.required', problems) : readGroup(value, 'dependencies', problems);
  const optional = result.tiered ? readGroup(value.optional, 'dependencies.optional', problems) : { lists: emptyLists(), declared: new Set() };
  result.required = required.lists;
  result.optional = optional.lists;
  if (required.declared.has('connectors') || optional.declared.has('connectors')) {
    result.connectorAllowList = [...required.lists.connectors, ...optional.lists.connectors];
  }
  crossTierProblems(manifest, result.required, result.optional, problems);
  const floor = result.tiered ? tieredFloorProblem(manifest) : null;
  if (floor) problems.push(floor);
  return result;
}

/**
 * @description Read a manifest's dependency tiers, failing closed on any problem.
 * @param {object} manifest Parsed oshal-app.yaml.
 * @returns {{ tiered: boolean, required: object, optional: object, connectorAllowList: string[]|null }}
 * @throws {Error} Naming every problem, when the block is malformed.
 */
function readAppDependencies(manifest) {
  const { problems, ...dependencies } = inspectAppDependencies(manifest);
  if (problems.length) throw new Error(problems.join('; '));
  return dependencies;
}

module.exports = { DEPENDENCY_TIERS_SKILL, inspectAppDependencies, readAppDependencies };
