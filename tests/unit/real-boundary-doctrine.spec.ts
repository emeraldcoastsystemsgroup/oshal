/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the integration-boundary doctrine and its first audited companions: real ticket/RLS stores, real package alias resolution, and mutation-tested build artifacts.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (file: string): string => readFileSync(file, 'utf8');

describe('real-boundary regression doctrine', () => {
  it('keeps the coding rule and the explicit audit linked', () => {
    const rules = read('CLAUDE.md');
    const audit = read('docs/governance/real-boundary-regression-audit.md');
    expect(rules).toContain('Integration-boundary corollary');
    expect(rules).toContain('real-boundary-regression-audit.md');
    expect(audit).toContain('Open SEC-05 blocker');
  });

  it('runs ticket ingress over the real Postgres store and enforcing role', () => {
    const requiredE2e = read('tests/e2e-green-suite.txt');
    for (const file of [
      'tests/alert-intake-rls-live.spec.ts',
      'tests/connector-webhook-rls-live.spec.ts',
    ]) {
      const source = read(file);
      expect(source, file).toContain('new Pool');
      expect(source, file).toContain('PostgresTicketStore');
      expect(source, file).toContain('NOBYPASSRLS');
      expect(source, file).not.toContain('vi.mock(');
      expect(requiredE2e).toContain(file);
    }
  });

  it('resolves an @/ import through the production hook from an external package', () => {
    const implementation = read('src/app/composition/manifest-route-mounter.ts');
    const regression = read('tests/unit/manifest-route-mounter.spec.ts');
    expect(implementation).toContain('registerPackageFrameworkAliases(frameworkRoot)');
    expect(implementation).toContain('tsconfigPaths.register');
    expect(regression).toContain('createRequire(packageModule)');
    expect(regression).toContain("require('@/shared/boundary-probe')");
    expect(regression).not.toContain("vi.mock('tsconfig-paths'");
  });

  it('mutation-tests exact package artifacts in addition to probing the image', () => {
    const guard = read('scripts/check-kernel-skills.ts');
    const regression = read('tests/unit/kernel-uses-declaration.spec.ts');
    expect(guard).toContain("['run', '--rm', '--entrypoint', 'sh', imageTag");
    expect(guard).toContain('dist/features/drone/index.js');
    expect(guard).toContain('dist/app/routes/cli-token-routes.js');
    expect(regression).toContain('rmSync(join(build, PACKAGE_PIN_ARTIFACTS[0]))');
    expect(regression).toContain('rmSync(join(build, PACKAGE_PIN_ARTIFACTS[1]))');
  });
});
