/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Define installation evidence linked to registered Lab cases and format honest portable CLI reports.
 */
import type { AppSmokeApplicationResult, AppSmokeResult, AppSmokeVerificationResult } from './app-smoke-verifier';
import type { InstalledAppTestCase } from './installed-app-test-catalog';

/** @description A catalog case and its installation disposition; suites are never implicitly executed. */
export interface InstallationCaseReport {
  id: string;
  appName: string;
  appVersion: string;
  source: string;
  revision: string;
  name: string;
  path: string;
  level: InstalledAppTestCase['level'];
  runner: InstalledAppTestCase['runner']['kind'];
  installationEligible: boolean;
  status: AppSmokeResult['status'] | 'not-run';
  labUrl: string;
  error?: string;
  httpStatus?: number;
  durationMs: number;
}

/** @description Registration and smoke evidence for one installed package or its declared group members. */
export interface ApplicationInstallationReport extends AppSmokeApplicationResult {
  version?: string;
  verified: boolean;
  stale: boolean;
  registration: {
    coverage: 'catalog' | 'smoke-only' | 'not-declared' | 'members' | 'unavailable';
    caseCount: number;
    smokeCount: number;
    suiteCount: number;
    caseIds: string[];
  };
  cases: InstallationCaseReport[];
}

/** @description Preserve existing success/error fields while distinguishing verified checks from pending prerequisites. */
export interface InstallationVerificationReport extends AppSmokeVerificationResult {
  reportVersion: 1;
  verified: boolean;
  verificationStatus: AppSmokeResult['status'];
  apps: ApplicationInstallationReport[];
  summary: { registeredCases: number; smokesPassed: number; smokesFailed: number; smokesPending: number; suitesNotRun: number };
}

/** @description Link only to an existing Lab case identity; no package-controlled destination is accepted.
 * @param id Registered case identity. @returns Relative link focused after the Lab catalog loads. */
export function installationCaseUrl(id: string): string {
  return `/api/test-lab/app#${encodeURIComponent(`card-${id}`)}`;
}

function line(value: string): string { return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 240); }

/** @description Format the same server evidence for installers without requiring host Node, jq or a second runner.
 * @param report Completed or pending installation evidence. @returns Bounded text with a closed first-line status. */
export function formatInstallationVerification(report: InstallationVerificationReport): string {
  const { summary } = report;
  const rows = [`OSHAL_APP_VERIFICATION ${report.verificationStatus}`,
    `Registered cases: ${summary.registeredCases}; smoke passed: ${summary.smokesPassed}; failed: ${summary.smokesFailed}; pending: ${summary.smokesPending}; suites not run: ${summary.suitesNotRun}.`];
  for (const app of report.apps) {
    rows.push(`${line(app.appName)} ${line(app.version || 'not installed')}: ${app.status}; coverage=${app.registration.coverage}; registered=${app.registration.caseCount}.`);
    if (app.error) rows.push(`  ${line(app.error)}`);
    for (const test of app.cases) {
      rows.push(`  [${test.status}] ${line(test.id)}${test.httpStatus === undefined ? '' : ` HTTP ${test.httpStatus}`}`);
      rows.push(`    ${test.labUrl}`);
      if (test.error) rows.push(`    ${line(test.error)}`);
    }
  }
  return rows.join('\n') + '\n';
}
