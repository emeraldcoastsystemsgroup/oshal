-- 153-trading-book-arm-acknowledgement.sql — the arming acknowledgement a second autopilot leg needs.
--
-- BACKLOG: "Arming a second autopilot leg is a deliberate, gated act". A schedule resolves exactly
-- ONE book, from its own taskData, and never enumerates enabled books — so enabling a second book is
-- inert for trading. That safety was a property of the dispatch code with nothing standing between a
-- hand-written schedule row and an account full of positions the engine never opened. These columns
-- are where the deliberate act is recorded; src/app/trading-schedule-dispatch.ts hard-skips a fire
-- for any NON-LEGACY book whose arm_ack_at is NULL.
--
-- NULL is the only "not acknowledged" state there is: a BOOLEAN DEFAULT false would have been
-- back-filled onto every existing book as a decision nobody made, and WHEN it was recorded is what
-- an audit reads. The two legacy books ('paper'/'live') never carry the gate — they are the first
-- leg, already armed — so this migration changes the behaviour of nothing that is running today.
--
-- Mirrors the runtime rail in src/app/trading-books-store.ts (ADR-134 D1 dual-rail convergence);
-- every statement is idempotent and the runtime rail converges to the identical shape.

DO $$
BEGIN
  IF to_regclass('oshal_trading_books') IS NULL THEN RETURN; END IF;
  ALTER TABLE oshal_trading_books ADD COLUMN IF NOT EXISTS arm_ack_at   TIMESTAMPTZ;
  ALTER TABLE oshal_trading_books ADD COLUMN IF NOT EXISTS arm_ack_by   TEXT;
  ALTER TABLE oshal_trading_books ADD COLUMN IF NOT EXISTS arm_ack_note TEXT;
END $$;
