/**
 * Free-tier provider catalog — the "bank of free tokens" source list (ADR-064).
 *
 * The decision (ADR-064): we do NOT pool one account's signup credits. Instead each
 * user connects their OWN free tier across many providers, and the platform rotates
 * across them. Every provider here exposes an OpenAI-compatible `/chat/completions`
 * endpoint, so one validation/rotation path covers all of them, and every provider id
 * is one Cline CLI already understands — so resolution just hands Cline the provider +
 * model + key (+ base URL), and Cline makes the real call (ADR-005).
 *
 * This file is pure data + helpers (no I/O), so it stays trivially testable and well
 * under the file-size cap. The connect/rotate engine is in free-tier-rotation.ts and
 * the HTTP surface is free-tier-routes.ts.
 *
 * NOTE ON MODEL IDS: provider free-model ids drift over time. `freeModels[0]` is just a
 * sensible default; a user can override the model on connect, and the rotation engine
 * stores whatever model the connection was validated with.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial catalog (OpenRouter, Gemini/AI Studio, Groq, Cerebras, Mistral) for ADR-064 free-tier connect + rotation.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Gemini freeModels refreshed — Google zeroed free quota on gemini-2.0-flash (429 limit:0) and retired the 1.5 family (404), so every candidate was dead; live-probed replacements led by the self-updating gemini-flash-lite-latest alias.
 *
 * @module free-tier-providers
 */

/** Provider-column prefix in oshal_connections for a free-tier connection ("free:groq"). */
export const FREE_PROVIDER_PREFIX = 'free:';

/** One connectable free-tier provider. */
export interface FreeProvider {
  /** Our short id (also the suffix in the `free:<id>` provider column). */
  id: string;
  /** Human label for the connect UI. */
  label: string;
  /** Provider id Cline CLI understands — what we hand the harness on resolution. */
  clineProvider: string;
  /** OpenAI-compatible base URL (no trailing slash, no /chat/completions). */
  baseUrl: string;
  /** Candidate free models; `[0]` is the default offered on connect. */
  freeModels: string[];
  /** Deep link to where the user creates a key (fast because they're often already signed in). */
  keyHelpUrl: string;
  /** True when the provider supports an OAuth key-provisioning flow (only OpenRouter today). */
  oauth: boolean;
  /** One-line note shown in the connect UI. */
  note: string;
  /** One-line "what's free" blurb for the walkthrough page. */
  freeBlurb: string;
  /** Ordered, plain-language steps to get a key and connect (rendered on the walkthrough page). */
  howTo: string[];
}

/**
 * The catalog. Keyed by id. OpenAI-compatible endpoints verified by shape (every entry
 * answers `POST {baseUrl}/chat/completions` with a Bearer key).
 */
export const FREE_PROVIDERS: Record<string, FreeProvider> = {
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    clineProvider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    // Live-verified 2026-07-08: gemini-2.0-flash-exp:free and deepseek-chat:free had 404'd
    // (delisted / moved to paid). Refreshed to currently-live :free models. OpenRouter's free
    // catalog churns — keep this fresh; runtime discovery from GET /models is the durable fix (BACKLOG).
    freeModels: [
      'openai/gpt-oss-20b:free',
      'openai/gpt-oss-120b:free',
      'meta-llama/llama-3.3-70b-instruct:free',
    ],
    keyHelpUrl: 'https://openrouter.ai/keys',
    oauth: true,
    note: 'One-click OAuth connect; free `:free` models out of the box.',
    freeBlurb: 'Free `:free` models (rate-limited). The only true one-click connect here.',
    howTo: [
      'Click "Connect with OpenRouter" — you are sent to OpenRouter to approve (signing up on the spot is fine; no copy/paste).',
      'Approve the connection.',
      'You land back here, connected. The free `:free` models are immediately usable.',
      'Worth it: a one-time $10 credit at openrouter.ai/credits lifts your free allowance from 50 to 1,000 requests/day — `:free` models never spend the $10, it only raises the ceiling.',
      'Prefer a key? Create one at openrouter.ai/keys and paste it instead.',
    ],
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini (AI Studio)',
    clineProvider: 'gemini',
    // Google's OpenAI-compatibility endpoint (Bearer = AI Studio key).
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    // Google moves free quota between generations (2.0-flash went to 429 limit:0 and the
    // 1.5 family 404s — live-probed 2026-07-11). Lead with their self-updating "-latest"
    // alias so the lane survives the next rotation without a code change.
    freeModels: ['gemini-flash-lite-latest', 'gemini-3.1-flash-lite'],
    keyHelpUrl: 'https://aistudio.google.com/apikey',
    oauth: false,
    note: 'Signing in with Google does NOT grant this — paste an AI Studio key (fast: you are already signed in).',
    freeBlurb: 'Generous free tier on Gemini Flash models.',
    howTo: [
      'Open Google AI Studio (button below) — you are probably already signed into Google.',
      'Click "Create API key" and copy it.',
      'Paste the key below and click Connect.',
      'Note: "Sign in with Google" on this site does NOT grant the key — this paste is the step.',
    ],
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    clineProvider: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    freeModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    keyHelpUrl: 'https://console.groq.com/keys',
    oauth: false,
    note: 'Very fast inference; generous free tier. Paste a key.',
    freeBlurb: 'Free tier, extremely fast inference.',
    howTo: [
      'Open the Groq console (button below) and sign up — it is free.',
      'Go to API Keys, create one, and copy it.',
      'Paste the key below and click Connect.',
    ],
  },
  cerebras: {
    id: 'cerebras',
    label: 'Cerebras',
    clineProvider: 'cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    // Live-probed 2026-07-11: Cerebras retired the llama-3.x ids entirely (GET /models now lists
    // only these three). gpt-oss-120b leads — it is the most capable and it answers free here;
    // note it is a REASONING model, so a tiny-max_tokens probe can come back 200-but-empty.
    freeModels: ['gpt-oss-120b', 'gemma-4-31b', 'zai-glm-4.7'],
    keyHelpUrl: 'https://cloud.cerebras.ai/',
    oauth: false,
    note: 'Fastest open-model inference; free tier. Paste a key.',
    freeBlurb: 'Free tier; the fastest open-model inference available.',
    howTo: [
      'Open Cerebras Cloud (button below) and sign up — it is free.',
      'Create an API key under API Keys and copy it.',
      'Paste the key below and click Connect.',
    ],
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral',
    clineProvider: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    freeModels: ['mistral-small-latest', 'open-mistral-nemo'],
    keyHelpUrl: 'https://console.mistral.ai/api-keys/',
    oauth: false,
    note: 'Free experimental tier on la Plateforme. Paste a key.',
    freeBlurb: 'Free experimental tier on la Plateforme.',
    howTo: [
      'Open the Mistral console (button below) and sign up.',
      'Create a key under API Keys (the experimental tier is free).',
      'Paste the key below and click Connect.',
    ],
  },
};

/** OpenRouter OAuth (PKCE) endpoints. Verified against OpenRouter's OAuth-PKCE docs 2026-06-21.
 *  CALLBACK CONSTRAINT: OpenRouter only allows callback URLs that are HTTPS on port 443 or 3000,
 *  OR any localhost port. So the OAuth connect works on the public HTTPS origin (or local dev);
 *  on an odd non-localhost port it will be rejected by OpenRouter — paste-key (/connect) is the
 *  always-works fallback. The response from keyExchangeUrl is `{ key, user_id }` (we read `key`). */
export const OPENROUTER_OAUTH = {
  /** Where we send the user to approve; we append callback_url + PKCE challenge (S256). */
  authUrl: 'https://openrouter.ai/auth',
  /** Where we exchange { code, code_verifier } for a provisioned API key. */
  keyExchangeUrl: 'https://openrouter.ai/api/v1/auth/keys',
};

/** Resolve a catalog entry by our id, or undefined. */
export function getFreeProvider(id: string): FreeProvider | undefined {
  return FREE_PROVIDERS[String(id || '').trim().toLowerCase()];
}

/** Map a stored provider column ("free:groq") back to its catalog id ("groq"), or '' if not a
 *  free-tier provider. */
export function freeIdFromProviderColumn(providerColumn: string): string {
  const p = String(providerColumn || '');
  return p.startsWith(FREE_PROVIDER_PREFIX) ? p.slice(FREE_PROVIDER_PREFIX.length) : '';
}

/** The provider-column value we store for a given catalog id ("groq" -> "free:groq"). */
export function providerColumnFor(id: string): string {
  return `${FREE_PROVIDER_PREFIX}${id}`;
}

/** Short host label for display ("api.groq.com"). */
export function hostOf(baseUrl: string): string {
  try { return new URL(baseUrl).host; } catch { return baseUrl; }
}
