#!/usr/bin/env node
/**
 * Headless local evidence refresh — the self-healing companion to nightly-refresh.mjs.
 *
 * WHY THIS EXISTS: the competitive scoreboard caps every category at 75 once its
 * `Proof-Tier: live` evidence is older than the freshness window (48h). The original
 * nightly step (`npm run test:live`) regenerates that evidence by attaching over CDP to
 * The operator's own foreground, signed-in Chrome — which cannot run unattended (cron,
 * CI, headless box). So the board decayed to the floor every 48h with no way to self-heal.
 *
 * This runner instead executes every headless `scripts/evidence/prove-*-live.ts` generator.
 * Each generator exercises real route code (loopback-mounted Express modules) or the live
 * stack (health, RLS via `npm run verify:rls`, pg backup/restore) and writes a dated
 * `Proof-Tier: live` doc ONLY on genuine pass. No browser, no operator interaction.
 *
 * A single generator failure is reported but does not abort the rest, so one flaky proof
 * never blocks the others or the score regeneration.
 *
 * Usage:
 *   node scripts/evidence/refresh-local.mjs             # run every generator, then regen scores
 *   node scripts/evidence/refresh-local.mjs --dry-run   # list the generators, run nothing
 *   node scripts/evidence/refresh-local.mjs --no-score  # generators only, skip score regen
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const skipScore = args.has('--no-score');

const log = (msg) => process.stdout.write(`[refresh-local] ${msg}\n`);

/** Every headless generator: scripts/evidence/prove-*-live.ts, run in a stable order. */
const generators = readdirSync(here)
  .filter((name) => /^prove-.*-live\.ts$/.test(name))
  .sort();

if (!generators.length) {
  log('no prove-*-live.ts generators found — nothing to refresh');
  process.exit(1);
}

log(`${dryRun ? 'DRY RUN — ' : ''}${generators.length} headless generators discovered`);

const tsNode = ['ts-node', '-r', 'tsconfig-paths/register', '--transpile-only'];
const results = [];
for (const gen of generators) {
  const rel = `scripts/evidence/${gen}`;
  if (dryRun) {
    log(`would run: ${rel}`);
    results.push({ gen, status: 'planned' });
    continue;
  }
  log(`run: ${rel}`);
  const out = spawnSync('npx', [...tsNode, rel], { cwd: repoRoot, stdio: 'inherit', shell: true });
  const ok = out.status === 0;
  log(`${ok ? 'ok' : 'FAILED'}: ${gen} (exit ${out.status})`);
  results.push({ gen, status: ok ? 'ok' : 'failed', exit: out.status });
}

if (!dryRun && !skipScore) {
  for (const step of ['evidence:competitive', 'evidence:procurement-saas']) {
    log(`run: npm run ${step}`);
    const out = spawnSync('npm', ['run', step], { cwd: repoRoot, stdio: 'inherit', shell: true });
    log(`${out.status === 0 ? 'ok' : 'FAILED'}: ${step} (exit ${out.status})`);
    results.push({ gen: step, status: out.status === 0 ? 'ok' : 'failed', exit: out.status });
  }
}

const failed = results.filter((r) => r.status === 'failed');
log(`done: ${results.filter((r) => r.status === 'ok').length}/${results.length} ok`);
if (failed.length) log(`failed: ${failed.map((r) => r.gen).join(', ')}`);
// Exit non-zero only if a score-regeneration step failed; individual flaky proofs do not
// fail the whole run (the score artifact will honestly reflect any missing/stale proof).
const hardFail = failed.some((r) => r.gen.startsWith('evidence:'));
process.exit(hardFail ? 1 : 0);
