/**
 * Which brain runs this user's turn (ADR-127).
 *
 * Before this module the answer was a fixed ladder inside `resolveUserLlmConnection`: explicit BYO,
 * then the free-tier legs, then (demo) the deployment's own API keys. Two things were missing — a
 * user could not SAY which of their connected providers they wanted, and a mounted CLI login could
 * never be the answer at all, because SEC-05 refuses autonomous CLI harnesses at a bot node.
 *
 * The resolution here returns one of three shapes, and the caller wires each to an existing rail:
 *   - `hosted` → the OpenAI-compatible {baseUrl, apiKey, model} that rides as `byoLlmConnection`.
 *   - `cli`    → a provider id the controller STAMPS on the dispatch (the ADR-034 authoritative
 *                dispatch record), which the node reconciles its active provider to before running.
 *   - `none`   → nothing usable; the caller owes the user an honest "no engine connected".
 *
 * The CLI shape is only ever produced under the ADR-127 carve (demo deployment + an operator-owned
 * request). It is deliberately the SAME condition the node's preflight enforces — the controller
 * never hands out a selection the node would refuse, and the node never trusts the controller's
 * word for it.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-127: per-user preference store + preference-aware brain resolution (preference → demo CLI default → explicit BYO → free tiers → operator-key lane → none).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added isRetryableCliBrainFailure so a CLI-lane turn can fall back to a hosted lane. reportResolvedLlmFailure speaks only for hosted connections (it refuses when there is none, which is every CLI turn), so a logged-out CLI login dead-ended instead of retrying.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | DEMO_CLI_ORDER flipped to codex-first (operator directive 2026-08-12: codex is the swarm's default CLI/API/LLM). Claude Code stays as the second rung so a codex blip degrades to the other mounted login instead of dead-ending.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-128 Amendment 1 (operator directive 2026-08-13): claude-code removed as a DEFAULT — the subscription is being cancelled, so an automatic degrade onto it turns a codex outage into silent spend on a dying account. DEMO_CLI_ORDER is ['openai-codex'] only; an explicitly named claude-code preference (resolveNamedPreference) still resolves.
 *
 * @module user-brain-resolution
 */

import { createChildLogger } from '@/shared/logger';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { demoModeEnabled, isDeploymentOperatorSub } from '@/shared/deployment-mode';
import { getUserLlmConnection } from './byo-llm-routes';
import {
  resolveLiveFreeTierConnection,
  resolveUserLlmConnection,
  type ResolvedUserLlmConnection,
} from './free-tier-rotation';

const logger = createChildLogger({ module: 'user-brain-resolution' });

/** The providers a user may name as their default. `auto` = walk the ladder. */
export const LLM_PREFERENCE_IDS = ['auto', 'claude-code', 'openai-codex', 'any-llm', 'free-tier'] as const;
export type LlmPreferenceId = typeof LLM_PREFERENCE_IDS[number];

/** The mounted CLI logins the demo default tries, in order. **Codex is the only rung**
 * (operator directive 2026-08-13, amending ADR-128 #2 and superseding ADR-127's
 * claude-code-first order): the Claude Code subscription is being cancelled, so a ladder that
 * silently degrades onto it hands turns to an account that is going away — a failure the operator
 * would discover as a billing surprise or a dead bot, not as an error. A codex blip now surfaces
 * as a codex blip. Claude Code remains selectable as an EXPLICIT per-user preference
 * ({@link resolveNamedPreference}) and as a per-bot harness override; it is no longer a default
 * anything. The array type keeps both ids so naming one explicitly still typechecks. */
export const DEMO_CLI_ORDER: Array<'claude-code' | 'openai-codex'> = ['openai-codex'];

/** A user's saved default. Absent row = { preferred: 'auto' }. */
export interface UserLlmPreference {
  preferred: LlmPreferenceId;
  model?: string;
}

/** What the caller should run this turn on. */
export type ResolvedBrain =
  | { kind: 'hosted'; connection: ResolvedUserLlmConnection }
  | { kind: 'cli'; providerId: 'claude-code' | 'openai-codex'; model?: string }
  | { kind: 'none' };

/**
 * @description Whether this caller may be handed a CLI harness selection. Mirrors the node-side
 * carve exactly: a demo deployment AND an exact, case-sensitive operator subject. Anything else
 * gets a hosted rung or nothing — the controller must not offer what the node will refuse.
 * @param userSub - the caller's OIDC sub
 * @returns true when a `cli` resolution is admissible for this caller
 */
export function cliBrainAvailable(userSub: string): boolean {
  return demoModeEnabled() && isDeploymentOperatorSub(userSub);
}

/**
 * CLI-harness failures a hosted retry can survive: an expired or absent CLI login, a throttled
 * subscription, and the harness's own runtime/stall banners. Deliberately NOT the free-tier
 * rotation matcher — that one classifies hosted QUOTA walls and doubles as the signal that cools a
 * rotation lane, and a CLI lane has no rotation state to cool.
 */
const CLI_BRAIN_RETRYABLE =
  /not logged in|logged out|please run \/login|login required|invalid api key|\b(?:401|403)\b|unauthorized|authentication (?:issue|failed|required)|\boauth\b|\b(?:429|too many requests)\b|rate[-\s]?limit|quota|usage limit|throttl\w*|overloaded|CLI (?:task failed|encountered an error|error)|CLI stalled|INACTIVITY CIRCUIT BREAKER|runtime stall|exit code \d+/i;

/**
 * @description Whether a failed CLI-brain turn may be replayed once on a hosted lane. A CLI brain is
 * the DEPLOYMENT's own mounted harness, not an endpoint the user chose, so there is no privacy or
 * billing boundary to protect the way there is for an explicit BYO connection — the only question is
 * whether the harness failed for a reason a different lane can survive. A genuine content or
 * business-rule failure is not retried, because a second brain would only reproduce it.
 * @param error - the execution failure thrown by the turn
 * @returns true when the caller should retry this turn on a hosted endpoint
 */
export function isRetryableCliBrainFailure(error: unknown): boolean {
  const text = error instanceof Error
    ? `${String((error as Error & { code?: unknown }).code || '')} ${error.message}`
    : String(error);
  return CLI_BRAIN_RETRYABLE.test(text);
}

/** Table bootstrap — same runtime path every other per-user store uses. */
async function ensurePreferenceSchema(pool: any): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'user-brain-resolution',
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_user_llm_prefs (
         user_sub TEXT PRIMARY KEY,
         preferred_provider TEXT NOT NULL,
         preferred_model TEXT,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
    ],
    requirements: [
      { table: 'oshal_user_llm_prefs', columns: ['user_sub', 'preferred_provider', 'preferred_model', 'updated_at'] },
    ],
  });
}

/**
 * @description Read a user's saved default brain. A missing row, an unreadable row, or a value this
 * build no longer recognizes all mean `auto` — a preference must never be able to break a turn.
 * @param pool - Postgres pool @param userSub - the caller's OIDC sub
 * @returns the saved preference, defaulted to `auto`
 */
export async function getUserLlmPreference(pool: any, userSub: string): Promise<UserLlmPreference> {
  try {
    await ensurePreferenceSchema(pool);
    const { rows } = await pool.query(
      'SELECT preferred_provider, preferred_model FROM oshal_user_llm_prefs WHERE user_sub = $1',
      [userSub],
    );
    const raw = String(rows?.[0]?.preferred_provider || 'auto') as LlmPreferenceId;
    const preferred = LLM_PREFERENCE_IDS.includes(raw) ? raw : 'auto';
    const model = rows?.[0]?.preferred_model ? String(rows[0].preferred_model) : undefined;
    return { preferred, ...(model ? { model } : {}) };
  } catch (err) {
    logger.warn({ err, userSub }, 'llm-preference: read failed — treating as auto');
    return { preferred: 'auto' };
  }
}

/**
 * @description Save a user's default brain. Writes under the caller's own identity, so RLS on
 * oshal_user_llm_prefs is what actually scopes it — this function does not police ownership.
 * @param pool @param userSub @param preferred - one of LLM_PREFERENCE_IDS @param model - optional pin
 * @returns the stored preference
 */
export async function saveUserLlmPreference(
  pool: any, userSub: string, preferred: LlmPreferenceId, model?: string,
): Promise<UserLlmPreference> {
  await ensurePreferenceSchema(pool);
  const pinned = (model || '').trim() || null;
  await pool.query(
    `INSERT INTO oshal_user_llm_prefs (user_sub, preferred_provider, preferred_model)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_sub) DO UPDATE
       SET preferred_provider = EXCLUDED.preferred_provider,
           preferred_model = EXCLUDED.preferred_model`,
    [userSub, preferred, pinned],
  );
  logger.info({ userSub, preferred, model: pinned }, 'llm-preference: saved');
  return { preferred, ...(pinned ? { model: pinned } : {}) };
}

/** The user's own saved endpoint, as a resolved hosted brain. */
async function explicitHosted(pool: any, userSub: string): Promise<ResolvedBrain | null> {
  const byo = await getUserLlmConnection(pool, userSub);
  return byo ? { kind: 'hosted', connection: { ...byo, resolutionSource: 'explicit' } } : null;
}

/** The user's own connected free tiers, probed live. */
async function freeTierHosted(pool: any, userSub: string): Promise<ResolvedBrain | null> {
  const free = await resolveLiveFreeTierConnection(pool, userSub);
  if (!free) return null;
  return {
    kind: 'hosted',
    connection: {
      baseUrl: free.baseUrl, apiKey: free.apiKey, model: free.model,
      resolutionSource: 'free-tier', connectionId: free.connectionId,
    },
  };
}

/** Honour an explicitly named provider. Returns null when that choice is not usable right now. */
async function resolveNamedPreference(
  pool: any, userSub: string, pref: UserLlmPreference,
): Promise<ResolvedBrain | null> {
  if (pref.preferred === 'claude-code' || pref.preferred === 'openai-codex') {
    if (!cliBrainAvailable(userSub)) return null;
    return { kind: 'cli', providerId: pref.preferred, ...(pref.model ? { model: pref.model } : {}) };
  }
  if (pref.preferred === 'any-llm') return explicitHosted(pool, userSub);
  if (pref.preferred === 'free-tier') return freeTierHosted(pool, userSub);
  return null;
}

/**
 * @description Resolve which brain runs this turn (ADR-127).
 *
 * Order: the user's named preference when usable → the demo CLI default (Claude Code, then Codex)
 * for a caller the carve covers → their explicit BYO endpoint → their free tiers → the platform
 * free lane → the deployment's own API keys (demo, operator) → none.
 *
 * The demo CLI default sits ABOVE explicit BYO on purpose, and only ever affects a caller the carve
 * covers (the operator of a demo box): on such a box the mounted subscription is the brain the
 * operator installed the product to use. Any user who wants their own endpoint instead names it in
 * Settings, which is checked first.
 * @param pool - Postgres pool @param userSub - the caller's OIDC sub
 * @returns the brain to run on, or { kind: 'none' }
 */
export async function resolveUserBrain(pool: any, userSub: string): Promise<ResolvedBrain> {
  const pref = await getUserLlmPreference(pool, userSub);
  if (pref.preferred !== 'auto') {
    const named = await resolveNamedPreference(pool, userSub, pref);
    if (named) return named;
    logger.warn({ userSub, preferred: pref.preferred }, 'llm-preference: named provider unusable — falling down the ladder');
  }
  if (cliBrainAvailable(userSub)) return { kind: 'cli', providerId: DEMO_CLI_ORDER[0] };
  // The hosted rungs stay in ONE place: resolveUserLlmConnection already encodes explicit BYO →
  // (non-operator only) free tiers → platform free → (demo operator) the deployment's own keys,
  // including the operator's exemption from the `:free` legs. Re-implementing that order here is
  // how the two ladders would silently drift apart.
  const hosted = await resolveUserLlmConnection(pool, userSub);
  return hosted ? { kind: 'hosted', connection: hosted } : { kind: 'none' };
}
