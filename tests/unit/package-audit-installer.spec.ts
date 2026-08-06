/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | APP-02: mutation guards for the core audit profile, safe record loading, staged policy, and a real Git exact-SHA install boundary.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const audit = require('../../scripts/oshal-package-audit') as {
  PACKAGE_AUDIT_CONTROLS: readonly string[];
  UNAUDITED_SOURCE_SHA: string;
  assessPackageAuditForInstall: (entry: unknown, record: unknown, mode?: string) => {
    mode: string; allowed: boolean; verified: boolean; sourceSha: string | null;
    reasons: string[]; structuralProblems: string[];
  };
  loadPackageAuditAssessment: (root: string, app: string, mode?: string) => {
    allowed: boolean; verified: boolean; sourceSha: string | null; reasons: string[];
  };
  packageAuditRecordProblems: (record: unknown) => string[];
  resolvePackageAuditMode: (value?: string) => string;
};

const roots: string[] = [];
const SOURCE_SHA = '1234567890abcdef1234567890abcdef12345678';

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixtureRoot(prefix = 'oshal-core-audit-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function controls(status = 'passed'): Record<string, string> {
  return Object.fromEntries(audit.PACKAGE_AUDIT_CONTROLS.map((name) => [name, status]));
}

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    profileVersion: 1,
    app: 'sample-app',
    version: '1.2.3',
    sourceSha: SOURCE_SHA,
    status: 'passed',
    auditedAt: '2026-08-06T05:00:00.000Z',
    controls: controls(),
    evidence: [{ name: 'security-tests.tap', sha256: 'a'.repeat(64) }],
    ...overrides,
  };
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'sample-app',
    version: '1.2.3',
    source: { type: 'git-subdir', url: 'https://example.test/store', path: 'sample-app', ref: 'main' },
    audit: { record: 'audits/sample-app.json', sourceSha: SOURCE_SHA },
    ...overrides,
  };
}

function writeStore(root: string, catalogEntry = entry(), auditRecord = record()): void {
  mkdirSync(join(root, 'audits'), { recursive: true });
  writeFileSync(join(root, 'marketplace.json'), `${JSON.stringify({ version: 1, apps: [catalogEntry] }, null, 2)}\n`);
  writeFileSync(join(root, 'audits', 'sample-app.json'), `${JSON.stringify(auditRecord, null, 2)}\n`);
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function commit(root: string, message: string): string {
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=oshal tests', '-c', 'user.email=maintainer@emeraldcoastsystemsgroup.com', 'commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

describe('core APP-02 audit contract', () => {
  it('defaults compatible and rejects an unknown mode instead of weakening policy', () => {
    expect(audit.resolvePackageAuditMode('')).toBe('compatible');
    expect(audit.resolvePackageAuditMode('ENFORCE')).toBe('enforce');
    expect(() => audit.resolvePackageAuditMode('observe')).toThrow(/compatible or enforce/);
  });

  it('requires all six controls and nonempty hashed evidence for a passed record', () => {
    expect(audit.packageAuditRecordProblems(record())).toEqual([]);
    expect(audit.packageAuditRecordProblems(record({ evidence: [] })).join('\n')).toMatch(/at least one/);
    expect(audit.packageAuditRecordProblems(record({ evidence: [{ name: 'x', sha256: 'NOT-A-DIGEST' }] })).join('\n')).toMatch(/SHA-256/);
    expect(audit.packageAuditRecordProblems(record({ controls: { ...controls(), authz: 'pending' } })).join('\n')).toMatch(/authz=passed/);
  });

  it('warns only for a structurally valid rollout record and grants no false SHA pin', () => {
    const pending = record({
      sourceSha: audit.UNAUDITED_SOURCE_SHA,
      status: 'pending',
      auditedAt: null,
      controls: controls('pending'),
      evidence: [],
    });
    const pendingEntry = entry({ audit: { record: 'audits/sample-app.json', sourceSha: audit.UNAUDITED_SOURCE_SHA } });
    expect(audit.assessPackageAuditForInstall(pendingEntry, pending, 'compatible')).toMatchObject({
      allowed: true, verified: false, sourceSha: null, structuralProblems: [],
    });
    expect(audit.assessPackageAuditForInstall(pendingEntry, pending, 'enforce')).toMatchObject({
      allowed: false, verified: false, sourceSha: null,
    });
  });

  it('blocks malformed or mismatched bindings in compatible mode too', () => {
    const missing = audit.assessPackageAuditForInstall({ ...entry(), audit: undefined }, record(), 'compatible');
    expect(missing.allowed).toBe(false);
    expect(missing.structuralProblems.join('\n')).toMatch(/catalog audit/);
    const mismatch = audit.assessPackageAuditForInstall(
      entry({ audit: { record: 'audits/sample-app.json', sourceSha: 'b'.repeat(40) } }),
      record(),
      'compatible',
    );
    expect(mismatch.allowed).toBe(false);
    expect(mismatch.reasons.join('\n')).toMatch(/does not match/);
  });

  it('reads only the canonical confined record and rejects path substitution', () => {
    const root = fixtureRoot();
    writeStore(root);
    expect(audit.loadPackageAuditAssessment(root, 'sample-app', 'enforce')).toMatchObject({
      allowed: true, verified: true, sourceSha: SOURCE_SHA,
    });
    writeStore(root, entry({ audit: { record: '../outside.json', sourceSha: SOURCE_SHA } }));
    expect(() => audit.loadPackageAuditAssessment(root, 'sample-app', 'compatible')).toThrow(/must equal audits\/sample-app\.json/);
  });
});

describe('oshal-app exact-SHA install boundary', () => {
  it('installs the audited commit rather than the newer catalog commit in enforce mode', () => {
    const store = fixtureRoot('oshal-audit-git-store-');
    const destination = fixtureRoot('oshal-audit-install-');
    git(store, ['init', '-b', 'main']);
    mkdirSync(join(store, 'sample-app'), { recursive: true });
    writeFileSync(join(store, 'sample-app', 'oshal-app.yaml'), [
      'name: sample-app',
      'displayName: Sample App',
      'suite: ai-engineering',
      'version: 1.2.3',
      'dependencies:',
      '  apps: []',
      '',
    ].join('\n'));
    const auditedSha = commit(store, 'audited package source');
    writeStore(store, entry({
      source: { type: 'git-subdir', url: pathToFileURL(store).href, path: 'sample-app', ref: 'main' },
      audit: { record: 'audits/sample-app.json', sourceSha: auditedSha },
    }), record({ sourceSha: auditedSha }));
    const catalogSha = commit(store, 'publish audit record');

    execFileSync(process.execPath, [
      resolve('scripts/oshal-app.js'), 'install', 'sample-app',
      '--repo', pathToFileURL(store).href,
      '--ref', 'main',
      '--dest', destination,
      '--audit-mode', 'enforce',
    ], { cwd: resolve('.'), encoding: 'utf8' });

    const provenance = JSON.parse(readFileSync(join(destination, 'sample-app', '.oshal-install.json'), 'utf8'));
    expect(provenance.sha).toBe(auditedSha);
    expect(provenance.sha).not.toBe(catalogSha);
    expect(provenance.audit).toMatchObject({
      mode: 'enforce', verified: true, status: 'passed', sourceSha: auditedSha,
    });
  }, 20_000);
});
