/**
 * Trading config overrides (ADR-095) — the "apply a lab strategy to my profile" layer.
 *
 * The autopilot's knobs (posture, take-profit, SPY core, rotation rank/cadence/topN/weighting,
 * universe) historically lived ONLY in env vars, so switching the profile onto a tested Strategy
 * Lab configuration meant editing `.env` and bouncing the container. This module holds ONE active
 * per-user override (a snapshot of a lab StrategyConfig + an apply percentage) that the dispatch
 * config resolvers overlay on top of the env defaults. No override row → env behavior, unchanged.
 * Deactivated rows are kept as the apply/revert audit history.
 *
 * `applyPct` scales how much of the book the strategy's SLEEVE runs: the strategy's designed
 * sleeve share is (100 − corePct); at applyPct=50 only half that share rotates and the remainder
 * parks in the core symbol. 100 = the strategy exactly as designed. Operator-hold core entries
 * (`SYM:0` exemptions in TRADING_CORE_SYMBOLS, e.g. the SKHY IPO position) always survive an
 * override — the strategy owns the core TARGET, never the operator's standing holds.
 *
 * Schema self-heals on first use (ensureOverridesSchema), mirroring migration
 * scripts/migrations/073-trading-lab-notes-overrides.sql — the ensureLabSchema pattern.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — override CRUD (one active per user, history kept) + the pure overlay helpers the dispatch config resolvers call (effectiveCorePct, overlayCoreEntries, overlayRotationKnobs, policyOverrideOf).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | BLEND overrides (ADR-095 round 2): an applied blend enables rotation at the blend cadence (the merged-target path executes it), and policyOverrideOf resolves the MOST-CONSERVATIVE component policy (tightest stop, earliest tp) for book-level exits/caps.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Honesty rails: apply/revert now auto-record a strategy-journal entry so every knob turn reaches the daily report's "What changed" section without anyone remembering to write it down.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-134 PR2 — per-book actives: the one-active index swaps atomically to (user_sub, book_id) WHERE active with a clone-backfill (each currently-active book-less row becomes identical per-legacy-book actives; history keeps book_id NULL; a rolled-back image can still insert a book-less active — the CHECK is deferred to PR4). getActiveOverride/applyOverride/revertOverride gain book scope; deactivation WHEREs are book-scoped (the cross-revert trap); book-less calls keep today's both-books contract for deployed store twins.
 *
 * @module trading-config-overrides
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import type { PolicyOverride } from '@/features/trading';
import type { StrategyConfig } from './trading-strategy-lab-sim';
import { conservativeBlendPolicy } from './trading-blend';
import { recordStrategyJournal } from './trading-strategy-journal';
import { legacyBookId } from './trading-books-store';

const logger = createChildLogger({ module: 'trading-config-overrides' });

/** An applied (or historical) profile override row. */
export interface ConfigOverrideRow {
  id: string;
  /** ADR-134: the book this override drives; NULL only on pre-book history rows. */
  bookId: string | null;
  strategyId: string | null;
  strategyName: string;
  config: StrategyConfig;
  applyPct: number;
  active: boolean;
  note: string;
  createdAt: string;
  deactivatedAt: string | null;
}

/** The rotation-knob shape rotationConfig() resolves (kept structural so this module stays light). */
export interface RotationKnobs {
  enabled: boolean;
  everyDays: number;
  topN: number;
  rank: string;
  weighting: string;
  extHours: boolean;
}

let ensured = false;

/**
 * @description Creates the overrides table + RLS if migration 073 has not run yet (fresh installs,
 * hot-swap deploys). Idempotent; runs once per process.
 * @param pool - The shared Postgres pool.
 * @returns Nothing.
 */
export async function ensureOverridesSchema(pool: Pool): Promise<void> {
  if (ensured) return;
  // One multi-statement query = one implicit transaction: the one-active index SWAP and the
  // clone-backfill land atomically (ADR-134 PR2). The old (user_sub) WHERE active index cannot
  // coexist with per-book actives, so it is dropped and replaced by (user_sub, book_id) WHERE
  // active; every currently-active book-less row is CLONED to each legacy book (identical
  // snapshots — preserves today's "one override drives both books" contract and keeps a code
  // rollback benign: old getActiveOverride reads either identical row). History rows keep
  // book_id NULL. The CHECK (NOT active OR book_id IS NOT NULL) is DEFERRED to PR4 — rolled-back
  // PR1-era code must still be able to insert a book-less active row (adversarial-review rule).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading_config_overrides (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_sub TEXT NOT NULL,
      strategy_id UUID,
      strategy_name TEXT NOT NULL,
      config JSONB NOT NULL,
      apply_pct INTEGER NOT NULL DEFAULT 100 CHECK (apply_pct BETWEEN 1 AND 100),
      active BOOLEAN NOT NULL DEFAULT true,
      note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      deactivated_at TIMESTAMPTZ
    );
    ALTER TABLE trading_config_overrides ADD COLUMN IF NOT EXISTS book_id UUID;
    DROP INDEX IF EXISTS idx_trd_cfg_override_one_active;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_cfg_override_one_active_book ON trading_config_overrides (user_sub, book_id) WHERE active;
    CREATE INDEX IF NOT EXISTS idx_trd_cfg_override_owner ON trading_config_overrides (user_sub, created_at DESC);
    INSERT INTO trading_config_overrides (user_sub, book_id, strategy_id, strategy_name, config, apply_pct, active, note, created_at)
    SELECT o.user_sub, md5('oshal-book:'||o.user_sub||':'||k.kind)::uuid, o.strategy_id, o.strategy_name, o.config, o.apply_pct, true,
           o.note, o.created_at
      FROM trading_config_overrides o
     CROSS JOIN (VALUES ('paper'), ('live')) AS k(kind)
     WHERE o.active AND o.book_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM trading_config_overrides x
          WHERE x.user_sub = o.user_sub AND x.active
            AND x.book_id = md5('oshal-book:'||o.user_sub||':'||k.kind)::uuid);
    UPDATE trading_config_overrides SET active = false, deactivated_at = now()
     WHERE active AND book_id IS NULL;
  `);
  ensured = true;
  logger.info('trading config-overrides schema ensured (per-book actives, ADR-134)');
}

const rowMap = (r: Record<string, unknown>): ConfigOverrideRow => ({
  id: String(r.id),
  bookId: r.book_id ? String(r.book_id) : null,
  strategyId: r.strategy_id ? String(r.strategy_id) : null,
  strategyName: String(r.strategy_name ?? ''),
  config: r.config as StrategyConfig,
  applyPct: Number(r.apply_pct ?? 100),
  active: Boolean(r.active),
  note: String(r.note ?? ''),
  createdAt: String(r.created_at),
  deactivatedAt: r.deactivated_at ? String(r.deactivated_at) : null,
});

/**
 * @description The caller's ACTIVE profile override, or null when the profile runs env defaults.
 * Read once per autopilot fire by dispatchTradingSchedule and threaded through the run.
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 * @returns The active override row or null.
 */
export async function getActiveOverride(pool: Pool, sub: string, bookId?: string | null): Promise<ConfigOverrideRow | null> {
  await ensureOverridesSchema(pool);
  // ADR-134: with a bookId, THAT book's active row; without (deployed store twins, pre-book
  // callers), any active row — under the clone-backfill the legacy books carry identical
  // snapshots, so either answer is today's behavior.
  const { rows } = bookId
    ? await pool.query('SELECT * FROM trading_config_overrides WHERE user_sub = $1 AND book_id = $2 AND active LIMIT 1', [sub, bookId])
    : await pool.query('SELECT * FROM trading_config_overrides WHERE user_sub = $1 AND active ORDER BY created_at DESC LIMIT 1', [sub]);
  return rows.length ? rowMap(rows[0]) : null;
}

/**
 * @description Applies a strategy as the caller's profile override: deactivates any current
 * override (keeping it as history) and inserts the new active row, atomically.
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 * @param apply - Strategy identity, its config snapshot, apply percentage and an operator note.
 * @returns The new active override row.
 */
export async function applyOverride(pool: Pool, sub: string, apply: {
  strategyId: string | null; strategyName: string; config: StrategyConfig; applyPct: number; note: string;
  /** ADR-134: the target book. Omitted (deployed store twins) = BOTH legacy books get identical
   *  clones — today's "one apply drives both books" contract, byte-preserved. */
  bookId?: string | null;
  /** Display ref for the journal line ('paper' | 'live' | 'b-xxxxxxxx'); derived when omitted. */
  bookRef?: string | null;
}): Promise<ConfigOverrideRow> {
  await ensureOverridesSchema(pool);
  const targets: Array<{ bookId: string; ref: string }> = apply.bookId
    ? [{ bookId: apply.bookId, ref: apply.bookRef || 'book' }]
    : (['paper', 'live'] as const).map((kind) => ({ bookId: legacyBookId(sub, kind), ref: kind }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Deactivation is BOOK-SCOPED (the cross-revert trap): an apply to book A must never silently
    // revert book B's strategy. The no-book path deactivates exactly its two legacy targets.
    let first: ConfigOverrideRow | null = null;
    for (const t of targets) {
      await client.query(
        'UPDATE trading_config_overrides SET active = false, deactivated_at = now() WHERE user_sub = $1 AND book_id = $2 AND active',
        [sub, t.bookId]);
      const { rows } = await client.query(
        `INSERT INTO trading_config_overrides (user_sub, book_id, strategy_id, strategy_name, config, apply_pct, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [sub, t.bookId, apply.strategyId, apply.strategyName, JSON.stringify(apply.config),
         Math.round(Math.max(1, Math.min(100, apply.applyPct))), apply.note.slice(0, 500)]);
      first = first ?? rowMap(rows[0]);
    }
    await client.query('COMMIT');
    logger.info({ sub, strategy: apply.strategyName, applyPct: apply.applyPct, books: targets.map((t) => t.ref).join(',') }, 'profile override APPLIED');
    // Honesty rail: every knob turn reaches the daily report. Fire-and-forget — the journal
    // helper swallows its own failures, so the apply itself can never be blocked by reporting.
    void recordStrategyJournal(pool, {
      sub, kind: 'knob-turn', source: 'trading-config-overrides.applyOverride',
      bookRef: apply.bookId ? (apply.bookRef || 'book') : 'paper+live',
      summary: `Strategy override applied: "${apply.strategyName}" at ${apply.applyPct}% of the sleeve [${apply.bookId ? (apply.bookRef || 'book') : 'both books'}]${apply.note ? ` — ${apply.note.slice(0, 120)}` : ''}`,
      detail: { strategyId: apply.strategyId, applyPct: apply.applyPct, bookId: apply.bookId ?? null },
    });
    return first as ConfigOverrideRow;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err, sub }, 'applyOverride failed');
    throw err;
  } finally {
    client.release();
  }
}


/**
 * @description Reverts the caller's profile to env defaults by deactivating the active override.
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 * @returns The deactivated row, or null when nothing was active.
 */
export async function revertOverride(pool: Pool, sub: string, bookId?: string | null, bookRef?: string | null): Promise<ConfigOverrideRow | null> {
  await ensureOverridesSchema(pool);
  // ADR-134: with a bookId the revert is SCOPED to that book (the cross-revert trap — reverting
  // book A must not touch book B). Without one, ALL the user's actives revert — today's contract
  // for the deployed store twins under the legacy clone pair.
  const { rows } = bookId
    ? await pool.query(
      `UPDATE trading_config_overrides SET active = false, deactivated_at = now()
        WHERE user_sub = $1 AND book_id = $2 AND active RETURNING *`, [sub, bookId])
    : await pool.query(
      `UPDATE trading_config_overrides SET active = false, deactivated_at = now()
        WHERE user_sub = $1 AND active RETURNING *`, [sub]);
  if (rows.length) {
    logger.info({ sub, strategy: rows[0].strategy_name, books: rows.length }, 'profile override REVERTED — env defaults resume');
    void recordStrategyJournal(pool, {
      sub, kind: 'knob-turn', source: 'trading-config-overrides.revertOverride',
      bookRef: bookId ? (bookRef || 'book') : 'paper+live',
      summary: `Strategy override reverted: "${rows[0].strategy_name}" [${bookId ? (bookRef || 'book') : 'all books'}] — env defaults resume`,
      detail: { strategyId: rows[0].strategy_id ?? null, bookId: bookId ?? null },
    });
  }
  return rows.length ? rowMap(rows[0]) : null;
}

/**
 * @description The caller's apply/revert history, newest first (the audit trail the UI shows).
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 * @param limit - Max rows (default 20).
 * @returns Override rows including the active one.
 */
export async function listOverrideHistory(pool: Pool, sub: string, limit = 20): Promise<ConfigOverrideRow[]> {
  await ensureOverridesSchema(pool);
  const { rows } = await pool.query(
    'SELECT * FROM trading_config_overrides WHERE user_sub = $1 ORDER BY created_at DESC LIMIT $2', [sub, limit]);
  return rows.map(rowMap);
}

/* ── Pure overlay helpers (unit-tested; no I/O) ─────────────────────────────────────────────── */

/**
 * @description The core percentage the book actually runs under an override. The strategy's
 * designed sleeve share is (100 − corePct); applyPct scales that share and the remainder parks in
 * the core symbol. applyPct=100 → the strategy exactly as designed; applyPct=25 on a full-deploy
 * (corePct=0) strategy → 75% core, 25% sleeve.
 * @param config - The applied strategy config.
 * @param applyPct - Percent of the strategy's designed sleeve share to run (1–100).
 * @returns The effective core percent, clamped 0–95.
 */
export function effectiveCorePct(config: Pick<StrategyConfig, 'corePct'>, applyPct: number): number {
  const pct = Math.max(1, Math.min(100, Number(applyPct) || 100));
  const designedSleeve = 100 - Math.max(0, Math.min(95, Number(config.corePct) || 0));
  return Math.round(Math.max(0, Math.min(95, 100 - designedSleeve * (pct / 100))));
}

/**
 * @description Overlays an override onto the env-parsed per-symbol core map. Operator exemption
 * holds (`SYM:0` entries — held, never topped up, never sleeve-sold) are PRESERVED; env core
 * targets (>0) are replaced by the strategy's core symbol at its effective percentage.
 * @param envPerSymbol - The per-symbol target map coreConfig() parsed from env.
 * @param override - The active override, or null/undefined for env behavior.
 * @returns The map the run should use (a new Map when an override is active).
 */
export function overlayCoreEntries(envPerSymbol: Map<string, number>, override?: ConfigOverrideRow | null): Map<string, number> {
  if (!override) return envPerSymbol;
  const out = new Map<string, number>();
  for (const [sym, pct] of envPerSymbol) if (pct === 0) out.set(sym, 0); // operator holds survive
  const coreSym = String(override.config.coreSymbol || 'SPY').toUpperCase();
  const eff = effectiveCorePct(override.config, override.applyPct);
  if (eff > 0) out.set(coreSym, eff);
  else if (!out.has(coreSym)) out.delete(coreSym);
  return out;
}

/**
 * @description Overlays an override onto the env-resolved rotation knobs. A 'rotation'-kind
 * strategy takes ownership of the sleeve (enabled + its rank/cadence/topN/weighting); an
 * 'ensemble'-kind strategy turns rotation OFF so the multi-timeframe scan owns the sleeve.
 * extHours stays env-controlled — it is an execution-safety dial, not a strategy knob.
 * @param base - The knobs rotationConfig() parsed from env.
 * @param override - The active override, or null/undefined for env behavior.
 * @returns The knobs the run should use.
 */
export function overlayRotationKnobs(base: RotationKnobs, override?: ConfigOverrideRow | null): RotationKnobs {
  if (!override) return base;
  const c = override.config;
  if (c.kind === 'blend') {
    // A blend runs the merged-target rotation path; everyDays gates the cadence (min component
    // cadence, set at normalize). rank is a label only — the blend path reads components directly.
    return { ...base, enabled: true, everyDays: Math.max(1, Math.round(Number(c.cadenceDays) || 1)), rank: 'blend-multi' };
  }
  if (c.kind !== 'rotation') return { ...base, enabled: false };
  return {
    enabled: true,
    everyDays: Math.max(1, Math.round(Number(c.cadenceDays) || 1)),
    topN: Math.max(1, Math.round(Number(c.topN) || 12)),
    rank: ['gravity', 'momentum', 'ensemble', 'blend'].includes(String(c.rank)) ? String(c.rank) : 'gravity',
    weighting: c.weighting === 'equal' ? 'equal' : 'conviction',
    extHours: base.extHours,
  };
}

/**
 * @description The riskPolicy() override argument for an active profile override: the strategy's
 * posture always applies; its takeProfitPct applies as-is (null deliberately means "the posture's
 * own take-profit", overriding any env TRADING_TAKE_PROFIT_PCT).
 * @param override - The active override, or null/undefined.
 * @returns The policy override, or undefined for env behavior.
 */
export function policyOverrideOf(override?: ConfigOverrideRow | null): PolicyOverride | undefined {
  if (!override) return undefined;
  if (override.config.kind === 'blend' && override.config.components?.length) {
    const p = conservativeBlendPolicy(override.config.components);
    return { posture: p.posture, takeProfitPct: p.takeProfitPct };
  }
  return { posture: override.config.posture, takeProfitPct: override.config.takeProfitPct };
}
