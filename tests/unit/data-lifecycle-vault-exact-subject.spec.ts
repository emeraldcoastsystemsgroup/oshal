/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard Personal Data Vault export/delete for digest-bound slash, traversal-like, case, and whitespace subjects, plus fail-closed main/sidecar/manifest link and nonregular-file mutations.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildVaultExporter } from '../../src/features/data-lifecycle';
import {
  resolveVault,
  SqliteVaultStore,
  type VaultLayout,
} from '../../src/features/personal-data';
import { ensureExactSubjectStoreDirectory } from '../../src/shared/security/exact-subject-store';

const roots: string[] = [];
const ENV_KEYS = ['ENABLE_PERSONAL_INTELLIGENCE', 'PI_STORE_ROOT', 'PI_TENANT', 'SESSION_SECRET'] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-vault-export-'));
  roots.push(root);
  return root;
}

function configuredRoot(): string {
  const root = fixtureRoot();
  process.env.ENABLE_PERSONAL_INTELLIGENCE = 'true';
  process.env.PI_STORE_ROOT = root;
  process.env.PI_TENANT = 'default';
  process.env.SESSION_SECRET = 'vault-export-exact-test-secret';
  return root;
}

async function seedVault(root: string, userSub: string, label: string): Promise<VaultLayout> {
  const layout = resolveVault(root, 'default', userSub);
  const store = new SqliteVaultStore();
  try {
    await store.upsertEntity(layout, userSub, {
      type: 'person', match: { exact: label }, label, attrs: { label }, worldRef: null, confidence: 1,
    }, { source: 'vault-export-spec', ingestedAt: '2026-08-05T12:00:00.000Z', confidence: 1 });
  } finally {
    store.close();
  }
  return resolveVault(root, 'default', userSub);
}

function entityLabels(rows: unknown[]): string[] {
  return rows
    .filter((row): row is { kind: string; label: string } => (
      typeof row === 'object' && row !== null && (row as { kind?: unknown }).kind === 'entity'
    ))
    .map((row) => row.label);
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Personal Data Vault exact-subject lifecycle', () => {
  it('exports only the bound slash/traversal/whitespace identity', async () => {
    const root = configuredRoot();
    const exact = ' ../Issuer/Owner ';
    const nearAlias = '../Issuer/Owner';
    await seedVault(root, exact, 'exact-owner-row');
    await seedVault(root, nearAlias, 'near-alias-row');
    const exporter = buildVaultExporter();
    expect(entityLabels(await exporter.exportRows(exact))).toEqual(['exact-owner-row']);
    expect(entityLabels(await exporter.exportRows(nearAlias))).toEqual(['near-alias-row']);
  });

  it('deletes only exact-owner rows and its ordinary manifest', async () => {
    const root = configuredRoot();
    const exact = ' ../../Delete/Owner ';
    const nearAlias = '../../Delete/Owner';
    const layout = await seedVault(root, exact, 'delete-me');
    await seedVault(root, nearAlias, 'retain-me');
    fs.writeFileSync(layout.manifestPath, '{}', { encoding: 'utf8', mode: 0o600 });
    const exporter = buildVaultExporter();
    await expect(exporter.deleteRows!(exact)).resolves.toBeGreaterThan(0);
    expect(entityLabels(await exporter.exportRows(exact))).toEqual([]);
    expect(entityLabels(await exporter.exportRows(nearAlias))).toEqual(['retain-me']);
    expect(fs.existsSync(layout.manifestPath)).toBe(false);
  });

  it('rejects empty and control-bearing subjects instead of widening or normalizing', async () => {
    configuredRoot();
    const exporter = buildVaultExporter();
    await expect(exporter.exportRows('')).rejects.toThrow(/exact UTF-8/);
    await expect(exporter.deleteRows!('owner\nother')).rejects.toThrow(/exact UTF-8/);
  });
});

describe('Personal Data Vault lifecycle path mutation guards', () => {
  it('rejects hard-linked and nonregular main database entries', async () => {
    const root = configuredRoot();
    const outside = fixtureRoot();
    const linked = ensureExactSubjectStoreDirectory(root, 'default', 'linked-main-owner');
    const linkedVault = path.join(linked.subjectDir, 'vault');
    fs.mkdirSync(linkedVault, { mode: 0o700 });
    const outsideDb = path.join(outside, 'outside.db');
    fs.writeFileSync(outsideDb, 'outside');
    fs.linkSync(outsideDb, path.join(linkedVault, 'vault.db'));
    const exporter = buildVaultExporter();
    await expect(exporter.exportRows('linked-main-owner')).rejects.toThrow(/linked or nonregular/);

    const nonregular = ensureExactSubjectStoreDirectory(root, 'default', 'directory-main-owner');
    const nonregularVault = path.join(nonregular.subjectDir, 'vault');
    fs.mkdirSync(path.join(nonregularVault, 'vault.db'), { recursive: true, mode: 0o700 });
    await expect(exporter.deleteRows!('directory-main-owner')).rejects.toThrow(/linked or nonregular/);
  });

  it('rejects a linked SQLite sidecar before deleting any exact-owner row', async () => {
    const root = configuredRoot();
    const outside = fixtureRoot();
    const subject = 'sidecar/owner';
    const layout = await seedVault(root, subject, 'must-survive');
    const outsideWal = path.join(outside, 'outside-wal');
    fs.writeFileSync(outsideWal, 'outside');
    fs.linkSync(outsideWal, path.join(layout.vaultDir, 'vault.db-wal'));
    const exporter = buildVaultExporter();
    await expect(exporter.deleteRows!(subject)).rejects.toThrow(/linked or nonregular/);
    fs.rmSync(path.join(layout.vaultDir, 'vault.db-wal'));
    expect(entityLabels(await exporter.exportRows(subject))).toEqual(['must-survive']);
  });

  it('rejects a hard-linked manifest before deleting any exact-owner row', async () => {
    const root = configuredRoot();
    const outside = fixtureRoot();
    const subject = 'manifest/owner';
    const layout = await seedVault(root, subject, 'manifest-survivor');
    const outsideManifest = path.join(outside, 'outside-manifest');
    fs.writeFileSync(outsideManifest, '{}');
    fs.linkSync(outsideManifest, layout.manifestPath);
    const exporter = buildVaultExporter();
    await expect(exporter.deleteRows!(subject)).rejects.toThrow(/linked or nonregular/);
    fs.rmSync(layout.manifestPath);
    expect(entityLabels(await exporter.exportRows(subject))).toEqual(['manifest-survivor']);
  });
});
