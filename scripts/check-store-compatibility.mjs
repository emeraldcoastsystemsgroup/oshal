#!/usr/bin/env node
/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Check pinned core/store commits in disposable exports with retained diagnostics and an optional real-compiler rejection proof.
 */
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'node scripts/check-store-compatibility.mjs [--core <repo>] [--core-ref <ref>] [--store <repo>] [--store-ref <ref>] [--dependencies <provisioned-core>] [--reports <directory>] [--prove-rejection]';

/** @description Publish a complete report atomically so readers never observe truncated JSON. */
function saveReport(file, report) {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/** @description Execute without a shell and retain complete subprocess output when a log is supplied. */
function command(executable, args, { cwd, log, timeout = 120000 } = {}) {
  const fd = log ? openSync(log, 'a') : null;
  try {
    const result = spawnSync(executable, args, {
      cwd, encoding: 'utf8', windowsHide: true, timeout,
      maxBuffer: 32 * 1024 * 1024,
      ...(fd === null ? {} : { stdio: ['ignore', fd, fd] }),
    });
    if (result.error || result.status !== 0) {
      throw new Error(`${executable} exited ${result.status ?? result.signal ?? 'without status'}: ${result.error?.message ?? result.stderr ?? ''}${log ? `; see ${log}` : ''}`);
    }
    return result.stdout?.trim() ?? '';
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** @description Resolve a commit once; later branch movement cannot change this run's inputs. */
function pin(repo, ref) {
  const sha = command('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], { cwd: repo });
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error(`Invalid commit for ${repo}`);
  return sha;
}

/** @description Export only committed files, never an operator's working files or ignored secrets. */
function exportCommit(repo, sha, scratch, name) {
  const destination = join(scratch, name);
  const archive = join(scratch, `${name}.tar`);
  mkdirSync(destination);
  command('git', ['archive', '--format=tar', '--output', archive, sha], { cwd: repo });
  command('tar', ['-xf', archive, '-C', destination]);
  unlinkSync(archive);
  return destination;
}

/** @description Keep disposable exports outside both checkouts even when TMPDIR points into a repo. */
function outsideRepos(path, repos) {
  for (const repo of repos) {
    const rel = relative(realpathSync(repo), realpathSync(path));
    if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) {
      throw new Error(`Scratch/report directory must be outside repository: ${path}`);
    }
  }
}

/** @description Provision locked dependencies or explicitly reuse an already provisioned matching core tree. */
function dependencies(core, provisioned, report) {
  if (provisioned) {
    for (const file of ['package.json', 'package-lock.json']) {
      if (readFileSync(join(core, file), 'utf8').replaceAll('\r\n', '\n') !== readFileSync(join(provisioned, file), 'utf8').replaceAll('\r\n', '\n')) {
        throw new Error(`Dependency reuse refused: ${file} differs from pinned core; omit --dependencies for npm ci`);
      }
    }
    const modules = realpathSync(join(provisioned, 'node_modules'));
    if (!existsSync(join(modules, 'typescript', 'bin', 'tsc'))) throw new Error('Provisioned TypeScript compiler missing');
    symlinkSync(modules, join(core, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    report.dependencies = 'reused matching manifest/lockfile (caller-provisioned node_modules)';
    return true;
  }
  // npm.cmd requires a shell on Windows; execute npm's actual Node entry instead.
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const args = ['ci', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'];
  const log = join(report.directory, 'dependencies.log');
  if (process.platform === 'win32') command(process.execPath, [npmCli, ...args], { cwd: core, log, timeout: 1800000 });
  else command('npm', args, { cwd: core, log, timeout: 1800000 });
  report.dependencies = 'npm ci from pinned lockfile; lifecycle scripts disabled';
  return false;
}

/** @description Add a deliberately dishonest ambient export and its consumer only inside the disposable store. */
function addRejectionFixture(store) {
  const root = join(store, 'compatibility-negative-probe');
  if (existsSync(root)) throw new Error('Rejection fixture name already exists');
  mkdirSync(join(root, 'src-routes'), { recursive: true });
  writeFileSync(join(root, 'oshal-app.yaml'), 'name: compatibility-negative-probe\nroutes:\n  - module: routes/probe.js\n    factory: createProbe\n    mountPath: /api/compatibility-negative-probe\n    auth: oidc\n');
  const module = '@/shared/workspace-root';
  writeFileSync(join(root, 'src-routes', 'core-modules.d.ts'), `declare module '${module}' { export const inventedCompatibilityExport: number; }\n`);
  writeFileSync(join(root, 'src-routes', 'probe.ts'), `import { inventedCompatibilityExport } from '${module}';\nexport function createProbe() { return inventedCompatibilityExport; }\n`);
}

/** @description Check committed core/store compatibility and preserve a unique report on every outcome. */
export function checkCompatibility(options = {}) {
  const coreRepo = realpathSync(resolve(options.core ?? CORE));
  const storeRepo = realpathSync(resolve(options.store ?? join(coreRepo, '..', 'oshal-applications')));
  const reports = resolve(options.reports ?? join(tmpdir(), 'oshal-compatibility-reports'));
  mkdirSync(reports, { recursive: true });
  outsideRepos(reports, [coreRepo, storeRepo]);
  outsideRepos(tmpdir(), [coreRepo, storeRepo]);
  const directory = mkdtempSync(join(reports, 'run-'));
  const report = { directory, startedAt: new Date().toISOString(), status: 'running' };
  const reportFile = join(directory, 'result.json');
  let scratch;
  let core;
  let linked = false;
  console.log(`Compatibility report: ${reportFile}`);
  try {
    report.coreSha = pin(coreRepo, options.coreRef ?? 'HEAD');
    report.storeSha = pin(storeRepo, options.storeRef ?? 'HEAD');
    console.log(`Pinned core=${report.coreSha} store=${report.storeSha}`);
    saveReport(reportFile, report);
    scratch = mkdtempSync(join(tmpdir(), 'oshal-compatibility-'));
    report.scratch = scratch;
    core = exportCommit(coreRepo, report.coreSha, scratch, 'core');
    const store = exportCommit(storeRepo, report.storeSha, scratch, 'store');
    linked = dependencies(core, options.dependencies, report);
    const compiler = join(store, 'scripts', 'security', 'rebuild-store-routes.mjs');
    const args = [compiler, '--store', store, '--framework', core, '--check-only'];
    const log = join(directory, 'compile.log');
    report.phase = 'compiling';
    saveReport(reportFile, report);
    command(process.execPath, args, { cwd: core, log, timeout: 1200000 });
    report.summary = readFileSync(log, 'utf8').trim();
    if (!/Canonical store compatibility passed: [1-9]\d* sources across [1-9]\d* packages/.test(report.summary)) {
      throw new Error('Compiler exited successfully without a nonempty package compilation summary');
    }
    console.log(report.summary);
    if (options.proveRejection) {
      addRejectionFixture(store);
      const negativeLog = join(directory, 'rejection.log');
      let rejected = false;
      try { command(process.execPath, args, { cwd: core, log: negativeLog, timeout: 1200000 }); }
      catch { rejected = true; }
      const diagnostic = readFileSync(negativeLog, 'utf8');
      if (!rejected || !/compatibility-negative-probe\/probe\.ts.*error TS2305.*inventedCompatibilityExport/.test(diagnostic.replaceAll('\\', '/'))) {
        throw new Error(`Rejection proof failed: expected TS2305 at the invented package export; see ${negativeLog}`);
      }
      report.rejectionProof = 'passed: ambient invented export rejected by real framework compiler (TS2305)';
      console.log(report.rejectionProof);
    }
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
  } finally {
    try {
      // Unlink the junction itself before recursively removing only our own mkdtemp export.
      if (linked) unlinkSync(join(core, 'node_modules'));
      if (scratch) rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
      report.cleaned = true;
    } catch (error) {
      report.status = 'failed';
      report.cleanupError = error.message;
    }
    report.finishedAt = new Date().toISOString();
    saveReport(reportFile, report);
  }
  if (report.status !== 'passed') throw new Error(`${report.error ?? report.cleanupError}; report: ${reportFile}`);
  return report;
}

/** @description Parse explicit repository/ref pairs and refuse misspelled or duplicate options. */
function parseArgs(args) {
  const options = {};
  const values = { '--core': 'core', '--core-ref': 'coreRef', '--store': 'store', '--store-ref': 'storeRef', '--dependencies': 'dependencies', '--reports': 'reports' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prove-rejection' && !options.proveRejection) { options.proveRejection = true; continue; }
    const key = values[args[i]];
    if (!key || options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(USAGE);
    options[key] = args[++i];
  }
  return options;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--help')) console.log(USAGE);
    else checkCompatibility(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
