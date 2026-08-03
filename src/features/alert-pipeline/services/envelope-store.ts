/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Operations Stream landing stage: the verbatim envelope write, the pure per-alert normalizer (target ladder, severity ordinal, promoted labels, timestamp sanity floor), the SKIP LOCKED pending-event claim, and the decide/fail/deadletter transitions. One transaction per delivery so an envelope and its events are either both durable or neither is.
 */

import type { Pool, PoolClient } from 'pg';
import { createChildLogger } from '@/shared/logger';
import {
  PIPELINE_OWNER_SUB,
  SEVERITY_RANK,
  SEVERITY_RANK_DEFAULT,
  type AlertEnvelopeRow,
  type AlertEventRow,
  type AlertSource,
  type AlertStatus,
  type ClaimDecision,
  type DeadletterStage,
  type UnclaimedReason,
} from './alert-pipeline-types';

const logger = createChildLogger({ module: 'envelope-store' });

/**
 * @description How many times one event may fail its claim attempt before the pipeline stops
 * retrying it. On the attempt that reaches this count the event is stamped `failed` AND a
 * deadletter row is written, so a permanently broken event leaves evidence instead of either
 * spinning forever or vanishing from the funnel.
 */
export const MAX_EVENT_ATTEMPTS = 5;

/**
 * @description Ceiling on the stored `summary`. Applied AT WRITE TIME rather than at render
 * time: an unbounded annotation is attacker-influenced free text on a hot table, and a limit
 * enforced only by the surface still pays the storage and the transfer cost on every read.
 */
export const ALERT_SUMMARY_MAX_LENGTH = 500;

/**
 * @description The target-resolution ladder, most specific rung first. The first label that
 * carries a non-empty value names the failing thing, and the rung that matched is stored
 * alongside it — `instance` resolving a target means something materially different from
 * `container` resolving it, and that distinction is unrecoverable once only the value is kept.
 */
export const TARGET_LADDER = ['container', 'container_name', 'name', 'pod', 'instance', 'job'] as const;

/** @description The label that resolved an event's target — one rung of {@link TARGET_LADDER}. */
export type TargetKind = (typeof TARGET_LADDER)[number];

/**
 * @description A query boundary that is either the pool or a transaction-scoped client. Every
 * write here accepts one so a caller holding rows under `FOR UPDATE` can complete the decision
 * on the SAME connection — using the pool instead would block on locks its own transaction holds.
 */
export type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

/** @description One alert inside an Alertmanager v4 delivery, exactly as it arrives on the wire. */
export interface RawAlertmanagerAlert {
  status?: string;
  labels?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  startsAt?: string;
  endsAt?: string;
  generatorURL?: string;
  fingerprint?: string;
}

/** @description The Alertmanager v4 webhook body: batch metadata plus the alerts it carries. */
export interface RawAlertmanagerEnvelope {
  version?: string;
  groupKey?: string;
  truncatedAlerts?: number;
  status?: string;
  receiver?: string;
  groupLabels?: Record<string, unknown>;
  commonLabels?: Record<string, unknown>;
  commonAnnotations?: Record<string, unknown>;
  externalURL?: string;
  alerts?: RawAlertmanagerAlert[];
}

/** @description A parsed delivery plus the transport facts only the receiving route can know. */
export interface LandEnvelopeInput {
  /** The parsed body, stored verbatim so a normalization fix is a replay, not lost data. */
  body: RawAlertmanagerEnvelope;
  /** The lane this arrived on — selects the claim-rule candidate set downstream. */
  source: AlertSource;
  /** Peer address as the route observed it, for provenance on a forged-delivery investigation. */
  remoteAddr?: string | null;
  /** Whether the body signature was verified. Recorded, never assumed. */
  signatureVerified: boolean;
  /** Set when this delivery is a replay of an earlier envelope. */
  replayedFrom?: string | null;
}

/** @description What landed: the envelope and every event expanded out of it, in arrival order. */
export interface LandEnvelopeResult {
  envelopeId: string;
  eventIds: string[];
}

/**
 * @description One alert reduced to the column set `oshal_alert_event` stores. Deliberately
 * excludes the consolidation identity (`dedupKey` / `identitySource`): landing records what
 * ARRIVED, the claim stage decides what it MEANS, and one writer per column is what keeps the
 * two from disagreeing.
 */
export interface NormalizedAlertInput {
  fingerprint: string;
  alertname: string;
  target: string;
  targetKind: TargetKind | null;
  severity: string;
  severityNum: number;
  status: AlertStatus;
  startedAt: Date | null;
  endedAt: Date | null;
  generatorUrl: string | null;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  summary: string | null;
  namespace: string | null;
  container: string | null;
  instance: string | null;
  job: string | null;
}

/** @description What to stamp on an event alongside its decision. Every field is optional. */
export interface EventDecisionDetail {
  /** The claim rule that admitted the event — the answer to "why is this here". */
  claimedByRule?: string | null;
  /** Why it was NOT claimed. A coverage gap and a routing bug must look different. */
  unclaimedReason?: UnclaimedReason | null;
  /** The incident the event landed on, when the decision produced or joined one. */
  incidentId?: string | null;
  /**
   * The consolidation identity, resolved by the claim stage rather than at landing. Landing
   * stores what arrived; deciding stores what it means, so the two never race for the column.
   */
  dedupKey?: string | null;
  /**
   * The exact pre-image that was hashed, human-readable. Without it a wrong key cannot be
   * diagnosed after the fact — the digest alone says nothing about which fields produced it.
   */
  identitySource?: string | null;
  /**
   * True when the identity rendered empty and the upstream fingerprint stood in. A rising rate
   * means an alert shape whose labels are not covered, which is alertable rather than a log line.
   */
  usedFingerprintFallback?: boolean;
}

/** @description An item that could not be understood or processed, parked for replay. */
export interface DeadletterEntry {
  stage: DeadletterStage;
  envelopeId?: string | null;
  eventId?: string | null;
  failureReason: string;
  error?: unknown;
  raw?: unknown;
  attempts?: number;
}

/** @description The snake_case `oshal_alert_envelope` row as `pg` returns it. */
export interface AlertEnvelopeDbRow {
  envelope_id: string;
  received_at: Date;
  source: string;
  receiver: string | null;
  envelope_status: string | null;
  group_key: string | null;
  external_url: string | null;
  alert_count: number;
  truncated_alerts: number;
  body: unknown;
  remote_addr: string | null;
  signature_verified: boolean;
  expanded_count: number;
  normalize_error: string | null;
  replayed_from: string | null;
}

/** @description The snake_case `oshal_alert_event` row as `pg` returns it. */
export interface AlertEventDbRow {
  event_id: string;
  envelope_id: string | null;
  received_at: Date;
  source: string;
  fingerprint: string;
  alertname: string;
  target: string;
  target_kind: string | null;
  severity: string;
  severity_num: number;
  status: string;
  started_at: Date | null;
  ended_at: Date | null;
  generator_url: string | null;
  labels: Record<string, string> | null;
  annotations: Record<string, string> | null;
  summary: string | null;
  namespace: string | null;
  container: string | null;
  instance: string | null;
  job: string | null;
  envelope_group_key: string | null;
  receiver: string | null;
  dedup_key: string | null;
  identity_source: string | null;
  used_fingerprint_fallback: boolean;
  claim_decision: string;
  claimed_by_rule: string | null;
  unclaimed_reason: string | null;
  incident_id: string | null;
  attempts: number;
  last_error: string | null;
  processed_at: Date | null;
}

/** Timestamps at or before this instant are a misparse, not a real alert time. */
const TIMESTAMP_SANITY_FLOOR_MS = Date.UTC(2000, 0, 1);

/** Upper bound on a stored `last_error`, so one pathological stack cannot bloat the hot table. */
const LAST_ERROR_MAX_LENGTH = 2000;

/** Ceiling on one claim batch. A pump asking for more would lock a slice nobody can drain. */
const MAX_CLAIM_BATCH = 500;

const INSERT_ENVELOPE_SQL = `
  INSERT INTO oshal_alert_envelope (
    source, receiver, envelope_status, group_key, external_url,
    alert_count, truncated_alerts, body, remote_addr, signature_verified,
    replayed_from, owner_sub
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)
  RETURNING envelope_id, received_at`;

const INSERT_EVENT_SQL = `
  INSERT INTO oshal_alert_event (
    envelope_id, received_at, source, fingerprint, alertname, target, target_kind,
    severity, severity_num, status, started_at, ended_at, generator_url,
    labels, annotations, summary, namespace, container, instance, job,
    envelope_group_key, receiver, owner_sub
  ) VALUES (
    $1,$2,$3,$4,$5,$6,$7,
    $8,$9,$10,$11,$12,$13,
    $14::jsonb,$15::jsonb,$16,$17,$18,$19,$20,
    $21,$22,$23
  )
  RETURNING event_id`;

const SELECT_PENDING_SQL = `
  SELECT * FROM oshal_alert_event
   WHERE claim_decision = 'pending'
   ORDER BY received_at
     FOR UPDATE SKIP LOCKED
   LIMIT $1`;

const DECIDE_EVENT_SQL = `
  UPDATE oshal_alert_event
     SET claim_decision   = $2,
         claimed_by_rule  = $3,
         unclaimed_reason = $4,
         incident_id      = $5,
         -- COALESCE so a later decision never blanks an identity an earlier pass resolved:
         -- a replay that re-decides an event must not erase the key it consolidated under.
         dedup_key        = COALESCE($6, dedup_key),
         identity_source  = COALESCE($7, identity_source),
         used_fingerprint_fallback = COALESCE($8, used_fingerprint_fallback),
         processed_at     = now()
   WHERE event_id = $1`;

const FAIL_EVENT_SQL = `
  UPDATE oshal_alert_event
     SET attempts       = attempts + 1,
         last_error     = $2,
         claim_decision = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE claim_decision END,
         processed_at   = CASE WHEN attempts + 1 >= $3 THEN now() ELSE processed_at END
   WHERE event_id = $1
   RETURNING attempts, claim_decision, source, alertname, target, fingerprint`;

const INSERT_DEADLETTER_SQL = `
  INSERT INTO oshal_alert_deadletter (
    stage, envelope_id, event_id, failure_reason, error, raw, attempts, owner_sub
  ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`;

/**
 * @description Coerces an arbitrary JSON map into the string map the label/annotation columns
 * hold. A producer sending a number or an object where a label is expected is a contract
 * mismatch that must still be stored and queryable — dropping the key would hide it.
 * @param value - Candidate map from the wire.
 * @returns Every present key with a string value; `{}` for anything that is not a plain object.
 */
function toStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || raw === undefined) {
      continue;
    }
    out[key] = typeof raw === 'string' ? raw : JSON.stringify(raw);
  }
  return out;
}

/**
 * @description Parses an alert timestamp against a sanity floor of 2000-01-01. Producers emit a
 * zero-value time (year 0001) for an unset `endsAt`, which parses cleanly into a date two
 * millennia in the past; storing that would make every duration and every "still firing" read
 * wrong while looking like valid data. Below the floor the answer is "unknown", which is null.
 * @param raw - Candidate ISO-8601 timestamp.
 * @returns The parsed instant, or null when absent, unparseable, or implausibly old.
 */
function parseAlertTimestamp(raw: unknown): Date | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return null;
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms) || ms < TIMESTAMP_SANITY_FLOOR_MS) {
    return null;
  }
  return new Date(ms);
}

/**
 * @description Trims free text to a hard character budget, marking the cut so a reader can tell
 * a truncated sentence from a producer that genuinely wrote a fragment.
 * @param value - Text to bound.
 * @param max - Inclusive character ceiling.
 * @returns The value unchanged when it fits, otherwise a marked prefix of exactly `max` chars.
 */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * @description Renders any thrown value as loggable, storable text without leaking a stack into
 * an unbounded column.
 * @param error - The thrown value.
 * @returns A bounded single-string description.
 */
function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return truncate(text, LAST_ERROR_MAX_LENGTH);
}

/**
 * @description Walks {@link TARGET_LADDER} and returns the first rung that carries a value,
 * together with WHICH rung it was.
 * @param labels - Merged labels for one alert.
 * @returns The resolved target and its rung; `{ target: '', targetKind: null }` when none match.
 */
function resolveTarget(labels: Record<string, string>): { target: string; targetKind: TargetKind | null } {
  for (const kind of TARGET_LADDER) {
    const candidate = (labels[kind] ?? '').trim();
    if (candidate.length > 0) {
      return { target: candidate, targetKind: kind };
    }
  }
  return { target: '', targetKind: null };
}

/**
 * @description Maps a severity label to the inverted ordinal every rule filter compares against
 * (1 = critical … 4 = info). An unrecognized severity ranks as `warning` rather than dropping
 * out of range — the CHECK constraint on the column admits 1..4 only, and a rule reading
 * `severity_num <= N` must never be silently unable to see an event.
 * @param severity - Raw `severity` label.
 * @returns An ordinal between 1 and 4.
 */
function severityOrdinal(severity: string): number {
  return SEVERITY_RANK[severity.toLowerCase()] ?? SEVERITY_RANK_DEFAULT;
}

/**
 * @description Normalizes one wire alert into the row shape `oshal_alert_event` stores. Pure:
 * given the same alert and envelope it always yields the same result and touches nothing else,
 * which is what makes a replay of a stored envelope reproduce the original expansion exactly.
 *
 * Envelope-level `commonLabels` / `commonAnnotations` merge UNDERNEATH the per-alert maps: the
 * common maps are the intersection the batch happens to share, so letting them win would
 * overwrite the specific value that identifies the individual alert.
 * @param alert - One entry from the delivery's `alerts[]`.
 * @param envelope - The delivery it arrived in, for the common label/annotation floor.
 * @returns The normalized per-alert column set.
 */
export function normalizeAlert(
  alert: RawAlertmanagerAlert,
  envelope: RawAlertmanagerEnvelope,
): NormalizedAlertInput {
  const labels = { ...toStringMap(envelope?.commonLabels), ...toStringMap(alert?.labels) };
  const annotations = { ...toStringMap(envelope?.commonAnnotations), ...toStringMap(alert?.annotations) };
  const { target, targetKind } = resolveTarget(labels);
  // Case-folded so `severity` groups into one bucket per level. Nothing is lost: the label map
  // stored alongside keeps the producer's exact spelling.
  const severity = (labels.severity ?? '').trim().toLowerCase() || 'warning';
  const summary = (annotations.summary ?? annotations.description ?? '').trim();
  const status: AlertStatus = alert?.status === 'resolved' ? 'resolved' : 'firing';
  return {
    fingerprint: (alert?.fingerprint ?? '').trim(),
    alertname: (labels.alertname ?? '').trim(),
    target,
    targetKind,
    severity,
    severityNum: severityOrdinal(severity),
    status,
    startedAt: parseAlertTimestamp(alert?.startsAt),
    endedAt: parseAlertTimestamp(alert?.endsAt),
    generatorUrl: (alert?.generatorURL ?? '').trim() || null,
    labels,
    annotations,
    summary: summary ? truncate(summary, ALERT_SUMMARY_MAX_LENGTH) : null,
    namespace: labels.namespace?.trim() || null,
    container: labels.container?.trim() || labels.container_name?.trim() || null,
    instance: labels.instance?.trim() || null,
    job: labels.job?.trim() || null,
  };
}

/**
 * @description Converts a landed envelope row to the camelCase contract shape.
 * @param row - Raw `oshal_alert_envelope` row.
 * @returns The envelope in contract form.
 */
export function mapAlertEnvelopeRow(row: AlertEnvelopeDbRow): AlertEnvelopeRow {
  return {
    envelopeId: row.envelope_id,
    receivedAt: row.received_at,
    source: row.source,
    receiver: row.receiver,
    envelopeStatus: row.envelope_status,
    groupKey: row.group_key,
    externalUrl: row.external_url,
    alertCount: Number(row.alert_count),
    truncatedAlerts: Number(row.truncated_alerts),
    body: row.body,
    remoteAddr: row.remote_addr,
    signatureVerified: row.signature_verified,
    expandedCount: Number(row.expanded_count),
    normalizeError: row.normalize_error,
    replayedFrom: row.replayed_from,
  };
}

/**
 * @description Converts a normalized event row to the camelCase contract shape every downstream
 * stage reads.
 * @param row - Raw `oshal_alert_event` row.
 * @returns The event in contract form.
 */
export function mapAlertEventRow(row: AlertEventDbRow): AlertEventRow {
  return {
    eventId: row.event_id,
    envelopeId: row.envelope_id,
    receivedAt: row.received_at,
    source: row.source,
    fingerprint: row.fingerprint,
    alertname: row.alertname,
    target: row.target,
    targetKind: row.target_kind,
    severity: row.severity,
    severityNum: Number(row.severity_num),
    status: row.status === 'resolved' ? 'resolved' : 'firing',
    startedAt: row.started_at,
    endedAt: row.ended_at,
    generatorUrl: row.generator_url,
    labels: row.labels ?? {},
    annotations: row.annotations ?? {},
    summary: row.summary,
    namespace: row.namespace,
    container: row.container,
    instance: row.instance,
    job: row.job,
    envelopeGroupKey: row.envelope_group_key,
    receiver: row.receiver,
    dedupKey: row.dedup_key,
    identitySource: row.identity_source,
    usedFingerprintFallback: row.used_fingerprint_fallback,
    claimDecision: row.claim_decision as ClaimDecision,
    claimedByRule: row.claimed_by_rule,
    unclaimedReason: row.unclaimed_reason as UnclaimedReason | null,
    incidentId: row.incident_id,
    attempts: Number(row.attempts),
    lastError: row.last_error,
    processedAt: row.processed_at,
  };
}

/** Bind list for the envelope insert, in `INSERT_ENVELOPE_SQL` order. */
function envelopeParams(input: LandEnvelopeInput, alertCount: number): unknown[] {
  const body = input.body ?? {};
  const truncated = Number(body.truncatedAlerts ?? 0);
  return [
    input.source,
    body.receiver ?? null,
    body.status ?? null,
    body.groupKey ?? null,
    body.externalURL ?? null,
    alertCount,
    Number.isFinite(truncated) ? truncated : 0,
    JSON.stringify(body),
    input.remoteAddr ?? null,
    input.signatureVerified,
    input.replayedFrom ?? null,
    PIPELINE_OWNER_SUB,
  ];
}

/** Bind list for the event insert, in `INSERT_EVENT_SQL` order. */
function eventParams(
  envelopeId: string,
  receivedAt: Date,
  source: AlertSource,
  normalized: NormalizedAlertInput,
  envelope: RawAlertmanagerEnvelope,
): unknown[] {
  return [
    envelopeId,
    receivedAt,
    source,
    normalized.fingerprint,
    normalized.alertname,
    normalized.target,
    normalized.targetKind,
    normalized.severity,
    normalized.severityNum,
    normalized.status,
    normalized.startedAt,
    normalized.endedAt,
    normalized.generatorUrl,
    JSON.stringify(normalized.labels),
    JSON.stringify(normalized.annotations),
    normalized.summary,
    normalized.namespace,
    normalized.container,
    normalized.instance,
    normalized.job,
    envelope?.groupKey ?? null,
    envelope?.receiver ?? null,
    PIPELINE_OWNER_SUB,
  ];
}

/**
 * @description The landing stage of the Operations Stream: durable arrival, durable expansion,
 * and the durable intake decision for every event that came out of a delivery.
 */
export class EnvelopeStore {
  constructor(private readonly pool: Pool) {}

  /**
   * @description Stores one webhook delivery and expands it into normalized events inside a
   * SINGLE transaction. An envelope whose events failed to write would claim a delivery was
   * received while none of its alerts exist, so the two are committed together or not at all;
   * on any failure the transaction rolls back and the error propagates, which is what lets the
   * receiving route answer 503 and have the sender redeliver.
   * @param input - The parsed body plus the transport facts only the route can observe.
   * @returns The stored envelope id and every expanded event id, in arrival order.
   */
  async landEnvelope(input: LandEnvelopeInput): Promise<LandEnvelopeResult> {
    const body = input.body ?? {};
    const alerts = Array.isArray(body.alerts) ? body.alerts : [];
    const startedMs = Date.now();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const landed = await client.query(INSERT_ENVELOPE_SQL, envelopeParams(input, alerts.length));
      const envelopeId: string = landed.rows[0].envelope_id;
      const receivedAt: Date = landed.rows[0].received_at;
      const eventIds: string[] = [];
      for (const alert of alerts) {
        const normalized = normalizeAlert(alert, body);
        const params = eventParams(envelopeId, receivedAt, input.source, normalized, body);
        const stored = await client.query(INSERT_EVENT_SQL, params);
        eventIds.push(stored.rows[0].event_id);
      }
      await client.query(
        'UPDATE oshal_alert_envelope SET expanded_count = $1 WHERE envelope_id = $2',
        [eventIds.length, envelopeId],
      );
      await client.query('COMMIT');
      logger.info(
        { envelopeId, source: input.source, alertCount: alerts.length, expanded: eventIds.length, durationMs: Date.now() - startedMs },
        'Landed alert envelope',
      );
      return { envelopeId, eventIds };
    } catch (error) {
      await this.rollback(client, input.source);
      logger.error(
        { err: error, source: input.source, alertCount: alerts.length, durationMs: Date.now() - startedMs },
        'Alert envelope landing failed — nothing was stored, delivery must be retried',
      );
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * @description Claims up to `limit` pending events and runs `handler` over them INSIDE the
   * claiming transaction. `FOR UPDATE SKIP LOCKED` is what lets several pumps drain the same
   * queue without ever handing the same row to two of them, and holding the transaction open
   * across the handler is what makes a crash safe: the rows revert to pending on rollback
   * rather than sitting claimed by a process that no longer exists.
   *
   * The handler receives the transaction client and MUST use it for its own writes — a write
   * issued on the pool would wait on locks this transaction holds and deadlock the pump.
   * @param limit - Maximum events to claim; clamped to a sane batch.
   * @param handler - Work to run over the claimed events, on the claiming connection.
   * @returns How many events were claimed and handed to the handler.
   */
  async withPendingEvents(
    limit: number,
    handler: (events: AlertEventRow[], executor: Queryable) => Promise<void>,
  ): Promise<number> {
    const batch = Math.min(MAX_CLAIM_BATCH, Math.max(1, Math.floor(Number(limit) || 1)));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await client.query(SELECT_PENDING_SQL, [batch]);
      const events = (claimed.rows as AlertEventDbRow[]).map(mapAlertEventRow);
      if (events.length > 0) {
        await handler(events, client);
      }
      await client.query('COMMIT');
      logger.debug({ batch, claimed: events.length }, 'Drained pending alert events');
      return events.length;
    } catch (error) {
      await this.rollback(client, 'claim');
      logger.error({ err: error, batch }, 'Pending-event drain failed — claimed rows returned to pending');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * @description Stamps the durable intake decision on one event. This is the record that makes
   * the funnel and the noise allowlist tunable from evidence rather than from an in-process
   * counter that resets with the api.
   * @param eventId - The event being decided.
   * @param decision - The outcome to record.
   * @param extra - Optional rule, unclaimed reason, and incident linkage.
   * @param executor - Connection to write on; pass the claiming client from `withPendingEvents`.
   * @returns Nothing.
   */
  async decideEvent(
    eventId: string,
    decision: ClaimDecision,
    extra: EventDecisionDetail = {},
    executor: Queryable = this.pool,
  ): Promise<void> {
    try {
      await executor.query(DECIDE_EVENT_SQL, [
        eventId,
        decision,
        extra.claimedByRule ?? null,
        extra.unclaimedReason ?? null,
        extra.incidentId ?? null,
        extra.dedupKey ?? null,
        extra.identitySource ?? null,
        extra.usedFingerprintFallback ?? null,
      ]);
      logger.debug({ eventId, decision, rule: extra.claimedByRule ?? null }, 'Recorded alert event decision');
    } catch (error) {
      logger.error({ err: error, eventId, decision }, 'Failed to record alert event decision');
      throw error;
    }
  }

  /**
   * @description Records one failed processing attempt. Attempts are incremented in the
   * statement itself rather than read-then-written, so two pumps racing the same event cannot
   * both write the same count. On the attempt that reaches {@link MAX_EVENT_ATTEMPTS} the event
   * is stamped `failed` and a `claim`-stage deadletter row is written in the same call: a
   * permanently broken event stops consuming the queue but stays visible and replayable.
   * @param eventId - The event that failed.
   * @param error - The thrown value, stored bounded as `last_error`.
   * @param executor - Connection to write on; pass the claiming client from `withPendingEvents`.
   * @returns Nothing.
   */
  async failEvent(eventId: string, error: unknown, executor: Queryable = this.pool): Promise<void> {
    const description = describeError(error);
    let result;
    try {
      result = await executor.query(FAIL_EVENT_SQL, [eventId, description, MAX_EVENT_ATTEMPTS]);
    } catch (updateError) {
      logger.error({ err: updateError, eventId }, 'Failed to record alert event attempt');
      throw updateError;
    }
    const row = result.rows[0];
    if (!row) {
      logger.warn({ eventId }, 'Attempted to fail an alert event that no longer exists');
      return;
    }
    const attempts = Number(row.attempts);
    logger.warn({ eventId, attempts, exhausted: attempts >= MAX_EVENT_ATTEMPTS }, 'Alert event processing attempt failed');
    if (attempts < MAX_EVENT_ATTEMPTS) {
      return;
    }
    await this.recordDeadletter(
      {
        stage: 'claim',
        eventId,
        failureReason: `claim exhausted after ${attempts} attempts`,
        error: description,
        raw: { eventId, source: row.source, alertname: row.alertname, target: row.target, fingerprint: row.fingerprint },
        attempts,
      },
      executor,
    );
  }

  /**
   * @description Parks an unparseable or unprocessable item. Malformed input is the only
   * evidence an upstream contract changed, so it is never discarded — and because this is the
   * last line of the failure path, a write failure here is logged and rethrown rather than
   * swallowed, which would turn a broken producer into silence.
   * @param entry - What failed, where, and the payload needed to replay it.
   * @param executor - Connection to write on; pass the claiming client when inside a drain.
   * @returns Nothing.
   */
  async recordDeadletter(entry: DeadletterEntry, executor: Queryable = this.pool): Promise<void> {
    const errorText = entry.error === undefined || entry.error === null ? null : describeError(entry.error);
    try {
      await executor.query(INSERT_DEADLETTER_SQL, [
        entry.stage,
        entry.envelopeId ?? null,
        entry.eventId ?? null,
        truncate(entry.failureReason, LAST_ERROR_MAX_LENGTH),
        errorText,
        JSON.stringify(entry.raw ?? null),
        Math.max(0, Math.floor(Number(entry.attempts ?? 0)) || 0),
        PIPELINE_OWNER_SUB,
      ]);
      logger.warn(
        { stage: entry.stage, envelopeId: entry.envelopeId ?? null, eventId: entry.eventId ?? null, failureReason: entry.failureReason },
        'Parked alert pipeline item in the deadletter',
      );
    } catch (writeError) {
      logger.error({ err: writeError, stage: entry.stage, eventId: entry.eventId ?? null }, 'Deadletter write failed');
      throw writeError;
    }
  }

  /**
   * @description Aborts an open transaction, keeping the original failure as the thrown error.
   * A rollback that itself fails is logged rather than raised, because replacing the cause with
   * the cleanup error is how a diagnosable failure becomes an unexplained one.
   * @param client - The transaction's connection.
   * @param context - Lane or stage label for the log line.
   * @returns Nothing.
   */
  private async rollback(client: PoolClient, context: string): Promise<void> {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      logger.error({ err: rollbackError, context }, 'Alert pipeline rollback failed');
    }
  }
}
