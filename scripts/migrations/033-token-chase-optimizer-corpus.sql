-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase optimizer corpus
--   (ADR-046 step 3/4). One APPEND-ONLY row per variant replay observation: a captured call
--   re-fired on a different model, with the measured trade-off (cost vs the priced baseline,
--   latency, accuracy = similarity to the captured output, and the swap verdict). This is the
--   training substrate for the eventual selection policy ("given this kind of query + what's
--   available, pick this model+harness"). Single-tenant now; tenant_id reserved like 032/031.
--   No provider keys here — variant lanes reuse the per-user oshal_connections BYO store.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS token_chase_optimizer_corpus (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          TEXT NOT NULL DEFAULT 'default',
    user_sub           TEXT NOT NULL,
    run_id             TEXT NOT NULL,            -- captured run (task workspace) id
    seq                INTEGER NOT NULL,         -- call sequence within the run
    query_type         TEXT,                     -- coarse class of the call (heuristic; refined later)
    harness            TEXT,                     -- baseline harness that produced the captured call
    baseline_provider  TEXT,                     -- captured provider
    baseline_model     TEXT,                     -- captured model
    baseline_cost_usd  NUMERIC(12,6),            -- priced from captured tokens
    variant_provider   TEXT,                     -- lane provider the replay fired on
    variant_model      TEXT NOT NULL,            -- lane model the replay fired on
    cost_usd           NUMERIC(12,6),            -- variant cost (reported or estimated)
    cost_delta_usd     NUMERIC(12,6),            -- variant minus baseline (negative = cheaper)
    latency_ms         INTEGER,                  -- variant latency
    accuracy           NUMERIC(6,4),             -- similarity of variant output to captured baseline [0,1]
    equivalent         BOOLEAN,                  -- variant within semantic tolerance of baseline
    tier               TEXT,                     -- equivalent-cheaper | equivalent-pricier | divergent
    complexity         TEXT,                     -- low | medium | high (heuristic from prompt size/tools)
    tools_used         TEXT[],                   -- tool names available on the captured call
    status             TEXT,                     -- replay status (graded verdict or excluded reason)
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tc_corpus_user  ON token_chase_optimizer_corpus(user_sub);
CREATE INDEX IF NOT EXISTS idx_tc_corpus_query ON token_chase_optimizer_corpus(query_type);
CREATE INDEX IF NOT EXISTS idx_tc_corpus_model ON token_chase_optimizer_corpus(variant_model);
CREATE INDEX IF NOT EXISTS idx_tc_corpus_run   ON token_chase_optimizer_corpus(run_id, seq);
