/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase spend gate (ADR-046 hardening, BACKLOG "per-run judge budget cap"): TOKEN_CHASE_JUDGE_BAR is a QUALITY bar — this is the missing SPEND ceiling. A per-run gate consulted before each optimizer round: (1) a finite env cap TOKEN_CHASE_BUDGET_USD (default 25) against the run's accumulated measured replay spend, and (2) an injected cost-governance check (the app layer binds BudgetService.checkBudget — FSD forbids a same-layer feature import, same structural-injection pattern as the assessor's QualityGrader) so operator DB hard caps, which see the LEDGER including judge-call spend, also stop the chase. Exceeded = stop cleanly (log + status), never a throw-loop; a failing governance probe fails OPEN, mirroring BudgetService semantics. Capture/determinism semantics untouched — this is only a ceiling.
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'token-chase-budget-gate' });

/**
 * @description The finite default per-run spend ceiling in USD when TOKEN_CHASE_BUDGET_USD is
 * unset or invalid. Generous (a savings loop over a large captured run on paid lanes stays well
 * under it) but FINITE — an optimizer run can never chase unbounded spend by default.
 */
export const DEFAULT_TOKEN_CHASE_BUDGET_USD = 25;

/**
 * @description Resolves the per-run Token Chase spend cap from the environment.
 * TOKEN_CHASE_BUDGET_USD must be a finite number > 0; anything else (unset, empty, NaN, zero,
 * negative) falls back to {@link DEFAULT_TOKEN_CHASE_BUDGET_USD} — there is deliberately no
 * "0 = unlimited" arm, because the whole point of the knob is that the ceiling always exists.
 * @param env - Environment bag (injectable for tests); defaults to process.env.
 * @returns The cap in USD, always finite and positive.
 */
export function readTokenChaseBudgetUsd(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseFloat(String(env.TOKEN_CHASE_BUDGET_USD ?? ''));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TOKEN_CHASE_BUDGET_USD;
}

/**
 * @description The verdict an injected governance check returns. Structurally compatible with
 * the cost-governance BudgetService's BudgetDecision ON PURPOSE: FSD forbids token-chase (a
 * feature slice) from importing the cost-governance slice directly, so the app layer binds
 * `(sub) => new BudgetService(pool).checkBudget(sub)` and passes it in — the shapes must line
 * up without a nominal import (same pattern as the assessor's QualityGrader).
 */
export interface GovernanceDecision {
  /** False ONLY when a hard cap / kill switch definitively tripped. */
  allowed: boolean;
  /** Machine-readable decision code (e.g. 'hard-cap-exceeded', 'runaway-halt'). */
  reason: string;
  /** The spend behind the tripping budget, when known. */
  spend?: number;
  /** The cap behind the tripping budget, when known. */
  cap?: number;
}

/** @description The injected governance probe — bound to BudgetService.checkBudget at the app layer. */
export type GovernanceCheck = (userSub: string | null) => Promise<GovernanceDecision>;

/**
 * @description The gate's answer, also served as the run's budget status in responses so a
 * caller can see WHY a chase stopped (the "stop cleanly with status" contract).
 */
export interface TokenChaseBudgetStatus {
  /** The resolved per-run cap in USD (always finite). */
  capUsd: number;
  /** Measured replay spend accumulated by this run so far, USD. */
  spentUsd: number;
  /** True when the next round must not run. */
  exhausted: boolean;
  /** Why: within-cap | run-cap-exceeded | governance-blocked. */
  reason: 'within-cap' | 'run-cap-exceeded' | 'governance-blocked';
  /** The governance decision code when reason is 'governance-blocked'. */
  governanceReason?: string;
}

/** @description Constructor options for {@link TokenChaseBudgetGate}. */
export interface TokenChaseBudgetGateOptions {
  /** The accountable caller — threaded into the governance probe. */
  userSub?: string | null;
  /** Explicit cap override (tests); defaults to readTokenChaseBudgetUsd(env). */
  capUsd?: number;
  /** Optional cost-governance probe (BudgetService.checkBudget, bound at the app layer). */
  governance?: GovernanceCheck;
  /** Environment bag for the cap knob (tests); defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * @description Per-run spend ceiling for the Token Chase optimizer. One instance per optimizer
 * run (or per single-variant request). `check()` is consulted BEFORE each round; `record()`
 * accumulates each round's measured variant cost afterwards. The gate never throws a budget
 * outcome — a tripped ceiling is a status the loop uses to stop cleanly, and a broken
 * governance probe fails OPEN (an infra gap must not brick the optimizer, mirroring the
 * cost-governance BudgetService's own semantics). It alters no capture/determinism behavior:
 * frames already replayed and graded are untouched; the gate only decides whether the NEXT
 * round may spend.
 */
export class TokenChaseBudgetGate {
  private readonly capUsd: number;
  private readonly userSub: string | null;
  private readonly governance?: GovernanceCheck;
  private spentUsd = 0;
  private lastReason: TokenChaseBudgetStatus['reason'] = 'within-cap';
  private governanceReason?: string;
  private warned = false;

  /**
   * @description Builds a gate for one optimizer run.
   * @param options - Caller identity, optional cap/env overrides, optional governance probe.
   */
  constructor(options: TokenChaseBudgetGateOptions = {}) {
    const cap = options.capUsd;
    this.capUsd = typeof cap === 'number' && Number.isFinite(cap) && cap > 0
      ? cap
      : readTokenChaseBudgetUsd(options.env);
    this.userSub = options.userSub ?? null;
    this.governance = options.governance;
  }

  /**
   * @description Accumulates one round's measured spend (the variant lane's actual replay cost).
   * Non-finite / non-positive values are ignored — a $0 free-lane replay must not poison the sum.
   * @param costUsd - The round's measured cost in USD.
   * @returns void
   */
  record(costUsd: number): void {
    if (Number.isFinite(costUsd) && costUsd > 0) this.spentUsd += costUsd;
  }

  /**
   * @description THE pre-round gate. Order: (1) the deterministic per-run env cap against the
   * accumulated measured spend; (2) the injected cost-governance probe (operator DB caps + the
   * runaway kill switch — its ledger view includes judge-call spend recorded via chat_tasks).
   * A failing probe fails OPEN with a WARN. Never throws.
   * @returns The status; `exhausted: true` means the caller must stop the chase cleanly.
   */
  async check(): Promise<TokenChaseBudgetStatus> {
    if (this.spentUsd >= this.capUsd) {
      this.lastReason = 'run-cap-exceeded';
      if (!this.warned) {
        this.warned = true;
        logger.warn(
          { spentUsd: this.spentUsd, capUsd: this.capUsd, userSub: this.userSub },
          'Token Chase per-run spend cap (TOKEN_CHASE_BUDGET_USD) exceeded — stopping the chase',
        );
      }
      return this.status();
    }
    if (this.governance) {
      try {
        const verdict = await this.governance(this.userSub);
        if (!verdict.allowed) {
          this.lastReason = 'governance-blocked';
          this.governanceReason = verdict.reason;
          if (!this.warned) {
            this.warned = true;
            logger.warn(
              { reason: verdict.reason, spend: verdict.spend, cap: verdict.cap, userSub: this.userSub },
              'Cost-governance budget blocked the Token Chase round — stopping the chase',
            );
          }
          return this.status();
        }
      } catch (err) {
        logger.error(
          { err, stack: (err as Error)?.stack, userSub: this.userSub },
          'Token Chase governance probe failed — failing OPEN (env cap still enforced)',
        );
      }
    }
    this.lastReason = 'within-cap';
    return this.status();
  }

  /**
   * @description The current budget status without re-probing governance — served in optimizer
   * responses so callers can see the run's spend, cap, and why it stopped (if it did).
   * @returns The status snapshot.
   */
  status(): TokenChaseBudgetStatus {
    return {
      capUsd: this.capUsd,
      spentUsd: this.spentUsd,
      exhausted: this.lastReason !== 'within-cap',
      reason: this.lastReason,
      ...(this.governanceReason ? { governanceReason: this.governanceReason } : {}),
    };
  }
}
