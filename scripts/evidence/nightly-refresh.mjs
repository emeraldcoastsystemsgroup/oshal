#!/usr/bin/env node
/**
 * Nightly evidence refresh — keeps the competitive scoreboard from self-expiring.
 *
 * The 13/15-category harness caps any category at 75 when its `Proof-Tier: live` evidence
 * is older than the freshness window (COMPETITIVE_EVIDENCE_MAX_LIVE_AGE_HOURS, default 48h).
 * Run nightly, this re-runs the live proofs and regenerates the score + readiness artifacts
 * so categories whose capability is already built stay at their real score instead of
 * decaying to the floor between sessions.
 *
 * Steps (in order; a failed step is reported but does not abort the rest, so a flaky live
 * spec never blocks the score regeneration):
 *   1. npm run evidence:refresh-local — run every unattended prove-*-live.ts generator to
 *      regenerate dated Proof-Tier: live evidence. Most are process-only; the own-data proof
 *      launches isolated headless Playwright against app-role Postgres. None needs operator input.
 *      NOTE: this replaced `npm run test:live` as the default because test:live attaches
 *      over CDP to the operator's foreground signed-in Chrome and cannot run unattended,
 *      so a cron/CI run left the whole board decaying to the 75-floor. Pass --cdp to ALSO
 *      run the CDP browser proofs when the operator's Chrome is available.
 *   2. npm run evidence:competitive   — regenerate the 15-category score artifact
 *   3. npm run evidence:procurement-saas — regenerate the procurement/SaaS readiness artifact
 *
 * (refresh-local already regenerates the score itself; nightly re-runs it after the optional
 * CDP step so the final artifact reflects every proof source.)
 *
 * Usage:
 *   node scripts/evidence/nightly-refresh.mjs            # headless generators + score (cron-safe)
 *   node scripts/evidence/nightly-refresh.mjs --cdp      # ALSO run the CDP browser proofs
 *   node scripts/evidence/nightly-refresh.mjs --dry-run  # print the plan, run nothing
 *   node scripts/evidence/nightly-refresh.mjs --skip-live # score-only (no live stack needed)
 *
 * Schedule it (do not bake into the image): Windows Task Scheduler or a platform cron that
 * invokes `npm run evidence:nightly` once per day. Wire COMPETITIVE_EVIDENCE_MAX_LIVE_AGE_HOURS
 * to a hair over the cadence (e.g. 26h for a daily run) so a single missed run does not flip
 * everything red.
 *
 * Fail-loud guard (BUG-4): the run exits non-zero and prints `ALARM:` lines when the board
 * actually decayed — a failed headless proof run (the usual decay cause), a board average below
 * EVIDENCE_MIN_AVG (default 90), or any category missing live proof (EVIDENCE_MAX_MISSING_PROOF,
 * default 0). A flaky CDP browser proof alone stays a warning. This replaced the old
 * "exit 0 whenever only a proof step failed" behavior that let the scoreboard decay silently.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const skipLive = args.has('--skip-live');
const withCdp = args.has('--cdp');

const steps = [
  { name: 'unattended live proofs', cmd: 'npm', args: ['run', 'evidence:refresh-local', '--', '--no-score'], skip: skipLive },
  { name: 'cdp browser proofs', cmd: 'npm', args: ['run', 'test:live'], skip: skipLive || !withCdp },
  { name: 'competitive score', cmd: 'npm', args: ['run', 'evidence:competitive'], skip: false },
  { name: 'procurement/saas readiness', cmd: 'npm', args: ['run', 'evidence:procurement-saas'], skip: false },
];

const log = (msg) => process.stdout.write(`[nightly-refresh] ${msg}\n`);

log(dryRun ? 'DRY RUN — nothing will execute' : 'starting nightly evidence refresh');

const results = [];
for (const step of steps) {
  const display = `${step.cmd} ${step.args.join(' ')}`;
  if (step.skip) {
    log(`skip: ${step.name} (${display})`);
    results.push({ name: step.name, status: 'skipped' });
    continue;
  }
  if (dryRun) {
    log(`would run: ${step.name} -> ${display}`);
    results.push({ name: step.name, status: 'planned' });
    continue;
  }
  log(`run: ${step.name} -> ${display}`);
  const out = spawnSync(step.cmd, step.args, { stdio: 'inherit', shell: true });
  const ok = out.status === 0;
  log(`${ok ? 'ok' : 'FAILED'}: ${step.name} (exit ${out.status})`);
  results.push({ name: step.name, status: ok ? 'ok' : 'failed', exit: out.status });
}

const failed = results.filter((r) => r.status === 'failed');
log(`done: ${results.map((r) => `${r.name}=${r.status}`).join(', ')}`);

// --- Fail-loud guard (BUG-4): silent scorecard decay must never exit 0. ---
// The old code exited 0 whenever only a *proof* step failed. But a failed HEADLESS proof run
// is the usual decay cause (Postgres/Chroma down -> categories stale-capped at the 75 floor),
// so it is a hard failure. A flaky CDP *browser* proof is the one that rightly stayed tolerated.
// Beyond step outcomes, re-read the freshly regenerated board and alarm if it actually decayed,
// so a "successful" run that produced stale-capped scores still surfaces loudly.
const minAvg = Number(process.env.EVIDENCE_MIN_AVG ?? 90);
const maxMissingProof = Number(process.env.EVIDENCE_MAX_MISSING_PROOF ?? 0);
const statusOf = (name) => results.find((r) => r.name === name)?.status;
const alarms = [];

if (statusOf('competitive score') === 'failed') alarms.push('competitive score step failed — board not regenerated');
if (statusOf('procurement/saas readiness') === 'failed') alarms.push('procurement/saas readiness step failed');
if (statusOf('unattended live proofs') === 'failed') {
  alarms.push('unattended live proofs FAILED — categories will decay to the 75 floor (check Postgres/Chroma/Playwright)');
}

if (!dryRun) {
  try {
    const evidenceDir = join(process.cwd(), 'docs', 'evidence');
    const boards = readdirSync(evidenceDir)
      .filter((f) => /^competitive-readiness-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort();
    const latest = boards[boards.length - 1];
    if (!latest) {
      alarms.push('no competitive-readiness board found to verify');
    } else {
      const board = JSON.parse(readFileSync(join(evidenceDir, latest), 'utf8'));
      const avg = board?.totals?.averageScore;
      const missing = board?.totals?.missingLiveProof;
      log(`board: ${latest} avg=${avg} missingLiveProof=${missing}`);
      if (typeof avg === 'number' && avg < minAvg) {
        alarms.push(`board average ${avg} is below floor ${minAvg} (${latest})`);
      }
      if (typeof missing === 'number' && missing > maxMissingProof) {
        alarms.push(`${missing} categor${missing === 1 ? 'y is' : 'ies are'} missing live proof (> ${maxMissingProof}) — decayed to the floor`);
      }
    }
  } catch (err) {
    alarms.push(`could not read the regenerated board: ${err.message}`);
  }
}

const cdpOnlyFailed = failed.length > 0 && failed.every((r) => r.name === 'cdp browser proofs');
if (cdpOnlyFailed) log('warn: cdp browser proofs failed (flaky attach) — not treated as decay');

if (alarms.length > 0) {
  for (const a of alarms) log(`ALARM: ${a}`);
  log('nightly refresh FAILED loud — do not publish this board; fix the cause and re-run.');
  process.exit(1);
}
log('nightly refresh healthy — board fresh, no decay.');
process.exit(0);
