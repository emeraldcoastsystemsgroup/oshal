/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from tests/unit/ci-local-k8s-gates.spec.ts when it split into three specs: the gate logic with recording stand-ins (runs in hosted CI, which installs neither kubeconform nor terraform), the real-tool cases, and the cluster-gate wrapper. One copy of the Git Bash resolution, the environment scrubbing, the kubectl emulation and the recording stand-ins, so the three specs cannot drift into driving a different shell or a different stand-in from each other.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const RUN_TIMEOUT_MS = 300_000;

/**
 * @description Forward-slash form of a path, which Git Bash and the gate scripts accept on Windows.
 * @param p a native path
 * @returns the same path with every backslash turned into a slash
 */
export function posix(p: string): string {
  return p.replaceAll('\\', '/');
}

/** The shipped scripts these specs run. */
export const SCRIPTS = {
  argo: posix(path.join(REPO_ROOT, 'scripts', 'ci', 'check-argo-manifests.sh')),
  terraform: posix(path.join(REPO_ROOT, 'scripts', 'ci', 'check-terraform.sh')),
  cluster: posix(path.join(REPO_ROOT, 'scripts', 'ci', 'check-cluster-gates.sh')),
  tenantIsolation: posix(path.join(REPO_ROOT, 'scripts', 'governance', 'verify-tenant-isolation.sh')),
  ciLocal: posix(path.join(REPO_ROOT, 'scripts', 'ci-local.sh')),
};

export const ARGO_DIR = path.join(REPO_ROOT, 'ops', 'deployment', 'argo');

/** The five manifests the work package names; the directory glob must cover every one. */
export const ARGO_MANIFESTS = [
  'tenant-namespace.example.yaml',
  'tenant-network-policies.yaml',
  'argo-executor-rbac.yaml',
  'tenant-workspace-pvc.example.yaml',
  'incident-rca-workflowtemplate.yaml',
];

/**
 * One malformed edit per manifest: a single-field typo an author could plausibly make. `field` is
 * the misspelt key. The anchor must exist in the real file (the specs assert it), so a manifest
 * rewrite cannot quietly retire a case. `expect` is what the REAL kubeconform says about it.
 */
export const MUTATIONS: Array<{ file: string; from: string; to: string; field: string; expect: RegExp }> = [
  { file: 'tenant-namespace.example.yaml', from: '\n  hard:\n', to: '\n  hardd:\n', field: 'hardd', expect: /ResourceQuota oshal-tenant-quota is invalid.*'hardd'/ },
  { file: 'tenant-network-policies.yaml', from: '  podSelector: {}\n', to: '  podSelectr: {}\n', field: 'podSelectr', expect: /NetworkPolicy default-deny-all is invalid.*'podSelectr'/ },
  { file: 'argo-executor-rbac.yaml', from: '    verbs: [create, patch, get, list, watch]\n', to: '    verb: [create, patch, get, list, watch]\n', field: 'verb', expect: /Role argo-executor is invalid/ },
  { file: 'tenant-workspace-pvc.example.yaml', from: '  accessModes: [ReadWriteOnce]\n', to: '  accessMode: [ReadWriteOnce]\n', field: 'accessMode', expect: /PersistentVolumeClaim oshal-workspace-shared is invalid.*'accessMode'/ },
  { file: 'incident-rca-workflowtemplate.yaml', from: '\n  entrypoint: incident-rca\n', to: '\n  entrypointt: incident-rca\n', field: 'entrypointt', expect: /WorkflowTemplate oshal-incident-rca is invalid.*'entrypointt'/ },
];

/**
 * @description Locate Git Bash without falling into Windows' WSL launcher, which runs in another
 * filesystem namespace and would judge a different tree than the one a case built.
 * @returns the bash to run, and (on Windows) the Git for Windows directories holding its own tools
 */
function resolveBash(): { bash: string; gitTools: string[] } {
  if (process.platform !== 'win32') return { bash: 'bash', gitTools: [] };
  let dir = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  for (let up = 0; up < 6; up += 1) {
    const candidate = path.join(dir, 'bin', 'bash.exe');
    if (fs.existsSync(candidate)) return { bash: candidate, gitTools: [path.join(dir, 'bin'), path.join(dir, 'usr', 'bin')] };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Git Bash not found; refusing the WSL bash on PATH');
}

const { bash: BASH_FOUND, gitTools: GIT_TOOLS } = resolveBash();
export const BASH = BASH_FOUND;

/**
 * The commands a case must only ever reach as a stand-in, or not at all. A hosted Linux runner
 * can carry any of them in /usr/bin, where a "tool absent" case would find the real one.
 */
const SHADOWED = new Set(['kubectl', 'kubeconform', 'terraform', 'helm', 'node', 'npm', 'npx', 'tsx', 'docker']);

/**
 * @description The host's own shell tools as a PATH fragment, with none of the tools under test in
 * it. On Windows that is Git for Windows' bin directories, which carry none of them. Elsewhere it
 * is a directory of links to every command in /usr/bin and /bin except SHADOWED.
 * @param scratch the spec's scratch directory (the link directory is created there)
 * @returns the PATH fragment
 */
export function hostTools(scratch: string): string {
  if (process.platform === 'win32') return GIT_TOOLS.join(path.delimiter);
  const dir = path.join(scratch, 'host-tools');
  fs.mkdirSync(dir, { recursive: true });
  const linked = new Set(fs.readdirSync(dir));
  for (const source of ['/usr/bin', '/bin']) {
    if (!fs.existsSync(source)) continue;
    for (const name of fs.readdirSync(source)) {
      if (SHADOWED.has(name) || linked.has(name)) continue;
      fs.symlinkSync(path.join(source, name), path.join(dir, name));
      linked.add(name);
    }
  }
  return dir;
}

/** A finished script run. */
export interface Run {
  status: number | null;
  out: string;
}

/**
 * @description Environment without anything that could steer a gate from outside the case: every
 * OSHAL_* variable of the calling shell is dropped (an operator's OSHAL_KUBECONFORM would otherwise
 * point a stand-in case at a real binary).
 * @param extra the variables the case sets
 * @returns the scrubbed environment
 */
export function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith('OSHAL_')) env[key] = value;
  }
  return { ...env, ...extra };
}

/**
 * @description Replace the search path with exactly `dirs`. Windows carries it as `Path`, so every
 * other spelling is removed or the child would see two search paths.
 * @param env the environment to rewrite in place
 * @param dirs the only directories a command may be found in
 * @returns the same environment
 */
export function onlyPath(env: NodeJS.ProcessEnv, dirs: string[]): NodeJS.ProcessEnv {
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = dirs.join(path.delimiter);
  return env;
}

/**
 * @description Run a script in Git Bash and capture its exit status and combined output.
 * @param args the script and its arguments
 * @param env the complete environment of the run
 * @returns exit status and stdout+stderr
 */
export function runBash(args: string[], env: NodeJS.ProcessEnv): Run {
  const res = spawnSync(BASH, args, { encoding: 'utf8', env, timeout: RUN_TIMEOUT_MS });
  if (res.error) throw res.error;
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/**
 * @description A fresh scratch directory for one spec file; the caller removes it in afterAll.
 * @param prefix directory name prefix under the OS temp directory
 * @returns the absolute path
 */
export function makeScratch(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * @description Write a throwaway tree holding exactly the given files, for a gate to judge as root.
 * @param root absolute directory, emptied first
 * @param files relative path to content
 * @returns the root in forward-slash form
 */
export function writeTree(root: string, files: Record<string, string>): string {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content, 'utf8');
  }
  return posix(root);
}

/**
 * @description All five real Argo manifests under ops/deployment/argo in a throwaway tree.
 * @param root absolute directory for the tree
 * @param override file name to replacement content
 * @returns the root in forward-slash form
 */
export function argoTree(root: string, override: Record<string, string> = {}): string {
  const files: Record<string, string> = {};
  for (const file of ARGO_MANIFESTS) {
    files[`ops/deployment/argo/${file}`] = override[file] ?? fs.readFileSync(path.join(ARGO_DIR, file), 'utf8');
  }
  return writeTree(root, files);
}

/**
 * @description Write an executable stand-in named `name` into `dir`.
 * @param dir directory that goes on the case's PATH
 * @param name command name the script under test will look up
 * @param body the bash script
 */
export function writeStandIn(dir: string, name: string, body: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body, { encoding: 'utf8', mode: 0o755 });
}

/** One call a recording stand-in received: its argv, and the variables it was told to report. */
export interface RecordedCall {
  args: string[];
  env: Record<string, string>;
}

/**
 * The recording prologue every tool stand-in starts with. One line per call: the argv joined by
 * US (0x1f), then RS (0x1e), then NAME=value pairs joined by US for the variables listed in
 * OSHAL_TEST_RECORD_VARS plus PWD (in C:/ form under Git Bash, so it compares with a Node path).
 * The separators cannot occur in a path or a flag, so an argument holding a space is still one
 * argument when the spec reads it back.
 */
const RECORD_PROLOGUE = `rec_args="$(IFS=$'\\x1f'; printf '%s' "$*")"
rec_env="PWD=$(pwd -W 2>/dev/null || pwd)"
for rec_var in \${OSHAL_TEST_RECORD_VARS:-}; do rec_env="$rec_env"$'\\x1f'"$rec_var=\${!rec_var-<unset>}"; done
printf '%s\\x1e%s\\n' "$rec_args" "$rec_env" >> "\${OSHAL_TEST_TOOL_LOG:-/dev/null}"
`;

/**
 * @description A bash stand-in that records every call (see RECORD_PROLOGUE), then runs `body`.
 * @param body what the stand-in does once the call is logged
 * @returns the complete script
 */
export function recordingScript(body: string): string {
  return `#!/usr/bin/env bash\n${RECORD_PROLOGUE}${body}`;
}

/**
 * kubeconform stand-in. `-v` answers a version. Otherwise it judges every *.yaml argument: a file
 * holding a key that OSHAL_TEST_KUBECONFORM_REJECT (an ERE alternation of key names) matches is
 * reported invalid (exit 1), as the real tool reports an unknown field under -strict; the rest are
 * valid. OSHAL_TEST_KUBECONFORM_MODE
 * scripts the other outcomes the gate must not call a pass: `schema-error` (a schema could not be
 * fetched, exit 1), `skipped` (exit 0 with a skipped resource) and `nothing` (exit 0, no resources).
 */
export const KUBECONFORM_STAND_IN = recordingScript(`[ "\${1:-}" = -v ] && { echo v0.0.0-stand-in; exit 0; }
files=(); for a in "$@"; do case "$a" in *.yaml) files+=("$a") ;; esac; done
n=\${#files[@]}
case "\${OSHAL_TEST_KUBECONFORM_MODE:-judge}" in
  schema-error)
    echo "\${files[0]} - WorkflowTemplate oshal-incident-rca failed validation: could not find schema for WorkflowTemplate"
    echo "Summary: $n resources found in $n files - Valid: $((n - 1)), Invalid: 0, Errors: 1, Skipped: 0"; exit 1 ;;
  skipped)
    echo "\${files[0]} - WorkflowTemplate oshal-incident-rca skipped"
    echo "Summary: $n resources found in $n files - Valid: $((n - 1)), Invalid: 0, Errors: 0, Skipped: 1"; exit 0 ;;
  nothing)
    echo "Summary: 0 resource found in $n files - Valid: 0, Invalid: 0, Errors: 0, Skipped: 0"; exit 0 ;;
esac
bad=0
for f in "\${files[@]}"; do
  if [ -n "\${OSHAL_TEST_KUBECONFORM_REJECT:-}" ] && grep -Eq "^[[:space:]-]*(\${OSHAL_TEST_KUBECONFORM_REJECT}):" "$f"; then
    echo "$f - stand-in is invalid: problem validating schema: an additional property matching '\${OSHAL_TEST_KUBECONFORM_REJECT}' is not allowed"
    bad=$((bad + 1))
  else
    echo "$f - stand-in is valid"
  fi
done
echo "Summary: $n resources found in $n files - Valid: $((n - bad)), Invalid: $bad, Errors: 0, Skipped: 0"
[ "$bad" -eq 0 ]
`);

/**
 * terraform stand-in. `version` answers one. The subcommand is the argument after -chdir=...;
 * each one named in OSHAL_TEST_TERRAFORM_FAIL (space-separated: fmt, init, validate) fails the way
 * the real tool does, the rest succeed. `init` writes into TF_DATA_DIR, as the real init writes
 * its providers there, so a case can prove the gate removes that directory and never writes into
 * the module it judges.
 */
export const TERRAFORM_STAND_IN = recordingScript(`sub="\${1:-}"; case "$sub" in -chdir=*) sub="\${2:-}" ;; esac
[ "$sub" = version ] && { echo "Terraform v0.0.0-stand-in"; exit 0; }
case " \${OSHAL_TEST_TERRAFORM_FAIL:-} " in *" $sub "*)
  case "$sub" in
    fmt) echo "main.tf"; exit 3 ;;
    init) echo "Error: Failed to query available provider packages (stand-in)"; exit 1 ;;
    validate) echo "Error: Reference to undeclared input variable (stand-in)"; exit 1 ;;
  esac ;;
esac
if [ "$sub" = init ] && [ -n "\${TF_DATA_DIR:-}" ]; then mkdir -p "$TF_DATA_DIR/providers" && echo stand-in > "$TF_DATA_DIR/providers/installed"; fi
[ "$sub" = validate ] && echo "Success! The configuration is valid."
exit 0
`);

/**
 * @description Read back what a recording stand-in was called with.
 * @param log the OSHAL_TEST_TOOL_LOG file
 * @returns one entry per call, in order
 */
export function readCalls(log: string): RecordedCall[] {
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.length > 0).map((line) => {
    const [argPart, envPart] = line.split('\x1e');
    const env: Record<string, string> = {};
    for (const pair of (envPart ?? '').split('\x1f')) {
      const eq = pair.indexOf('=');
      if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    return { args: argPart ? argPart.split('\x1f') : [], env };
  });
}

/**
 * kubectl stand-in. Logs every call ("$*", one line), honours a leading --context, and emulates
 * these clusters: `unreachable`; `isolating` (tenant-a/tenant-b web pods that reach only
 * themselves, both policies present, the dependency grants in place); `open` (the same, but
 * cross-tenant traffic flows); `admitting` (answers the launcher manifest's server-side dry-run,
 * marked "(server dry run)" as kubectl marks it, and exposes deployments/scale with patch);
 * `client-marks` (the dry-run exits 0 but no object carries the server mark); `drops-after-probe`
 * (answers the first cluster-info and refuses everything after it); `no-pods` (reachable, no
 * app=web pods); `hangs` (answers cluster-info, never returns from anything else).
 */
export const KUBECTL_STAND_IN = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$OSHAL_TEST_KUBECTL_LOG"
[ "\${1:-}" = "--context" ] && shift 2
mode="\${OSHAL_TEST_KUBECTL_CLUSTER:-unreachable}"
if [ "$mode" = drops-after-probe ] && [ "$(grep -c cluster-info "$OSHAL_TEST_KUBECTL_LOG")" -gt 1 ]; then mode=unreachable; fi
if [ "$mode" = unreachable ]; then
  echo "The connection to the server 127.0.0.1:6443 was refused - did you specify the right host or port?" >&2
  exit 1
fi
if [ "$mode" = hangs ] && [ "$1" != cluster-info ]; then sleep 30; exit 1; fi
ip_for() { case "$1" in tenant-a) echo 10.1.0.10 ;; tenant-b) echo 10.2.0.10 ;; esac; }
field() { printf '%s' "$1" | grep -o '"'"$2"'":"[^"]*"' | head -n 1 | cut -d '"' -f 4; }
case "$1" in
  cluster-info) echo "Kubernetes control plane is running at https://127.0.0.1:6443"; exit 0 ;;
  exec)
    ns="$3"; target="\${@: -1}"
    [ "$mode" = open ] && exit 0
    [ "$target" = "http://$(ip_for "$ns")/" ] && exit 0
    exit 1 ;;
  apply)
    dry=; for arg in "$@"; do case "$arg" in --dry-run=*) dry="\${arg#--dry-run=}" ;; esac; done
    mark="(dry run)"
    [ "$dry" = server ] && [ "$mode" != client-marks ] && mark="(server dry run)"
    while IFS= read -r doc || [ -n "$doc" ]; do
      case "$doc" in ""|---) continue ;; esac
      av="$(field "$doc" apiVersion)"; group=
      case "$av" in */*) group=".\${av%%/*}" ;; esac
      kind="$(field "$doc" kind | tr '[:upper:]' '[:lower:]')"
      printf '%s%s/%s created %s\\n' "$kind" "$group" "$(field "$doc" name)" "$mark"
    done
    exit 0 ;;
  get)
    if [ "$2" = namespace ]; then printf 'NAME STATUS AGE\\n%s Active 1d\\n' "$3"; exit 0; fi
    if [ "$2" = --raw ] && [ "$3" = /apis/apps/v1 ]; then
      printf '%s' '{"kind":"APIResourceList","groupVersion":"apps/v1","resources":[{"name":"deployments","verbs":["create","delete","get","list","patch","update","watch"]},{"name":"deployments/scale","verbs":["get","patch","update"]}]}'
      exit 0
    fi
    if [ "$2" = pod ]; then
      [ "$mode" = no-pods ] && exit 0
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

/**
 * @description Environment for a case that talks to the kubectl stand-in: a fresh call log, the
 * emulated cluster, and a PATH holding only `dirs`, so the real kubectl on this box (which may
 * point at a live cluster) is unreachable from the case.
 * @param scratch the spec's scratch directory (the call log goes there)
 * @param cluster the emulated cluster (see KUBECTL_STAND_IN)
 * @param dirs the only PATH entries
 * @param extra further variables for the case
 * @returns the environment, and a reader for the kubectl calls made
 */
export function kubectlEnv(
  scratch: string,
  cluster: string,
  dirs: string[],
  extra: Record<string, string> = {},
): { env: NodeJS.ProcessEnv; calls: () => string[] } {
  const log = fs.mkdtempSync(path.join(scratch, 'kubectl-log-'));
  const file = path.join(log, 'calls.log');
  fs.writeFileSync(file, '');
  const env = onlyPath(cleanEnv({
    OSHAL_TEST_KUBECTL_CLUSTER: cluster,
    OSHAL_TEST_KUBECTL_LOG: posix(file),
    ...extra,
  }), dirs);
  return { env, calls: () => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) };
}
