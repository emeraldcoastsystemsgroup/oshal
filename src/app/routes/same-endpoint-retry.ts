/**
 * Bounded SAME-ENDPOINT retry for a turn running on an explicitly chosen BYO endpoint.
 *
 * WHY THIS IS A SEPARATE DECISION FROM ROTATION. `reportResolvedLlmFailure` answers exactly one
 * question — *may this turn be replayed on a DIFFERENT provider?* — and for an explicit BYO
 * connection the answer is permanently no: the user picked that endpoint as a privacy/billing
 * boundary and silently spending their prompt somewhere else crosses it. That refusal is correct
 * and stays. What it was ALSO doing, by conflation, was denying the turn a retry of any kind, so a
 * provider-side spend cap that trips intermittently (operator, 2026-09-22: a Pro account whose cap
 * "sometimes triggers, sometimes doesn't") cost the whole turn and surfaced an error. Replaying the
 * same prompt against the same endpoint with the same key crosses no boundary at all — it is the
 * remedy the provider itself prescribes when it answers 429.
 *
 * WHAT IS NOT RETRIED HERE, and why (the exclusions are subtractions from the shared
 * RETRYABLE_PROVIDER_FAILURE vocabulary — there is deliberately no second pattern for "retryable"):
 *   - `403` / forbidden / permission-denied — an authorization verdict about this key against this
 *     endpoint. It reproduces deterministically; a backoff changes nothing, so a same-endpoint
 *     replay only spends the waiting user's seconds on a certain failure. It stays in the ROTATION
 *     set because a different lane carries a different key.
 *   - `empty_final_answer` / "returned no final answer" — measured origin is
 *     `any-bot/server/services/llm/OpenAIProvider.js` and `TaskController.js`: the endpoint answered
 *     HTTP 200 with no usable content. That call COMPLETED and was billed. It is not a wall, the
 *     same prompt on the same model tends to produce the same emptiness, and it is the one member of
 *     the vocabulary where the failed attempt already consumed tokens. Rotation-only.
 *
 * WHAT A RETRIED TURN RE-DOES (measured, not assumed). `TaskOrchestrator.processMessage` writes its
 * cost/usage rows in `handleResult`, which runs only on the success path; a provider failure goes to
 * `handleError`, which returns `{ success:false, … }` with no `usageSummary` and never reaches
 * `handleResult`. So a failed attempt writes NO `chat_tasks`/cost row and a replay cannot duplicate
 * the ledger. Two real costs remain, both pre-existing for the rotation replay this sits beside:
 * `saveUserMessage` has already run, so each replay re-appends the user's message to the thread
 * (cosmetic duplicate), and an agentic wall that lands after tool calls re-runs those tools. Both
 * are why the attempt budget is small and the reason is logged on every retry.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — classifier (a subtraction from the shared retryable vocabulary), the attempt/backoff/ceiling plan, and the bounded executor both chat entry points wrap their turn in.
 *
 * @module same-endpoint-retry
 */

import { createChildLogger } from '@/shared/logger';
import { RETRYABLE_PROVIDER_FAILURE } from './free-tier-rotation';

const logger = createChildLogger({ module: 'same-endpoint-retry' });

/**
 * The classified shape of a turn failure, as it appears in the log line. `rate-limit` and `quota`
 * are the two that earn a same-endpoint replay; the rest name why one was refused, so the next
 * occurrence is evidence instead of a guess.
 */
export type SameEndpointRetryReason =
  | 'rate-limit'
  | 'quota'
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
  return { retry: true, reason: QUOTA_FAILURE.test(text) ? 'quota' : 'rate-limit' };
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
 * does not cover: attempts that are themselves slow. All four are env-overridable because the
 * numbers are a deployment's latency tolerance, not a fact about the code.
 */
export const DEFAULT_SAME_ENDPOINT_RETRY_PLAN: Readonly<SameEndpointRetryPlan> = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 4_000,
  budgetMs: 15_000,
});

/**
 * @description Reads the retry bound from the environment, falling back to
 * {@link DEFAULT_SAME_ENDPOINT_RETRY_PLAN}. A non-numeric or negative override is ignored rather
 * than obeyed: a typo in an env var must not silently switch the retry off or unbound it.
 * @param env - The environment to read (injectable for guards).
 * @returns The effective plan.
 */
export function sameEndpointRetryPlan(env: NodeJS.ProcessEnv = process.env): SameEndpointRetryPlan {
  const read = (name: string, fallback: number, min: number): number => {
    const parsed = Number(env[name]);
    return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
  };
  return {
    maxAttempts: read('OSHAL_BYO_RETRY_MAX_ATTEMPTS', DEFAULT_SAME_ENDPOINT_RETRY_PLAN.maxAttempts, 1),
    baseDelayMs: read('OSHAL_BYO_RETRY_BASE_DELAY_MS', DEFAULT_SAME_ENDPOINT_RETRY_PLAN.baseDelayMs, 0),
    maxDelayMs: read('OSHAL_BYO_RETRY_MAX_DELAY_MS', DEFAULT_SAME_ENDPOINT_RETRY_PLAN.maxDelayMs, 0),
    budgetMs: read('OSHAL_BYO_RETRY_BUDGET_MS', DEFAULT_SAME_ENDPOINT_RETRY_PLAN.budgetMs, 0),
  };
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

/** Injectable seams. Production passes at most `failureOf`; the clock/sleep/random are guard-only. */
export interface SameEndpointRetryHooks<T> {
  /**
   * Lifts a SWALLOWED failure off a resolved result. The agentic loop catches provider errors
   * internally and resolves `{ success:false, error }` instead of throwing, so without this the
   * retry would only ever see the minority of failures that actually propagate.
   */
  failureOf?: (result: T) => Error | undefined;
  /** Overrides on top of {@link sameEndpointRetryPlan}. */
  plan?: Partial<SameEndpointRetryPlan>;
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
function endpointHost(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).host || null;
  } catch {
    return null;
  }
}

/**
 * @description Runs a turn against ONE endpoint, replaying it on the same endpoint for a bounded
 * number of attempts when the failure is a retryable provider wall.
 *
 * Three independent bounds, each of which ends the loop: the attempt count, the per-failure
 * classification, and a wall-clock budget measured from the first attempt's start. The budget is
 * checked BEFORE scheduling each retry (`elapsed + delay > budget` stops), which is what it can
 * honestly promise: this wrapper cannot cut short an attempt already in flight — that is the job of
 * the route's own timeout (`DECISION_TIMEOUT_MS` races the Jarvis turn) — but it guarantees the
 * retry machinery never pushes a turn past the budget by scheduling one more try.
 *
 * Failure semantics are preserved exactly: a run that threw rethrows its ORIGINAL error, and a run
 * that resolved with a failed result returns that result, so every caller's existing handling —
 * including the rotation leg that follows for non-explicit lanes — sees what it saw before.
 *
 * @param context - Endpoint/agent identification for the log lines (never the api key).
 * @param run - Executes one attempt; receives the 1-based attempt number.
 * @param hooks - `failureOf` for swallowed failures, plan overrides, and guard-only seams.
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
  const endpoint = endpointHost(context.baseUrl);
  const where = { agentId: context.agentId, endpoint, model: context.model };

  for (let attempt = 1; ; attempt += 1) {
    let result: T | undefined;
    let failure: Error | undefined;
    let thrown: unknown;
    let didThrow = false;
    try {
      result = await run(attempt);
      failure = hooks.failureOf ? hooks.failureOf(result) : undefined;
    } catch (err) {
      didThrow = true;
      thrown = err;
      failure = err instanceof Error ? err : new Error(String(err));
    }

    if (!failure) {
      if (attempt > 1) {
        logger.info(
          { ...where, attempts: attempt, elapsedMs: now() - startedAt },
          'same-endpoint retry: the endpoint recovered — the turn answered on a replay, not an error',
        );
      }
      return result as T;
    }

    const { retry, reason } = classifySameEndpointRetry(failure);
    const surface = (why: string): T => {
      logger.info(
        { ...where, attempts: attempt, maxAttempts: plan.maxAttempts, reason, elapsedMs: now() - startedAt },
        `same-endpoint retry: ${why} — surfacing the provider failure`,
      );
      if (didThrow) throw thrown;
      return result as T;
    };

    if (!retry) return surface(`not retried (${reason})`);
    if (attempt >= plan.maxAttempts) return surface(`attempt bound of ${plan.maxAttempts} reached`);

    const delayMs = sameEndpointBackoffMs(attempt, plan, random);
    const elapsedMs = now() - startedAt;
    if (elapsedMs + delayMs > plan.budgetMs) {
      return surface(`retry budget of ${plan.budgetMs}ms would be exceeded`);
    }

    logger.warn(
      { ...where, attempt, nextAttempt: attempt + 1, maxAttempts: plan.maxAttempts, reason, delayMs, elapsedMs },
      'same-endpoint retry: retryable provider wall — replaying on the SAME endpoint (never another provider)',
    );
    await sleep(delayMs);
  }
}
