/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P3 (ADR-119 Stage E, FR-E2): the analyst cost guard — sliding-hour RCA spend vs ALERT_RCA_HOURLY_BUDGET_USD, evaluated BEFORE an auto-flow dispatch. Actuals come through the RcaSpendReader seam (the app layer wires the per-event cost ledger recordCost feeds — the same source cost-governance reads; the controller/LLM boundary holds: this gate reads numbers, it never calls a model). Reserve-before-act (source P3/P6): an allowed dispatch reserves the recent p95 per-RCA cost so a concurrent burst cannot race N dispatches under one budget read; reservations expire after ALERT_RCA_RESERVATION_TTL (true-up: by then the run's actuals are in the ledger) and release on create failure so a retry can proceed. FAIL-OPEN on unreadable spend (an infra gap must never brick the self-healing intake) — the fail-closed direction here would blind the swarm to its own outages
 */

import { createChildLogger } from '@/shared/logger';
import {
  ALERT_RCA_COST_SAMPLE_LIMIT,
  ALERT_RCA_RESERVATION_TTL_SECONDS,
  ALERT_RCA_RESERVE_FALLBACK_USD,
  rcaHourlyBudgetUsd,
} from './alert-triage-constants';

const logger = createChildLogger({ module: 'alert-rca-budget-gate' });

/**
 * @description The FR-E2 actuals seam, expressed structurally so this feature slice never
 * imports the cost-governance slice or a DB driver (FSD: the app layer wires an
 * implementation over the per-event cost ledger; tests inject fakes). Both reads return
 * null on any infra gap so the gate can fail open explicitly.
 */
export interface RcaSpendReader {
  /**
   * @description USD actually spent on this ticket type's analysis inside the trailing
   * hour (per-event ledger rows joined to tickets via ticket_task_links).
   * @param ticketType - The alert queue's ticket type.
   * @returns Spend in USD, or null when unreadable.
   */
  hourlyRcaSpendUsd(ticketType: string): Promise<number | null>;
  /**
   * @description Recent per-ticket total analysis costs (newest tickets first) — the p95
   * reservation sample.
   * @param ticketType - The alert queue's ticket type.
   * @param limit - Maximum tickets to sample.
   * @returns Per-ticket USD totals, or null when unreadable.
   */
  recentRcaTicketCostsUsd(ticketType: string, limit: number): Promise<number[] | null>;
}

/** @description The gate's pre-dispatch decision (FR-E2). */
export interface RcaBudgetVerdict {
  /** True when the auto-flow ticket must park in backlog with the visible budget flag. */
  park: boolean;
  /** The configured sliding-hour budget. */
  budgetUsd: number;
  /** Ledger actuals for the trailing hour (null = unreadable → failed open). */
  spendUsd: number | null;
  /** Live (unexpired) reservations counted against the budget. */
  reservedUsd: number;
  /** The p95-based estimate an allowed dispatch should reserve. */
  estimateUsd: number;
}

/** @description Handle for releasing a reservation when the guarded action failed. */
export interface RcaReservation {
  /** Releases the reservation (create failed / creation race lost — no dispatch happened). */
  release(): void;
}

/** @description The `flags[]` / label value FR-E2 surfaces on a parked ticket (spec §5). */
export const BUDGET_PARK_FLAG = 'analysis-skipped:budget';

/**
 * @description FR-E2 gate instance — one per intake route. Reservations are in-process
 * state (optimization + burst protection inside one api process); the durable meter is the
 * cost ledger itself, which every evaluation re-reads. With no reader wired the gate is an
 * explicit pass-through (a deployment without a DB pool keeps its alert intake).
 */
export class RcaBudgetGate {
  private reservations: Array<{ atMs: number; usd: number; released: boolean }> = [];

  /**
   * @param reader - Actuals source; null runs the gate as a logged pass-through.
   */
  constructor(private readonly reader: RcaSpendReader | null = null) {}

  /**
   * @description Decides whether the next auto-flow dispatch fits the sliding-hour budget:
   * park when `actuals + live reservations >= budget`. Fail-OPEN (park=false, WARN) when
   * actuals are unreadable — a DB hiccup must never park the swarm's own outage tickets.
   * An operator promote is never gated here: the gate runs only on the intake's automatic
   * dispatch decision.
   * @param ticketType - The alert queue's ticket type.
   * @param nowMs - Evaluation time (injected for deterministic guards).
   * @returns The verdict, including the estimate to reserve when allowed.
   */
  async evaluate(ticketType: string, nowMs = Date.now()): Promise<RcaBudgetVerdict> {
    const budgetUsd = rcaHourlyBudgetUsd();
    if (!this.reader) {
      return { park: false, budgetUsd, spendUsd: null, reservedUsd: 0, estimateUsd: ALERT_RCA_RESERVE_FALLBACK_USD };
    }
    const spendUsd = await this.reader.hourlyRcaSpendUsd(ticketType);
    const estimateUsd = await this.resolveEstimate(ticketType);
    if (spendUsd === null || !Number.isFinite(spendUsd)) {
      logger.warn({ ticketType, budgetUsd }, 'RCA hourly spend unreadable — budget gate failing OPEN (dispatch proceeds)');
      return { park: false, budgetUsd, spendUsd: null, reservedUsd: 0, estimateUsd };
    }
    this.pruneReservations(nowMs);
    const reservedUsd = this.reservations.reduce((sum, r) => sum + r.usd, 0);
    const park = spendUsd + reservedUsd >= budgetUsd;
    if (park) {
      logger.warn(
        { ticketType, spendUsd, reservedUsd, budgetUsd },
        'RCA hourly budget exhausted — parking auto-flow dispatch in backlog (FR-E2, visible via analysis-skipped:budget)',
      );
    }
    return { park, budgetUsd, spendUsd, reservedUsd, estimateUsd };
  }

  /**
   * @description Reserves an allowed dispatch's estimated cost against the budget
   * (reserve-before-act, source P3). The reservation expires after
   * ALERT_RCA_RESERVATION_TTL — by then the run's actuals are in the ledger and keeping it
   * would double-count — or is released explicitly when the guarded create failed.
   * @param estimateUsd - The verdict's estimate.
   * @param nowMs - Reservation time (injected for deterministic guards).
   * @returns A release handle.
   */
  reserve(estimateUsd: number, nowMs = Date.now()): RcaReservation {
    const entry = { atMs: nowMs, usd: Math.max(0, estimateUsd), released: false };
    this.reservations.push(entry);
    return {
      release: () => {
        entry.released = true;
        this.reservations = this.reservations.filter((r) => r !== entry);
      },
    };
  }

  /**
   * @description Drops expired reservations (true-up by TTL — see class docs).
   * @param nowMs - Current time.
   */
  private pruneReservations(nowMs: number): void {
    const cutoff = nowMs - ALERT_RCA_RESERVATION_TTL_SECONDS * 1000;
    this.reservations = this.reservations.filter((r) => !r.released && r.atMs >= cutoff);
  }

  /**
   * @description The reservation estimate: p95 of recent per-RCA ticket costs, falling back
   * to a modest constant while the ledger has no history (a fresh deployment learns real
   * costs instead of parking on a guess).
   * @param ticketType - The alert queue's ticket type.
   * @returns Estimate in USD.
   */
  private async resolveEstimate(ticketType: string): Promise<number> {
    const samples = await this.reader?.recentRcaTicketCostsUsd(ticketType, ALERT_RCA_COST_SAMPLE_LIMIT);
    const usable = (samples ?? []).filter((c) => Number.isFinite(c) && c > 0).sort((a, b) => a - b);
    if (usable.length === 0) return ALERT_RCA_RESERVE_FALLBACK_USD;
    const index = Math.min(usable.length - 1, Math.max(0, Math.ceil(usable.length * 0.95) - 1));
    return usable[index];
  }
}
