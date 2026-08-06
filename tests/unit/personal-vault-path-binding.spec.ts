/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the SQLite vault's runtime re-binding of every layout to its exact owner, including cached-handle reuse and linked main-file refusal before open.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveVault } from '../../src/features/personal-data/vault';
import { SqliteVaultStore } from '../../src/features/personal-data/sqlite-vault-store';
import { ensureExactSubjectStoreDirectory } from '../../src/shared/security/exact-subject-store';

const fixtures: string[] = [];
const originalSecret = process.env.SESSION_SECRET;

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-vault-binding-'));
  fixtures.push(root);
  return root;
}

afterEach(() => {
  if (originalSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = originalSecret;
  for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('personal vault exact path binding', () => {
  it('never reuses an owner A cached handle for owner B with a borrowed layout', () => {
    process.env.SESSION_SECRET = 'personal-vault-test-secret';
    const root = fixtureRoot();
    const layout = resolveVault(root, 'default', 'Owner-A');
    const store = new SqliteVaultStore();
    expect(store.getEntities(layout, 'Owner-A')).toEqual([]);
    expect(() => store.getEntities(layout, 'owner-a')).toThrow(/layout changed/);
    store.close();
  });

  it('rejects a hard-linked vault database before SQLite can open it', () => {
    process.env.SESSION_SECRET = 'personal-vault-test-secret';
    const root = fixtureRoot();
    const outside = fixtureRoot();
    const subject = ensureExactSubjectStoreDirectory(root, 'default', 'vault-owner');
    const vaultDir = path.join(subject.subjectDir, 'vault');
    fs.mkdirSync(vaultDir, { mode: 0o700 });
    const outsideDb = path.join(outside, 'outside.db');
    fs.writeFileSync(outsideDb, 'outside');
    fs.linkSync(outsideDb, path.join(vaultDir, 'vault.db'));
    const store = new SqliteVaultStore();
    expect(() => store.getEntities(resolveVault(root, 'default', 'vault-owner'), 'vault-owner'))
      .toThrow(/linked or nonregular/);
    store.close();
  });
});
