/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com   | Keep the persisted ADR-127 provider vocabulary in sync with the resolver: Gemini CLI and Antigravity CLI were added to the application enum, but the original database CHECK still rejected both values.
 */

ALTER TABLE oshal_user_llm_prefs
  DROP CONSTRAINT IF EXISTS oshal_user_llm_prefs_preferred_provider_check;

ALTER TABLE oshal_user_llm_prefs
  ADD CONSTRAINT oshal_user_llm_prefs_preferred_provider_check
  CHECK (preferred_provider IN (
    'auto',
    'claude-code',
    'openai-codex',
    'gemini-cli',
    'antigravity-cli',
    'any-llm',
    'free-tier'
  ));
