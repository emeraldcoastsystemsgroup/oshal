/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Per-run JUDGE spend cap (BACKLOG "per-run judge budget cap", ADR-046 step 4): TOKEN_CHASE_BUDGET_USD gates REPLAY spend — this is the missing ceiling on the grading loop's LLM-judge calls. TOKEN_CHASE_JUDGE_BUDGET_USD (finite default 5, no unlimited arm) is checked BEFORE every judge call against measured judge-agent spend (an injected probe the app layer binds to a chat_tasks SUM for QUALITY_JUDGE_AGENT_ID since the run began — real ledger dollars, not estimates). On breach the loop stops grading further frames and the run is marked partially graded HONESTLY (skipped counts in the status, WARN log) — never silently. Fail-closed on the cap (>= cap blocks, including exactly-at); a failing spend probe fails OPEN with an ERROR log (infra must not brick the optimizer), mirroring TokenChaseBudgetGate's governance semantics.
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'token-chase-judge-budget' });

/**
 * @description The finite default per-run JUDGE spend ceiling in USD when
 * TOKEN_CHASE_JUDGE_BUDGET_USD is unset or invalid. Judge calls are small (bounded previews +
 * rubric), so $5 covers grading a large run with retries — but it is FINITE: a grading loop can
 * never chase unbounded judge spend by default.
 */
export const DEFAULT_TOKEN_CHASE_JUDGE_BUDGET_USD = 5;

/**
 * @description Resolves the per-run judge spend cap from the environment.
 * TOKEN_CHASE_JUDGE_BUDGET_USD must be a finite number > 0; anything else (unset, empty, NaN,
 * zero, negative) falls back to {@link DEFAULT_TOKEN_CHASE_JUDGE_BUDGET_USD} — deliberately no
 * "0 = unlimited" arm: the whole point of the knob is that the ceiling always exists.
 * @param env - Environment bag (injectable for tests); defaults to process.env.
 * @returns The cap in USD, always finite and positive.
 */
export function readTokenChaseJudgeBudgetUsd(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseFloat(String(env.TOKEN_CHASE_JUDGE_BUDGET_USD ?? ''));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TOKEN_CHASE_JUDGE_BUDGET_USD;
}

/**
 * @description The injected measured-spend probe: returns the judge agent's accumulated REAL
 * spend (USD) attributable to this run's grading so far. The app layer binds a chat_tasks SUM
 * scoped to the quality-judge agent id since the gate was constructed; tests inject a fake.
 * A throwing probe fails OPEN (logged at ERROR) — an infra gap must not brick the optimizer.
 */
export type JudgeSpendProbe = () => Promise<number>;

/** @description The gate's verdict for one prospective judge call. */
export interface JudgeBudgetCheck {
  /** True when the next judge call may run. */
  allowed: boolean;
  /** The resolved cap in USD (always finite). */
  capUsd: number;
  /** Measured judge spend so far, USD (last successful probe reading). */
  spentUsd: number;
}

/**
 * @description The run-level judge budget status served in optimizer responses — the honest
 * record of how much of the run got a real judge grade and why grading stopped (if it did).
 */
export interface JudgeBudgetStatus {
  capUsd: number;
  spentUsd: number;
  /** True once the cap tripped — no further judge calls ran after that point. */
  exhausted: boolean;
  /** Frames that received a judge grade in this run. */
  gradedFrames: number;
  /** Frames recorded UNGRADED because the cap had tripped (the partial-grade remainder). */
  skippedFrames: number;
  /** True when at least one frame was skipped — the run is only partially judge-graded. */
  partiallyGraded: boolean;
}

/** @description Constructor options for {@link TokenChaseJudgeBudget}. */
export interface TokenChaseJudgeBudgetOptions {
  /** Explicit cap override (tests); defaults to readTokenChaseJudgeBudgetUsd(env). */
  capUsd?: number;
  /** Environment bag for the cap knob (tests); defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** The measured-spend probe (see {@link JudgeSpendProbe}); omit for a spend-blind gate that only counts explicit record() calls. */
  spendProbe?: JudgeSpendProbe;
}

/**
 * @description Per-run hard ceiling on the Token Chase grading loop's judge spend. One instance
 * per optimizer run. `beforeJudgeCall()` is consulted BEFORE each judge call: it refreshes the
 * measured spend via the injected probe and blocks (fail-closed) once spend >= cap. The caller
 * then records the frame ungraded via `noteSkipped()` — grading stops, persistence does not, and
 * `status()` reports the partial grading honestly. Never throws: a broken probe fails OPEN with
 * an ERROR log while the last known reading still enforces the cap.
 */
export class TokenChaseJudgeBudget {
  private readonly capUsd: number;
  private readonly spendProbe?: JudgeSpendProbe;
  private spentUsd = 0;
  private tripped = false;
  private graded = 0;
  private skipped = 0;
  private warned = false;

  /**
   * @description Builds a judge budget for one grading run.
   * @param options - Cap/env overrides + the measured-spend probe.
   */
  constructor(options: TokenChaseJudgeBudgetOptions = {}) {
    const cap = options.capUsd;
    this.capUsd = typeof cap === 'number' && Number.isFinite(cap) && cap > 0
      ? cap
      : readTokenChaseJudgeBudgetUsd(options.env);
    this.spendProbe = options.spendProbe;
  }

  /**
   * @description Adds directly-measured judge spend (when a caller knows a call's cost without
   * the probe). Non-finite / non-positive values are ignored.
   * @param costUsd - The judge call's measured cost in USD.
   * @returns void
   */
  record(costUsd: number): void {
    if (Number.isFinite(costUsd) && costUsd > 0) this.spentUsd += costUsd;
  }

  /**
   * @description THE pre-call gate — consult before EVERY judge call. Refreshes measured spend
   * from the probe (a probe failure fails OPEN at ERROR; the last reading still applies), then
   * enforces the cap fail-closed: spend >= cap blocks, including exactly-at-cap. Once tripped it
   * stays tripped for the run — a later cheaper probe reading never un-trips it (the "stops
   * grading further frames" contract is monotonic).
   * @returns Whether the next judge call may run, with the cap and spend behind the answer.
   */
  async beforeJudgeCall(): Promise<JudgeBudgetCheck> {
    if (this.spendProbe) {
      try {
        const probed = await this.spendProbe();
        if (Number.isFinite(probed) && probed > this.spentUsd) this.spentUsd = probed;
      } catch (err) {
        logger.error(
          { err, stack: (err as Error)?.stack, spentUsd: this.spentUsd, capUsd: this.capUsd },
          'Token Chase judge spend probe failed — failing OPEN on this reading (cap still enforced on known spend)',
        );
      }
    }
    if (this.tripped || this.spentUsd >= this.capUsd) {
      this.tripped = true;
      if (!this.warned) {
        this.warned = true;
        logger.warn(
          { spentUsd: this.spentUsd, capUsd: this.capUsd },
          'Token Chase per-run judge budget (TOKEN_CHASE_JUDGE_BUDGET_USD) exhausted — remaining frames will be recorded UNGRADED',
        );
      }
      return { allowed: false, capUsd: this.capUsd, spentUsd: this.spentUsd };
    }
    return { allowed: true, capUsd: this.capUsd, spentUsd: this.spentUsd };
  }

  /**
   * @description Counts one frame that received a judge grade.
   * @returns void
   */
  noteGraded(): void {
    this.graded += 1;
  }

  /**
   * @description Counts one frame recorded UNGRADED because the budget had tripped — the honest
   * partial-grade marker the run status reports.
   * @returns void
   */
  noteSkipped(): void {
    this.skipped += 1;
  }

  /**
   * @description The run's judge-budget status for the response payload — cap, measured spend,
   * whether the ceiling tripped, and the graded/skipped split that makes a partially-graded run
   * visible instead of silent.
   * @returns The status snapshot.
   */
  status(): JudgeBudgetStatus {
    return {
      capUsd: this.capUsd,
      spentUsd: this.spentUsd,
      exhausted: this.tripped,
      gradedFrames: this.graded,
      skippedFrames: this.skipped,
      partiallyGraded: this.skipped > 0,
    };
  }
}
