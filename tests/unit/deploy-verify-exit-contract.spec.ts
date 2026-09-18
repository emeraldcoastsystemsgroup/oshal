/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guards the EXIT-CODE contract, which is what the third state was missing. Between 2026-09-15 and 2026-09-16 `VERIFY UNVERIFIED` printed on every deploy, in the same words each time, while Jarvis answered 503 to every ask and a real ticket landed in `escalated` - and each of those runs still ended `DEPLOYED ... 0 unhealthy` with exit 0. A verdict with no consequence is not a gate. Two rules give it one and both are driven here against the real library in a real shell. (a) With OSHAL_VERIFY_OPERATOR_PAT set the product checks are BINARY: the probe already refused exit 3 on a supplied token, but the shell - which decides the deploy's exit code - accepted a 3 unconditionally, and a 3 is reachable with the token visibly set, because ${!OSHAL_VERIFY_@} enumerates non-exported variables and a bare assignment is forwarded as a name docker resolves against its own environment and finds nothing. (b) An unproven run escalates off a ledger the gate appends to, so the third consecutive one returns 3 and the deploy exits 5 - a different fact from exit 4's proved-broken - and the line printed on the way there changes every run. tests/unit/deploy-live-verification.spec.ts keeps the three checks themselves; this file is only about what a deploy DOES with their verdicts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guard the storm tail by DRIVING it: the real block from scripts/oshal-deploy.sh is executed at each probe outcome and the operator-facing line is read back. Restoring the defect it fixes - logging UNVERIFIED and then claiming "api lived through the recreate" - left every deploy guard in this file green, because the only thing asserted about that block was the absence of one word.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEPLOY_SCRIPT, DOCKER_STUB, VERIFY_LIB, resolveHostBash, runPostVerify, scratchFile,
} from '../helpers/deploy-verify-shell';

const libSource = readFileSync(VERIFY_LIB, 'utf8');
const deploySource = readFileSync(DEPLOY_SCRIPT, 'utf8');
const BASH = resolveHostBash();

/** A probe that answers "not verifiable from automation" for BOTH product checks. */
const UNPROVEN = {
  DOCKER_STUB_JARVIS_RC: '3', DOCKER_STUB_JARVIS_OUT: 'NOT VERIFIABLE FROM AUTOMATION: ...',
  DOCKER_STUB_TICKET_RC: '3', DOCKER_STUB_TICKET_OUT: 'NOT VERIFIABLE FROM AUTOMATION: ...',
};
/** Stands in for an operator's session-minted PAT; asserted never to reach any output. */
const SUPPLIED_PAT = 'fixture-operator-pat-never-printed';

let scratch: string;
let stub: string;

beforeAll(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'deploy-verify-contract-'));
  stub = scratchFile(scratch, 'docker-stub');
  writeFileSync(stub, DOCKER_STUB);
});

afterAll(() => {
  expect(path.dirname(path.resolve(scratch))).toBe(path.resolve(tmpdir()));
  rmSync(scratch, { recursive: true, force: true });
});

/** Run the REAL gate once, with the docker binary shadowed and an isolated streak ledger. */
function verify(env: Record<string, string> = {}) {
  return runPostVerify(BASH, stub, scratch, env);
}

/** Seed a streak ledger with the run outcomes a case needs to already be on the record. */
function seedLedger(lines: string[]): string {
  const file = scratchFile(scratch, 'seed');
  writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '');
  return file;
}

/** What the gate recorded, one line per completed run. */
function ledgerLines(file: string): string[] {
  try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; }
}

describe('scripts/lib/deploy-verify.sh — with an operator PAT there is no third state', () => {
  it.each([
    ['jarvis-ask', { DOCKER_STUB_JARVIS_RC: '3', DOCKER_STUB_JARVIS_OUT: 'NOT VERIFIABLE FROM AUTOMATION: ...' }],
    ['ticket-dispatch', { DOCKER_STUB_TICKET_RC: '3', DOCKER_STUB_TICKET_OUT: 'NOT VERIFIABLE FROM AUTOMATION: ...' }],
  ])('FAILS %s on a probe exit 3 when OSHAL_VERIFY_OPERATOR_PAT is set', (check, env) => {
    // The probe reaches the same conclusion inside the container — but it only knows what it
    // RECEIVED, and the gap between "the caller set it" and "the probe received it" is real and
    // reachable: ${!OSHAL_VERIFY_@} enumerates NON-exported variables too, so a PAT assigned
    // without `export` is forwarded as a bare `-e NAME`, docker resolves that name against its own
    // environment, finds nothing, and the probe mints a service-secret PAT and refuses exactly as
    // if none had been supplied. Only this side of the boundary can see that, so only this side
    // can refuse it — which is why the rule lives in the shell and not only in the probe.
    const run = verify({ ...(env as Record<string, string>), OSHAL_VERIFY_OPERATOR_PAT: SUPPLIED_PAT });
    expect(run.stdout, 'a token in hand means PASS or FAIL — never a third state').toContain('RC=1');
    expect(run.stdout).toContain(`VERIFY FAIL  ${check}`);
    expect(run.stdout).not.toContain(`VERIFY UNVERIFIED  ${check}`);
    expect(run.stdout, 'and the run must not summarise as unproven either').not.toContain('check(s) NOT VERIFIABLE');
    expect(run.stdout).toContain('post-deploy live verification: 1 check(s) FAILED');
  });

  it('names BOTH ways a supplied token can fail to prove anything, cheapest one first', () => {
    const run = verify({ ...UNPROVEN, OSHAL_VERIFY_OPERATOR_PAT: SUPPLIED_PAT });
    expect(run.stdout).toContain('carries no verified principal issuer');
    expect(run.stdout, 'the export trap is invisible from inside the container, so it has to be named here')
      .toContain("assigned without 'export'");
    expect(run.stdout).toContain('export OSHAL_VERIFY_OPERATOR_PAT');
    expect(run.stdout, 'a remedy must never echo the credential it is about').not.toContain(SUPPLIED_PAT);
  });

  it('passes plainly — and records a PROVEN run — when a supplied PAT makes both checks answerable', () => {
    const run = verify({ OSHAL_VERIFY_OPERATOR_PAT: SUPPLIED_PAT });
    expect(run.stdout).toContain('RC=0');
    expect(run.stdout).toContain('post-deploy live verification: all checks passed');
    expect(run.stdout).not.toContain('UNVERIFIED');
    expect(ledgerLines(run.ledger)).toEqual([expect.stringMatching(/^\S+ PROVEN$/)]);
  });

  it('still fails a genuinely broken product when the PAT is set — a token is not a pass', () => {
    const run = verify({
      OSHAL_VERIFY_OPERATOR_PAT: SUPPLIED_PAT,
      DOCKER_STUB_TICKET_RC: '1', DOCKER_STUB_TICKET_OUT: "landed in 'escalated'",
    });
    expect(run.stdout).toContain('RC=1');
    expect(run.stdout).toContain('VERIFY FAIL  ticket-dispatch');
    expect(ledgerLines(run.ledger)[0]).toContain('FAILED');
  });
});

describe('scripts/lib/deploy-verify.sh — an unproven run escalates instead of repeating itself', () => {
  it('stays advisory on the first unproven run, but says how long and how many are left', () => {
    const run = verify(UNPROVEN);
    expect(run.stdout).toContain('RC=0');
    // The pinned sentence the rest of the corpus reads is untouched...
    expect(run.stdout).toContain('2 check(s) NOT VERIFIABLE from automation - this deploy is UNPROVEN as a product');
    // ...and the new line beside it is what stops it being wallpaper.
    expect(run.stdout).toContain('UNPROVEN on 1 consecutive run(s)');
    expect(run.stdout).toContain('2 more before this FAILS the deploy');
    expect(run.stdout).toContain('OSHAL_VERIFY_OPERATOR_PAT');
    expect(ledgerLines(run.ledger)[0]).toMatch(/UNPROVEN unverified=2$/);
  });

  it('returns 3 — not 1, and not 0 — once the grace is spent, naming the one action that clears it', () => {
    const run = verify({ ...UNPROVEN, OSHAL_VERIFY_LEDGER: seedLedger([
      '2026-09-14T00:00:00Z UNPROVEN unverified=2',
      '2026-09-15T00:00:00Z UNPROVEN unverified=2',
    ]) });
    expect(run.stdout, 'unproven past the grace is its own outcome').toContain('RC=3');
    expect(run.stdout).toContain('UNPROVEN on 3 consecutive run(s) (first 2026-09-14T00:00:00Z)');
    expect(run.stdout).toContain('the grace for that is SPENT');
    expect(run.stdout, 'nothing here is PROVED broken — that is the other code').not.toContain('check(s) FAILED');
    expect(run.stdout).toContain('POST /api/cli-tokens');
    expect(run.stdout, 'the export trap belongs in the instruction the operator will actually follow')
      .toMatch(/export OSHAL_VERIFY_OPERATOR_PAT/);
  });

  it('is still advisory one run before that — the boundary, not a vibe', () => {
    const run = verify({ ...UNPROVEN, OSHAL_VERIFY_LEDGER: seedLedger(['2026-09-15T00:00:00Z UNPROVEN unverified=2']) });
    expect(run.stdout).toContain('RC=0');
    expect(run.stdout).toContain('UNPROVEN on 2 consecutive run(s)');
    expect(run.stdout).toContain('1 more before this FAILS the deploy');
  });

  it.each([
    ['a PROVEN run', '2026-09-15T12:00:00Z PROVEN'],
    ['a FAILED run', '2026-09-15T12:00:00Z FAILED failed=1'],
    ['a garbled line', 'something that is not an outcome line at all'],
  ])('resets the streak on %s — only consecutive unproven runs count', (_label, line) => {
    // A FAILED run already exits non-zero, so it needs no escalation; a garbled line under-counts
    // rather than over-counts, which costs a later escalation and never a deploy failed on noise.
    const run = verify({ ...UNPROVEN, OSHAL_VERIFY_LEDGER: seedLedger([
      '2026-09-13T00:00:00Z UNPROVEN unverified=2',
      '2026-09-14T00:00:00Z UNPROVEN unverified=2',
      line,
    ]) });
    expect(run.stdout).toContain('RC=0');
    expect(run.stdout).toContain('UNPROVEN on 1 consecutive run(s)');
  });

  it('never prints the same unproven line twice running — the property that made it boilerplate', () => {
    const ledger = seedLedger([]);
    const unprovenLine = (out: string) => out.split('\n').find((line) => line.includes('UNPROVEN on'));
    const first = verify({ ...UNPROVEN, OSHAL_VERIFY_LEDGER: ledger });
    const second = verify({ ...UNPROVEN, OSHAL_VERIFY_LEDGER: ledger });
    expect(unprovenLine(first.stdout)).toBeDefined();
    expect(unprovenLine(second.stdout), 'a signal that never changes its wording is wallpaper, not a signal')
      .not.toBe(unprovenLine(first.stdout));
    expect(unprovenLine(first.stdout)).toContain('2 more');
    expect(unprovenLine(second.stdout)).toContain('1 more');
  });

  it('fails on the FIRST unproven run under OSHAL_VERIFY_REQUIRE_PROOF — the intended steady state', () => {
    const run = verify({ ...UNPROVEN, OSHAL_VERIFY_REQUIRE_PROOF: '1' });
    expect(run.stdout).toContain('RC=3');
    expect(run.stdout).toContain('UNPROVEN on 1 consecutive run(s)');
    expect(run.stdout).toContain('the grace for that is SPENT');
  });

  it('has exactly one switch for the grace, and it can only TIGHTEN it', () => {
    // A knob that widens a gate is the knob that gets used to defuse the gate. The grace is a
    // constant in the library on purpose; the only environment variable removes it entirely.
    const graceNames = new Set(libSource.match(/\bOSHAL_[A-Z_]*GRACE[A-Z_]*\b/g) ?? []);
    expect([...graceNames]).toEqual(['OSHAL_VERIFY_UNPROVEN_GRACE_DEPLOYS']);
    expect(libSource, 'the grace is assigned, never read from the environment')
      .toMatch(/^OSHAL_VERIFY_UNPROVEN_GRACE_DEPLOYS=\d+$/m);
    expect(libSource).not.toMatch(/OSHAL_VERIFY_UNPROVEN_GRACE_DEPLOYS:-/);
    expect(libSource).toContain('OSHAL_VERIFY_REQUIRE_PROOF');
  });

  it('records nothing on a skipped run — a run that measured nothing neither grows nor resets it', () => {
    const ledger = seedLedger(['2026-09-14T00:00:00Z UNPROVEN unverified=2']);
    const before = readFileSync(ledger, 'utf8');
    const run = verify({ OSHAL_DEPLOY_SKIP_LIVE_VERIFY: '1', OSHAL_VERIFY_LEDGER: ledger });
    expect(run.stdout).toContain('RC=0');
    expect(readFileSync(ledger, 'utf8'), 'a run that measured nothing may claim nothing').toBe(before);
  });

  it('says so out loud when it cannot record the run, and still does not fail the deploy on it', () => {
    // A gate that goes red because $HOME is read-only is a gate nobody can act on. But without the
    // ledger the streak can never grow, so the escalation is frozen at its first rung — and an
    // escalation that silently cannot fire is the exact defect this whole change removes.
    // The parent is a regular FILE, so `mkdir -p` under it cannot succeed on any platform.
    const blocker = scratchFile(scratch, 'not-a-directory');
    writeFileSync(blocker, 'a regular file\n');
    const run = verify({ ...UNPROVEN, OSHAL_VERIFY_LEDGER: `${blocker}/live-verify.log` });
    expect(run.stdout).toContain('RC=0');
    expect(run.stdout).toContain('the unproven streak cannot escalate');
    expect(run.stdout, 'and it has to name the path, or it is not actionable').toContain(blocker);
  });

  it('keeps a FAILED check fatal even while another check is unproven on a spent grace', () => {
    const run = verify({
      DOCKER_STUB_JARVIS_RC: '3', DOCKER_STUB_JARVIS_OUT: 'NOT VERIFIABLE FROM AUTOMATION: ...',
      DOCKER_STUB_TICKET_RC: '1', DOCKER_STUB_TICKET_OUT: "landed in 'escalated'",
      OSHAL_VERIFY_LEDGER: seedLedger([
        '2026-09-14T00:00:00Z UNPROVEN unverified=2',
        '2026-09-15T00:00:00Z UNPROVEN unverified=2',
      ]),
    });
    // Even sitting on a spent grace, a real failure outranks it: the deploy has to hear the code
    // that names a broken product, not the one that says nothing was proved.
    expect(run.stdout).toContain('RC=1');
    expect(run.stdout).toContain('VERIFY FAIL  ticket-dispatch');
    expect(run.stdout).toContain('1 check(s) NOT VERIFIABLE');
  });
});

describe('scripts/oshal-deploy.sh — the two codes it spends those verdicts on', () => {
  const at = (needle: string) => {
    const index = deploySource.indexOf(needle);
    expect(index, `missing anchor: ${needle}`).toBeGreaterThan(-1);
    return index;
  };

  it('exits 5 — a DIFFERENT code from 4 — when the product was never PROVED, and does not roll back', () => {
    const block = deploySource.slice(at('if [ "$VERIFY_RC" -eq 3 ]; then'), at('log "DEPLOYED '));
    expect(block).toContain('exit 5');
    expect(block).toMatch(/NEVER PROVED/);
    expect(block, 'the absence of proof is not a reason to replace a serving image').not.toMatch(/\brollback\b/);
    expect(block).toMatch(/NOT rolled back/i);
    expect(block, 'the one action that clears it has to be typed out, not pointed at').toContain('POST /api/cli-tokens');
    expect(block).toContain('OSHAL_VERIFY_OPERATOR_PAT');
    expect(block, 'and the export trap with it — a bare assignment forwards a name that resolves to nothing')
      .toMatch(/export/);
    // Reachable from nowhere else, or the code stops meaning anything — same rule as exit 4.
    expect(deploySource.match(/exit 5/g) ?? []).toHaveLength(1);
    expect(deploySource.slice(0, deploySource.indexOf('set -uo pipefail'))).toMatch(/EXIT:[\s\S]*\b5\b/);
  });

  /**
   * @description Runs the REAL storm block out of scripts/oshal-deploy.sh at one probe outcome.
   * Everything the block reads is supplied; nothing about it is rewritten, so the assertions are
   * about the sentence an operator actually gets.
   * @param rc - The probe's exit status: 0 measured-and-clean, 1 failed, 2 could not look.
   * @param verdict - The probe's own stdout line, which the failure text branches on.
   * @returns The block's output and exit status.
   */
  function stormBlock(rc: number, verdict = ''): { out: string; status: number | null } {
    const block = deploySource.slice(at('STORM_TAIL='), at('log "advisory error scan'));
    const scratch = mkdtempSync(path.join(tmpdir(), 'storm-tail-'));
    try {
      const file = path.join(scratch, 'block.sh');
      writeFileSync(file, [
        'set -uo pipefail',
        'log() { printf "%s\\n" "$*"; }',
        'HEAD_SHA=abcdef0123456789; NEW_ID="sha256:0123456789abcdef"; BOT_SERVICES=(a b c)',
        'RUN_LOG=/dev/null; API_CONTAINER=api; STORM_SINCE=2026-01-01T00:00:00Z; STORM_RESTARTS=0',
        'VERIFY_TAIL="live verification passed"',
        `STORM_RC=${rc}; STORM_VERDICT=${JSON.stringify(verdict)}`,
        block,
      ].join('\n') + '\n');
      const run = spawnSync(BASH, [file.replace(/\\/g, '/')], { encoding: 'utf8', timeout: 30_000 });
      return { out: `${run.stdout ?? ''}${run.stderr ?? ''}`, status: run.status };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  it('says the api survived the recreate ONLY on a run that measured it', () => {
    // The whole point of the tail. A storm check that could not be taken used to log UNVERIFIED and
    // then print "api lived through the recreate" one line below it, in the line the operator reads.
    const measured = stormBlock(0);
    expect(measured.status).toBe(0);
    expect(measured.out).toContain('api lived through the recreate');

    const unverified = stormBlock(2);
    expect(unverified.status, 'a check that could not be taken is not a failure').toBe(0);
    expect(unverified.out).toContain('UNVERIFIED');
    expect(unverified.out, 'it cannot claim survival in the same breath as UNVERIFIED')
      .not.toContain('api lived through the recreate');
  });

  it('tells the operator which failure it saw, because a survived termination is not a restart', () => {
    const restarted = stormBlock(1, 'api-storm-probe: FAIL(restarted) - RestartCount moved 0 -> 1');
    expect(restarted.status).toBe(6);
    expect(restarted.out).toContain('DID NOT LIVE THROUGH THE BOT RECREATE');

    const terminated = stormBlock(1, 'api-storm-probe: FAIL(terminated) - RestartCount unchanged, but 1 line(s)');
    expect(terminated.status).toBe(6);
    expect(terminated.out).toContain('TRANSACTION WAS TERMINATED');
    expect(terminated.out, 'the process did not restart, so nobody should be sent to read one')
      .not.toContain('DID NOT LIVE THROUGH THE BOT RECREATE');
    expect(terminated.out).not.toContain('Read the restart');
  });

  it('maps the gate’s two non-zero returns to those two codes, and to nothing else', () => {
    const one = at('if [ "$VERIFY_RC" -eq 1 ]; then');
    const three = at('if [ "$VERIFY_RC" -eq 3 ]; then');
    expect(three).toBeGreaterThan(one);
    expect(deploySource.slice(one, three)).toContain('exit 4');
    expect(deploySource.slice(three)).toContain('exit 5');
    // A bare negation folds 3 into 1 and loses the distinction with nothing to say it happened.
    expect(deploySource, 'the return code has to be READ, not just tested for truthiness')
      .not.toContain('if ! oshal_deploy_post_verify');
  });

  it('carries the streak into the headline, so a DEPLOYED line cannot read the same two days running', () => {
    const tail = deploySource.slice(at('if [ "${OSHAL_VERIFY_UNVERIFIED:-0}" -eq 0 ]'), at('log "DEPLOYED '));
    expect(tail).toContain('OSHAL_VERIFY_UNPROVEN_STREAK');
    expect(tail).toMatch(/consecutive run/);
  });

  it('is written down where an operator reads it, including the state with no third option', () => {
    const runbook = readFileSync(path.resolve('docs/runbooks/deploy-parity.md'), 'utf8');
    const prose = runbook.replace(/\s+/g, ' ');
    // The rule that closes the hole. An operator who supplies a token must know the check is binary.
    expect(prose, 'a runbook that leaves this vague invites the third state back with a token in hand')
      .toContain('there is no third state');
    // The escalation, its home, and the switch that removes the grace.
    expect(runbook).toContain('live-verify.log');
    expect(runbook).toContain('OSHAL_VERIFY_REQUIRE_PROOF');
    expect(prose).toContain('exit 5');
    expect(prose, 'the grace has to be a number an operator can count deploys against')
      .toMatch(/three consecutive|3 consecutive/i);
    // And the distinction the two codes exist for.
    expect(prose, 'exit 4 and exit 5 mean different things and demand different actions')
      .toMatch(/proved broken[\s\S]{0,140}never proved|never proved[\s\S]{0,140}proved broken/i);
  });
});
