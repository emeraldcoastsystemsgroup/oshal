/**
 * Free-tier rotation engine (ADR-064) — pick the next usable free connection, track
 * rate-limit cooldowns, and shape the pick for the Cline CLI harness.
 *
 * The "bank of free tokens" is the user's OWN connected free tiers across providers
 * (stored per-user, AES-GCM encrypted, in oshal_connections under `free:<id>` via the
 * same rails as every other connector). This module is the resolution seam the
 * execution layer calls — the analogue of byo-llm's getUserLlmConnection — plus the
 * least-recently-used rotation and a small cooldown table so a rate-limited key is
 * skipped until it resets instead of failing the request.
 *
 * WHY A SEPARATE STATE TABLE: rotation needs per-connection `last_used_at` + a
 * `cooldown_until`, which are runtime telemetry, not credential data. Keeping them in
 * oshal_free_tier_state (keyed by connection_id, no FK so creation order is irrelevant)
 * leaves the shared connections table untouched.
 *
 * RESOLUTION → CLINE: freeTierToHarnessConfig() returns exactly the fields
 * buildClineProvider() consumes ({ providerId, apiType, modelId, apiKey, baseUrl }), so
 * "it all wraps in Cline CLI" (ADR-005): the execution layer hands these to Cline and
 * Cline makes the real call. No per-provider model adapter is written here.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — schema, LRU rotation, rate-limit cooldown, listing, and the Cline-handoff shape for ADR-064.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | platformFreeConnection: return null (not an unprobed dead model) when every candidate is walled, so the bot's configured provider actually runs — the unprobed fallback bricked every Jarvis turn with a 429 once the shared key hit OpenRouter's account-wide free-requests/day cap. Also cache the probe verdict in-memory: probes are real completions that burned ~6 of the 50/day quota per resolution.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | resolveUserLlmConnection: the OPERATOR skips the free-tier legs (their turns + scheduled runs stay on the bot's configured claude/codex provider — the free tier is a backup for OTHER users, operator decision 2026-07-10). Ambient request identity first, OSHAL_OPERATOR_SUBS allowlist for background work.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Preserve the resolution source long enough to cool a free-tier connection or invalidate the cached platform verdict after a real 429, allowing one immediate configured-provider retry instead of trusting a stale probe.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | platformFreeConnection: hard free-only guard — drop any non-:free candidate (incl. a misconfigured OPENROUTER_FREE_MODEL override). The shared account now carries the one-time $10 (1,000 :free req/day unlocked), so a paid model id would actually spend; operator directive: the platform key only ever runs :free models.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Runtime free-model discovery (BACKLOG "Free-tier model rot"): the platform candidate list now comes from OpenRouter GET /models (filter :free + zero pricing, family/context ranking, 30-min cache) instead of the hardcoded PLATFORM_FREE_MODELS array that kept 404ing as the catalog churned. Platform probes now also reject 200-but-empty completions (reasoning models eat a tiny-max_tokens probe) so the pick demonstrably answers; last-live model is tried first to cut probe burn. User-connection probe semantics unchanged.
 *
 * @module free-tier-rotation
 */

import { createChildLogger } from '@/shared/logger';
import { getRequestIdentity } from '@/shared/services/database/request-identity';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { decryptToken } from './connector-token-crypto';
import { accessibleConnections, ownerSub, type ConnectionRow } from './connector-tenancy';
import { getUserLlmConnection, type ByoLlmConnection } from './byo-llm-routes';
import {
  getFreeProvider, freeIdFromProviderColumn, FREE_PROVIDER_PREFIX, hostOf, type FreeProvider,
} from './free-tier-providers';

const logger = createChildLogger({ module: 'free-tier-rotation' });

/** Default cooldown applied on a rate-limit when the provider gives no Retry-After. */
const DEFAULT_COOLDOWN_MS = 60_000;

/** A resolved free-tier connection ready to run (decrypted) + its catalog facts. */
export interface FreeTierResolution {
  connectionId: string;
  providerId: string;       // catalog id, e.g. 'groq'
  clineProvider: string;    // provider id Cline understands
  model: string;
  baseUrl: string;          // OpenAI-compatible endpoint
  apiKey: string;           // decrypted
  label: string;
}

/** Controller-only metadata for reporting a real execution failure before the key is stripped. */
export interface ResolvedUserLlmConnection extends ByoLlmConnection {
  resolutionSource: 'explicit' | 'free-tier' | 'platform';
  connectionId?: string;
}

/** A connection's status for the /list surface (never includes the key). */
export interface FreeTierStatus {
  connectionId: string;
  providerId: string;
  providerLabel: string;
  model: string;
  host: string;
  isDefault: boolean;
  tenantId: string | null;
  cooldownUntil: number;    // epoch ms; 0 = none
  cooledDown: boolean;      // cooldownUntil > now
  lastStatus: string | null;
}

/** Per-connection rotation telemetry. */
interface StateRow {
  connection_id: string;
  cooldown_until: string | number | null;
  last_used_at: string | number | null;
  last_status: string | null;
}

/**
 * @description Create the rotation state table. Idempotent; safe on every boot. No FK to
 * oshal_connections so it does not depend on connector schema creation order.
 * @param pool - pg pool
 */
export async function ensureFreeTierSchema(pool: any): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'free-tier rotation',
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_free_tier_state (
        connection_id UUID PRIMARY KEY,
        cooldown_until BIGINT NOT NULL DEFAULT 0,
        last_used_at BIGINT NOT NULL DEFAULT 0,
        last_status TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    ],
    requirements: [
      { table: 'oshal_free_tier_state', columns: ['connection_id', 'cooldown_until', 'last_used_at', 'last_status', 'updated_at'] },
    ],
  });
}

/** All of a caller's free-tier connection rows (personal ∪ shared), newest first. */
async function freeRows(pool: any, userSub: string): Promise<ConnectionRow[]> {
  const rows = await accessibleConnections(pool, userSub);
  return rows.filter((r) => (r.provider || '').startsWith(FREE_PROVIDER_PREFIX));
}

/** Fetch state for a set of connection ids as a map. Missing rows = zeroed defaults. */
async function stateMap(pool: any, ids: string[]): Promise<Map<string, StateRow>> {
  const map = new Map<string, StateRow>();
  if (!ids.length) return map;
  const rows = (await pool.query(
    'SELECT connection_id, cooldown_until, last_used_at, last_status FROM oshal_free_tier_state WHERE connection_id = ANY($1::uuid[])',
    [ids],
  )).rows as StateRow[];
  for (const r of rows) map.set(String(r.connection_id), r);
  return map;
}

const num = (v: string | number | null | undefined): number => (v == null ? 0 : Number(v));

/**
 * @description List the caller's free-tier connections with rotation status, for the UI.
 * Never returns keys. Cooldown is computed against `now`.
 * @param pool @param userSub @returns status array (newest first)
 */
export async function listFreeTierConnections(pool: any, userSub: string): Promise<FreeTierStatus[]> {
  const rows = await freeRows(pool, userSub);
  const states = await stateMap(pool, rows.map((r) => r.connection_id));
  const now = Date.now();
  return rows.map((r) => {
    const id = freeIdFromProviderColumn(r.provider);
    const prov = getFreeProvider(id);
    const st = states.get(r.connection_id);
    const cooldownUntil = num(st?.cooldown_until);
    return {
      connectionId: r.connection_id,
      providerId: id,
      providerLabel: prov?.label || id,
      model: r.scopes || '',
      host: hostOf(r.account_id || prov?.baseUrl || ''),
      isDefault: r.is_default,
      tenantId: r.tenant_id || null,
      cooldownUntil,
      cooledDown: cooldownUntil > now,
      lastStatus: st?.last_status || null,
    };
  });
}

/**
 * @description Resolve the NEXT free-tier connection to run for a caller (the rotation
 * pick), decrypted and ready for Cline. Skips connections whose cooldown has not expired,
 * then picks least-recently-used (round-robin) so load spreads across the user's keys.
 * Returns null when the user has no free-tier connections, or all are cooling down.
 * @param pool @param userSub @param opts - { providerId? } to force one provider
 * @returns the resolution or null
 */
export async function getFreeTierConnection(
  pool: any, userSub: string, opts?: { providerId?: string },
): Promise<FreeTierResolution | null> {
  let rows = await freeRows(pool, userSub);
  if (opts?.providerId) {
    const want = opts.providerId.trim().toLowerCase();
    rows = rows.filter((r) => freeIdFromProviderColumn(r.provider) === want);
  }
  if (!rows.length) return null;

  const states = await stateMap(pool, rows.map((r) => r.connection_id));
  const now = Date.now();
  const eligible = rows.filter((r) => num(states.get(r.connection_id)?.cooldown_until) <= now);
  if (!eligible.length) {
    logger.warn({ userSub, total: rows.length }, 'free-tier: all connections cooling down');
    return null;
  }
  // Least-recently-used first (round-robin); never-used (0) sort first.
  eligible.sort((a, b) =>
    num(states.get(a.connection_id)?.last_used_at) - num(states.get(b.connection_id)?.last_used_at));
  const row = eligible[0];

  const id = freeIdFromProviderColumn(row.provider);
  const prov = getFreeProvider(id);
  if (!prov || !row.access_token || !row.scopes) {
    logger.warn({ userSub, id }, 'free-tier: chosen row missing provider/model/key');
    return null;
  }
  let apiKey: string;
  try {
    apiKey = await decryptToken(pool, ownerSub(row), row.access_token);
  } catch (err) {
    logger.error({ err, connectionId: row.connection_id }, 'free-tier: key decrypt failed');
    return null;
  }
  await markUsed(pool, row.connection_id, now);
  return {
    connectionId: row.connection_id,
    providerId: id,
    clineProvider: prov.clineProvider,
    model: row.scopes,
    // Catalog is the source of truth for the endpoint; account_id is just a stored copy.
    baseUrl: prov.baseUrl,
    apiKey,
    label: row.label || prov.label,
  };
}

/**
 * @description Shape a resolution for the Cline CLI harness. The returned object matches the
 * fields buildClineProvider()/HarnessFactoryConfig consume, so the execution layer can do:
 *   const cfg = freeTierToHarnessConfig(conn); buildClineProvider(cfg)
 * and Cline makes the real call (ADR-005). Kept as a plain object (no import of the harness
 * type) so this module has no dependency on the composition layer.
 * @param conn - a resolved free-tier connection
 * @returns { providerId, apiType, modelId, apiKey, baseUrl }
 */
export function freeTierToHarnessConfig(conn: FreeTierResolution): {
  providerId: string; apiType: string; modelId: string; apiKey: string; baseUrl: string;
} {
  return {
    providerId: conn.clineProvider,
    apiType: conn.clineProvider,
    modelId: conn.model,
    apiKey: conn.apiKey,
    baseUrl: conn.baseUrl,
  };
}

/** Upsert a state row, setting the given fields. */
async function upsertState(
  pool: any, connectionId: string, fields: { cooldownUntil?: number; lastUsedAt?: number; lastStatus?: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO oshal_free_tier_state (connection_id, cooldown_until, last_used_at, last_status, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (connection_id) DO UPDATE SET
       cooldown_until = COALESCE($2, oshal_free_tier_state.cooldown_until),
       last_used_at   = COALESCE($3, oshal_free_tier_state.last_used_at),
       last_status    = COALESCE($4, oshal_free_tier_state.last_status),
       updated_at     = NOW()`,
    [
      connectionId,
      fields.cooldownUntil ?? null,
      fields.lastUsedAt ?? null,
      fields.lastStatus ?? null,
    ],
  );
}

/** @description Mark a connection as just used (advances its LRU position). */
export async function markUsed(pool: any, connectionId: string, at = Date.now()): Promise<void> {
  await upsertState(pool, connectionId, { lastUsedAt: at, lastStatus: 'ok' });
}

/**
 * @description Record that a connection hit a rate limit, so rotation skips it until it
 * resets. Call this from the execution layer on a 429 (or quota error) from the provider.
 * @param pool @param connectionId @param retryAfterMs - provider Retry-After in ms (optional)
 */
export async function reportRateLimit(pool: any, connectionId: string, retryAfterMs?: number): Promise<void> {
  const until = Date.now() + (retryAfterMs && retryAfterMs > 0 ? retryAfterMs : DEFAULT_COOLDOWN_MS);
  await upsertState(pool, connectionId, { cooldownUntil: until, lastStatus: 'rate_limited' });
  logger.info({ connectionId, until }, 'free-tier: connection cooled down after rate limit');
}

/** @description Clear a connection's cooldown (e.g. after a confirmed success). */
export async function reportSuccess(pool: any, connectionId: string): Promise<void> {
  await upsertState(pool, connectionId, { cooldownUntil: 0, lastStatus: 'ok' });
}

/** @description Delete the rotation state for a connection (called when it is disconnected). */
export async function deleteState(pool: any, connectionId: string): Promise<void> {
  await pool.query('DELETE FROM oshal_free_tier_state WHERE connection_id = $1', [connectionId]);
}

/** @description Catalog entry for a stored row's provider (helper for callers/UI). */
export function providerOfRow(row: { provider: string }): FreeProvider | undefined {
  return getFreeProvider(freeIdFromProviderColumn(row.provider));
}

// ── Live resolution (execution wiring) ──────────────────────────────────────────

/**
 * @description Cheap liveness probe: a 1-token chat completion against the connection.
 * Distinguishes a rate-limit/quota wall (cool it down, rotate past it) from a transient
 * error. Kept here so the rotation engine owns "is this connection usable right now".
 * @returns 'ok' | 'rate_limited' | 'error'
 */
async function probe(conn: FreeTierResolution, opts?: { requireContent?: boolean }): Promise<'ok' | 'rate_limited' | 'error'> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const r = await fetch(`${conn.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conn.apiKey}` },
      body: JSON.stringify({
        model: conn.model, messages: [{ role: 'user', content: 'ping' }],
        max_tokens: opts?.requireContent ? 16 : 1, temperature: 0, stream: false,
      }),
      signal: ctrl.signal,
    });
    // 429 = rate limit; 402/403 = quota exhausted / billing wall — both mean "rotate past".
    if (r.status === 429 || r.status === 402 || r.status === 403) return 'rate_limited';
    if (!r.ok) return 'error';
    if (!opts?.requireContent) return 'ok';
    // Platform picks only: reasoning models can burn a small max_tokens entirely on hidden
    // reasoning and answer 200 with EMPTY content — since we are CHOOSING a model here (not
    // validating a user's explicit connection), an empty completion is a dead pick; rotate past.
    const parsed = await r.json().catch(() => null) as { choices?: Array<{ message?: { content?: string } }> } | null;
    return (parsed?.choices?.[0]?.message?.content ?? '').trim() ? 'ok' : 'error';
  } catch {
    return 'error';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @description Resolve the next free-tier connection that is actually live right now. Picks in
 * LRU order (getFreeTierConnection), probes it, and on a rate-limit/quota wall cools it down and
 * advances to the next — so a limited key is skipped end-to-end, not just flagged. A transient
 * error gets a short cooldown so rotation moves on but retries it soon. Bounded retries.
 * @param pool @param userSub @param opts - { providerId? } to force one provider
 * @returns a live resolution or null (none connected, or all walled/erroring)
 */
export async function resolveLiveFreeTierConnection(
  pool: any, userSub: string, opts?: { providerId?: string },
): Promise<FreeTierResolution | null> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const conn = await getFreeTierConnection(pool, userSub, opts);
    if (!conn) return null; // none eligible (none connected, or all cooling down)
    const status = await probe(conn);
    if (status === 'ok') return conn;
    if (status === 'rate_limited') {
      await reportRateLimit(pool, conn.connectionId);
    } else {
      // Transient: short cooldown so the LRU pick advances but this key is retried soon.
      await reportRateLimit(pool, conn.connectionId, 15_000);
    }
  }
  logger.warn({ userSub }, 'free-tier: no live connection after probing the rotation');
  return null;
}

/** OpenRouter GET /models entry — just the fields discovery filters/ranks on. */
interface DiscoveredModel { id: string; context_length?: number; pricing?: { prompt?: string; completion?: string } }

/** Discovered `:free` catalog, cached briefly. The catalog churns daily (delist/paid-move), not
 *  per-minute, and GET /models costs nothing — the TTL exists for latency + rank stability, so the
 *  verdict cache and the catalog don't thrash each other. */
let freeCatalog: { models: string[]; until: number } | null = null;
const FREE_CATALOG_TTL_MS = 30 * 60_000;

/** Probe ceiling per resolution — probes are REAL completions that spend the shared key's daily
 *  free-request quota (observed ~6/resolution burning the 50/day wall, 2026-07-10). */
const MAX_PLATFORM_PROBES = 6;

/** Probe ORDER preference over the discovered catalog (major families first — likeliest to be
 *  alive and coherent). Ordering heuristic ONLY: the candidate ids themselves come from live
 *  GET /models discovery — there is no hardcoded model list left (BACKLOG "Free-tier model rot"). */
const FAMILY_ORDER = ['openai/', 'meta-llama/', 'qwen/', 'google/', 'mistralai/', 'nvidia/', 'deepseek/'];
const familyRank = (id: string): number => {
  const i = FAMILY_ORDER.findIndex((prefix) => id.startsWith(prefix));
  return i === -1 ? FAMILY_ORDER.length : i;
};

/** The last platform model that probed live — tried first (after the override) on the next
 *  resolution so a stable catalog costs one probe, not a rescan. */
let lastLivePlatformModel: string | null = null;

/**
 * @description Discover the currently-listed `:free` OpenRouter models at runtime — the durable
 * fix for free-model rot: every hardcoded id eventually 404s (delisted) or 402s (moved to paid)
 * as the free catalog churns. Filters to ids ending `:free` WITH zero prompt+completion pricing
 * (both conditions — the shared key must never spend), ranks by family preference then context
 * length, and caches the result briefly. On discovery failure the previous catalog (if any) is
 * kept so a transient /models blip doesn't drop the whole fallback lane.
 * @param apiKey - the platform OpenRouter key
 * @param baseUrl - the OpenRouter OpenAI-compatible base URL
 * @returns ranked `:free` model ids (possibly empty when discovery fails with no prior catalog)
 */
async function discoverPlatformFreeModels(apiKey: string, baseUrl: string): Promise<string[]> {
  if (freeCatalog && Date.now() < freeCatalog.until) return freeCatalog.models;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const r = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` }, signal: ctrl.signal,
    });
    if (!r.ok) {
      logger.warn({ status: r.status }, 'free-tier: OpenRouter model discovery failed — keeping previous catalog');
      return freeCatalog?.models ?? [];
    }
    const body = await r.json().catch(() => null) as { data?: DiscoveredModel[] } | null;
    const free = (body?.data ?? []).filter((m) =>
      typeof m?.id === 'string' && /:free$/i.test(m.id)
      && Number(m.pricing?.prompt ?? '0') === 0 && Number(m.pricing?.completion ?? '0') === 0);
    free.sort((a, b) => familyRank(a.id) - familyRank(b.id) || (b.context_length ?? 0) - (a.context_length ?? 0));
    const models = free.map((m) => m.id);
    if (models.length) freeCatalog = { models, until: Date.now() + FREE_CATALOG_TTL_MS };
    else logger.warn('free-tier: OpenRouter discovery returned no :free models');
    return models;
  } catch (err) {
    logger.warn({ err }, 'free-tier: OpenRouter model discovery errored — keeping previous catalog');
    return freeCatalog?.models ?? [];
  } finally {
    clearTimeout(timer);
  }
}

/** One remembered platformFreeConnection() verdict. Probes are REAL completions that spend the
 *  shared key's daily free quota (~6 per resolution — observed burning the whole 50/day wall by
 *  mid-morning, live-hit 2026-07-10), so a resolution is remembered briefly instead of re-probed
 *  on every ask. A live model is held a little while; an all-walled verdict (conn: null) is held
 *  longer so requests fast-fall to the bot's configured provider without re-burning probes. */
let platformVerdict: { conn: ByoLlmConnection | null; until: number } | null = null;
const PLATFORM_LIVE_TTL_MS = 10 * 60_000;
const PLATFORM_WALLED_TTL_MS = 15 * 60_000;

/**
 * @description The platform's OWN OpenRouter key as an invisible default fallback — "we have a token
 * too, usable but never shown." Reads `OPENROUTER_API_KEY` from env (operator's key, gitignored .env /
 * a secret store — NEVER hardcoded or returned to the client). Returns null when the env key is unset,
 * so the whole fallback is opt-in. All models are `:free` so the shared key can't accrue spend. Users
 * connecting their OWN key always take precedence.
 *
 * PROBES + ROTATES (2026-07-08 fix): returns the FIRST candidate that answers live, so a delisted or
 * rate-limited free model no longer dead-ends the fallback. When EVERY probe fails (2026-07-10 fix:
 * OpenRouter's free-requests/day cap is ACCOUNT-WIDE, so a walled key 429s on every model) it returns
 * null — handing back an unprobed candidate is a guaranteed-dead connection that would block the
 * caller's documented fallback to the bot's configured provider. Verdicts are cached in-memory
 * (see platformVerdict) because the probes themselves spend the daily free quota.
 *
 * DISCOVERS (2026-07-12 fix): candidates come from live GET /models discovery (see
 * discoverPlatformFreeModels), not a hardcoded list — hardcoded free ids rotted (404/402) as the
 * catalog churned. Order: OPENROUTER_FREE_MODEL override → last-live model → discovered rank,
 * capped at MAX_PLATFORM_PROBES. Platform probes require actual content (requireContent) so a
 * reasoning model that eats a small max_tokens and answers 200-but-empty is rotated past.
 * @returns { baseUrl, apiKey, model }, or null when the env key is unset or the key is walled.
 */
export async function platformFreeConnection(): Promise<ByoLlmConnection | null> {
  const apiKey = (process.env.OPENROUTER_API_KEY || '').trim();
  if (!apiKey) return null;
  const prov = getFreeProvider('openrouter');
  if (!prov) return null;
  if (platformVerdict && Date.now() < platformVerdict.until) return platformVerdict.conn;

  const override = (process.env.OPENROUTER_FREE_MODEL || '').trim();
  if (override && !/:free$/i.test(override)) {
    logger.warn({ override }, 'free-tier: OPENROUTER_FREE_MODEL is not a :free model — ignored (platform key is free-only)');
  }
  const discovered = await discoverPlatformFreeModels(apiKey, prov.baseUrl);
  // HARD free-only guard (operator directive 2026-07-11): the shared account now carries real
  // credit ($10 daily-ceiling unlock), so a paid model id here would actually spend. Drop any
  // non-`:free` candidate — including a misconfigured override — rather than probe or run it.
  const candidates = [...new Set([
    ...(override ? [override] : []),
    ...(lastLivePlatformModel ? [lastLivePlatformModel] : []),
    ...discovered,
  ])].filter((model) => /:free$/i.test(model)).slice(0, MAX_PLATFORM_PROBES);
  if (!candidates.length) {
    logger.warn('free-tier: no :free platform candidates (discovery empty/failed, no valid override) — falling back to the bot\'s configured provider');
    platformVerdict = { conn: null, until: Date.now() + PLATFORM_WALLED_TTL_MS };
    return null;
  }
  for (const model of candidates) {
    const status = await probe({
      connectionId: 'platform-openrouter', providerId: 'openrouter', clineProvider: 'openrouter',
      model, baseUrl: prov.baseUrl, apiKey, label: 'platform',
    }, { requireContent: true });
    if (status === 'ok') {
      const conn = { baseUrl: prov.baseUrl, apiKey, model };
      lastLivePlatformModel = model;
      platformVerdict = { conn, until: Date.now() + PLATFORM_LIVE_TTL_MS };
      return conn;
    }
  }
  logger.warn('free-tier: every platform free model is walled/erroring — falling back to the bot\'s configured provider');
  platformVerdict = { conn: null, until: Date.now() + PLATFORM_WALLED_TTL_MS };
  return null;
}

const RETRYABLE_PROVIDER_FAILURE = /(?:\b(?:402|403|429)\b|too many requests|rate[-\s]?limit|quota|throttl\w*|resourceexhausted|empty_final_answer|returned no final answer)/i;

/**
 * @description Records a real execution-time provider wall. Probes can race with the provider's
 * free-tier quota, so a cached "live" verdict is not authoritative for the later completion call.
 * User-owned free connections are cooled in the LRU table; the shared platform verdict is changed
 * to a short all-walled result so the immediate retry uses the bot's configured provider without
 * burning six more probe completions.
 */
export async function reportResolvedLlmFailure(
  pool: any,
  connection: ResolvedUserLlmConnection | undefined,
  error: unknown,
): Promise<boolean> {
  // An explicit BYO endpoint is a user-selected privacy/billing boundary. Never silently replay
  // that prompt on the bot's configured provider; surface its failure to the user instead.
  if (!connection || connection.resolutionSource === 'explicit') {
    return false;
  }
  const errorText = error instanceof Error
    ? `${String((error as Error & { code?: unknown }).code || '')} ${error.message}`
    : String(error);
  if (!RETRYABLE_PROVIDER_FAILURE.test(errorText)) {
    return false;
  }
  if (connection.resolutionSource === 'free-tier' && connection.connectionId) {
    try {
      await reportRateLimit(pool, connection.connectionId);
    } catch (stateError) {
      // Rotation telemetry must not suppress the one bounded configured-provider retry.
      logger.warn({ err: stateError, connectionId: connection.connectionId }, 'free-tier: failed to persist runtime cooldown');
    }
  } else if (connection.resolutionSource === 'platform') {
    platformVerdict = { conn: null, until: Date.now() + PLATFORM_WALLED_TTL_MS };
    logger.warn({ model: connection.model }, 'free-tier: live platform execution hit a provider wall; using configured-provider fallback');
  }
  return true;
}

/**
 * @description True when this call runs for the operator. The swarm's default BYOK login (the
 * mounted claude/codex OAuth every bot node is configured with) IS the operator's own
 * subscription, so the free-tier legs must not hijack their turns onto `:free` models — the
 * free tier exists to keep OTHER users off the operator's subscriptions (operator decision
 * 2026-07-10). Interactive requests carry isOperator on the ambient request identity (set by
 * the RLS identity middleware); background/scheduled work has no ambient identity, so fall
 * back to the OSHAL_OPERATOR_SUBS allowlist (same env the authz helpers read).
 * @param userSub - the caller's OIDC sub
 * @returns true when the caller is the operator
 */
function isOperatorCaller(userSub: string): boolean {
  const ambient = getRequestIdentity();
  if (ambient && ambient.sub === userSub) return ambient.isOperator;
  const subs = (process.env.OSHAL_OPERATOR_SUBS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return subs.includes(userSub.toLowerCase());
}

/**
 * @description The per-request LLM resolver the agentic routes call. Returns the OpenAI-compatible
 * { baseUrl, apiKey, model } the execution handler runs as `byoLlmConnection` (routed through
 * Cline / the OpenAI provider, ADR-005). Order of precedence:
 *   1. the user's EXPLICIT bring-your-own endpoint,
 *   2. (non-operator callers only) a probed-live pick from the user's own connected free tiers,
 *   3. (non-operator callers only) the platform's OpenRouter fallback key on a free model
 *      (invisible default — opt-in via OPENROUTER_API_KEY), so a user who has connected nothing
 *      can still run for free by default.
 * The OPERATOR skips 2–3: their turns and scheduled runs stay on the bot's configured provider
 * (the swarm claude/codex login — theirs already), not a `:free` model (see isOperatorCaller).
 * Returns undefined when nothing applies → the bot's configured provider runs (the previous
 * behavior). Purely additive: the platform fallback is off unless the env key is set.
 * @param pool @param userSub
 * @returns { baseUrl, apiKey, model } or undefined
 */
export async function resolveUserLlmConnection(
  pool: any, userSub: string,
): Promise<ResolvedUserLlmConnection | undefined> {
  const byo = await getUserLlmConnection(pool, userSub);
  if (byo) return { ...byo, resolutionSource: 'explicit' };
  if (isOperatorCaller(userSub)) return undefined;
  const free = await resolveLiveFreeTierConnection(pool, userSub);
  if (free) {
    return {
      baseUrl: free.baseUrl, apiKey: free.apiKey, model: free.model,
      resolutionSource: 'free-tier', connectionId: free.connectionId,
    };
  }
  const platform = await platformFreeConnection();
  return platform ? { ...platform, resolutionSource: 'platform' } : undefined;
}
