#!/usr/bin/env node
/**
 * CHANGE LOG
 * SEQ | AUTHOR | DESCRIPTION
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Batch registered local Node and Node-harness browser recipes with explicit prerequisites and one report.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Forward cancellation, bound exact-owned cleanup and supply the TypeScript adapter as a portable file URL.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { runOwnedTestProcess } from './owned-test-process.mjs';

const core = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(core, 'package.json'));
const yaml = require('js-yaml'), ts = require('typescript');
const { loadPackageTestCatalog } = require('./scripts/oshal-test-catalog.js');
const hash = value => createHash('sha256').update(value).digest('hex');

/** @description Parse explicit package selectors without accepting shell commands. */
export function parseArgs(args) {
  const result = { packages: [], cases: [], level: 'all', run: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--run') { result.run = true; continue; }
    if (!['--package', '--case', '--level', '--report'].includes(flag) || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('Expected --package <directory> [--case <id>] [--level all|unit|integration|browser] [--report <new.json>] [--run]');
    const value = args[++i];
    if (flag === '--package') result.packages.push(path.resolve(value));
    else if (flag === '--case') result.cases.push(value);
    else if (flag === '--level') result.level = value;
    else if (result.report) throw Error('Select one report destination.');
    else result.report = path.resolve(value);
  }
  if (!result.packages.length || result.packages.length > 20 || new Set(result.packages).size !== result.packages.length) throw Error('Select one to twenty distinct package directories.');
  if (!['all', 'unit', 'integration', 'browser'].includes(result.level)) throw Error('Unsupported test level.');
  if (result.cases.some(id => !/^[a-z0-9][a-z0-9-]{0,79}$/.test(id))) throw Error('Invalid registered case ID.');
  return result;
}

/** @description Detect a real Node test harness; comments and string literals cannot opt a different runner in. */
export function nodeHarness(file, content = fs.readFileSync(file, 'utf8')) {
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  return source.statements.some(statement => ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === 'node:test');
}

/** @description Check local dependencies only; this command never installs browsers or packages. */
export function capabilities() {
  const values = new Set(['runner:node-test', 'runner:node', 'core:dependencies', 'harness:oshal-core-root', 'framework-checkout:oshal-core-dir']);
  if (fs.existsSync(path.join(core, 'src/shared/ui/css/surface-themes.css'))) values.add('core:shared-theme-assets');
  if (fs.existsSync(path.join(core, 'src/shared/ui/js/surface-bridge-client.js'))) values.add('core:surface-bridge');
  for (const name of ['tsx', 'express', 'multer', 'sharp']) {
    try { require.resolve(name); values.add('dependency:' + name); } catch { /* Missing stays pending. */ }
  }
  try {
    const { chromium } = require('playwright');
    if (fs.existsSync(chromium.executablePath())) { values.add('runner:playwright'); values.add('browser:chromium'); }
  } catch { /* Missing stays pending. */ }
  return values;
}

/** @description Plan only declared disposable recipes using the existing package catalog validator. */
export function plan(options, available = capabilities()) {
  const packages = options.packages.map(root => {
    const manifest = yaml.load(fs.readFileSync(path.join(root, 'oshal-app.yaml'), 'utf8'), { schema: yaml.JSON_SCHEMA });
    const loaded = loadPackageTestCatalog(root, manifest);
    if (!loaded) throw Error('Package has no registered test catalog: ' + manifest.name);
    const cases = loaded.catalog.cases.filter(test => (options.level === 'all' || test.level === options.level)
      && (!options.cases.length || options.cases.includes(test.id)));
    return { root, name: manifest.name, version: manifest.version, cases: cases.map(test => recipe(root, test, loaded.revisions[test.id], available)) };
  });
  for (const id of options.cases) if (!packages.some(pkg => pkg.cases.some(test => test.id === id))) throw Error('Registered case not found in selected level/packages: ' + id);
  if (!packages.some(pkg => pkg.cases.length)) throw Error('No registered cases match the selection.');
  return packages;
}

/** @description Preserve unsupported runner and prerequisite reasons instead of substituting readiness. */
function recipe(root, test, revision, available) {
  const reasons = [];
  if (!['node-test', 'playwright'].includes(test.runner.kind) || test.runner.scope !== 'package') reasons.push('Requires its declared ' + test.runner.kind + ' runner.');
  if (test.isolation.mode !== 'disposable' || !['none', 'fixture-write'].includes(test.sideEffects)) reasons.push('This host batch accepts disposable offline fixtures only.');
  for (const item of test.prerequisites) if (!available.has(item)) reasons.push('Missing prerequisite: ' + item);
  const files = test.runner.files || [];
  if (files.some(file => !/\.(?:[cm]?js|ts)$/.test(file))) reasons.push('No host adapter for a declared file type.');
  if (test.runner.kind === 'playwright' && files.some(file => !nodeHarness(path.join(root, file)))) reasons.push('Browser recipe requires a different Playwright harness.');
  const typescript = files.some(file => file.endsWith('.ts'));
  if (typescript && !available.has('dependency:tsx')) reasons.push('Missing prerequisite: dependency:tsx');
  return { id: test.id, name: test.name, level: test.level, revision, files, timeoutMs: test.limits.timeoutMs,
    typescript, status: reasons.length ? 'pending' : 'ready', reasons };
}

/** @description Give fixture processes known framework paths without forwarding service/provider credentials. */
export function childEnvironment(packageRoot) {
  const allowed = new Set(['path', 'systemroot', 'windir', 'temp', 'tmp', 'userprofile', 'home', 'appdata', 'localappdata', 'comspec', 'pathext', 'systemdrive']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())));
  return { ...env, CI: '1', OSHAL_CORE_ROOT: core, OSHAL_CORE_DIR: core, OSHAL_FRAMEWORK_ROOT: core,
    OSHAL_PUBLIC_STORE_ROOT: path.dirname(packageRoot) };
}

/** @description Require an executed nonempty TAP summary; exit zero alone is not a test pass. */
export function verdict(code, output, timedOut) {
  const counts = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...output.matchAll(new RegExp('^# ' + key + ' (\\d+)\\s*$', 'gm'))];
    counts[key] = matches.length === 1 ? Number(matches[0][1]) : null;
  }
  const passed = code === 0 && !timedOut && counts.tests > 0 && counts.pass === counts.tests
    && ['fail', 'cancelled', 'skipped', 'todo'].every(key => counts[key] === 0);
  return { status: passed ? 'passed' : 'failed', exitCode: code, timedOut, counts };
}

/** @description Execute one fixed Node invocation and retain a bounded transcript. */
export async function execute(root, test, options = {}) {
  const args = [...(test.typescript ? ['--import', pathToFileURL(require.resolve('tsx')).href] : []), '--test', '--test-concurrency=1', '--test-reporter=tap', ...test.files];
  const startedAt = Date.now();
  const result = await runOwnedTestProcess(process.execPath, args, { cwd: root, env: childEnvironment(root),
    timeoutMs: test.timeoutMs + 15000, signal: options.signal });
  const judged = verdict(result.code, result.output, result.timedOut || result.cancelled || !result.cleanup?.exitVerified);
  return { ...judged, timedOut: result.timedOut, cancelled: result.cancelled, cleanup: result.cleanup,
    durationMs: Date.now() - startedAt, output: result.output, outputSha256: hash(result.output) };
}

/** @description Run recipes serially, including browser suites, and keep one honest aggregate report. */
export async function runBatch(packages, run = execute) {
  const results = [], queue = packages.flatMap(pkg => pkg.cases.map(test => ({ pkg, test })));
  const controller = new AbortController(), cancel = () => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  let stopped = false;
  try {
  for (const { pkg, test } of queue) {
    const row = { package: pkg.name, version: pkg.version, ...test };
    if ((stopped || controller.signal.aborted) && test.status === 'ready') Object.assign(row, { status: 'deferred', reasons: ['Batch stopped after cancellation, timeout or unverified cleanup.'] });
    else if (test.status === 'ready') {
      try {
        const fresh = plan({ packages: [pkg.root], cases: [test.id], level: 'all' })[0].cases[0];
        if (fresh.revision !== test.revision) Object.assign(row, { status: 'failed', error: 'Registered recipe changed before execution.' });
        else if (fresh.status !== 'ready') Object.assign(row, { status: 'pending', reasons: fresh.reasons });
        else Object.assign(row, await run(pkg.root, test, { signal: controller.signal }));
      } catch { Object.assign(row, { status: 'failed', error: 'Registered recipe is unavailable or the runner could not start.' }); }
    }
    results.push(row);
    if (row.timedOut || row.cancelled || row.cleanup?.exitVerified === false) stopped = true;
  }
  return results;
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}

async function main() {
  const options = parseArgs(process.argv.slice(2)), packages = plan(options);
  if (options.report && fs.existsSync(options.report)) throw Error('Report already exists; select a new output file.');
  const cases = options.run ? await runBatch(packages) : packages.flatMap(pkg => pkg.cases.map(test => ({ package: pkg.name, version: pkg.version, ...test })));
  const counts = Object.fromEntries(['ready', 'passed', 'failed', 'pending', 'deferred'].map(state => [state, cases.filter(test => test.status === state).length]));
  const report = { createdAt: new Date().toISOString(), mode: options.run ? 'run' : 'plan', counts, cases,
    limits: ['Local checkout evidence; not installed application acceptance.', 'Unsupported runners and prerequisites stay pending.', 'Browser fixtures own their cleanup; a timeout stops this batch.'] };
  if (options.report) { fs.mkdirSync(path.dirname(options.report), { recursive: true }); fs.writeFileSync(options.report, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); }
  console.log(JSON.stringify({ mode: report.mode, counts, cases: cases.map(({ package: app, id, status, reasons, error }) => ({ package: app, id, status, reasons, error })), report: options.report || null }, null, 2));
  if (counts.failed || counts.deferred) process.exitCode = 1; else if (options.run && counts.pending) process.exitCode = 2;
}
if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
