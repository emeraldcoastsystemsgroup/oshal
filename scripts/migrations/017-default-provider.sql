/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block
 */

-- =============================================================================
-- Migration 017: Resolve "auto" provider to the runtime default
-- =============================================================================
-- Resolves "auto" provider/model to the actual runtime default so the cockpit
-- and all UI surfaces display the correct provider without fallback logic.
-- =============================================================================

UPDATE agents
SET api_provider_id = COALESCE(NULLIF(current_setting('app.llm_provider', true), ''), 'openai-codex'),
    model_id = COALESCE(NULLIF(current_setting('app.llm_model', true), ''), 'gpt-4.1'),
    updated_at = NOW()
WHERE api_provider_id = 'auto' OR api_provider_id IS NULL OR api_provider_id = '';
