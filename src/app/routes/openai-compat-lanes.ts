/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted the OpenAI-compatible framework-lane catalog (base URL + key env vars) out of optimizer-providers so the free-tier resolver can build an OPERATOR-KEY lane from the same table instead of duplicating endpoints. Adds a default model per lane and the operator lane order.
 */

/** @description One OpenAI-compatible vendor endpoint the platform can call with a process env key. */
export interface OpenAiCompatLane {
  /** OpenAI-compatible base URL (no trailing `/chat/completions`). */
  baseUrl: string;
  /** Env var names holding a usable key, in preference order. */
  envKeys: string[];
  /**
   * Model used when the caller pins no model. Kept conservative (cheap/fast tiers) because this is
   * the id an unattended resolver will run without a human choosing it.
   */
  defaultModel?: string;
}

/**
 * @description Base URL + key env vars for framework providers that speak the OpenAI wire format.
 * Consumed by the Token Chase optimizer (ephemeral replay lanes) and by the operator-key resolver
 * in free-tier-rotation. One table, so a new vendor endpoint is added in exactly one place.
 */
export const OPENAI_COMPAT_LANES: Record<string, OpenAiCompatLane> = {
  openai: { baseUrl: 'https://api.openai.com/v1', envKeys: ['OPENAI_API_KEY'], defaultModel: 'gpt-4o-mini' },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    defaultModel: 'gemini-2.5-flash',
  },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', envKeys: ['OPENROUTER_API_KEY'] },
  deepseek: { baseUrl: 'https://api.deepseek.com', envKeys: ['DEEPSEEK_API_KEY'], defaultModel: 'deepseek-chat' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', envKeys: ['GROQ_API_KEY'], defaultModel: 'llama-3.3-70b-versatile' },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', envKeys: ['MISTRAL_API_KEY'], defaultModel: 'mistral-small-latest' },
  cerebras: { baseUrl: 'https://api.cerebras.ai/v1', envKeys: ['CEREBRAS_API_KEY'], defaultModel: 'gpt-oss-120b' },
  xai: { baseUrl: 'https://api.x.ai/v1', envKeys: ['XAI_API_KEY'], defaultModel: 'grok-3-mini' },
  together: {
    baseUrl: 'https://api.together.xyz/v1',
    envKeys: ['TOGETHER_API_KEY', 'TOGETHERAI_API_KEY'],
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },
};

/**
 * @description Lane preference order for the OPERATOR's own turns, most-capable-per-dollar first.
 * OpenRouter is deliberately absent: that key is the shared ADR-064 platform free-fallback and is
 * hard-guarded to `:free` model ids, so it is not an operator BYOK lane.
 */
export const DEFAULT_OPERATOR_LANE_ORDER = ['gemini', 'groq', 'cerebras', 'mistral', 'openai'];

/**
 * @description First non-empty process-env key for a lane.
 * @param lane - the catalog entry to resolve a key for
 * @returns the key string, or null when this deployment has none of the lane's env vars set
 */
export function laneKeyFromEnv(lane: OpenAiCompatLane): string | null {
  for (const name of lane.envKeys) {
    const value = (process.env[name] || '').trim();
    if (value) return value;
  }
  return null;
}
