/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise the scheduled local runner through real child-process exit, reports, failed and skipped suites, and credential isolation.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NIGHTLY_ISOLATED_SUITES, assessTestReport, isolatedEnvironment, runNightlyIsolated } from '../../scripts/ci/run-nightly-isolated.mjs';

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fakeRoot(status: 'passed' | 'failed' | 'pending', exit: number, omitReport = false): string {
  const root = mkdtempSync(resolve(tmpdir(), 'oshal-nightly-runner-')); scratch.push(root);
  mkdirSync(resolve(root, 'node_modules/vitest'), { recursive: true });
  const source = `import {writeFileSync} from 'node:fs';
const output=process.argv.find(arg=>arg.startsWith('--outputFile=')).slice(13);
const paths=process.argv.filter(arg=>arg.startsWith('tests/unit/'));
const statuses=${JSON.stringify(status)};
if(!${omitReport})writeFileSync(output,JSON.stringify({testResults:paths.map(path=>({name:process.cwd()+'/'+path,status:statuses==='passed'?'passed':'failed',assertionResults:[{status:statuses}]}))}));
if(process.env.SWARM_SERVICE_SECRET || process.env.DATABASE_URL)throw new Error('deployment credentials leaked');
console.log('fixture child completed'); process.exit(${exit});`;
  writeFileSync(resolve(root, 'node_modules/vitest/vitest.mjs'), source);
  return root;
}
describe('retained local nightly result', () => {
  it('runs the scheduled invocation and retains distinct complete results without overwriting an older run', async () => {
    const root = fakeRoot('passed', 0); const reportsRoot = resolve(root, 'reports');
    const first = await runNightlyIsolated({ root, reportsRoot, scheduled: true });
    const second = await runNightlyIsolated({ root, reportsRoot });
    expect(first.status).toBe('passed'); expect(first.invocation).toBe('scheduled-invocation');
    expect(first.runDirectory).not.toBe(second.runDirectory);
    expect(JSON.parse(readFileSync(resolve(first.runDirectory, 'result.json'), 'utf8')).status).toBe('passed');
    expect(readFileSync(first.outputLog, 'utf8')).toContain('fixture child completed');
    expect(first.notRun).toContain('unattended-scheduler-proof');
    expect(first.source.selection).toBe('working-tree');
  });
  it.each([['failed', 1], ['passed', 9], ['pending', 0]] as const)('keeps a %s suite / exit %s red', async (status, exit) => {
    const root = fakeRoot(status, exit);
    const result = await runNightlyIsolated({ root, reportsRoot: resolve(root, 'reports') });
    expect(result.status).toBe('failed'); expect(result.exitCode).toBe(exit);
  });
  it('cannot turn a missing report into a passing scheduler result', async () => {
    const root = fakeRoot('passed', 0, true);
    const result = await runNightlyIsolated({ root, reportsRoot: resolve(root, 'reports') });
    expect(result.status).toBe('failed'); expect(result.suites.every(suite => suite.status === 'not-run')).toBe(true);
  });
  it('removes deployment credentials and refuses an incomplete suite inventory', () => {
    const env = isolatedEnvironment({ PATH: 'fixture-path', HOME: 'fixture-home', DATABASE_URL: 'must-not-survive',
      SWARM_SERVICE_SECRET: 'must-not-survive', ALERT_WEBHOOK_TOKEN: 'must-not-survive', AWS_SECRET_ACCESS_KEY: 'must-not-survive' });
    expect(JSON.stringify(env)).not.toContain('must-not-survive'); expect(env.PATH).toBe('fixture-path');
    const result = assessTestReport({ testResults: [{ name: `/fixture/${NIGHTLY_ISOLATED_SUITES[0]}`, status: 'passed', assertionResults: [{ status: 'passed' }] }] }, 0);
    expect(result.status).toBe('failed'); expect(result.suites.filter(suite => suite.status === 'not-run').length).toBeGreaterThan(0);
  });
});
