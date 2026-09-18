/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the integration-boundary doctrine and its first audited companions: real ticket/RLS stores, real package alias resolution, and mutation-tested build artifacts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Pin the ci-local `secret-scan` scanner double in the audit. Its guard replaces `docker` on PATH, so the gitleaks image - the boundary that exits 0 on a tree it could not read - never runs, and the audit carried no row for it. This case reads the shipped gate and helper, so the registration goes red if the scanner tag or the calibrated wording version moves away from what the row records.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The SEC-05 durable-memory proof was a file on disk: written, never listed in a required suite, and recorded in the audit as an open blocker. This case requires it to be in the e2e green set, to still be a real-Pool/NOBYPASSRLS proof rather than a double, and to be named by an audit row that no longer reads as open; it also pins both halves of the ledger-broker contract the recorded mutations exercised, so loosening either without re-recording the result turns the gate red.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | The green-set registration checks were substring matches on the RAW suite text, so a spec commented out with a leading `#` still satisfied them while scripts/e2e-green.mjs drops every such line and never runs it (reviewer's proof on PR #620: commenting out the SEC-05 line left 6 of 6 green). Membership is now asserted against the list parsed exactly as the runner parses it - trimmed, blank and `#` lines dropped - and the runner's filter is pinned so the mirror cannot drift from it silently.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | The mirror is gone: the guard imports the same parser the runner uses (scripts/e2e-green-list.mjs) and, instead of grepping the runner for three strings, asks it (`--list`) what it would hand to playwright and requires that to equal the parsed list. The source-text pin from seq 4 was satisfied by three semantically different runners (an extra filter, a different file, the expressions kept only in a comment) - PR #620 second review.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { readGreenSuite } from '../../scripts/e2e-green-list.mjs';

const read = (file: string): string => readFileSync(file, 'utf8');

/**
 * @description The spec files scripts/e2e-green.mjs will actually hand to Playwright: the
 * same split/trim/drop-comments filter the runner applies to tests/e2e-green-suite.txt. A
 * substring check on the raw file text is not registration - a line commented out with `#`
 * still contains the path and never runs.
 * @returns The spec paths the green gate runs, in list order.
 */
const GREEN_LIST = path.resolve('tests/e2e-green-suite.txt');
const greenSuiteFiles = (): string[] => readGreenSuite(GREEN_LIST) as string[];

/**
 * @description Asks the real runner which spec paths it would hand to playwright. This is the
 * runner boundary itself: a runner that filters, re-points or re-parses the list answers
 * differently, whatever its source text still contains.
 * @returns The runner's list, one path per line.
 */
const runnerWouldRun = (): string[] => {
  const r = spawnSync(process.execPath, ['scripts/e2e-green.mjs', '--list'], { encoding: 'utf8', timeout: 30_000 });
  expect(r.status, `e2e-green.mjs --list failed: ${r.stderr}`).toBe(0);
  return r.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
};


describe('real-boundary regression doctrine', () => {
  it('keeps the coding rule and the explicit audit linked', () => {
    const rules = read('CLAUDE.md');
    const audit = read('docs/governance/real-boundary-regression-audit.md');
    expect(rules).toContain('Integration-boundary corollary');
    expect(rules).toContain('real-boundary-regression-audit.md');
    expect(audit).toContain('integration-boundary corollary');
  });

  it('proves the durable swarm-memory ledger against a real PostgreSQL, inside a required gate', () => {
    const spec = 'tests/swarm-memory-rls-live.spec.ts';
    const audit = read('docs/governance/real-boundary-regression-audit.md');
    const source = read(spec);
    const requiredE2e = greenSuiteFiles();
    const migration = read('scripts/migrations/117-swarm-memory-provenance.sql');
    const service = read('src/features/agent-management/services/swarm-memory-service.ts');

    // A proof nothing runs is not evidence. This is the whole reason the row stayed open. The
    // membership is over the list the runner builds, not the file's text: a `#`-commented line
    // still contains the path and is exactly what the runner drops.
    // The runner is asked, not grepped: what it would run must be exactly what the parser says.
    expect(runnerWouldRun(), 'scripts/e2e-green.mjs would run a different list than the shared parser reads').toEqual(requiredE2e);
    expect(requiredE2e, `${spec} must be in the required e2e set, not merely on disk`).toContain(spec);

    // And it has to still be the real seam: a real Pool, a role RLS can apply to, the shipped
    // migration text, and the production GUC wrapper — no module mocking anywhere.
    expect(source).toContain('new Pool');
    expect(source).toContain('NOBYPASSRLS');
    expect(source).toContain("readFileSync('scripts/migrations/117-swarm-memory-provenance.sql'");
    expect(source).toContain('wrapPoolWithGuc');
    expect(source).not.toContain('vi.mock(');

    const row = audit.split('\n').find((line) => line.includes(spec));
    expect(row, 'the durable-memory boundary must be registered in the audit by spec path').toBeTruthy();
    expect(row, 'the row must not still read as an open blocker once the proof has run').not.toContain('Open SEC-05 blocker');

    // Both halves of the broker contract the recorded mutations exercised. Moving either one
    // without re-running and re-recording would leave the audit describing code that is gone.
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain("USING (current_setting('oshal.swarm_memory_ledger_broker', true) = 'on')");
    expect(service).toContain("set_config('oshal.swarm_memory_ledger_broker', 'on', true)");
  });

  it('runs ticket ingress over the real Postgres store and enforcing role', () => {
    const requiredE2e = greenSuiteFiles();
    for (const file of [
      'tests/alert-intake-rls-live.spec.ts',
      'tests/connector-webhook-rls-live.spec.ts',
    ]) {
      const source = read(file);
      expect(source, file).toContain('new Pool');
      expect(source, file).toContain('PostgresTicketStore');
      expect(source, file).toContain('NOBYPASSRLS');
      expect(source, file).not.toContain('vi.mock(');
      expect(requiredE2e, `${file} must be in the list the green gate runs, not merely in the file text`).toContain(file);
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
