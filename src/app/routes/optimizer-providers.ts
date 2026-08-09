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
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Resolve current, BYO, and compatible framework lanes for Token Chase without exposing stored credentials.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Keep the shared OpenRouter key on probed `:free` models and refuse it when the free quota is unavailable.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Add the aggregate `free:auto` selector backed by owner-scoped health/LRU rotation; replay-time provider walls rotate only through free lanes and otherwise fail closed.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Source the OpenAI-compatible endpoint table from the shared openai-compat-lanes module so the operator-key resolver and this optimizer cannot drift apart on base URLs or key env names.
 *
 * @module optimizer-providers
 */

import fs from 'node:fs';
import path from 'node:path';
import { createChildLogger } from '@/shared/logger';
import type { VariantLaneRotation, VariantReplayLane } from '@/features/token-chase';
import { listConfiguredProviders } from './provider-routes';
import { getUserLlmConnection, buildAnyLlmListEntry, ANY_LLM_PROVIDER } from './byo-llm-routes';
import { accessibleConnections } from './connector-tenancy';
import { OPENAI_COMPAT_LANES } from './openai-compat-lanes';
import {
  freeTierRuntimeSnapshot,
  listFreeTierConnections,
  platformFreeConnection,
  reportResolvedLlmFailure,
  reportSuccess,
  resolveLiveFreeTierConnection,
  type FreeTierResolution,
  type ResolvedUserLlmConnection,
} from './free-tier-rotation';

const logger = createChildLogger({ module: 'optimizer-providers' });

const FRAMEWORK_PREFIX = 'framework:';
const CURRENT_ID = 'current';
/** @description Stable connection id for Token Chase's aggregate health-qualified free selector. */
export const TOKEN_CHASE_FREE_ROTATION_ID = 'free:auto';
const MAX_FREE_ROTATION_ATTEMPTS = 8;

/**
 * OpenAI-compatible base URL + key env vars for framework providers the bot CAN replay ephemerally.
 * The table itself lives in openai-compat-lanes so the operator-key resolver in free-tier-rotation
 * runs against the SAME endpoints (one place to add a vendor, no drift between the two consumers).
 */
const COMPAT = OPENAI_COMPAT_LANES;

/** @description A login the optimizer can offer in its picker (no secrets — id + display + model). */
export interface OptimizerLogin {
  connectionId: string;
  label: string;
  model: string;
  kind: 'current' | 'byo' | 'framework' | 'free-rotation';
  isDefault: boolean;
}

/** @description Non-secret evidence identifying the exact free lane selected for a replay. */
export interface OptimizerFreeSelection {
  source: 'user-free-tier' | 'platform-free';
  connectionId: string | null;
  providerId: string;
  model: string;
}

/** @description A resolved lane to replay against (carries the secret for `byo`). */
export type OptimizerLane =
  | { kind: 'current'; label: string }
  | {
      kind: 'byo';
      baseUrl: string;
      model: string;
      apiKey: string;
      label: string;
      providerId?: string;
      freeSelection?: OptimizerFreeSelection;
    };

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

/** @description Counts owner-visible free connections that rotation may currently attempt. */
async function eligibleUserFreeCount(pool: unknown, userSub: string): Promise<number> {
  try {
    const statuses = await listFreeTierConnections(pool, userSub);
    return statuses.filter((lane) => !lane.cooledDown && Boolean(lane.providerId) && Boolean(lane.model)).length;
  } catch (err) {
    logger.warn({ err }, 'Failed to read free-tier eligibility for Token Chase');
    return 0;
  }
}

/** @description Builds the aggregate selector row without exposing a key or an unhealthy lane. */
async function buildFreeRotationLogin(pool: unknown, userSub: string): Promise<OptimizerLogin | null> {
  const userLanes = await eligibleUserFreeCount(pool, userSub);
  let platformLive = false;
  try {
    const platform = freeTierRuntimeSnapshot();
    platformLive = platform.configured && platform.verdict === 'live' && isFreeModelId(platform.model ?? '');
  } catch (err) {
    logger.warn({ err }, 'Failed to read platform free-lane eligibility for Token Chase');
  }
  const eligible = userLanes + (platformLive ? 1 : 0);
  if (eligible === 0) return null;
  return {
    connectionId: TOKEN_CHASE_FREE_ROTATION_ID,
    label: `Free-provider rotation (${eligible} eligible lane${eligible === 1 ? '' : 's'})`,
    model: 'health-qualified at replay time',
    kind: 'free-rotation',
    isDefault: false,
  };
}

/** @description Shapes an owner-owned free resolution as a Token Chase replay lane. */
function userFreeOptimizerLane(free: FreeTierResolution): OptimizerLane {
  return {
    kind: 'byo',
    baseUrl: free.baseUrl,
    model: free.model,
    apiKey: free.apiKey,
    label: `Free rotation — ${free.providerId} / ${free.model}`,
    providerId: free.providerId,
    freeSelection: {
      source: 'user-free-tier', connectionId: free.connectionId,
      providerId: free.providerId, model: free.model,
    },
  };
}

/** @description Resolves the next probed-live free lane, never the bot's paid/default provider. */
async function resolveFreeOptimizerLane(pool: unknown, userSub: string): Promise<OptimizerLane | null> {
  const free = await resolveLiveFreeTierConnection(pool, userSub);
  if (free) return userFreeOptimizerLane(free);
  const platform = await platformFreeConnection();
  if (!platform || !isFreeModelId(platform.model)) return null;
  return {
    kind: 'byo', baseUrl: platform.baseUrl, model: platform.model, apiKey: platform.apiKey,
    label: `Free rotation — openrouter / ${platform.model}`, providerId: 'openrouter',
    freeSelection: {
      source: 'platform-free', connectionId: null, providerId: 'openrouter', model: platform.model,
    },
  };
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

  const freeRotation = await buildFreeRotationLogin(pool, userSub);
  if (freeRotation) logins.splice(Math.min(1, logins.length), 0, freeRotation);

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
  if (connectionId === TOKEN_CHASE_FREE_ROTATION_ID) {
    return resolveFreeOptimizerLane(pool, userSub);
  }
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

/**
 * @description Converts an optimizer lane into the credential-bearing replay shape consumed by
 * TokenChaseOptimizeService while retaining the selected provider id for evidence.
 * @param lane - Resolved optimizer lane.
 * @param label - Optional caller display label; selection evidence remains server-derived.
 * @returns The replay lane.
 */
export function optimizerReplayLane(lane: OptimizerLane, label?: string): VariantReplayLane {
  const chosenLabel = label?.trim() || lane.label;
  if (lane.kind === 'current') return { label: chosenLabel };
  return {
    label: chosenLabel,
    byo: {
      baseUrl: lane.baseUrl, apiKey: lane.apiKey, model: lane.model, providerId: lane.providerId,
    },
  };
}

/** @description Reconstructs the free-tier failure record without exposing it outside the server. */
function failureConnectionOf(lane: OptimizerLane): ResolvedUserLlmConnection | undefined {
  if (lane.kind !== 'byo' || !lane.freeSelection) return undefined;
  return {
    baseUrl: lane.baseUrl,
    apiKey: lane.apiKey,
    model: lane.model,
    resolutionSource: lane.freeSelection.source === 'user-free-tier' ? 'free-tier' : 'platform',
    connectionId: lane.freeSelection.connectionId ?? undefined,
  };
}

/**
 * @description Builds replay-time rotation callbacks for an aggregate free selector. Classified
 * quota/provider walls cool the current free lane and select another; no callback ever returns the
 * bot's configured lane, so exhaustion fails closed rather than spending a paid platform key.
 * @param pool - pg pool holding owner-scoped rotation state.
 * @param userSub - Authenticated owner subject.
 * @param initial - First resolved free optimizer lane.
 * @returns Rotation callbacks, or undefined for non-free selections.
 */
export function createOptimizerLaneRotation(
  pool: unknown,
  userSub: string,
  initial: OptimizerLane,
): VariantLaneRotation | undefined {
  if (initial.kind !== 'byo' || !initial.freeSelection) return undefined;
  let current: OptimizerLane = initial;
  return {
    maxAttempts: MAX_FREE_ROTATION_ATTEMPTS,
    next: async () => {
      const next = await resolveFreeOptimizerLane(pool, userSub);
      if (!next) return null;
      current = next;
      return optimizerReplayLane(next);
    },
    onFailure: async (_lane, reason) =>
      reportResolvedLlmFailure(pool, failureConnectionOf(current), reason),
    onSuccess: async () => {
      const selected = current.kind === 'byo' ? current.freeSelection : undefined;
      if (selected?.source !== 'user-free-tier' || !selected.connectionId) return;
      try {
        await reportSuccess(pool, selected.connectionId);
      } catch (err) {
        logger.warn({ err, connectionId: selected.connectionId }, 'Failed to persist Token Chase free-lane success telemetry');
      }
    },
  };
}
