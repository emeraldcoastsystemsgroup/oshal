/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | APP-02: mutation guards for the core audit profile, safe record loading, staged policy, and a real Git exact-SHA install boundary.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Backlog #33: the evidence contract and the stale-source refusal, over real Git stores and the real installer CLI. A passed record now carries the seven canonical evidence documents; the installer re-hashes them from its sparse checkout, refuses a changed byte in every mode, refuses a source change or a version bump made without a re-audit in enforce mode (compatible installs the catalog ref unpinned with a warning), and refuses in enforce mode an attestation whose audited commit the store cannot serve (the shape of a single-commit public snapshot).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type AuditAssessment = {
  mode: string; allowed: boolean; verified: boolean; sourceSha: string | null;
  reasons: string[]; structuralProblems: string[]; evidenceTrees: string[];
};

const audit = require('../../scripts/oshal-package-audit') as {
  PACKAGE_AUDIT_CONTROLS: readonly string[];
  PACKAGE_AUDIT_EVIDENCE_NAMES: readonly string[];
  UNAUDITED_SOURCE_SHA: string;
  assessPackageAuditForInstall: (entry: unknown, record: unknown, mode?: string) => AuditAssessment;
  auditEvidenceDigest: (text: string) => string;
  auditEvidenceDirectory: (app: string, sourceSha: string) => string;
  canonicalAuditJson: (value: unknown) => string;
  loadPackageAuditAssessment: (root: string, app: string, mode?: string) => AuditAssessment;
  packageAuditRecordProblems: (record: unknown) => string[];
  resolvePackageAuditMode: (value?: string) => string;
  sourceCurrencyProblems: (input: Record<string, unknown>) => string[];
};

const roots: string[] = [];
const SOURCE_SHA = '1234567890abcdef1234567890abcdef12345678';
const TREE = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';

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
    evidence: audit.PACKAGE_AUDIT_EVIDENCE_NAMES.map((name) => ({ name, sha256: 'a'.repeat(64) })),
    ...overrides,
  };
}

function pending(): Record<string, unknown> {
  return record({ status: 'pending', sourceSha: audit.UNAUDITED_SOURCE_SHA, auditedAt: null, controls: controls('pending'), evidence: [] });
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

/** Write the seven canonical evidence documents and return the record items that bind them. */
function writeEvidence(root: string, sourceSha: string, packageTree: string, version = '1.2.3', failing: string[] = []) {
  const directory = join(root, ...audit.auditEvidenceDirectory('sample-app', sourceSha).split('/'));
  mkdirSync(directory, { recursive: true });
  return audit.PACKAGE_AUDIT_EVIDENCE_NAMES.map((name) => {
    const result = failing.includes(name) ? 'failed' : 'passed';
    const text = audit.canonicalAuditJson({
      profileVersion: 1, app: 'sample-app', version, sourceSha, sourcePath: 'sample-app', packageTree,
      control: name, result, checks: [{ name: `${name}-check`, result }],
    });
    writeFileSync(join(directory, `${name}.json`), text);
    return { name, sha256: audit.auditEvidenceDigest(text) };
  });
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function commit(root: string, message: string): string {
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=oshal tests', '-c', 'user.email=maintainer@emeraldcoastsystemsgroup.com', 'commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

function manifest(version = '1.2.3'): string {
  return ['name: sample-app', 'displayName: Sample App', 'suite: ai-engineering', `version: ${version}`, 'dependencies:', '  apps: []', ''].join('\n');
}

/** A real Git store: the package commit is audited, then its attestation is published after it. */
function auditedGitStore() {
  const store = fixtureRoot('oshal-audit-git-store-');
  git(store, ['init', '-b', 'main']);
  mkdirSync(join(store, 'sample-app'), { recursive: true });
  writeFileSync(join(store, 'sample-app', 'oshal-app.yaml'), manifest());
  const auditedSha = commit(store, 'audited package source');
  const packageTree = git(store, ['rev-parse', `${auditedSha}:sample-app`]);
  const evidence = writeEvidence(store, auditedSha, packageTree);
  const auditRecord = record({ sourceSha: auditedSha, evidence });
  const catalogEntry = entry({
    source: { type: 'git-subdir', url: pathToFileURL(store).href, path: 'sample-app', ref: 'main' },
    audit: { record: 'audits/sample-app.json', sourceSha: auditedSha },
  });
  writeStore(store, catalogEntry, auditRecord);
  const catalogSha = commit(store, 'publish audit record');
  return { store, auditedSha, catalogSha, packageTree, auditRecord, catalogEntry };
}

function install(store: string, mode: 'compatible' | 'enforce') {
  const destination = fixtureRoot('oshal-audit-install-');
  const run = spawnSync(process.execPath, [
    resolve('scripts/oshal-app.js'), 'install', 'sample-app',
    '--repo', pathToFileURL(store).href, '--ref', 'main', '--dest', destination, '--audit-mode', mode,
  ], { cwd: resolve('.'), encoding: 'utf8' });
  const provenancePath = join(destination, 'sample-app', '.oshal-install.json');
  const provenance = run.status === 0 ? JSON.parse(readFileSync(provenancePath, 'utf8')) : null;
  return { status: run.status, output: `${run.stdout}\n${run.stderr}`, provenance };
}

describe('core APP-02 audit contract', () => {
  it('defaults compatible and rejects an unknown mode instead of weakening policy', () => {
    expect(audit.resolvePackageAuditMode('')).toBe('compatible');
    expect(audit.resolvePackageAuditMode('ENFORCE')).toBe('enforce');
    expect(() => audit.resolvePackageAuditMode('observe')).toThrow(/compatible or enforce/);
  });

  it('requires all six controls and the seven hashed evidence documents for a passed record', () => {
    expect(audit.packageAuditRecordProblems(record())).toEqual([]);
    expect(audit.packageAuditRecordProblems(record({ evidence: [] })).join('\n')).toMatch(/evidence is missing manifest/);
    const noGolden = (record().evidence as Array<{ name: string }>).filter((item) => item.name !== 'goldenPath');
    expect(audit.packageAuditRecordProblems(record({ evidence: noGolden })).join('\n')).toMatch(/evidence is missing goldenPath/);
    expect(audit.packageAuditRecordProblems(record({ evidence: [...(record().evidence as object[]), { name: 'x.tap', sha256: 'b'.repeat(64) }] })).join('\n')).toMatch(/unsupported item\(s\) x\.tap/);
    expect(audit.packageAuditRecordProblems(record({ evidence: [{ name: 'x', sha256: 'NOT-A-DIGEST' }] })).join('\n')).toMatch(/SHA-256/);
    expect(audit.packageAuditRecordProblems(record({ controls: { ...controls(), authz: 'pending' } })).join('\n')).toMatch(/authz=passed/);
    expect(audit.packageAuditRecordProblems({ ...pending(), evidence: record().evidence }).join('\n')).toMatch(/pending audit evidence must be empty/);
  });

  it('warns only for a structurally valid rollout record and grants no false SHA pin', () => {
    const pendingEntry = entry({ audit: { record: 'audits/sample-app.json', sourceSha: audit.UNAUDITED_SOURCE_SHA } });
    expect(audit.assessPackageAuditForInstall(pendingEntry, pending(), 'compatible')).toMatchObject({
      allowed: true, verified: false, sourceSha: null, structuralProblems: [],
    });
    expect(audit.assessPackageAuditForInstall(pendingEntry, pending(), 'enforce')).toMatchObject({
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

  it('reads only the canonical confined record and re-hashes its evidence from disk', () => {
    const root = fixtureRoot();
    writeStore(root, entry(), record({ evidence: writeEvidence(root, SOURCE_SHA, TREE) }));
    expect(audit.loadPackageAuditAssessment(root, 'sample-app', 'enforce')).toMatchObject({
      allowed: true, verified: true, sourceSha: SOURCE_SHA, evidenceTrees: [TREE],
    });
    const golden = join(root, ...audit.auditEvidenceDirectory('sample-app', SOURCE_SHA).split('/'), 'goldenPath.json');
    writeFileSync(golden, readFileSync(golden, 'utf8').replace('goldenPath-check', 'goldenPath-chock'));
    const tampered = audit.loadPackageAuditAssessment(root, 'sample-app', 'compatible');
    expect(tampered).toMatchObject({ allowed: false, verified: false, sourceSha: null });
    expect(tampered.structuralProblems.join('\n')).toMatch(/evidence goldenPath bytes do not match the recorded sha256; re-audit required/);
    writeStore(root, entry({ audit: { record: '../outside.json', sourceSha: SOURCE_SHA } }));
    expect(() => audit.loadPackageAuditAssessment(root, 'sample-app', 'compatible')).toThrow(/must equal audits\/sample-app\.json/);
  });

  it('refuses a missing evidence directory, a missing document and evidence that contradicts the record', () => {
    const root = fixtureRoot();
    writeStore(root, entry(), record());
    expect(audit.loadPackageAuditAssessment(root, 'sample-app', 'compatible').structuralProblems.join('\n'))
      .toMatch(/evidence directory audits\/evidence\/sample-app\/[0-9a-f]{40} is unavailable: missing/);
    const evidence = writeEvidence(root, SOURCE_SHA, TREE, '1.2.3', ['rls']);
    writeStore(root, entry(), record({ evidence }));
    expect(audit.loadPackageAuditAssessment(root, 'sample-app', 'compatible').structuralProblems.join('\n'))
      .toMatch(/controls\.rls=passed disagrees with evidence rls \(failed\)/);
    const fresh = writeEvidence(root, SOURCE_SHA, TREE);
    rmSync(join(root, ...audit.auditEvidenceDirectory('sample-app', SOURCE_SHA).split('/'), 'surface.json'));
    writeStore(root, entry(), record({ evidence: fresh }));
    expect(audit.loadPackageAuditAssessment(root, 'sample-app', 'compatible').structuralProblems.join('\n'))
      .toMatch(/evidence surface: audits\/evidence\/sample-app\/[0-9a-f]{40}\/surface\.json is missing/);
  });

  it('judges source currency from the catalog tree, the audited tree and the evidence tree', () => {
    const base = { sourceSha: SOURCE_SHA, sourcePath: 'sample-app', catalogTree: TREE, auditedTree: TREE, evidenceTrees: [TREE] };
    expect(audit.sourceCurrencyProblems(base)).toEqual([]);
    expect(audit.sourceCurrencyProblems({ ...base, catalogTree: 'f'.repeat(40) }).join('\n')).toMatch(/changed since the audit .*re-audit required/);
    expect(audit.sourceCurrencyProblems({ ...base, evidenceTrees: ['f'.repeat(40)] }).join('\n')).toMatch(/evidence does not describe the audited source tree/);
    expect(audit.sourceCurrencyProblems({ ...base, auditedTree: null, fetchError: 'not our ref' }).join('\n')).toMatch(/cannot be read from this store: not our ref/);
  });
});

describe('oshal-app exact-SHA install boundary', () => {
  it.each(['sample-app', 'source-folder'])('installs %s through its catalog identity when the source folder differs', (requestedName) => {
    const store = fixtureRoot('oshal-folder-store-'), destination = fixtureRoot('oshal-folder-install-');
    git(store, ['init', '-b', 'main']);
    mkdirSync(join(store, 'source-folder'));
    writeFileSync(join(store, 'source-folder', 'oshal-app.yaml'), 'name: sample-app\ndisplayName: Sample App\nsuite: ai-engineering\nversion: 1.2.3\n');
    writeStore(store, entry({ source: { type: 'git-subdir', path: 'source-folder', url: pathToFileURL(store).href, ref: 'main' }, audit: { record: 'audits/sample-app.json', sourceSha: audit.UNAUDITED_SOURCE_SHA } }), pending());
    const sha = commit(store, 'package with a distinct source folder');
    execFileSync(process.execPath, [resolve('scripts/oshal-app.js'), 'install', requestedName, '--repo', pathToFileURL(store).href, '--dest', destination], { cwd: resolve('.'), encoding: 'utf8' });
    const provenance = JSON.parse(readFileSync(join(destination, requestedName, '.oshal-install.json'), 'utf8'));
    expect(provenance.sha).toBe(sha);
    expect(provenance.audit.record).toBe('audits/sample-app.json');
    expect(readFileSync(join(destination, requestedName, 'oshal-app.yaml'), 'utf8')).toContain('name: sample-app');
  }, 20_000);

  it('rejects ambiguous identities and source paths that escape the package tree', () => {
    const { resolveStorePackage } = require('../../scripts/oshal-app');
    const root = fixtureRoot();
    for (const sourcePath of ['../escape', '/absolute', 'C:/drive', 'a/../b', 'a\\b', '*', '']) {
      writeStore(root, entry({ source: { type: 'git-subdir', path: sourcePath } }));
      expect(() => resolveStorePackage(root, 'sample-app')).toThrow(/confined/);
    }
    writeFileSync(join(root, 'marketplace.json'), JSON.stringify({ apps: [entry(), entry()] }));
    expect(() => resolveStorePackage(root, 'sample-app')).toThrow(/exactly one/);
    writeStore(root, entry());
    expect(resolveStorePackage(root, 'sample-app').evidenceDir).toBe(`audits/evidence/sample-app/${SOURCE_SHA}/`);
    writeStore(root, entry({ audit: { record: 'audits/sample-app.json', sourceSha: audit.UNAUDITED_SOURCE_SHA } }));
    expect(resolveStorePackage(root, 'sample-app').evidenceDir).toBeNull();
  });

  it('installs the audited commit rather than the newer catalog commit in enforce mode', () => {
    const { store, auditedSha, catalogSha } = auditedGitStore();
    const run = install(store, 'enforce');
    expect(run.status, run.output).toBe(0);
    expect(run.provenance.sha).toBe(auditedSha);
    expect(run.provenance.sha).not.toBe(catalogSha);
    expect(run.provenance.audit).toMatchObject({
      mode: 'enforce', verified: true, status: 'passed', sourceSha: auditedSha,
    });
  }, 30_000);

  it('refuses a source change made after the audit in enforce mode and installs it unpinned in compatible mode', () => {
    const { store, auditedSha } = auditedGitStore();
    writeFileSync(join(store, 'sample-app', 'README.md'), 'changed after the audit\n');
    const changedSha = commit(store, 'change the package without a re-audit');

    const enforced = install(store, 'enforce');
    expect(enforced.status).not.toBe(0);
    expect(enforced.output).toMatch(/package source sample-app changed since the audit .*re-audit required/);

    const compatible = install(store, 'compatible');
    expect(compatible.status, compatible.output).toBe(0);
    expect(compatible.output).toMatch(/NOT AUDIT-VERIFIED/);
    expect(compatible.provenance.sha).toBe(changedSha);
    expect(compatible.provenance.sha).not.toBe(auditedSha);
    expect(compatible.provenance.audit).toMatchObject({ mode: 'compatible', verified: false, sourceSha: null });
    expect(compatible.provenance.audit.reasons.join('\n')).toMatch(/changed since the audit/);
  }, 40_000);

  it('refuses an evidence byte changed after the audit in every mode', () => {
    const { store, auditedSha } = auditedGitStore();
    const golden = join(store, ...audit.auditEvidenceDirectory('sample-app', auditedSha).split('/'), 'goldenPath.json');
    writeFileSync(golden, readFileSync(golden, 'utf8').replace('goldenPath-check', 'goldenPath-chock'));
    commit(store, 'edit the evidence without re-auditing');
    for (const mode of ['enforce', 'compatible'] as const) {
      const run = install(store, mode);
      expect(run.status).not.toBe(0);
      expect(run.output).toMatch(/evidence goldenPath bytes do not match the recorded sha256; re-audit required/);
    }
  }, 40_000);

  it('refuses a version bump made without a re-audit, whether or not the record follows it', () => {
    const { store, auditRecord, catalogEntry } = auditedGitStore();
    writeFileSync(join(store, 'sample-app', 'oshal-app.yaml'), manifest('1.2.4'));
    writeStore(store, { ...catalogEntry, version: '1.2.4' }, auditRecord);
    commit(store, 'bump the catalog and manifest only');
    const bindingOnly = install(store, 'compatible');
    expect(bindingOnly.status).not.toBe(0);
    expect(bindingOnly.output).toMatch(/audit version does not match catalog version/);

    writeStore(store, { ...catalogEntry, version: '1.2.4' }, { ...auditRecord, version: '1.2.4' });
    commit(store, 'bump the record too, still without auditing 1.2.4');
    const relabelled = install(store, 'enforce');
    expect(relabelled.status).not.toBe(0);
    expect(relabelled.output).toMatch(/evidence manifest version does not match the audit record/);
  }, 40_000);

  it('refuses in enforce mode an attestation whose audited commit the store cannot serve', () => {
    const { store, auditRecord, catalogEntry, packageTree, auditedSha } = auditedGitStore();
    // A single-commit snapshot of the same tree (how the public store is cut): the record names a
    // trunk commit this repository does not contain.
    const snapshot = fixtureRoot('oshal-audit-snapshot-');
    git(snapshot, ['init', '-b', 'main']);
    mkdirSync(join(snapshot, 'sample-app'), { recursive: true });
    writeFileSync(join(snapshot, 'sample-app', 'oshal-app.yaml'), manifest());
    writeEvidence(snapshot, auditedSha, packageTree);
    writeStore(snapshot, { ...catalogEntry, source: { ...(catalogEntry.source as object), url: pathToFileURL(snapshot).href } }, auditRecord);
    const snapshotSha = commit(snapshot, 'snapshot');
    expect(git(snapshot, ['rev-parse', `${snapshotSha}:sample-app`])).toBe(packageTree);
    expect(store).not.toBe(snapshot);

    const enforced = install(snapshot, 'enforce');
    expect(enforced.status).not.toBe(0);
    expect(enforced.output).toMatch(/audited source [0-9a-f]{40} \(sample-app\) cannot be read from this store/);
    const compatible = install(snapshot, 'compatible');
    expect(compatible.status, compatible.output).toBe(0);
    expect(compatible.provenance).toMatchObject({ sha: snapshotSha, audit: { verified: false, sourceSha: null } });
  }, 40_000);
});
