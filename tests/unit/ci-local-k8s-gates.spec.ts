/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the Kubernetes gates ci-local.sh gained (docs/k8/remote-cluster-work-package.md items 7 and 8). Every case RUNS the shipped scripts in Git Bash. argo-manifests: the REAL kubeconform judges the real ops/deployment/argo tree green, and a temporary copy with one malformed edit - one per manifest, all five, the Argo WorkflowTemplate included - red, naming the file and the field; a YAML syntax break is red too. terraform: the REAL terraform judges throwaway modules - clean green, and an unformatted, a syntax-broken and an undeclared-reference module red - and writes nothing into the module. Both refuse (UNCHECKED, exit 2) without their tool and without anything to judge. cluster gates: a kubectl stand-in proves they refuse with no context, no kubectl and no reachable API server, carry the named context into every kubectl call, and pass only when the emulated cluster isolates. ci-local.sh --k8s-only: without --cluster-gates the cluster gates never run and say NOT RUN; with it and no reachable cluster they are FAIL. Neither kubeconform nor terraform on PATH is a loud failure here, never a skip - the same posture as chart-durability-boundary.spec.ts with helm.
 *
 * SCOPED DOUBLES (real-boundary audit): kubectl and the cluster behind it, in the cluster-gate and
 * ci-local cases - a unit run must never reach the live cluster on this box. The claim there is the
 * gates' REFUSAL and WIRING decisions, which run for real; the real companion is `ci-local.sh
 * --cluster-gates` on a reachable cluster (work-package items 12 and 13). kubeconform and terraform
 * are doubled ONLY in the two ci-local wiring cases, whose claim is which gates run; their own cases
 * above use the real binaries.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../..');
const ARGO_DIR = path.join(REPO_ROOT, 'ops', 'deployment', 'argo');
const ARGO_GATE = path.join(REPO_ROOT, 'scripts', 'ci', 'check-argo-manifests.sh').replaceAll('\\', '/');
const TF_GATE = path.join(REPO_ROOT, 'scripts', 'ci', 'check-terraform.sh').replaceAll('\\', '/');
const CLUSTER_GATE = path.join(REPO_ROOT, 'scripts', 'ci', 'check-cluster-gates.sh').replaceAll('\\', '/');
const TENANT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'governance', 'verify-tenant-isolation.sh').replaceAll('\\', '/');
const CI_LOCAL = path.join(REPO_ROOT, 'scripts', 'ci-local.sh').replaceAll('\\', '/');
const RUN_TIMEOUT_MS = 300_000;
const CONTEXT = 'ctx-under-test';

/** The five manifests the work package names; the directory glob must cover every one. */
const ARGO_MANIFESTS = [
  'tenant-namespace.example.yaml',
  'tenant-network-policies.yaml',
  'argo-executor-rbac.yaml',
  'tenant-workspace-pvc.example.yaml',
  'incident-rca-workflowtemplate.yaml',
];

/**
 * One malformed edit per manifest. Each is a single-field typo an author could plausibly make; the
 * anchor must exist in the real file (asserted), so a manifest rewrite cannot quietly retire a case.
 */
const MUTATIONS: Array<{ file: string; from: string; to: string; expect: RegExp }> = [
  { file: 'tenant-namespace.example.yaml', from: '\n  hard:\n', to: '\n  hardd:\n', expect: /ResourceQuota oshal-tenant-quota is invalid.*'hardd'/ },
  { file: 'tenant-network-policies.yaml', from: '  podSelector: {}\n', to: '  podSelectr: {}\n', expect: /NetworkPolicy default-deny-all is invalid.*'podSelectr'/ },
  { file: 'argo-executor-rbac.yaml', from: '    verbs: [create, patch, get, list, watch]\n', to: '    verb: [create, patch, get, list, watch]\n', expect: /Role argo-executor is invalid/ },
  { file: 'tenant-workspace-pvc.example.yaml', from: '  accessModes: [ReadWriteOnce]\n', to: '  accessMode: [ReadWriteOnce]\n', expect: /PersistentVolumeClaim oshal-workspace-shared is invalid.*'accessMode'/ },
  { file: 'incident-rca-workflowtemplate.yaml', from: '\n  entrypoint: incident-rca\n', to: '\n  entrypointt: incident-rca\n', expect: /WorkflowTemplate oshal-incident-rca is invalid.*'entrypointt'/ },
];

/** @description Locate Git Bash without falling into Windows' WSL launcher. */
function resolveBash(): { bash: string; toolPath: string } {
  if (process.platform !== 'win32') return { bash: 'bash', toolPath: '/usr/bin:/bin' };
  let dir = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  for (let up = 0; up < 6; up += 1) {
    const candidate = path.join(dir, 'bin', 'bash.exe');
    if (fs.existsSync(candidate)) {
      return { bash: candidate, toolPath: [path.join(dir, 'bin'), path.join(dir, 'usr', 'bin')].join(path.delimiter) };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Git Bash not found; refusing the WSL bash on PATH');
}

const { bash: BASH, toolPath: TOOL_PATH } = resolveBash();
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-k8s-gates-'));
const STAND_INS = path.join(SCRATCH, 'stand-ins');
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

interface Run {
  status: number | null;
  out: string;
}

/** @description Environment without anything that could steer a gate from outside the case. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith('OSHAL_')) env[key] = value;
  }
  return { ...env, ...extra };
}

/** @description Run a script in Git Bash and capture its exit status and combined output. */
function runBash(args: string[], env: NodeJS.ProcessEnv): Run {
  const res = spawnSync(BASH, args, { encoding: 'utf8', env, timeout: RUN_TIMEOUT_MS });
  if (res.error) throw res.error;
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/**
 * @description Find the REAL binary a gate would use (its OSHAL_ override, else PATH). Absent is a
 * loud failure: this guard exists to prove the real tool turns the gate red, so it does not skip.
 */
function requireTool(tool: 'kubeconform' | 'terraform'): string {
  const key = tool === 'kubeconform' ? 'OSHAL_KUBECONFORM' : 'OSHAL_TERRAFORM';
  const probe = spawnSync(BASH, ['-c', `command -v "\${${key}:-${tool}}"`], { encoding: 'utf8', env: process.env });
  const found = (probe.stdout ?? '').trim();
  if (probe.status !== 0 || !found) {
    throw new Error(`${tool} is not installed (PATH or ${key}); this guard runs the REAL ${tool} and does not skip. `
      + `Install it (see the header of scripts/ci/check-${tool === 'kubeconform' ? 'argo-manifests' : 'terraform'}.sh).`);
  }
  return found;
}

/** @description A throwaway tree holding the given files, for a gate to judge as its root. */
function tree(name: string, files: Record<string, string>): string {
  const root = path.join(SCRATCH, name);
  fs.rmSync(root, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content, 'utf8');
  }
  return root.replaceAll('\\', '/');
}

/** @description All five real Argo manifests, with `override` replacing some by name. */
function argoTree(name: string, override: Record<string, string> = {}): string {
  const files: Record<string, string> = {};
  for (const file of ARGO_MANIFESTS) {
    files[`ops/deployment/argo/${file}`] = override[file] ?? fs.readFileSync(path.join(ARGO_DIR, file), 'utf8');
  }
  return tree(name, files);
}

/** @description Run the argo-manifests gate with the real kubeconform against a root. */
function argoGate(root: string, kubeconform: string): Run {
  return runBash([ARGO_GATE, root], cleanEnv({
    OSHAL_KUBECONFORM: kubeconform,
    OSHAL_KUBECONFORM_CACHE: path.join(os.tmpdir(), 'oshal-kubeconform-cache').replaceAll('\\', '/'),
  }));
}

describe('argo-manifests gate: the real kubeconform over all five ops/deployment/argo manifests', () => {
  it('judges the committed manifests green, every one of the five schema-validated, nothing skipped', () => {
    const kubeconform = requireTool('kubeconform');
    const on = fs.readdirSync(ARGO_DIR).filter((f) => f.endsWith('.yaml')).sort();
    expect(on, 'the directory holds exactly the five manifests this guard mutates').toEqual([...ARGO_MANIFESTS].sort());
    const run = argoGate(REPO_ROOT.replaceAll('\\', '/'), kubeconform);
    expect(run.status, run.out).toBe(0);
    for (const file of ARGO_MANIFESTS) {
      expect(run.out, `${file} must be validated, not merely listed`).toMatch(new RegExp(`ops/deployment/argo/${file.replaceAll('.', '\\.')} - \\S+ \\S+ is valid`));
    }
    expect(run.out).toMatch(/WorkflowTemplate oshal-incident-rca is valid/);
    expect(run.out).toMatch(/Skipped: 0$/m);
    expect(run.out).toContain('argo-manifests: PASS');
  }, RUN_TIMEOUT_MS);

  for (const mutation of MUTATIONS) {
    it(`turns red on a malformed edit to ${mutation.file}, naming the file and the field`, () => {
      const kubeconform = requireTool('kubeconform');
      const real = fs.readFileSync(path.join(ARGO_DIR, mutation.file), 'utf8');
      expect(real.includes(mutation.from), `mutation anchor missing from ${mutation.file}`).toBe(true);
      const root = argoTree(`mutated-${mutation.file}`, { [mutation.file]: real.replace(mutation.from, mutation.to) });
      const run = argoGate(root, kubeconform);
      expect(run.status, run.out).toBe(1);
      expect(run.out).toMatch(new RegExp(`ops/deployment/argo/${mutation.file.replaceAll('.', '\\.')} - `));
      expect(run.out).toMatch(mutation.expect);
      expect(run.out).toContain('argo-manifests: FAIL');
    }, RUN_TIMEOUT_MS);
  }

  it('turns red on a YAML syntax break', () => {
    const kubeconform = requireTool('kubeconform');
    const file = 'tenant-workspace-pvc.example.yaml';
    const real = fs.readFileSync(path.join(ARGO_DIR, file), 'utf8');
    const root = argoTree('yaml-break', { [file]: real.replace('[ReadWriteOnce]', '[ReadWriteOnce') });
    const run = argoGate(root, kubeconform);
    expect(run.status, run.out).toBe(1);
    expect(run.out).toMatch(/error converting YAML to JSON/);
  }, RUN_TIMEOUT_MS);

  it('is UNCHECKED, not PASS, without kubeconform - and says how to install it', () => {
    const run = runBash([ARGO_GATE, REPO_ROOT.replaceAll('\\', '/')], cleanEnv({ OSHAL_KUBECONFORM: 'kubeconform-absent-for-this-case' }));
    expect(run.status, run.out).toBe(2);
    expect(run.out).toContain('argo-manifests: UNCHECKED - kubeconform not found');
    expect(run.out).toContain('https://github.com/yannh/kubeconform/releases');
  }, RUN_TIMEOUT_MS);

  it('is UNCHECKED, not PASS, when there is no manifest to judge', () => {
    const kubeconform = requireTool('kubeconform');
    const run = argoGate(tree('no-argo', { 'README.md': 'nothing here\n' }), kubeconform);
    expect(run.status, run.out).toBe(2);
    expect(run.out).toContain('nothing was judged');
  }, RUN_TIMEOUT_MS);
});

const TF_CLEAN = 'variable "x" {\n  type = string\n}\n\noutput "y" {\n  value = var.x\n}\n';

describe('terraform gate: the real terraform, fmt -check and validate', () => {
  /** @description Run the terraform gate with the real binary over a one-file module. */
  function tfGate(name: string, mainTf: string): { run: Run; module: string } {
    const terraform = requireTool('terraform');
    const root = tree(name, { 'deploy/terraform/main.tf': mainTf });
    const run = runBash([TF_GATE, root], cleanEnv({ OSHAL_TERRAFORM: terraform }));
    return { run, module: path.join(root, 'deploy', 'terraform') };
  }

  it('passes a formatted, valid module and writes nothing into it', () => {
    const { run, module } = tfGate('tf-clean', TF_CLEAN);
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain('terraform: fmt PASS');
    expect(run.out).toContain('terraform: validate PASS');
    expect(fs.readdirSync(module), 'init must not leave .terraform or a lock file in the tree it judges').toEqual(['main.tf']);
  }, RUN_TIMEOUT_MS);

  it('fails an unformatted module even when it is valid', () => {
    const { run } = tfGate('tf-unformatted', TF_CLEAN.replace('type = string', 'type    = string'));
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('terraform: fmt FAIL');
    expect(run.out).toContain('terraform: validate PASS');
  }, RUN_TIMEOUT_MS);

  it('fails a module with a syntax error', () => {
    const { run } = tfGate('tf-syntax', TF_CLEAN.replace('  type = string\n}\n', '  type = string\n'));
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('terraform: validate FAIL');
  }, RUN_TIMEOUT_MS);

  it('fails a well-formed module that references an undeclared variable', () => {
    const { run } = tfGate('tf-undeclared', TF_CLEAN.replace('value = var.x', 'value = var.nope'));
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('terraform: fmt PASS');
    expect(run.out).toContain('terraform: validate FAIL');
    expect(run.out).toMatch(/"nope" has not been declared/);
  }, RUN_TIMEOUT_MS);

  it('is UNCHECKED, not PASS, without terraform or without a module', () => {
    const absent = runBash([TF_GATE, REPO_ROOT.replaceAll('\\', '/')], cleanEnv({ OSHAL_TERRAFORM: 'terraform-absent-for-this-case' }));
    expect(absent.status, absent.out).toBe(2);
    expect(absent.out).toContain('terraform: UNCHECKED - terraform not found');
    expect(absent.out).toContain('https://releases.hashicorp.com/terraform/');
    const terraform = requireTool('terraform');
    const empty = runBash([TF_GATE, tree('tf-none', { 'README.md': 'x\n' })], cleanEnv({ OSHAL_TERRAFORM: terraform }));
    expect(empty.status, empty.out).toBe(2);
    expect(empty.out).toContain('nothing was judged');
  }, RUN_TIMEOUT_MS);
});

/**
 * kubectl stand-in. Logs every call, honours a leading --context, and emulates three clusters:
 * `unreachable`, `isolating` (tenant-a/tenant-b web pods that reach only themselves, both policies
 * present, the dependency grants in place) and `open` (the same, but cross-tenant traffic flows).
 */
const KUBECTL_STAND_IN = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$OSHAL_TEST_KUBECTL_LOG"
[ "\${1:-}" = "--context" ] && shift 2
mode="\${OSHAL_TEST_KUBECTL_CLUSTER:-unreachable}"
if [ "$mode" = unreachable ]; then
  echo "The connection to the server 127.0.0.1:6443 was refused - did you specify the right host or port?" >&2
  exit 1
fi
ip_for() { case "$1" in tenant-a) echo 10.1.0.10 ;; tenant-b) echo 10.2.0.10 ;; esac; }
case "$1" in
  cluster-info) echo "Kubernetes control plane is running at https://127.0.0.1:6443"; exit 0 ;;
  exec)
    ns="$3"; target="\${@: -1}"
    [ "$mode" = open ] && exit 0
    [ "$target" = "http://$(ip_for "$ns")/" ] && exit 0
    exit 1 ;;
  get)
    if [ "$2" = pod ]; then
      case "$*" in *metadata.name*) printf 'web-%s' "$4" ;; *podIP*) printf '%s' "$(ip_for "$4")" ;; esac
      exit 0
    fi
    if [ "$2" = networkpolicy ]; then
      case "$*" in
        *"-o json"*) printf '{\\n  "spec": {\\n    "egress": [\\n      {"to": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "oshal"}}}]},\\n      {"to": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "oshal-model"}}}]},\\n      {"to": [{"ipBlock": {"cidr": "192.168.65.3/32"}}]}\\n    ]\\n  }\\n}\\n' ;;
      esac
      exit 0
    fi ;;
esac
echo "kubectl stand-in: unhandled call: $*" >&2
exit 1
`;

/** Stand-ins used ONLY by the ci-local wiring cases: they pass, so only the cluster gates decide. */
const KUBECONFORM_STAND_IN = '#!/usr/bin/env bash\n[ "${1:-}" = -v ] && { echo v0.0.0-stand-in; exit 0; }\n'
  + 'echo "Summary: 1 resource found in 1 file - Valid: 1, Invalid: 0, Errors: 0, Skipped: 0"\nexit 0\n';
const TERRAFORM_STAND_IN = '#!/usr/bin/env bash\n[ "${1:-}" = version ] && echo "Terraform v0.0.0-stand-in"\nexit 0\n';

let callCount = 0;

beforeAll(() => {
  fs.mkdirSync(STAND_INS, { recursive: true });
  for (const [name, body] of [['kubectl', KUBECTL_STAND_IN], ['kubeconform', KUBECONFORM_STAND_IN], ['terraform', TERRAFORM_STAND_IN]]) {
    fs.writeFileSync(path.join(STAND_INS, name), body, { encoding: 'utf8', mode: 0o755 });
  }
});

/**
 * @description Environment for a cluster-gate case: the stand-ins first on a PATH that holds only
 * them and Git Bash's own tools, so the real kubectl on this box is unreachable from the case.
 */
function clusterEnv(cluster: string, extra: Record<string, string> = {}): { env: NodeJS.ProcessEnv; calls: () => string[] } {
  const log = path.join(SCRATCH, `kubectl-calls-${callCount += 1}.log`);
  fs.writeFileSync(log, '');
  const env = cleanEnv({
    PATH: [STAND_INS, TOOL_PATH].join(path.delimiter),
    OSHAL_TEST_KUBECTL_CLUSTER: cluster,
    OSHAL_TEST_KUBECTL_LOG: log.replaceAll('\\', '/'),
    ...extra,
  });
  for (const key of Object.keys(env)) if (key !== 'PATH' && key.toUpperCase() === 'PATH') delete env[key];
  return { env, calls: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

describe('cluster gates refuse without a named, reachable cluster and never report a pass they did not earn', () => {
  it('refuses with no OSHAL_CLUSTER_CONTEXT, before asking kubectl anything', () => {
    for (const which of ['bot-manifest', 'tenant-isolation']) {
      const { env, calls } = clusterEnv('isolating');
      const run = runBash([CLUSTER_GATE, which], env);
      expect(run.status, run.out).toBe(2);
      expect(run.out).toContain(`cluster-${which}: UNCHECKED - OSHAL_CLUSTER_CONTEXT is not set`);
      expect(calls(), 'no context means no kubectl call at all').toEqual([]);
    }
  }, RUN_TIMEOUT_MS);

  it('refuses when no API server answers at the named context, and asks only that context', () => {
    for (const which of ['bot-manifest', 'tenant-isolation']) {
      const { env, calls } = clusterEnv('unreachable', { OSHAL_CLUSTER_CONTEXT: CONTEXT });
      const run = runBash([CLUSTER_GATE, which], env);
      expect(run.status, run.out).toBe(2);
      expect(run.out).toContain(`no API server answered at context '${CONTEXT}'`);
      expect(run.out).not.toMatch(/PASS/);
      expect(calls()).toEqual([`--context ${CONTEXT} cluster-info`]);
    }
  }, RUN_TIMEOUT_MS);

  it('refuses when kubectl is not installed', () => {
    const env = cleanEnv({ PATH: TOOL_PATH, OSHAL_CLUSTER_CONTEXT: CONTEXT });
    for (const key of Object.keys(env)) if (key !== 'PATH' && key.toUpperCase() === 'PATH') delete env[key];
    const run = runBash([CLUSTER_GATE, 'tenant-isolation'], env);
    expect(run.status, run.out).toBe(2);
    expect(run.out).toContain('kubectl is not on PATH');
  }, RUN_TIMEOUT_MS);

  it('passes the tenant-isolation gate only on an isolating cluster, with the context on every kubectl call', () => {
    const { env, calls } = clusterEnv('isolating', { OSHAL_CLUSTER_CONTEXT: CONTEXT });
    const run = runBash([CLUSTER_GATE, 'tenant-isolation'], env);
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain('CROSS-TENANT ISOLATION PROVEN');
    expect(run.out).toContain(`cluster-tenant-isolation: PASS (context '${CONTEXT}')`);
    const made = calls();
    expect(made.length).toBeGreaterThan(10);
    for (const call of made) expect(call, 'every kubectl call must carry the named context').toMatch(new RegExp(`^--context ${CONTEXT} `));
  }, RUN_TIMEOUT_MS);

  it('fails the tenant-isolation gate when cross-tenant traffic flows', () => {
    const { env } = clusterEnv('open', { OSHAL_CLUSTER_CONTEXT: CONTEXT });
    const run = runBash([CLUSTER_GATE, 'tenant-isolation'], env);
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('tenant-a REACHED tenant-b');
    expect(run.out).toContain(`cluster-tenant-isolation: FAIL (context '${CONTEXT}')`);
  }, RUN_TIMEOUT_MS);

  it('verify-tenant-isolation.sh refuses an argument it does not know instead of ignoring it', () => {
    const { env, calls } = clusterEnv('isolating');
    const run = runBash([TENANT_SCRIPT, '--contxt', CONTEXT], env);
    expect(run.status, run.out).toBe(2);
    expect(run.out).toContain('unknown argument: --contxt');
    expect(calls()).toEqual([]);
  }, RUN_TIMEOUT_MS);
});

describe('ci-local.sh wiring: the cluster gates are opt-in, and fail closed when opted in', () => {
  /** @description Run ci-local.sh with its state directory inside the scratch tree. */
  function ciLocal(args: string[], cluster: string, extra: Record<string, string> = {}): { run: Run; calls: string[] } {
    const state = path.join(SCRATCH, `localappdata-${callCount + 1}`);
    fs.mkdirSync(state, { recursive: true });
    const { env, calls } = clusterEnv(cluster, { LOCALAPPDATA: state, ...extra });
    const run = runBash([CI_LOCAL, ...args], env);
    return { run, calls: calls() };
  }

  it('--k8s-only runs argo-manifests and terraform, never touches kubectl, and says the cluster gates did NOT RUN', () => {
    const { run, calls } = ciLocal(['--k8s-only'], 'isolating', { OSHAL_CLUSTER_CONTEXT: CONTEXT });
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain('GATE argo-manifests: PASS');
    expect(run.out).toContain('GATE terraform: PASS');
    expect(run.out).toContain('GATES cluster-bot-manifest + cluster-tenant-isolation: NOT RUN (opt-in: --cluster-gates');
    expect(run.out).not.toContain('GATE cluster-');
    expect(calls, 'without --cluster-gates no kubectl call is made, even with a context set').toEqual([]);
  }, RUN_TIMEOUT_MS);

  it('--k8s-only --cluster-gates with no reachable cluster is FAIL for both cluster gates, not a pass', () => {
    const { run, calls } = ciLocal(['--k8s-only', '--cluster-gates'], 'unreachable', { OSHAL_CLUSTER_CONTEXT: CONTEXT });
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('GATE cluster-bot-manifest: FAIL');
    expect(run.out).toContain('GATE cluster-tenant-isolation: FAIL');
    expect(run.out).toContain('=== K8S GATES: FAILED: cluster-bot-manifest cluster-tenant-isolation ===');
    expect(calls.every((c) => c.startsWith(`--context ${CONTEXT} `))).toBe(true);
  }, RUN_TIMEOUT_MS);

  it('--k8s-only refuses a flag it would otherwise silently ignore', () => {
    const { run } = ciLocal(['--k8s-only', '--head'], 'unreachable');
    expect(run.status, run.out).toBe(2);
    expect(run.out).toContain('--k8s-only takes only --cluster-gates beside it');
  }, RUN_TIMEOUT_MS);

  it('the full run always calls the two cluster-free gates and the cluster gates only behind --cluster-gates', () => {
    const source = fs.readFileSync(CI_LOCAL, 'utf8');
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
