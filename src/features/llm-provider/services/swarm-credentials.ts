/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | One shared resolver for the SWARM's own provider credentials. Extracted from cline-runtime-config-sync-service's private buildCredentialBag so features stop inventing their own env-var reads.
 */
/**
 * @description The swarm's own provider credentials — one source of truth.
 *
 * **Never read a vendor key out of `process.env` inside a feature.** The swarm holds its provider
 * credentials in `config-seed/secrets.json` + `global-config.json`, and every consumer must resolve
 * them through here. A feature that invents its own `process.env.FOO_API_KEY` read creates a second,
 * invisible credential path that the operator never configured and cannot rotate — which is exactly
 * how the storyboard stage ended up asking for an `OPENAI_API_KEY` that no other part of the swarm
 * uses.
 *
 * This is the SWARM-level credential (BYOK on the swarm's own login). It is distinct from:
 *   - **per-user connectors** (`oshal_connections` → `getValidAccessToken(pool, sub, provider)`) —
 *     use those when the work should bill or scope to a *user*;
 *   - **BYO-LLM connections** (`byoLlmConnection`) — a caller's own endpoint + key.
 *
 * @module features/llm-provider/services/swarm-credentials
 */

import * as fs from 'fs';
import * as path from 'path';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'swarm-credentials' });

/** Providers the swarm can hold its own credential for. */
export type SwarmCredentialProvider = 'openai' | 'google' | 'anthropic' | 'openrouter' | 'gemini';

/** @description Read a JSON object, or `{}` when missing/invalid. @param {string} filePath path @returns {Record<string, unknown>} parsed object */
function readJsonObject(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** @description The swarm's seed-secrets path (container mount, or the repo's config-seed). @returns {string} path */
export function resolveSeedSecretsPath(): string {
  const override = process.env.OSHAL_SEED_SECRETS_PATH;
  if (override) return override;
  const containerSeed = '/app/config-seed/secrets.json';
  if (fs.existsSync(containerSeed)) return containerSeed;
  return path.join(process.cwd(), 'config-seed', 'secrets.json');
}

/**
 * @description The **live** codex auth source — the file the codex harness reads and, since the
 * token-stranding fix (`codex-auth-write-back.ts`), writes the rotated token back to.
 *
 * This must resolve identically to the harness (`CODEX_AUTH_SOURCE_PATH`, else `$HOME/.codex/auth.json`).
 * The copy inside `config-seed/secrets.json` is a SEED, not the live credential: it is not rotated, so
 * a consumer that reads only the seed will hold an expired token forever even while the swarm's codex
 * auth is healthy. (Observed 2026-07-13: the live source had been refreshed the previous day; the seed
 * copy carried no `last_refresh` at all.)
 *
 * @returns {string | null} path to the live auth.json, or null when no home dir is resolvable
 */
export function resolveCodexAuthSourcePath(): string | null {
  const explicit = (process.env.CODEX_AUTH_SOURCE_PATH || '').trim();
  if (explicit) return explicit;
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (!homeDir) return null;
  return path.join(homeDir, '.codex', 'auth.json');
}

/** @description The swarm's global-config path. @returns {string} path */
export function resolveGlobalConfigPath(): string {
  const override = process.env.OSHAL_GLOBAL_CONFIG_PATH;
  if (override) return override;
  const configDir = process.env.CONFIG_OUTPUT_DIR || '';
  if (configDir && fs.existsSync(path.join(configDir, 'global-config.json'))) {
    return path.join(configDir, 'global-config.json');
  }
  const containerSeed = '/app/config-seed/global-config.json';
  if (fs.existsSync(containerSeed)) return containerSeed;
  return path.join(process.cwd(), 'config-seed', 'global-config.json');
}

/**
 * @description Pull the OpenAI Codex OAuth **access token** out of a secrets envelope.
 *
 * The ChatGPT login stores a JSON blob under `openAiCodexOauthCredentials` (app key) or
 * `openai-codex-oauth-credentials` (Cline key), sometimes nested under a per-user envelope. This is
 * the swarm's OpenAI credential — the same one `buildClineConfig` receives as `OPENAI_API_KEY`.
 *
 * NOTE: the blob's `refresh_token` is **single-use**. Never refresh it here — the codex harness owns
 * that, behind its prime gate, because a racing refresh bricks codex auth for every bot.
 *
 * @param {Record<string, unknown>} envelope a parsed secrets object
 * @returns {string | null} the access token, or null
 */
export function extractOpenAiCodexAccessToken(envelope: Record<string, unknown>): string | null {
  for (const key of ['openAiCodexOauthCredentials', 'openai-codex-oauth-credentials']) {
    const blob = envelope[key];
    let parsed: Record<string, unknown> | null = null;
    if (typeof blob === 'string' && blob.trim()) {
      try { parsed = JSON.parse(blob) as Record<string, unknown>; } catch { parsed = null; }
    } else if (blob && typeof blob === 'object' && !Array.isArray(blob)) {
      parsed = blob as Record<string, unknown>;
    }
    if (!parsed) continue;
    const direct = (parsed.access_token ?? parsed.accessToken) as string | undefined;
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    // ChatGPT-login shape: { tokens: { access_token, refresh_token, … } }
    const tokens = parsed.tokens as Record<string, unknown> | undefined;
    const nested = tokens?.access_token as string | undefined;
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
  }
  // Per-user envelopes (e.g. mock-user-001.openAiCodexOauthCredentials)
  for (const val of Object.values(envelope)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const found = extractOpenAiCodexAccessToken(val as Record<string, unknown>);
      if (found) return found;
    }
  }
  return null;
}

/**
 * @description Resolve the swarm's own credential for a provider.
 *
 * Order: `global-config.json` → `secrets.json` → (for openai) the Codex OAuth access token. Env vars
 * are consulted **last and only as an operator override**, never as the primary path — so a
 * credential the operator never configured cannot silently become the one in use.
 *
 * @param {SwarmCredentialProvider} provider which vendor
 * @returns {string} the credential, or '' when the swarm holds none
 */
export function getSwarmApiKey(provider: SwarmCredentialProvider): string {
  const config = readJsonObject(resolveGlobalConfigPath());
  const secrets = readJsonObject(resolveSeedSecretsPath());

  /** First non-empty string among the named keys of an envelope. */
  const pick = (envelope: Record<string, unknown>, keys: string[]): string => {
    for (const k of keys) {
      const v = envelope[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };

  switch (provider) {
    case 'openai': {
      const named = pick(config, ['openAiApiKey', 'openAiNativeApiKey'])
        || pick(secrets, ['openAiApiKey', 'openAiNativeApiKey']);
      if (named) return named;

      // The swarm's OpenAI identity is the Codex ChatGPT login. Read the LIVE source FIRST — the
      // codex harness rotates the token there and (since the token-stranding fix) writes it back.
      // The secrets.json copy is a seed and is never rotated, so preferring it would pin us to an
      // expired token even while codex auth is healthy.
      const liveAuthPath = resolveCodexAuthSourcePath();
      if (liveAuthPath) {
        const live = readJsonObject(liveAuthPath);
        const fromLive = extractOpenAiCodexAccessToken(live)
          || (typeof live.OPENAI_API_KEY === 'string' ? live.OPENAI_API_KEY.trim() : '');
        if (fromLive) return fromLive;
      }

      const seeded = extractOpenAiCodexAccessToken(secrets) || extractOpenAiCodexAccessToken(config);
      if (seeded) {
        logger.warn('using the SEEDED codex credential (config-seed) — the live ~/.codex/auth.json was unreadable; this token is not rotated and may be expired');
        return seeded;
      }
      return (process.env.OPENAI_API_KEY || '').trim();
    }
    case 'google':
    case 'gemini':
      return pick(config, ['googleApiKey', 'geminiApiKey'])
        || pick(secrets, ['googleApiKey', 'geminiApiKey'])
        || (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '').trim();
    case 'anthropic':
      return pick(config, ['anthropicApiKey']) || pick(secrets, ['anthropicApiKey'])
        || (process.env.ANTHROPIC_API_KEY || '').trim();
    case 'openrouter':
      return pick(config, ['openRouterApiKey']) || pick(secrets, ['openRouterApiKey'])
        || (process.env.OPENROUTER_API_KEY || '').trim();
    default:
      return '';
  }
}

/**
 * @description Does the swarm hold a usable credential for this provider? Cheap: no network call.
 * @param {SwarmCredentialProvider} provider which vendor
 * @returns {boolean} true when a credential is configured
 */
export function hasSwarmApiKey(provider: SwarmCredentialProvider): boolean {
  const has = Boolean(getSwarmApiKey(provider));
  if (!has) logger.debug({ provider }, 'swarm holds no credential for this provider');
  return has;
}
