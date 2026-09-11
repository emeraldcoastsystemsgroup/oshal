/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Register installed package smokes in the AI Test Lab and reuse the installation verifier with caller-scoped execution authority.
 */

import { createHash } from 'crypto';
import type { SwarmApplicationRecord, SwarmAppSmokeDeclaration } from '../types';
import { verifyAppSmokes, type AppSmokeResult, type AppSmokeVerificationOptions } from './app-smoke-verifier';

export type InstalledTestAuth = Pick<AppSmokeVerificationOptions, 'serviceSecret' | 'authorization'>;

/** Public case metadata deliberately excludes manifests, owners, fixtures and credentials. */
export interface InstalledAppTestCase {
  id: string;
  appName: string;
  appVersion: string;
  revision: string;
  name: string;
  level: 'integration';
  method: string;
  path: string;
  auth: SwarmAppSmokeDeclaration['auth'];
  prerequisites: string[];
  runnable: boolean;
  pendingReason?: string;
}

interface Registration {
  record: SwarmApplicationRecord;
  cases: Map<string, { metadata: InstalledAppTestCase; smoke: SwarmAppSmokeDeclaration }>;
}

/** @description Explain unavailable execution without attempting an AI call or a mutation. */
function pendingReason(smoke: SwarmAppSmokeDeclaration, auth: InstalledTestAuth): string | undefined {
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

  /** @description Publish a completed activation, taking a snapshot so later manifest edits cannot change a live case. */
  register(record: SwarmApplicationRecord): void {
    if (record.status !== 'active') { this.unregister(record.name); return; }
    const snapshot = structuredClone(record);
    const cases: Registration['cases'] = new Map();
    for (const smoke of snapshot.manifest.smoke ?? []) {
      const id = `app:${encodeURIComponent(snapshot.name)}:smoke:${encodeURIComponent(smoke.name)}`;
      if (cases.has(id)) throw new Error(`Duplicate installed test case: ${id}`);
      const prerequisites = [
        ...(!['GET', 'HEAD'].includes(smoke.method) ? ['approved-mutation-runner'] : []),
        ...(smoke.requiresAi ? ['approved-ai-runner'] : []),
        ...(smoke.auth !== 'public' ? [smoke.auth === 'service' ? 'operator-service-auth' : 'caller-pat'] : []),
      ];
      cases.set(id, { smoke, metadata: {
        id, appName: snapshot.name, appVersion: snapshot.version,
        revision: createHash('sha256').update(JSON.stringify(smoke)).digest('hex'),
        name: smoke.name, level: 'integration', method: smoke.method, path: smoke.path,
        auth: smoke.auth, prerequisites, runnable: false,
      } });
    }
    this.registrations.set(snapshot.name, { record: snapshot, cases });
  }

  /** @description Remove executable registrations before asynchronous deactivation begins. */
  unregister(appName: string): void { this.registrations.delete(appName); }

  /** @description Return only active, caller-visible package cases and current prerequisites. */
  list(visibleApps: ReadonlyMap<string, string>, auth: InstalledTestAuth = {}): InstalledAppTestCase[] {
    const cases: InstalledAppTestCase[] = [];
    for (const [name, registration] of this.registrations) {
      if (!visibleApps.has(name)) continue;
      for (const entry of registration.cases.values()) {
        const reason = pendingReason(entry.smoke, auth);
        cases.push({ ...entry.metadata, prerequisites: [...entry.metadata.prerequisites], runnable: !reason,
          ...(reason ? { pendingReason: reason } : {}) });
      }
    }
    return cases.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** @description Surface smoke-only, undeclared and group coverage without duplicating member cases. */
  apps(visibleApps: ReadonlyMap<string, string>): Array<{
    name: string; displayName: string; version: string; coverage: 'smoke-only' | 'not-declared' | 'members'; caseIds: string[];
  }> {
    return [...this.registrations].filter(([name]) => visibleApps.has(name)).map(([name, entry]) => {
      const group = entry.record.manifest.kind === 'group';
      const caseIds = group
        ? (entry.record.manifest.dependencies?.apps ?? []).filter(member => visibleApps.has(member))
          .flatMap(member => [...(this.registrations.get(member)?.cases.keys() ?? [])])
        : [...entry.cases.keys()];
      return { name, displayName: visibleApps.get(name) || name, version: entry.record.version,
        coverage: group ? 'members' : caseIds.length ? 'smoke-only' : 'not-declared', caseIds };
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
    if (entry.metadata.appVersion !== expected.appVersion || entry.metadata.revision !== expected.revision) {
      return pending('Case changed after selection. Refresh the catalog.');
    }
    const reason = pendingReason(entry.smoke, options);
    if (reason) return pending(reason);
    const result = await verifyAppSmokes([{ requestedName: expected.appName, record: {
      ...registration.record, manifest: { ...registration.record.manifest, smoke: [entry.smoke] },
    } }], options);
    if (this.registrations.get(expected.appName) !== registration) return pending('Application changed during execution. Run the current case again.');
    return result.apps[0].smokes[0];
  }
}
