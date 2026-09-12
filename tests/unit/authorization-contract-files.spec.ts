/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add ADR-149 application permission contracts, policy persistence and isolated enforcement verification.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadApplicationAuthorization } from '../../src/shared/application-authorization';
const roots: string[] = [];
function fixture(): string { const root = mkdtempSync(join(tmpdir(), 'oshal-auth-contract-')); roots.push(root); return root; }
const catalog = JSON.stringify({ version: 1, resources: { records: { scopes: ['own'] } },
  permissions: { 'records.read': { resource: 'records', effect: 'read', minimumTier: 'viewer' } },
  roles: { reader: { tier: 'viewer', grants: [{ permission: 'records.read', scope: 'own' }] } },
  bindings: { tools: [{ id: 'read-records', allOf: ['records.read'] }] } });
afterEach(() => {
  for (const root of roots.splice(0)) {
    const owned = relative(resolve(tmpdir()), resolve(root));
    if (!owned.startsWith('oshal-auth-contract-') || owned.includes('..')) throw new Error('Fixture cleanup escaped owned temp directory');
    rmSync(root, { recursive: true, force: true });
  }
});
describe('authorization package catalog import', () => {
  it('loads a real package-local YAML catalog through the same CLI/runtime validator', () => {
    const root = fixture(); writeFileSync(join(root, 'authorization.yaml'), catalog);
    expect(loadApplicationAuthorization(root, { uses: ['application-authorization'], authorization: { version: 1, catalog: 'authorization.yaml' } })!.roles.reader.tier).toBe('viewer');
    expect(loadApplicationAuthorization(root, {})).toBeNull();
    expect(() => loadApplicationAuthorization(root, { authorization: { version: 1, catalog: 'authorization.yaml' } })).toThrow('uses:');
  });
  it('rejects escape paths, unsupported/unknown declarations and malformed catalogs without fallback', () => {
    const root = fixture(); writeFileSync(join(root, 'authorization.yaml'), 'version: 9');
    for (const declaration of [{ version: 1, catalog: '../outside.yaml' }, { version: 2, catalog: 'authorization.yaml' }, { version: 1, catalog: 'authorization.yaml', fallback: true }, { version: 1, catalog: 'authorization.yaml' }]) {
      expect(() => loadApplicationAuthorization(root, { uses: ['application-authorization'], authorization: declaration })).toThrow();
    }
  });
  it('rejects catalog paths through a directory symlink even when bytes are otherwise valid', () => {
    const root = fixture(); const pkg = join(root, 'package'); const outside = join(root, 'outside');
    mkdirSync(pkg); mkdirSync(outside); writeFileSync(join(outside, 'authorization.yaml'), catalog);
    symlinkSync(outside, join(pkg, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => loadApplicationAuthorization(pkg, { uses: ['application-authorization'], authorization: { version: 1, catalog: 'linked/authorization.yaml' } })).toThrow('symlinks');
  });
});
