-- 065-trading-orders-book-scoped-idempotency.sql
--
-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ                 | AUTHOR                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Scope the order idempotency key to the BOOK: (user_sub, client_order_id) -> (user_sub, mode, client_order_id).
--
-- WHY
-- The paper and live books fire on the same 5-min autopilot tick, and the autopilot's requestId
-- (`auto-<ISO minute>-<SYM>-<side>`) carried no book, so both produced the SAME client_order_id for
-- a symbol. The unique index omitted `mode`, so the second order did not insert a row — it hit
-- recordOrder's ON CONFLICT and OVERWROTE the first. On 2026-07-08 a paper Alpaca fill clobbered the
-- broker_order_id of a real LIVE Schwab AMD sell, replacing a numeric Schwab id with an Alpaca UUID.
-- That live row could never be reconciled again (Schwab 400s the UUID) and stayed 'pending' forever,
-- which in turn kept the symbol inside IN_FLIGHT_STATUSES and blocked its future exits.
--
-- Idempotency is per book. Mirrors oshal_trading_signals, already keyed (user_sub, mode, content_hash).
-- The new index is strictly more permissive, so it cannot fail on existing rows.
-- Matches the runtime bootstrap in src/app/trading-schema.ts (ensureTradingSchema).

DROP INDEX IF EXISTS idx_trd_orders_client;

CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_orders_client_mode
  ON oshal_trading_orders (user_sub, mode, client_order_id);
