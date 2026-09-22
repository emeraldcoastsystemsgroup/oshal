/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The REAL-tool half of the argo-manifests and terraform gate guards, moved out of tests/unit/ci-local-k8s-gates.spec.ts (whose CHANGE LOG entry 1 records how the cases were written). That file threw when kubeconform or terraform was absent, and it runs in the hosted CI Test job, which installs neither - so it would have turned hosted CI red on merge (review of wp/validators, item 8). The gate LOGIC is now guarded there with recording stand-ins that need no tool. What only the real binaries can show stays here: the real kubeconform judges the committed Argo tree green, and a copy with one malformed edit per manifest (all five, the WorkflowTemplate included) or a YAML syntax break red, naming the file and the field; the real terraform judges throwaway modules, clean green and unformatted, syntax-broken or undeclared-reference red, and nothing is written into the module. Each case is it.skipIf on its tool. Where a tool is absent, one case runs in their place: it prints why they skipped (an all-skipped file prints nothing under the default reporter) and proves the gate itself is UNCHECKED on that host, so the skip never stands beside a green gate.
 *
 * NO DOUBLES: the real kubeconform and terraform. Where they are absent these cases skip, and they
 * say so on stderr. They cannot skip unnoticed in the local gate: they find the tool exactly as the
 * gates do (OSHAL_KUBECONFORM / OSHAL_TERRAFORM, else PATH), and `bash scripts/ci-local.sh` runs
 * the gates `argo-manifests` and `terraform` over the real tree with the real tools, red - with the
 * install instructions - when either tool is missing. The logic guard, which never skips, is
 * tests/unit/ci-local-k8s-gates.spec.ts.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ARGO_DIR, ARGO_MANIFESTS, BASH, MUTATIONS, REPO_ROOT, RUN_TIMEOUT_MS, SCRIPTS,
  argoTree, cleanEnv, makeScratch, posix, runBash, writeTree, type Run,
} from '../helpers/k8s-gate-harness';

const SCRATCH = makeScratch('oshal-k8s-real-tools-');
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

/**
 * @description Find the REAL binary a gate would use: its OSHAL_ override, else PATH.
 * @param tool the tool to look for
 * @returns its path, or '' when the gate could not find it either
 */
function findTool(tool: 'kubeconform' | 'terraform'): string {
  const key = tool === 'kubeconform' ? 'OSHAL_KUBECONFORM' : 'OSHAL_TERRAFORM';
  const probe = spawnSync(BASH, ['-c', `command -v "\${${key}:-${tool}}"`], { encoding: 'utf8', env: process.env });
  return probe.status === 0 ? (probe.stdout ?? '').trim() : '';
}

const KUBECONFORM = findTool('kubeconform');
const TERRAFORM = findTool('terraform');
const withKubeconform = it.skipIf(!KUBECONFORM);
const withTerraform = it.skipIf(!TERRAFORM);

/** Per tool: what the gate is called, its script, the variable that overrides it, and its install page. */
const TOOLS = [
  { tool: 'kubeconform', found: KUBECONFORM, gate: 'argo-manifests', script: SCRIPTS.argo, key: 'OSHAL_KUBECONFORM', hint: 'https://github.com/yannh/kubeconform/releases' },
  { tool: 'terraform', found: TERRAFORM, gate: 'terraform', script: SCRIPTS.terraform, key: 'OSHAL_TERRAFORM', hint: 'https://releases.hashicorp.com/terraform/' },
];

describe('a real tool that is absent: its cases skip, say why, and the gate itself refuses on this host', () => {
  for (const { tool, found, gate, script, key, hint } of TOOLS) {
    it.runIf(!found)(`${tool} is absent: the real-${tool} cases are skipped, and the ${gate} gate is UNCHECKED here, not green`, () => {
      console.warn(`[ci-local-k8s-gates-real-tools] SKIPPING the real-${tool} cases: ${tool} is not on PATH and ${key} is not set. `
        + 'The gate logic is still guarded, with no tool needed, by tests/unit/ci-local-k8s-gates.spec.ts. The real check runs in '
        + `\`bash scripts/ci-local.sh\` (gate ${gate}), which is red without ${tool}. Install it from ${hint}.`);
      const run = runBash([script, posix(REPO_ROOT)], process.env);
      expect(run.status, run.out).toBe(2);
      expect(run.out).toContain(`${gate}: UNCHECKED - ${tool} not found`);
      expect(run.out).toContain(hint);
    }, RUN_TIMEOUT_MS);
  }
});

/** @description Run the argo-manifests gate with the real kubeconform against a root. */
function argoGate(root: string): Run {
  return runBash([SCRIPTS.argo, root], cleanEnv({
    OSHAL_KUBECONFORM: KUBECONFORM,
    OSHAL_KUBECONFORM_CACHE: posix(path.join(os.tmpdir(), 'oshal-kubeconform-cache')),
  }));
}

describe('argo-manifests gate: the real kubeconform over all five ops/deployment/argo manifests', () => {
  withKubeconform('judges the committed manifests green, every one of the five schema-validated, nothing skipped', () => {
    const on = fs.readdirSync(ARGO_DIR).filter((f) => f.endsWith('.yaml')).sort();
    expect(on, 'the directory holds exactly the five manifests this guard mutates').toEqual([...ARGO_MANIFESTS].sort());
    const run = argoGate(posix(REPO_ROOT));
    expect(run.status, run.out).toBe(0);
    for (const file of ARGO_MANIFESTS) {
      expect(run.out, `${file} must be validated, not merely listed`).toMatch(new RegExp(`ops/deployment/argo/${file.replaceAll('.', '\\.')} - \\S+ \\S+ is valid`));
    }
    expect(run.out).toMatch(/WorkflowTemplate oshal-incident-rca is valid/);
    expect(run.out).toMatch(/Skipped: 0$/m);
    expect(run.out).toContain('argo-manifests: PASS');
  }, RUN_TIMEOUT_MS);

  for (const mutation of MUTATIONS) {
    withKubeconform(`turns red on a malformed edit to ${mutation.file}, naming the file and the field`, () => {
      const real = fs.readFileSync(path.join(ARGO_DIR, mutation.file), 'utf8');
      expect(real.includes(mutation.from), `mutation anchor missing from ${mutation.file}`).toBe(true);
      const root = argoTree(path.join(SCRATCH, `mutated-${mutation.file}`), { [mutation.file]: real.replace(mutation.from, mutation.to) });
      const run = argoGate(root);
      expect(run.status, run.out).toBe(1);
      expect(run.out).toMatch(new RegExp(`ops/deployment/argo/${mutation.file.replaceAll('.', '\\.')} - `));
      expect(run.out).toMatch(mutation.expect);
      expect(run.out).toContain('argo-manifests: FAIL');
    }, RUN_TIMEOUT_MS);
  }

  withKubeconform('turns red on a YAML syntax break', () => {
    const file = 'tenant-workspace-pvc.example.yaml';
    const real = fs.readFileSync(path.join(ARGO_DIR, file), 'utf8');
    const run = argoGate(argoTree(path.join(SCRATCH, 'yaml-break'), { [file]: real.replace('[ReadWriteOnce]', '[ReadWriteOnce') }));
    expect(run.status, run.out).toBe(1);
    expect(run.out).toMatch(/error converting YAML to JSON/);
  }, RUN_TIMEOUT_MS);
});

const TF_CLEAN = 'variable "x" {\n  type = string\n}\n\noutput "y" {\n  value = var.x\n}\n';

describe('terraform gate: the real terraform, fmt -check and validate', () => {
  /** @description Run the terraform gate with the real binary over a one-file module. */
  function tfGate(name: string, mainTf: string): { run: Run; module: string } {
    const root = writeTree(path.join(SCRATCH, name), { 'deploy/terraform/main.tf': mainTf });
    const run = runBash([SCRIPTS.terraform, root], cleanEnv({ OSHAL_TERRAFORM: TERRAFORM }));
    return { run, module: path.join(root, 'deploy', 'terraform') };
  }

  withTerraform('passes a formatted, valid module and writes nothing into it', () => {
    const { run, module } = tfGate('tf-clean', TF_CLEAN);
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain('terraform: fmt PASS');
    expect(run.out).toContain('terraform: validate PASS');
    expect(fs.readdirSync(module), 'init must not leave .terraform or a lock file in the tree it judges').toEqual(['main.tf']);
  }, RUN_TIMEOUT_MS);

  withTerraform('fails an unformatted module even when it is valid', () => {
    const { run } = tfGate('tf-unformatted', TF_CLEAN.replace('type = string', 'type    = string'));
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('terraform: fmt FAIL');
    expect(run.out).toContain('terraform: validate PASS');
  }, RUN_TIMEOUT_MS);

  withTerraform('fails a module with a syntax error', () => {
    const { run } = tfGate('tf-syntax', TF_CLEAN.replace('  type = string\n}\n', '  type = string\n'));
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('terraform: validate FAIL');
  }, RUN_TIMEOUT_MS);

  withTerraform('fails a well-formed module that references an undeclared variable', () => {
    const { run } = tfGate('tf-undeclared', TF_CLEAN.replace('value = var.x', 'value = var.nope'));
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('terraform: fmt PASS');
    expect(run.out).toContain('terraform: validate FAIL');
    expect(run.out).toMatch(/"nope" has not been declared/);
  }, RUN_TIMEOUT_MS);
});
