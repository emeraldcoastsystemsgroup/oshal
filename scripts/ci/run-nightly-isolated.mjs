#!/usr/bin/env node
/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Retain truthful local nightly fixture results without using deployment credentials or calling live endpoints.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const NIGHTLY_ISOLATED_SUITES = Object.freeze([
  'tests/unit/alert-incident-cutover.spec.ts',
  'tests/unit/alert-incident-reopen.spec.ts',
  'tests/unit/topology-traversal.spec.ts',
  'tests/unit/alert-postgres-isolation.spec.ts',
  'tests/unit/nightly-isolated-runner.spec.ts',
  'tests/unit/ci-local-scheduled-ref.spec.ts',
  'tests/unit/ci-local-run-log.spec.ts',
  'tests/unit/ci-gate-streak.spec.ts',
]);

/** Only OS/Docker discovery settings survive into the test process; never deployment service keys. */
export function isolatedEnvironment(ambient = process.env) {
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC',
    'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY']);
  const safe = Object.fromEntries(Object.entries(ambient).filter(([key, value]) => allowed.has(key.toUpperCase()) && value !== undefined));
  return { ...safe, NODE_ENV: 'test', CI: 'true', FORCE_COLOR: '0', LOG_LEVEL: 'silent',
    GIT_TERMINAL_PROMPT: '0', DATABASE_URL: '', TEST_DATABASE_URL: '', ALERT_PIPELINE_TEST_DSN: '',
    ALERT_PIPELINE_TEST_DATABASE_URL: '', SWARM_SERVICE_SECRET: '', ALERT_WEBHOOK_TOKEN: '' };
}

/** A zero process exit alone is insufficient: missing, skipped or unreported suites remain red. */
export function assessTestReport(report, exitCode) {
  const results = Array.isArray(report?.testResults) ? report.testResults : [];
  const suites = NIGHTLY_ISOLATED_SUITES.map(path => {
    const result = results.find(row => typeof row.name === 'string' && row.name.replaceAll('\\', '/').endsWith(`/${path}`));
    const assertions = Array.isArray(result?.assertionResults) ? result.assertionResults : [];
    const passed = assertions.filter(item => item.status === 'passed').length;
    const failed = assertions.filter(item => item.status === 'failed').length;
    const skipped = assertions.length - passed - failed;
    const status = !result ? 'not-run' : result.status === 'passed' && passed > 0 && failed === 0 && skipped === 0 ? 'passed' : 'failed';
    return { path, status, passed, failed, skipped };
  });
  return { status: exitCode === 0 && suites.every(suite => suite.status === 'passed') ? 'passed' : 'failed', suites };
}

/** Launch only the fixed fixture suite and bound its complete process tree. */
async function execute(root, reportPath, logPath, timeoutMs) {
  const output = createWriteStream(logPath, { flags: 'wx' });
  const child = spawn(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run',
    '--no-file-parallelism', '--hookTimeout', '120000', '--reporter=json', `--outputFile=${reportPath}`,
    ...NIGHTLY_ISOLATED_SUITES], { cwd: root, env: isolatedEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === 'win32' && child.pid) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 }); }
      catch { child.kill('SIGKILL'); }
    } else child.kill('SIGKILL');
  }, timeoutMs);
  const exitCode = await new Promise(resolveExit => {
    child.once('error', () => resolveExit(1));
    child.once('close', code => resolveExit(code ?? 1));
  });
  clearTimeout(timer);
  await new Promise(resolveEnd => output.end(resolveEnd));
  return { exitCode: timedOut ? 124 : exitCode, timedOut };
}

/** Callable by local CI and a task scheduler; scheduled invocation does not claim an unattended run. */
export async function runNightlyIsolated({ root = ROOT, reportsRoot = resolve(ROOT, 'temp/nightly-isolated'), scheduled = false, timeoutMs = 900_000 } = {}) {
  mkdirSync(reportsRoot, { recursive: true });
  const runDirectory = mkdtempSync(resolve(reportsRoot, `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-`));
  const startedAt = new Date().toISOString();
  let commit = null;
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { /* export has no git metadata */ }
  const reportPath = resolve(runDirectory, 'vitest.json');
  const logPath = resolve(runDirectory, 'output.log');
  const processResult = await execute(root, reportPath, logPath, timeoutMs);
  let report = null;
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')); } catch { /* missing report is a failed gate */ }
  const result = { version: 1, gate: 'nightly-isolated', invocation: scheduled ? 'scheduled-invocation' : 'manual',
    source: { selection: 'working-tree', commit }, startedAt, finishedAt: new Date().toISOString(),
    ...processResult, ...assessTestReport(report, processResult.exitCode),
    notRun: ['full-unit', 'e2e-green', 'image-build', 'trivy', 'live-golden', 'unattended-scheduler-proof'],
    outputLog: logPath, rawReport: reportPath };
  writeFileSync(resolve(runDirectory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  const rows = result.suites.map(suite => `| ${suite.path} | ${suite.status} | ${suite.passed} | ${suite.failed} | ${suite.skipped} |`);
  writeFileSync(resolve(runDirectory, 'result.md'), [
    '# Local nightly fixture result', '', `Result: **${result.status.toUpperCase()}**; invocation: ${result.invocation}.`,
    `Source: working tree at ${commit ?? 'unknown commit'}; this is not a committed-source or unattended-run claim.`,
    `Window: ${startedAt} to ${result.finishedAt}.`, '', '| Suite | Status | Passed | Failed | Skipped |',
    '|---|---|---|---|---|', ...rows, '', `Not run: ${result.notRun.join(', ')}.`,
    'Database fixtures use disposable containers. No deployment endpoints, alerts or account writes were invoked.', '',
  ].join('\n'));
  return { ...result, runDirectory };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--scheduled')) { process.stderr.write('Usage: node scripts/ci/run-nightly-isolated.mjs [--scheduled]\n'); process.exitCode = 2; }
  else runNightlyIsolated({ scheduled: args.includes('--scheduled') }).then(result => {
    process.stdout.write(`nightly-isolated: ${result.status.toUpperCase()} (${result.runDirectory})\n`);
    process.exitCode = result.status === 'passed' ? 0 : 1;
  }).catch(error => { process.stderr.write(`nightly-isolated failed: ${error.message}\n`); process.exitCode = 1; });
}
