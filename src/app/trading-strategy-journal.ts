/**
 * Trading strategy journal — the honest record of every knob turn and incident, for the report.
 *
 * The operator directive behind this store: "when strategies change or knobs are turned or there
 * is an issue logging in or there is downtime, the entire platform needs to be honest." Numbers
 * alone can't explain a regime reweight, a universe expansion, or a missed report — this journal
 * holds the one-line human truths ("core hold moved SPY -> BRK.B", "13 nightly reports missed"),
 * and the daily recap reads it to build its "What changed" section. Entries are append-only;
 * corrections are new entries, never edits — the journal is a record, not a wiki.
 *
 * Auto-captured writers: applyOverride / revertOverride (trading-config-overrides). Everything
 * else (code-level strategy changes, incidents, outages) is written explicitly by the operator or
 * the pipeline that observed it, via recordStrategyJournal or scripts/oshal-strategy-journal.js.
 *
 * Mirrors the self-healing runtime-table pattern of the daily-equity / peaks / rotation stores:
 * created on first use, off every critical path — a failure here degrades reporting, never trading.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — append-only journal (kind/summary/detail/source per ET day) + since-window reader for the recap's "What changed" section.
 *
 * @module trading-strategy-journal
 */

import type { Pool } from 'pg';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'trading-strategy-journal' });

/** The journal entry kinds the report knows how to phrase. */
export type StrategyJournalKind = 'knob-turn' | 'universe' | 'hold-swap' | 'strategy' | 'incident' | 'note';

/** @description One journal row as read back for reporting. */
export interface StrategyJournalRow {
  id: number;
  userSub: string;
  etDay: string;
  kind: StrategyJournalKind;
  summary: string;
  detail: Record<string, unknown> | null;
  source: string;
  createdAt: string;
}

/** US/Eastern calendar day (YYYY-MM-DD) for a given epoch-ms (default: now). Market days are ET. */
function etDay(ms: number = Date.now()): string {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** @description Create the journal table if absent (self-healing, like the daily-equity store). */
export async function ensureStrategyJournalTable(pool: Pool): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool, moduleName: 'trading strategy journal',
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_trading_strategy_journal (
        id BIGSERIAL PRIMARY KEY,
        user_sub TEXT NOT NULL,
        et_day DATE NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        detail JSONB,
        source TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_strategy_journal_sub_day
         ON oshal_trading_strategy_journal (user_sub, et_day)`,
    ],
    requirements: [{ table: 'oshal_trading_strategy_journal', columns: ['user_sub', 'et_day', 'kind', 'summary', 'source'] }],
  });
}

/**
 * @description Appends one journal entry. Never throws to the caller's critical path — a journal
 * failure is logged and swallowed so a knob turn is never blocked by its own paper trail.
 * @param pool - Postgres pool.
 * @param entry - Owner sub, kind, one-line summary (what the report will say), optional structured
 *   detail, and the source that recorded it (route, script, or operator).
 * @returns True when the entry landed; false when it was logged-and-swallowed.
 */
export async function recordStrategyJournal(pool: Pool, entry: {
  sub: string; kind: StrategyJournalKind; summary: string;
  detail?: Record<string, unknown>; source: string; etDayOverride?: string;
}): Promise<boolean> {
  try {
    await ensureStrategyJournalTable(pool);
    await pool.query(
      `INSERT INTO oshal_trading_strategy_journal (user_sub, et_day, kind, summary, detail, source)
       VALUES ($1, $2::date, $3, $4, $5, $6)`,
      [entry.sub, entry.etDayOverride ?? etDay(), entry.kind, entry.summary.slice(0, 500),
       entry.detail ? JSON.stringify(entry.detail) : null, entry.source.slice(0, 120)]);
    logger.info({ sub: entry.sub, kind: entry.kind, summary: entry.summary }, 'strategy journal entry recorded');
    return true;
  } catch (err) {
    logger.error({ err, kind: entry.kind }, 'strategy journal write failed (swallowed — never blocks the change itself)');
    return false;
  }
}

/**
 * @description Journal entries for a sub in the ET-day window (sinceDay, throughDay], oldest first —
 * exactly the shape the recap's "What changed" section consumes.
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 * @param sinceDay - Exclusive lower bound (the previous report's day).
 * @param throughDay - Inclusive upper bound (the report day).
 * @returns Rows oldest-first; empty on any read failure (honest nulls beat a crashed report).
 */
export async function listStrategyJournal(pool: Pool, sub: string, sinceDay: string, throughDay: string): Promise<StrategyJournalRow[]> {
  try {
    await ensureStrategyJournalTable(pool);
    const { rows } = await pool.query(
      `SELECT id, user_sub, et_day::text AS et_day, kind, summary, detail, source, created_at
         FROM oshal_trading_strategy_journal
        WHERE user_sub = $1 AND et_day > $2::date AND et_day <= $3::date
        ORDER BY et_day, id`, [sub, sinceDay, throughDay]);
    return rows.map((r) => ({
      id: Number(r.id), userSub: String(r.user_sub), etDay: String(r.et_day),
      kind: r.kind as StrategyJournalKind, summary: String(r.summary),
      detail: r.detail ?? null, source: String(r.source), createdAt: String(r.created_at),
    }));
  } catch (err) {
    logger.error({ err, sub }, 'strategy journal read failed (returning empty — the report ships without the section)');
    return [];
  }
}
