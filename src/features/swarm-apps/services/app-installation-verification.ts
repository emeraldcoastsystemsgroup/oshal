/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify eligible installed smokes through their registered executor and link all other cases without running them.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | A group's members are its REQUIRED apps, read through @/shared/app-dependencies (dependencies.required.apps or the legacy dependencies.apps).
 * 3 | maintainer@emeraldcoastsystemsgroup.com | A service-auth smoke with no bound operator transport reports PENDING instead of being executed unauthenticated. createServiceSmokeFetch only binds a transport for a cookie-bearing operator browser session, so the CLI verifier (scripts/oshal-verify.sh --apps, which the installer runs) got undefined, fell through to a bare fetch and collected 403 authorization_app_admin_required for EVERY service smoke — a fresh install could never pass its own postflight.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | A package that DECLARES status: inactive is pending, not failed — and so is a group whose only blocker is such a member. brand-graphics, print-ingest and youtube-kids ship opt-in (status: inactive in their own manifest); the verifier read the runtime status alone, called them 'App is inactive.' and failed the install, taking the intelligent-career and marketing-suite groups down with them. An app that declared active and is inactive anyway is still a failure — that is a real defect, and calendar (missing kernel module) must keep failing.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | ... and so is the GROUP the runtime holds inactive because of such a member: its own record reports only 'App is inactive.', so the member check never ran. intelligent-career (print-ingest) and marketing-suite (brand-graphics) failed clean installs for a condition one operator click resolves. The cause is now named in the message.
 */
import { requiredAppDependencies } from '@/shared/app-dependencies';
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
    for (const name of requiredAppDependencies(record.manifest)) {
      if (resolved.size >= 256) throw new Error('Installation verification exceeds 256 packages.');
      if (!resolved.has(name)) resolved.set(name, await options.resolveMember(name));
    }
  }
  return resolved;
}

/** A blocking condition, and whether it is an unfinished step rather than a defect. */
type RegistrationIssue = { message: string; pending: boolean };

function registrationIssue(record: SwarmApplicationRecord | null, registered?: Registration): RegistrationIssue | undefined {
  if (!record) return { message: 'App is not installed.', pending: false };
  if (record.status !== 'active') {
    // A manifest may declare `status: inactive`: the package ships opt-in and an operator turns it
    // on. Staging it is the whole of its installation, so this is an unfinished activation rather
    // than a failed install. A package that declared ACTIVE and is inactive anyway did break.
    return record.manifest.status === 'inactive'
      ? { message: 'App ships inactive by declaration; activate it to verify its smokes.', pending: true }
      : { message: 'App is inactive.', pending: false };
  }
  if (!registered) return { message: 'Installed test registration is unavailable.', pending: false };
  if (record.version !== registered.version) {
    return { message: 'Application changed before verification. Refresh the installation report.', pending: false };
  }
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
  // No bound transport means no operator session to borrow: executing anyway sends the service
  // secret with no operator identity, which the app-admin gate refuses. Unrunnable, not broken.
  if (test.auth === 'service' && !serviceSmokeFetch) {
    return { ...result, status: 'pending',
      error: 'Service-auth smokes run only through an operator browser session; open this case in the Test Lab.' };
  }
  const smoke = await catalog.run(test, visible, { ...runOptions, serviceSmokeFetch });
  const { error: _pending, ...base } = result;
  return { ...base, status: smoke.status, durationMs: smoke.durationMs,
    ...(smoke.httpStatus === undefined ? {} : { httpStatus: smoke.httpStatus }), ...(smoke.error ? { error: smoke.error } : {}) };
}

function summarizeApplication(entry: RecordEntry, registered: Registration | undefined,
  cases: InstallationCaseReport[], error?: string, stale = false, unfinished = false): ApplicationInstallationReport {
  const smokes = cases.filter(test => test.runner === 'smoke').map(test => ({
    name: test.appName === entry.requestedName ? test.name : `${test.appName}/${test.name}`, path: test.path,
    caseId: test.id, labUrl: test.labUrl,
    status: test.status as AppSmokeResult['status'], durationMs: test.durationMs,
    ...(test.error ? { error: test.error } : {}), ...(test.httpStatus === undefined ? {} : { httpStatus: test.httpStatus }) }));
  const failed = (Boolean(error) && !unfinished) || smokes.some(smoke => smoke.status === 'failed');
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
    let issue = registrationIssue(entry.record, registered);
    const members = entry.record?.manifest.kind === 'group' ? requiredAppDependencies(entry.record.manifest) : [];
    // A group holding an opt-in member is itself held inactive by the runtime: its own record says
    // only "App is inactive." while the CAUSE sits in the member. Name the member and keep the
    // group pending — enabling that member is the one operator action that activates both.
    const optIn = members.filter(name => resolved.get(name)?.manifest.status === 'inactive');
    if (issue && !issue.pending && optIn.length && entry.record?.status !== 'active') {
      issue = { pending: true,
        message: `Group waits on opt-in member(s) ${optIn.join(', ')}: activate them to verify this group.` };
    }
    for (const name of members) {
      const memberIssue = registrationIssue(resolved.get(name) ?? null, registrations.get(name));
      // A group cannot activate while a member is opt-in: that waits on the same operator action.
      if (memberIssue) issue ||= { message: `Member ${name}: ${memberIssue.message}`, pending: memberIssue.pending };
    }
    const error = issue?.message;
    const selected = (registered?.caseIds ?? []).map(id => tests.get(id)).filter((test): test is InstalledAppTestCase => Boolean(test));
    for (const test of selected) if (!error && !executed.has(test.id)) executed.set(test.id, await verifyCase(test, catalog, visible, options));
    apps.push(summarizeApplication(entry, registered, selected.map(test => error ? disposition(test) : { ...executed.get(test.id)! }), error, false, issue?.pending ?? false));
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
