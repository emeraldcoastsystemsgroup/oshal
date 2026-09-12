/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Register installed package smokes in the AI Test Lab and reuse the installation verifier with caller-scoped execution authority.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Derive clearable verified-user prerequisites, exclude user probes from unattended installation eligibility, and fail malformed supplied tokens.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Execute sealed offline Node suites in a disposable sandbox with current authority and source checks.
 */

import { createHash } from 'crypto';
import path from 'node:path';
import type { SwarmApplicationRecord, SwarmAppSmokeDeclaration } from '../types';
import { userSmokePrerequisite, verifyAppSmokes, type AppSmokeVerificationOptions } from './app-smoke-verifier';
import { loadPackageTestCatalog, packageTestSource, type LoadedPackageTestCatalog, type PackageTestCase, type PackageTestLevel, type PackageTestRunner } from '@/shared/package-testing';
import { packageTestRecipePending, snapshotPackageTests } from './package-test-snapshot';
import { PackageTestSandbox } from './package-test-sandbox';
import { executePackageTest, type InstalledAppTestResult } from './package-test-execution';
import { inventoryPackageTests, type PackageTestInventory } from './package-test-inventory';
export type { InstalledAppTestResult } from './package-test-execution';

export type InstalledTestAuth = Pick<AppSmokeVerificationOptions, 'serviceSecret' | 'authorization'> & { canRunSuites?: boolean };
export interface InstalledTestRunOptions extends Pick<AppSmokeVerificationOptions, 'apiBaseUrl' | 'timeoutMs'>, InstalledTestAuth {
  signal?: AbortSignal;
  executionId?: string;
  revalidate?: () => Promise<boolean>;
}

/** Public metadata includes suite/fixture references, never their bytes, owners or credentials. */
export interface InstalledAppTestCase {
  id: string;
  appName: string;
  appVersion: string;
  source: string;
  caseId: string;
  revision: string;
  executionRevision?: string;
  sourceCommit?: string;
  name: string;
  purpose: string;
  level: PackageTestLevel;
  runner: PackageTestRunner;
  expected: string[];
  sideEffects: PackageTestCase['sideEffects'];
  isolation: PackageTestCase['isolation'];
  limits: PackageTestCase['limits'];
  installationEligible: boolean;
  method: string;
  path: string;
  auth: SwarmAppSmokeDeclaration['auth'] | 'none';
  prerequisites: string[];
  runnable: boolean;
  pendingReason?: string;
}

interface Registration {
  record: SwarmApplicationRecord;
  source: string;
  cases: Map<string, { metadata: InstalledAppTestCase; smoke?: SwarmAppSmokeDeclaration; declaration?: PackageTestCase; executionError?: string }>;
}

/** @description Explain unavailable execution without attempting an AI call or a mutation. */
function pendingReason(entry: Registration['cases'] extends Map<string, infer E> ? E : never, auth: InstalledTestAuth): string | undefined {
  const smoke = entry.smoke;
  if (!smoke) {
    const recipe = entry.declaration ? packageTestRecipePending(entry.declaration) : 'Test declaration is unavailable.';
    if (recipe) return recipe;
    if (entry.executionError || !entry.metadata.executionRevision) return entry.executionError || 'Sealed package source is unavailable.';
    return auth.canRunSuites === true ? undefined : 'A swarm administrator must start isolated package tests.';
  }
  const userPrerequisite = userSmokePrerequisite(smoke, auth.authorization);
  if (userPrerequisite) return userPrerequisite.error;
  if (entry.declaration?.sideEffects !== undefined && entry.declaration.sideEffects !== 'none') return 'Declared side effects require a separately approved test runner.';
  if (entry.declaration?.prerequisites.length) return `Additional prerequisites require verification: ${entry.declaration.prerequisites.join(', ')}.`;
  if (!['GET', 'HEAD'].includes(smoke.method)) return 'Mutation requires a separately approved test runner.';
  if (smoke.requiresAi) return 'AI execution requires a separately approved test runner.';
  if (smoke.auth === 'service' && !auth.serviceSecret) return 'Operator service authentication is unavailable.';
  if (smoke.auth === 'pat' && !/^Bearer\s+oshal_pat_[a-f0-9]{48}$/.test(auth.authorization ?? '')) {
    return 'A caller-owned PAT is required.';
  }
  return undefined;
}

/** @description Bind executable cases to the complete staged source inventory, including imported helpers. */
function sealExecutableCases(packageDir: string, cases: Registration['cases']): void {
  const executable = [...cases.values()].filter(entry => entry.declaration && !packageTestRecipePending(entry.declaration));
  if (!executable.length) return;
  try {
    const snapshot = snapshotPackageTests(packageDir);
    const staged = new Set(snapshot.files.map(file => file.path));
    for (const entry of executable) {
      const runner = entry.metadata.runner;
      if (runner.kind !== 'smoke' && runner.files.some(file => !staged.has(file))) {
        entry.executionError = 'A suite file is excluded from isolated source staging.'; continue;
      }
      entry.metadata.executionRevision = snapshot.revision;
      entry.metadata.sourceCommit = snapshot.sourceCommit;
      entry.metadata.revision = createHash('sha256').update(JSON.stringify({ catalog: entry.metadata.revision, execution: snapshot.revision })).digest('hex');
    }
  } catch { for (const entry of executable) entry.executionError = 'Package source cannot be sealed for isolated execution.'; }
}

/** @description Retain the established smoke catalog and prerequisites while sealing local suites separately. */
function registerSmokes(snapshot: SwarmApplicationRecord, source: string, loaded: LoadedPackageTestCatalog | null, cases: Registration['cases']): void {
  const declarations = new Map(loaded?.catalog.cases.map(test => [test.id, test]) ?? []);
  for (const smoke of snapshot.manifest.smoke ?? []) {
    const id = `app:${encodeURIComponent(snapshot.name)}:smoke:${encodeURIComponent(smoke.name)}`;
    if (cases.has(id)) throw new Error(`Duplicate installed test case: ${id}`);
    const declaration = declarations.get(smoke.name);
    const prerequisites = [
      ...(!['GET', 'HEAD'].includes(smoke.method) ? ['approved-mutation-runner'] : []),
      ...(smoke.requiresAi ? ['approved-ai-runner'] : []),
      ...(smoke.requiresUser ? ['verified-user-context'] : []),
      ...(smoke.auth !== 'public' ? [smoke.auth === 'service' ? 'operator-service-auth' : 'caller-pat'] : []),
    ];
    cases.set(id, { smoke, declaration, metadata: {
      id, appName: snapshot.name, appVersion: snapshot.version, source, caseId: smoke.name,
      revision: createHash('sha256').update(JSON.stringify({ source, version: snapshot.version, smoke, catalog: loaded?.revisions[smoke.name] })).digest('hex'),
      name: declaration?.name ?? smoke.name, purpose: declaration?.purpose ?? 'Verify the existing package installation smoke assertions.',
      level: 'integration', runner: { kind: 'smoke', smoke: smoke.name },
      expected: declaration?.expected ?? [JSON.stringify(smoke.expect)],
      sideEffects: declaration?.sideEffects ?? (['GET', 'HEAD'].includes(smoke.method) ? 'none' : 'external-write'),
      isolation: declaration?.isolation ?? { mode: ['GET', 'HEAD'].includes(smoke.method) ? 'none' : 'live' },
      limits: declaration?.limits ?? { timeoutMs: 15000 },
      installationEligible: !smoke.requiresUser && (declaration ? declaration.installation === 'safe-smoke' : ['GET', 'HEAD'].includes(smoke.method) && !smoke.requiresAi),
      method: smoke.method, path: smoke.path,
      auth: smoke.auth, prerequisites: [...new Set([...prerequisites, ...(declaration?.prerequisites ?? [])])], runnable: false,
    } });
  }
}

/**
 * One registry per SwarmAppService. Activation replaces a package atomically; teardown removes
 * its executors. The caller supplies the current visibility set for each catalog/read/run.
 */
export class InstalledAppTestCatalog {
  private readonly registrations = new Map<string, Registration>();
  private readonly sandbox: PackageTestSandbox;
  private readonly runnerImage?: string;

  /** @description Use a server-owned runner recipe and optional immutable image selection. */
  constructor(options: { sandbox?: PackageTestSandbox; runnerImage?: string } = {}) {
    this.sandbox = options.sandbox ?? new PackageTestSandbox();
    this.runnerImage = options.runnerImage;
  }

  /** @description Reject missing or malformed catalogs before a toggle can activate package resources. */
  validate(record: SwarmApplicationRecord): void {
    const packageDir = path.dirname(path.resolve(record.manifestPath));
    loadPackageTestCatalog(packageDir, record.manifest);
    packageTestSource(packageDir);
  }

  /** @description Publish a completed activation, taking a snapshot so later manifest edits cannot change a live case. */
  register(record: SwarmApplicationRecord): void {
    if (record.status !== 'active') { this.unregister(record.name); return; }
    const snapshot = structuredClone(record);
    const packageDir = path.dirname(path.resolve(snapshot.manifestPath));
    const loaded = loadPackageTestCatalog(packageDir, snapshot.manifest);
    const source = packageTestSource(packageDir);
    const declarations = new Map(loaded?.catalog.cases.map(test => [test.id, test]) ?? []);
    const cases: Registration['cases'] = new Map();
    registerSmokes(snapshot, source, loaded, cases);
    for (const declaration of declarations.values()) {
      if (declaration.runner.kind === 'smoke') continue;
      const id = `app:${encodeURIComponent(snapshot.name)}:test:${encodeURIComponent(declaration.id)}`;
      cases.set(id, { declaration, metadata: {
        id, caseId: declaration.id, appName: snapshot.name, appVersion: snapshot.version, source,
        revision: createHash('sha256').update(JSON.stringify({ source, version: snapshot.version, catalog: loaded!.revisions[declaration.id] })).digest('hex'),
        name: declaration.name, purpose: declaration.purpose, level: declaration.level, runner: declaration.runner,
        expected: declaration.expected, prerequisites: [...new Set([`runner:${declaration.runner.kind}`, ...declaration.prerequisites])],
        sideEffects: declaration.sideEffects, isolation: declaration.isolation, limits: declaration.limits,
        installationEligible: false, method: 'LOCAL', path: declaration.runner.files.join(', '), auth: 'none', runnable: false,
      } });
    }
    sealExecutableCases(packageDir, cases);
    this.registrations.set(snapshot.name, { record: snapshot, source, cases });
  }

  /** @description Remove executable registrations before asynchronous deactivation begins. */
  unregister(appName: string): void { this.registrations.delete(appName); }

  /** @description Report registration drift only for currently visible installed applications. */
  inventory(visibleApps: ReadonlyMap<string, string>): PackageTestInventory[] {
    return [...this.registrations].filter(([name]) => visibleApps.has(name)).map(([name, entry]) => {
      const registered = new Set([...entry.cases.values()].flatMap(item => {
        const runner = item.metadata.runner;
        return runner.kind !== 'smoke' && runner.scope === 'package' ? runner.files : [];
      }));
      return inventoryPackageTests(name, path.dirname(path.resolve(entry.record.manifestPath)), registered);
    });
  }

  /** @description Return only active, caller-visible package cases and current prerequisites. */
  list(visibleApps: ReadonlyMap<string, string>, auth: InstalledTestAuth = {}): InstalledAppTestCase[] {
    const cases: InstalledAppTestCase[] = [];
    for (const [name, registration] of this.registrations) {
      if (!visibleApps.has(name)) continue;
      for (const entry of registration.cases.values()) {
        const reason = pendingReason(entry, auth);
        cases.push({ ...structuredClone(entry.metadata), runnable: !reason,
          ...(reason ? { pendingReason: reason } : {}) });
      }
    }
    return cases.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** @description Surface smoke-only, undeclared and group coverage without duplicating member cases. */
  apps(visibleApps: ReadonlyMap<string, string>): Array<{
    name: string; displayName: string; version: string; source: string; coverage: 'catalog' | 'smoke-only' | 'not-declared' | 'members'; caseIds: string[];
  }> {
    return [...this.registrations].filter(([name]) => visibleApps.has(name)).map(([name, entry]) => {
      const group = entry.record.manifest.kind === 'group';
      const caseIds = [...new Set([...entry.cases.keys(), ...(group
        ? (entry.record.manifest.dependencies?.apps ?? []).filter(member => visibleApps.has(member))
          .flatMap(member => [...(this.registrations.get(member)?.cases.keys() ?? [])]) : [])])];
      return { name, displayName: visibleApps.get(name) || name, version: entry.record.version, source: entry.source,
        coverage: entry.record.manifest.testing ? 'catalog' : group ? 'members' : caseIds.length ? 'smoke-only' : 'not-declared', caseIds };
    });
  }

  /**
   * @description Re-resolve the active registration immediately before execution and use the
   * existing verifier for its exact one smoke. Missing/changed cases never run a cached executor.
   */
  async run(
    expected: InstalledAppTestCase,
    visibleApps: ReadonlyMap<string, string>,
    options: InstalledTestRunOptions,
  ): Promise<InstalledAppTestResult> {
    const registration = this.registrations.get(expected.appName);
    const entry = registration?.cases.get(expected.id);
    const pending = (error: string): InstalledAppTestResult => ({ name: expected.name, path: expected.path,
      status: 'pending', durationMs: 0, cleanupVerified: true, error });
    if (!visibleApps.has(expected.appName) || !entry || !registration) return pending('Case is no longer available. Refresh the catalog.');
    if (entry.metadata.source !== expected.source || entry.metadata.appVersion !== expected.appVersion || entry.metadata.revision !== expected.revision) {
      return pending('Case changed after selection. Refresh the catalog.');
    }
    const userPrerequisite = entry.smoke && userSmokePrerequisite(entry.smoke, options.authorization);
    if (userPrerequisite?.status === 'failed') return { name: expected.name, path: expected.path, durationMs: 0, ...userPrerequisite };
    const reason = pendingReason(entry, options);
    if (reason) return pending(reason);
    if (!entry.smoke) return this.runSuite(entry.metadata, registration, options);
    const result = await verifyAppSmokes([{ requestedName: expected.appName, record: {
      ...registration.record, manifest: { ...registration.record.manifest, smoke: [entry.smoke] },
    } }], { ...options, timeoutMs: Math.min(options.timeoutMs ?? 15000, entry.metadata.limits.timeoutMs) });
    if (this.registrations.get(expected.appName) !== registration) return pending('Application changed during execution. Run the current case again.');
    return result.apps[0].smokes[0];
  }

  /** @description Stage current matching bytes without inheriting API credentials or writable mounts. */
  private async runSuite(expected: InstalledAppTestCase, registration: Registration, options: InstalledTestRunOptions): Promise<InstalledAppTestResult> {
    const pending = (error: string): InstalledAppTestResult => ({ name: expected.name, path: expected.path, status: 'pending', durationMs: 0, cleanupVerified: true, error });
    if (!options.revalidate || expected.runner.kind !== 'node-test' || expected.runner.scope !== 'package') return pending('Current execution authority is required.');
    const packageDir = path.dirname(path.resolve(registration.record.manifestPath));
    try {
      const snapshot = snapshotPackageTests(packageDir);
      if (snapshot.revision !== expected.executionRevision) return pending('Package source changed after selection. Refresh the catalog.');
      return await executePackageTest({ name: expected.name, path: expected.path, suiteFiles: expected.runner.files,
        timeoutMs: Math.min(options.timeoutMs ?? expected.limits.timeoutMs, expected.limits.timeoutMs), maxMemoryMb: expected.limits.maxMemoryMb,
        snapshot, snapshotNow: () => snapshotPackageTests(packageDir), image: this.runnerImage, sandbox: this.sandbox, signal: options.signal, executionId: options.executionId,
        current: async () => this.registrations.get(expected.appName) === registration && await options.revalidate!() });
    } catch { return pending('Current package source is unavailable.'); }
  }
}
