/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Mutation guards for backup-name detection and value-free environment schema export.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertLocalSecretHygiene, findLocalSecretBackups } from '../../scripts/security/check-local-secret-hygiene.mjs';
import { exportEnvSchema, redactedEnvSchema } from '../../scripts/security/export-env-schema.mjs';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'oshal-local-secret-hygiene-'));
  roots.push(root);
  return root;
}

describe('local secret hygiene', () => {
  it('finds ignored credential backup shapes without rejecting legitimate dotenv variants', () => {
    const root = fixtureRoot();
    for (const name of ['.env.bak-2026-07-30', '.env.backup', 'credentials.json.old.2', 'secrets.env.copy']) {
      writeFileSync(join(root, name), 'SECRET=do-not-print');
    }
    writeFileSync(join(root, '.env.local'), 'LOCAL=allowed');
    writeFileSync(join(root, '.env.example'), 'EXAMPLE=');
    expect(findLocalSecretBackups(root)).toEqual([
      '.env.backup', '.env.bak-2026-07-30', 'credentials.json.old.2', 'secrets.env.copy',
    ]);
    expect(() => assertLocalSecretHygiene(root)).toThrow(/Plaintext credential backup/);
  });

  it('emits only stable key names and never values, comments, or duplicates', () => {
    const output = redactedEnvSchema([
      '# provider secret is sensitive',
      'BETA="second-value"',
      'export ALPHA=first-value',
      'ALPHA=repeated-value',
      'not an assignment',
    ].join('\n'));
    expect(output).toContain('ALPHA=\nBETA=');
    expect(output.match(/ALPHA=/g)).toHaveLength(1);
    for (const forbidden of ['second-value', 'first-value', 'repeated-value', 'provider secret']) {
      expect(output).not.toContain(forbidden);
    }
  });

  it('creates a new schema file and refuses source overwrite or output clobbering', () => {
    const root = fixtureRoot();
    const input = join(root, '.env');
    const output = join(root, 'environment-keys.example');
    writeFileSync(input, 'TOKEN=live-value\n');
    expect(exportEnvSchema(input, output)).toBe(output);
    expect(readFileSync(output, 'utf8')).toContain('TOKEN=\n');
    expect(readFileSync(output, 'utf8')).not.toContain('live-value');
    expect(() => exportEnvSchema(input, output)).toThrow();
    expect(() => exportEnvSchema(input, input)).toThrow(/overwrite the source/);
  });
});
