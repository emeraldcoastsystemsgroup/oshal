/**
 * Optimizer provider resolution — the lanes the Token Chase optimizer can replay a captured call on.
 *
 * Every replay runs through the bot node's /api/token-chase/replay-call (the framework's native variant
 * path). The deployed bots run the lean "bot-node" runtime, which has NO /api/llm-provider — so we never
 * switch a bot's provider. Two lane kinds:
 *   - `current`: replay on the bot's OWN configured provider (its default login, e.g. Claude Code) — no
 *     extra creds; the bot uses getActiveProvider.
 *   - `byo`: replay on an ephemeral OpenAI-compatible endpoint+key+model the bot is handed for that one
 *     call. Sourced from (a) the caller's Bring-Your-Own-LLM connections, and (b) framework providers
 *     that expose an OpenAI-compatible endpoint AND have a resolvable key on this instance.
 *
 * Framework providers with non-OpenAI APIs (Vertex, native Anthropic) or OAuth-only logins are NOT
 * offered as `byo` lanes — the lean bot can't drive them ephemerally. The default login still runs via
 * `current`. The roster comes from the framework's own `listConfiguredProviders()`.
 *
 * SPEND GUARD (2026-07-11): when the openrouter lane resolves to the PLATFORM's shared
 * `OPENROUTER_API_KEY` (the ADR-064 free-fallback key, now carrying real credit), the lane is
 * coerced to platformFreeConnection()'s probed-live `:free` model — never the registry's paid
 * default. The operator directive behind commit 791286de applies here too: the platform key only
 * ever runs `:free` models. A user's own BYO OpenRouter connection is untouched.
 *
 * @module optimizer-providers
 */

import fs from 'node:fs';
import path from 'node:path';
import { createChildLogger } from '@/shared/logger';
import { listConfiguredProviders } from './provider-routes';
import { getUserLlmConnection, buildAnyLlmListEntry, ANY_LLM_PROVIDER } from './byo-llm-routes';
import { accessibleConnections } from './connector-tenancy';
import { platformFreeConnection } from './free-tier-rotation';

const logger = createChildLogger({ module: 'optimizer-providers' });

const FRAMEWORK_PREFIX = 'framework:';
const CURRENT_ID = 'current';

/** OpenAI-compatible base URL + key env vars for framework providers the bot CAN replay ephemerally. */
const COMPAT: Record<string, { baseUrl: string; envKeys: string[] }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', envKeys: ['OPENAI_API_KEY'] },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', envKeys: ['OPENROUTER_API_KEY'] },
  deepseek: { baseUrl: 'https://api.deepseek.com', envKeys: ['DEEPSEEK_API_KEY'] },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', envKeys: ['GROQ_API_KEY'] },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', envKeys: ['MISTRAL_API_KEY'] },
  cerebras: { baseUrl: 'https://api.cerebras.ai/v1', envKeys: ['CEREBRAS_API_KEY'] },
  xai: { baseUrl: 'https://api.x.ai/v1', envKeys: ['XAI_API_KEY'] },
  together: { baseUrl: 'https://api.together.xyz/v1', envKeys: ['TOGETHER_API_KEY', 'TOGETHERAI_API_KEY'] },
};

/** @description A login the optimizer can offer in its picker (no secrets — id + display + model). */
export interface OptimizerLogin {
  connectionId: string;
  label: string;
  model: string;
  kind: 'current' | 'byo' | 'framework';
  isDefault: boolean;
}

/** @description A resolved lane to replay against (carries the secret for `byo`). */
export type OptimizerLane =
  | { kind: 'current'; label: string }
  | { kind: 'byo'; baseUrl: string; model: string; apiKey: string; label: string };

/** @description Loads persisted global secrets (same store the Utilities provider panel reports from). */
function loadPersistedSecrets(): Record<string, unknown> {
  try {
    const configDir = process.env.CONFIG_OUTPUT_DIR || './output';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { EncryptedConfigManager } = require('../../../src/api/encrypted-config-manager');
    return new EncryptedConfigManager(configDir, process.env.ENCRYPTION_KEY || null).loadSecrets() as Record<string, unknown>;
  } catch (err) {
    logger.warn({ err }, 'Could not load persisted secrets for optimizer providers');
    return {};
  }
}

/** @description Resolves a usable key for an OpenAI-compatible framework provider (env or persisted). */
function resolveCompatKey(envKeys: string[], secrets: Record<string, unknown>): string | null {
  for (const env of envKeys) if (process.env[env]) return String(process.env[env]);
  for (const env of envKeys) if (typeof secrets[env] === 'string' && (secrets[env] as string).trim()) return secrets[env] as string;
  return null;
}

/** @description True when this key IS the platform's shared ADR-064 free-fallback key. */
function isPlatformOpenRouterKey(apiKey: string): boolean {
  const platform = (process.env.OPENROUTER_API_KEY || '').trim();
  return platform.length > 0 && apiKey.trim() === platform;
}

/** @description True for OpenRouter's zero-cost model ids (`…:free`). */
function isFreeModelId(model: string): boolean {
  return model.trim().endsWith(':free');
}

/**
 * @description Lists the lanes the optimizer can replay against: the bot's current provider, the caller's
 * BYO connections, and OpenAI-compatible framework providers that have a key on this instance.
 * @param pool - pg pool.
 * @param userSub - The caller's OIDC sub.
 * @returns The offered logins (current first).
 */
export async function listOptimizerLogins(pool: unknown, userSub: string): Promise<OptimizerLogin[]> {
  const logins: OptimizerLogin[] = [];
  let activeProviderId: string | null = null;

  // 1) The bot's current provider (its default login) — always runnable via a no-byo replay.
  try {
    const { providers, activeProvider } = listConfiguredProviders();
    activeProviderId = activeProvider;
    const active = providers.find((p) => p.id === activeProvider);
    logins.push({
      connectionId: CURRENT_ID,
      label: `${active ? active.label : 'Bot default'} (current)`,
      model: active ? (active.selectedModel || active.defaultModelId) : '',
      kind: 'current',
      isDefault: true,
    });

    // 3) OpenAI-compatible framework providers with a key — replayable as ephemeral byo lanes.
    const secrets = loadPersistedSecrets();
    for (const p of providers) {
      if (p.id === activeProvider) continue; // already shown as "current"
      const compat = COMPAT[p.id];
      if (!compat) continue;
      const compatKey = resolveCompatKey(compat.envKeys, secrets);
      if (!compatKey) continue;
      let model = p.selectedModel || p.defaultModelId;
      if (!model) continue;
      // Spend guard display: the platform openrouter key never runs a paid model — the resolve
      // path coerces to a probed-live :free pick, so show that instead of the paid default.
      if (p.id === 'openrouter' && isPlatformOpenRouterKey(compatKey) && !isFreeModelId(model)) {
        model = ':free (auto — platform key)';
      }
      logins.push({ connectionId: `${FRAMEWORK_PREFIX}${p.id}`, label: p.label, model, kind: 'framework', isDefault: false });
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to read framework providers for optimizer');
  }

  // 2) The caller's own Bring-Your-Own-LLM connections.
  try {
    const rows = await accessibleConnections(pool, userSub, ANY_LLM_PROVIDER);
    const entry = buildAnyLlmListEntry(rows);
    for (const c of (entry.connections as Array<{ connectionId: string; label?: string; model?: string }>) ?? []) {
      logins.push({ connectionId: c.connectionId, label: `${c.label || c.model || 'BYO'} (your key)`, model: c.model || '', kind: 'byo', isDefault: false });
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to list BYO connections for optimizer');
  }

  void activeProviderId;
  return logins;
}

/**
 * @description Resolves one offered login to a ready-to-run lane.
 * @param pool - pg pool.
 * @param userSub - The caller's OIDC sub.
 * @param connectionId - 'current', a `framework:<id>`, or a BYO connection id.
 * @returns The lane, or null when the login is unknown / not runnable here.
 */
export async function resolveOptimizerLane(pool: unknown, userSub: string, connectionId: string): Promise<OptimizerLane | null> {
  if (connectionId === CURRENT_ID) {
    const { providers, activeProvider } = listConfiguredProviders();
    const active = providers.find((p) => p.id === activeProvider);
    return { kind: 'current', label: active ? `${active.label} (current)` : 'Bot default' };
  }
  if (connectionId.startsWith(FRAMEWORK_PREFIX)) {
    const providerId = connectionId.slice(FRAMEWORK_PREFIX.length);
    const compat = COMPAT[providerId];
    if (!compat) return null;
    const apiKey = resolveCompatKey(compat.envKeys, loadPersistedSecrets());
    if (!apiKey) return null;
    const { providers } = listConfiguredProviders();
    const p = providers.find((x) => x.id === providerId);
    const model = p ? (p.selectedModel || p.defaultModelId) : '';
    if (!model) return null;
    // Spend guard: the platform's shared OPENROUTER_API_KEY (which now carries real credit) must
    // never replay on a paid model — coerce to platformFreeConnection()'s probed-live :free pick,
    // and refuse the lane outright when the free quota is walled rather than fall back to paid.
    if (providerId === 'openrouter' && isPlatformOpenRouterKey(apiKey) && !isFreeModelId(model)) {
      const free = await platformFreeConnection();
      if (!free) {
        logger.warn({ providerId }, 'Optimizer lane refused: platform OpenRouter key is free-quota-walled and the configured model is paid');
        return null;
      }
      return { kind: 'byo', baseUrl: compat.baseUrl, model: free.model, apiKey, label: `${p ? p.label : providerId} (:free — platform key)` };
    }
    return { kind: 'byo', baseUrl: compat.baseUrl, model, apiKey, label: p ? p.label : providerId };
  }
  const conn = await getUserLlmConnection(pool, userSub, { connectionId });
  return conn ? { kind: 'byo', baseUrl: conn.baseUrl, model: conn.model, apiKey: conn.apiKey, label: conn.model } : null;
}
