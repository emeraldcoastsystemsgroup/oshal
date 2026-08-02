/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The Operations Stream funnel read model: per-lane stage counts captured into oshal_alert_funnel_snapshot in one unnest statement, the same counts computed live, per-stage trends for sparklines, the intake drop breakdown answered in SQL, the absence alarms that fire when the pipeline goes quiet, and the three dispatch counters that must never stand in for one another.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import {
  FUNNEL_STAGES,
  UNKNOWN_SOURCE,
  type AlertSource,
  type ClaimDecision,
  type DispatchAction,
  type DispatchChannel,
  type FunnelPoint,
  type FunnelStage,
  type UnclaimedReason,
} from './alert-pipeline-types';

const logger = createChildLogger({ module: 'funnel-stats' });

/** @description Default capture window. One hour of volume is enough to see a lane stop. */
export const DEFAULT_FUNNEL_WINDOW_MINUTES = 60;

/**
 * @description How long the intake may receive nothing at all before that silence is itself the
 * alarm. Alertmanager repeats a firing alert on its own repeat interval, so a healthy estate with
 * an open alert delivers continuously; a receiver that has stopped delivering produces no rows and
 * therefore no threshold alert of any kind. Ten minutes is comfortably longer than any normal
 * repeat interval and short enough that a wedged intake is noticed within one coffee break.
 */
export const ABSENCE_ENVELOPE_SILENCE_MINUTES = 10;

/**
 * @description How long an event may sit undecided before the claim stage is considered stalled.
 * The pump claims within one poll cycle, so anything still `pending` after five minutes means the
 * pump is not running, is crashing before it commits, or is losing its lock.
 */
export const ABSENCE_PENDING_AGE_MINUTES = 5;

/**
 * @description Share of incidents that may be grouped with no correlation engine before the
 * traversal is treated as unavailable. Correlation degrades to `none` rather than failing, which is
 * the right runtime behaviour and the wrong silent one: past this share the estate is being
 * consolidated on identity alone and every incident is arriving without its neighbours.
 */
export const ABSENCE_CORRELATION_FALLBACK_RATE = 0.5;

/**
 * @description Share of events that may fall back to the upstream fingerprint for identity before
 * the identity ladder is treated as broken. The fallback keeps an unlabelled alert countable, but a
 * fingerprint changes whenever the sender's label set changes, so a high rate means dedup is
 * quietly splitting one recurring incident into a stream of new ones.
 */
export const ABSENCE_FINGERPRINT_FALLBACK_RATE = 0.25;

/**
 * @description Minimum sample before either fallback rate is judged. Two events out of three is
 * 67% and means nothing; a rate alarm on a handful of rows fires constantly on a quiet estate and
 * teaches everyone to ignore it.
 */
export const ABSENCE_FALLBACK_MIN_SAMPLE = 20;

/** @description Window the absence alarms evaluate stage volume and fallback rates over. */
export const ABSENCE_FUNNEL_WINDOW_MINUTES = 60;

/**
 * @description Ceiling on the rows returned by each intake breakdown list. The breakdown answers
 * "what fired and what did nothing want", which is a ranked question — an unbounded GROUP BY over a
 * noisy day returns thousands of one-count rows that bury the answer and the payload.
 */
export const INTAKE_BREAKDOWN_LIMIT = 50;

/** The stage produced by the envelope table. Aliased to the stage name so the reader is generic. */
const ENVELOPE_STAGES = ['envelopes'] as const satisfies readonly FunnelStage[];

/** The stages produced by the event table's claim decision and unclaimed reason. */
const EVENT_STAGES = [
  'events',
  'identity_dropped',
  'noise',
  'claimed',
  'incidents_opened',
  'incidents_reopened',
  'incidents_bundled',
] as const satisfies readonly FunnelStage[];

/** The stages produced by the dispatch ledger. */
const DISPATCH_STAGES = [
  'tickets_created',
  'dispatch_attempted',
  'dispatch_suppressed',
  'dispatch_failed',
  'actions_applied',
] as const satisfies readonly FunnelStage[];

/**
 * Compile-time proof that the three per-table stage lists partition the funnel vocabulary. Adding a
 * stage to FUNNEL_STAGES without giving it a query makes `Unmapped` non-`never` and fails the build,
 * which is what stops a new stage from being captured as a permanent zero.
 */
type MappedStage =
  | (typeof ENVELOPE_STAGES)[number]
  | (typeof EVENT_STAGES)[number]
  | (typeof DISPATCH_STAGES)[number];
type UnmappedStage = Exclude<FunnelStage, MappedStage>;
const STAGE_COVERAGE_IS_COMPLETE: UnmappedStage extends never ? true : never = true;
void STAGE_COVERAGE_IS_COMPLETE;

/**
 * The decisions that mean a rule admitted the event. `resolved` belongs here: a resolution is an
 * event a rule claimed and acted on, and excluding it would make the claimed stage fall to zero on
 * a lane whose incidents are all clearing normally.
 */
const CLAIMED_DECISIONS: readonly ClaimDecision[] = [
  'created',
  'consolidated',
  'bundled',
  'reopened',
  'resolved',
];

/** The unclaimed reasons that mean the event could not be identified, as opposed to unwanted. */
const IDENTITY_DROP_REASONS: readonly UnclaimedReason[] = ['no_identity', 'identity_empty'];

const NOISE_DECISION: ClaimDecision = 'noise';
const CREATED_DECISION: ClaimDecision = 'created';
const REOPENED_DECISION: ClaimDecision = 'reopened';
const BUNDLED_DECISION: ClaimDecision = 'bundled';
const PENDING_DECISION: ClaimDecision = 'pending';

const TICKET_CHANNEL: DispatchChannel = 'ticket';
const TICKET_CREATE_ACTION: DispatchAction = 'create';
const APPLY_CHANNEL: DispatchChannel = 'self-heal';
const APPLY_ACTION: DispatchAction = 'apply';

/** The engine value recorded when a grouping ran without topology traversal. */
const CORRELATION_ENGINE_NONE = 'none';

/**
 * Every claim decision seeded at zero. Typed as a total `Record<ClaimDecision, number>` so a new
 * decision in the vocabulary is a compile error here rather than a key that silently never renders.
 */
const CLAIM_DECISION_SEED: Readonly<Record<ClaimDecision, number>> = Object.freeze({
  pending: 0,
  created: 0,
  consolidated: 0,
  bundled: 0,
  reopened: 0,
  resolved: 0,
  noise: 0,
  dropped: 0,
  failed: 0,
});

/** @description One absence condition and whether it currently holds. */
export interface AbsenceAlarm {
  /** Stable identifier, safe to route or silence on. Funnel gaps are `funnel-gap:<stage>`. */
  id: string;
  /** True when the condition holds right now. */
  firing: boolean;
  /** The numbers behind the verdict, so a firing alarm needs no second query to be understood. */
  detail: string;
}

/** @description The intake drop breakdown: what arrived, how it was decided, and what nothing wanted. */
export interface IntakeBreakdown {
  /** Every claim decision in the vocabulary, seeded at zero so an absent decision reads as zero. */
  byDecision: Record<string, number>;
  /** The loudest alert names in the window, ranked. */
  byAlertname: Array<{ alertname: string; count: number }>;
  /** Alert names that no rule claimed, split by the reason, ranked. The coverage-gap list. */
  unclaimed: Array<{ alertname: string; reason: string; count: number }>;
}

/**
 * @description Three counts that are routinely conflated and are never interchangeable. Rendering
 * any one of them under another's label overstates or understates the pipeline by whatever the
 * dedup and suppression ratios happen to be that hour, so they are returned together, named, and
 * computed over the same rows in one statement.
 */
export interface PipelineCounters {
  /** Distinct incident identities the pipeline dispatched about. NOT a message count. */
  uniqueIncidents: number;
  /** Outbound attempts made, successful or not. NOT an incident count and NOT a delivery count. */
  deliveryAttempts: number;
  /** Attempts that were neither suppressed nor failed. The only number that means "it landed". */
  successfulFirstDeliveries: number;
  /** The window these three describe. A count rendered without its window invites a wrong reading. */
  windowMinutes: number;
}

/** Per-lane, per-stage tallies being assembled from several queries. */
type LaneCounts = Map<AlertSource, Map<FunnelStage, number>>;

/** The raw numbers every absence condition is decided from, read at one instant. */
interface AbsenceProbe {
  recentEnvelopes: number;
  stalePending: number;
  oldestPending: Date | null;
  windowEvents: number;
  fingerprintFallbacks: number;
  windowIncidents: number;
  correlationFallbacks: number;
}

/**
 * @description Reject a window that cannot describe a time range. Answering a NaN or negative
 * window with a number hands back a count over an undefined range that reads exactly like a real
 * one, and a funnel is read as evidence.
 * @param value - Candidate window.
 * @param unit - Unit name for the message.
 * @param method - Calling method, for the message.
 * @returns The validated window.
 */
function requireWindow(value: number, unit: string, method: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `FunnelStats.${method}: ${unit} must be a finite number greater than zero (received ${String(value)})`,
    );
  }
  return value;
}

/**
 * @description Read one aggregate column. Counts arrive as strings because they are `bigint`, and a
 * missing column means the statement did not return what this code expects — which must surface as
 * an error rather than as a zero indistinguishable from a genuinely quiet lane.
 * @param row - The result row.
 * @param column - Column to read.
 * @returns The count as a number.
 */
function readCount(row: Record<string, unknown>, column: string): number {
  const raw = row[column];
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`FunnelStats: aggregate column "${column}" was not a number (received ${String(raw)})`);
  }
  return parsed;
}

/**
 * @description Fetch a lane's tallies, creating it with every stage at zero on first sight. Seeding
 * the whole vocabulary is what lets a lane that produced envelopes and nothing else be captured as
 * explicit zeros — the shape the gap alarm and the trend both need.
 * @param lanes - The accumulator.
 * @param source - Lane name.
 * @returns That lane's stage map.
 */
function laneBucket(lanes: LaneCounts, source: AlertSource): Map<FunnelStage, number> {
  const existing = lanes.get(source);
  if (existing) return existing;
  const fresh = new Map<FunnelStage, number>(FUNNEL_STAGES.map((stage) => [stage, 0]));
  lanes.set(source, fresh);
  return fresh;
}

/**
 * @description Fold one query's rows into the accumulator. Each query aliases its aggregates to the
 * exact stage names it produces, so the fold is generic and a renamed alias fails loudly in
 * `readCount` instead of quietly contributing nothing.
 * @param lanes - The accumulator.
 * @param rows - Rows carrying a `source` column plus one column per stage.
 * @param stages - The stages this query produced.
 * @returns Nothing; the accumulator is mutated.
 */
function absorbRows(
  lanes: LaneCounts,
  rows: Array<Record<string, unknown>>,
  stages: readonly FunnelStage[],
): void {
  for (const row of rows) {
    const raw = row.source;
    const source: AlertSource = typeof raw === 'string' && raw !== '' ? raw : UNKNOWN_SOURCE;
    const bucket = laneBucket(lanes, source);
    for (const stage of stages) {
      bucket.set(stage, (bucket.get(stage) ?? 0) + readCount(row, stage));
    }
  }
}

/**
 * @description Flatten the accumulator into funnel points ordered by the stage sequence, then by
 * lane. Stage order is the funnel's meaning: a consumer that renders rows in arrival order draws a
 * chart whose bars are in whatever order Postgres grouped them.
 * @param lanes - The accumulator.
 * @param ts - The instant every count describes.
 * @param windowMinutes - The window every count covers.
 * @returns Ordered funnel points.
 */
function flattenLanes(lanes: LaneCounts, ts: Date, windowMinutes: number): FunnelPoint[] {
  const sources = [...lanes.keys()].sort();
  const points: FunnelPoint[] = [];
  for (const stage of FUNNEL_STAGES) {
    for (const source of sources) {
      points.push({ stage, source, count: lanes.get(source)?.get(stage) ?? 0, ts, windowMinutes });
    }
  }
  return points;
}

/**
 * @description Sum a funnel across its lanes into one total per stage. The absence alarms judge the
 * pipeline as a whole, so they read this rather than reasoning lane by lane.
 * @param points - Funnel points for one window.
 * @returns Total per stage, every stage present.
 */
function totalPerStage(points: readonly FunnelPoint[]): Map<FunnelStage, number> {
  const totals = new Map<FunnelStage, number>(FUNNEL_STAGES.map((stage) => [stage, 0]));
  for (const point of points) {
    totals.set(point.stage, (totals.get(point.stage) ?? 0) + point.count);
  }
  return totals;
}

/**
 * @description Evaluate the funnel-gap condition for every adjacent pair of stages: a stage sitting
 * at zero while the stage feeding it is not.
 *
 * This is the condition that catches a pipeline that is up, healthy by every threshold, and doing
 * nothing — envelopes landing but no events, events claimed but no incidents, incidents opened but
 * no dispatch. Each pair is reported separately, firing or not, so a consumer can route the one
 * that matters to it instead of reading a single composite verdict.
 * @param totals - Stage totals for the alarm window.
 * @returns One alarm per adjacent stage pair.
 */
function funnelGapAlarms(totals: Map<FunnelStage, number>): AbsenceAlarm[] {
  const alarms: AbsenceAlarm[] = [];
  for (let i = 1; i < FUNNEL_STAGES.length; i += 1) {
    const previous = FUNNEL_STAGES[i - 1] as FunnelStage;
    const stage = FUNNEL_STAGES[i] as FunnelStage;
    const before = totals.get(previous) ?? 0;
    const here = totals.get(stage) ?? 0;
    alarms.push({
      id: `funnel-gap:${stage}`,
      firing: before > 0 && here === 0,
      detail: `${previous}=${before}, ${stage}=${here} over ${ABSENCE_FUNNEL_WINDOW_MINUTES}m`,
    });
  }
  return alarms;
}

/**
 * @description Evaluate the two silence conditions: nothing arriving at all, and nothing being
 * understood despite arrivals.
 * @param probe - The instantaneous read.
 * @param events - Event total over the alarm window.
 * @param envelopes - Envelope total over the alarm window.
 * @returns The silence alarms.
 */
function silenceAlarms(probe: AbsenceProbe, events: number, envelopes: number): AbsenceAlarm[] {
  const oldest = probe.oldestPending ? probe.oldestPending.toISOString() : 'none';
  return [
    {
      id: 'intake-silent',
      firing: probe.recentEnvelopes === 0,
      detail: `${probe.recentEnvelopes} envelopes in the last ${ABSENCE_ENVELOPE_SILENCE_MINUTES}m`,
    },
    {
      id: 'normalize-stalled',
      firing: envelopes > 0 && events === 0,
      detail: `envelopes=${envelopes}, events=${events} over ${ABSENCE_FUNNEL_WINDOW_MINUTES}m`,
    },
    {
      id: 'claim-backlog',
      firing: probe.stalePending > 0,
      detail: `${probe.stalePending} events pending for over ${ABSENCE_PENDING_AGE_MINUTES}m (oldest ${oldest})`,
    },
  ];
}

/**
 * @description Evaluate the two degradation rates. Both stages degrade rather than fail, which is
 * correct at runtime and invisible without these: the pipeline keeps producing incidents while the
 * grouping behind them stops meaning anything.
 * @param probe - The instantaneous read.
 * @returns The fallback-rate alarms.
 */
function fallbackAlarms(probe: AbsenceProbe): AbsenceAlarm[] {
  const fingerprintRate = probe.windowEvents > 0 ? probe.fingerprintFallbacks / probe.windowEvents : 0;
  const correlationRate = probe.windowIncidents > 0 ? probe.correlationFallbacks / probe.windowIncidents : 0;
  const asPercent = (rate: number): string => `${(rate * 100).toFixed(1)}%`;
  return [
    {
      id: 'fingerprint-fallback-rate',
      firing:
        probe.windowEvents >= ABSENCE_FALLBACK_MIN_SAMPLE
        && fingerprintRate > ABSENCE_FINGERPRINT_FALLBACK_RATE,
      detail:
        `${probe.fingerprintFallbacks}/${probe.windowEvents} events fell back to the upstream fingerprint `
        + `(${asPercent(fingerprintRate)}, threshold ${asPercent(ABSENCE_FINGERPRINT_FALLBACK_RATE)})`,
    },
    {
      id: 'correlation-fallback-rate',
      firing:
        probe.windowIncidents >= ABSENCE_FALLBACK_MIN_SAMPLE
        && correlationRate > ABSENCE_CORRELATION_FALLBACK_RATE,
      detail:
        `${probe.correlationFallbacks}/${probe.windowIncidents} incidents grouped with no correlation engine `
        + `(${asPercent(correlationRate)}, threshold ${asPercent(ABSENCE_CORRELATION_FALLBACK_RATE)})`,
    },
  ];
}

/**
 * Every input the absence conditions are decided from, in ONE statement bounded by a single
 * `bounds.ts`. Four separate reads would judge four different moments, and the disagreement between
 * them would present as exactly the gap the alarms are looking for.
 */
const ABSENCE_PROBE_SQL = `
  WITH bounds AS (SELECT now() AS ts),
  env AS (
    SELECT COUNT(*)::bigint AS recent_envelopes
      FROM oshal_alert_envelope, bounds
     WHERE received_at > bounds.ts - make_interval(mins => $1)
  ),
  pend AS (
    SELECT COUNT(*)::bigint AS stale_pending, MIN(received_at) AS oldest_pending
      FROM oshal_alert_event, bounds
     WHERE claim_decision = $2
       AND received_at < bounds.ts - make_interval(mins => $3)
  ),
  ev AS (
    SELECT COUNT(*)::bigint AS window_events,
           COUNT(*) FILTER (WHERE used_fingerprint_fallback)::bigint AS fingerprint_fallbacks
      FROM oshal_alert_event, bounds
     WHERE received_at > bounds.ts - make_interval(mins => $4)
  ),
  inc AS (
    SELECT COUNT(*)::bigint AS window_incidents,
           COUNT(*) FILTER (WHERE correlation_engine = $5)::bigint AS correlation_fallbacks
      FROM oshal_incident, bounds
     WHERE first_seen > bounds.ts - make_interval(mins => $4)
  )
  SELECT * FROM env, pend, ev, inc`;

/**
 * @description The funnel read model over the Operations Stream tables.
 *
 * Every stage count is a PER-LANE query. A global total sliced by a lane label is not a funnel: the
 * slices stop being sequential, a later stage can come back larger than an earlier one, and the one
 * question the funnel exists to answer — where did the volume stop — becomes unanswerable.
 */
export class FunnelStats {
  /**
   * @description Bind the read model to a connection pool.
   * @param pool - Pool whose connections carry the identity the row-level policies expect: the
   * pipeline owner or an operator. A pool without it reads and writes nothing and reports zeros.
   */
  constructor(private readonly pool: Pool) {}

  /**
   * @description Read the database clock. Every stage query is then bounded by that ONE instant on
   * both sides, so the stages describe exactly the same window. Letting each query call `now()`
   * itself lets a row land between two of them and appear in a later stage but not an earlier one,
   * which is indistinguishable from the pipeline being broken.
   * @returns The database's current transaction-independent timestamp.
   */
  private async dbNow(): Promise<Date> {
    const result = await this.pool.query('SELECT now() AS ts');
    const ts = result.rows[0]?.ts;
    if (!(ts instanceof Date)) {
      throw new Error('FunnelStats: the database did not return a usable clock reading');
    }
    return ts;
  }

  /**
   * @description Count landed deliveries per lane.
   * @param ts - Upper bound of the window.
   * @param minutes - Window length.
   * @returns Rows aliased to the envelope stage name.
   */
  private async envelopeRows(ts: Date, minutes: number): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT source, COUNT(*)::bigint AS envelopes
         FROM oshal_alert_envelope
        WHERE received_at >  $1::timestamptz - make_interval(mins => $2)
          AND received_at <= $1::timestamptz
        GROUP BY source`,
      [ts, minutes],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  /**
   * @description Count the intake decisions per lane. Every stage here is a `FILTER` over the same
   * scan, so the drops, the noise and the claims are all measured against the identical event set.
   * @param ts - Upper bound of the window.
   * @param minutes - Window length.
   * @returns Rows aliased to the event stage names.
   */
  private async eventRows(ts: Date, minutes: number): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT source,
              COUNT(*)::bigint AS events,
              COUNT(*) FILTER (WHERE unclaimed_reason = ANY($3::text[]))::bigint AS identity_dropped,
              COUNT(*) FILTER (WHERE claim_decision = $4)::bigint AS noise,
              COUNT(*) FILTER (WHERE claim_decision = ANY($5::text[]))::bigint AS claimed,
              COUNT(*) FILTER (WHERE claim_decision = $6)::bigint AS incidents_opened,
              COUNT(*) FILTER (WHERE claim_decision = $7)::bigint AS incidents_reopened,
              COUNT(*) FILTER (WHERE claim_decision = $8)::bigint AS incidents_bundled
         FROM oshal_alert_event
        WHERE received_at >  $1::timestamptz - make_interval(mins => $2)
          AND received_at <= $1::timestamptz
        GROUP BY source`,
      [
        ts,
        minutes,
        IDENTITY_DROP_REASONS,
        NOISE_DECISION,
        CLAIMED_DECISIONS,
        CREATED_DECISION,
        REOPENED_DECISION,
        BUNDLED_DECISION,
      ],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  /**
   * @description Count the outbound decisions per lane.
   *
   * The ledger records an identity, not a lane, so the lane is recovered by looking each dispatched
   * identity up against its most recent event. That lookup is deliberately NOT bounded by the
   * window: a dispatch about an incident that opened hours ago still belongs to the lane it arrived
   * on, and bounding it would file every long-running incident under the unknown lane.
   * @param ts - Upper bound of the window.
   * @param minutes - Window length.
   * @returns Rows aliased to the dispatch stage names.
   */
  private async dispatchRows(ts: Date, minutes: number): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `WITH dispatched AS (
         SELECT dedup_key, target_channel, action, attempted, suppressed, success
           FROM oshal_alert_dispatch
          WHERE at >  $1::timestamptz - make_interval(mins => $2)
            AND at <= $1::timestamptz
       ),
       lane AS (
         SELECT DISTINCT ON (e.dedup_key) e.dedup_key, e.source
           FROM oshal_alert_event e
          WHERE e.dedup_key IS NOT NULL
            AND e.dedup_key <> ''
            AND e.dedup_key IN (SELECT dedup_key FROM dispatched)
          ORDER BY e.dedup_key, e.received_at DESC
       )
       SELECT COALESCE(lane.source, $3::text) AS source,
              COUNT(*) FILTER (WHERE d.target_channel = $4 AND d.action = $5
                                 AND d.attempted AND d.success IS TRUE)::bigint AS tickets_created,
              COUNT(*) FILTER (WHERE d.attempted)::bigint AS dispatch_attempted,
              COUNT(*) FILTER (WHERE d.suppressed)::bigint AS dispatch_suppressed,
              COUNT(*) FILTER (WHERE d.attempted AND d.success IS NOT TRUE)::bigint AS dispatch_failed,
              COUNT(*) FILTER (WHERE d.target_channel = $6 AND d.action = $7
                                 AND d.attempted AND d.success IS TRUE)::bigint AS actions_applied
         FROM dispatched d
         LEFT JOIN lane ON lane.dedup_key = d.dedup_key
        GROUP BY COALESCE(lane.source, $3::text)`,
      [ts, minutes, UNKNOWN_SOURCE, TICKET_CHANNEL, TICKET_CREATE_ACTION, APPLY_CHANNEL, APPLY_ACTION],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  /**
   * @description Compute the whole funnel live, per lane, over one shared instant.
   * @param minutes - Window length, already validated.
   * @returns The instant the funnel describes and its ordered points.
   */
  private async liveFunnel(minutes: number): Promise<{ ts: Date; points: FunnelPoint[] }> {
    const ts = await this.dbNow();
    const [envelopes, events, dispatches] = await Promise.all([
      this.envelopeRows(ts, minutes),
      this.eventRows(ts, minutes),
      this.dispatchRows(ts, minutes),
    ]);
    const lanes: LaneCounts = new Map();
    absorbRows(lanes, envelopes, ENVELOPE_STAGES);
    absorbRows(lanes, events, EVENT_STAGES);
    absorbRows(lanes, dispatches, DISPATCH_STAGES);
    return { ts, points: flattenLanes(lanes, ts, minutes) };
  }

  /**
   * @description Compute the funnel and write it to the snapshot table.
   *
   * Every lane is written with every stage, zeros included: a stage that is missing from the
   * snapshot is indistinguishable from a stage that was never captured, and the gap alarm and the
   * trend both need the zero to be a recorded fact. The whole capture is ONE insert over unnested
   * parallel arrays, so a lane cannot be half-written by a connection that drops mid-loop.
   * @param windowMinutes - Window each captured count covers.
   * @returns Number of snapshot rows written.
   */
  async capture(windowMinutes: number = DEFAULT_FUNNEL_WINDOW_MINUTES): Promise<number> {
    const minutes = requireWindow(windowMinutes, 'windowMinutes', 'capture');
    const { ts, points } = await this.liveFunnel(minutes);
    if (points.length === 0) {
      logger.info({ windowMinutes: minutes }, 'Funnel capture found no active lanes — nothing to record');
      return 0;
    }
    try {
      const result = await this.pool.query(
        `INSERT INTO oshal_alert_funnel_snapshot (ts, source, stage, count, window_minutes)
         SELECT $1::timestamptz, lane.source, lane.stage, lane.count, $5::integer
           FROM unnest($2::text[], $3::text[], $4::bigint[]) AS lane(source, stage, count)`,
        [ts, points.map((p) => p.source), points.map((p) => p.stage), points.map((p) => p.count), minutes],
      );
      const written = result.rowCount ?? 0;
      logger.info({ windowMinutes: minutes, written, lanes: written / FUNNEL_STAGES.length }, 'Funnel captured');
      return written;
    } catch (err) {
      logger.error({ err, windowMinutes: minutes, points: points.length }, 'Funnel capture write failed — this window will be a hole in the trend');
      throw err;
    }
  }

  /**
   * @description The funnel computed from the live tables rather than read back from snapshots.
   * This is what a surface renders for "right now"; the snapshots exist for history.
   * @param windowMinutes - Trailing window.
   * @returns Points ordered by the funnel stage sequence, then by lane.
   */
  async currentFunnel(windowMinutes: number): Promise<FunnelPoint[]> {
    const minutes = requireWindow(windowMinutes, 'windowMinutes', 'currentFunnel');
    try {
      const { points } = await this.liveFunnel(minutes);
      return points;
    } catch (err) {
      logger.error({ err, windowMinutes: minutes }, 'Live funnel computation failed');
      throw err;
    }
  }

  /**
   * @description One stage's captured history, per lane, oldest first — the sparkline behind a
   * stage tile. Read from the snapshots rather than recomputed, because the events they were
   * computed from age out long before the snapshots do.
   * @param stage - Stage to trend. Validated against the vocabulary because callers hand through
   * strings from a query string, where the type says nothing.
   * @param hours - How far back to read.
   * @returns Captured points in ascending time order.
   */
  async trend(stage: FunnelStage, hours: number): Promise<Array<{ ts: Date; count: number; source: string }>> {
    const span = requireWindow(hours, 'hours', 'trend');
    if (!FUNNEL_STAGES.includes(stage)) {
      throw new Error(`FunnelStats.trend: "${String(stage)}" is not a funnel stage`);
    }
    try {
      const result = await this.pool.query(
        `SELECT ts, source, count::bigint AS count
           FROM oshal_alert_funnel_snapshot
          WHERE stage = $1
            AND ts > now() - make_interval(hours => $2)
          ORDER BY ts ASC, source ASC`,
        [stage, span],
      );
      return (result.rows as Array<Record<string, unknown>>).map((row) => ({
        ts: row.ts as Date,
        source: String(row.source),
        count: readCount(row, 'count'),
      }));
    } catch (err) {
      logger.error({ err, stage, hours: span }, 'Funnel trend read failed');
      throw err;
    }
  }

  /**
   * @description What arrived, how intake decided it, and what nothing wanted.
   *
   * Answered entirely in SQL over the durable decision columns. A process-local counter cannot
   * answer it: it resets with the process, it cannot be grouped by alert name, and it disagrees
   * between replicas — which is exactly why a noise allowlist that is tuned from counters is tuned
   * from guesswork.
   * @param windowMinutes - Trailing window.
   * @returns The decision totals, the loudest alert names, and the unclaimed coverage gaps.
   */
  async intakeBreakdown(windowMinutes: number): Promise<IntakeBreakdown> {
    const minutes = requireWindow(windowMinutes, 'windowMinutes', 'intakeBreakdown');
    try {
      const ts = await this.dbNow();
      const [decisions, alertnames, unclaimed] = await Promise.all([
        this.decisionRows(ts, minutes),
        this.alertnameRows(ts, minutes),
        this.unclaimedRows(ts, minutes),
      ]);
      const byDecision: Record<string, number> = { ...CLAIM_DECISION_SEED };
      for (const row of decisions) {
        byDecision[String(row.claim_decision)] = readCount(row, 'count');
      }
      return {
        byDecision,
        byAlertname: alertnames.map((row) => ({
          alertname: String(row.alertname),
          count: readCount(row, 'count'),
        })),
        unclaimed: unclaimed.map((row) => ({
          alertname: String(row.alertname),
          reason: String(row.reason),
          count: readCount(row, 'count'),
        })),
      };
    } catch (err) {
      logger.error({ err, windowMinutes: minutes }, 'Intake breakdown read failed');
      throw err;
    }
  }

  /**
   * @description Group the window's events by their durable intake decision.
   * @param ts - Upper bound of the window.
   * @param minutes - Window length.
   * @returns One row per decision present.
   */
  private async decisionRows(ts: Date, minutes: number): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT claim_decision, COUNT(*)::bigint AS count
         FROM oshal_alert_event
        WHERE received_at >  $1::timestamptz - make_interval(mins => $2)
          AND received_at <= $1::timestamptz
        GROUP BY claim_decision`,
      [ts, minutes],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  /**
   * @description Rank the window's alert names by volume — what is loud, claimed or not.
   * @param ts - Upper bound of the window.
   * @param minutes - Window length.
   * @returns Up to {@link INTAKE_BREAKDOWN_LIMIT} rows, loudest first.
   */
  private async alertnameRows(ts: Date, minutes: number): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT alertname, COUNT(*)::bigint AS count
         FROM oshal_alert_event
        WHERE received_at >  $1::timestamptz - make_interval(mins => $2)
          AND received_at <= $1::timestamptz
        GROUP BY alertname
        ORDER BY count DESC, alertname ASC
        LIMIT $3`,
      [ts, minutes, INTAKE_BREAKDOWN_LIMIT],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  /**
   * @description Rank what no rule claimed, split by the reason. A coverage gap (`no_rule_match`)
   * and a routing bug (`unknown_source`) look identical in a total and want opposite fixes, so the
   * reason is carried rather than summed away.
   * @param ts - Upper bound of the window.
   * @param minutes - Window length.
   * @returns Up to {@link INTAKE_BREAKDOWN_LIMIT} rows, loudest first.
   */
  private async unclaimedRows(ts: Date, minutes: number): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `SELECT alertname, unclaimed_reason AS reason, COUNT(*)::bigint AS count
         FROM oshal_alert_event
        WHERE received_at >  $1::timestamptz - make_interval(mins => $2)
          AND received_at <= $1::timestamptz
          AND unclaimed_reason IS NOT NULL
        GROUP BY alertname, unclaimed_reason
        ORDER BY count DESC, alertname ASC, reason ASC
        LIMIT $3`,
      [ts, minutes, INTAKE_BREAKDOWN_LIMIT],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  /**
   * @description Evaluate every absence condition and report each one's state, firing or not.
   *
   * These conditions are absence-shaped on purpose. A threshold alarm can only fire on data, so a
   * pipeline that has stopped producing data produces no alarms and looks, on every dashboard, like
   * a quiet night. The only way to alarm on nothing happening is to ask whether nothing happened.
   *
   * A read failure throws rather than returning an empty or all-clear list: a monitor that cannot
   * evaluate its conditions must be loud, and an all-clear it invented is the exact failure this
   * whole method exists to prevent.
   * @returns One entry per condition, including the ones that are not firing.
   */
  async absenceAlarms(): Promise<AbsenceAlarm[]> {
    try {
      const [{ points }, probe] = await Promise.all([
        this.liveFunnel(ABSENCE_FUNNEL_WINDOW_MINUTES),
        this.absenceProbe(),
      ]);
      const totals = totalPerStage(points);
      const alarms = [
        ...silenceAlarms(probe, totals.get('events') ?? 0, totals.get('envelopes') ?? 0),
        ...funnelGapAlarms(totals),
        ...fallbackAlarms(probe),
      ];
      const firing = alarms.filter((alarm) => alarm.firing);
      if (firing.length > 0) {
        logger.warn({ firing: firing.map((alarm) => alarm.id) }, 'Alert pipeline absence alarms are firing');
      }
      return alarms;
    } catch (err) {
      logger.error({ err }, 'Absence alarm evaluation failed — the pipeline health verdict is unknown, not clear');
      throw err;
    }
  }

  /**
   * @description Read every number the absence conditions are decided from, at one instant and in
   * one statement, so no two conditions can be judged against different moments.
   * @returns The raw probe counts.
   */
  private async absenceProbe(): Promise<AbsenceProbe> {
    const result = await this.pool.query(
      ABSENCE_PROBE_SQL,
      [
        ABSENCE_ENVELOPE_SILENCE_MINUTES,
        PENDING_DECISION,
        ABSENCE_PENDING_AGE_MINUTES,
        ABSENCE_FUNNEL_WINDOW_MINUTES,
        CORRELATION_ENGINE_NONE,
      ],
    );
    const row = (result.rows[0] ?? {}) as Record<string, unknown>;
    const oldest = row.oldest_pending;
    return {
      recentEnvelopes: readCount(row, 'recent_envelopes'),
      stalePending: readCount(row, 'stale_pending'),
      oldestPending: oldest instanceof Date ? oldest : null,
      windowEvents: readCount(row, 'window_events'),
      fingerprintFallbacks: readCount(row, 'fingerprint_fallbacks'),
      windowIncidents: readCount(row, 'window_incidents'),
      correlationFallbacks: readCount(row, 'correlation_fallbacks'),
    };
  }

  /**
   * @description The three dispatch counters, computed over the same rows in one statement.
   *
   * They answer three different questions and are routinely swapped for one another: how many
   * distinct things went wrong, how many times the pipeline reached outward, and how many of those
   * reaches actually landed. Suppression and dedup mean the three diverge by an arbitrary factor,
   * so no one of them can be derived from another and none may be relabelled as another.
   * @param windowMinutes - Trailing window.
   * @returns The three counts plus the window they describe.
   */
  async countersSummary(windowMinutes: number): Promise<PipelineCounters> {
    const minutes = requireWindow(windowMinutes, 'windowMinutes', 'countersSummary');
    try {
      const result = await this.pool.query(
        `SELECT COUNT(DISTINCT dedup_key)::bigint AS unique_incidents,
                COUNT(*) FILTER (WHERE attempted)::bigint AS delivery_attempts,
                COUNT(*) FILTER (WHERE attempted AND success IS TRUE AND NOT suppressed)::bigint
                  AS successful_first_deliveries
           FROM oshal_alert_dispatch
          WHERE at > now() - make_interval(mins => $1)`,
        [minutes],
      );
      const row = (result.rows[0] ?? {}) as Record<string, unknown>;
      return {
        uniqueIncidents: readCount(row, 'unique_incidents'),
        deliveryAttempts: readCount(row, 'delivery_attempts'),
        successfulFirstDeliveries: readCount(row, 'successful_first_deliveries'),
        windowMinutes: minutes,
      };
    } catch (err) {
      logger.error({ err, windowMinutes: minutes }, 'Dispatch counter summary failed');
      throw err;
    }
  }
}
