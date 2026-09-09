#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - BUG-22 prevention. The nightly gate failed 38 consecutive nights and emailed the same sentence every time, so a NEW failure inside the standing failure was indistinguishable from the standing failure itself. A daily alert that never changes its wording is wallpaper, not a signal. This derives the streak and the newly-red set from the run log so the alert can say what CHANGED.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Two corrections found by running this against the real log. (1) De-duplicate gate names: lines already written are never rewritten, and one corrupted run doubled four of them. (2) A SKIPPED gate is NOT a fixed gate - when an early gate fails, every downstream gate leaves the failing set and read as "FIXED", which would have reported unit/lint/e2e-green/trivy as fixed on a night none of them executed. Claiming a green that was never measured is worse than the flat wording this replaced.
 */

/**
 * Read the local-CI run log and describe how tonight's failure differs from last night's.
 *
 * The log is append-only and already records every run's outcome as a single line, so the
 * history needed here is a parse, not new state to maintain:
 *
 *   [2026-09-08T10:37:48] === LOCAL CI: FAILED gates: unit lint secret-scan e2e-green trivy ===
 *   [2026-09-08T00:13:50] === LOCAL CI: ALL GATES GREEN ===
 *
 * The LAST outcome line is the current run - `ci-local.sh` writes it before it notifies.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const FAILED_LINE = /^\[([^\]]+)\]\s+=== LOCAL CI: FAILED gates:\s*(.*?)\s*===\s*$/;
const GREEN_LINE = /^\[([^\]]+)\]\s+=== LOCAL CI: ALL GATES GREEN ===\s*$/;

/**
 * @description Extract every recorded run outcome, oldest first. Lines that are not run
 * outcomes (per-gate PASS/FAIL, tool output) are ignored, so a log that has grown noisy
 * between runs parses identically to a clean one.
 * @param {string} logText - full contents of ci-local.log; '' is valid and yields [].
 * @returns {Array<{ at: string, failed: string[] }>} one entry per run; `failed` is empty on a green run.
 */
export function parseRunOutcomes(logText) {
  const outcomes = [];
  for (const rawLine of String(logText ?? '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const failed = FAILED_LINE.exec(line);
    if (failed) {
      // A failure line always names at least one gate; guard anyway so a truncated write
      // degrades to "a failure with no gates named" instead of throwing mid-alert.
      //
      // De-duplicate. ci-local.sh collapses duplicates before it writes, but lines already in
      // the log do not get rewritten: the 2026-09-08 run re-executed a block and recorded
      // `unpushed-commits` and three *-skipped names twice. Without this, that night reads as a
      // set difference against a doubled baseline and every later comparison inherits the noise.
      const gates = [...new Set(failed[2].split(/\s+/).filter(Boolean))];
      outcomes.push({ at: failed[1], failed: gates });
      continue;
    }
    const green = GREEN_LINE.exec(line);
    if (green) outcomes.push({ at: green[1], failed: [] });
  }
  return outcomes;
}

/**
 * @description Summarize the current (last) run against the run before it: how many nights
 * the gate has been red without a green, and which gates are red for the FIRST time tonight.
 *
 * "Newly red" is deliberately measured against the immediately preceding run only. Measuring
 * it against the whole streak would mark a gate that flaps on and off as new every other
 * night, which reintroduces exactly the noise this exists to remove.
 *
 * @param {string} logText - full contents of ci-local.log, including the current run's outcome line.
 * @returns {{
 *   streak: number,
 *   firstFailureAt: string | null,
 *   current: string[],
 *   previous: string[] | null,
 *   newlyRed: string[],
 *   alreadyKnown: string[],
 *   newlyGreen: string[],
 *   skipped: string[],
 *   hasHistory: boolean,
 *   headline: string,
 * }} `streak` counts consecutive failed runs ending at the current one (0 when the last run
 * was green or there are no runs). `previous` is null when the current run is the first ever
 * recorded, in which case nothing is claimed to be "new". `skipped` holds the run's skip
 * markers; when it is non-empty a gate leaving the failing set is reported as UNRUN, never
 * as fixed — it was not measured.
 */
export function summarizeGateStreak(logText) {
  const outcomes = parseRunOutcomes(logText);
  const last = outcomes[outcomes.length - 1];

  if (!last || last.failed.length === 0) {
    return {
      streak: 0,
      firstFailureAt: null,
      current: [],
      previous: null,
      newlyRed: [],
      alreadyKnown: [],
      newlyGreen: [],
      skipped: [],
      hasHistory: outcomes.length > 1,
      headline: last ? 'all gates green' : 'no runs recorded',
    };
  }

  // Walk back while runs are still failures - the streak ends at the first green.
  let streak = 0;
  let firstFailureAt = last.at;
  for (let i = outcomes.length - 1; i >= 0 && outcomes[i].failed.length > 0; i -= 1) {
    streak += 1;
    firstFailureAt = outcomes[i].at;
  }

  const prevOutcome = outcomes.length >= 2 ? outcomes[outcomes.length - 2] : null;
  const previous = prevOutcome ? prevOutcome.failed : null;
  const current = last.failed;

  // With no prior run there is no baseline, so nothing may be called new. Claiming every
  // gate is "newly red" on a first run would be a fabricated signal.
  const prevSet = new Set(previous ?? current);
  const currSet = new Set(current);
  const newlyRed = previous === null ? [] : current.filter((gate) => !prevSet.has(gate));
  const alreadyKnown = previous === null ? [...current] : current.filter((gate) => prevSet.has(gate));
  const newlyGreen = previous === null ? [] : previous.filter((gate) => !currSet.has(gate));

  // A gate that DID NOT RUN is not a gate that passed. When an early gate fails, ci-local.sh
  // records skip markers and every downstream gate silently leaves the failing set — which reads
  // as "FIXED" against the previous run. On 2026-09-09 that would have reported `unit lint
  // e2e-green trivy` as fixed on a night none of them executed. Claiming a green that was never
  // measured is worse than the flat wording this replaced, so the skip markers suppress the claim.
  const skipped = current.filter((gate) => gate.endsWith('-skipped') || gate === 'node-gates-skipped');
  const nights = streak === 1 ? '1st night' : `night ${streak}`;
  let headline;
  if (newlyRed.length) headline = `NEW: ${newlyRed.join(' ')} (${nights})`;
  else if (newlyGreen.length && !skipped.length) headline = `no new failures; FIXED: ${newlyGreen.join(' ')} (${nights})`;
  else if (newlyGreen.length) headline = `no new failures; ${newlyGreen.length} gate(s) DID NOT RUN (${nights})`;
  else if (previous === null) headline = `first recorded run (${nights})`;
  else headline = `no change from last run (${nights})`;

  return {
    streak,
    firstFailureAt,
    current,
    previous,
    newlyRed,
    alreadyKnown,
    newlyGreen,
    skipped,
    hasHistory: previous !== null,
    headline,
  };
}

/**
 * @description Render the alert body. Kept separate from the summary so the wording can change
 * without touching the streak arithmetic the guard spec pins.
 * @param {ReturnType<typeof summarizeGateStreak>} summary - output of summarizeGateStreak.
 * @param {{ sourceRef?: string, sourceSha?: string, posture?: string, runLog?: string, host?: string }} [ctx] - run provenance for the body.
 * @returns {string} single-paragraph alert body.
 */
export function renderAlertBody(summary, ctx = {}) {
  const parts = [];
  if (summary.newlyRed.length) parts.push(`NEWLY RED: ${summary.newlyRed.join(' ')}.`);
  if (summary.newlyGreen.length) {
    // Same rule as the headline: only call it fixed if the run got far enough to measure it.
    parts.push(summary.skipped?.length
      ? `LEFT THE FAILING SET BUT DID NOT RUN (this run skipped gates — NOT proof they pass):`
        + ` ${summary.newlyGreen.join(' ')}.`
      : `FIXED SINCE LAST RUN: ${summary.newlyGreen.join(' ')}.`);
  }
  parts.push(`Already known: ${summary.alreadyKnown.join(' ') || 'none'}.`);
  if (summary.streak > 1) {
    parts.push(`Red for ${summary.streak} consecutive runs (first ${summary.firstFailureAt}).`);
  }
  parts.push(`All failing gates: ${summary.current.join(' ')}.`);
  const prov = [ctx.sourceRef, ctx.sourceSha].filter(Boolean).join(' ');
  if (prov || ctx.posture) parts.push(`Source ${prov || 'unknown'}; posture=${ctx.posture ?? 'unknown'}.`);
  if (ctx.runLog) parts.push(`Full log: ${ctx.runLog}${ctx.host ? ` on ${ctx.host}` : ''}.`);
  return parts.join(' ');
}

/**
 * @description CLI: print the alert subject on line 1 and the body on line 2 so the shell can
 * read both with one call and no temp file. Exits 0 even when the log is unreadable - the
 * notifier must still send SOMETHING when its own history is missing.
 */
function main() {
  const [logPath, sourceRef, sourceSha, posture, runLog, host] = process.argv.slice(2);
  let logText = '';
  try {
    logText = readFileSync(logPath, 'utf8');
  } catch {
    logText = '';
  }
  const summary = summarizeGateStreak(logText);
  const subject = summary.streak
    ? `OSHAL LOCAL CI FAILED - ${summary.headline}`
    : 'OSHAL LOCAL CI FAILED';
  process.stdout.write(`${subject}\n`);
  process.stdout.write(`${renderAlertBody(summary, { sourceRef, sourceSha, posture, runLog, host })}\n`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
