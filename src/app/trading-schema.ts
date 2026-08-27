/**
 * Trading store schema bootstrap (mirrors migration 034; CREATE IF NOT EXISTS so the app
 * self-heals). Leaf ENGINE module — depends only on the shared database service, so every
 * trading module (routes, dispatch loops, reconcile) can await it safely.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from trading-routes.ts (1000-line cap decomposition): ensureTradingSchema + the DDL bootstrap and its once-per-process memoization. Code moved verbatim — zero behavior change.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Moved routes/trading-routes-schema.ts → app/trading-schema.ts (trading engine extraction, ADR-085 pre-carve): the schema bootstrap is ENGINE, not surface — 8 kernel dispatch/reconcile loops await it, so it can't live under the routes family the surface carve will take. Code unchanged — pure motion, zero behavior change.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-134 book_id re-key (PR1): books registry bootstraps first; signals/decisions/orders/predictions gain a nullable book_id with trigger-BEFORE-backfill ordering (the BEFORE INSERT fill trigger arms before the backfill sweep so concurrent writers — reconcile fires while closed, un-redeployed store twins — can never mint NULL-book rows); book-scoped unique arbiters coexist with the mode-scoped ones until the PR4 cutover. `mode` is retained and always written.
 *
 * @module trading-schema
 */

import { runRuntimeSchemaBootstrap } from '@/shared/services/database';
import type { AppContext } from '@/app/composition/app-context';
import { ensureBooksSchema } from './trading-books-store';

// Memoize the DDL bootstrap so it runs ONCE per process, not on every route hit (every /status,
// /signals, /decide, … awaits this). On failure we reset the cache to null so a later call retries.
let schemaReady: Promise<void> | null = null;

/**
 * @description Ensure the trading tables/indexes exist (memoized — the bootstrap runs once per
 * process; a failed attempt clears the memo so the next call retries).
 * @param pool - Postgres pool.
 * @returns Resolves when the trading schema is in place.
 */
export async function ensureTradingSchema(pool: AppContext['pool']): Promise<void> {
  if (!schemaReady) {
    schemaReady = bootstrapTradingSchema(pool).catch((err) => {
      schemaReady = null; // allow a retry on the next call
      throw err;
    });
  }
  return schemaReady;
}

async function bootstrapTradingSchema(pool: AppContext['pool']): Promise<void> {
  // ADR-134: the books registry must exist (and legacy books be minted) BEFORE the book_id
  // trigger/backfill below derives ids against it.
  await ensureBooksSchema(pool);
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'trading routes',
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_trading_signals (
        signal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_sub TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('paper','live')),
        source TEXT NOT NULL, external_id TEXT, author TEXT, url TEXT, title TEXT, body TEXT,
        symbols TEXT[], indicators JSONB, content_hash TEXT NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX IF NOT EXISTS idx_trd_signals_user_mode ON oshal_trading_signals (user_sub, mode, observed_at DESC)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_signals_dedup ON oshal_trading_signals (user_sub, mode, content_hash)',
      `CREATE TABLE IF NOT EXISTS oshal_trading_decisions (
        decision_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_sub TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('paper','live')),
        signal_ids UUID[] NOT NULL,
        agent_id TEXT, action TEXT NOT NULL, symbol TEXT, side TEXT, qty NUMERIC(18,6),
        order_type TEXT, limit_price NUMERIC(18,4), confidence NUMERIC(5,4),
        rationale TEXT NOT NULL, indicators JSONB, guardrails JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT trd_decisions_has_signal CHECK (array_length(signal_ids, 1) >= 1),
        CONSTRAINT trd_decisions_action CHECK (action IN ('buy','sell','hold'))
      )`,
      'CREATE INDEX IF NOT EXISTS idx_trd_decisions_user_mode ON oshal_trading_decisions (user_sub, mode, created_at DESC)',
      `CREATE TABLE IF NOT EXISTS oshal_trading_orders (
        order_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_sub TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('paper','live')),
        decision_id UUID NOT NULL REFERENCES oshal_trading_decisions (decision_id),
        broker TEXT NOT NULL, broker_order_id TEXT, client_order_id TEXT NOT NULL,
        symbol TEXT NOT NULL, side TEXT NOT NULL, qty NUMERIC(18,6) NOT NULL,
        order_type TEXT NOT NULL, limit_price NUMERIC(18,4),
        status TEXT NOT NULL, raw_status TEXT,
        filled_qty NUMERIC(18,6) NOT NULL DEFAULT 0, filled_avg_price NUMERIC(18,4),
        realized_pnl NUMERIC(18,4), reject_reason TEXT,
        submitted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX IF NOT EXISTS idx_trd_orders_user_mode ON oshal_trading_orders (user_sub, mode, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_trd_orders_decision ON oshal_trading_orders (decision_id)',
      // Idempotency is PER BOOK. The old unique index omitted `mode`, so a paper order and a live
      // order sharing a client_order_id (the autopilot's requestId was book-independent) collided:
      // the second INSERT hit ON CONFLICT and OVERWROTE the first's broker_order_id/status. On
      // 2026-07-08 a paper Alpaca fill clobbered the real Schwab order id of a LIVE AMD sell, leaving
      // that live row permanently unreconcilable. Mirrors oshal_trading_signals (user_sub, mode, …).
      'DROP INDEX IF EXISTS idx_trd_orders_client',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_orders_client_mode ON oshal_trading_orders (user_sub, mode, client_order_id)',
      'ALTER TABLE oshal_trading_decisions ADD COLUMN IF NOT EXISTS stop_price NUMERIC(18,4)',
      'ALTER TABLE oshal_trading_decisions ADD COLUMN IF NOT EXISTS trail_price NUMERIC(18,4)',
      'ALTER TABLE oshal_trading_decisions ADD COLUMN IF NOT EXISTS trail_percent NUMERIC(8,4)',
      'ALTER TABLE oshal_trading_decisions ADD COLUMN IF NOT EXISTS time_in_force TEXT',
      'ALTER TABLE oshal_trading_orders ADD COLUMN IF NOT EXISTS stop_price NUMERIC(18,4)',
      'ALTER TABLE oshal_trading_orders ADD COLUMN IF NOT EXISTS trail_price NUMERIC(18,4)',
      'ALTER TABLE oshal_trading_orders ADD COLUMN IF NOT EXISTS trail_percent NUMERIC(8,4)',
      'ALTER TABLE oshal_trading_orders ADD COLUMN IF NOT EXISTS time_in_force TEXT',
      // cost_basis = the position's avg entry captured when a SELL is submitted, so realized_pnl
      // (= (fill - cost_basis) * filled_qty) can be computed on fill — the per-sale P&L track record.
      'ALTER TABLE oshal_trading_orders ADD COLUMN IF NOT EXISTS cost_basis NUMERIC(18,4)',
      `CREATE TABLE IF NOT EXISTS oshal_trading_predictions (
        prediction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_sub TEXT, mode TEXT NOT NULL DEFAULT 'paper' CHECK (mode IN ('paper','live')),
        symbol TEXT NOT NULL, algo TEXT NOT NULL,
        pred_dir TEXT NOT NULL CHECK (pred_dir IN ('up','down')), confidence NUMERIC(5,4),
        price NUMERIC(18,4) NOT NULL, basis TEXT, horizon_hrs INTEGER NOT NULL DEFAULT 24,
        resolved BOOLEAN NOT NULL DEFAULT false, actual_dir TEXT, actual_price NUMERIC(18,4), hit BOOLEAN,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), resolved_at TIMESTAMPTZ
      )`,
      'CREATE INDEX IF NOT EXISTS idx_trd_pred_symbol_algo ON oshal_trading_predictions (symbol, algo, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_trd_pred_algo ON oshal_trading_predictions (algo, resolved)',
      // Partial index for the matured-prediction resolver (resolveMaturedPredictions): it scans
      // only open (resolved=false) rows by mode + age, so a partial index keeps that sweep cheap.
      // NOT CONCURRENTLY — this runs inside the bootstrap transaction path.
      'CREATE INDEX IF NOT EXISTS idx_trd_pred_open_mode ON oshal_trading_predictions (mode, created_at) WHERE resolved = false',

      /* ── ADR-134: book_id re-key (additive; `mode` retained and always written) ──────────────
         Ordering is load-bearing (adversarial live-safety review): columns → TRIGGER → backfill →
         indexes. Writers never stop (reconcile fires every 5min even closed; un-redeployed store
         twins insert book-less rows until their own docker-cp), so the BEFORE INSERT trigger must
         be armed BEFORE the backfill sweep — an insert landing between a backfill-first UPDATE and
         a later trigger install would stay NULL forever and silently escape the twin-order
         arbiter (NULL never conflicts in a unique index). */
      'ALTER TABLE oshal_trading_signals    ADD COLUMN IF NOT EXISTS book_id UUID',
      'ALTER TABLE oshal_trading_decisions  ADD COLUMN IF NOT EXISTS book_id UUID',
      'ALTER TABLE oshal_trading_orders     ADD COLUMN IF NOT EXISTS book_id UUID',
      'ALTER TABLE oshal_trading_predictions ADD COLUMN IF NOT EXISTS book_id UUID',
      // (The fill function itself is created canonically by ensureBooksSchema, awaited above.)
      'DROP TRIGGER IF EXISTS trg_trd_signals_book_fill ON oshal_trading_signals',
      'CREATE TRIGGER trg_trd_signals_book_fill BEFORE INSERT ON oshal_trading_signals FOR EACH ROW EXECUTE FUNCTION oshal_trading_book_id_fill()',
      'DROP TRIGGER IF EXISTS trg_trd_decisions_book_fill ON oshal_trading_decisions',
      'CREATE TRIGGER trg_trd_decisions_book_fill BEFORE INSERT ON oshal_trading_decisions FOR EACH ROW EXECUTE FUNCTION oshal_trading_book_id_fill()',
      'DROP TRIGGER IF EXISTS trg_trd_orders_book_fill ON oshal_trading_orders',
      'CREATE TRIGGER trg_trd_orders_book_fill BEFORE INSERT ON oshal_trading_orders FOR EACH ROW EXECUTE FUNCTION oshal_trading_book_id_fill()',
      'DROP TRIGGER IF EXISTS trg_trd_predictions_book_fill ON oshal_trading_predictions',
      'CREATE TRIGGER trg_trd_predictions_book_fill BEFORE INSERT ON oshal_trading_predictions FOR EACH ROW EXECUTE FUNCTION oshal_trading_book_id_fill()',
      `UPDATE oshal_trading_signals SET book_id = md5('oshal-book:'||user_sub||':'||mode)::uuid WHERE book_id IS NULL AND user_sub IS NOT NULL`,
      `UPDATE oshal_trading_decisions SET book_id = md5('oshal-book:'||user_sub||':'||mode)::uuid WHERE book_id IS NULL AND user_sub IS NOT NULL`,
      `UPDATE oshal_trading_orders SET book_id = md5('oshal-book:'||user_sub||':'||mode)::uuid WHERE book_id IS NULL AND user_sub IS NOT NULL`,
      `UPDATE oshal_trading_predictions SET book_id = md5('oshal-book:'||user_sub||':'||mode)::uuid WHERE book_id IS NULL AND user_sub IS NOT NULL`,
      // Book-scoped unique arbiters COEXIST with the mode-scoped ones until PR4 (the bijection
      // makes any old-index violation a new-index conflict too; a rolled-back image still finds
      // its ON CONFLICT (user_sub, mode, …) targets). The 07-08 clobber + 08-18 twin-order
      // classes stay double-covered: book in the KEY TEXT (requestId ref) and in the INDEX.
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_signals_dedup_book ON oshal_trading_signals (user_sub, book_id, content_hash)',
      'CREATE INDEX IF NOT EXISTS idx_trd_signals_user_book ON oshal_trading_signals (user_sub, book_id, observed_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_trd_decisions_user_book ON oshal_trading_decisions (user_sub, book_id, created_at DESC)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_orders_client_book ON oshal_trading_orders (user_sub, book_id, client_order_id)',
      'CREATE INDEX IF NOT EXISTS idx_trd_pred_open_book ON oshal_trading_predictions (book_id, created_at) WHERE resolved = false',
    ],
    requirements: [
      {
        table: 'oshal_trading_signals',
        columns: ['signal_id', 'user_sub', 'mode', 'book_id', 'source', 'external_id', 'author', 'url', 'title', 'body', 'symbols', 'indicators', 'content_hash', 'observed_at'],
      },
      {
        table: 'oshal_trading_decisions',
        columns: [
          'decision_id',
          'user_sub',
          'mode',
          'book_id',
          'signal_ids',
          'agent_id',
          'action',
          'symbol',
          'side',
          'qty',
          'order_type',
          'limit_price',
          'confidence',
          'rationale',
          'indicators',
          'guardrails',
          'created_at',
          'stop_price',
          'trail_price',
          'trail_percent',
          'time_in_force',
        ],
      },
      {
        table: 'oshal_trading_orders',
        columns: [
          'order_id',
          'user_sub',
          'mode',
          'book_id',
          'decision_id',
          'broker',
          'broker_order_id',
          'client_order_id',
          'symbol',
          'side',
          'qty',
          'order_type',
          'limit_price',
          'status',
          'raw_status',
          'filled_qty',
          'filled_avg_price',
          'realized_pnl',
          'reject_reason',
          'submitted_at',
          'created_at',
          'updated_at',
          'stop_price',
          'trail_price',
          'trail_percent',
          'time_in_force',
        ],
      },
      {
        table: 'oshal_trading_predictions',
        columns: [
          'prediction_id',
          'user_sub',
          'mode',
          'book_id',
          'symbol',
          'algo',
          'pred_dir',
          'confidence',
          'price',
          'basis',
          'horizon_hrs',
          'resolved',
          'actual_dir',
          'actual_price',
          'hit',
          'created_at',
          'resolved_at',
        ],
      },
    ],
  });
}
