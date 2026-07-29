/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — file-content guards for the 2026-07-28 recap outage fixes. Each assertion goes red if its fix regresses: doomed 30s pulls, existence-only piece checks (the stale-mix hazard), silent MessageBox failures, the missing OSHAL_USER_SUB on data steps, the localhost/::1 watchdog false-FAIL, piece-name drift across runner/assembler/goal, and the auto-journaled knob turns feeding the deck's "changes" section.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

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
    expect(runner).toMatch(/function NodePull[^\n]*--timeoutMs=600000/);
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
