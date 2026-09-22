/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the Kubernetes gates ci-local.sh gained (docs/k8/remote-cluster-work-package.md items 7 and 8). Every case RUNS the shipped scripts in Git Bash. argo-manifests: the REAL kubeconform judges the real ops/deployment/argo tree green, and a temporary copy with one malformed edit - one per manifest, all five, the Argo WorkflowTemplate included - red, naming the file and the field; a YAML syntax break is red too. terraform: the REAL terraform judges throwaway modules - clean green, and an unformatted, a syntax-broken and an undeclared-reference module red - and writes nothing into the module. Both refuse (UNCHECKED, exit 2) without their tool and without anything to judge. cluster gates: a kubectl stand-in proves they refuse with no context, no kubectl and no reachable API server, carry the named context into every kubectl call, and pass only when the emulated cluster isolates. ci-local.sh --k8s-only: without --cluster-gates the cluster gates never run and say NOT RUN; with it and no reachable cluster they are FAIL. Neither kubeconform nor terraform on PATH is a loud failure here, never a skip - the same posture as chart-durability-boundary.spec.ts with helm.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The wrapper's own verdicts had no guard (review of wp/validators): no case took `check-cluster-gates.sh bot-manifest` past its cluster-info probe, and only exits 0 and 1 of tenant-isolation were driven, so dropping `--require-server` from the validator call, or reporting the check's exit 2 as PASS, left every case green. New cases run the REAL validator through the wrapper (npx tsx, --require-server) against emulated clusters: it passes only on server-side admission with the context and namespace on every call; a dry-run that exits 0 without "(server dry run)" is FAIL; an API server that stops answering after the wrapper's probe is UNCHECKED with no client-side fallback. The remaining branches are driven too: tenant-isolation refusing (no app=web pods) is UNCHECKED, a check outliving OSHAL_CLUSTER_TIMEOUT is UNCHECKED, and any other exit (the check missing from the tree it runs from, 127) is FAIL - never PASS in any of them. On Windows a kubectl.exe forwarder, compiled from C# in the case, carries the validator's calls to the same bash stand-in.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | This file runs under `npm run test:unit`, and the hosted CI Test job (.github/workflows/ci.yml) installs neither kubeconform nor terraform, so entry 1's throw-when-absent posture would have turned hosted CI red on merge (review of wp/validators, item 8). The gate LOGIC is now judged here with recording stand-ins on a controlled PATH, needing no real tool: which flags and schema locations reach kubeconform (-strict, the pinned Kubernetes version, the commit-pinned Argo CRD schema, the cache, no -ignore-missing-schemas), that every manifest in the directory reaches it (one malformed edit per manifest, all five, is red only because that file was judged), that an invalid manifest, an unfetchable schema, a skipped resource or an empty summary is never PASS, and the exact terraform fmt -check / init -backend=false -lockfile=readonly / validate calls with a throwaway TF_DATA_DIR that is removed and never lands in the module. An absent tool is UNCHECKED with its install hint both through the OSHAL_* override and through a PATH without it, and `ci-local.sh --k8s-only` with neither tool installed is FAIL for both gates - the ci-local step that runs the REAL tools over the real tree fails closed. The real-tool cases moved to tests/unit/ci-local-k8s-gates-real-tools.spec.ts (skipped, with the reason printed, where the tools are absent); the cluster-gate cases moved to tests/unit/check-cluster-gates.spec.ts. The ci-local wiring cases now point the schema and provider caches into the scratch tree, so they never depend on ci-local's cygpath-derived state directory.
 *
 * SCOPED DOUBLES (real-boundary audit): kubeconform and terraform in every case here, and kubectl in
 * the ci-local wiring cases. The claim here is the gates' own decisions - what they pass to the tool,
 * how they read its answer, when they refuse - and which gates ci-local.sh runs; the shipped scripts
 * make those decisions for real. What the REAL tools say about the real tree and about malformed
 * input is tests/unit/ci-local-k8s-gates-real-tools.spec.ts, and `bash scripts/ci-local.sh` (gates
 * argo-manifests and terraform), which is red without the tools.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ARGO_DIR, ARGO_MANIFESTS, KUBECONFORM_STAND_IN, KUBECTL_STAND_IN, MUTATIONS, REPO_ROOT, RUN_TIMEOUT_MS, SCRIPTS,
  TERRAFORM_STAND_IN, argoTree, cleanEnv, hostTools, kubectlEnv, makeScratch, onlyPath, posix, readCalls, runBash,
  writeStandIn, writeTree, type RecordedCall, type Run,
} from '../helpers/k8s-gate-harness';

const CONTEXT = 'ctx-under-test';
const SCRATCH = makeScratch('oshal-k8s-gates-');
/** The host's shell tools, with no kubeconform, terraform or kubectl among them. */
const TOOL_PATH = hostTools(SCRATCH);
const STAND_INS = path.join(SCRATCH, 'stand-ins');
const KUBECONFORM_CACHE = posix(path.join(SCRATCH, 'kubeconform-cache'));
const TF_PLUGIN_CACHE = posix(path.join(SCRATCH, 'terraform-plugin-cache'));
const PINNED_CRD_SCHEMA = /^https:\/\/raw\.githubusercontent\.com\/datreeio\/CRDs-catalog\/[0-9a-f]{40}\/\{\{\.Group\}\}\/\{\{\.ResourceKind\}\}_\{\{\.ResourceAPIVersion\}\}\.json$/;
const TF_VARS = 'TF_DATA_DIR TF_PLUGIN_CACHE_DIR TF_IN_AUTOMATION CHECKPOINT_DISABLE';
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

beforeAll(() => {
  writeStandIn(STAND_INS, 'kubeconform', KUBECONFORM_STAND_IN);
  writeStandIn(STAND_INS, 'terraform', TERRAFORM_STAND_IN);
  writeStandIn(STAND_INS, 'kubectl', KUBECTL_STAND_IN);
});

let runs = 0;

/**
 * @description Run a gate script against `root` with the recording stand-ins first on PATH (or,
 * with `dirs`, only the directories given) and a fresh call log.
 * @param script the gate script
 * @param root the tree it judges
 * @param extra variables steering the stand-ins or the gate
 * @param dirs the PATH entries (default: stand-ins, then the host tools)
 * @returns the run and every call the stand-ins recorded
 */
function gate(script: string, root: string, extra: Record<string, string> = {}, dirs = [STAND_INS, TOOL_PATH]): { run: Run; calls: RecordedCall[] } {
  const log = path.join(SCRATCH, `tool-calls-${runs += 1}.log`);
  const env = onlyPath(cleanEnv({ OSHAL_TEST_TOOL_LOG: posix(log), OSHAL_TEST_RECORD_VARS: TF_VARS, ...extra }), dirs);
  const run = runBash([script, root], env);
  return { run, calls: readCalls(log) };
}

/** @description The argo-manifests gate with the kubeconform stand-in, schema cache in the scratch tree. */
function argoGate(root: string, extra: Record<string, string> = {}, dirs?: string[]): { run: Run; calls: RecordedCall[] } {
  return gate(SCRIPTS.argo, root, { OSHAL_KUBECONFORM_CACHE: KUBECONFORM_CACHE, ...extra }, dirs);
}

/** @description The yaml paths one kubeconform call judged, in the order it got them. */
function judged(call: RecordedCall): string[] {
  return call.args.filter((a) => a.endsWith('.yaml'));
}

let trees = 0;
/** @description A fresh throwaway copy of the five committed Argo manifests. */
const REAL_TREE = (): string => argoTree(path.join(SCRATCH, `argo-${trees += 1}`));

describe('argo-manifests gate logic, judged with a recording kubeconform stand-in', () => {
  it('passes when every resource is valid, calling kubeconform once with the pinned -strict flags over all five manifests', () => {
    const root = REAL_TREE();
    const { run, calls } = argoGate(root);
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain('argo-manifests: PASS - every resource in 5 files is schema-valid (-strict).');
    expect(calls.map((c) => c.args[0]), 'a version probe, then exactly one validation call').toEqual(['-v', '-strict']);
    const validate = calls[1];
    const files = judged(validate);
    expect(validate.args.slice(0, validate.args.length - files.length)).toEqual([
      '-strict', '-summary', '-verbose',
      '-kubernetes-version', '1.36.0',
      '-schema-location', 'default',
      '-schema-location', validate.args[8],
      '-cache', KUBECONFORM_CACHE,
    ]);
    expect(validate.args[8], 'the Argo CRD schema is pinned to a commit, never a branch').toMatch(PINNED_CRD_SCHEMA);
    expect(validate.args, 'nothing may be skipped for want of a schema').not.toContain('-ignore-missing-schemas');
    expect([...files].sort()).toEqual(ARGO_MANIFESTS.map((f) => `ops/deployment/argo/${f}`).sort());
    expect(validate.env.PWD, 'kubeconform runs from the root the gate judges').toBe(root);
  }, RUN_TIMEOUT_MS);

  it('honours OSHAL_KUBECONFORM_K8S_VERSION and OSHAL_KUBECONFORM (the binary override)', () => {
    const { run, calls } = argoGate(REAL_TREE(), {
      OSHAL_KUBECONFORM_K8S_VERSION: '1.35.2', OSHAL_KUBECONFORM: posix(path.join(STAND_INS, 'kubeconform')),
    }, [TOOL_PATH]);
    expect(run.status, run.out).toBe(0);
    expect(calls[1].args.slice(3, 5)).toEqual(['-kubernetes-version', '1.35.2']);
  }, RUN_TIMEOUT_MS);

  it('the malformed edits exist in the real manifests, and the stand-in rejects nothing in the unedited tree', () => {
    for (const mutation of MUTATIONS) {
      expect(fs.readFileSync(path.join(ARGO_DIR, mutation.file), 'utf8').includes(mutation.from), `mutation anchor missing from ${mutation.file}`).toBe(true);
    }
    const { run } = argoGate(REAL_TREE(), { OSHAL_TEST_KUBECONFORM_REJECT: MUTATIONS.map((m) => m.field).join('|') });
    expect(run.status, run.out).toBe(0);
  }, RUN_TIMEOUT_MS);

  for (const mutation of MUTATIONS) {
    it(`is red when kubeconform rejects a malformed edit to ${mutation.file} - every manifest reaches the validator`, () => {
      const real = fs.readFileSync(path.join(ARGO_DIR, mutation.file), 'utf8');
      const root = argoTree(path.join(SCRATCH, `mutated-${mutation.file}`), { [mutation.file]: real.replace(mutation.from, mutation.to) });
      const { run } = argoGate(root, { OSHAL_TEST_KUBECONFORM_REJECT: mutation.field });
      expect(run.status, run.out).toBe(1);
      expect(run.out).toContain(`ops/deployment/argo/${mutation.file} - stand-in is invalid`);
      expect(run.out).toContain('argo-manifests: FAIL - a manifest above is invalid');
      expect(run.out).not.toContain('argo-manifests: PASS');
    }, RUN_TIMEOUT_MS);
  }

  it('judges every *.yaml in the directory, including one added after this guard was written', () => {
    const root = REAL_TREE();
    fs.writeFileSync(path.join(root, 'ops', 'deployment', 'argo', 'zz-new.yaml'), 'kind: Namespace\nhardd: x\n');
    const { run, calls } = argoGate(root, { OSHAL_TEST_KUBECONFORM_REJECT: 'hardd' });
    expect(run.status, run.out).toBe(1);
    expect(judged(calls[1])).toHaveLength(6);
    expect(run.out).toContain('ops/deployment/argo/zz-new.yaml - stand-in is invalid');
  }, RUN_TIMEOUT_MS);

  it('is red when a schema could not be fetched', () => {
    const { run } = argoGate(REAL_TREE(), { OSHAL_TEST_KUBECONFORM_MODE: 'schema-error' });
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('could not find schema for WorkflowTemplate');
    expect(run.out).toContain('argo-manifests: FAIL');
  }, RUN_TIMEOUT_MS);

  it('is red when kubeconform exits 0 but skipped a resource', () => {
    const { run } = argoGate(REAL_TREE(), { OSHAL_TEST_KUBECONFORM_MODE: 'skipped' });
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('argo-manifests: FAIL - kubeconform skipped a resource, so it was not validated.');
  }, RUN_TIMEOUT_MS);

  it('is UNCHECKED, not PASS, when kubeconform exits 0 having found no resource', () => {
    const { run } = argoGate(REAL_TREE(), { OSHAL_TEST_KUBECONFORM_MODE: 'nothing' });
    expect(run.status, run.out).toBe(2);
    expect(run.out).toContain('argo-manifests: UNCHECKED - kubeconform reported no resources; nothing was judged.');
  }, RUN_TIMEOUT_MS);

  it('is UNCHECKED, not PASS, without kubeconform - named by the override or absent from PATH - and says how to install it', () => {
    for (const [extra, dirs] of [[{ OSHAL_KUBECONFORM: 'kubeconform-absent-for-this-case' }, [STAND_INS, TOOL_PATH]], [{}, [TOOL_PATH]]] as const) {
      const { run, calls } = argoGate(REAL_TREE(), extra, [...dirs]);
      expect(run.status, run.out).toBe(2);
      expect(run.out).toContain('argo-manifests: UNCHECKED - kubeconform not found');
      expect(run.out).toContain('https://github.com/yannh/kubeconform/releases');
      expect(run.out).toContain('This gate does not skip without it.');
      expect(calls).toEqual([]);
    }
  }, RUN_TIMEOUT_MS);

  it('is UNCHECKED, not PASS, when there is no manifest to judge, and never calls kubeconform', () => {
    const { run, calls } = argoGate(writeTree(path.join(SCRATCH, 'no-argo'), { 'README.md': 'nothing here\n' }));
    expect(run.status, run.out).toBe(2);
    expect(run.out).toContain('nothing was judged');
    expect(calls).toEqual([]);
  }, RUN_TIMEOUT_MS);
});

describe('terraform gate logic, judged with a recording terraform stand-in', () => {
  const MODULE_FILES = { 'deploy/terraform/main.tf': 'variable "x" {\n  type = string\n}\n' };

  /** @description Run the terraform gate over a one-file module with the stand-in failing `fail`. */
  function tfGate(name: string, fail = '', extra: Record<string, string> = {}, dirs?: string[]): { run: Run; calls: RecordedCall[]; root: string } {
    const root = writeTree(path.join(SCRATCH, name), MODULE_FILES);
    const res = gate(SCRIPTS.terraform, root, { OSHAL_TF_PLUGIN_CACHE: TF_PLUGIN_CACHE, OSHAL_TEST_TERRAFORM_FAIL: fail, ...extra }, dirs);
    return { ...res, root };
  }

  const FMT = ['-chdir=deploy/terraform', 'fmt', '-check', '-recursive', '-diff', '-no-color'];
  const INIT = ['-chdir=deploy/terraform', 'init', '-backend=false', '-input=false', '-lockfile=readonly', '-no-color'];
  const VALIDATE = ['-chdir=deploy/terraform', 'validate', '-no-color'];

  it('passes when fmt and validate pass, with the exact calls, a throwaway data dir, and nothing written into the module', () => {
    const { run, calls, root } = tfGate('tf-clean');
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain('terraform: fmt PASS');
    expect(run.out).toContain('terraform: validate PASS');
    expect(calls.map((c) => c.args)).toEqual([['version'], FMT, INIT, VALIDATE]);
    for (const call of calls) expect(call.env.PWD, 'terraform runs from the root the gate judges').toBe(root);
    const [, , init, validate] = calls;
    const dataDir = init.env.TF_DATA_DIR;
    expect(dataDir, 'init and validate share one data dir').toBe(validate.env.TF_DATA_DIR);
    expect(dataDir.startsWith(root), 'the data dir is never inside the tree being judged').toBe(false);
    expect(fs.existsSync(dataDir), 'the data dir (which init wrote into) is removed with the run').toBe(false);
    expect(init.env.TF_PLUGIN_CACHE_DIR).toBe(TF_PLUGIN_CACHE);
    for (const call of [init, validate]) {
      expect([call.env.TF_IN_AUTOMATION, call.env.CHECKPOINT_DISABLE]).toEqual(['1', '1']);
    }
    expect(fs.readdirSync(path.join(root, 'deploy', 'terraform'))).toEqual(['main.tf']);
  }, RUN_TIMEOUT_MS);

  it('fails an unformatted module, and still validates it so one run names every problem', () => {
    const { run, calls } = tfGate('tf-unformatted', 'fmt');
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('terraform: fmt FAIL');
    expect(run.out).toContain('terraform: validate PASS');
    expect(calls.map((c) => c.args)).toContainEqual(VALIDATE);
  }, RUN_TIMEOUT_MS);

  it('fails a module that does not validate', () => {
    const { run } = tfGate('tf-invalid', 'validate');
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('terraform: fmt PASS');
    expect(run.out).toContain('Reference to undeclared input variable (stand-in)');
    expect(run.out).toContain('terraform: validate FAIL');
  }, RUN_TIMEOUT_MS);

  it('fails when init does not complete, shows why, and never reports validate PASS', () => {
    const { run, calls } = tfGate('tf-no-init', 'init');
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('Failed to query available provider packages (stand-in)');
    expect(run.out).toContain('terraform: validate FAIL - init did not complete');
    expect(calls.map((c) => c.args[1])).not.toContain('validate');
  }, RUN_TIMEOUT_MS);

  it('is UNCHECKED, not PASS, without terraform - named by the override or absent from PATH - and says how to install it', () => {
    for (const [extra, dirs] of [[{ OSHAL_TERRAFORM: 'terraform-absent-for-this-case' }, [STAND_INS, TOOL_PATH]], [{}, [TOOL_PATH]]] as const) {
      const { run, calls } = tfGate('tf-absent', '', extra, [...dirs]);
      expect(run.status, run.out).toBe(2);
      expect(run.out).toContain('terraform: UNCHECKED - terraform not found');
      expect(run.out).toContain('https://releases.hashicorp.com/terraform/');
      expect(run.out).toContain('This gate does not skip without it.');
      expect(calls).toEqual([]);
    }
  }, RUN_TIMEOUT_MS);

  it('is UNCHECKED, not PASS, when there is no module, and never calls terraform', () => {
    const { run, calls } = gate(SCRIPTS.terraform, writeTree(path.join(SCRATCH, 'tf-none'), { 'README.md': 'x\n' }));
    expect(run.status, run.out).toBe(2);
    expect(run.out).toContain('nothing was judged');
    expect(calls).toEqual([]);
  }, RUN_TIMEOUT_MS);
});

describe('ci-local.sh wiring: the cluster-free gates always run and fail closed, the cluster gates are opt-in', () => {
  /**
   * @description Run ci-local.sh with its state directory, schema cache and provider cache inside
   * the scratch tree (ci-local derives its state directory with cygpath, which a Linux runner lacks).
   */
  function ciLocal(args: string[], cluster: string, extra: Record<string, string> = {}, dirs = [STAND_INS, TOOL_PATH]) {
    const state = path.join(SCRATCH, `localappdata-${runs += 1}`);
    fs.mkdirSync(state, { recursive: true });
    const tools = path.join(SCRATCH, `ci-local-tool-calls-${runs}.log`);
    const { env, calls } = kubectlEnv(SCRATCH, cluster, dirs, {
      LOCALAPPDATA: state,
      OSHAL_KUBECONFORM_CACHE: KUBECONFORM_CACHE,
      OSHAL_TF_PLUGIN_CACHE: TF_PLUGIN_CACHE,
      OSHAL_TEST_TOOL_LOG: posix(tools),
      ...extra,
    });
    const run = runBash([SCRIPTS.ciLocal, ...args], env);
    return { run, calls: calls(), toolCalls: readCalls(tools) };
  }

  it('--k8s-only runs argo-manifests and terraform over the working tree, never touches kubectl, and says the cluster gates did NOT RUN', () => {
    const { run, calls, toolCalls } = ciLocal(['--k8s-only'], 'isolating', { OSHAL_CLUSTER_CONTEXT: CONTEXT });
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain('GATE argo-manifests: PASS');
    expect(run.out).toContain('GATE terraform: PASS');
    expect(run.out).toContain('GATES cluster-bot-manifest + cluster-tenant-isolation: NOT RUN (opt-in: --cluster-gates');
    expect(run.out).not.toContain('GATE cluster-');
    expect(calls, 'without --cluster-gates no kubectl call is made, even with a context set').toEqual([]);
    const validate = toolCalls.find((c) => c.args[0] === '-strict');
    expect(validate && [...judged(validate)].sort()).toEqual(ARGO_MANIFESTS.map((f) => `ops/deployment/argo/${f}`).sort());
    expect(toolCalls.map((c) => c.args[1]).filter((sub) => sub === 'fmt' || sub === 'validate')).toEqual(['fmt', 'validate']);
    for (const call of toolCalls) expect(call.env.PWD, 'the gates judge the working tree').toBe(posix(REPO_ROOT));
  }, RUN_TIMEOUT_MS);

  it('--k8s-only with neither kubeconform nor terraform installed is FAIL for both, with their install hints', () => {
    const { run, toolCalls } = ciLocal(['--k8s-only'], 'isolating', {}, [TOOL_PATH]);
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('GATE argo-manifests: FAIL');
    expect(run.out).toContain('GATE terraform: FAIL');
    expect(run.out).toContain('https://github.com/yannh/kubeconform/releases');
    expect(run.out).toContain('https://releases.hashicorp.com/terraform/');
    expect(run.out).toContain('=== K8S GATES: FAILED: argo-manifests terraform ===');
    expect(toolCalls).toEqual([]);
  }, RUN_TIMEOUT_MS);

  it('--k8s-only --cluster-gates with no reachable cluster is FAIL for both cluster gates, not a pass', () => {
    const { run, calls } = ciLocal(['--k8s-only', '--cluster-gates'], 'unreachable', { OSHAL_CLUSTER_CONTEXT: CONTEXT });
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('GATE cluster-bot-manifest: FAIL');
    expect(run.out).toContain('GATE cluster-tenant-isolation: FAIL');
    expect(run.out).toContain('=== K8S GATES: FAILED: cluster-bot-manifest cluster-tenant-isolation ===');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.startsWith(`--context ${CONTEXT} `))).toBe(true);
  }, RUN_TIMEOUT_MS);

  it('--k8s-only refuses a flag it would otherwise silently ignore', () => {
    const { run } = ciLocal(['--k8s-only', '--head'], 'unreachable');
    expect(run.status, run.out).toBe(2);
    expect(run.out).toContain('--k8s-only takes only --cluster-gates beside it');
  }, RUN_TIMEOUT_MS);

  it('the full run always calls the two cluster-free gates and the cluster gates only behind --cluster-gates', () => {
    const source = fs.readFileSync(SCRIPTS.ciLocal, 'utf8');
    const block = source.slice(source.indexOf('if [ "$NODE_GATES_OK" = "1" ]; then'), source.indexOf('run_gate secret-scan gate_secrets'));
    expect(block).toContain('run_gate argo-manifests gate_argo_manifests');
    expect(block).toContain('run_gate terraform gate_terraform');
    const optIn = block.slice(block.indexOf('if [ "$CLUSTER_GATES" = "1" ]; then'));
    expect(optIn.indexOf('run_gate cluster-bot-manifest gate_cluster_bot_manifest')).toBeGreaterThan(0);
    expect(optIn.indexOf('run_gate cluster-tenant-isolation gate_cluster_tenant_isolation')).toBeGreaterThan(0);
    expect(optIn.indexOf('log "$K8S_CLUSTER_GATES_NOT_REQUESTED"')).toBeGreaterThan(optIn.indexOf('else'));
    expect(source.match(/run_gate cluster-/g), 'the cluster gates are called in exactly one place').toHaveLength(2);
  });
});
