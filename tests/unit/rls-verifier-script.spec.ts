import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('RLS governance scripts', () => {
  it('prints verifier usage without connecting to Postgres', () => {
    const root = process.cwd();
    const output = execFileSync(
      process.execPath,
      [path.join(root, 'scripts/governance/verify-rls-isolation.mjs'), '--help'],
      { cwd: root, encoding: 'utf8' },
    );

    expect(output).toContain('verify-rls-isolation');
    expect(output).toContain('OSHAL_RLS_VERIFY_STAGE=permissive|enforce');
    expect(output).toContain('OSHAL_RLS_VERIFY_ALLOW_BYPASS=1');
  });

  it('prints role-provisioner usage without connecting to Postgres', () => {
    const root = process.cwd();
    const output = execFileSync(
      process.execPath,
      [path.join(root, 'scripts/governance/provision-rls-app-role.mjs'), '--help'],
      { cwd: root, encoding: 'utf8' },
    );

    expect(output).toContain('provision-rls-app-role');
    expect(output).toContain('OSHAL_DB_ROLE_APPLY=apply');
    expect(output).toContain('NOBYPASSRLS');
  });
});
