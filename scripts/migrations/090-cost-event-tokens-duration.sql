-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ                 | AUTHOR                                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Per-call observability on the cost ledger (BACKLOG: run traces show per-LLM-call cost but not tokens/durations). oshal_cost_events (078) carried only cost_usd, so a trace's llm-call spans could never show a token split or how long the call took even though every producer already KNOWS the tokens at emit time (CostEvent.inputTokens/outputTokens feed the chat_tasks rollup) and the execution handlers already measure wall-clock duration. Three additive NULLABLE columns — NULL means "the producer did not know", never 0 — so pre-090 rows stay honest and windowed budget reads (which sum only cost_usd) are unaffected.

-- input_tokens/output_tokens: this event's token split, mirroring the same numbers the
-- chat_tasks lifetime rollup accumulates. BIGINT to match long-session token counts.
-- duration_ms: wall-clock duration of the LLM execution this event bills, when the
-- producer measured one (the bot-node/legacy execution handlers time the run; marker
-- rows like the Argo onExit run marker have no call to time and stay NULL).
ALTER TABLE oshal_cost_events ADD COLUMN IF NOT EXISTS input_tokens  BIGINT;
ALTER TABLE oshal_cost_events ADD COLUMN IF NOT EXISTS output_tokens BIGINT;
ALTER TABLE oshal_cost_events ADD COLUMN IF NOT EXISTS duration_ms   INTEGER;
