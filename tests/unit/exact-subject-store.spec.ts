/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard exact-subject digest isolation, owner-marker binding, conservative legacy compatibility, alias refusal, link-free vault leaves, and SQLite main/sidecar containment against path and metadata mutation.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertLinkFreeSqliteDatabase,
  ensureExactSubjectStoreDirectory,
  exactSubjectDirectoryKey,
  listExactSubjectStoreDirectories,
  resolveExactSubjectStoreDirectory,
} from '../../src/shared/security/exact-subject-store';
import { resolveVault } from '../../src/features/personal-data/vault';

const fixtures: string[] = [];

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-exact-store-'));
  fixtures.push(root);
  return root;
}

function tenantRoot(root: string): string {
  return path.join(root, 'default');
}

function markerPath(subjectDir: string): string {
  return path.join(subjectDir, '.oshal-user-sub');
}

afterEach(() => {
  for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('exact-subject filesystem isolation', () => {
  it('maps traversal, separator, case, and whitespace variants to distinct contained keys', () => {
    const root = fixtureRoot();
    const subjects = ['issuer/user', 'issuer\\user', '../owner', ' Owner ', 'owner', 'Owner'];
    const stores = subjects.map((subject) => ensureExactSubjectStoreDirectory(root, 'default', subject));
    expect(new Set(stores.map((store) => store.subjectDir)).size).toBe(subjects.length);
    for (const [index, store] of stores.entries()) {
      expect(path.dirname(store.subjectDir)).toBe(tenantRoot(root));
      expect(path.basename(store.subjectDir)).toBe(exactSubjectDirectoryKey(subjects[index]));
      expect(fs.readFileSync(markerPath(store.subjectDir), 'utf8')).toBe(subjects[index]);
    }
  });

  it('retains one exact legacy directory but never accepts its case alias', () => {
    const root = fixtureRoot();
    const exact = 'Legacy.Owner';
    fs.mkdirSync(path.join(tenantRoot(root), exact), { recursive: true, mode: 0o750 });
    const legacy = resolveExactSubjectStoreDirectory(root, 'default', exact);
    const alias = resolveExactSubjectStoreDirectory(root, 'default', 'legacy.owner');
    expect(legacy).toMatchObject({ exists: true, kind: 'legacy' });
    expect(alias).toMatchObject({ exists: false, kind: 'canonical' });
    expect(alias.subjectDir).not.toBe(legacy.subjectDir);
  });

  it('fails closed when canonical and legacy aliases coexist or a marker is replaced', () => {
    const root = fixtureRoot();
    const subject = 'owner-a';
    const canonical = ensureExactSubjectStoreDirectory(root, 'default', subject);
    fs.mkdirSync(path.join(tenantRoot(root), subject), { mode: 0o750 });
    expect(() => resolveExactSubjectStoreDirectory(root, 'default', subject)).toThrow(/aliases coexist/);
    fs.rmSync(path.join(tenantRoot(root), subject), { recursive: true });
    fs.writeFileSync(markerPath(canonical.subjectDir), 'owner-b', 'utf8');
    expect(() => resolveExactSubjectStoreDirectory(root, 'default', subject)).toThrow(/binding mismatch/);
  });
});

describe('exact-subject store mutation guards', () => {
  it('enumerates canonical markers and exact legacy names without losing subject bytes', () => {
    const root = fixtureRoot();
    const canonicalSub = ' ../Exact/Owner ';
    const legacySub = 'legacy.owner';
    ensureExactSubjectStoreDirectory(root, 'default', canonicalSub);
    fs.mkdirSync(path.join(tenantRoot(root), legacySub), { mode: 0o750 });
    const listed = listExactSubjectStoreDirectories(root, 'default');
    expect(listed.map((entry) => entry.subject).sort()).toEqual([canonicalSub, legacySub].sort());
  });

  it('rejects a linked owner directory and a linked vault leaf', () => {
    const root = fixtureRoot();
    const outside = fixtureRoot();
    const linkedTenantRoot = fixtureRoot();
    fs.symlinkSync(outside, tenantRoot(linkedTenantRoot), 'junction');
    expect(() => resolveExactSubjectStoreDirectory(linkedTenantRoot, 'default', 'owner')).toThrow(/link/);

    fs.mkdirSync(tenantRoot(root), { recursive: true, mode: 0o750 });
    fs.symlinkSync(outside, path.join(tenantRoot(root), 'linked-owner'), 'junction');
    expect(() => resolveExactSubjectStoreDirectory(root, 'default', 'linked-owner')).toThrow(/linked/);

    const canonical = ensureExactSubjectStoreDirectory(root, 'default', 'vault-owner');
    fs.symlinkSync(outside, path.join(canonical.subjectDir, 'vault'), 'junction');
    expect(() => resolveVault(root, 'default', 'vault-owner')).toThrow(/link/);
  });

  it('rejects hard-linked SQLite main files and linked sidecar entries', () => {
    const root = fixtureRoot();
    const outside = fixtureRoot();
    const store = ensureExactSubjectStoreDirectory(root, 'default', 'sqlite-owner');
    const outsideDb = path.join(outside, 'outside.db');
    fs.writeFileSync(outsideDb, 'not sqlite');
    fs.linkSync(outsideDb, path.join(store.subjectDir, 'crm.db'));
    expect(() => assertLinkFreeSqliteDatabase(store.subjectDir, 'crm.db')).toThrow(/linked or nonregular/);

    fs.rmSync(path.join(store.subjectDir, 'crm.db'));
    fs.writeFileSync(path.join(store.subjectDir, 'crm.db'), 'ordinary');
    fs.symlinkSync(outside, path.join(store.subjectDir, 'crm.db-wal'), 'junction');
    expect(() => assertLinkFreeSqliteDatabase(store.subjectDir, 'crm.db')).toThrow(/linked or nonregular/);
  });

  it('rejects invalid tenant syntax, empty subjects, and oversized marker mutations', () => {
    const root = fixtureRoot();
    expect(() => ensureExactSubjectStoreDirectory(root, '../tenant', 'owner')).toThrow(/tenant/);
    expect(() => ensureExactSubjectStoreDirectory(root, 'default', '')).toThrow(/exact UTF-8/);
    const store = ensureExactSubjectStoreDirectory(root, 'default', 'bounded-owner');
    fs.writeFileSync(markerPath(store.subjectDir), 'x'.repeat(513), 'utf8');
    expect(() => resolveExactSubjectStoreDirectory(root, 'default', 'bounded-owner')).toThrow(/bounded/);
  });
});
