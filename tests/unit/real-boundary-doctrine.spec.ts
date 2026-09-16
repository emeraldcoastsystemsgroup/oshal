/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the integration-boundary doctrine and its first audited companions: real ticket/RLS stores, real package alias resolution, and mutation-tested build artifacts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Pin the ci-local `secret-scan` scanner double in the audit. Its guard replaces `docker` on PATH, so the gitleaks image - the boundary that exits 0 on a tree it could not read - never runs, and the audit carried no row for it. This case reads the shipped gate and helper, so the registration goes red if the scanner tag or the calibrated wording version moves away from what the row records.
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

  it('registers the ci-local secret-scan scanner double and the real run it still owes', () => {
    const audit = read('docs/governance/real-boundary-regression-audit.md');
    const guard = read('tests/unit/ci-local-secret-scan.spec.ts');
    const gate = read('scripts/ci-local.sh');
    const helper = read('scripts/ci/ci-secret-scan.sh');

    // The double is real: the guard puts its own `docker` first on PATH, so the scanner image
    // never runs and no path in the export it scans is actually unreadable.
    expect(guard).toContain("join(fakeBin, 'docker')");
    expect(guard).toContain('command -v docker | grep -q');

    const row = audit
      .split('\n')
      .find((line) => line.includes('tests/unit/ci-local-secret-scan.spec.ts'));
    expect(row, 'the scanner double must be registered in the audit').toBeTruthy();
    expect(row, 'the real gitleaks run is not done; the row must not read as closed').toContain('Owed');

    // The row has to name what the gate actually runs and the version its wording list came
    // from, so bumping either without re-recording the companion turns this red.
    const tag = /zricethezav\/gitleaks:[\w.-]+/.exec(gate)?.[0];
    const calibrated = /v\d+\.\d+\.\d+/.exec(helper)?.[0];
    expect(tag, 'ci-local.sh must still name the scanner image').toBeTruthy();
    expect(calibrated, 'ci-secret-scan.sh must still name the version its wordings came from').toBeTruthy();
    expect(row, 'the audit row must name the scanner the gate runs').toContain(tag!);
    expect(row, 'the audit row must name the calibrated wording version').toContain(calibrated!);
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
