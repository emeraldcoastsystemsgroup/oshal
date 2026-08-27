-- 125-trading-books-cutover.sql — ADR-134 PR4: the side-store PK swaps a SECOND live book needs.
--
-- NOT applied at boot. Executed exclusively by scripts/trading-books-cutover.sh AFTER its
-- preconditions pass (zero NULL book_ids; discovery linked; operator --arm). Until this runs, the
-- legacy (user_sub, mode[, …]) PRIMARY KEYs make any second-live-book side-store write raise
-- unique_violation — which the PR1 engine reads FAIL-CLOSED (entries halt), safe but dead.
--
-- Each swap: drop the legacy mode-keyed PK and promote the book-scoped unique index (created in
-- PR1, already backfilled and agreeing under the bijection) to PRIMARY KEY. Guarded DO-blocks —
-- re-running is a no-op. The orders/signals/decisions tables keep BOTH unique indexes until the
-- follow-up hardening migration (their legacy indexes don't block a second book: mode is not
-- their full key).

DO $$
BEGIN
  -- equity_hwm: PK (user_sub, mode) → (user_sub, book_id)
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oshal_trading_equity_hwm_pkey'
               AND conrelid = 'oshal_trading_equity_hwm'::regclass
               AND pg_get_constraintdef(oid) LIKE '%(user_sub, mode)%') THEN
    ALTER TABLE oshal_trading_equity_hwm DROP CONSTRAINT oshal_trading_equity_hwm_pkey;
    ALTER TABLE oshal_trading_equity_hwm ALTER COLUMN book_id SET NOT NULL;
    ALTER TABLE oshal_trading_equity_hwm ADD CONSTRAINT oshal_trading_equity_hwm_pkey PRIMARY KEY USING INDEX idx_trd_hwm_book;
  END IF;

  -- rotation_state: PK (user_sub, mode) → (user_sub, book_id)
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oshal_trading_rotation_state_pkey'
               AND conrelid = 'oshal_trading_rotation_state'::regclass
               AND pg_get_constraintdef(oid) LIKE '%(user_sub, mode)%') THEN
    ALTER TABLE oshal_trading_rotation_state DROP CONSTRAINT oshal_trading_rotation_state_pkey;
    ALTER TABLE oshal_trading_rotation_state ALTER COLUMN book_id SET NOT NULL;
    ALTER TABLE oshal_trading_rotation_state ADD CONSTRAINT oshal_trading_rotation_state_pkey PRIMARY KEY USING INDEX idx_trd_rotation_book;
  END IF;

  -- daily_equity: PK (user_sub, mode, et_day) → (user_sub, book_id, et_day)
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oshal_trading_daily_equity_pkey'
               AND conrelid = 'oshal_trading_daily_equity'::regclass
               AND pg_get_constraintdef(oid) LIKE '%(user_sub, mode, et_day)%') THEN
    ALTER TABLE oshal_trading_daily_equity DROP CONSTRAINT oshal_trading_daily_equity_pkey;
    ALTER TABLE oshal_trading_daily_equity ALTER COLUMN book_id SET NOT NULL;
    ALTER TABLE oshal_trading_daily_equity ADD CONSTRAINT oshal_trading_daily_equity_pkey PRIMARY KEY USING INDEX idx_trd_daily_eq_book;
  END IF;

  -- peaks: PK (user_sub, mode, symbol) → (user_sub, book_id, symbol)
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oshal_trading_peaks_pkey'
               AND conrelid = 'oshal_trading_peaks'::regclass
               AND pg_get_constraintdef(oid) LIKE '%(user_sub, mode, symbol)%') THEN
    ALTER TABLE oshal_trading_peaks DROP CONSTRAINT oshal_trading_peaks_pkey;
    ALTER TABLE oshal_trading_peaks ALTER COLUMN book_id SET NOT NULL;
    ALTER TABLE oshal_trading_peaks ADD CONSTRAINT oshal_trading_peaks_pkey PRIMARY KEY USING INDEX idx_trd_peaks_book;
  END IF;

  -- gate_blocks: PK (user_sub, mode, gate, symbol, et_day) → (user_sub, book_id, gate, symbol, et_day)
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oshal_trading_gate_blocks_pkey'
               AND conrelid = 'oshal_trading_gate_blocks'::regclass
               AND pg_get_constraintdef(oid) LIKE '%(user_sub, mode, gate, symbol, et_day)%') THEN
    ALTER TABLE oshal_trading_gate_blocks DROP CONSTRAINT oshal_trading_gate_blocks_pkey;
    ALTER TABLE oshal_trading_gate_blocks ALTER COLUMN book_id SET NOT NULL;
    ALTER TABLE oshal_trading_gate_blocks ADD CONSTRAINT oshal_trading_gate_blocks_pkey PRIMARY KEY USING INDEX idx_trd_gate_blocks_book;
  END IF;
END $$;
