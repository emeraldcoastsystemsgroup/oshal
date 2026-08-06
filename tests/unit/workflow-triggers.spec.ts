/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard the manual-only workflow budget after two automatic full-CI billing regressions.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Permit the bounded SEC-06 PR/main/weekly workflow while preserving manual-only general CI.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Keep runner-local Compose work classified as disposable image/build validation unless a separately reviewed durable deployment contract replaces it.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Revert entry 2. Asserting that security.yml MUST declare push and schedule inverted the guard: removing an automatic trigger — the safe direction, and the one that stops the billing — failed the build, so the test defended the spend instead of the budget. security.yml is manual-only again and is now covered by the same rule as every other workflow; the assertion that remains proves it cannot silently regain a trigger. Operator decision 2026-08-06.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const WORKFLOW_DIR = '.github/workflows';
const AUTOMATIC_TRIGGERS = ['push', 'pull_request', 'pull_request_target', 'schedule'];
const EXCEPTIONS: Record<string, string[]> = { 'publish-gate.yml': ['pull_request'] };
const DEPLOYMENT_DISPOSITION_DOCS = [
  'docs/BACKLOG.md',
  'docs/adr/090-github-actions-to-local-ci.md',
  'docs/backlog/non-human-checklist.md',
  'docs/runbooks/ci-cd.md',
  'docs/runbooks/local-ci.md',
];
const MISLABELED_RUNNER_DEPLOYMENT =
  /(?:runner-local|ephemeral(?:-runner)?|quickstart-smoke)\s+(?:compose\s+)?deployment\b|\bdeploys?\s+(?:to|on)\s+(?:the\s+)?(?:runner|ephemeral)\b/i;

/** @description Extract top-level trigger keys from block and inline workflow `on` forms. */
function declaredTriggers(source: string): string[] {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => /^on:/.test(line));
  if (start === -1) return [];
  const inline = /^on:\s*\[?([a-z_,\s]+)\]?\s*$/.exec(lines[start]);
  if (inline?.[1].trim()) return inline[1].split(',').map((value) => value.trim()).filter(Boolean);

  const out: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^[a-zA-Z_]/.test(lines[index])) break;
    const match = /^ {2}([a-z_]+):/.exec(lines[index]);
    if (match) out.push(match[1]);
  }
  return out;
}

describe('GitHub Actions automatic-trigger budget', () => {
  const files = existsSync(WORKFLOW_DIR)
    ? readdirSync(WORKFLOW_DIR).filter((file) => /\.ya?ml$/.test(file))
    : [];

  it('finds the workflow directory and every workflow remains manually runnable', () => {
    expect(existsSync(WORKFLOW_DIR)).toBe(true);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const triggers = declaredTriggers(readFileSync(join(WORKFLOW_DIR, file), 'utf8'));
      expect(triggers, `${file} cannot be run manually`).toContain('workflow_dispatch');
    }
  });

  it.each(files)('%s declares no unsanctioned automatic trigger', (file) => {
    const triggers = declaredTriggers(readFileSync(join(WORKFLOW_DIR, file), 'utf8'));
    const allowed = EXCEPTIONS[file] ?? [];
    const bad = triggers.filter((trigger) => AUTOMATIC_TRIGGERS.includes(trigger) && !allowed.includes(trigger));
    expect(bad, `${file} widened automatic execution beyond the reviewed budget`).toEqual([]);
  });

  it('keeps the public publish gate PR-only', () => {
    const source = readFileSync(join(WORKFLOW_DIR, 'publish-gate.yml'), 'utf8');
    const triggers = declaredTriggers(source);
    expect(triggers).toContain('pull_request');
    for (const forbidden of ['push', 'schedule', 'pull_request_target']) expect(triggers).not.toContain(forbidden);
  });

  it('keeps the security gate manual-only and its jobs intact', () => {
    const source = readFileSync(join(WORKFLOW_DIR, 'security.yml'), 'utf8');
    // Assert the ABSENCE of automatic triggers, never their presence. The previous form required
    // push and schedule to be declared, which meant turning hosted-runner billing off failed the
    // build — a cost guard pointed the wrong way.
    expect(declaredTriggers(source)).toEqual(['workflow_dispatch']);
    for (const forbidden of ['  push:', '  pull_request:', '  pull_request_target:', '  schedule:']) {
      expect(source, `security.yml regained an automatic trigger: ${forbidden.trim()}`)
        .not.toMatch(new RegExp(`^${forbidden}`, 'm'));
    }
    // Manual-only is a billing decision, not a reason to quietly lose coverage: the jobs must
    // still be here, and scripts/ci-local.sh is what runs them.
    for (const job of ['codeql:', 'policy-inventories:', 'dependency-audit:', 'secret-scan:', 'container-and-sbom:']) {
      expect(source, `security.yml dropped the ${job} job`).toMatch(new RegExp(`^  ${job}`, 'm'));
    }
    expect(readFileSync('scripts/ci-local.sh', 'utf8')).toContain('run-policy-gates.mjs');
  });

  it('keeps runner-local Compose work scoped as disposable image/build validation', () => {
    expect(files).not.toContain('deploy.yml');

    const ciSource = readFileSync(join(WORKFLOW_DIR, 'ci.yml'), 'utf8');
    expect(ciSource).toContain('EPHEMERAL IMAGE/BUILD VALIDATION ONLY');
    expect(ciSource).toMatch(/^  quickstart-smoke:$/m);
    expect(ciSource).toMatch(/- name: Tear down\s+if: always\(\)/);
    expect(ciSource).not.toMatch(/^  deploy[-_a-z0-9]*:$/mi);
    expect(ciSource).not.toMatch(/^\s+- name:\s*Deploy\b/im);
    expect(ciSource).not.toMatch(MISLABELED_RUNNER_DEPLOYMENT);

    for (const path of DEPLOYMENT_DISPOSITION_DOCS) {
      const source = readFileSync(path, 'utf8');
      expect(source, `${path} revived the retired deployment-workflow claim`)
        .not.toMatch(/\bdeploy\.yml\b/i);
      expect(source, `${path} mislabeled disposable runner validation as deployment`)
        .not.toMatch(MISLABELED_RUNNER_DEPLOYMENT);
    }
  });
});
