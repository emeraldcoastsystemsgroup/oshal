/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Dependency tiers at the API install paths: parse the operator's optional-app selection, and hot-load the dependencies the installer pulled from the store (deepest first, required before the package) so an install is live without waiting for the next boot.
 */
import fs from 'fs';
import path from 'path';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'app-install-dependencies' });

/** Same slug contract as the installer; bounds how many optional apps one install may name. */
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const MAX_OPTIONAL_SELECTION = 32;

/** Which tier a dependency sits in, relative to the package the operator installed. */
export type DependencyTier = 'required' | 'optional';

/** What happened to the dependencies an install pulled in. */
export interface DependencyLoadReport {
  /** Dependencies hot-loaded, in load order. */
  loaded: string[];
  /** Dependencies that did not load; a `required` failure means the package itself must not load. */
  failed: Array<{ name: string; tier: DependencyTier; error: string }>;
}

/**
 * @description Validate the optional apps an install request names. The installer checks each
 * name against the package's own optional list (fail closed); this only bounds the shape so a
 * request can never smuggle a flag or an arbitrary argument into the installer's argv.
 * @param value - The request body's `withOptional`.
 * @returns The de-duplicated names, `[]` when absent, or null when malformed.
 */
export function parseOptionalSelection(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_OPTIONAL_SELECTION) return null;
  if (!value.every((name) => typeof name === 'string' && NAME_RE.test(name))) return null;
  return [...new Set(value as string[])];
}

/**
 * @description The installer argv for an optional selection (`--with a,b`), empty when none.
 * @param selection - Names from parseOptionalSelection.
 * @returns Extra installer arguments.
 */
export function optionalSelectionArgs(selection: string[]): string[] {
  return selection.length ? ['--with', selection.join(',')] : [];
}

/** One package's recorded dependency resolution: the tiered record, or a legacy flat map (all required). */
function recordedDependencies(deployedDir: string, name: string): Array<[string, string, DependencyTier]> {
  const file = path.join(deployedDir, name, '.oshal-install.json');
  if (!fs.existsSync(file)) return [];
  try {
    const deps = JSON.parse(fs.readFileSync(file, 'utf8'))?.dependencies;
    if (!deps || typeof deps !== 'object') return [];
    if (!('required' in deps) && !('optional' in deps)) {
      return Object.entries(deps).map(([dep, state]) => [dep, String(state), 'required']);
    }
    return (['required', 'optional'] as const).flatMap((tier) => Object.entries(deps[tier] ?? {})
      .map(([dep, state]): [string, string, DependencyTier] => [dep, String(state), tier]));
  } catch (err) {
    logger.error({ err, name }, 'install record unreadable — its dependencies will load on the next boot');
    return [];
  }
}

/**
 * @description Hot-load every dependency the installer pulled from the store for `name`, deepest
 * first, so each app activates after the apps it requires. Only `installed-from-store` entries
 * load: an app that was already installed keeps whatever status its operator left it in. A
 * dependency whose own required dependency failed is not loaded either. The package itself is the
 * caller's to load — and only when no REQUIRED dependency failed.
 * @param deployedDir - The deploy directory the installer wrote to.
 * @param name - The package the operator installed.
 * @param load - Loads one manifest (SwarmAppService.loadApp with the installer's owner stamp).
 * @returns Which dependencies loaded and which failed, with each failure's effective tier.
 */
export async function hotLoadInstalledDependencies(
  deployedDir: string, name: string, load: (manifestPath: string) => Promise<unknown>,
): Promise<DependencyLoadReport> {
  const report: DependencyLoadReport = { loaded: [], failed: [] };
  const seen = new Set<string>([name]);
  const loadOne = async (dep: string, tier: DependencyTier): Promise<boolean> => {
    try {
      await load(path.join(deployedDir, dep, 'oshal-app.yaml'));
      report.loaded.push(dep);
      return true;
    } catch (err) {
      logger.error({ err, dep, tier, for: name }, 'dependency installed on disk but hot-load failed');
      report.failed.push({ name: dep, tier, error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  };
  const visit = async (pkg: string, inherited: DependencyTier): Promise<boolean> => {
    let requiredOk = true;
    for (const [dep, state, tier] of recordedDependencies(deployedDir, pkg)) {
      if (state !== 'installed-from-store' || seen.has(dep)) continue;
      seen.add(dep);
      const effective: DependencyTier = inherited === 'optional' || tier === 'optional' ? 'optional' : 'required';
      const ready = await visit(dep, effective);
      if (!ready) report.failed.push({ name: dep, tier: effective, error: 'one of its required dependencies failed to load' });
      const ok = ready && await loadOne(dep, effective);
      if (!ok && tier === 'required') requiredOk = false;
    }
    return requiredOk;
  };
  await visit(name, 'required');
  logger.info({ name, loaded: report.loaded, failed: report.failed.map((f) => f.name) }, 'install dependencies hot-loaded');
  return report;
}

/** The outcome of making a freshly installed package live. */
export type InstalledPackageLoad =
  | { ok: true; dependencies: DependencyLoadReport }
  | { ok: false; error: string; dependencies: DependencyLoadReport };

/**
 * @description Make a freshly installed package live: its store-installed dependencies first, then
 * the package — unless a REQUIRED dependency failed, in which case the package stays unloaded
 * (activating it would strand it without an app it cannot run without). An optional dependency
 * that fails is reported and the package loads anyway.
 * @param deployedDir - The deploy directory the installer wrote to.
 * @param name - The package the operator installed.
 * @param load - Loads one manifest (SwarmAppService.loadApp with the installer's owner stamp).
 * @returns ok with the dependency report, or the reason the package was not loaded.
 */
export async function loadInstalledPackage(
  deployedDir: string, name: string, load: (manifestPath: string) => Promise<unknown>,
): Promise<InstalledPackageLoad> {
  const dependencies = await hotLoadInstalledDependencies(deployedDir, name, load);
  const blocking = dependencies.failed.filter((failure) => failure.tier === 'required');
  if (blocking.length) {
    const detail = blocking.map((failure) => `${failure.name}: ${failure.error}`).join('; ');
    return { ok: false, dependencies, error: `installed on disk, but required dependencies did not load (${detail}) — "${name}" was not loaded` };
  }
  try {
    await load(path.join(deployedDir, name, 'oshal-app.yaml'));
  } catch (err) {
    logger.error({ err, name }, 'installed on disk but hot-load failed');
    return { ok: false, dependencies, error: `installed on disk but hot-load failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, dependencies };
}
