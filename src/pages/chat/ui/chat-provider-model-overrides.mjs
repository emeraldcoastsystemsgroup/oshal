/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Synced the chat modal OpenAI Codex model list to current upstream Cline so GPT-5.4/5.3/5.2/5.1 Codex variants appear instead of stale GPT-4.x entries
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Extracted hardcoded provider model-catalog overrides from the oversized chat config modal so provider inventory logic no longer lives directly inside the monolithic controller
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added gpt-4.5 to openai-codex model list per Cline VS Code plugin alignment
 */

/**
 * @description Provider-specific model catalog overrides used by the standalone
 * chat configuration workspace when backend provider metadata is incomplete or
 * intentionally curated for a given provider experience.
 */
export const API_PROVIDER_MODEL_OVERRIDES = {
  'openai-codex': [
    { id: 'gpt-5.4', name: 'GPT-5.4' },
    { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
    { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex' },
    { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max' },
    { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini' },
    { id: 'gpt-5.2', name: 'GPT-5.2' },
  ],
};
