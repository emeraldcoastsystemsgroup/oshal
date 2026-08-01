/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Global classify-call budget — the guard the 2026-06-29 Codex burn proved missing: ingestFeeds→analyzeBatch had per-chunk sizing and per-source circuit breakers but NO ceiling on total LLM calls, so a catch-up storm (everything "fresh" after downtime) spawned the classify CLI 27×/min for 9 hours. This pure token bucket caps calls per fixed hour and per fixed day; exhausted → callers fall back to the free lexicon for the remainder of the window. Pure + clock-injectable so the spec can walk windows deterministically.
 */

/** Point-in-time view of the budget — what the pulse log records and the first-denial warn carries. */
export interface ClassifyBudgetSnapshot {
  /** LLM calls granted in the current hour window. */
  hourUsed: number;
  /** Max calls per hour window. */
  hourCap: number;
  /** LLM calls granted in the current day window. */
  dayUsed: number;
  /** Max calls per day window. */
  dayCap: number;
  /** Requests denied in the current hour window (0 = budget never bit this hour). */
  denied: number;
}

/** The budget contract analyzeBatch consumes: one tryTake per LLM call, fail-closed. */
export interface ClassifyBudget {
  /**
   * @description Consume one LLM call if BOTH the hour and day windows have room.
   * Synchronous (the JS event loop makes it atomic across concurrent chunk workers).
   * @returns true when the call may spend; false when the caller must fall back to lexicon.
   */
  tryTake(): boolean;
  /** @description Current counters (rolls windows first, so a stale snapshot is impossible). */
  snapshot(): ClassifyBudgetSnapshot;
}

/** A cap: non-finite or negative input fails CLOSED to zero (no LLM), never open. */
const cap = (n: number): number => (Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);

/**
 * @description Create a classify budget with fixed (wall-clock aligned) hour + day windows.
 * Fixed windows over sliding ones on purpose: counters reset at the top of the hour/UTC day,
 * which makes the behavior predictable ("60 per clock hour") and the arithmetic trivially
 * testable. Process-lifetime state only — a restart forfeits nothing but the current counts,
 * and the per-hour cap re-bounds any restart storm within one window.
 * @param opts - perHour / perDay caps (values < 0 or non-numeric clamp to 0 = no LLM), and an
 *               injectable `now` (ms epoch) for tests.
 * @returns The budget instance.
 */
export function createClassifyBudget(opts: { perHour: number; perDay: number; now?: () => number }): ClassifyBudget {
  const perHour = cap(opts.perHour);
  const perDay = cap(opts.perDay);
  const now = opts.now ?? Date.now;

  let hourWindow = -1;
  let dayWindow = -1;
  let hourUsed = 0;
  let dayUsed = 0;
  let denied = 0;

  /** Roll counters when the wall-clock window has moved on. */
  const roll = (): void => {
    const t = now();
    const h = Math.floor(t / 3_600_000);
    const d = Math.floor(t / 86_400_000);
    if (h !== hourWindow) { hourWindow = h; hourUsed = 0; denied = 0; }
    if (d !== dayWindow) { dayWindow = d; dayUsed = 0; }
  };

  return {
    tryTake(): boolean {
      roll();
      if (hourUsed >= perHour || dayUsed >= perDay) { denied += 1; return false; }
      hourUsed += 1;
      dayUsed += 1;
      return true;
    },
    snapshot(): ClassifyBudgetSnapshot {
      roll();
      return { hourUsed, hourCap: perHour, dayUsed, dayCap: perDay, denied };
    },
  };
}
