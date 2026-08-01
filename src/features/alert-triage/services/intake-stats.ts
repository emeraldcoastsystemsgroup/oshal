/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P1 (ADR-119) FR-A3: every intake decision is counted — created/consolidated/noise/dropped/resolved, with a per-alertname noise breakdown so the claim allowlist can be tuned from evidence. Replaces the previous uncounted vanish of unapproved alerts (spec §1 problem 3: "noise handling is a binary allowlist … there is no record of what was dropped")
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P2 (ADR-119 Stage D): `bundled` joins the decision set — the counter slot P1 reserved, now that the bundling stage actually increments it (spec §9.9 — no counter ships before something moves it)
 */

/**
 * @description One intake decision class (FR-A3). `bundled` = an arrival recorded as a NEW
 * member of an open related incident (Stage D attach); a refire of an already-bundled
 * member counts as `consolidated`.
 */
export type AlertIntakeDecision = 'created' | 'consolidated' | 'bundled' | 'noise' | 'dropped' | 'resolved';

/** @description Point-in-time view of the intake counters, served by GET /intake-stats. */
export interface AlertIntakeStatsSnapshot {
  /** ISO timestamp the counters started (process start / router construction). */
  since: string;
  /** Total decisions per class since `since`. */
  counts: Record<AlertIntakeDecision, number>;
  /** Noise drops per alertname — the "top noise sources" evidence (FR-A3). */
  noiseByAlertname: Record<string, number>;
}

/**
 * @description In-process intake decision counters (FR-A3). Operational telemetry, not
 * ticket data (spec §5): the durable consolidated record is the ticket; these counters
 * reset with the api process and say so via `since`. Noise is *measured*, never invisible.
 */
export class AlertIntakeStats {
  private readonly since = new Date().toISOString();

  private readonly counts: Record<AlertIntakeDecision, number> = {
    created: 0,
    consolidated: 0,
    bundled: 0,
    noise: 0,
    dropped: 0,
    resolved: 0,
  };

  private readonly noiseByAlertname = new Map<string, number>();

  /**
   * @description Records one intake decision; noise decisions also bump the per-alertname
   * bucket (unnamed alerts bucket under 'UnnamedAlert' so nothing is lost).
   * @param decision - The decision class.
   * @param alertname - The alertname, required in spirit for 'noise'.
   */
  record(decision: AlertIntakeDecision, alertname?: string): void {
    this.counts[decision] += 1;
    if (decision === 'noise') {
      const name = (alertname ?? '').trim() || 'UnnamedAlert';
      this.noiseByAlertname.set(name, (this.noiseByAlertname.get(name) ?? 0) + 1);
    }
  }

  /**
   * @description Returns a defensive copy of the counters for the stats read.
   * @returns Snapshot of counts + per-alertname noise.
   */
  snapshot(): AlertIntakeStatsSnapshot {
    return {
      since: this.since,
      counts: { ...this.counts },
      noiseByAlertname: Object.fromEntries(this.noiseByAlertname),
    };
  }
}
