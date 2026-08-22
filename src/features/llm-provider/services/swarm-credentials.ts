/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | One shared resolver for the SWARM's own provider credentials. Extracted from cline-runtime-config-sync-service's private buildCredentialBag so features stop inventing their own env-var reads.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: resolve Codex OAuth only from the live vendor auth source and fail closed when it is absent; never revive a static config-seed token copy.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Platform-realm siblings getSwarmPlatformApiKey/hasSwarmPlatformApiKey: consumers of platform-only endpoints (the Images API) must never be handed the codex ChatGPT-subscription OAuth token — /v1/images 401s on it (missing scope api.model.images.request, re-verified live 2026-08-21) while plain key-presence reads as configured. Chat-harness resolution (getSwarmApiKey) is unchanged.
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
  const direct = (envelope.access_token ?? envelope.accessToken) as string | undefined;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const rootTokens = envelope.tokens as Record<string, unknown> | undefined;
  const rootNested = rootTokens?.access_token as string | undefined;
  if (typeof rootNested === 'string' && rootNested.trim()) return rootNested.trim();

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
 * @description Reports whether the live Codex vendor auth source contains usable OAuth material.
 * Static config-seed copies are deliberately ignored because they do not rotate and can resurrect
 * a revoked or expired platform credential.
 * @returns True only for a readable live auth.json with an access token
 */
export function hasLiveCodexAuth(): boolean {
  const liveAuthPath = resolveCodexAuthSourcePath();
  return !!liveAuthPath && !!extractOpenAiCodexAccessToken(readJsonObject(liveAuthPath));
}

/**
 * @description First non-empty string among the named keys of an envelope.
 * @param {Record<string, unknown>} envelope a parsed config/secrets object
 * @param {string[]} keys key names to try, in order
 * @returns {string} the first non-empty trimmed value, or ''
 */
function pickNamedKey(envelope: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = envelope[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** Named PLATFORM-realm OpenAI key names in config/secrets — never OAuth material. */
const OPENAI_PLATFORM_KEY_NAMES = ['openAiApiKey', 'openAiNativeApiKey'];

/**
 * @description Resolve the swarm's own credential for a provider.
 *
 * Named hosted-provider keys use global config/secret settings. Codex OAuth is different: it is
 * accepted only from the live vendor auth source, with an explicit environment API key as the
 * non-OAuth fallback. Static config-seed OAuth copies are never executable credentials.
 *
 * @param {SwarmCredentialProvider} provider which vendor
 * @returns {string} the credential, or '' when the swarm holds none
 */
export function getSwarmApiKey(provider: SwarmCredentialProvider): string {
  const config = readJsonObject(resolveGlobalConfigPath());
  const secrets = readJsonObject(resolveSeedSecretsPath());

  switch (provider) {
    case 'openai': {
      const named = pickNamedKey(config, OPENAI_PLATFORM_KEY_NAMES)
        || pickNamedKey(secrets, OPENAI_PLATFORM_KEY_NAMES);
      if (named) return named;

      // The swarm's Codex identity is the live vendor auth source. The harness rotates the token
      // there and writes it back. A config-seed copy is neither live nor revocation-aware and is
      // therefore never accepted as a runtime fallback.
      const liveAuthPath = resolveCodexAuthSourcePath();
      if (liveAuthPath) {
        const live = readJsonObject(liveAuthPath);
        const fromLive = extractOpenAiCodexAccessToken(live)
          || (typeof live.OPENAI_API_KEY === 'string' ? live.OPENAI_API_KEY.trim() : '');
        if (fromLive) return fromLive;
      }

      return (process.env.OPENAI_API_KEY || '').trim();
    }
    case 'google':
    case 'gemini':
      return pickNamedKey(config, ['googleApiKey', 'geminiApiKey'])
        || pickNamedKey(secrets, ['googleApiKey', 'geminiApiKey'])
        || (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '').trim();
    case 'anthropic':
      return pickNamedKey(config, ['anthropicApiKey']) || pickNamedKey(secrets, ['anthropicApiKey'])
        || (process.env.ANTHROPIC_API_KEY || '').trim();
    case 'openrouter':
      return pickNamedKey(config, ['openRouterApiKey']) || pickNamedKey(secrets, ['openRouterApiKey'])
        || (process.env.OPENROUTER_API_KEY || '').trim();
    default:
      return '';
  }
}

/**
 * @description Resolve the swarm's credential for a provider in the PLATFORM realm only.
 *
 * For `openai` this skips the codex-OAuth rung of {@link getSwarmApiKey}: the ChatGPT-subscription
 * access token authenticates the codex backend but is *forbidden* on the platform API — `/v1/images`
 * 401s with a missing `api.model.images.request` scope and `/v1/models` 403s (ADR-082, re-verified
 * live 2026-08-21). A consumer that calls a platform-only endpoint must resolve here, so a mounted
 * codex login can never read as "configured" for a call it structurally cannot make. Every other
 * provider has no OAuth rung and resolves identically to {@link getSwarmApiKey}.
 *
 * @param {SwarmCredentialProvider} provider which vendor
 * @returns {string} the platform credential, or '' when the swarm holds none
 */
export function getSwarmPlatformApiKey(provider: SwarmCredentialProvider): string {
  if (provider !== 'openai') return getSwarmApiKey(provider);
  const config = readJsonObject(resolveGlobalConfigPath());
  const secrets = readJsonObject(resolveSeedSecretsPath());
  return pickNamedKey(config, OPENAI_PLATFORM_KEY_NAMES)
    || pickNamedKey(secrets, OPENAI_PLATFORM_KEY_NAMES)
    || (process.env.OPENAI_API_KEY || '').trim();
}

/**
 * @description Does the swarm hold a PLATFORM-realm credential for this provider? Cheap: no network call.
 * @param {SwarmCredentialProvider} provider which vendor
 * @returns {boolean} true when a platform credential is configured
 */
export function hasSwarmPlatformApiKey(provider: SwarmCredentialProvider): boolean {
  const has = Boolean(getSwarmPlatformApiKey(provider));
  if (!has) logger.debug({ provider }, 'swarm holds no PLATFORM credential for this provider');
  return has;
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
