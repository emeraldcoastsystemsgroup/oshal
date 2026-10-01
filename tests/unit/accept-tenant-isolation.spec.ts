/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The logic of scripts/governance/accept-tenant-isolation.sh, the automated cluster acceptance for provision-tenant.sh's namespace half, and of the --namespaces parameter it drives verify-tenant-isolation.sh with. SCOPED DOUBLE (real-boundary audit): kubectl and the cluster behind it, replaced by the stateful stand-in tests/fixtures/kubectl-tenant-cluster.sh - a unit run must never reach the live cluster on this box. Everything else runs for real in Git Bash: the acceptance script, provision-tenant.sh rendering both tenants, and verify-tenant-isolation.sh judging the two rendered namespaces, whose policy reads the stand-in answers from the manifest that was actually applied. The claim is the script's wiring, verdicts and cleanup: every kubectl call carries the context; it accepts only when isolation is proven AND both namespaces it created are confirmed gone; it deletes exactly what it created and nothing else; it refuses before creating anything when the cluster, the context or a namespace's absence cannot be established. The real companion is one run on a NetworkPolicy-enforcing cluster (docs/runbooks/tenant-provisioning.md).
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  REPO_ROOT, RUN_TIMEOUT_MS, SCRIPTS, cleanEnv, hostTools, makeScratch, onlyPath, posix, runBash, writeStandIn,
} from '../helpers/k8s-gate-harness';

const ACCEPT = posix(path.join(REPO_ROOT, 'scripts', 'governance', 'accept-tenant-isolation.sh'));
const CONTEXT = 'ctx-under-test';
const ARGS = ['--context', CONTEXT, '--apiserver-cidr', '192.168.50.10/32',
  '--db-host', 'oshal-db.oshal.svc.cluster.local', '--image', 'nginx:alpine', '--timeout', '5'];
const SCRATCH = makeScratch('oshal-tenant-acceptance-');
/** The host's shell tools, with no kubectl among them. */
const TOOL_PATH = hostTools(SCRATCH);
const STAND_INS = path.join(SCRATCH, 'stand-ins');
writeStandIn(STAND_INS, 'kubectl', fs.readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'kubectl-tenant-cluster.sh'), 'utf8'));
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

/** One run of a script against the emulated cluster. */
interface ClusterRun {
  status: number | null;
  out: string;
  /** Every kubectl call, as "$*". */
  calls: string[];
  /** Namespaces still present in the emulated cluster afterwards. */
  left: string[];
}

/**
 * @description Run a script against a fresh emulated cluster, with a PATH holding only the stand-in
 * and the host's shell tools, so the real kubectl on this box is unreachable.
 * @param cluster The emulated cluster (see the stand-in's header).
 * @param args The script and its arguments.
 * @param withKubectl False to leave kubectl off PATH entirely.
 * @returns Exit status, output, the kubectl calls made and the namespaces left behind.
 */
function onCluster(cluster: string, args: string[], withKubectl = true): ClusterRun {
  const dir = fs.mkdtempSync(path.join(SCRATCH, 'cluster-'));
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(log, '');
  const env = onlyPath(cleanEnv({
    OSHAL_TEST_KUBECTL_CLUSTER: cluster,
    OSHAL_TEST_KUBECTL_LOG: posix(log),
    OSHAL_TEST_CLUSTER_STATE: posix(path.join(dir, 'state')),
  }), withKubectl ? [STAND_INS, TOOL_PATH] : [TOOL_PATH]);
  const run = runBash(args, env);
  const nsDir = path.join(dir, 'state', 'ns');
  return {
    ...run,
    calls: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean),
    left: fs.existsSync(nsDir) ? fs.readdirSync(nsDir) : [],
  };
}

/**
 * @description The namespaces named by calls of one verb.
 * @param calls The kubectl calls.
 * @param pattern How the verb's calls name a namespace, with the name as group 1.
 * @returns The names, in call order.
 */
function namespacesIn(calls: string[], pattern: RegExp): string[] {
  return calls.flatMap((call) => {
    const match = pattern.exec(call);
    return match ? [match[1]] : [];
  });
}

const APPLIED = /^--context \S+ apply -f \S*\/(acc-[0-9a-f]{8}-[ab])\/namespace\.yaml$/;
const DELETED = /^--context \S+ delete namespace (\S+) --ignore-not-found /;

describe('accept-tenant-isolation.sh against an emulated cluster', () => {
  it('accepts an isolating cluster, judging the two namespaces it rendered, and deletes exactly them', () => {
    const run = onCluster('isolating', [ACCEPT, ...ARGS]);
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain('CROSS-TENANT ISOLATION PROVEN');
    expect(run.out).toContain(`TENANT ISOLATION ACCEPTED on context '${CONTEXT}'`);
    for (const call of run.calls) expect(call, 'every kubectl call carries the context').toMatch(new RegExp(`^--context ${CONTEXT} `));
    const tenants = namespacesIn(run.calls, APPLIED);
    expect(tenants).toHaveLength(2);
    const namespaces = tenants.map((tenant) => `oshal-tenant-${tenant}`);
    expect(namespacesIn(run.calls, DELETED)).toEqual(namespaces);
    expect(run.left).toEqual([]);
    for (const ns of namespaces) {
      expect(run.calls).toContain(`--context ${CONTEXT} run web --image=nginx:alpine --labels=app=web --port=80 --restart=Never -n ${ns}`);
      expect(run.calls).toContain(`--context ${CONTEXT} get networkpolicy allow-same-tenant -n ${ns} -o json`);
      expect(run.out).toContain(`${ns} egress grants the oshal namespace`);
      expect(run.out).toContain(`deleted namespace ${ns}`);
    }
    expect(run.out).toContain(`${namespaces[0]} -> ${namespaces[1]} blocked`);
    expect(run.out).toContain(`${namespaces[1]} -> ${namespaces[0]} blocked`);
  }, RUN_TIMEOUT_MS);

  it('does not accept a cluster where cross-namespace traffic flows, and still deletes what it created', () => {
    const run = onCluster('open', [ACCEPT, ...ARGS]);
    expect(run.status, run.out).toBe(1);
    expect(run.out).toMatch(/oshal-tenant-acc-[0-9a-f]{8}-a REACHED oshal-tenant-acc-[0-9a-f]{8}-b/);
    expect(run.out).toContain('TENANT ISOLATION NOT ACCEPTED');
    expect(namespacesIn(run.calls, DELETED)).toHaveLength(2);
    expect(run.left).toEqual([]);
  }, RUN_TIMEOUT_MS);

  it('does not accept when a web pod cannot even reach itself: a deny there would prove nothing', () => {
    const run = onCluster('self-broken', [ACCEPT, ...ARGS]);
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('cannot reach its OWN pod');
    expect(run.left).toEqual([]);
  }, RUN_TIMEOUT_MS);

  it('does not accept when a pod never becomes Ready, probes nothing, and deletes what it created', () => {
    const run = onCluster('pod-never-ready', [ACCEPT, ...ARGS]);
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('never became Ready');
    expect(run.calls.some((call) => / exec /.test(call))).toBe(false);
    expect(namespacesIn(run.calls, DELETED)).toHaveLength(2);
    expect(run.left).toEqual([]);
  }, RUN_TIMEOUT_MS);

  it('is red when cleanup is incomplete, even though isolation was proven', () => {
    const run = onCluster('delete-stuck', [ACCEPT, ...ARGS]);
    expect(run.out).toContain('CROSS-TENANT ISOLATION PROVEN');
    expect(run.status, run.out).toBe(1);
    expect(run.out).toMatch(/CLEANUP INCOMPLETE: still present: oshal-tenant-acc-[0-9a-f]{8}-a oshal-tenant-acc-[0-9a-f]{8}-b/);
    expect(run.left).toHaveLength(2);
  }, RUN_TIMEOUT_MS);

  it('refuses, creating and deleting nothing, when a namespace it would create already exists', () => {
    const run = onCluster('preexisting', [ACCEPT, ...ARGS]);
    expect(run.status, run.out).toBe(2);
    expect(run.out).toContain('already exists; nothing was created');
    expect(run.calls.filter((call) => / (apply|run|delete) /.test(call))).toEqual([]);
  }, RUN_TIMEOUT_MS);

  it('refuses, creating nothing, when it cannot confirm a namespace is absent', () => {
    const run = onCluster('get-errors', [ACCEPT, ...ARGS]);
    expect(run.status, run.out).toBe(2);
    expect(run.out).toContain('could not confirm namespace');
    expect(run.calls.filter((call) => / (apply|run|delete) /.test(call))).toEqual([]);
  }, RUN_TIMEOUT_MS);

  it('refuses when no API server answers at the context, asking only that context', () => {
    const run = onCluster('unreachable', [ACCEPT, ...ARGS]);
    expect(run.status, run.out).toBe(2);
    expect(run.out).toContain(`no API server answered at context '${CONTEXT}'`);
    expect(run.calls).toEqual([`--context ${CONTEXT} cluster-info`]);
  }, RUN_TIMEOUT_MS);

  it('refuses a missing context, a missing value, an unknown argument and a missing kubectl before any call', () => {
    const without = (flag: string) => ARGS.filter((_arg, index) => ARGS[index] !== flag && ARGS[index - 1] !== flag);
    const cases: [string[], string][] = [
      [without('--context'), '--context is required'],
      [without('--apiserver-cidr'), '--apiserver-cidr is required'],
      [without('--db-host'), '--db-host is required'],
      [without('--image'), '--image is required'],
      [[...ARGS, '--timeout', 'soon'], "invalid --timeout 'soon'"],
      [[...ARGS, '--namespace', 'default'], 'unknown argument: --namespace'],
    ];
    for (const [args, message] of cases) {
      const run = onCluster('isolating', [ACCEPT, ...args]);
      expect(run.status, args.join(' ')).toBe(2);
      expect(run.out, args.join(' ')).toContain(message);
      expect(run.calls, args.join(' ')).toEqual([]);
    }
    const absent = onCluster('isolating', [ACCEPT, ...ARGS], false);
    expect(absent.status, absent.out).toBe(2);
    expect(absent.out).toContain('kubectl not found');
  }, RUN_TIMEOUT_MS);
});

describe('verify-tenant-isolation.sh --namespaces', () => {
  it('refuses a malformed pair, or the same namespace twice, before any kubectl call', () => {
    for (const value of ['tenant-a', 'Tenant-A,tenant-b', 'tenant-a,tenant-a', 'tenant-a,-b']) {
      const run = onCluster('isolating', [SCRIPTS.tenantIsolation, '--namespaces', value]);
      expect(run.status, value).toBe(2);
      expect(run.out, value).toMatch(/--namespaces (needs two namespace names|names the same namespace twice)/);
      expect(run.calls, value).toEqual([]);
    }
  }, RUN_TIMEOUT_MS);
});
