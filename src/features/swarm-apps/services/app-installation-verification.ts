/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify eligible installed smokes through their registered executor and link all other cases without running them.
 */
import type { SwarmApplicationRecord } from '../types';
import type { AppSmokeFetch, AppSmokeResult } from './app-smoke-verifier';
import type { InstalledAppTestCatalog, InstalledAppTestCase, InstalledTestRunOptions } from './installed-app-test-catalog';
import { installationCaseUrl, type ApplicationInstallationReport, type InstallationCaseReport, type InstallationVerificationReport } from './app-installation-report';

type RecordEntry = { requestedName: string; record: SwarmApplicationRecord | null };
type Registration = ReturnType<InstalledAppTestCatalog['apps']>[number];

/** @description Controller-owned dependencies; no case, URL, runner or actor is accepted from the request body. */
export interface InstallationVerificationOptions extends Omit<InstalledTestRunOptions, 'serviceSmokeFetch'> {
  resolveMember(name: string): Promise<SwarmApplicationRecord | null>;
  fetchImpl?: AppSmokeFetch;
  serviceSmokeFetch?: (test: InstalledAppTestCase) => Promise<AppSmokeFetch | undefined>;
}

function disposition(test: InstalledAppTestCase): InstallationCaseReport {
  const smoke = test.runner.kind === 'smoke';
  return { id: test.id, appName: test.appName, appVersion: test.appVersion, source: test.source,
    revision: test.revision, name: test.runner.kind === 'smoke' ? test.runner.smoke : test.name, path: test.path,
    level: test.level, runner: test.runner.kind, installationEligible: test.installationEligible,
    status: smoke ? 'pending' : 'not-run', labUrl: installationCaseUrl(test.id), durationMs: 0,
    error: smoke ? test.pendingReason || 'This smoke is excluded from automatic installation checks.'
      : 'Registered for separate execution; installation does not run this suite.' };
}

async function resolveRecords(records: RecordEntry[], options: InstallationVerificationOptions) {
  const resolved = new Map(records.map(entry => [entry.requestedName, entry.record]));
  for (const { record } of records) {
    if (record?.manifest.kind !== 'group') continue;
    for (const name of record.manifest.dependencies?.apps ?? []) {
      if (resolved.size >= 256) throw new Error('Installation verification exceeds 256 packages.');
      if (!resolved.has(name)) resolved.set(name, await options.resolveMember(name));
    }
  }
  return resolved;
}

function registrationError(record: SwarmApplicationRecord | null, registered?: Registration): string | undefined {
  if (!record) return 'App is not installed.';
  if (record.status !== 'active') return 'App is inactive.';
  if (!registered) return 'Installed test registration is unavailable.';
  if (record.version !== registered.version) return 'Application changed before verification. Refresh the installation report.';
  return undefined;
}

function current(test: InstalledAppTestCase, catalog: InstalledAppTestCatalog, visible: ReadonlyMap<string, string>): boolean {
  return catalog.list(visible).some(now => now.id === test.id && now.revision === test.revision
    && now.source === test.source && now.appVersion === test.appVersion);
}

async function verifyCase(test: InstalledAppTestCase, catalog: InstalledAppTestCatalog,
  visible: ReadonlyMap<string, string>, options: InstallationVerificationOptions): Promise<InstallationCaseReport> {
  const result = disposition(test);
  if (test.runner.kind !== 'smoke' || !test.installationEligible) return result;
  const { serviceSmokeFetch: transport, resolveMember: _resolve, ...runOptions } = options;
  const serviceSmokeFetch = test.auth === 'service' ? await transport?.(test) : undefined;
  const smoke = await catalog.run(test, visible, { ...runOptions, serviceSmokeFetch });
  const { error: _pending, ...base } = result;
  return { ...base, status: smoke.status, durationMs: smoke.durationMs,
    ...(smoke.httpStatus === undefined ? {} : { httpStatus: smoke.httpStatus }), ...(smoke.error ? { error: smoke.error } : {}) };
}

function summarizeApplication(entry: RecordEntry, registered: Registration | undefined,
  cases: InstallationCaseReport[], error?: string, stale = false): ApplicationInstallationReport {
  const smokes = cases.filter(test => test.runner === 'smoke').map(test => ({
    name: test.appName === entry.requestedName ? test.name : `${test.appName}/${test.name}`, path: test.path,
    caseId: test.id, labUrl: test.labUrl,
    status: test.status as AppSmokeResult['status'], durationMs: test.durationMs,
    ...(test.error ? { error: test.error } : {}), ...(test.httpStatus === undefined ? {} : { httpStatus: test.httpStatus }) }));
  const failed = Boolean(error) || smokes.some(smoke => smoke.status === 'failed');
  const status = failed ? 'failed' : stale || !smokes.length || smokes.some(smoke => smoke.status === 'pending') ? 'pending' : 'passed';
  return { appName: entry.requestedName, version: registered?.version ?? entry.record?.version, status, verified: status === 'passed', stale, smokes,
    registration: { coverage: registered?.coverage ?? 'unavailable', caseCount: cases.length, smokeCount: smokes.length,
      suiteCount: cases.length - smokes.length, caseIds: cases.map(test => test.id) }, cases,
    ...(error ? { error } : !smokes.length ? { error: 'No installation smoke is declared; application verification is pending.' } : {}) };
}

function uniqueEvidence(apps: ApplicationInstallationReport[]): InstallationCaseReport[] {
  const evidence = new Map<string, InstallationCaseReport>();
  const rank = { 'not-run': 0, pending: 1, passed: 2, failed: 3 };
  for (const test of apps.flatMap(app => app.cases)) {
    const prior = evidence.get(test.id);
    if (!prior || rank[test.status] > rank[prior.status]) evidence.set(test.id, test);
  }
  return [...evidence.values()];
}

function aggregate(apps: ApplicationInstallationReport[]): InstallationVerificationReport {
  const failedApps = apps.filter(app => app.status === 'failed').map(app => app.appName);
  const pendingApps = apps.filter(app => app.status === 'pending').map(app => app.appName);
  const cases = uniqueEvidence(apps);
  const verificationStatus = failedApps.length ? 'failed' : pendingApps.length ? 'pending' : 'passed';
  return { reportVersion: 1, success: failedApps.length === 0, verified: verificationStatus === 'passed', verificationStatus,
    failedApps, pendingApps, apps, summary: { registeredCases: cases.length,
      smokesPassed: cases.filter(test => test.runner === 'smoke' && test.status === 'passed').length,
      smokesFailed: cases.filter(test => test.runner === 'smoke' && test.status === 'failed').length,
      smokesPending: cases.filter(test => test.runner === 'smoke' && test.status === 'pending').length,
      suitesNotRun: cases.filter(test => test.runner !== 'smoke').length } };
}

/** @description Execute only declared eligible smokes, once per registered identity, while retaining pending and suite dispositions.
 * @param records Exact installed records selected by the authorized installer. @param catalog Active service-owned Lab registry.
 * @param options Trusted runtime transport and member resolver. @returns Version-linked installation report with honest verification status. */
export async function verifyInstalledApplications(records: RecordEntry[], catalog: InstalledAppTestCatalog,
  options: InstallationVerificationOptions): Promise<InstallationVerificationReport> {
  const resolved = await resolveRecords(records, options);
  const visible = new Map([...resolved].map(([name, record]) => [name, record?.displayName || name]));
  const registrations = new Map(catalog.apps(visible).map(app => [app.name, app]));
  const tests = new Map(catalog.list(visible, options).map(test => [test.id, test]));
  const executed = new Map<string, InstallationCaseReport>();
  const apps: ApplicationInstallationReport[] = [];
  for (const entry of records) {
    const registered = registrations.get(entry.requestedName);
    let error = registrationError(entry.record, registered);
    const members = entry.record?.manifest.kind === 'group' ? entry.record.manifest.dependencies?.apps ?? [] : [];
    for (const name of members) {
      const memberError = registrationError(resolved.get(name) ?? null, registrations.get(name));
      if (memberError) error ||= `Member ${name}: ${memberError}`;
    }
    const selected = (registered?.caseIds ?? []).map(id => tests.get(id)).filter((test): test is InstalledAppTestCase => Boolean(test));
    for (const test of selected) if (!error && !executed.has(test.id)) executed.set(test.id, await verifyCase(test, catalog, visible, options));
    apps.push(summarizeApplication(entry, registered, selected.map(test => error ? disposition(test) : { ...executed.get(test.id)! }), error));
  }
  const active = new Map(catalog.apps(visible).map(app => [app.name, app]));
  for (const app of apps) {
    const staleCases = app.cases.filter(test => !current(tests.get(test.id)!, catalog, visible));
    const stale = JSON.stringify(active.get(app.appName)) !== JSON.stringify(registrations.get(app.appName)) || staleCases.length > 0;
    if (!stale) continue;
    app.stale = true; app.verified = false;
    if (app.status !== 'failed') app.status = 'pending';
    for (const test of staleCases) if (test.status === 'passed') Object.assign(test, { status: 'pending', error: 'Application changed during verification. Refresh the installation report.' });
    app.smokes = app.smokes.map(smoke => staleCases.some(test => test.path === smoke.path && test.runner === 'smoke') && smoke.status === 'passed'
      ? { ...smoke, status: 'pending' } : smoke);
  }
  return aggregate(apps);
}
