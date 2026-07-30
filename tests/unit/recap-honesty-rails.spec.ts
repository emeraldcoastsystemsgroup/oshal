/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — file-content guards for the 2026-07-28 recap outage fixes. Each assertion goes red if its fix regresses: doomed 30s pulls, existence-only piece checks (the stale-mix hazard), silent MessageBox failures, the missing OSHAL_USER_SUB on data steps, the localhost/::1 watchdog false-FAIL, piece-name drift across runner/assembler/goal, and the auto-journaled knob turns feeding the deck's "changes" section.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the 2026-07-30 silent-transfer fix, plus a re-point. NodePull is no longer a one-liner, so the existing 600000-timeout assertion (which required the value on the SAME line as `function NodePull`) is re-pointed at the function BODY — same claim, new shape; it would otherwise have gone green-by-vacuity the moment the body moved. New assertions: both transfer helpers inspect RN's result instead of discarding it to Out-Null, and NodePull fails on a local file that did not change (the exact shape of the 26-minute silent no-op).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/**
 * Extracts one PowerShell function's body from a script's text.
 * @description Assertions that pin behaviour to a single physical line silently stop testing
 *   anything when the function is reformatted. Scoping to the body keeps the claim honest
 *   across shape changes — and throws (rather than passing) if the function is renamed away.
 * @param src the script contents
 * @param name the function name, e.g. 'NodePull'
 * @returns the function header plus its brace-matched body
 * @throws if the function is absent or its braces do not balance — either way the guard is no
 *   longer testing what it claims to, and going red is the correct outcome.
 */
const bodyOf = (src: string, name: string): string => {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found — the guard is pointing at a name that no longer exists`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}' && (depth -= 1) === 0) return src.slice(start, i + 1);
  }
  throw new Error(`function ${name} has unbalanced braces — cannot scope the assertion to its body`);
};

const runner = read('scripts/run-daily-recap.ps1');
const routability = read('scripts/swarm-routability-check.sh');
const remoteNode = read('scripts/codex-remote-node.mjs');
const assemble = read('scripts/assemble-recap.js');
const goal = read('packages/oshal-vids-operator/RECAP-BUILD-GOAL.md');
const deckGen = read('scripts/oshal-deck-data.js');
const overrides = read('src/app/trading-config-overrides.ts');
const template = read('packages/oshal-vids-operator/make-deck-detailed.py');

describe('recap runner honesty rails (2026-07-28 outage fixes)', () => {
  it('pulls wait for chunked transfers instead of the doomed 30s default', () => {
    expect(bodyOf(runner, 'NodePull')).toMatch(/--timeoutMs=600000/);
  });
  it('piece check includes FRESHNESS, not just existence (the stale-mix hazard)', () => {
    expect(runner).toMatch(/LastWriteTime -lt \$runStart/);
  });
  it('failures alert by email, never a blocking dialog an unattended run cannot dismiss', () => {
    expect(runner).toMatch(/oshal-send-alert\.js/);
    expect(runner).not.toMatch(/MessageBox/);
  });
  it('data generation carries OSHAL_USER_SUB (else the headline P/L ships as silent nulls)', () => {
    expect(runner).toMatch(/OSHAL_USER_SUB=\$\(\$env:OSHAL_USER_SUB\)/);
  });
  it('preflight prunes stray Chrome but never the oshal-video-chrome automation profile', () => {
    expect(runner).toMatch(/CommandLine -notmatch 'oshal-video-chrome'/);
  });
  it('runner writes ops-notes.json for the report\'s operations section', () => {
    expect(runner).toMatch(/ops-notes\.json/);
  });
});

// 2026-07-30: the four piece pulls ran 26 minutes, reported nothing, and produced a prior day's
// deck-narrated.mp4. RN returns its last output after exhausting retries; both helpers threw that
// output away with `| Out-Null`, so a dead transfer and a good one were the same thing to every
// caller. The failure the operator finally saw named a stale FILE, not the dead transfer.
describe('node transfers fail loudly (2026-07-30 silent-pull fix)', () => {
  it('neither transfer helper discards the driver result to Out-Null', () => {
    expect(bodyOf(runner, 'NodePull')).not.toMatch(/\|\s*Out-Null/);
    expect(bodyOf(runner, 'NodePush')).not.toMatch(/\|\s*Out-Null/);
  });

  it('both helpers inspect the result and call Fail on a dead transfer', () => {
    for (const fn of ['NodePull', 'NodePush']) {
      const body = bodyOf(runner, fn);
      expect(body, `${fn} must test the transfer result`).toMatch(/TransferFailed/);
      expect(body, `${fn} must fail loudly, not continue`).toMatch(/Fail /);
    }
  });

  it('the failure test covers the transport errors RN itself retries on', () => {
    const test = bodyOf(runner, 'TransferFailed');
    for (const signal of ['ECONNRESET', 'fetch failed', 'timed out']) {
      expect(test, `TransferFailed must recognise "${signal}"`).toContain(signal);
    }
  });

  it('NodePull rejects a pull that left the local copy unchanged (the silent no-op)', () => {
    const body = bodyOf(runner, 'NodePull');
    expect(body).toMatch(/\$before/);              // captures the pre-pull timestamp
    expect(body).toMatch(/LastWriteTime -le \$before/); // …and refuses when it did not move
  });

  it('keeps the independent step-5 freshness gate — it catches a stale REMOTE piece', () => {
    expect(runner).toMatch(/LastWriteTime -lt \$runStart/);
  });
});

describe('watchdog false-FAIL fix', () => {
  it('routability probes 127.0.0.1, not localhost (the ::1 wslrelay squatter)', () => {
    expect(routability).toMatch(/127\.0\.0\.1:35457/);
    expect(routability).not.toMatch(/http:\/\/localhost:35457/);
  });
});

describe('remote pull chunk window', () => {
  it('pull defaults each chunk to a patient window; explicit --timeoutMs still wins', () => {
    expect(remoteNode).toMatch(/if \(args\.timeoutMs == null\) args\.timeoutMs = 120_000;/);
  });
});

describe('piece-name contract (runner, assembler and build goal must agree)', () => {
  const pieces = ['presenter-intro.mp4', 'presenter-overview.mp4', 'presenter-close.mp4', 'deck-narrated.mp4'];
  it.each(pieces)('%s appears in runner, assembler and goal', (piece) => {
    expect(runner).toContain(piece);
    if (piece !== 'deck-narrated.mp4') expect(assemble).toContain(piece);
    else expect(assemble).toContain(piece);
    expect(goal).toContain(piece);
  });
  it('no orphaned pre-scrub piece names survive anywhere in the contract files', () => {
    for (const f of [runner, assemble, goal]) expect(f).not.toMatch(/the operator-(intro|overview|close)\.mp4/);
  });
});

describe('what-changed / ops sections exist end to end', () => {
  it('deck generator reads the strategy journal since the prior session', () => {
    expect(deckGen).toMatch(/oshal_trading_strategy_journal/);
    expect(deckGen).toMatch(/et_day > \$2::date AND et_day <= \$3::date/);
  });
  it('deck generator folds date-guarded ops notes in', () => {
    expect(deckGen).toMatch(/ops-notes\.json/);
    expect(deckGen).toMatch(/ops\.date !== targetDate/);
  });
  it('knob turns auto-journal on apply and revert', () => {
    expect(overrides).toMatch(/recordStrategyJournal/);
    expect(overrides).toMatch(/applyOverride[\s\S]*kind: 'knob-turn'/);
  });
  it('the deck template renders the transparency slide honestly when empty', () => {
    expect(template).toMatch(/WHAT CHANGED/);
    expect(template).toMatch(/No strategy changes since the last report/);
  });
});
