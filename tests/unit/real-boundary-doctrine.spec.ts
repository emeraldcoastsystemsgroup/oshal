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
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | The guard drives the runner body with a recording spawner and pins the playwright ARGV to the parsed list; `--list` compared the parser to itself through a second derivation, and a filter at the spawn site passed it (third review, X1-X4). parseGreenSuite gets its own case for CRLF, indentation, trailing whitespace, `#` lines and blanks.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | The guard drives main() - the function the CLI entry calls - rather than the body beneath it, and pins the argv to exactly the parsed list with no flags appended, so an entry that re-points the list or adds --grep-invert goes red (fourth review, X6/X6b).
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | The program is run out of process with a recording npx (a copy of the runner, its parser and the list in a scratch tree shaped like the repo), and the argv it hands playwright is pinned to the parsed list with no flags - the only drive that reaches the module default list path and the entry line (fifth review: X10, X6', X8 passed the in-process drive). The in-process drive stays as the fast path and no longer supplies listPath, so main's own default is exercised. The "only the exit is undriven" wording is withdrawn.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Pin the planted-fixture secret-scan proof as the scanner boundary run that actually happened. Entry 2 pinned the DOUBLE and the audit row that says a real run is still owed; the detection half of that debt is now paid by a guard that runs the real gitleaks image, so this case keeps it real - no stand-in on PATH, the production gate text rather than a paraphrase, a planted token that is never contiguous in the source (which is why it needs no .gitleaks.toml allowlist entry), and an audit row linked to evidence carrying the red verdict verbatim.
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Pin the PARTIAL-SCAN proof and retire the last locally reachable `Owed` in the audit. Entry 9 paid the detection half of the scanner debt; the half the gate was actually written for - gitleaks exiting 0 on a tree it could not fully read - was still only a recording. This case keeps the new companion real (no stand-in on PATH, the production scanner function and both gate_secrets lines rather than a paraphrase, both verdict strings, and the floating-tag wording read out of the shipped helper instead of copied into the guard), and the scanner-double case above now requires its row to name that companion rather than to read as owed.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { parseGreenSuite, readGreenSuite } from '../../scripts/e2e-green-list.mjs';
import { main as runGreenGate } from '../../scripts/e2e-green.mjs';

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
 * @description Runs main() - the function the CLI entry calls - in process with a recording
 * spawner and returns the playwright argv it produced. This is the fast path: it reaches the
 * body and main's own defaults, but not the entry line itself, which programHandsPlaywright()
 * below covers by running the program as the gate does.
 * @returns The spec paths the runner handed to playwright, in order.
 */
const runnerHandsPlaywright = (): string[] => {
  const calls: string[][] = [];
  const result = runGreenGate([], {
    // No listPath: the program's OWN default is what must resolve to the parsed list.
    exists: () => true, // the chat bundle is the page under test, not the list under test
    spawn: (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { status: 0 }; },
    log: () => undefined,
    error: () => undefined,
  });
  expect(result.status).toBe(0);
  expect(calls, 'the runner spawned something other than one playwright run').toHaveLength(1);
  // Exactly this argv and nothing appended: a filter flag added by the entry would be a way to
  // skip a listed spec while the list itself still names it.
  const [cmd, tool, verb, ...rest] = calls[0];
  expect([cmd, tool, verb]).toEqual(['npx', 'playwright', 'test']);
  expect(rest.filter((arg) => arg.startsWith('-')), 'the gate appended playwright flags of its own').toEqual([]);
  return rest;
};


/**
 * @description Runs scripts/e2e-green.mjs AS A PROGRAM, the way the gate does, with a recording
 * `npx` first on PATH, and returns the argv it handed playwright. A copy of the runner, its parser
 * and the list is laid out in a scratch directory with the same shape as the repo, so the
 * program's own default list path, its top-level statements and the entry line's argv expression
 * all execute for real. Nothing here can be satisfied by what the guard supplies, because the
 * guard supplies nothing but PATH.
 * @returns The spec paths (and any flags) the program handed playwright, in order.
 */
const programHandsPlaywright = (): string[] => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'e2e-green-program-'));
  try {
    for (const rel of ['scripts/e2e-green.mjs', 'scripts/e2e-green-list.mjs', 'tests/e2e-green-suite.txt']) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      copyFileSync(path.resolve(rel), path.join(root, rel));
    }
    // The chat bundle is the page under test, not the list under test: an empty file skips the
    // unrelated vite preflight the way a built checkout would.
    mkdirSync(path.join(root, 'src', 'api', 'dist'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'api', 'dist', 'chat-ui.js'), '');
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    const record = path.join(root, 'npx-argv.txt');
    // `shell: true` resolves `npx` through cmd.exe on Windows and sh elsewhere; both shims append
    // their argv, space-joined, to the record and exit 0.
    writeFileSync(path.join(bin, 'npx.cmd'), `@echo off\r\necho %*>> "${record}"\r\n`);
    writeFileSync(path.join(bin, 'npx'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${record.replace(/\\/g, '/')}"\n`, { mode: 0o755 });
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'e2e-green.mjs')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` },
    });
    expect(r.status, `the program did not exit 0: ${r.stdout}${r.stderr}`).toBe(0);
    expect(existsSync(record), 'the program never invoked npx').toBe(true);
    const lines = readFileSync(record, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    expect(lines, 'the program invoked npx more than once').toHaveLength(1);
    const [tool, verb, ...rest] = lines[0].split(/\s+/);
    expect([tool, verb]).toEqual(['playwright', 'test']);
    return rest;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe('real-boundary regression doctrine', () => {
  it('hands playwright exactly the parsed list when run as the gate runs it', () => {
    // Out of process, through the real entry line and the module's own default list path.
    const handed = programHandsPlaywright();
    expect(handed.filter((arg) => arg.startsWith('-')), 'the program appended playwright flags of its own').toEqual([]);
    expect(handed, 'the program handed playwright a different list than the shared parser reads').toEqual(greenSuiteFiles());
  });

  it('parses the green list the one way both the runner and this guard depend on', () => {
    const text = ' tests/a.spec.ts \r\n\n#tests/commented.spec.ts\r\n  # indented comment\n\ttests/b.spec.ts\t\ntests/c.spec.ts';
    expect(parseGreenSuite(text)).toEqual(['tests/a.spec.ts', 'tests/b.spec.ts', 'tests/c.spec.ts']);
    expect(parseGreenSuite('')).toEqual([]);
    expect(parseGreenSuite('# only a comment\n\n')).toEqual([]);
  });

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
    // The runner is driven, not grepped: the argv it hands playwright must be exactly the parsed list.
    expect(runnerHandsPlaywright(), 'scripts/e2e-green.mjs handed playwright a different list than the shared parser reads').toEqual(requiredE2e);
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

  it('registers the ci-local secret-scan scanner double and the real run that has now paid for it', () => {
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
    // The partial-scan run has happened (2026-09-21), so this row may no longer read as owed - and
    // it has to say which guard paid the debt, or "not owed" is an unsourced claim.
    expect(row, 'the row must not read as an owed boundary now that the real run exists')
      .not.toMatch(/\|\s*Owed\b/);
    expect(row, 'the row must name the companion that made the real image skip a path')
      .toContain('tests/unit/ci-local-secret-scan-unreadable-path.spec.ts');

    // The row has to name what the gate actually runs and the version its wording list came
    // from, so bumping either without re-recording the companion turns this red.
    const tag = /zricethezav\/gitleaks:[\w.-]+/.exec(gate)?.[0];
    const calibrated = /v\d+\.\d+\.\d+/.exec(helper)?.[0];
    expect(tag, 'ci-local.sh must still name the scanner image').toBeTruthy();
    expect(calibrated, 'ci-secret-scan.sh must still name the version its wordings came from').toBeTruthy();
    expect(row, 'the audit row must name the scanner the gate runs').toContain(tag!);
    expect(row, 'the audit row must name the calibrated wording version').toContain(calibrated!);
  });

  it('registers the planted-fixture proof as the scanner run that really happened, with no stand-in on PATH', () => {
    const audit = read('docs/governance/real-boundary-regression-audit.md');
    const guard = read('tests/unit/ci-local-secret-scan-planted-fixture.spec.ts');
    const gate = read('scripts/ci-local.sh');
    const evidence = read('docs/security/secret-scan-planted-fixture-proof.md');

    // The whole value of this guard is that the image runs. A stand-in `docker` first on PATH —
    // the sibling guard's technique — would silently turn it back into a recording.
    expect(guard, 'a stand-in scanner would hollow out this proof').not.toContain('fakeBin');
    expect(guard, 'nothing may be put in front of the real docker').not.toContain('export PATH=');
    expect(guard, 'only the real image writes its scan line').toContain('scanned ~');
    // It must run the production gate text, not a paraphrase of it.
    expect(guard).toContain("['gitleaks_container_scan', 'gate_secrets']");

    // Fail, then pass, decided by the scanner's own exit code rather than by the guard.
    expect(guard).toContain('secret-scan: FAIL scanner rc=1 unread=0 of 4 exported files');
    expect(guard).toContain('secret-scan: PASS unread=0 of 3 exported files (scanner rc=0)');

    // The planted value is assembled at runtime, so the source never carries the token and the
    // fixture allowlist never has to be widened to accommodate this file.
    // The allowlisted documentation dummy is the one AWS-shaped token allowed to be spelled out.
    const withoutDocumented = guard.replace(/AKIA[0-9A-Z]*EXAMPLE/g, '<documented>');
    expect(withoutDocumented, 'the planted token must never appear contiguously in the source')
      .not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(read('.gitleaks.toml'), 'this guard must not need an allowlist entry')
      .not.toContain('ci-local-secret-scan-planted-fixture');

    const tag = /zricethezav\/gitleaks:[\w.-]+/.exec(gate)?.[0];
    expect(tag, 'ci-local.sh must still name the scanner image').toBeTruthy();
    const row = audit.split('\n')
      .find((line) => line.includes('tests/unit/ci-local-secret-scan-planted-fixture.spec.ts'));
    expect(row, 'the real companion must be registered in the audit').toBeTruthy();
    expect(row, 'the audit row must link the evidence').toContain('secret-scan-planted-fixture-proof.md');
    expect(evidence, 'the evidence must name the scanner the gate runs').toContain(tag!);
    expect(evidence, 'the evidence must carry the red verdict verbatim')
      .toContain('secret-scan: FAIL scanner rc=1 unread=0 of 4 exported files');
  });

  it('registers the partial-scan proof: a real image that skipped a path, and a gate that refused the PASS', () => {
    const audit = read('docs/governance/real-boundary-regression-audit.md');
    const guard = read('tests/unit/ci-local-secret-scan-unreadable-path.spec.ts');
    const gate = read('scripts/ci-local.sh');
    const helper = read('scripts/ci/ci-secret-scan.sh');
    const evidence = read('docs/security/secret-scan-unreadable-path-proof.md');

    // The whole value of this guard is that the image runs and really fails to read a path.
    expect(guard, 'a stand-in scanner would hollow out this proof').not.toContain('fakeBin');
    expect(guard, 'nothing may be put in front of the real docker').not.toContain('export PATH=');
    expect(guard, 'only the real image writes its scan line').toContain('scanned ~');

    // Production text, not a paraphrase: the scanner function and both gate_secrets lines.
    expect(guard).toContain("ciFunction('gitleaks_container_scan')");
    expect(guard).toContain("gateLine('git archive')");
    expect(guard).toContain('gateLine(\'run_secret_scan "$exp"\')');

    // The defect itself: the scanner exits 0 on a partial scan and the gate must still say FAIL,
    // with the count in the verdict, and PASS on the same export once the read is given back.
    expect(guard).toContain('secret-scan: FAIL unread=1 of 4 exported files (scanner rc=0)');
    expect(guard).toContain('secret-scan: PASS unread=0 of 4 exported files (scanner rc=0)');

    // The floating-tag check has to read the wording list out of the shipped helper. A copy of the
    // pattern inside the guard would keep passing after the image reworded its skip line.
    expect(helper, 'the helper must still own the wording list').toContain('GITLEAKS_UNREAD_PATTERN=');
    expect(guard).toContain('GITLEAKS_UNREAD_PATTERN');
    expect(guard).toContain('readFileSync(SCAN_HELPER');
    // And it must refuse to run at all if the unreadable path could not be created.
    expect(guard).toContain('could not make');

    const tag = /zricethezav\/gitleaks:[\w.-]+/.exec(gate)?.[0];
    expect(tag, 'ci-local.sh must still name the scanner image').toBeTruthy();
    const row = audit.split('\n')
      .find((line) => line.startsWith('| `tests/unit/ci-local-secret-scan-unreadable-path.spec.ts`'));
    expect(row, 'the partial-scan companion must be registered in the audit').toBeTruthy();
    expect(row, 'the audit row must link the evidence').toContain('secret-scan-unreadable-path-proof.md');
    expect(evidence, 'the evidence must name the scanner the gate runs').toContain(tag!);
    expect(evidence, 'the evidence must carry the red verdict verbatim')
      .toContain('secret-scan: FAIL unread=1 of 4 exported files (scanner rc=0)');
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
