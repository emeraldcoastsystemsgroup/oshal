/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard the SEC-06 automatic trigger, immutable-action, fail-closed scan, policy-discovery, and CodeQL exception contracts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Extend immutable-action enforcement to every workflow, including the manual CI and publish gate.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error The dependency-free CI command is plain ESM so CodeQL jobs need no npm install.
import { evaluateFindings, findingsFromSarif } from '../../scripts/security/check-codeql-sarif.mjs';
// @ts-expect-error The dependency-free discovery command intentionally has no generated declaration.
import { discoverPolicySpecs } from '../../scripts/security/run-policy-gates.mjs';

const securityWorkflow = readFileSync('.github/workflows/security.yml', 'utf8');
const legacyWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const gitleaksConfig = readFileSync('.gitleaks.toml', 'utf8');

/**
 * @description Collect every external action reference from every workflow so a mutable tag cannot
 * re-enter through a cheaper or manual pipeline outside the dedicated security workflow.
 */
function allWorkflowActions(): Array<{ workflow: string; action: string }> {
  return readdirSync('.github/workflows')
    .filter((file) => /\.ya?ml$/.test(file))
    .flatMap((workflow) => {
      const source = readFileSync(resolve('.github/workflows', workflow), 'utf8');
      return [...source.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)]
        .map((match) => ({ workflow, action: match[1] }));
    });
}

describe('SEC-06 security workflow contract', () => {
  it('runs on PRs, exact main pushes, one weekly schedule, and manual dispatch', () => {
    expect(securityWorkflow).toMatch(/^  pull_request:\s*$/m);
    expect(securityWorkflow).toMatch(/^  push:\s*\n    branches: \[main\]$/m);
    expect(securityWorkflow).toMatch(/^  schedule:\s*\n    - cron: "17 07 \* \* 1"$/m);
    expect(securityWorkflow).toMatch(/^  workflow_dispatch:\s*$/m);
  });

  it('pins every third-party action in every workflow to an immutable commit', () => {
    const actions = allWorkflowActions();
    expect(actions.length).toBeGreaterThan(20);
    for (const { workflow, action } of actions) {
      expect(action, `${workflow} uses a mutable action reference`).toMatch(/^[^@]+@[0-9a-f]{40}$/);
    }
  });

  it('keeps every security control blocking and aggregates all required jobs', () => {
    expect(securityWorkflow).not.toMatch(/\|\|\s*true|continue-on-error\s*:\s*true/i);
    for (const token of [
      'security-extended',
      'check-codeql-sarif.mjs',
      'run-policy-gates.mjs',
      'check-backlog-active-only.js',
      'pip_audit',
      '--log-opts="--all"',
      '--no-git',
      'severity: CRITICAL,HIGH',
      'format: cyclonedx',
      'SEC-06 required security gate',
    ]) expect(securityWorkflow).toContain(token);
  });

  it('does not retain the former advisory npm-audit bypass in manual CI', () => {
    expect(legacyWorkflow).not.toMatch(/npm audit[^\n]*\|\|\s*true/);
  });

  it('does not hide whole test trees or test suffixes from secret scanning', () => {
    expect(gitleaksConfig).not.toContain("'''tests/.*'''");
    expect(gitleaksConfig).not.toContain("'''.*\\.spec\\.ts$'''");
    expect(gitleaksConfig).not.toContain("'''.*\\.test\\.ts$'''");
    expect(gitleaksConfig).toContain('Exact synthetic secret-detection fixtures');
    expect(gitleaksConfig).toContain('condition = "AND"');
  });
});

describe('SEC-06 policy discovery', () => {
  it('discovers route, machine-write, migration, RLS, and workflow guards non-emptily', () => {
    const files = discoverPolicySpecs(resolve('.'));
    expect(files).toContain('tests/unit/server-route-auth-inventory.spec.ts');
    expect(files).toContain('tests/unit/machine-write-identity.spec.ts');
    expect(files).toContain('tests/unit/security-ci-contract.spec.ts');
    expect(files).toContain('tests/unit/backlog-active-only.spec.ts');
    expect(files.filter((file) => /(?:migration|rls).*\.spec\.ts$/i.test(file)).length).toBeGreaterThan(4);
  });
});

describe('CodeQL SARIF enforcement', () => {
  const sarif = {
    runs: [{
      tool: { driver: { rules: [{ id: 'js/example', properties: { 'security-severity': '8.2' } }] } },
      results: [{ ruleId: 'js/example', ruleIndex: 0, level: 'warning', locations: [{
        physicalLocation: { artifactLocation: { uri: 'src/example.ts' } },
      }] }],
    }],
  };

  it('blocks high findings even when SARIF labels them warning', () => {
    const findings = findingsFromSarif(sarif);
    expect(evaluateFindings(findings, { exceptions: [] })[0].reason).toBe('high-or-critical');
  });

  it('requires an exact unexpired ledger entry for lower findings', () => {
    const finding = { ruleId: 'js/low', path: 'src/low.ts', level: 'warning', securityScore: 4.1 };
    expect(evaluateFindings([finding], { exceptions: [] })[0].reason).toBe('missing-expiring-exception');
    const exceptions = [{
      ruleId: 'js/low',
      path: 'src/low.ts',
      owner: 'maintainer@emeraldcoastsystemsgroup.com',
      reason: 'Reviewed compensating control',
      expires: '2099-01-01',
    }];
    expect(evaluateFindings([finding], { exceptions })).toEqual([]);
  });
});
