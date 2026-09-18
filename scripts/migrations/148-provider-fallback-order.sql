/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The FALLBACK ORDER is a row too (operator, 2026-09-18). Migration 147 made provider SELECTION a switch in a table and left FAILOVER as a hardcoded literal in src/app/bot-node-runtime.ts: a three-name union type and a Record whose values were ['cline-cli'] / ['openai-codex','cline-cli'] / ['openai-codex']. A provider outside those three could not be a fallback at all, an administrator could not reorder the chain, and a 2026-08-13 policy decision about one vendor's subscription was encoded as a comment plus a missing array entry — so when that vendor ran out of tokens the only remaining backup was a second vendor that also ran out, and there was no configuration anywhere that could say otherwise. This column is the same fix migration 147 applied one rung up: the administrator names as many providers as they want, in the order they want, and no code names any of them.
 */

-- =============================================================================
-- Migration 148: the provider fallback ORDER, on the switch rows
-- Same table, same precedence rule as the provider id itself
-- (src/shared/llm-runtime/bot-provider-switch.ts): a bot's own row, else the
-- fleet-default row, else an env override, else no failover at all.
-- Carries no secret: these are provider IDS, validated by the api against the
-- same runnable catalog the provider_id column is validated against.
-- =============================================================================

ALTER TABLE oshal_bot_provider_switch
  ADD COLUMN IF NOT EXISTS fallback_order TEXT[];

-- An empty array is a DELIBERATE "no failover, fail visibly" and must stay
-- distinguishable from NULL ("inherit the next rung"). What is refused is a
-- blank or whitespace-bearing id, the shapes no validator would ever produce —
-- the same CHECK shape provider_id already carries.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oshal_bot_provider_switch_fallback_order'
  ) THEN
    ALTER TABLE oshal_bot_provider_switch
      ADD CONSTRAINT oshal_bot_provider_switch_fallback_order CHECK (
        fallback_order IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM unnest(fallback_order) AS entry
          WHERE btrim(entry) = '' OR entry ~ '\s'
        )
      );
  END IF;
END $$;

COMMENT ON COLUMN oshal_bot_provider_switch.fallback_order IS
  'Ordered provider ids to try when the selected provider fails in a way the failure classifier calls eligible (throttle, quota, auth, runtime stall). Same id vocabulary as provider_id: a harness key or a Cline-backed API provider id, validated by the api against the runnable catalog. NULL = inherit the next precedence rung (bot row -> fleet row -> env -> no failover). An EMPTY array = no failover, deliberately: fail visibly rather than spend on a second vendor. No code names a provider; this column is the whole chain.';
