/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Register installed package smokes in the AI Test Lab and reuse the installation verifier with caller-scoped execution authority.
 */

import { createHash } from 'crypto';
import path from 'node:path';
import type { SwarmApplicationRecord, SwarmAppSmokeDeclaration } from '../types';
import { verifyAppSmokes, type AppSmokeResult, type AppSmokeVerificationOptions } from './app-smoke-verifier';
import { loadPackageTestCatalog, packageTestSource, type PackageTestCase, type PackageTestLevel, type PackageTestRunner } from '@/shared/package-testing';

export type InstalledTestAuth = Pick<AppSmokeVerificationOptions, 'serviceSecret' | 'authorization'>;

/** Public metadata includes suite/fixture references, never their bytes, owners or credentials. */
export interface InstalledAppTestCase {
  id: string;
  appName: string;
  appVersion: string;
  source: string;
  caseId: string;
  revision: string;
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
  cases: Map<string, { metadata: InstalledAppTestCase; smoke?: SwarmAppSmokeDeclaration; declaration?: PackageTestCase }>;
}

/** @description Explain unavailable execution without attempting an AI call or a mutation. */
function pendingReason(entry: Registration['cases'] extends Map<string, infer E> ? E : never, auth: InstalledTestAuth): string | undefined {
  const smoke = entry.smoke;
  if (!smoke) return `The ${entry.metadata.runner.kind} runner is unavailable. This catalog registers suites without executing them.`;
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

/**
 * One registry per SwarmAppService. Activation replaces a package atomically; teardown removes
 * its executors. The caller supplies the current visibility set for each catalog/read/run.
 */
export class InstalledAppTestCatalog {
  private readonly registrations = new Map<string, Registration>();

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
    for (const smoke of snapshot.manifest.smoke ?? []) {
      const id = `app:${encodeURIComponent(snapshot.name)}:smoke:${encodeURIComponent(smoke.name)}`;
      if (cases.has(id)) throw new Error(`Duplicate installed test case: ${id}`);
      const declaration = declarations.get(smoke.name);
      const prerequisites = [
        ...(!['GET', 'HEAD'].includes(smoke.method) ? ['approved-mutation-runner'] : []),
        ...(smoke.requiresAi ? ['approved-ai-runner'] : []),
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
        installationEligible: declaration ? declaration.installation === 'safe-smoke' : ['GET', 'HEAD'].includes(smoke.method) && !smoke.requiresAi,
        method: smoke.method, path: smoke.path,
        auth: smoke.auth, prerequisites: [...new Set([...prerequisites, ...(declaration?.prerequisites ?? [])])], runnable: false,
      } });
    }
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
    this.registrations.set(snapshot.name, { record: snapshot, source, cases });
  }

  /** @description Remove executable registrations before asynchronous deactivation begins. */
  unregister(appName: string): void { this.registrations.delete(appName); }

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
    options: Pick<AppSmokeVerificationOptions, 'apiBaseUrl' | 'timeoutMs'> & InstalledTestAuth,
  ): Promise<AppSmokeResult> {
    const registration = this.registrations.get(expected.appName);
    const entry = registration?.cases.get(expected.id);
    const pending = (error: string): AppSmokeResult => ({ name: expected.name, path: expected.path,
      status: 'pending', durationMs: 0, error });
    if (!visibleApps.has(expected.appName) || !entry || !registration) return pending('Case is no longer available. Refresh the catalog.');
    if (entry.metadata.source !== expected.source || entry.metadata.appVersion !== expected.appVersion || entry.metadata.revision !== expected.revision) {
      return pending('Case changed after selection. Refresh the catalog.');
    }
    const reason = pendingReason(entry, options);
    if (reason) return pending(reason);
    if (!entry.smoke) return pending('Test runner is unavailable.');
    const result = await verifyAppSmokes([{ requestedName: expected.appName, record: {
      ...registration.record, manifest: { ...registration.record.manifest, smoke: [entry.smoke] },
    } }], { ...options, timeoutMs: Math.min(options.timeoutMs ?? 15000, entry.metadata.limits.timeoutMs) });
    if (this.registrations.get(expected.appName) !== registration) return pending('Application changed during execution. Run the current case again.');
    return result.apps[0].smokes[0];
  }
}
