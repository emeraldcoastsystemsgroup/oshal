#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - BUG-22 prevention. The nightly gate failed 38 consecutive nights and emailed the same sentence every time, so a NEW failure inside the standing failure was indistinguishable from the standing failure itself. A daily alert that never changes its wording is wallpaper, not a signal. This derives the streak and the newly-red set from the run log so the alert can say what CHANGED.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Two corrections found by running this against the real log. (1) De-duplicate gate names: lines already written are never rewritten, and one corrupted run doubled four of them. (2) A SKIPPED gate is NOT a fixed gate - when an early gate fails, every downstream gate leaves the failing set and read as "FIXED", which would have reported unit/lint/e2e-green/trivy as fixed on a night none of them executed. Claiming a green that was never measured is worse than the flat wording this replaced.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The mirror of entry 2, found in three real alerts: a SKIPPED gate also must not make a long-standing failure look NEW. When a run skips gates they leave its failing set, so the next run diffs against a baseline that never measured them - on 2026-09-13 the alert announced "NEW: store-compatibility unit lint security-policy e2e-green trivy" when only security-policy was new and the rest had been red since July. A false NEW is worse than the flat wording BUG-22 replaced: it trains you to ignore the word. The baseline is now the most recent prior run with NO skip markers (a green run qualifies), and the body names it when intervening runs were stepped over.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Read the RESOURCE-EXHAUSTED section ci-local.sh now writes (`FAILED gates: a; RESOURCE-EXHAUSTED gates: b`, or either alone). Without it a starved-only run had no outcome line this parser recognised, so the alert would have described the PREVIOUS night. Exhausted gates were not judged: they keep the streak red, a run carrying them is never a baseline, they are never NEW and never FIXED, and the subject reads RESOURCE-EXHAUSTED rather than FAILED when nothing else failed - an out-of-memory night must not be read as a regression.
 */

/**
 * Read the local-CI run log and describe how tonight's failure differs from last night's.
 *
 * The log is append-only and already records every run's outcome as a single line, so the
 * history needed here is a parse, not new state to maintain:
 *
 *   [2026-09-08T10:37:48] === LOCAL CI: FAILED gates: unit lint secret-scan e2e-green trivy ===
 *   [2026-09-08T00:13:50] === LOCAL CI: ALL GATES GREEN ===
 *   [2026-10-02T01:10:00] === LOCAL CI: FAILED gates: lint; RESOURCE-EXHAUSTED gates: unit ===
 *   [2026-10-03T01:10:00] === LOCAL CI: RESOURCE-EXHAUSTED gates: head-src node-gates-skipped ===
 *
 * The LAST outcome line is the current run - `ci-local.sh` writes it before it notifies.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// One run-outcome line: code failures and gates the host could not judge are separate sections,
// joined by "; " when both are present. Lines written before the second section existed parse
// exactly as they always did.
const OUTCOME_LINE = /^\[([^\]]+)\]\s+=== LOCAL CI: ((?:FAILED|RESOURCE-EXHAUSTED) gates:.*?)\s*===\s*$/;
const OUTCOME_SECTION = /^(FAILED|RESOURCE-EXHAUSTED) gates:\s*(.*)$/;
const GREEN_LINE = /^\[([^\]]+)\]\s+=== LOCAL CI: ALL GATES GREEN ===\s*$/;

/**
 * @description A gate name that records a gate which DID NOT RUN, rather than one that failed.
 * `ci-local.sh` appends these when an earlier gate fails: `node-gates-skipped` for the whole
 * typecheck/unit/lint/connectors/manifests/kernel-skills/e2e block, and `<gate>-skipped` for the
 * image chain. They are the only signal in a run-outcome line that the run did not measure
 * everything, which is what makes them load-bearing for both "fixed" and "new".
 * @param {string} gate - one gate name from a run-outcome line.
 * @returns {boolean} true when the name marks an unrun gate.
 */
function isSkipMarker(gate) {
  return gate.endsWith('-skipped') || gate === 'node-gates-skipped';
}

/**
 * @description Whether a run was anything but green: a code failure OR a gate the host could
 * not judge. A starved night is not a green night, so it keeps the streak going.
 * @param {{ failed: string[], exhausted: string[] }} run - one parsed outcome.
 * @returns {boolean} true when the run had a failed or a resource-exhausted gate.
 */
function isRed(run) {
  return run.failed.length > 0 || run.exhausted.length > 0;
}

/**
 * @description Whether a run measured every gate and can serve as the baseline for "new": no skip
 * marker, and no resource-exhausted gate (those were not judged either).
 * @param {{ failed: string[], exhausted: string[] }} run - one parsed outcome.
 * @returns {boolean} true when nothing in the run went unmeasured.
 */
function measuredEverything(run) {
  return !run.failed.some(isSkipMarker) && run.exhausted.length === 0;
}

/**
 * @description Split one gate list, de-duplicated. ci-local.sh collapses duplicates before it
 * writes, but lines already in the log are never rewritten: the 2026-09-08 run re-executed a block
 * and recorded `unpushed-commits` and three *-skipped names twice. Without this, that night reads
 * as a set difference against a doubled baseline and every later comparison inherits the noise.
 * @param {string} text - the space-separated gate names of one outcome section.
 * @returns {string[]} the names, first occurrence order.
 */
function gateList(text) {
  return [...new Set(text.split(/\s+/).filter(Boolean))];
}

/**
 * @description Extract every recorded run outcome, oldest first. Lines that are not run
 * outcomes (per-gate PASS/FAIL, tool output) are ignored, so a log that has grown noisy
 * between runs parses identically to a clean one.
 * @param {string} logText - full contents of ci-local.log; '' is valid and yields [].
 * @returns {Array<{ at: string, failed: string[], exhausted: string[] }>} one entry per run;
 * `failed` holds code failures, `exhausted` the gates the host could not judge; both are empty on
 * a green run.
 */
export function parseRunOutcomes(logText) {
  const outcomes = [];
  for (const rawLine of String(logText ?? '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const outcome = OUTCOME_LINE.exec(line);
    if (outcome) {
      // A red line always names at least one gate; guard anyway so a truncated write degrades to
      // "a failure with no gates named" instead of throwing mid-alert.
      const run = { at: outcome[1], failed: [], exhausted: [] };
      for (const section of outcome[2].split(/;\s*/)) {
        const parts = OUTCOME_SECTION.exec(section.trim());
        if (!parts) continue;
        if (parts[1] === 'FAILED') run.failed = gateList(parts[2]);
        else run.exhausted = gateList(parts[2]);
      }
      outcomes.push(run);
      continue;
    }
    const green = GREEN_LINE.exec(line);
    if (green) outcomes.push({ at: green[1], failed: [], exhausted: [] });
  }
  return outcomes;
}

/**
 * @description The summary of a run that was green (or of an empty log): no streak, nothing new,
 * nothing known. Kept out of summarizeGateStreak so the arithmetic there stays readable.
 * @param {number} runCount - how many run outcomes the log holds.
 * @param {boolean} hasLast - whether there is a current run at all.
 * @returns {ReturnType<typeof summarizeGateStreak>} the green summary.
 */
function greenSummary(runCount, hasLast) {
  return {
    streak: 0,
    firstFailureAt: null,
    current: [],
    exhausted: [],
    previous: null,
    newlyRed: [],
    alreadyKnown: [],
    newlyGreen: [],
    skipped: [],
    baselineAt: null,
    baselineSkippedRuns: 0,
    hasHistory: runCount > 1,
    headline: hasLast ? 'all gates green' : 'no runs recorded',
  };
}

/**
 * @description The one-line headline the alert subject leads with: what changed tonight, then
 * which gates the host could not judge. A skipped chain suppresses "FIXED" (it was not measured).
 * @param {{ streak: number, newlyRed: string[], newlyGreen: string[], unmeasuredChain: boolean,
 *   current: string[], previous: string[] | null, exhausted: string[] }} s - the computed sets.
 * @returns {string} the headline.
 */
function headlineFor(s) {
  const nights = s.streak === 1 ? '1st night' : `night ${s.streak}`;
  let headline;
  if (s.newlyRed.length) headline = `NEW: ${s.newlyRed.join(' ')} (${nights})`;
  else if (s.newlyGreen.length && !s.unmeasuredChain) headline = `no new failures; FIXED: ${s.newlyGreen.join(' ')} (${nights})`;
  else if (s.newlyGreen.length) headline = `no new failures; ${s.newlyGreen.length} gate(s) DID NOT RUN (${nights})`;
  else if (s.current.length === 0) headline = `no code failures (${nights})`;
  else if (s.previous === null) headline = `first recorded run (${nights})`;
  else headline = `no change from last run (${nights})`;
  return s.exhausted.length ? `${headline}; host saturated, not judged: ${s.exhausted.join(' ')}` : headline;
}

/**
 * @description Summarize the current (last) run against the run before it: how many nights
 * the gate has been red without a green, and which gates are red for the FIRST time tonight.
 *
 * "Newly red" is measured against ONE baseline run, never against the whole streak — measuring
 * across the streak would mark a gate that flaps on and off as new every other night, which
 * reintroduces exactly the noise this exists to remove.
 *
 * That baseline is the most recent prior run that SKIPPED NOTHING, which is usually but not
 * always the immediately preceding run. A run that skipped gates never measured them, so it
 * cannot answer "was this failing before?" — diffing against it manufactures false NEWs.
 *
 * Resource-exhausted gates were not judged at all. They keep the streak red, a run that carries
 * them is never the baseline, and they are never NEW and never FIXED: the host, not the code,
 * decided their result.
 *
 * @param {string} logText - full contents of ci-local.log, including the current run's outcome line.
 * @returns {{
 *   streak: number,
 *   firstFailureAt: string | null,
 *   current: string[],
 *   exhausted: string[],
 *   previous: string[] | null,
 *   newlyRed: string[],
 *   alreadyKnown: string[],
 *   newlyGreen: string[],
 *   skipped: string[],
 *   baselineAt: string | null,
 *   baselineSkippedRuns: number,
 *   hasHistory: boolean,
 *   headline: string,
 * }} `streak` counts consecutive red runs ending at the current one (0 when the last run
 * was green or there are no runs). `current` holds tonight's code failures and `exhausted` the
 * gates the host could not judge. `previous` is the last run that MEASURED everything — not
 * necessarily the immediately preceding one — and is null when no such run exists, in which
 * case nothing is claimed to be "new". `baselineAt` timestamps that run and
 * `baselineSkippedRuns` counts how many skip-bearing runs were stepped over to reach it.
 * `skipped` holds the CURRENT run's skip markers; when it is non-empty a gate leaving the
 * failing set is reported as UNRUN, never as fixed — it was not measured.
 */
export function summarizeGateStreak(logText) {
  const outcomes = parseRunOutcomes(logText);
  const last = outcomes[outcomes.length - 1];

  if (!last || !isRed(last)) return greenSummary(outcomes.length, Boolean(last));

  // Walk back while runs are still red - the streak ends at the first green.
  let streak = 0;
  let firstFailureAt = last.at;
  for (let i = outcomes.length - 1; i >= 0 && isRed(outcomes[i]); i -= 1) {
    streak += 1;
    firstFailureAt = outcomes[i].at;
  }

  // The baseline for "new" must be a run that actually MEASURED the gates. When a run skips
  // gates, they silently leave its failing set, so the next run diffs against a set that never
  // contained them and every long-standing failure reads as brand new. Real example: 2026-09-12
  // failed at head-src and skipped the node gates; on 2026-09-13 the alert announced
  // "NEW: store-compatibility unit lint security-policy e2e-green trivy" when only
  // security-policy was new — unit/lint/e2e-green/trivy had been red since July. A false NEW is
  // worse than the flat wording BUG-22 replaced: it trains you to ignore the word NEW.
  //
  // So walk back to the most recent prior run with NO skip markers. A green run qualifies (it
  // measured everything and nothing failed). If no such run exists there is no honest baseline,
  // and nothing is claimed to be new.
  // A run with resource-exhausted gates did not measure them either, so it is stepped over too.
  const priorOutcomes = outcomes.slice(0, -1);
  const prevOutcome = [...priorOutcomes].reverse().find(measuredEverything) ?? null;
  const previous = prevOutcome ? prevOutcome.failed : null;
  const baselineAt = prevOutcome ? prevOutcome.at : null;
  const baselineSkippedRuns = prevOutcome
    ? priorOutcomes.length - 1 - priorOutcomes.lastIndexOf(prevOutcome)
    : priorOutcomes.length;
  const current = last.failed;
  const exhausted = last.exhausted;

  // With no prior run there is no baseline, so nothing may be called new. Claiming every
  // gate is "newly red" on a first run would be a fabricated signal.
  const prevSet = new Set(previous ?? current);
  const currSet = new Set(current);
  const exhaustedSet = new Set(exhausted);
  const newlyRed = previous === null ? [] : current.filter((gate) => !prevSet.has(gate));
  const alreadyKnown = previous === null ? [...current] : current.filter((gate) => prevSet.has(gate));
  // A gate the host could not judge tonight left the failing set unmeasured: never "fixed".
  const newlyGreen = previous === null
    ? []
    : previous.filter((gate) => !currSet.has(gate) && !exhaustedSet.has(gate));

  // A gate that DID NOT RUN is not a gate that passed. When an early gate fails, ci-local.sh
  // records skip markers and every downstream gate silently leaves the failing set — which reads
  // as "FIXED" against the previous run. On 2026-09-09 that would have reported `unit lint
  // e2e-green trivy` as fixed on a night none of them executed. Claiming a green that was never
  // measured is worse than the flat wording this replaced, so the skip markers suppress the claim -
  // including the ones a starved first link records among the exhausted gates.
  const skipped = current.filter(isSkipMarker);
  const unmeasuredChain = skipped.length > 0 || exhausted.some(isSkipMarker);
  const headline = headlineFor({ streak, newlyRed, newlyGreen, unmeasuredChain, current, previous, exhausted });

  return {
    streak,
    firstFailureAt,
    current,
    exhausted,
    previous,
    newlyRed,
    alreadyKnown,
    newlyGreen,
    skipped,
    baselineAt,
    baselineSkippedRuns,
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
  const exhausted = summary.exhausted ?? [];
  if (summary.newlyRed.length) parts.push(`NEWLY RED: ${summary.newlyRed.join(' ')}.`);
  if (exhausted.length) {
    parts.push(`RESOURCE-EXHAUSTED, NOT JUDGED (the host was below its free-memory floor, so these`
      + ` are neither a pass nor a code failure): ${exhausted.join(' ')}.`);
  }
  if (summary.newlyGreen.length) {
    // Same rule as the headline: only call it fixed if the run got far enough to measure it.
    parts.push(summary.skipped?.length || exhausted.some(isSkipMarker)
      ? `LEFT THE FAILING SET BUT DID NOT RUN (this run skipped gates — NOT proof they pass):`
        + ` ${summary.newlyGreen.join(' ')}.`
      : `FIXED SINCE LAST RUN: ${summary.newlyGreen.join(' ')}.`);
  }
  parts.push(`Already known: ${summary.alreadyKnown.join(' ') || 'none'}.`);
  // Say what "new" was measured against. Silently comparing to an older run would make the
  // NEW/already-known split unauditable from the alert alone.
  if (summary.baselineSkippedRuns > 0) {
    const runs = summary.baselineSkippedRuns === 1 ? 'run' : 'runs';
    parts.push(`Compared against ${summary.baselineAt} — the last run that measured every gate;`
      + ` ${summary.baselineSkippedRuns} intervening ${runs} skipped gates and cannot say what is new.`);
  }
  if (summary.streak > 1) {
    parts.push(`Red for ${summary.streak} consecutive runs (first ${summary.firstFailureAt}).`);
  }
  parts.push(`All failing gates: ${summary.current.join(' ') || 'none'}.`);
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
  // A night whose only problem is a starved host says so in the subject, not "FAILED".
  const kind = summary.current.length === 0 && summary.exhausted.length > 0 ? 'RESOURCE-EXHAUSTED' : 'FAILED';
  const subject = summary.streak
    ? `OSHAL LOCAL CI ${kind} - ${summary.headline}`
    : 'OSHAL LOCAL CI FAILED';
  process.stdout.write(`${subject}\n`);
  process.stdout.write(`${renderAlertBody(summary, { sourceRef, sourceSha, posture, runLog, host })}\n`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main();
