/**
 * Strategy Lab store (ADR-092) — Postgres persistence for strategy variations, their
 * backtest/forward/regression runs (metrics + full equity curves), and the forward-walk state.
 * Schema self-heals on first use (ensureLabSchema), mirroring migration
 * scripts/migrations/072-trading-strategy-lab.sql — the same pattern as ensureTradingSchema.
 * All queries are user_sub-scoped in SQL on top of the RLS policies (defense in depth).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — strategies CRUD, run persistence with curves, baseline pinning, forward-state save/load with appended equity points.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | trading_strategy_notes (ADR-095): dated per-strategy notes / lessons-learned / decision journal + CRUD, so every tested configuration carries its narrative (the operator ask: "notes and lessons learned on each"). Table added to ensureLabSchema, mirrored in migration 073.
 *
 * @module trading-strategy-lab-store
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import type { EquityPoint, LabMetrics, StrategyConfig, WalkState } from './trading-strategy-lab-sim';

const logger = createChildLogger({ module: 'trading-strategy-lab-store' });

/** A saved strategy variation row. */
export interface StrategyRow {
  id: string;
  name: string;
  description: string;
  config: StrategyConfig;
  status: 'candidate' | 'armed' | 'retired';
  baselineRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A persisted run row (curve omitted from lists — fetch via getRun). */
export interface RunRow {
  id: string;
  strategyId: string;
  kind: 'backtest' | 'forward' | 'regression';
  status: 'ok' | 'drifted' | 'failed';
  feed: string;
  gitSha: string;
  windowStart: string | null;
  windowEnd: string | null;
  bars: number;
  configSnapshot: StrategyConfig;
  metrics: LabMetrics & Record<string, unknown>;
  error: string | null;
  createdAt: string;
}

let ensured = false;

/**
 * @description Creates the lab tables + RLS if the migration has not run yet (fresh installs,
 * hot-swap deploys). Idempotent; runs once per process.
 * @param pool - The shared Postgres pool.
 * @returns Nothing.
 */
export async function ensureLabSchema(pool: Pool): Promise<void> {
  if (ensured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading_strategies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_sub TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      config JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','armed','retired')),
      baseline_run_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_sub, name)
    );
    CREATE INDEX IF NOT EXISTS idx_trd_strategies_owner ON trading_strategies (user_sub, status);
    CREATE TABLE IF NOT EXISTS trading_strategy_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      strategy_id UUID NOT NULL REFERENCES trading_strategies(id) ON DELETE CASCADE,
      user_sub TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('backtest','forward','regression')),
      status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','drifted','failed')),
      feed TEXT NOT NULL DEFAULT 'sip',
      git_sha TEXT NOT NULL DEFAULT '',
      window_start DATE,
      window_end DATE,
      bars INTEGER NOT NULL DEFAULT 0,
      config_snapshot JSONB NOT NULL,
      metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
      equity_curve JSONB NOT NULL DEFAULT '[]'::jsonb,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_trd_strategy_runs_strategy ON trading_strategy_runs (strategy_id, kind, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_trd_strategy_runs_owner ON trading_strategy_runs (user_sub, created_at DESC);
    CREATE TABLE IF NOT EXISTS trading_strategy_state (
      strategy_id UUID PRIMARY KEY REFERENCES trading_strategies(id) ON DELETE CASCADE,
      user_sub TEXT NOT NULL,
      as_of DATE NOT NULL,
      state JSONB NOT NULL,
      equity_points JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_trd_strategy_state_owner ON trading_strategy_state (user_sub);
    CREATE TABLE IF NOT EXISTS trading_strategy_notes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      strategy_id UUID NOT NULL REFERENCES trading_strategies(id) ON DELETE CASCADE,
      user_sub TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','lesson','decision')),
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_trd_strategy_notes_strategy ON trading_strategy_notes (strategy_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_trd_strategy_notes_owner ON trading_strategy_notes (user_sub);
  `);
  ensured = true;
  logger.info('Strategy Lab schema ensured');
}

const stratRow = (r: Record<string, unknown>): StrategyRow => ({
  id: String(r.id), name: String(r.name), description: String(r.description ?? ''),
  config: r.config as StrategyConfig, status: r.status as StrategyRow['status'],
  baselineRunId: r.baseline_run_id ? String(r.baseline_run_id) : null,
  createdAt: String(r.created_at), updatedAt: String(r.updated_at),
});

/** pg returns DATE columns as JS Dates — String(date).slice(0,10) yields "Thu Sep 19", which
 *  breaks the regression's pinned endDate comparison against "YYYY-MM-DD" session strings.
 *  Found by the 2026-07-13 live proof. */
const isoDay = (v: unknown): string | null => {
  if (!v) return null;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? String(v).slice(0, 10) : d.toISOString().slice(0, 10);
};

const runRow = (r: Record<string, unknown>): RunRow => ({
  id: String(r.id), strategyId: String(r.strategy_id), kind: r.kind as RunRow['kind'],
  status: r.status as RunRow['status'], feed: String(r.feed), gitSha: String(r.git_sha ?? ''),
  windowStart: isoDay(r.window_start),
  windowEnd: isoDay(r.window_end),
  bars: Number(r.bars ?? 0), configSnapshot: r.config_snapshot as StrategyConfig,
  metrics: (r.metrics ?? {}) as RunRow['metrics'], error: r.error ? String(r.error) : null,
  createdAt: String(r.created_at),
});

/**
 * @description Lists a user's strategies with their latest backtest metrics + forward tally.
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 * @returns Strategy rows, each with `latestBacktest` / `forward` summaries when present.
 */
export async function listStrategies(pool: Pool, sub: string): Promise<Array<StrategyRow & { latestBacktest: RunRow | null; forwardPoints: number; forwardLast: EquityPoint | null; notesCount: number; lessonsCount: number }>> {
  const { rows } = await pool.query(
    `SELECT s.*,
            (SELECT row_to_json(r) FROM (
               SELECT id, strategy_id, kind, status, feed, git_sha, window_start, window_end, bars, config_snapshot, metrics, error, created_at
               FROM trading_strategy_runs r WHERE r.strategy_id = s.id AND r.kind = 'backtest' AND r.status <> 'failed'
               ORDER BY r.created_at DESC LIMIT 1) r) AS latest_backtest,
            (SELECT count(*) FROM trading_strategy_notes n WHERE n.strategy_id = s.id) AS notes_count,
            (SELECT count(*) FROM trading_strategy_notes n WHERE n.strategy_id = s.id AND n.kind = 'lesson') AS lessons_count,
            st.equity_points AS fwd_points
       FROM trading_strategies s
       LEFT JOIN trading_strategy_state st ON st.strategy_id = s.id
      WHERE s.user_sub = $1
      ORDER BY s.created_at ASC`, [sub]);
  return rows.map((r) => {
    const fwd = Array.isArray(r.fwd_points) ? (r.fwd_points as EquityPoint[]) : [];
    return {
      ...stratRow(r),
      latestBacktest: r.latest_backtest ? runRow(r.latest_backtest as Record<string, unknown>) : null,
      forwardPoints: fwd.length,
      forwardLast: fwd.length ? fwd[fwd.length - 1] : null,
      notesCount: Number(r.notes_count ?? 0),
      lessonsCount: Number(r.lessons_count ?? 0),
    };
  });
}

/** @description Fetches one strategy (owner-scoped) or null. */
export async function getStrategy(pool: Pool, sub: string, id: string): Promise<StrategyRow | null> {
  const { rows } = await pool.query('SELECT * FROM trading_strategies WHERE id = $1 AND user_sub = $2', [id, sub]);
  return rows.length ? stratRow(rows[0]) : null;
}

/** @description Creates a strategy variation; throws on duplicate name for the owner. */
export async function createStrategy(pool: Pool, sub: string, name: string, description: string, config: StrategyConfig): Promise<StrategyRow> {
  const { rows } = await pool.query(
    `INSERT INTO trading_strategies (user_sub, name, description, config)
     VALUES ($1, $2, $3, $4) RETURNING *`, [sub, name, description, JSON.stringify(config)]);
  return stratRow(rows[0]);
}

/**
 * @description Patches a strategy's mutable fields. A config change clears the baseline pin and
 * the forward state — the old curves describe a different strategy, so they stay on their runs
 * but the forward walk restarts.
 */
export async function updateStrategy(pool: Pool, sub: string, id: string, patch: { name?: string; description?: string; status?: StrategyRow['status']; config?: StrategyConfig }): Promise<StrategyRow | null> {
  const cur = await getStrategy(pool, sub, id);
  if (!cur) return null;
  const configChanged = patch.config !== undefined;
  const { rows } = await pool.query(
    `UPDATE trading_strategies
        SET name = $3, description = $4, status = $5, config = $6,
            baseline_run_id = CASE WHEN $7 THEN NULL ELSE baseline_run_id END,
            updated_at = now()
      WHERE id = $1 AND user_sub = $2 RETURNING *`,
    [id, sub, patch.name ?? cur.name, patch.description ?? cur.description, patch.status ?? cur.status,
     JSON.stringify(patch.config ?? cur.config), configChanged]);
  if (configChanged) await pool.query('DELETE FROM trading_strategy_state WHERE strategy_id = $1 AND user_sub = $2', [id, sub]);
  return rows.length ? stratRow(rows[0]) : null;
}

/** @description Deletes a strategy (runs + state cascade). */
export async function deleteStrategy(pool: Pool, sub: string, id: string): Promise<boolean> {
  const res = await pool.query('DELETE FROM trading_strategies WHERE id = $1 AND user_sub = $2', [id, sub]);
  return (res.rowCount ?? 0) > 0;
}

/** @description Persists a run (metrics + full curve). Returns the stored row (curve omitted). */
export async function insertRun(pool: Pool, sub: string, run: {
  strategyId: string; kind: RunRow['kind']; status: RunRow['status']; feed: string; gitSha: string;
  windowStart: string | null; windowEnd: string | null; bars: number;
  configSnapshot: StrategyConfig; metrics: Record<string, unknown>; curve: EquityPoint[]; error?: string | null;
}): Promise<RunRow> {
  const { rows } = await pool.query(
    `INSERT INTO trading_strategy_runs
       (strategy_id, user_sub, kind, status, feed, git_sha, window_start, window_end, bars, config_snapshot, metrics, equity_curve, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id, strategy_id, kind, status, feed, git_sha, window_start, window_end, bars, config_snapshot, metrics, error, created_at`,
    [run.strategyId, sub, run.kind, run.status, run.feed, run.gitSha, run.windowStart, run.windowEnd,
     run.bars, JSON.stringify(run.configSnapshot), JSON.stringify(run.metrics), JSON.stringify(run.curve), run.error ?? null]);
  return runRow(rows[0]);
}

/** @description Lists a strategy's runs, newest first, curves omitted. */
export async function listRuns(pool: Pool, sub: string, strategyId: string, limit = 50): Promise<RunRow[]> {
  const { rows } = await pool.query(
    `SELECT id, strategy_id, kind, status, feed, git_sha, window_start, window_end, bars, config_snapshot, metrics, error, created_at
       FROM trading_strategy_runs WHERE strategy_id = $1 AND user_sub = $2
      ORDER BY created_at DESC LIMIT $3`, [strategyId, sub, limit]);
  return rows.map(runRow);
}

/** @description Fetches one run WITH its equity curve. */
export async function getRun(pool: Pool, sub: string, runId: string): Promise<(RunRow & { curve: EquityPoint[] }) | null> {
  const { rows } = await pool.query('SELECT * FROM trading_strategy_runs WHERE id = $1 AND user_sub = $2', [runId, sub]);
  if (!rows.length) return null;
  return { ...runRow(rows[0]), curve: (rows[0].equity_curve ?? []) as EquityPoint[] };
}

/** @description Pins a run as the strategy's regression baseline. */
export async function setBaseline(pool: Pool, sub: string, strategyId: string, runId: string): Promise<void> {
  await pool.query('UPDATE trading_strategies SET baseline_run_id = $3, updated_at = now() WHERE id = $1 AND user_sub = $2', [strategyId, sub, runId]);
}

/** @description Loads a strategy's forward-walk state + accumulated points (null when never started). */
export async function getForwardState(pool: Pool, sub: string, strategyId: string): Promise<{ state: WalkState; points: EquityPoint[]; asOf: string } | null> {
  const { rows } = await pool.query('SELECT * FROM trading_strategy_state WHERE strategy_id = $1 AND user_sub = $2', [strategyId, sub]);
  if (!rows.length) return null;
  return { state: rows[0].state as WalkState, points: (rows[0].equity_points ?? []) as EquityPoint[], asOf: isoDay(rows[0].as_of) ?? '' };
}

/** A dated note on a strategy — the per-configuration narrative (notes, lessons learned, decisions). */
export interface NoteRow {
  id: string;
  strategyId: string;
  kind: 'note' | 'lesson' | 'decision';
  body: string;
  createdAt: string;
}

const noteRow = (r: Record<string, unknown>): NoteRow => ({
  id: String(r.id), strategyId: String(r.strategy_id),
  kind: (['note', 'lesson', 'decision'].includes(String(r.kind)) ? String(r.kind) : 'note') as NoteRow['kind'],
  body: String(r.body ?? ''), createdAt: String(r.created_at),
});

/** @description Lists a strategy's notes, newest first. */
export async function listNotes(pool: Pool, sub: string, strategyId: string, limit = 200): Promise<NoteRow[]> {
  const { rows } = await pool.query(
    `SELECT * FROM trading_strategy_notes WHERE strategy_id = $1 AND user_sub = $2
      ORDER BY created_at DESC LIMIT $3`, [strategyId, sub, limit]);
  return rows.map(noteRow);
}

/** @description Appends a dated note/lesson/decision to a strategy's journal. */
export async function addNote(pool: Pool, sub: string, strategyId: string, kind: NoteRow['kind'], body: string): Promise<NoteRow> {
  const { rows } = await pool.query(
    `INSERT INTO trading_strategy_notes (strategy_id, user_sub, kind, body)
     VALUES ($1, $2, $3, $4) RETURNING *`, [strategyId, sub, kind, body.slice(0, 4000)]);
  return noteRow(rows[0]);
}

/** @description Deletes one note (owner-scoped). */
export async function deleteNote(pool: Pool, sub: string, strategyId: string, noteId: string): Promise<boolean> {
  const res = await pool.query(
    'DELETE FROM trading_strategy_notes WHERE id = $1 AND strategy_id = $2 AND user_sub = $3', [noteId, strategyId, sub]);
  return (res.rowCount ?? 0) > 0;
}

/** @description Saves the forward-walk state, appending any new equity points. */
export async function saveForwardState(pool: Pool, sub: string, strategyId: string, state: WalkState, newPoints: EquityPoint[]): Promise<void> {
  await pool.query(
    `INSERT INTO trading_strategy_state (strategy_id, user_sub, as_of, state, equity_points, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (strategy_id) DO UPDATE SET
       as_of = EXCLUDED.as_of, state = EXCLUDED.state,
       equity_points = trading_strategy_state.equity_points || EXCLUDED.equity_points,
       updated_at = now()`,
    [strategyId, sub, state.lastDate || new Date().toISOString().slice(0, 10), JSON.stringify(state), JSON.stringify(newPoints)]);
}
