/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - guard for BUG-22's prevention. The defect was not a crash; it was an alert whose wording never changed, so these pin the two claims the alert now makes and that a wrong parse would silently corrupt: the streak count, and which gates are red for the first time tonight.
 */

/**
 * Guards for the nightly-gate streak summary.
 *
 * The failure this prevents is a false or unchanging alert, so the assertions are about what
 * the summary is allowed to CLAIM. The log fixtures below are the real recorded format from
 * `%LOCALAPPDATA%\oshal\ci-local.log`, interleaved with per-gate lines and tool output,
 * because parsing that real shape is the boundary this guard has to cross - a summary tested
 * only against clean synthetic lines would not have caught a log that grew noisier.
 */
import { describe, expect, it } from 'vitest';
import {
  parseRunOutcomes,
  renderAlertBody,
  summarizeGateStreak,
} from '../../scripts/ci/ci-gate-streak.mjs';

/** Verbatim shape from the real log, including the noise between run-outcome lines. */
const REAL_LOG = [
  '[2026-09-06T00:20:14] GATE unit: FAIL (1803s)',
  '[2026-09-06T00:46:26] === LOCAL CI: FAILED gates: unit security-policy secret-scan e2e-green trivy ===',
  '[2026-09-06T23:47:51] GATE unit: FAIL (649s)',
  '[2026-09-07T00:21:59] === LOCAL CI: FAILED gates: unit lint secret-scan e2e-green trivy ===',
  '[2026-09-07T23:48:54] GATE unit: FAIL (699s)',
  '[2026-09-08T00:13:50] === LOCAL CI: FAILED gates: unit lint secret-scan e2e-green image-smoke trivy ===',
].join('\n');

describe('parsing the run log', () => {
  it('reads only run outcomes, ignoring per-gate and tool lines', () => {
    const outcomes = parseRunOutcomes(REAL_LOG);
    expect(outcomes).toHaveLength(3);
    expect(outcomes[0].failed).toEqual(['unit', 'security-policy', 'secret-scan', 'e2e-green', 'trivy']);
    expect(outcomes[2].at).toBe('2026-09-08T00:13:50');
  });

  it('records a green run as an outcome with no failed gates', () => {
    const outcomes = parseRunOutcomes('[2026-09-08T00:13:50] === LOCAL CI: ALL GATES GREEN ===');
    expect(outcomes).toEqual([{ at: '2026-09-08T00:13:50', failed: [] }]);
  });

  it('survives an empty or absent log rather than throwing inside the notifier', () => {
    expect(parseRunOutcomes('')).toEqual([]);
    expect(parseRunOutcomes(undefined as unknown as string)).toEqual([]);
  });

  it('reads a log written with CRLF line endings', () => {
    expect(parseRunOutcomes(REAL_LOG.replace(/\n/g, '\r\n'))).toHaveLength(3);
  });
});

describe('the streak count', () => {
  it('counts consecutive failed runs ending at the current one', () => {
    expect(summarizeGateStreak(REAL_LOG).streak).toBe(3);
  });

  it('stops counting at the last green run, and dates the streak from the failure after it', () => {
    const log = [
      '[2026-08-01T00:00:00] === LOCAL CI: FAILED gates: trivy ===',
      '[2026-08-02T00:00:00] === LOCAL CI: ALL GATES GREEN ===',
      '[2026-08-03T00:00:00] === LOCAL CI: FAILED gates: unit ===',
      '[2026-08-04T00:00:00] === LOCAL CI: FAILED gates: unit ===',
    ].join('\n');
    const summary = summarizeGateStreak(log);
    expect(summary.streak).toBe(2);
    expect(summary.firstFailureAt).toBe('2026-08-03T00:00:00');
  });

  it('reports no streak when the latest run is green', () => {
    const log = `${REAL_LOG}\n[2026-09-09T00:00:00] === LOCAL CI: ALL GATES GREEN ===`;
    const summary = summarizeGateStreak(log);
    expect(summary.streak).toBe(0);
    expect(summary.headline).toBe('all gates green');
  });
});

describe('what is newly red — the signal BUG-22 lost', () => {
  it('names only the gates that were not failing in the previous run', () => {
    // 09-07 was `unit lint secret-scan e2e-green trivy`; 09-08 adds image-smoke.
    const summary = summarizeGateStreak(REAL_LOG);
    expect(summary.newlyRed).toEqual(['image-smoke']);
    expect(summary.alreadyKnown).toEqual(['unit', 'lint', 'secret-scan', 'e2e-green', 'trivy']);
    expect(summary.headline).toContain('NEW: image-smoke');
  });

  it('says so explicitly when nothing changed, so an unchanged alert is readable as unchanged', () => {
    const log = [
      '[2026-09-07T00:00:00] === LOCAL CI: FAILED gates: unit trivy ===',
      '[2026-09-08T00:00:00] === LOCAL CI: FAILED gates: unit trivy ===',
    ].join('\n');
    const summary = summarizeGateStreak(log);
    expect(summary.newlyRed).toEqual([]);
    expect(summary.headline).toBe('no change from last run (night 2)');
  });

  it('reports a gate that went green as fixed, so progress is not invisible', () => {
    const log = [
      '[2026-09-07T00:00:00] === LOCAL CI: FAILED gates: unit secret-scan trivy ===',
      '[2026-09-08T00:00:00] === LOCAL CI: FAILED gates: unit trivy ===',
    ].join('\n');
    const summary = summarizeGateStreak(log);
    expect(summary.newlyGreen).toEqual(['secret-scan']);
    expect(summary.headline).toContain('FIXED: secret-scan');
  });

  it('claims nothing is new when there is no previous run to compare against', () => {
    const summary = summarizeGateStreak('[2026-09-08T00:00:00] === LOCAL CI: FAILED gates: unit trivy ===');
    expect(summary.newlyRed).toEqual([]);
    expect(summary.previous).toBeNull();
    expect(summary.hasHistory).toBe(false);
    expect(summary.headline).toBe('first recorded run (1st night)');
  });

  it('measures newness against the previous run only, so a flapping gate is not new every other night', () => {
    const log = [
      '[2026-09-05T00:00:00] === LOCAL CI: FAILED gates: unit lint ===',
      '[2026-09-06T00:00:00] === LOCAL CI: FAILED gates: unit ===',
      '[2026-09-07T00:00:00] === LOCAL CI: FAILED gates: unit lint ===',
    ].join('\n');
    // lint IS new relative to 09-06 even though it failed on 09-05 — that is the intended
    // reading: it came back. What must not happen is calling `unit` new.
    const summary = summarizeGateStreak(log);
    expect(summary.newlyRed).toEqual(['lint']);
    expect(summary.alreadyKnown).toEqual(['unit']);
  });
});

describe('the alert body', () => {
  it('leads with what changed and states the streak', () => {
    const body = renderAlertBody(summarizeGateStreak(REAL_LOG), {
      sourceRef: 'origin/main',
      sourceSha: 'b84bdfbe',
      posture: 'scheduled-origin-main',
      runLog: 'C:/logs/ci-local-last-run.log',
      host: 'test-host',
    });
    expect(body).toContain('NEWLY RED: image-smoke.');
    expect(body).toContain('Red for 3 consecutive runs (first 2026-09-06T00:46:26).');
    expect(body).toContain('posture=scheduled-origin-main');
  });

  it('never omits the full failing set, so the alert stays self-contained', () => {
    const body = renderAlertBody(summarizeGateStreak(REAL_LOG));
    expect(body).toContain('All failing gates: unit lint secret-scan e2e-green image-smoke trivy.');
  });
});
