/**
 * Bounded SAME-ENDPOINT retry for a turn running on an explicitly chosen BYO endpoint.
 *
 * WHY THIS IS A SEPARATE DECISION FROM ROTATION. `reportResolvedLlmFailure` (app layer) answers
 * exactly one question — *may this turn be replayed on a DIFFERENT provider?* — and for an explicit
 * BYO connection the answer is permanently no for a non-operator caller: the user picked that
 * endpoint as a privacy/billing boundary and silently spending their prompt somewhere else crosses
 * it. That refusal is correct and stays. What it was ALSO doing, by conflation, was denying the
 * turn a retry of any kind, so a provider-side spend cap that trips intermittently (operator,
 * 2026-09-21: a Pro account whose cap "sometimes triggers, sometimes doesn't", refusing with
 * HTTP 503 "This model is currently experiencing high demand") cost the whole turn and surfaced
 * an error. Replaying the same prompt against the same endpoint with the same key crosses no
 * boundary at all — it is the remedy the provider itself prescribes when it answers 429 or 503.
 *
 * WHERE THE RETRY SITS, and why it moved here from the app layer. The first build wrapped the
 * whole orchestrator turn, so every replay re-ran `saveUserMessage` (three saved user messages)
 * and every failed attempt broadcast its own SSE error (three error events) before the turn was
 * finally reported. The retry now wraps the PROVIDER CALL: {@link SameEndpointRetryProvider}
 * decorates the hosted BYO provider inside the orchestrator's turn, so the user message is saved
 * once, the error is broadcast once at the end, and an agentic wall that lands after tool calls
 * replays only the model call, never the tools. This module lives in the llm-provider feature
 * because the orchestrator (a feature) may not import the app layer.
 *
 * WHAT IS NOT RETRIED HERE, and why (the exclusions are subtractions from the shared
 * RETRYABLE_PROVIDER_FAILURE vocabulary — there is deliberately no second pattern for "retryable"):
 *   - `403` / forbidden / permission-denied — an authorization verdict about this key against this
 *     endpoint. It reproduces deterministically; a backoff changes nothing, so a same-endpoint
 *     replay only spends the waiting user's seconds on a certain failure. It stays in the ROTATION
 *     set because a different lane carries a different key.
 *   - `empty_final_answer` / "returned no final answer" — the endpoint answered HTTP 200 with no
 *     usable content. That call COMPLETED and was billed. It is not a wall, the same prompt on the
 *     same model tends to produce the same emptiness, and it is the one member of the vocabulary
 *     where the failed attempt already consumed tokens. Rotation-only.
 *   - A bare `500`, a `400`, a `401`, a `404`, or a timeout after the request was sent — none of
 *     these is a capacity signal, so none is in the vocabulary at all.
 *
 * WHAT THE BUDGET BOUNDS, and why it had to become per-TURN. Moving the retry from the orchestrator
 * turn down to the model call (seq 2) bought one saved user message and one broadcast — and quietly
 * turned `budgetMs` into a bound on ONE model call, because `runWithSameEndpointRetry` takes its own
 * `startedAt` and the decorator invokes it per `sendRequest`. An agentic turn makes up to
 * `maxTurns` model calls (25, agentic-loop.ts), so an endpoint that walls intermittently could be
 * replayed 3 times on each of them: measured at 75 attempts and 75_000 ms of pure backoff against a
 * budget that reads 15_000, while `.env.example` and ADR-137 Amendment B both describe it as the
 * turn's ceiling. Jarvis is separately capped by `DECISION_TIMEOUT_MS`; the cockpit
 * `POST /api/send-message` path is not, so nothing else would have caught it. The fix is the bound
 * the documents already promised: {@link SameEndpointRetryTurnBudget} is created once per decorator
 * — and the decorator is created once per orchestrator turn (`TaskOrchestrator.resolveProvider`) —
 * and the per-call budget nests inside it. It accounts REPLAY time only (the sleeps plus the
 * attempts after the first), never the turn's ordinary latency, so a long agentic turn whose model
 * calls are merely slow still gets its full retry; what it cannot do is spend the budget again on
 * every model call. Same arithmetic, same env var, now honestly per turn: 35 attempts and 15_000 ms
 * across those same 25 model calls.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial (as src/app/routes/same-endpoint-retry.ts) — classifier (a subtraction from the shared retryable vocabulary), the attempt/backoff/ceiling plan, and the bounded executor both chat entry points wrapped their turn in.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Moved into the llm-provider feature and turned into a PROVIDER decorator (SameEndpointRetryProvider) so the replay wraps the model call, not the orchestrator turn: one saved user message, one error broadcast, tools never re-run. Now owns RETRYABLE_PROVIDER_FAILURE (free-tier-rotation re-exports it) and adds HTTP 503 with a high-demand/overloaded/service-unavailable body — the exact refusal the operator's Gemini endpoint gave twice on 2026-09-21 — while a bare 500 stays outside the vocabulary. OSHAL_BYO_RETRY_MAX_ATTEMPTS=0 now means OFF (one attempt) instead of silently yielding the default, every override is clamped to a sane ceiling, and a clamp or an ignored value is logged once per process. The final surfaced failure is annotated with the attempt count (property + message suffix) so the hot fallback can say how many replays the endpoint refused.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | OSHAL_BYO_RETRY_BUDGET_MS now bounds the TURN, which is what .env.example and ADR-137 Amendment B already said it did. Seq 2's per-sendRequest startedAt made it a per-MODEL-CALL bound, so an agentic turn against an intermittently walling endpoint could spend it 25 times over — measured at 75 attempts and 75_000 ms of backoff on one turn, with no cap on the cockpit POST /api/send-message path. SameEndpointRetryTurnBudget is created once per decorator (one per orchestrator turn), accounts replay time only so ordinary turn latency never eats it, and the per-call budget nests inside it; the same 25 model calls now make 35 attempts and 15_000 ms. The attempt loop is split into runOneAttempt/surfaceFailure/refuseNextAttempt so it stays inside the function-length limit.
 *
 * @module same-endpoint-retry
 */

import { createChildLogger } from '@/shared/logger';
import { LLMService, type CostResult, type LLMResponse, type SendRequestOptions, type TokenUsage } from './llm-service';

const logger = createChildLogger({ module: 'same-endpoint-retry' });

/**
 * @description The ONE vocabulary of "this is a provider wall, not a content failure", shared by
 * the rotation gate in `free-tier-rotation.ts` (which re-exports it) and by the same-endpoint
 * classifier below, which subtracts from it. One pattern, so the answer to "was this a wall?" is
 * one answer. `503`, "high demand", "overloaded" and "service/temporarily unavailable" are the
 * capacity refusals a hosted endpoint gives when it is up but cannot take the call right now;
 * a bare `500` is deliberately absent — a server fault is not a capacity signal.
 */
export const RETRYABLE_PROVIDER_FAILURE =
  /(?:\b(?:402|403|429|503)\b|too many requests|rate[-\s]?limit|quota|throttl\w*|resourceexhausted|high demand|overloaded|(?:service|temporarily) unavailable|empty_final_answer|returned no final answer)/i;

/**
 * The classified shape of a turn failure, as it appears in the log line. `rate-limit`, `quota` and
 * `capacity` are the three that earn a same-endpoint replay; the rest name why one was refused, so
 * the next occurrence is evidence instead of a guess.
 */
export type SameEndpointRetryReason =
  | 'rate-limit'
  | 'quota'
  | 'capacity'
  | 'authorization'
  | 'completed-empty'
  | 'not-a-provider-wall';

/**
 * Authorization verdicts. Inside the retryable vocabulary this is `403`; the extra phrasings cost
 * nothing (they are already non-retryable) and keep a vendor that spells it out from sneaking a
 * deterministic failure into the retry loop.
 */
const AUTHORIZATION_FAILURE = /\b403\b|forbidden|unauthoriz|permission[_\s-]?denied|invalid[_\s-]?api[_\s-]?key/i;

/** A 200 with no usable content — the call completed and was billed. See the module docstring. */
const COMPLETED_EMPTY_ANSWER = /empty_final_answer|returned no final answer/i;

/** Spend/credit walls, as distinct from a pure request-rate wall. Both are retried; both are named. */
const QUOTA_FAILURE = /\b402\b|quota|resourceexhausted|insufficient[_\s-]?(?:quota|credit|funds)|credit balance/i;

/** The endpoint is up but cannot take the call right now — the 2026-09-21 refusal shape. */
const CAPACITY_FAILURE = /\b503\b|high demand|overloaded|(?:service|temporarily) unavailable/i;

/** The suffix the final surfaced failure carries, so a swallowed result still names the count. */
const ATTEMPTS_SUFFIX = /\((\d+) attempts on the same endpoint\)\s*$/;

/**
 * @description Renders a failure the way the classifier reads it: an Error contributes both its
 * `code` (vendors put the status there) and its message, anything else is stringified. Mirrors the
 * rendering `reportResolvedLlmFailure` does, so one error cannot be classified two ways.
 * @param error - The turn failure.
 * @returns The text the patterns are matched against.
 */
function failureText(error: unknown): string {
  return error instanceof Error
    ? `${String((error as Error & { code?: unknown }).code || '')} ${error.message}`
    : String(error);
}

/**
 * @description Decides whether a failure earns a replay against the SAME endpoint, and names the
 * class either way. Retryability is the shared `RETRYABLE_PROVIDER_FAILURE` vocabulary MINUS the
 * two classes a same-endpoint replay cannot help (see the module docstring); it is never a second
 * opinion about what counts as a provider wall.
 * @param error - The turn failure (thrown, or lifted off a swallowed failed result).
 * @returns Whether to retry, and the classified reason for the log line.
 */
export function classifySameEndpointRetry(error: unknown): {
  retry: boolean;
  reason: SameEndpointRetryReason;
} {
  const text = failureText(error);
  if (!RETRYABLE_PROVIDER_FAILURE.test(text)) {
    return { retry: false, reason: 'not-a-provider-wall' };
  }
  // Exclusions are checked FIRST: a body carrying both a 403 and rate-limit wording is the
  // authorization verdict, and treating it as the wall would retry a certain failure.
  if (AUTHORIZATION_FAILURE.test(text)) return { retry: false, reason: 'authorization' };
  if (COMPLETED_EMPTY_ANSWER.test(text)) return { retry: false, reason: 'completed-empty' };
  if (QUOTA_FAILURE.test(text)) return { retry: true, reason: 'quota' };
  return { retry: true, reason: CAPACITY_FAILURE.test(text) ? 'capacity' : 'rate-limit' };
}

/**
 * @description How many attempts the same-endpoint retry made before surfacing this failure.
 * Reads the property the executor stamps on a thrown error, else the message suffix a swallowed
 * result (the agentic loop resolves `{ success:false, error }` with the message only) still carries.
 * @param error - The surfaced failure.
 * @returns The attempt count; 1 when the failure was never retried.
 */
export function sameEndpointAttemptsOf(error: unknown): number {
  const stamped = (error as { sameEndpointAttempts?: unknown } | null | undefined)?.sameEndpointAttempts;
  if (typeof stamped === 'number' && stamped >= 1) return stamped;
  const match = ATTEMPTS_SUFFIX.exec(failureText(error));
  return match ? Number(match[1]) : 1;
}

/** The bound on a same-endpoint replay: how many tries, how long between them, and when to stop. */
export interface SameEndpointRetryPlan {
  /** Total attempts INCLUDING the first, so `1` disables retrying entirely. */
  maxAttempts: number;
  /** The first backoff; doubled on each subsequent retry. */
  baseDelayMs: number;
  /** Ceiling on any single backoff, so the doubling cannot run away. */
  maxDelayMs: number;
  /** Wall-clock ceiling measured from the first attempt's start. See {@link runWithSameEndpointRetry}. */
  budgetMs: number;
}

/**
 * The defaults, derived from the budget this path already lives inside rather than picked.
 *
 * `jarvis-routes.ts` races the whole decision turn against `DECISION_TIMEOUT_MS` (75 s default), and
 * that module records the persona as usually deciding in under 20 s. A provider wall is an admission
 * rejection, so it comes back in well under a second. Two retries at 1 s and 2 s (±25% jitter, capped
 * at 4 s) therefore add at most ~7 s of the 75 s before the attempt that succeeds begins — leaving
 * far more than the documented typical turn. `budgetMs` is the backstop for the case the arithmetic
 * does not cover: attempts that are themselves slow, and an agentic turn that walls on model call
 * after model call — it is the TURN's replay ceiling ({@link SameEndpointRetryTurnBudget}), inside
 * which each model call's own `budgetMs` applies, so 25 agentic model calls cannot multiply it. All
 * four are env-overridable because the numbers are a deployment's latency tolerance, not a fact
 * about the code.
 */
export const DEFAULT_SAME_ENDPOINT_RETRY_PLAN: Readonly<SameEndpointRetryPlan> = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 4_000,
  budgetMs: 15_000,
});

/**
 * The most any override may ask for. A retry loop exists to absorb a blip, not to hold a user's
 * turn open for minutes: ten attempts and a two-minute clock are already past what any interactive
 * surface tolerates, so anything larger is a typo and is clamped, loudly, once.
 */
export const SAME_ENDPOINT_RETRY_CEILING: Readonly<SameEndpointRetryPlan> = Object.freeze({
  maxAttempts: 10,
  baseDelayMs: 30_000,
  maxDelayMs: 60_000,
  budgetMs: 120_000,
});

/** Env vars already reported (ignored or clamped) this process, so the log says it exactly once. */
const planOverrideWarned = new Set<string>();

/**
 * @description Test seam: forget which overrides were already reported so a guard can observe the
 * once-only log line again.
 * @returns void
 */
export function resetSameEndpointRetryPlanWarningsForTesting(): void {
  planOverrideWarned.clear();
}

/**
 * @description Reads the retry bound from the environment, falling back to
 * {@link DEFAULT_SAME_ENDPOINT_RETRY_PLAN}. `OSHAL_BYO_RETRY_MAX_ATTEMPTS=0` (or `1`) switches the
 * retry OFF — exactly one attempt, no replay. A non-numeric or negative override is ignored rather
 * than obeyed and a value above {@link SAME_ENDPOINT_RETRY_CEILING} is clamped to it; either is
 * logged once per process, because a typo in an env var must neither silently switch the retry
 * off nor unbound it, and must not be silent either.
 * @param env - The environment to read (injectable for guards).
 * @returns The effective plan.
 */
export function sameEndpointRetryPlan(env: NodeJS.ProcessEnv = process.env): SameEndpointRetryPlan {
  const read = (name: string, fallback: number, min: number, ceiling: number): number => {
    const raw = (env[name] ?? '').trim();
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < min) {
      warnOnce(name, { raw, fallback }, `${name} is not a number >= ${min} — ignored, using ${fallback}`);
      return fallback;
    }
    if (parsed > ceiling) {
      warnOnce(name, { raw, ceiling }, `${name}=${raw} exceeds the ceiling — clamped to ${ceiling}`);
      return ceiling;
    }
    return parsed;
  };
  const plan = DEFAULT_SAME_ENDPOINT_RETRY_PLAN;
  const ceiling = SAME_ENDPOINT_RETRY_CEILING;
  return {
    // 0 = off. Both 0 and 1 mean "one attempt, never replay"; the loop below treats them identically.
    maxAttempts: Math.max(1, read('OSHAL_BYO_RETRY_MAX_ATTEMPTS', plan.maxAttempts, 0, ceiling.maxAttempts)),
    baseDelayMs: read('OSHAL_BYO_RETRY_BASE_DELAY_MS', plan.baseDelayMs, 0, ceiling.baseDelayMs),
    maxDelayMs: read('OSHAL_BYO_RETRY_MAX_DELAY_MS', plan.maxDelayMs, 0, ceiling.maxDelayMs),
    budgetMs: read('OSHAL_BYO_RETRY_BUDGET_MS', plan.budgetMs, 0, ceiling.budgetMs),
  };
}

/** Logs an override problem the first time it is seen this process, then stays quiet. */
function warnOnce(name: string, detail: Record<string, unknown>, message: string): void {
  const key = `${name}:${message}`;
  if (planOverrideWarned.has(key)) return;
  planOverrideWarned.add(key);
  logger.warn({ name, ...detail }, `same-endpoint retry plan: ${message}`);
}

/**
 * @description Exponential backoff with symmetric jitter. Jitter matters even for one user: the
 * cockpit chat panel and a Jarvis turn can wall on the same cap in the same second, and lockstep
 * retries would hit the recovering endpoint together.
 * @param attempt - The attempt that just failed (1-based).
 * @param plan - The effective bound.
 * @param random - Uniform [0,1) source (injectable for guards).
 * @returns The delay before the next attempt, in ms.
 */
export function sameEndpointBackoffMs(
  attempt: number,
  plan: SameEndpointRetryPlan,
  random: () => number = Math.random,
): number {
  const base = Math.min(plan.maxDelayMs, plan.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jitter = 1 + (random() - 0.5) / 2; // +/-25%
  return Math.max(0, Math.round(base * jitter));
}

/** What the log lines identify the endpoint by. The api key never appears in any of it. */
export interface SameEndpointRetryContext {
  /** The bot whose turn this is. */
  agentId?: string;
  /** The endpoint's base URL; only its host is ever logged. */
  baseUrl?: string;
  /** The model id. */
  model?: string;
}

/**
 * @description The TURN's shared replay ceiling, which each model call's own `budgetMs` nests
 * inside. It counts ONLY what the retry machinery added — the backoff sleeps plus the attempts
 * after the first — so a turn whose model calls are simply slow keeps its full retry, while a turn
 * that walls on call after call cannot spend the budget once per call. One instance per
 * {@link SameEndpointRetryProvider}, and one provider per orchestrator turn, is what makes "per
 * turn" true; there is no clock here, because the executor owns the clock seam.
 */
export class SameEndpointRetryTurnBudget {
  private spent = 0;

  constructor(
    /** The turn's total replay ceiling in ms — `budgetMs` from the effective plan. */
    readonly budgetMs: number,
  ) {}

  /** Replay time this turn has already spent, across every model call in it. */
  get spentMs(): number {
    return this.spent;
  }

  /**
   * @description Replay time this turn may still spend, never negative.
   * @returns The remaining ms.
   */
  remainingMs(): number {
    return Math.max(0, this.budgetMs - this.spent);
  }

  /**
   * @description Records replay time one model call consumed. Called once per model call, on every
   * exit path, so a call that threw still charges the turn for the replays it made.
   * @param ms - Replay time to charge; non-positive values are ignored.
   * @returns void
   */
  spend(ms: number): void {
    if (ms > 0) this.spent += ms;
  }
}

/** Injectable seams. Production passes at most `failureOf`; the clock/sleep/random are guard-only. */
export interface SameEndpointRetryHooks<T> {
  /**
   * Lifts a SWALLOWED failure off a resolved result, for a caller that wraps something which
   * resolves `{ success:false, error }` instead of throwing. The provider decorator never needs
   * it — a provider throws — but the executor stays general.
   */
  failureOf?: (result: T) => Error | undefined;
  /** Overrides on top of {@link sameEndpointRetryPlan}. */
  plan?: Partial<SameEndpointRetryPlan>;
  /**
   * The TURN's replay ceiling this call nests inside. {@link SameEndpointRetryProvider} creates one
   * per decorated provider, and the orchestrator creates one provider per turn. A direct caller that
   * omits it gets the per-call budget alone, which is all a single unrepeated call needs.
   */
  turnBudget?: SameEndpointRetryTurnBudget;
  /** Clock source (guards only). */
  now?: () => number;
  /** Sleep (guards only). */
  sleep?: (ms: number) => Promise<void>;
  /** Uniform [0,1) source (guards only). */
  random?: () => number;
}

/**
 * @description Renders the endpoint for a log line as host:port only — never the path, query or
 * key, because some vendors carry credentials in a base URL.
 * @param baseUrl - The endpoint base URL, if known.
 * @returns The host, or null when there is nothing safely renderable.
 */
export function endpointHost(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).host || null;
  } catch {
    return null;
  }
}

/**
 * @description Stamps the surfaced failure with how many attempts the endpoint refused: a
 * property for a thrown error, and a message suffix so the count survives the agentic loop's
 * `{ success:false, error: message }` shape. The error object's identity is preserved — callers
 * that compare by reference still see the original.
 * @param failure - The failure about to be surfaced.
 * @param attempts - The attempts made, including the first.
 * @returns void
 */
function annotateAttempts(failure: Error, attempts: number): void {
  if (attempts < 2) return;
  (failure as Error & { sameEndpointAttempts?: number }).sameEndpointAttempts = attempts;
  if (!ATTEMPTS_SUFFIX.test(failure.message)) {
    failure.message = `${failure.message} (${attempts} attempts on the same endpoint)`;
  }
}

/** One attempt's outcome, normalized so a thrown and a swallowed failure read the same way. */
interface SameEndpointAttempt<T> {
  /** The resolved value, when the attempt did not throw. */
  result?: T;
  /** The failure, thrown or lifted off the result; absent means the attempt succeeded. */
  failure?: Error;
  /** The exact value thrown, preserved by identity for the rethrow. */
  thrown?: unknown;
  didThrow: boolean;
}

/**
 * @description Runs one attempt and folds "threw" and "resolved with a failed result" into one
 * shape, so the loop reads a single outcome and the rethrow can preserve the original identity.
 * @param run - Executes one attempt; receives the 1-based attempt number.
 * @param attempt - The 1-based attempt number.
 * @param failureOf - Lifts a swallowed failure off a resolved result, when the caller has one.
 * @returns The attempt's normalized outcome.
 */
async function runOneAttempt<T>(
  run: (attempt: number) => Promise<T>,
  attempt: number,
  failureOf?: (result: T) => Error | undefined,
): Promise<SameEndpointAttempt<T>> {
  try {
    const result = await run(attempt);
    return { result, failure: failureOf ? failureOf(result) : undefined, didThrow: false };
  } catch (err) {
    return { thrown: err, failure: err instanceof Error ? err : new Error(String(err)), didThrow: true };
  }
}

/**
 * @description Surfaces a failed attempt with its ORIGINAL semantics: a run that threw rethrows the
 * same error object (annotated with the attempt count once it was retried), a run that resolved a
 * failed result returns that result. Every caller's existing handling sees what it saw before.
 * @param outcome - The attempt being surfaced.
 * @param attempts - How many attempts were made, including the first.
 * @returns The failed result, when the run did not throw.
 * @throws The original thrown value, when it did.
 */
function surfaceFailure<T>(outcome: SameEndpointAttempt<T>, attempts: number): T {
  if (!outcome.didThrow) return outcome.result as T;
  if (outcome.thrown instanceof Error) annotateAttempts(outcome.thrown, attempts);
  throw outcome.thrown;
}

/**
 * @description Which wall-clock bound, if either, refuses one more attempt — the per-MODEL-CALL
 * budget measured from this call's first attempt, or the TURN's replay ceiling the call nests
 * inside. Both are checked before scheduling, which is what they can honestly promise: neither can
 * cut short an attempt already in flight (that is the provider's request timeout and the route's
 * decision race), but together they guarantee the retry machinery never schedules one more try past
 * the budget, on this call or on any later model call of the same turn.
 * @param input - The effective plan, the optional turn budget, and this call's elapsed/replay/delay.
 * @returns The sentence naming the bound that refused, or null when a retry may be scheduled.
 */
function refuseNextAttempt(input: {
  plan: SameEndpointRetryPlan;
  turn?: SameEndpointRetryTurnBudget;
  elapsedMs: number;
  replaySpentMs: number;
  delayMs: number;
}): string | null {
  if (input.elapsedMs + input.delayMs > input.plan.budgetMs) {
    return `retry budget of ${input.plan.budgetMs}ms would be exceeded`;
  }
  const turn = input.turn;
  if (turn && input.replaySpentMs + input.delayMs > turn.remainingMs()) {
    const spent = Math.round(turn.spentMs + input.replaySpentMs);
    return `the turn's retry budget of ${turn.budgetMs}ms would be exceeded (${spent}ms already replayed this turn)`;
  }
  return null;
}

/**
 * @description Runs a call against ONE endpoint, replaying it on the same endpoint for a bounded
 * number of attempts when the failure is a retryable provider wall.
 *
 * Four independent bounds, each of which ends the loop: the attempt count, the per-failure
 * classification, the per-model-call wall-clock budget measured from this call's first attempt, and
 * — when the caller passes one — the TURN's replay ceiling shared by every model call of the turn.
 * See {@link refuseNextAttempt} for what the two clocks can and cannot promise.
 *
 * Failure semantics are preserved: a run that threw rethrows its ORIGINAL error object (annotated
 * with the attempt count when it was retried), and a run that resolved with a failed result
 * returns that result, so every caller's existing handling sees what it saw before.
 *
 * @param context - Endpoint/agent identification for the log lines (never the api key).
 * @param run - Executes one attempt; receives the 1-based attempt number.
 * @param hooks - `failureOf` for swallowed failures, the turn budget, plan overrides, guard seams.
 * @returns The first successful result, or the final attempt's failed result.
 * @throws The final attempt's original error, when the run threw.
 */
export async function runWithSameEndpointRetry<T>(
  context: SameEndpointRetryContext,
  run: (attempt: number) => Promise<T>,
  hooks: SameEndpointRetryHooks<T> = {},
): Promise<T> {
  const plan = { ...sameEndpointRetryPlan(), ...hooks.plan };
  const now = hooks.now ?? Date.now;
  const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const random = hooks.random ?? Math.random;
  const startedAt = now();
  // When the FIRST attempt ended. Everything after it — the sleeps and the replay attempts — is
  // what the retry machinery added to this turn, and the only thing the turn budget is charged.
  let replayFrom: number | null = null;
  const replaySpent = (): number => (replayFrom === null ? 0 : now() - replayFrom);
  const where = { agentId: context.agentId, endpoint: endpointHost(context.baseUrl), model: context.model };

  try {
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await runOneAttempt(run, attempt, hooks.failureOf);
      if (attempt === 1) replayFrom = now();
      if (!outcome.failure) {
        if (attempt > 1) {
          logger.info(
            { ...where, attempts: attempt, elapsedMs: now() - startedAt },
            'same-endpoint retry: the endpoint recovered — the call answered on a replay, not an error',
          );
        }
        return outcome.result as T;
      }

      const { retry, reason } = classifySameEndpointRetry(outcome.failure);
      const surface = (why: string): T => {
        logger.info(
          { ...where, attempts: attempt, maxAttempts: plan.maxAttempts, reason, elapsedMs: now() - startedAt },
          `same-endpoint retry: ${why} — surfacing the provider failure`,
        );
        return surfaceFailure(outcome, attempt);
      };
      if (!retry) return surface(`not retried (${reason})`);
      if (attempt >= plan.maxAttempts) return surface(`attempt bound of ${plan.maxAttempts} reached`);

      const delayMs = sameEndpointBackoffMs(attempt, plan, random);
      const elapsedMs = now() - startedAt;
      const refusal = refuseNextAttempt({ plan, turn: hooks.turnBudget, elapsedMs, replaySpentMs: replaySpent(), delayMs });
      if (refusal) return surface(refusal);

      logger.warn(
        { ...where, attempt, nextAttempt: attempt + 1, maxAttempts: plan.maxAttempts, reason, delayMs, elapsedMs },
        'same-endpoint retry: retryable provider wall — replaying on the SAME endpoint (never another provider)',
      );
      await sleep(delayMs);
    }
  } finally {
    // Charged on EVERY exit — success, surfaced failure or rethrow — so the next model call of this
    // turn sees what this one already spent.
    hooks.turnBudget?.spend(replaySpent());
  }
}

/**
 * @description An {@link LLMService} decorator that replays a retryable provider wall against the
 * SAME delegate — same URL, same key, same billing account — under the bounded plan. It wraps the
 * model call and nothing else: the orchestrator's message persistence, tool execution, cost
 * recording and error broadcast all sit outside it and run once per turn.
 *
 * ONE INSTANCE IS ONE TURN. `TaskOrchestrator.resolveProvider` builds the provider once per
 * `processMessage`, so this object's lifetime is exactly the turn — which is why the turn's replay
 * ceiling lives here and is shared by every `sendRequest` an agentic loop makes.
 */
export class SameEndpointRetryProvider extends LLMService {
  /** The TURN's replay ceiling, shared by every model call this decorator serves. */
  private readonly turnBudget: SameEndpointRetryTurnBudget;

  constructor(
    private readonly delegate: LLMService,
    private readonly context: SameEndpointRetryContext,
    private readonly hooks: SameEndpointRetryHooks<LLMResponse> = {},
  ) {
    super(delegate.getProviderName(), {});
    this.turnBudget = hooks.turnBudget
      ?? new SameEndpointRetryTurnBudget({ ...sameEndpointRetryPlan(), ...hooks.plan }.budgetMs);
  }

  async sendRequest(options: SendRequestOptions): Promise<LLMResponse> {
    return runWithSameEndpointRetry(
      this.context,
      () => this.delegate.sendRequest(options),
      { ...this.hooks, turnBudget: this.turnBudget },
    );
  }

  override calculateCost(usage: TokenUsage): CostResult {
    return this.delegate.calculateCost(usage);
  }

  override getProviderName(): string {
    return this.delegate.getProviderName();
  }
}

/**
 * @description Wraps a provider so its model calls replay a retryable wall on the same endpoint.
 * @param delegate - The provider to decorate (the hosted BYO provider).
 * @param context - Endpoint/agent identification for the log lines (never the api key).
 * @param hooks - Guard-only seams and plan overrides.
 * @returns The decorated provider.
 */
export function withSameEndpointRetry(
  delegate: LLMService,
  context: SameEndpointRetryContext,
  hooks: SameEndpointRetryHooks<LLMResponse> = {},
): LLMService {
  return new SameEndpointRetryProvider(delegate, context, hooks);
}
