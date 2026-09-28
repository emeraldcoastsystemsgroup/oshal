/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Backlog #33: the exact-SHA package-audit Test Lab card is registered once, explicit-only (it installs over the network), keeps its suites on disk, judges an exact audited pin as pass and an unprovable attestation as a gap, and always removes its disposable install directory.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCENARIOS, scenariosForRun } from '@/app/routes/test-lab-scenarios';
import {
  APP_REGISTRY_SCENARIOS,
  exactShaEnforceInstall,
  packageAuditInstallVerdict,
  type AuditedCatalogPackage,
  type AuditInstallRun,
} from '@/app/routes/test-lab-app-registry-scenarios';

const SHA = '1234567890abcdef1234567890abcdef12345678';
const PKG: AuditedCatalogPackage = { name: 'sample-app', status: 'ready', source: { url: 'https://example.test/store', ref: 'main' }, audit: { sourceSha: SHA } };
const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'oshal-lab-audit-root-'));
  roots.push(root);
  return root;
}

function pinned(overrides: Record<string, unknown> = {}): AuditInstallRun {
  return { code: 0, output: '', provenance: { sha: SHA, audit: { mode: 'enforce', verified: true, sourceSha: SHA, ...overrides } } };
}

describe('exact-SHA package audit Test Lab card', () => {
  it('is registered once, explicit-only, with one step and suites that exist on disk', () => {
    const scenario = APP_REGISTRY_SCENARIOS.find((item) => item.id === 'package-audit-exact-sha')!;
    expect(SCENARIOS.filter((item) => item.id === 'package-audit-exact-sha')).toEqual([scenario]);
    expect(scenario.explicitOnly).toBe(true);
    expect(scenariosForRun('all').map((item) => item.id)).not.toContain('package-audit-exact-sha');
    expect(scenario.steps.map((step) => step.id)).toEqual(['enforce-install']);
    expect(scenario.regressionTests!.map((test) => test.path)).toContain('tests/unit/package-audit-installer.spec.ts');
    for (const test of scenario.regressionTests!) expect(existsSync(test.path), test.path).toBe(true);
  });

  it('passes only an exact audited pin and names unprovable attestations as a gap', () => {
    expect(packageAuditInstallVerdict(PKG, pinned()).state).toBe('pass');
    expect(packageAuditInstallVerdict(PKG, pinned({ verified: false })).state).toBe('fail');
    expect(packageAuditInstallVerdict(PKG, { ...pinned(), provenance: { sha: 'f'.repeat(40), audit: { mode: 'enforce', verified: true, sourceSha: SHA } } }).state).toBe('fail');
    const unserved = { code: 1, output: `refusing to install "sample-app"\n  error audited source ${SHA} (sample-app) cannot be read from this store; re-audit against this store required`, provenance: null };
    expect(packageAuditInstallVerdict(PKG, unserved)).toMatchObject({ state: 'gap', detail: expect.stringContaining('cannot be read from this store') });
    const stale = { code: 1, output: '  error package source sample-app changed since the audit (catalog tree a, audited tree b); re-audit required', provenance: null };
    expect(packageAuditInstallVerdict(PKG, stale).state).toBe('gap');
    expect(packageAuditInstallVerdict(PKG, { code: 1, output: 'install failed: could not resolve host', provenance: null }).state).toBe('degraded');
    expect(packageAuditInstallVerdict(PKG, { code: 1, output: '  error audit status is pending, not passed', provenance: null }).state).toBe('fail');
  });

  it('reports a gap without installing when no package carries an audited binding', async () => {
    let installs = 0;
    const result = await exactShaEnforceInstall({
      catalog: async () => ({ available: true, apps: [{ ...PKG, audit: { sourceSha: '0'.repeat(40) } }] }),
      install: async () => { installs += 1; return pinned(); },
      tempRoot: tempRoot(),
    });
    expect(result.state).toBe('gap');
    expect(installs).toBe(0);
    const unavailable = await exactShaEnforceInstall({ catalog: async () => ({ available: false, reason: 'offline', apps: [] }), install: async () => pinned(), tempRoot: tempRoot() });
    expect(unavailable).toMatchObject({ state: 'degraded', detail: expect.stringContaining('offline') });
  });

  it('installs into a disposable directory and removes it, even when the installer throws', async () => {
    const root = tempRoot();
    const seen: string[] = [];
    const install = async (_pkg: AuditedCatalogPackage, destination: string) => {
      seen.push(destination);
      mkdirSync(join(destination, 'sample-app'), { recursive: true });
      writeFileSync(join(destination, 'sample-app', '.oshal-install.json'), '{}');
      return pinned();
    };
    const result = await exactShaEnforceInstall({ catalog: async () => ({ available: true, apps: [PKG] }), install, tempRoot: root });
    expect(result.state).toBe('pass');
    expect(seen).toHaveLength(1);
    expect(seen[0].startsWith(root)).toBe(true);
    expect(existsSync(seen[0])).toBe(false);
    const failing = async (_pkg: AuditedCatalogPackage, destination: string): Promise<AuditInstallRun> => {
      seen.push(destination);
      throw new Error('installer crashed');
    };
    await expect(exactShaEnforceInstall({ catalog: async () => ({ available: true, apps: [PKG] }), install: failing, tempRoot: root })).rejects.toThrow('installer crashed');
    expect(existsSync(seen[1])).toBe(false);
  });
});
