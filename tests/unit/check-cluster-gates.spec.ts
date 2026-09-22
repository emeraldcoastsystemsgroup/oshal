/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for scripts/ci/check-cluster-gates.sh, the one caller of the two live-cluster governance checks (docs/k8/remote-cluster-work-package.md item 7). The refusal and real-validator cases moved here unchanged from tests/unit/ci-local-k8s-gates.spec.ts (its CHANGE LOG entries 1 and 2 record how they were written) when that file split so the hosted CI Test job can run it without kubeconform or terraform. The three files share tests/helpers/k8s-gate-harness.ts. On Linux the case PATH is the host's tools with kubectl, node and npx left out, so a runner image that ships a real kubectl cannot answer for the stand-in.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The wrapper's reading of the validator it runs is now pinned directly, not only through the real validator (review of wp/validators, item 7). A recording validator stand-in (`npx` first on PATH) takes the wrapper PAST its own cluster-info probe against a kubectl stand-in that answers it. The wrapper starts the validator once, with --require-server, the context and the namespace, from the tree it judges. Any non-zero exit is not PASS, even when the output carries both server-side lines. An exit 0 that is client-side only (NOT A PROOF, on stdout or stderr), or that lacks either server-side line, is FAIL - the wrapper's new pass-signal check (check-cluster-gates.sh entry 2), and against the wrapper before it those 5 cases are red. With no API server answering, or no context, the validator is never started. Mutation-checked: ignoring the validator's exit code (7 cases red), dropping --require-server (3), dropping the pass-signal check (5), capturing stdout only (1), reporting the check's exit 2 as PASS (3), ignoring tenant-isolation's exit code (4).
 *
 * SCOPED DOUBLES (real-boundary audit): kubectl and the cluster behind it - a unit run must never
 * reach the live cluster on this box. The claim here is the wrapper's REFUSAL, VERDICT and WIRING
 * decisions, which run for real in the shipped scripts. In the real-validator cases npx, tsx and
 * the shipped validator run for real too; on Windows the kubectl stand-in is reached from Node
 * through a kubectl.exe that only forwards to it. In the recording-validator cases `npx` itself is
 * doubled, because their claim is what the wrapper does with each outcome a validator can report.
 * The real companion is `ci-local.sh --cluster-gates` on a reachable cluster (work-package items 12
 * and 13).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BASH, KUBECTL_STAND_IN, REPO_ROOT, RUN_TIMEOUT_MS, SCRIPTS,
  cleanEnv, hostTools, kubectlEnv, makeScratch, onlyPath, posix, readCalls, recordingScript, runBash, writeStandIn, writeTree,
} from '../helpers/k8s-gate-harness';

const CONTEXT = 'ctx-under-test';
const NAMESPACE = 'ns-under-test';
const SCRATCH = makeScratch('oshal-cluster-gates-');
/** The host's shell tools, with no kubectl, node or npx among them. */
const TOOL_PATH = hostTools(SCRATCH);
const STAND_INS = path.join(SCRATCH, 'stand-ins');
const NPX_DIR = path.join(SCRATCH, 'stand-ins-npx');
const TRAMPOLINE_DIR = path.join(SCRATCH, 'stand-ins-exe');
/** Where node, npm and npx live: the real-validator cases run `npx tsx`, so they need them on PATH. */
const NODE_DIR = path.dirname(process.execPath);
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

/** The two lines work-package 4.3 names as the bot-manifest pass signal, exactly as the validator prints them. */
const SERVER_DRY_RUN_LINE = 'dry-run mode: server (validated by the real API server; nothing created)';
const SCALE_DISCOVERY_LINE = 'OK: the API server exposes deployments/scale with verbs [get, patch, update]';
const VALIDATOR_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'validate-dynamic-bot-manifest.mjs'), 'utf8');

/** What the validator prints on a server-side proof (stdout). */
const SERVER_OUT = `${SERVER_DRY_RUN_LINE}
deployment.apps/validate-dynamic-bot created (server dry run)
service/validate-dynamic-bot created (server dry run)

OK: the dynamic bot manifest is accepted by kubectl apply --dry-run=server.
${SCALE_DISCOVERY_LINE} — the enable/disable toggle PATCHes that path.
`;
/** What its default mode prints with no API server: stdout, then the two warnings on stderr. */
const CLIENT_OUT = `dry-run mode: client (no cluster reachable — schema only)
deployment.apps/validate-dynamic-bot created (dry run)
service/validate-dynamic-bot created (dry run)

OK (client-side shape check only): kubectl apply --dry-run=client accepted the dynamic bot manifest.
`;
const CLIENT_ERR = `
WARNING: client-side only - NOT A PROOF. No API server saw this manifest; re-run with --require-server against a cluster for admission evidence.
WARNING: no cluster reachable — deployments/scale was not confirmed against a real API server. NOT A PROOF.
`;

/** Recording validator stand-in: logs its argv and cwd, prints the scripted stdout and stderr, exits as told. */
const NPX_STAND_IN = recordingScript(`cat "\${OSHAL_TEST_VALIDATOR_OUT:-/dev/null}"
cat "\${OSHAL_TEST_VALIDATOR_ERR:-/dev/null}" >&2
exit "\${OSHAL_TEST_VALIDATOR_RC:-0}"
`);

beforeAll(() => {
  writeStandIn(STAND_INS, 'kubectl', KUBECTL_STAND_IN);
  writeStandIn(NPX_DIR, 'npx', NPX_STAND_IN);
});

/** @description A kubectl-stand-in environment whose PATH holds only the stand-in and the host's shell tools. */
function clusterEnv(cluster: string, extra: Record<string, string> = {}): ReturnType<typeof kubectlEnv> {
  return kubectlEnv(SCRATCH, cluster, [STAND_INS, TOOL_PATH], extra);
}

describe('cluster gates refuse without a named, reachable cluster and never report a pass they did not earn', () => {
  it('refuses with no OSHAL_CLUSTER_CONTEXT, before asking kubectl anything', () => {
    for (const which of ['bot-manifest', 'tenant-isolation']) {
      const { env, calls } = clusterEnv('isolating');
      const run = runBash([SCRIPTS.cluster, which], env);
      expect(run.status, run.out).toBe(2);
      expect(run.out).toContain(`cluster-${which}: UNCHECKED - OSHAL_CLUSTER_CONTEXT is not set`);
      expect(calls(), 'no context means no kubectl call at all').toEqual([]);
    }
  }, RUN_TIMEOUT_MS);

  it('refuses when no API server answers at the named context, and asks only that context', () => {
    for (const which of ['bot-manifest', 'tenant-isolation']) {
      const { env, calls } = clusterEnv('unreachable', { OSHAL_CLUSTER_CONTEXT: CONTEXT });
      const run = runBash([SCRIPTS.cluster, which], env);
      expect(run.status, run.out).toBe(2);
      expect(run.out).toContain(`no API server answered at context '${CONTEXT}'`);
      expect(run.out).not.toMatch(/PASS/);
      expect(calls()).toEqual([`--context ${CONTEXT} cluster-info`]);
    }
  }, RUN_TIMEOUT_MS);

  it('refuses when kubectl is not installed', () => {
    const env = onlyPath(cleanEnv({ OSHAL_CLUSTER_CONTEXT: CONTEXT }), [TOOL_PATH]);
    const run = runBash([SCRIPTS.cluster, 'tenant-isolation'], env);
    expect(run.status, run.out).toBe(2);
    expect(run.out).toContain('kubectl is not on PATH');
  }, RUN_TIMEOUT_MS);

  it('passes the tenant-isolation gate only on an isolating cluster, with the context on every kubectl call', () => {
    const { env, calls } = clusterEnv('isolating', { OSHAL_CLUSTER_CONTEXT: CONTEXT });
    const run = runBash([SCRIPTS.cluster, 'tenant-isolation'], env);
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain('CROSS-TENANT ISOLATION PROVEN');
    expect(run.out).toContain(`cluster-tenant-isolation: PASS (context '${CONTEXT}')`);
    const made = calls();
    expect(made.length).toBeGreaterThan(10);
    for (const call of made) expect(call, 'every kubectl call must carry the named context').toMatch(new RegExp(`^--context ${CONTEXT} `));
  }, RUN_TIMEOUT_MS);

  it('fails the tenant-isolation gate when cross-tenant traffic flows', () => {
    const { env } = clusterEnv('open', { OSHAL_CLUSTER_CONTEXT: CONTEXT });
    const run = runBash([SCRIPTS.cluster, 'tenant-isolation'], env);
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('tenant-a REACHED tenant-b');
    expect(run.out).toContain(`cluster-tenant-isolation: FAIL (context '${CONTEXT}')`);
  }, RUN_TIMEOUT_MS);

  it('verify-tenant-isolation.sh refuses an argument it does not know instead of ignoring it', () => {
    const { env, calls } = clusterEnv('isolating');
    const run = runBash([SCRIPTS.tenantIsolation, '--contxt', CONTEXT], env);
    expect(run.status, run.out).toBe(2);
    expect(run.out).toContain('unknown argument: --contxt');
    expect(calls()).toEqual([]);
  }, RUN_TIMEOUT_MS);
});

/**
 * @description Environment for a recording-validator case: the npx stand-in FIRST on PATH, then
 * the kubectl stand-in (which answers the wrapper's own probe), then Git Bash's tools - no node
 * directory, so no real npx can be reached.
 * @param cluster the emulated cluster behind the wrapper's probe
 * @param outcome what the validator stand-in prints and how it exits
 * @param extra further variables (OSHAL_CLUSTER_CONTEXT is set unless overridden)
 * @returns the environment, and readers for the kubectl and validator calls
 */
function validatorEnv(
  cluster: string,
  outcome: { rc: number; out?: string; err?: string },
  extra: Record<string, string> = { OSHAL_CLUSTER_CONTEXT: CONTEXT, OSHAL_CLUSTER_NAMESPACE: NAMESPACE },
): { env: NodeJS.ProcessEnv; kubectlCalls: () => string[]; validatorCalls: () => ReturnType<typeof readCalls> } {
  const dir = fs.mkdtempSync(path.join(SCRATCH, 'validator-'));
  const out = path.join(dir, 'out.txt');
  const err = path.join(dir, 'err.txt');
  const log = path.join(dir, 'npx-calls.log');
  fs.writeFileSync(out, outcome.out ?? '');
  fs.writeFileSync(err, outcome.err ?? '');
  const { env, calls } = kubectlEnv(SCRATCH, cluster, [NPX_DIR, STAND_INS, TOOL_PATH], {
    OSHAL_TEST_VALIDATOR_OUT: posix(out),
    OSHAL_TEST_VALIDATOR_ERR: posix(err),
    OSHAL_TEST_VALIDATOR_RC: String(outcome.rc),
    OSHAL_TEST_TOOL_LOG: posix(log),
    ...extra,
  });
  return { env, kubectlCalls: calls, validatorCalls: () => readCalls(log) };
}

describe('the wrapper reads the bot-manifest validator it runs: --require-server, its exit code, and its pass signal', () => {
  it('the fixtures are the validator\'s own wording, so a reworded validator retires no case silently', () => {
    for (const line of [SERVER_DRY_RUN_LINE.slice(0, 'dry-run mode: '.length), '(validated by the real API server; nothing created)',
      'OK: the API server exposes deployments/scale with verbs [', 'WARNING: client-side only - NOT A PROOF',
      'OK (client-side shape check only)', 'deployments/scale was not confirmed against a real API server. NOT A PROOF.']) {
      expect(VALIDATOR_SOURCE, line).toContain(line);
    }
  });

  it('starts the validator once - npx tsx, --require-server, the context and the namespace - from the tree it judges, and passes on server-side proof', () => {
    const { env, kubectlCalls, validatorCalls } = validatorEnv('admitting', { rc: 0, out: SERVER_OUT });
    const run = runBash([SCRIPTS.cluster, 'bot-manifest'], env);
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain(`cluster-bot-manifest: PASS (context '${CONTEXT}')`);
    const calls = validatorCalls();
    expect(calls.map((c) => c.args)).toEqual([[
      'tsx', 'scripts/validate-dynamic-bot-manifest.mjs', '--require-server', '--context', CONTEXT, '--namespace', NAMESPACE,
    ]]);
    expect(calls[0].env.PWD, 'the validator runs from the root the wrapper judges').toBe(posix(REPO_ROOT));
    expect(kubectlCalls(), 'the wrapper itself only probes').toEqual([`--context ${CONTEXT} cluster-info`]);

    const defaulted = validatorEnv('admitting', { rc: 0, out: SERVER_OUT }, { OSHAL_CLUSTER_CONTEXT: CONTEXT });
    expect(runBash([SCRIPTS.cluster, 'bot-manifest'], defaulted.env).status).toBe(0);
    expect(defaulted.validatorCalls()[0].args.slice(-2), 'OSHAL_CLUSTER_NAMESPACE defaults to oshal').toEqual(['--namespace', 'oshal']);
  }, RUN_TIMEOUT_MS);

  const nonZero: Array<{ rc: number; status: number; verdict: string }> = [
    { rc: 1, status: 1, verdict: `cluster-bot-manifest: FAIL (context '${CONTEXT}')` },
    { rc: 2, status: 2, verdict: 'cluster-bot-manifest: UNCHECKED - the check refused to run (exit 2)' },
    { rc: 3, status: 1, verdict: `cluster-bot-manifest: FAIL - the check exited 3 (context '${CONTEXT}')` },
    { rc: 124, status: 2, verdict: 'cluster-bot-manifest: UNCHECKED - the check did not finish within' },
    { rc: 127, status: 1, verdict: `cluster-bot-manifest: FAIL - the check exited 127 (context '${CONTEXT}')` },
  ];
  for (const { rc, status, verdict } of nonZero) {
    it(`a validator exit ${rc} makes the wrapper exit ${status}, never PASS - even with both server-side lines in its output`, () => {
      const { env, validatorCalls } = validatorEnv('admitting', { rc, out: SERVER_OUT });
      const run = runBash([SCRIPTS.cluster, 'bot-manifest'], env);
      expect(run.status, run.out).toBe(status);
      expect(run.out).toContain(verdict);
      expect(run.out).not.toMatch(/: PASS/);
      expect(validatorCalls()).toHaveLength(1);
    }, RUN_TIMEOUT_MS);
  }

  const noProof: Array<{ name: string; out: string; err: string }> = [
    { name: 'a client-side-only run (WARNING ... NOT A PROOF)', out: CLIENT_OUT, err: CLIENT_ERR },
    { name: 'server-side lines with a NOT A PROOF warning on stderr', out: SERVER_OUT, err: CLIENT_ERR.split('\n')[2] },
    { name: 'the server dry-run line without the deployments/scale discovery line', out: SERVER_OUT.replace(SCALE_DISCOVERY_LINE, 'OK:'), err: '' },
    { name: 'the discovery line without the server dry-run line', out: SERVER_OUT.replace(SERVER_DRY_RUN_LINE, ''), err: '' },
    { name: 'no output at all', out: '', err: '' },
  ];
  for (const { name, out, err } of noProof) {
    it(`a validator exit 0 is FAIL, not PASS, on ${name}`, () => {
      const { env } = validatorEnv('admitting', { rc: 0, out, err });
      const run = runBash([SCRIPTS.cluster, 'bot-manifest'], env);
      expect(run.status, run.out).toBe(1);
      expect(run.out).toContain('cluster-bot-manifest: FAIL - the check exited 0 without the server-side proof');
      expect(run.out).not.toMatch(/: PASS/);
    }, RUN_TIMEOUT_MS);
  }

  it('with no API server answering, or no context, the validator is never started and the gate is UNCHECKED', () => {
    const down = validatorEnv('unreachable', { rc: 0, out: SERVER_OUT });
    const run = runBash([SCRIPTS.cluster, 'bot-manifest'], down.env);
    expect(run.status, run.out).toBe(2);
    expect(run.out).toContain(`cluster-bot-manifest: UNCHECKED - no API server answered at context '${CONTEXT}'`);
    expect(run.out).not.toMatch(/: PASS/);
    expect(down.validatorCalls(), 'a validator that would report a pass is never reached').toEqual([]);
    expect(down.kubectlCalls()).toEqual([`--context ${CONTEXT} cluster-info`]);

    const unnamed = validatorEnv('admitting', { rc: 0, out: SERVER_OUT }, {});
    const refused = runBash([SCRIPTS.cluster, 'bot-manifest'], unnamed.env);
    expect(refused.status, refused.out).toBe(2);
    expect(unnamed.validatorCalls()).toEqual([]);
    expect(unnamed.kubectlCalls()).toEqual([]);
  }, RUN_TIMEOUT_MS);
});

/**
 * Windows only. Node resolves `kubectl` from PATH as kubectl.exe or kubectl.com, so it cannot run
 * the bash stand-in; and the copy of the node binary the validator's own spec uses cannot take the
 * `--context <ctx>` the wrapper makes the validator pass first, because node rejects it as a node
 * option. This executable forwards argv, stdin, stdout, stderr and the exit code unchanged to the
 * SAME bash stand-in, so the wrapper's own probe and every call the validator makes land on one
 * emulated cluster and one call log. Built with the C# compiler that ships with .NET Framework 4.
 */
const TRAMPOLINE_CS = String.raw`using System;
using System.Diagnostics;
using System.Text;

static class KubectlStandIn {
  static string Quote(string arg) {
    var sb = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in arg) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { sb.Append('\\', slashes * 2 + 1); } else { sb.Append('\\', slashes); }
      sb.Append(c);
      slashes = 0;
    }
    sb.Append('\\', slashes * 2);
    return sb.Append('"').ToString();
  }

  static int Main(string[] args) {
    var line = new StringBuilder(Quote(Environment.GetEnvironmentVariable("OSHAL_TEST_KUBECTL_SCRIPT")));
    foreach (var arg in args) line.Append(' ').Append(Quote(arg));
    var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("OSHAL_TEST_BASH"), line.ToString());
    start.UseShellExecute = false;
    using (var child = Process.Start(start)) { child.WaitForExit(); return child.ExitCode; }
  }
}
`;

/** @description Build kubectl.exe from TRAMPOLINE_CS; a missing compiler is a loud failure, never a skip. */
function buildTrampoline(): void {
  const windir = process.env.WINDIR ?? process.env.windir ?? 'C:\\Windows';
  const csc = ['Framework64', 'Framework']
    .map((fw) => path.join(windir, 'Microsoft.NET', fw, 'v4.0.30319', 'csc.exe'))
    .find((candidate) => fs.existsSync(candidate));
  if (!csc) throw new Error('csc.exe (.NET Framework 4) not found; it builds the kubectl.exe stand-in this guard needs on Windows');
  const source = path.join(SCRATCH, 'kubectl-stand-in.cs');
  fs.writeFileSync(source, TRAMPOLINE_CS, 'utf8');
  const built = spawnSync(csc, ['-nologo', `-out:${path.join(TRAMPOLINE_DIR, 'kubectl.exe')}`, source], { encoding: 'utf8' });
  if (built.status !== 0) throw new Error(`could not build the kubectl.exe stand-in: ${built.stdout ?? ''}${built.stderr ?? ''}`);
}

/**
 * @description Environment for a case that runs the REAL validator through the wrapper: the
 * kubectl stand-in (and on Windows its .exe forwarder) FIRST on PATH, ahead of node's directory,
 * so both the wrapper and the validator resolve the stand-in before anything else. The cases pin
 * the call log, so a call that reached any other kubectl would be missing from it and turn them red.
 */
function wrapperEnv(cluster: string): ReturnType<typeof kubectlEnv> {
  return kubectlEnv(SCRATCH, cluster, [TRAMPOLINE_DIR, STAND_INS, NODE_DIR, TOOL_PATH], {
    OSHAL_CLUSTER_CONTEXT: CONTEXT,
    OSHAL_CLUSTER_NAMESPACE: NAMESPACE,
    OSHAL_TEST_BASH: posix(BASH),
    OSHAL_TEST_KUBECTL_SCRIPT: posix(path.join(STAND_INS, 'kubectl')),
  });
}

describe('the cluster-gate wrapper running the REAL validator, and every verdict of the check it runs', () => {
  beforeAll(() => {
    fs.mkdirSync(TRAMPOLINE_DIR, { recursive: true });
    if (process.platform === 'win32') buildTrampoline();
  });

  it('bot-manifest passes on server-side admission, running the real validator with --require-server, the context and the namespace', () => {
    const { env, calls } = wrapperEnv('admitting');
    const run = runBash([SCRIPTS.cluster, 'bot-manifest'], env);
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain(SERVER_DRY_RUN_LINE);
    expect(run.out).toContain(SCALE_DISCOVERY_LINE);
    expect(run.out).not.toContain('NOT A PROOF');
    expect(run.out).toContain(`cluster-bot-manifest: PASS (context '${CONTEXT}')`);
    expect(calls(), 'the wrapper probe, then the validator: probe, namespace, server dry-run, scale discovery').toEqual([
      `--context ${CONTEXT} cluster-info`,
      `--context ${CONTEXT} cluster-info`,
      `--context ${CONTEXT} get namespace ${NAMESPACE}`,
      `--context ${CONTEXT} apply -f - -n ${NAMESPACE} --dry-run=server`,
      `--context ${CONTEXT} get --raw /apis/apps/v1`,
    ]);
  }, RUN_TIMEOUT_MS);

  it('bot-manifest is FAIL when the dry-run exits 0 without server-side admission - only --require-server looks for it', () => {
    const { env, calls } = wrapperEnv('client-marks');
    const run = runBash([SCRIPTS.cluster, 'bot-manifest'], env);
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('FAILED (--require-server): only 0 of 2 objects report "(server dry run)"');
    expect(run.out).toContain(`cluster-bot-manifest: FAIL (context '${CONTEXT}')`);
    expect(run.out).not.toMatch(/PASS/);
    expect(calls()).toContain(`--context ${CONTEXT} apply -f - -n ${NAMESPACE} --dry-run=server`);
  }, RUN_TIMEOUT_MS);

  it('bot-manifest is UNCHECKED, never PASS, when the API server stops answering after the wrapper\'s own probe', () => {
    const { env, calls } = wrapperEnv('drops-after-probe');
    const run = runBash([SCRIPTS.cluster, 'bot-manifest'], env);
    expect(run.status, run.out).toBe(2);
    expect(run.out).toContain(`FAILED (--require-server): no API server reachable at context "${CONTEXT}"`);
    expect(run.out).toContain('cluster-bot-manifest: UNCHECKED - the check refused to run (exit 2)');
    expect(run.out).not.toMatch(/PASS/);
    expect(calls(), 'no client-side fallback: nothing after the failed probe').toEqual([
      `--context ${CONTEXT} cluster-info`,
      `--context ${CONTEXT} cluster-info`,
    ]);
  }, RUN_TIMEOUT_MS);

  it('tenant-isolation is UNCHECKED, never PASS, when the check itself refuses - the app=web pods are absent', () => {
    const { env } = clusterEnv('no-pods', { OSHAL_CLUSTER_CONTEXT: CONTEXT });
    const run = runBash([SCRIPTS.cluster, 'tenant-isolation'], env);
    expect(run.status, run.out).toBe(2);
    expect(run.out).toContain('missing app=web pods in tenant-a/tenant-b');
    expect(run.out).toContain('cluster-tenant-isolation: UNCHECKED - the check refused to run (exit 2)');
    expect(run.out).not.toMatch(/PASS/);
  }, RUN_TIMEOUT_MS);

  it('a check that does not finish within OSHAL_CLUSTER_TIMEOUT is UNCHECKED, never PASS', () => {
    const { env } = clusterEnv('hangs', { OSHAL_CLUSTER_CONTEXT: CONTEXT, OSHAL_CLUSTER_TIMEOUT: '3' });
    const run = runBash([SCRIPTS.cluster, 'tenant-isolation'], env);
    expect(run.status, run.out).toBe(2);
    expect(run.out).toContain('cluster-tenant-isolation: UNCHECKED - the check did not finish within 3s.');
    expect(run.out).not.toMatch(/PASS/);
  }, RUN_TIMEOUT_MS);

  it('any other exit from the check is FAIL, never PASS - here the tree it runs from lacks the check (127)', () => {
    const { env, calls } = clusterEnv('isolating', { OSHAL_CLUSTER_CONTEXT: CONTEXT });
    const run = runBash([SCRIPTS.cluster, 'tenant-isolation', writeTree(path.join(SCRATCH, 'no-check'), { 'README.md': 'x\n' })], env);
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain(`cluster-tenant-isolation: FAIL - the check exited 127 (context '${CONTEXT}')`);
    expect(run.out).not.toMatch(/PASS/);
    expect(calls(), 'only the wrapper\'s own probe ran').toEqual([`--context ${CONTEXT} cluster-info`]);
  }, RUN_TIMEOUT_MS);
});
