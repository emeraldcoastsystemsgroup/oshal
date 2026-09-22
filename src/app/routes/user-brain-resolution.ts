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
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | gemini-cli joins the preference ids and the cli ResolvedBrain, through resolveGeminiCliBrain. Google is the only vendor where the pushed login and the API key are not the same lane: the key reaches generativelanguage.googleapis.com on the free tier (live 429, generate_content_free_tier_requests limit 0), while the credential 'gemini' writes is oauth-personal against cloudcode-pa.googleapis.com - verified in the installed CLI bundle. So a turn under a pushed login MUST resolve to the CLI harness and cannot be served by the HTTP provider. The carve is unchanged: cliBrainAvailable still decides WHO, and the extra pushed-login condition only decides whether the selection is honest; with no pushed login the resolution falls through to the hosted lane rather than naming a harness nothing can run. DEMO_CLI_ORDER is untouched - Gemini is selectable, never a default.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | A CLI brain is only offered when a bot node can actually EXECUTE it. Entry 5 gated the Gemini selection on a pushed sign-in and stopped there, so the moment a login was pushed the option went live - and the resolved {kind:'cli', providerId:'gemini-cli'} is refused BY NAME at the node, because HARNESS_BY_ID gives it botNodeRuntime: null and it is not a ProviderRegistry id either, so resolveBotNodeSwitch answers null and reconcileDispatchProviderConfig throws AuthoritativeDispatchConfigError. An operator who followed the instructions exactly - sign in, push, pick the option - had every turn afterwards refused. cliBrainOffer now answers one question for all four CLI ids (is the caller carved in, is there a node runtime, can this machine load the binary, is the credential obtainable) and BOTH the offer surface and this resolver call it, so what is offered and what resolves cannot drift apart. It only ever narrows: cliBrainAvailable still decides WHO, unchanged.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | antigravity-cli joins the preference ids and the cli ResolvedBrain. Google retired Gemini Code Assist sign-in for individuals on 2026-09-22 and points them at Antigravity instead, and `agy` is the one Google path measured answering on the models the shared API key 503s on - but it runs as the signed-in user, on a machine that can load it. Both remaining conditions are checked rather than assumed, so on the shipped stack the option is correctly NOT offered (see the backlog entry for what each one needs).
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | isRetryableCliBrainFailure treats an unresolvable dispatch (AuthoritativeDispatchConfigError / AUTHORITATIVE_PROVIDER_UNAVAILABLE) as retryable-to-hosted. It is thrown before the harness does any work, so it is a fact about the LANE and never about the turn - and without this arm the Jarvis CLI-lane retry never fired for it and the raw error reached the user on every turn. Entry 6 makes such a selection unreachable; this makes a future mis-selection DEGRADE instead of dead-ending.
 *
 * @module user-brain-resolution
 */

import { createChildLogger } from '@/shared/logger';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { demoModeEnabled, isDeploymentOperatorSub } from '@/shared/deployment-mode';
import { antigravityNodeCredentialReady, antigravityNodeReadiness, geminiPushedLoginPresent } from '@/features/llm-provider';
import { botNodeCanRunProvider } from '@/shared/llm-runtime';
import { getUserLlmConnection } from './byo-llm-routes';
import {
  resolveLiveFreeTierConnection,
  resolveUserLlmConnection,
  type ResolvedUserLlmConnection,
} from './free-tier-rotation';

const logger = createChildLogger({ module: 'user-brain-resolution' });

/** The providers a user may name as their default. `auto` = walk the ladder. */
export const LLM_PREFERENCE_IDS = ['auto', 'claude-code', 'openai-codex', 'gemini-cli', 'antigravity-cli', 'any-llm', 'free-tier'] as const;
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
  | { kind: 'cli'; providerId: CliBrainProviderId; model?: string }
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

/** The four CLI harnesses a user may name as their brain. Not all of them can run everywhere. */
export type CliBrainProviderId = 'claude-code' | 'openai-codex' | 'gemini-cli' | 'antigravity-cli';

/** Why a CLI brain is not on offer. Each value is a different missing PIECE, not a severity. */
export type CliBrainRefusal =
  /** The ADR-127 carve does not cover this caller: not a demo deployment, or not its operator. */
  | 'not-carved'
  /** No bot-node runtime executes this provider id, so a dispatch stamped with it is refused. */
  | 'no-node-runtime'
  /** A runtime exists, but this machine cannot load the vendor binary (absent, or wrong libc). */
  | 'node-cannot-run'
  /** Everything is in place except a credential the vendor will still issue. */
  | 'no-credential';

/** Whether this caller may be offered one CLI brain right now, and what is missing when not. */
export interface CliBrainOffer {
  available: boolean;
  refusal: CliBrainRefusal | null;
  /** A sentence naming the cause, for a surface to show. Empty when available. */
  detail: string;
}

/** Probe injection so a test never reads a real credential path or a real install. */
export interface CliBrainOfferOptions {
  pushedLoginPresent?: () => boolean;
  canRunProvider?: (providerId: string) => boolean;
  antigravityRunnable?: () => { runnable: boolean; detail: string };
  antigravityCredentialPresent?: () => boolean;
}

const OFFERED: CliBrainOffer = { available: true, refusal: null, detail: '' };

/**
 * @description Whether one CLI brain may be OFFERED to this caller — the single question both the
 * settings surface and {@link resolveNamedPreference} ask.
 *
 * It exists because those two had drifted apart, and the gap was not cosmetic. The surface offered
 * `gemini-cli` the moment a Google login was pushed; the resolver honoured that preference and
 * returned `{ kind: 'cli', providerId: 'gemini-cli' }`; and the node then refused the dispatch by
 * name, because no bot-node runtime resolves that id. A user who followed the instructions exactly
 * had every turn fail afterwards. One function, two callers, is the structural fix — an option can
 * no longer be offered that the resolver would not produce, nor produced that the node cannot run.
 *
 * The conditions are checked in order of how expensive they are to be wrong about, cheapest first,
 * and each is a separate FACT rather than a judgement:
 *   1. the ADR-127 carve (who) — unchanged, and never widened here;
 *   2. a bot-node runtime for the id (can anything execute it) — read from the harness table, so
 *      it flips by itself the day a runtime is wired rather than being a stale constant;
 *   3. this machine being able to load the vendor binary (Antigravity only — measured, see
 *      antigravity-cli-availability);
 *   4. the vendor credential existing at all (both Google CLIs, through their distinct probes).
 * @param providerId - The CLI harness id being considered
 * @param userSub - The caller's OIDC sub
 * @param options - Probe injection used by tests
 * @returns Whether to offer it, and the missing piece when not
 */
export function cliBrainOffer(
  providerId: CliBrainProviderId,
  userSub: string,
  options: CliBrainOfferOptions = {},
): CliBrainOffer {
  if (!cliBrainAvailable(userSub)) {
    return { available: false, refusal: 'not-carved', detail: 'Available only to the operator of a deployment running in demo mode.' };
  }
  const canRun = options.canRunProvider ?? botNodeCanRunProvider;
  if (!canRun(providerId)) {
    return {
      available: false,
      refusal: 'no-node-runtime',
      detail: `No bot node can execute ${providerId} — a turn stamped with it is refused by name before the harness starts.`,
    };
  }
  if (providerId === 'antigravity-cli') return antigravityOffer(options);
  if (providerId === 'gemini-cli') return geminiCredentialOffer(options);
  return OFFERED;
}

/** The Antigravity machine check: the binary has to be present and this node's libc able to load it. */
function antigravityOffer(options: CliBrainOfferOptions): CliBrainOffer {
  const readiness = (options.antigravityRunnable ?? antigravityNodeReadiness)();
  if (!readiness.runnable) return { available: false, refusal: 'node-cannot-run', detail: readiness.detail };
  const credential = options.antigravityCredentialPresent ?? antigravityNodeCredentialReady;
  if (credential()) return OFFERED;
  return {
    available: false,
    refusal: 'no-credential',
    detail: 'The bot-node Antigravity runtime has no proven Linux account login. The existing Windows '
      + 'Credential Manager session is not portable; provision a persistent Linux Secret Service/D-Bus '
      + 'keyring, authenticate agy there, prove one headless turn, then set ANTIGRAVITY_ACCOUNT_LOGIN_READY=true.',
  };
}

/** The Google credential check: an adopted sign-in has to actually be at the mounted path. */
function geminiCredentialOffer(options: CliBrainOfferOptions): CliBrainOffer {
  const probe = options.pushedLoginPresent ?? geminiPushedLoginPresent;
  if (probe()) return OFFERED;
  return {
    available: false,
    refusal: 'no-credential',
    detail: 'No Google sign-in has been adopted here, and a Google API key is not one — the key '
      + 'runs on the free tier against a different endpoint entirely.',
  };
}

/**
 * @description Whether a Gemini turn for this caller must run on the gemini-cli harness rather
 * than the hosted HTTP provider.
 *
 * This is the one place the Google rail differs from its two siblings, and the difference is
 * measured, not stylistic. A `GOOGLE_API_KEY` reaches
 * `generativelanguage.googleapis.com` on Google's FREE tier — a live `gemini-3.1-pro-preview` call
 * on this deployment's key answers 429 naming `generate_content_free_tier_requests, limit: 0` —
 * while the credential the operator's own `gemini` sign-in writes is a different identity on a
 * different endpoint: the CLI's `oauth-personal` mode builds a CodeAssistServer against
 * `https://cloudcode-pa.googleapis.com` (verified in the installed @google/gemini-cli bundle,
 * `createCodeAssistContentGenerator` + `CODE_ASSIST_ENDPOINT`). So the pushed token is NOT a
 * drop-in for the API key on the HTTP path: a turn that is to run under the operator's own login
 * has to go through the CLI harness, and a turn that cannot must stay on the hosted lane rather
 * than pretend.
 *
 * Both ADR-127 conditions still apply unchanged — this widens WHICH harness the carve can select,
 * never WHO the carve covers.
 * @param userSub - the caller's OIDC sub
 * @param options - probe injection; tests pass a fake so no real credential path is read
 * @returns the CLI brain when the carve covers this caller AND a pushed login is present, else null
 */
export function resolveGeminiCliBrain(
  userSub: string,
  options: CliBrainOfferOptions & { model?: string } = {},
): ResolvedBrain | null {
  return resolveCliHarnessBrain('gemini-cli', userSub, options);
}

/**
 * @description The Antigravity CLI as this caller's brain, when the carve covers them and the node
 * can actually run it.
 *
 * Google retired Gemini Code Assist sign-in for individuals on 2026-09-22 — the CLI answers "This
 * client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini,
 * please migrate to the Antigravity suite of products" — and points them here instead. Antigravity
 * runs as the user's own Google identity, which is why it answers on models the deployment's
 * shared API key returns 503 "high demand" for.
 *
 * Two things still have to be true and BOTH are checked rather than assumed: some bot-node runtime
 * must execute `antigravity-cli`, and the node must be able to load the binary. Neither holds on
 * the shipped stack today, so this correctly resolves null there and the turn falls to the hosted
 * ladder — see `cliBrainOffer` for which piece is missing and the backlog for what each needs.
 * @param userSub - the caller's OIDC sub
 * @param options - probe injection; tests pass fakes so no real install is read
 * @returns the CLI brain when it can genuinely run, else null
 */
export function resolveAntigravityCliBrain(
  userSub: string,
  options: CliBrainOfferOptions & { model?: string } = {},
): ResolvedBrain | null {
  return resolveCliHarnessBrain('antigravity-cli', userSub, options);
}

/**
 * @description Turns an offer into a resolution, so a brain is produced on EXACTLY the conditions
 * the surface offered it on.
 * @param providerId - The CLI harness id
 * @param userSub - The caller's OIDC sub
 * @param options - Probe injection plus an optional model pin
 * @returns The cli brain, or null with the refusal logged
 */
function resolveCliHarnessBrain(
  providerId: CliBrainProviderId,
  userSub: string,
  options: CliBrainOfferOptions & { model?: string },
): ResolvedBrain | null {
  const offer = cliBrainOffer(providerId, userSub, options);
  if (!offer.available) {
    logger.info(
      { userSub, providerId, refusal: offer.refusal },
      'llm-preference: CLI brain not usable — staying on the hosted lane',
    );
    return null;
  }
  return { kind: 'cli', providerId, ...(options.model ? { model: options.model } : {}) };
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
 * The node's refusal to run a provider it has no runtime for. `reconcileDispatchProviderConfig`
 * throws it when the stamped provider cannot be made authoritative, and it is thrown BEFORE the
 * harness does any work, so it says nothing about the model, the prompt or the user's content —
 * only that this lane is the wrong lane. That makes it the most retryable failure there is.
 *
 * Matched structurally (the error name and the stable `code`) rather than by message text: the
 * only thing distinguishing the message is an interpolated provider id, so it is not a contract.
 */
const UNRESOLVABLE_DISPATCH_ERROR_NAME = 'AuthoritativeDispatchConfigError';
const UNRESOLVABLE_DISPATCH_ERROR_CODE = 'AUTHORITATIVE_PROVIDER_UNAVAILABLE';

/**
 * @description Whether a failure is the node refusing the stamped provider outright, rather than
 * the harness failing at its work.
 * @param error - the execution failure thrown by the turn
 * @returns true for AuthoritativeDispatchConfigError / AUTHORITATIVE_PROVIDER_UNAVAILABLE
 */
function isUnresolvableDispatch(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === UNRESOLVABLE_DISPATCH_ERROR_NAME
    || candidate.code === UNRESOLVABLE_DISPATCH_ERROR_CODE;
}

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
  // An UNRESOLVABLE DISPATCH is retryable before anything else is considered. The node throws it
  // when the stamped provider has no runtime behind it (bot-node-dispatch-config.ts), which is a
  // fact about the LANE, never about the turn — a hosted endpoint can always answer instead.
  // Without this arm a mis-selected CLI brain reached the user as "Authoritative provider config
  // is unavailable for <id>" on EVERY turn, with no degrade. A selection that should not have
  // been offered is a bug to fix at the offer; reaching the user raw is a second, worse bug.
  if (isUnresolvableDispatch(error)) return true;
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
  // Google's two CLIs are the same carve plus the conditions cliBrainOffer enumerates, and
  // returning null here is what falls down the ladder onto the hosted lane. That fallthrough is
  // the SAFE branch, and an earlier revision of this comment had it backwards — it called the
  // null "not a dead-letter CLI selection" when the dead letter was the other branch: naming
  // gemini-cli on a dispatch no bot node can resolve is precisely how a turn dead-ends, refused
  // by name at reconcileDispatchProviderConfig. A hosted rung is always an answer; a harness
  // nothing runs never is.
  if (pref.preferred === 'gemini-cli') return resolveGeminiCliBrain(userSub, { model: pref.model });
  if (pref.preferred === 'antigravity-cli') return resolveAntigravityCliBrain(userSub, { model: pref.model });
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
