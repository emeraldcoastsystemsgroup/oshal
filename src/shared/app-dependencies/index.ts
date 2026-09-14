/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Typed runtime view of the shared CLI/runtime dependency-tier contract (scripts/oshal-app-dependencies.js): required vs optional apps, tools and connectors, the legacy flat form read as all-required, and the connector allow-list derived from both tiers.
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

/** The three things an app can depend on. */
export interface AppDependencyLists {
  /** Store packages (installable by name). */
  apps: string[];
  /** Runtime tool names another app or the registry provides. */
  tools: string[];
  /** Connector provider ids. */
  connectors: string[];
}

/** A manifest's dependencies, normalized into the two tiers. */
export interface AppDependencies {
  /** True when the manifest uses the `required:` / `optional:` form (false for the legacy flat form). */
  tiered: boolean;
  /** Installed with the app (fail-closed), resolved at load, and protected from removal while it is active. */
  required: AppDependencyLists;
  /** Offered at install and never blocking; the app works without them. */
  optional: AppDependencyLists;
  /** Connector ids the app's surfaces may offer; null when no tier declares `connectors` (unfiltered). */
  connectorAllowList: string[] | null;
}

/** The manifest fields the contract reads. */
export interface AppDependencySource {
  name?: unknown;
  kind?: unknown;
  uses?: unknown;
  dependencies?: unknown;
}

const contract = createRequire(__filename)(resolve(__dirname, '../../../scripts/oshal-app-dependencies.js')) as {
  DEPENDENCY_TIERS_SKILL: string;
  inspectAppDependencies(manifest: AppDependencySource): AppDependencies & { problems: string[] };
  readAppDependencies(manifest: AppDependencySource): AppDependencies;
};

/** The `uses:` compatibility floor a tiered (non-group) manifest must declare. */
export const DEPENDENCY_TIERS_SKILL = contract.DEPENDENCY_TIERS_SKILL;

/**
 * @description Read a manifest's dependency tiers, failing closed on a malformed block. The CLI's
 * `validate`/`install` and the runtime loader call the same contract, so a package the installer
 * accepts is one the loader accepts.
 * @param manifest - Parsed manifest (only name/kind/uses/dependencies are read).
 * @returns The normalized tiers.
 * @throws When the block is malformed; the message names every problem.
 */
export function readAppDependencies(manifest: AppDependencySource): AppDependencies {
  return contract.readAppDependencies(manifest);
}

/**
 * @description Collect a manifest's dependency problems without throwing — for screens that must
 * describe a package (the App Loader preview) rather than refuse to read it.
 * @param manifest - Parsed manifest.
 * @returns The normalized tiers plus every problem found (empty when valid).
 */
export function inspectAppDependencies(manifest: AppDependencySource): AppDependencies & { problems: string[] } {
  return contract.inspectAppDependencies(manifest);
}

/**
 * @description The apps an app cannot run without — a group's members, the reverse-dependency
 * guard's edges, and the set the installer resolves fail-closed. Lenient: an already-loaded record
 * with a malformed block (validated at load, so only a hand-edited row) contributes nothing.
 * @param manifest - Parsed manifest.
 * @returns Required app names in declaration order.
 */
export function requiredAppDependencies(manifest: AppDependencySource): string[] {
  return contract.inspectAppDependencies(manifest).required.apps;
}

/**
 * @description The apps an app can use when present but works without.
 * @param manifest - Parsed manifest.
 * @returns Optional app names in declaration order.
 */
export function optionalAppDependencies(manifest: AppDependencySource): string[] {
  return contract.inspectAppDependencies(manifest).optional.apps;
}

/**
 * @description The tools an app cannot run without (load fails closed when nothing provides one).
 * @param manifest - Parsed manifest.
 * @returns Required tool names.
 */
export function requiredToolDependencies(manifest: AppDependencySource): string[] {
  return contract.inspectAppDependencies(manifest).required.tools;
}

/**
 * @description The connector allow-list a manifest declares: the union of both tiers when either
 * declares `connectors`, else undefined so a legacy manifest keeps the unfiltered catalog.
 * @param manifest - Parsed manifest.
 * @returns Allowed connector ids, or undefined when the manifest declares none.
 */
export function connectorAllowList(manifest: AppDependencySource): string[] | undefined {
  return contract.inspectAppDependencies(manifest).connectorAllowList ?? undefined;
}
