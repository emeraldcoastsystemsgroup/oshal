-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Stock-trading swarm
--   (ADR-052). The signal -> decision -> order provenance chain, so every trade is
--   justified and traceable back to the data stream that triggered it. Three owner-scoped
--   stores, all keyed by (user_sub, mode) where mode IN ('paper','live') = the two
--   first-class ledgers. The chain is enforced in SQL: oshal_trading_orders.decision_id is
--   NOT NULL + FK -> oshal_trading_decisions, and a decision records the signal_ids it
--   reasoned over. An order with no justifying decision is therefore unrepresentable.
--   Broker credentials are NOT stored here — the adapter reads per-mode Alpaca keys from
--   the environment (operator account), exactly like the Stripe payment rail.
-- -----------------------------------------------------------------------------

-- 1) SIGNALS — the immutable snapshot of a data-stream event at decision time.
--    "If it reads a tweet and decides the market could move, it keeps the tweet."
CREATE TABLE IF NOT EXISTS oshal_trading_signals (
    signal_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_sub      TEXT NOT NULL,
    mode          TEXT NOT NULL CHECK (mode IN ('paper','live')),
    source        TEXT NOT NULL,            -- 'news' | 'x' | 'inbox' | 'manual'
    external_id   TEXT,                     -- source-native id (e.g. tweet id) for back-reference
    author        TEXT,                     -- e.g. '@realDonaldTrump' or the publisher
    url           TEXT,                     -- link to the original artifact
    title         TEXT,                     -- headline / short form
    body          TEXT,                     -- the captured artifact text (the tweet/story body)
    symbols       TEXT[],                   -- tickers the signal references / was tagged with
    indicators    JSONB,                    -- price/%move/volume/sentiment observed at this instant
    content_hash  TEXT NOT NULL,            -- dedup key for the same artifact
    observed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trd_signals_user_mode ON oshal_trading_signals (user_sub, mode, observed_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_signals_dedup ON oshal_trading_signals (user_sub, mode, content_hash);

-- 2) DECISIONS — the decision tree. References the signal(s) it reasoned over and records
--    the bot's structured rationale. A decision may resolve to NO trade (action='hold') —
--    a justified non-action is auditable too.
CREATE TABLE IF NOT EXISTS oshal_trading_decisions (
    decision_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_sub      TEXT NOT NULL,
    mode          TEXT NOT NULL CHECK (mode IN ('paper','live')),
    signal_ids    UUID[] NOT NULL,          -- the signals that triggered this decision (>=1)
    agent_id      TEXT,                     -- the trading-analyst bot that produced it
    action        TEXT NOT NULL,            -- 'buy' | 'sell' | 'hold'
    symbol        TEXT,                     -- ticker (null when action='hold' with no target)
    side          TEXT,                     -- 'buy' | 'sell' (null for hold)
    qty           NUMERIC(18,6),            -- proposed share quantity
    order_type    TEXT,                     -- 'market' | 'limit'
    limit_price   NUMERIC(18,4),            -- for limit orders
    confidence    NUMERIC(5,4),             -- [0,1] the bot's stated confidence
    rationale     TEXT NOT NULL,            -- the human-readable decision tree / justification
    indicators    JSONB,                    -- the indicators weighed (decision-tree inputs)
    guardrails    JSONB,                    -- guardrail checks applied + their results
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT trd_decisions_has_signal CHECK (array_length(signal_ids, 1) >= 1),
    CONSTRAINT trd_decisions_action CHECK (action IN ('buy','sell','hold'))
);
CREATE INDEX IF NOT EXISTS idx_trd_decisions_user_mode ON oshal_trading_decisions (user_sub, mode, created_at DESC);

-- 3) ORDERS — the executed leg + the ledger entry. EVERY order REQUIRES a decision_id
--    (NOT NULL + FK): no justification, no trade. Positions/P&L per (user_sub, mode) derive
--    from this table. Same schema serves both books; queries filter by mode.
CREATE TABLE IF NOT EXISTS oshal_trading_orders (
    order_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_sub        TEXT NOT NULL,
    mode            TEXT NOT NULL CHECK (mode IN ('paper','live')),
    decision_id     UUID NOT NULL REFERENCES oshal_trading_decisions (decision_id),
    broker          TEXT NOT NULL,          -- 'alpaca' | ...
    broker_order_id TEXT,                   -- broker-assigned id (null only on submit failure)
    client_order_id TEXT NOT NULL,          -- idempotency key (user_sub:requestId)
    symbol          TEXT NOT NULL,
    side            TEXT NOT NULL,          -- 'buy' | 'sell'
    qty             NUMERIC(18,6) NOT NULL,
    order_type      TEXT NOT NULL,          -- 'market' | 'limit'
    limit_price     NUMERIC(18,4),
    status          TEXT NOT NULL,          -- normalized OrderStatus
    raw_status      TEXT,                   -- broker-native status verbatim
    filled_qty      NUMERIC(18,6) NOT NULL DEFAULT 0,
    filled_avg_price NUMERIC(18,4),
    realized_pnl    NUMERIC(18,4),          -- set when a closing fill is reconciled
    reject_reason   TEXT,
    submitted_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trd_orders_user_mode ON oshal_trading_orders (user_sub, mode, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trd_orders_decision  ON oshal_trading_orders (decision_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trd_orders_client ON oshal_trading_orders (user_sub, client_order_id);
