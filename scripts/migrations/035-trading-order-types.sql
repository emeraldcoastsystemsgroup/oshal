-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Trading order-type
--   expansion (ADR-052 paper-scope). The original 034 stored order_type + limit_price only
--   (market/limit, long-only). To test the full trade matrix on the PAPER book we widen to the
--   complete Alpaca equity set — stop, stop_limit, trailing_stop — plus shorting. These columns
--   carry the extra price params + time-in-force on both the decision (what the bot proposed)
--   and the order (what was placed). Idempotent ADD COLUMN IF NOT EXISTS so it is safe whether
--   or not 034 has been applied yet.
-- -----------------------------------------------------------------------------

ALTER TABLE oshal_trading_decisions ADD COLUMN IF NOT EXISTS stop_price    NUMERIC(18,4);
ALTER TABLE oshal_trading_decisions ADD COLUMN IF NOT EXISTS trail_price   NUMERIC(18,4);
ALTER TABLE oshal_trading_decisions ADD COLUMN IF NOT EXISTS trail_percent NUMERIC(8,4);
ALTER TABLE oshal_trading_decisions ADD COLUMN IF NOT EXISTS time_in_force TEXT;

ALTER TABLE oshal_trading_orders ADD COLUMN IF NOT EXISTS stop_price    NUMERIC(18,4);
ALTER TABLE oshal_trading_orders ADD COLUMN IF NOT EXISTS trail_price   NUMERIC(18,4);
ALTER TABLE oshal_trading_orders ADD COLUMN IF NOT EXISTS trail_percent NUMERIC(8,4);
ALTER TABLE oshal_trading_orders ADD COLUMN IF NOT EXISTS time_in_force TEXT;
