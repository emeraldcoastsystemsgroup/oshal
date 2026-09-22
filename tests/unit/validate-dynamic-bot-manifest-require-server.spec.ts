/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for scripts/validate-dynamic-bot-manifest.mjs --require-server. The validator is cited as the live-boundary closure for the k8s bot launcher, and with no reachable cluster it used to fall back to a client-side dry-run, skip the deployments/scale discovery and EXIT 0 - a pass that proved nothing about any API server. This RUNS the real validator (through tsx, as documented, rendering the launcher's real manifest) with a kubectl stand-in first on PATH and asserts: --require-server exits non-zero when kubectl reports no cluster, when kubectl is absent, when discovery lacks deployments/scale, and when the dry-run output does not show server-side admission for every object; it passes only when every server-side check does; and the default mode's client-side path still exits 0 but is labelled NOT A PROOF.
 *
 * SCOPED DOUBLE (real-boundary audit): kubectl and the API server behind it. The stand-in is a copy
 * of the node binary named kubectl that loads a preload emulator through NODE_OPTIONS - a script
 * file cannot stand in for an executable that Node's spawnSync resolves from PATH on Windows. The
 * claim here is the validator's REFUSAL DECISION, which runs for real: argument parsing, PATH
 * resolution of `kubectl`, the probe, the fallback, the output checks and the exit code. What a real
 * API server admits is not this claim; its real companion is the same script run with
 * --require-server against a reachable cluster (`ci-local.sh --cluster-gates`, work-package item 12).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../..');
const VALIDATOR = 'scripts/validate-dynamic-bot-manifest.mjs';
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const RUN_TIMEOUT_MS = 120_000;

/** What the stand-in kubectl behaves like. `absent` puts no kubectl on PATH at all. */
type Cluster = 'unreachable' | 'reachable' | 'reachable-no-scale' | 'reachable-client-marks' | 'absent';

/**
 * The emulator, preloaded into the node binary that is standing in for kubectl. It is a no-op in
 * every other node process (tsx and the validator itself), which it tells apart by the executable's
 * name. Output mirrors kubectl's own formats: `<kind>.<group>/<name> created (server dry run)`.
 */
const EMULATOR = String.raw`
const fs = require('node:fs');
const path = require('node:path');
if (/^kubectl(\.exe)?$/i.test(path.basename(process.execPath))) {
  const argv = [path.basename(process.argv[1] || ''), ...process.argv.slice(2)];
  const mode = process.env.OSHAL_TEST_KUBECTL_CLUSTER || 'unreachable';
  if (process.env.OSHAL_TEST_KUBECTL_LOG) fs.appendFileSync(process.env.OSHAL_TEST_KUBECTL_LOG, JSON.stringify(argv) + '\n');
  const reachable = mode.startsWith('reachable');
  const done = (code, out, err) => { if (out) process.stdout.write(out); if (err) process.stderr.write(err); process.exit(code); };
  const refused = 'The connection to the server 127.0.0.1:6443 was refused - did you specify the right host or port?\n';
  const [cmd, ...rest] = argv;
  if (cmd === 'cluster-info') {
    reachable ? done(0, 'Kubernetes control plane is running at https://127.0.0.1:6443\n') : done(1, '', refused);
  }
  if (cmd === 'get' && rest[0] === 'namespace') reachable ? done(0, 'NAME STATUS AGE\n' + rest[1] + ' Active 1d\n') : done(1, '', refused);
  if (cmd === 'apply') {
    const dryRun = (rest.find((a) => a.startsWith('--dry-run=')) || '').slice('--dry-run='.length);
    if (dryRun === 'server' && !reachable) done(1, '', refused);
    const marker = dryRun === 'server' && mode !== 'reachable-client-marks' ? '(server dry run)' : '(dry run)';
    const docs = fs.readFileSync(0, 'utf8').split('\n---\n').filter((d) => d.trim()).map((d) => JSON.parse(d));
    const lines = docs.map((m) => {
      const group = m.apiVersion.includes('/') ? '.' + m.apiVersion.split('/')[0] : '';
      return m.kind.toLowerCase() + group + '/' + m.metadata.name + ' created ' + marker;
    });
    done(0, lines.join('\n') + '\n');
  }
  if (cmd === 'get' && rest[0] === '--raw' && rest[1] === '/apis/apps/v1') {
    if (!reachable) done(1, '', refused);
    const resources = [{ name: 'deployments', verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'] }];
    if (mode !== 'reachable-no-scale') resources.push({ name: 'deployments/scale', verbs: ['get', 'patch', 'update'] });
    done(0, JSON.stringify({ kind: 'APIResourceList', groupVersion: 'apps/v1', resources }));
  }
  done(1, '', 'kubectl stand-in: unhandled call ' + JSON.stringify(argv) + '\n');
}
`;

let sandbox = '';
let binDir = '';
let emptyDir = '';
let emulatorPath = '';
let runCount = 0;

beforeAll(() => {
  if (!fs.existsSync(TSX_CLI)) throw new Error(`tsx is required to run the validator as documented and was not found at ${TSX_CLI}`);
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-validator-require-server-'));
  binDir = path.join(sandbox, 'bin');
  emptyDir = path.join(sandbox, 'empty');
  fs.mkdirSync(binDir);
  fs.mkdirSync(emptyDir);
  emulatorPath = path.join(sandbox, 'kubectl-emulator.cjs');
  fs.writeFileSync(emulatorPath, EMULATOR, 'utf8');
  const standIn = path.join(binDir, process.platform === 'win32' ? 'kubectl.exe' : 'kubectl');
  try {
    fs.linkSync(process.execPath, standIn);
  } catch {
    fs.copyFileSync(process.execPath, standIn);
  }
  fs.chmodSync(standIn, 0o755);
});

afterAll(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

interface ValidatorRun {
  status: number | null;
  out: string;
  calls: string[][];
}

/**
 * @description Run the real validator with a PATH that holds only the kubectl stand-in (or nothing,
 * for `absent`), so the real kubectl on the box can never be reached.
 * @param args validator arguments
 * @param cluster what the stand-in behaves like
 * @returns the exit status, combined output, and every call the stand-in received
 */
function runValidator(args: string[], cluster: Cluster): ValidatorRun {
  const log = path.join(sandbox, `calls-${runCount += 1}.log`);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!['PATH', 'NODE_OPTIONS'].includes(key.toUpperCase())) env[key] = value;
  }
  env.PATH = cluster === 'absent' ? emptyDir : binDir;
  env.NODE_OPTIONS = `--require "${emulatorPath.replaceAll('\\', '/')}"`;
  env.OSHAL_TEST_KUBECTL_CLUSTER = cluster;
  env.OSHAL_TEST_KUBECTL_LOG = log;
  const res = spawnSync(process.execPath, [TSX_CLI, VALIDATOR, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
  });
  if (res.error) throw res.error;
  const calls = fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[])
    : [];
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}`, calls };
}

describe('validate-dynamic-bot-manifest --require-server refuses to pass without an API server', () => {
  it('exits non-zero when kubectl reports no cluster, and never falls back to a client-side dry-run', () => {
    const run = runValidator(['--require-server'], 'unreachable');
    expect(run.status, run.out).not.toBe(0);
    expect(run.status, run.out).not.toBeNull();
    expect(run.out).toContain('FAILED (--require-server): no API server reachable');
    expect(run.out).toContain('The connection to the server 127.0.0.1:6443 was refused');
    expect(run.calls.map((c) => c[0]), 'no apply may follow a failed probe in this mode').toEqual(['cluster-info']);
  }, RUN_TIMEOUT_MS);

  it('exits non-zero when kubectl is not on PATH at all', () => {
    const run = runValidator(['--require-server'], 'absent');
    expect(run.status, run.out).not.toBe(0);
    expect(run.status, run.out).not.toBeNull();
    expect(run.out).toContain('kubectl is not on PATH');
  }, RUN_TIMEOUT_MS);

  it('fails when the API server does not expose deployments/scale - the discovery check is not optional', () => {
    const run = runValidator(['--require-server'], 'reachable-no-scale');
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('does not expose deployments/scale');
  }, RUN_TIMEOUT_MS);

  it('fails when kubectl exits 0 but the output does not show server-side admission for every object', () => {
    const run = runValidator(['--require-server'], 'reachable-client-marks');
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('only 0 of 2 objects report "(server dry run)"');
  }, RUN_TIMEOUT_MS);

  it('passes only on the two server lines: server-side admission and deployments/scale with patch', () => {
    const run = runValidator(['--require-server', '--namespace', 'oshal'], 'reachable');
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain('dry-run mode: server (validated by the real API server; nothing created)');
    expect(run.out).toContain('OK: the API server exposes deployments/scale with verbs [get, patch, update]');
    expect(run.out).not.toContain('NOT A PROOF');
    const verbs = run.calls.map((c) => c.join(' '));
    expect(verbs).toContain('apply -f - -n oshal --dry-run=server');
    expect(verbs).toContain('get --raw /apis/apps/v1');
  }, RUN_TIMEOUT_MS);
});

describe('the default mode keeps its offline shape check, labelled as not a proof', () => {
  it('still exits 0 with no cluster, but every line that could be read as evidence says NOT A PROOF', () => {
    const run = runValidator([], 'unreachable');
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain('dry-run mode: client');
    expect(run.out).toContain('WARNING: client-side only - NOT A PROOF');
    expect(run.out).toContain('deployments/scale was not confirmed against a real API server. NOT A PROOF.');
    expect(run.out).toContain('OK (client-side shape check only)');
    expect(run.out).not.toContain('OK: the API server exposes deployments/scale');
    expect(run.calls.map((c) => c.join(' '))).toContain('apply -f - -n oshal --dry-run=client');
  }, RUN_TIMEOUT_MS);
});
