#!/usr/bin/env node
/*
 * Eval Wall — history backfill (optional) — ADR-063 §eval-wall.
 * -----------------------------------------------------------------------------
 * Parses the existing docs/test-lab-reports/<date>.md history and inserts one eval_runs row per
 * scenario so the green wall is not empty on first view. The live nightly loop is the real source
 * of truth going forward; this just bootstraps the wall from the reports already committed.
 *
 * Parsing is DEFENSIVE: report formatting drifts, so we read whatever we can (score, state, scenario,
 * heuristic/judge split from the Detail line) and store NULL for anything we cannot find — never a
 * fabricated number. Idempotent: a row is keyed by (scenario + run_at day) and skipped if present.
 *
 * Usage:  node scripts/eval-wall-seed.mjs
 * Env:    DATABASE_URL (or POSTGRES_URL). node-postgres reads PG* env too.
 */
'use strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_DIR = resolve(ROOT, 'docs', 'test-lab-reports');

const DDL = `
  CREATE TABLE IF NOT EXISTS eval_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    scenario TEXT NOT NULL,
    state VARCHAR(16) NOT NULL DEFAULT 'fail',
    heuristic_score INT,
    judge_score INT,
    final_score INT,
    passed BOOLEAN NOT NULL DEFAULT FALSE,
    latency_ms INT,
    retries INT,
    input_tokens INT,
    output_tokens INT,
    cost_usd DOUBLE PRECISION,
    security_findings INT,
    notes TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_eval_runs_run_at ON eval_runs (run_at DESC);
`;

/** Normalize a free-text result word to one of the wall states. */
function toState(word) {
  const w = String(word || '').toLowerCase();
  if (w.includes('pass')) return 'pass';
  if (w.includes('degrad')) return 'degraded';
  if (w.includes('gap')) return 'gap';
  return 'fail';
}

function intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse one report markdown file into eval-run records. Returns [] when nothing parseable is found.
 * Primary signal: the result table rows `| <scenario> | <RESULT> | <score>/100 ... | ... |`.
 * Secondary signal: the `Detail: score X (heuristic H, judge J)` lines fill in the split.
 */
function parseReport(text, runAtIso) {
  const runs = [];
  const lines = text.split(/\r?\n/);

  // First pass: table rows. A data row has >= 4 pipe-delimited cells and the 2nd cell is a RESULT.
  for (const line of lines) {
    if (!line.includes('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    // Drop the leading/trailing empty cells produced by surrounding pipes.
    const cols = cells.filter((c, i) => !(i === 0 && c === '') && !(i === cells.length - 1 && c === ''));
    if (cols.length < 4) continue;
    const scenario = cols[0];
    const resultWord = cols[1];
    // Skip the header row and the |---|---| separator.
    if (/^scenario$/i.test(scenario) || /^-+$/.test(scenario)) continue;
    if (!/(pass|fail|degrad|gap)/i.test(resultWord)) continue;
    const scoreMatch = (cols[2] || '').match(/(\d+)\s*\/\s*100/);
    const finalScore = scoreMatch ? intOrNull(scoreMatch[1]) : null;
    const state = toState(resultWord);
    runs.push({
      scenario,
      state,
      finalScore,
      heuristicScore: null,
      judgeScore: null,
      passed: state === 'pass',
      runAt: runAtIso,
    });
  }

  // Second pass: enrich with heuristic/judge from any `score X (heuristic H, judge J)` text.
  for (const line of lines) {
    const m = line.match(/score\s+(\d+)\s*\(heuristic\s+(\d+)(?:,\s*judge\s+(\d+))?\)/i);
    if (!m) continue;
    const finalScore = intOrNull(m[1]);
    const heuristicScore = intOrNull(m[2]);
    const judgeScore = intOrNull(m[3]);
    // Attach to the run whose finalScore matches (best-effort) or the last run.
    const target = runs.find((r) => r.finalScore === finalScore && r.heuristicScore === null) || runs[runs.length - 1];
    if (target) {
      if (target.finalScore === null) target.finalScore = finalScore;
      target.heuristicScore = heuristicScore;
      target.judgeScore = judgeScore;
    }
  }

  return runs;
}

async function main() {
  if (!existsSync(REPORT_DIR)) {
    console.error(`[eval-wall-seed] no report dir at ${REPORT_DIR} — nothing to seed.`);
    return;
  }
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  const pool = new Pool(connectionString ? { connectionString } : {});

  try {
    await pool.query(DDL);

    // Only dated reports (YYYY-MM-DD.md); skip latest.md / baseline.json to avoid double-counting.
    const files = readdirSync(REPORT_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
    let inserted = 0, skipped = 0;

    for (const f of files) {
      const dateSlug = basename(f, '.md');
      const runAtIso = `${dateSlug}T06:00:00.000Z`; // reports land in the morning; midpoint is fine
      let text = '';
      try { text = readFileSync(resolve(REPORT_DIR, f), 'utf8'); } catch { continue; }

      const runs = parseReport(text, runAtIso);
      for (const r of runs) {
        // Idempotent: skip if a row already exists for this scenario on this day.
        const exists = await pool.query(
          `SELECT 1 FROM eval_runs WHERE scenario = $1 AND date_trunc('day', run_at) = date_trunc('day', $2::timestamptz) LIMIT 1`,
          [r.scenario, runAtIso],
        );
        if (exists.rowCount > 0) { skipped++; continue; }

        await pool.query(
          `INSERT INTO eval_runs
             (run_at, scenario, state, heuristic_score, judge_score, final_score, passed, notes)
           VALUES ($1::timestamptz, $2, $3, $4, $5, $6, $7, $8)`,
          [runAtIso, r.scenario, r.state, r.heuristicScore, r.judgeScore, r.finalScore, r.passed,
           `seeded from ${f}`],
        );
        inserted++;
      }
    }

    console.log(`[eval-wall-seed] done: ${inserted} inserted, ${skipped} already present (from ${files.length} report file(s)).`);
  } catch (err) {
    console.error('[eval-wall-seed] failed:', err && err.message ? err.message : err);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
