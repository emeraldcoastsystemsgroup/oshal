/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The Operations Stream operator API (/api/ops/alert-pipeline): live scrape + firing state traced through the pipeline, the funnel and its trend, incident read models, the autonomy ladder, and the operator-gated surfaces — transactional claim-rule reconcile with save-time validation, rule/identity preview, the topology mirror, the intake gap, the deadletter and a bounded replay. Reads are requiresAuth; anything that mutates state or exposes routing internals additionally chains requiresOperator ON THE ROUTE, so a re-mount cannot drop the gate.
 */

/**
 * The surface an operator uses to answer "is the pipeline actually working", which threshold
 * alerting structurally cannot: a dead pipeline emits no data, and no rule fires on an absence.
 *
 * Two upstreams feed it and they fail differently. Postgres holds the durable pipeline state; if it
 * is unreadable the request fails loudly, because a fabricated zero is indistinguishable from a
 * genuinely quiet hour. Prometheus holds the live scrape and firing state; if it is unreachable the
 * screen still renders with an empty target list and an alarm that says so, because one upstream
 * being down must not blank the other nine panels — and no target row is ever invented to fill the
 * gap.
 *
 * @module ops-pipeline-routes
 */

import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { getCaller, requiresOperator } from '@/shared/middleware/authz';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import {
  DEFAULT_IDENTITY_FIELDS,
  DEPLOYMENT_ID_ENV,
  DispatchLog,
  EnvelopeStore,
  FUNNEL_STAGES,
  FunnelStats,
  IncidentStore,
  TopologyStore,
  ensureAlertPipelineSchema,
  hasUsableIdentity,
  mapAlertEventRow,
  normalizeAlert,
  renderDedupKey,
  renderIdentitySource,
  resolveDeploymentId,
  type AbsenceAlarm,
  type AlertEventDbRow,
  type AlertEventRow,
  type ClaimRuleRow,
  type ConsolidationOutcome,
  type FunnelStage,
  type IncidentState,
  type Queryable,
  type RawAlertmanagerEnvelope,
  type TopologyEdgeRow,
  type TopologyNodeRow,
} from '@/features/alert-pipeline';
import {
  autoApplyEnabled,
  autoApplyHourlyCap,
  autoApplyVerifyTimeoutSeconds,
  autoResolveEnabled,
  consolidationTtlSeconds,
  correlationDepth,
  correlationWindowSeconds,
  flapQuietSeconds,
  flapThreshold,
  flapWindowSeconds,
  maxIncidentMembers,
  rcaHourlyBudgetUsd,
  unclaimedPolicy,
} from '@/features/alert-triage';
import {
  matchesPredicate,
  selectClaimingRules,
  validateClaimRuleSet,
  type ClaimRuleDraft,
  type MatchableEvent,
} from './ops-pipeline-rule-validation';

const logger = createChildLogger({ module: 'ops-pipeline-routes' });

/**
 * @description Ceiling on how many stored envelopes one time-range replay may re-run. A replay
 * re-lands every alert it touches, so an unbounded range is a self-inflicted alert storm that also
 * holds a transaction open across the whole batch. Over the cap the request replays the oldest
 * `MAX_REPLAY_ENVELOPES` in the range and REPORTS how many it left behind, because a truncation the
 * caller cannot see is how "I replayed that window" becomes false.
 */
export const MAX_REPLAY_ENVELOPES = 200;

/** Ceiling on nodes plus edges in one topology write, so one request cannot rewrite the estate. */
export const MAX_TOPOLOGY_UPSERT = 1000;

/** Default Prometheus base URL on the compose network. */
const DEFAULT_PROMETHEUS_URL = 'http://oshal-local-prometheus:9090';

/** Ceiling on a Prometheus call. The screen renders without it rather than waiting on it. */
const PROMETHEUS_TIMEOUT_MS = 4000;

/** Trailing window the firing-alert trace looks back over for a matching event row. */
const HEALTH_TRACE_WINDOW_MINUTES = 60;

/** The sliding hour the autonomy ladder's cap and parking counts are measured over. */
const LADDER_WINDOW_MINUTES = 60;

/** The dispatch ledger's retention, so a suppression history read covers everything stored. */
const DISPATCH_LOOKBACK_MINUTES = 180 * 24 * 60;

const DEFAULT_WINDOW_MINUTES = 60;
const MAX_WINDOW_MINUTES = 7 * 24 * 60;
const DEFAULT_TREND_HOURS = 24;
const MAX_TREND_HOURS = 90 * 24;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const MAX_INCIDENT_EVENTS = 200;
const MAX_INCIDENT_SNAPSHOTS = 20;
const MAX_LOADER_RUNS = 20;
const TOPOLOGY_PAGE_LIMIT = 2000;

/** Incident lifecycle vocabulary, for validating the `state` filter before it reaches SQL. */
const INCIDENT_STATES: readonly IncidentState[] = ['open', 'resolved', 'closed', 'archived'];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Incident columns aliased to the contract's camelCase. `bigint` counters are cast to `int` so they
 * arrive as JSON numbers rather than the strings the driver returns for 64-bit values.
 */
const INCIDENT_SELECT = `
  SELECT incident_id AS "incidentId", dedup_key AS "dedupKey", identity_source AS "identitySource",
         incident_label AS "incidentLabel", instance_seq::int AS "instanceSeq", state,
         primary_alertname AS "primaryAlertname", primary_target AS "primaryTarget",
         claim_rule_id AS "claimRuleId", severity, severity_num::int AS "severityNum", priority,
         first_seen AS "firstSeen", last_seen AS "lastSeen",
         occurrence_count::int AS "occurrenceCount", member_count::int AS "memberCount",
         members_overflow::int AS "membersOverflow", reopen_count::int AS "reopenCount",
         reopened_at AS "reopenedAt", resolved_at AS "resolvedAt", closed_at AS "closedAt",
         closed_by AS "closedBy", recurrence_of AS "recurrenceOf",
         correlation_group_id AS "correlationGroupId", correlation_engine AS "correlationEngine",
         correlation_depth::int AS "correlationDepth", correlation_version AS "correlationVersion",
         root_candidate_target AS "rootCandidateTarget", root_candidate_reason AS "rootCandidateReason",
         root_candidate_ambiguous AS "rootCandidateAmbiguous", intake_status AS "intakeStatus",
         flags, flap_parked AS "flapParked", ticket_id AS "ticketId", revision::int AS revision
    FROM oshal_incident`;

/** Claim rules in evaluation order: lower priority first, rule id as the deterministic tiebreak. */
const CLAIM_RULE_SELECT = `
  SELECT rule_id AS "ruleId", enabled, priority::int AS priority,
         match_predicate AS "matchPredicate", identity_fields AS "identityFields",
         dedup_ttl_seconds::int AS "dedupTtlSeconds", reopen_window_seconds::int AS "reopenWindowSeconds",
         intake, autonomy_level AS "autonomyLevel", root_filter AS "rootFilter",
         correlation_depth::int AS "correlationDepth", predicate_hash AS "predicateHash",
         notes, updated_at AS "updatedAt", updated_by AS "updatedBy"
    FROM oshal_alert_claim_rule
   ORDER BY priority ASC, rule_id ASC`;

const UPSERT_RULE_SQL = `
  INSERT INTO oshal_alert_claim_rule (
    rule_id, enabled, priority, match_predicate, identity_fields, dedup_ttl_seconds,
    reopen_window_seconds, intake, autonomy_level, root_filter, correlation_depth,
    predicate_hash, notes, updated_at, updated_by
  ) VALUES ($1,$2,$3,$4::jsonb,$5::text[],$6,$7,$8,$9,$10::text[],$11,$12,$13,now(),$14)
  ON CONFLICT (rule_id) DO UPDATE SET
    enabled = EXCLUDED.enabled, priority = EXCLUDED.priority,
    match_predicate = EXCLUDED.match_predicate, identity_fields = EXCLUDED.identity_fields,
    dedup_ttl_seconds = EXCLUDED.dedup_ttl_seconds,
    reopen_window_seconds = EXCLUDED.reopen_window_seconds,
    intake = EXCLUDED.intake, autonomy_level = EXCLUDED.autonomy_level,
    root_filter = EXCLUDED.root_filter, correlation_depth = EXCLUDED.correlation_depth,
    predicate_hash = EXCLUDED.predicate_hash, notes = EXCLUDED.notes,
    updated_at = now(), updated_by = EXCLUDED.updated_by`;

/**
 * Matches each firing Prometheus alert to the most recent event row that carries the same
 * (alertname, target). `WITH ORDINALITY` keeps the answers aligned with the alerts that asked, so
 * two alerts sharing an identity cannot swap traces.
 */
const TRACE_SQL = `
  SELECT DISTINCT ON (q.ord)
         q.ord::int AS ord, e.event_id AS "eventId", e.target AS target,
         e.claimed_by_rule AS "claimedByRule", e.incident_id AS "incidentId",
         i.ticket_id AS "ticketId"
    FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS q(alertname, target, ord)
    LEFT JOIN oshal_alert_event e
      ON e.alertname = q.alertname AND e.target = q.target
     AND e.received_at > now() - make_interval(mins => $3)
    LEFT JOIN oshal_incident i ON i.incident_id = e.incident_id
   ORDER BY q.ord, e.received_at DESC NULLS LAST`;

/** @description Dependencies the router needs. Mirrors the factory pattern used across this directory. */
export interface OpsPipelineRoutesDeps {
  /** Postgres pool. Identity-stamped by the GUC wrapper, so RLS scopes every read to the caller. */
  pool: Pool;
  /** OIDC auth middleware from the server, passed in rather than imported. */
  requiresAuth: RequestHandler;
}

/** The stores one router instance shares across its handlers. */
interface OpsPipelineContext {
  pool: Pool;
  envelopes: EnvelopeStore;
  incidents: IncidentStore;
  dispatch: DispatchLog;
  topology: TopologyStore;
  funnel: FunnelStats;
}

/** The auth middleware and the logging wrapper every route is registered through. */
interface RouteGate {
  requiresAuth: RequestHandler;
  handle: (name: string, fn: (req: Request, res: Response) => Promise<void>) => RequestHandler;
}

/** One scrape target as the health screen reports it. */
interface HealthTarget {
  job: string;
  instance: string;
  tier: string | null;
  up: boolean;
  lastScrapeAgeSec: number | null;
}

/** What Prometheus answered, plus any alarm raised by failing to reach it. */
interface PrometheusSnapshot {
  targets: HealthTarget[];
  alerts: Array<{ labels: Record<string, string>; annotations?: Record<string, string>; activeAt?: string }>;
  alarms: AbsenceAlarm[];
}

/** One firing alert and how far it got through the pipeline. */
interface FiringAlertTrace {
  alertname: string;
  target: string;
  severity: string;
  startedAt: string | null;
  pipeline: {
    landed: boolean;
    normalized: boolean;
    claimedByRule: unknown;
    incidentId: unknown;
    ticketId: unknown;
  };
}

/** One configuration knob and where its effective value came from. */
interface ConfigKnob {
  key: string;
  effective: unknown;
  source: 'default' | 'env' | 'rule';
}

/**
 * @description Resolves the Prometheus base URL for this process, read per call so a container
 * restarted with a corrected value takes effect without a rebuild.
 * @returns The base URL with any trailing slash removed.
 */
function prometheusBaseUrl(): string {
  return (process.env.PROMETHEUS_URL || DEFAULT_PROMETHEUS_URL).replace(/\/$/, '');
}

/**
 * @description Reads one Prometheus HTTP API endpoint under a hard timeout.
 * @param path - API path beginning with a slash.
 * @returns The `data` member of the envelope.
 */
async function promGet<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROMETHEUS_TIMEOUT_MS);
  try {
    const response = await fetch(`${prometheusBaseUrl()}${path}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`prometheus answered HTTP ${response.status} for ${path}`);
    }
    const body = (await response.json()) as { status?: string; data?: T; error?: string };
    if (body.status !== 'success' || body.data === undefined) {
      throw new Error(body.error || `prometheus answered without data for ${path}`);
    }
    return body.data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @description Converts Prometheus' active-target list into the health contract. `tier` is a target
 * label rather than a derived value, so a target that does not declare one reports null instead of
 * being sorted into a tier nobody assigned it.
 * @param raw - The `activeTargets` array.
 * @returns One row per target.
 */
function mapTargets(raw: unknown[]): HealthTarget[] {
  const now = Date.now();
  return raw.map((entry) => {
    const target = entry as { labels?: Record<string, string>; health?: string; lastScrape?: string };
    const labels = target.labels ?? {};
    const scrapedMs = Date.parse(String(target.lastScrape ?? ''));
    return {
      job: labels.job ?? '',
      instance: labels.instance ?? '',
      tier: labels.tier ?? null,
      up: target.health === 'up',
      lastScrapeAgeSec: Number.isFinite(scrapedMs) ? Math.max(0, Math.round((now - scrapedMs) / 1000)) : null,
    };
  });
}

/**
 * @description Reads the live scrape and firing state. A failure here is reported as an alarm and
 * empty lists — never as invented rows, and never as a failure of the whole health screen.
 * @returns Targets, firing alerts, and the alarms raised while reading them.
 */
async function readPrometheusSnapshot(): Promise<PrometheusSnapshot> {
  try {
    const [targets, alerts] = await Promise.all([
      promGet<{ activeTargets?: unknown[] }>('/api/v1/targets?state=any'),
      promGet<{ alerts?: Array<{ state?: string; labels?: Record<string, string>; annotations?: Record<string, string>; activeAt?: string }> }>('/api/v1/alerts'),
    ]);
    return {
      targets: mapTargets(targets.activeTargets ?? []),
      alerts: (alerts.alerts ?? [])
        .filter((alert) => alert.state === 'firing')
        .map((alert) => ({ labels: alert.labels ?? {}, annotations: alert.annotations, activeAt: alert.activeAt })),
      alarms: [],
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, base: prometheusBaseUrl() }, 'Prometheus is unreachable — reporting no targets and an alarm');
    return {
      targets: [],
      alerts: [],
      alarms: [{
        id: 'prometheus-unreachable',
        firing: true,
        detail: `${prometheusBaseUrl()} did not answer (${detail}) — scrape and firing state are UNKNOWN, not clear`,
      }],
    };
  }
}

/**
 * @description Traces each firing alert through the pipeline. The alert is normalized with the same
 * function the intake uses, so the identity being looked up is the identity the pipeline would have
 * written — a second target ladder here would drift and report a healthy trace for an alert the
 * pipeline never saw.
 *
 * `landed` means a normalized event row exists for that identity in the trace window. `normalized`
 * means that row carries a usable identity; a row with no resolvable target landed but can never be
 * consolidated, and the two states must not look the same.
 * @param pool - Postgres pool.
 * @param alerts - Firing alerts from Prometheus.
 * @returns One entry per firing alert, with its pipeline trace.
 */
async function traceFiringAlerts(pool: Pool, alerts: PrometheusSnapshot['alerts']): Promise<FiringAlertTrace[]> {
  const normalized = alerts.map((alert) =>
    normalizeAlert({ status: 'firing', labels: alert.labels, annotations: alert.annotations, startsAt: alert.activeAt }, {}));
  if (normalized.length === 0) return [];
  const result = await pool.query(TRACE_SQL, [
    normalized.map((entry) => entry.alertname),
    normalized.map((entry) => entry.target),
    HEALTH_TRACE_WINDOW_MINUTES,
  ]);
  const traced = new Map<number, Record<string, unknown>>();
  for (const row of result.rows as Array<Record<string, unknown>>) {
    traced.set(Number(row.ord), row);
  }
  return normalized.map((entry, index) => {
    const row = traced.get(index + 1);
    const eventId = row?.eventId ?? null;
    return {
      alertname: entry.alertname,
      target: entry.target,
      severity: entry.severity,
      startedAt: entry.startedAt ? entry.startedAt.toISOString() : null,
      pipeline: {
        landed: eventId !== null,
        normalized: eventId !== null && entry.alertname !== '' && String(row?.target ?? '') !== '',
        claimedByRule: row?.claimedByRule ?? null,
        incidentId: row?.incidentId ?? null,
        ticketId: row?.ticketId ?? null,
      },
    };
  });
}

/**
 * @description Reads a bounded positive integer from a query string.
 * @param raw - The raw query value.
 * @param fallback - Value used when absent or unparseable.
 * @param min - Inclusive floor.
 * @param max - Inclusive ceiling.
 * @returns The clamped value.
 */
function parseBounded(raw: unknown, fallback: number, min: number, max: number): number {
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * @description Reads a JSON object body.
 * @param req - The request.
 * @returns The body as a map, or null when it is absent or not an object.
 */
function readObjectBody(req: Request): Record<string, unknown> | null {
  const body = req.body as unknown;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

/**
 * @description Reads a list of non-empty strings.
 * @param value - Candidate value.
 * @returns The trimmed entries, or null when the value is not a string array.
 */
function readStrings(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return null;
  const entries = value.map((entry) => (entry as string).trim()).filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries : null;
}

/**
 * @description Reads a string map, dropping non-string values rather than failing the request —
 * a producer sending a number where a label belongs is a contract mismatch the preview should show,
 * not a reason to refuse to answer.
 * @param value - Candidate value.
 * @returns The string entries, or null when the value is not an object.
 */
function readLabelMap(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const labels: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') labels[key] = entry;
  }
  return labels;
}

/**
 * @description The request facts safe to log: paths, route params, bounded query values and the
 * NAMES of body fields. Body values are never logged — a rule body carries operator-authored
 * matchers and a replay body carries identifiers, and neither belongs in a log line.
 * @param req - The request.
 * @returns The sanitized log context.
 */
function sanitizedParams(req: Request): Record<string, unknown> {
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === 'string') query[key] = value.slice(0, 120);
  }
  const body = req.body as unknown;
  return {
    path: req.path,
    params: req.params,
    query,
    bodyKeys: body && typeof body === 'object' ? Object.keys(body as object).slice(0, 20) : [],
  };
}

/**
 * @description Loads the claim rules in evaluation order.
 * @param pool - Postgres pool.
 * @returns Every stored rule, lowest priority number first.
 */
async function loadClaimRules(pool: Pool): Promise<ClaimRuleRow[]> {
  const result = await pool.query(CLAIM_RULE_SELECT);
  return result.rows as ClaimRuleRow[];
}

/**
 * @description Bind list for one rule upsert, in `UPSERT_RULE_SQL` order.
 * @param rule - The validated draft.
 * @param updatedBy - The acting operator, taken from the session and never from the body.
 * @returns The bind values.
 */
function ruleParams(rule: ClaimRuleDraft, updatedBy: string): unknown[] {
  return [
    rule.ruleId, rule.enabled, rule.priority, JSON.stringify(rule.matchPredicate), rule.identityFields,
    rule.dedupTtlSeconds, rule.reopenWindowSeconds, rule.intake, rule.autonomyLevel, rule.rootFilter,
    rule.correlationDepth, rule.predicateHash, rule.notes, updatedBy,
  ];
}

/**
 * @description Reconciles the stored rule set to exactly the submitted one, in ONE transaction:
 * every submitted rule is upserted and every rule_id absent from the submission is deleted. A
 * skip-if-exists save would leave an edited rule at its old predicate while the screen showed the
 * new one, and a delete outside the transaction would leave a window where a lane is claimed by
 * nothing at all.
 * @param pool - Postgres pool.
 * @param rules - The validated rule set to become the whole table.
 * @param updatedBy - The acting operator.
 * @returns How many rules were written and which rule ids were removed.
 */
async function reconcileClaimRules(
  pool: Pool,
  rules: ClaimRuleDraft[],
  updatedBy: string,
): Promise<{ saved: number; removed: string[] }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const rule of rules) {
      await client.query(UPSERT_RULE_SQL, ruleParams(rule, updatedBy));
    }
    const removed = await client.query(
      'DELETE FROM oshal_alert_claim_rule WHERE NOT (rule_id = ANY($1::text[])) RETURNING rule_id',
      [rules.map((rule) => rule.ruleId)],
    );
    await client.query('COMMIT');
    return { saved: rules.length, removed: removed.rows.map((row) => String(row.rule_id)) };
  } catch (error) {
    await client.query('ROLLBACK').catch((rollbackError: unknown) => {
      logger.error({ err: rollbackError }, 'Claim-rule reconcile rollback failed');
    });
    logger.error({ err: error, submitted: rules.length, updatedBy }, 'Claim-rule reconcile failed — nothing was written');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * @description Maps a consolidation outcome to the durable claim decision it represents.
 * @param outcome - What consolidation did.
 * @returns The decision to stamp on the event.
 */
function decisionFor(outcome: ConsolidationOutcome): 'created' | 'reopened' | 'consolidated' {
  if (outcome.wasReopened) return 'reopened';
  return outcome.wasCreated || outcome.wasRecurrence ? 'created' : 'consolidated';
}

/**
 * @description Records why nothing claimed an event. A coverage gap and a rule someone switched off
 * need different fixes, so they are stored as different reasons rather than as one "unclaimed".
 * @param ctx - The stores.
 * @param rules - Claim rules in evaluation order.
 * @param event - The unclaimed event.
 * @param executor - The claiming transaction's connection.
 * @returns Nothing.
 */
async function decideUnclaimed(
  ctx: OpsPipelineContext,
  rules: ClaimRuleRow[],
  event: AlertEventRow,
  executor: Queryable,
): Promise<void> {
  const disabled = rules.some((rule) => !rule.enabled && matchesPredicate(rule.matchPredicate ?? {}, event));
  await ctx.envelopes.decideEvent(
    event.eventId,
    'noise',
    { unclaimedReason: disabled ? 'rule_disabled' : 'no_rule_match' },
    executor,
  );
}

/**
 * @description Runs one pending event through the claim stage: identity gate, rule selection,
 * identity rendering, consolidation, membership and the durable decision. An empty rule table means
 * UNCONFIGURED and admits everything, which is why the unclaimed branch requires rules to exist.
 * @param ctx - The stores.
 * @param rules - Claim rules in evaluation order.
 * @param deploymentId - Suppression namespace for the dedup key.
 * @param event - The pending event.
 * @param executor - The claiming transaction's connection; every event write must use it.
 * @returns Nothing.
 */
async function claimOneEvent(
  ctx: OpsPipelineContext,
  rules: ClaimRuleRow[],
  deploymentId: string,
  event: AlertEventRow,
  executor: Queryable,
): Promise<void> {
  if (!hasUsableIdentity(event)) {
    await ctx.envelopes.decideEvent(event.eventId, 'dropped', { unclaimedReason: 'no_identity' }, executor);
    return;
  }
  const { claimedBy } = selectClaimingRules(rules, event);
  if (!claimedBy && rules.length > 0) {
    await decideUnclaimed(ctx, rules, event, executor);
    return;
  }
  const fields = claimedBy && claimedBy.identityFields.length > 0 ? claimedBy.identityFields : DEFAULT_IDENTITY_FIELDS;
  const dedupKey = renderDedupKey(event, fields, deploymentId);
  const identitySource = renderIdentitySource(event, fields);
  await executor.query('UPDATE oshal_alert_event SET dedup_key = $2, identity_source = $3 WHERE event_id = $1', [
    event.eventId, dedupKey, identitySource,
  ]);
  const outcome = await ctx.incidents.consolidate({ ...event, dedupKey, identitySource }, {
    reopenWindowSeconds: claimedBy?.reopenWindowSeconds ?? consolidationTtlSeconds(),
    claimRuleId: claimedBy?.ruleId ?? null,
    intakeStatus: claimedBy?.intake === 'auto' ? 'auto' : 'backlog',
  });
  await ctx.incidents.upsertMember(outcome.incident.incidentId, {
    memberKey: renderIdentitySource(event, DEFAULT_IDENTITY_FIELDS),
    alertname: event.alertname,
    target: event.target,
    severity: event.severity,
    severityNum: event.severityNum,
    fingerprint: event.fingerprint || null,
    seenAt: event.receivedAt,
    attachReason: outcome.wasCreated ? 'genesis' : 'same-key',
  });
  await ctx.envelopes.decideEvent(event.eventId, decisionFor(outcome), {
    claimedByRule: claimedBy?.ruleId ?? null,
    incidentId: outcome.incident.incidentId,
  }, executor);
}

/**
 * @description Drains pending events through the claim stage. Idempotent by construction: the
 * identity is derived from the event, and consolidation upserts on the live-incident unique index,
 * so replaying the same alert bubbles the same incident instead of opening a second one.
 * @param ctx - The stores.
 * @param limit - Maximum events to claim in this pass.
 * @returns How many events were decided.
 */
async function claimPendingEvents(ctx: OpsPipelineContext, limit: number): Promise<number> {
  if (limit <= 0) return 0;
  const rules = await loadClaimRules(ctx.pool);
  const deploymentId = resolveDeploymentId();
  let claimed = 0;
  await ctx.envelopes.withPendingEvents(limit, async (events, executor) => {
    for (const event of events) {
      try {
        await claimOneEvent(ctx, rules, deploymentId, event, executor);
        claimed += 1;
      } catch (error) {
        logger.error({ err: error, eventId: event.eventId }, 'Replay claim failed for one event');
        await ctx.envelopes.failEvent(event.eventId, error, executor);
      }
    }
  });
  return claimed;
}

/** What a replay request resolved to, or why it could not be resolved. */
type ReplayPlan =
  | { ok: true; envelopeIds: string[]; skipped: number; deadletterId: string | null }
  | { ok: false; status: number; error: string };

/**
 * @description Resolves a replay request to the envelopes it will re-run. A time range is capped at
 * {@link MAX_REPLAY_ENVELOPES} and the overflow is counted so the response can say how many were
 * left behind rather than silently truncating the window.
 * @param pool - Postgres pool.
 * @param body - The request body.
 * @returns The plan, or the refusal with its HTTP status.
 */
async function planReplay(pool: Pool, body: Record<string, unknown>): Promise<ReplayPlan> {
  const envelopeId = String(body.envelopeId ?? '').trim();
  if (envelopeId.length > 0) {
    if (!UUID_PATTERN.test(envelopeId)) return { ok: false, status: 400, error: 'envelopeId must be a UUID' };
    const found = await pool.query('SELECT envelope_id FROM oshal_alert_envelope WHERE envelope_id = $1', [envelopeId]);
    if (found.rows.length === 0) return { ok: false, status: 404, error: 'no such envelope' };
    return { ok: true, envelopeIds: [envelopeId], skipped: 0, deadletterId: null };
  }
  const deadletterId = String(body.deadletterId ?? '').trim();
  if (deadletterId.length > 0) {
    if (!/^\d{1,19}$/.test(deadletterId)) return { ok: false, status: 400, error: 'deadletterId must be a positive integer' };
    const row = await pool.query('SELECT envelope_id FROM oshal_alert_deadletter WHERE deadletter_id = $1', [deadletterId]);
    if (row.rows.length === 0) return { ok: false, status: 404, error: 'no such deadletter row' };
    const parked = row.rows[0].envelope_id as string | null;
    if (!parked) return { ok: false, status: 400, error: 'that deadletter row carries no envelope, so there is nothing to re-run' };
    return { ok: true, envelopeIds: [parked], skipped: 0, deadletterId };
  }
  return planRangeReplay(pool, body);
}

/**
 * @description Resolves the time-range form of a replay.
 * @param pool - Postgres pool.
 * @param body - The request body carrying `fromIso` and `toIso`.
 * @returns The bounded plan, or the refusal.
 */
async function planRangeReplay(pool: Pool, body: Record<string, unknown>): Promise<ReplayPlan> {
  const fromMs = Date.parse(String(body.fromIso ?? ''));
  const toMs = Date.parse(String(body.toIso ?? ''));
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return { ok: false, status: 400, error: 'supply envelopeId, deadletterId, or both fromIso and toIso' };
  }
  if (fromMs >= toMs) {
    return { ok: false, status: 400, error: 'fromIso must be earlier than toIso' };
  }
  const result = await pool.query(
    `SELECT envelope_id,
            COUNT(*) OVER ()::int AS matching
       FROM oshal_alert_envelope
      WHERE received_at >= $1 AND received_at <= $2
      ORDER BY received_at ASC
      LIMIT $3`,
    [new Date(fromMs), new Date(toMs), MAX_REPLAY_ENVELOPES],
  );
  const matching = result.rows.length > 0 ? Number(result.rows[0].matching) : 0;
  return {
    ok: true,
    envelopeIds: result.rows.map((row) => String(row.envelope_id)),
    skipped: Math.max(0, matching - result.rows.length),
    deadletterId: null,
  };
}

/**
 * @description Re-lands every planned envelope from its stored body and re-runs the claim stage over
 * what that produced. The body is stored verbatim at landing precisely so this is possible: a
 * normalization fix is a replay, not lost data.
 * @param ctx - The stores.
 * @param plan - The resolved plan.
 * @returns Counts for the response.
 */
async function runReplay(
  ctx: OpsPipelineContext,
  plan: Extract<ReplayPlan, { ok: true }>,
): Promise<{ envelopes: number; events: number; claimed: number }> {
  let envelopes = 0;
  let events = 0;
  for (const envelopeId of plan.envelopeIds) {
    const stored = await ctx.pool.query(
      'SELECT body, source, signature_verified FROM oshal_alert_envelope WHERE envelope_id = $1',
      [envelopeId],
    );
    const row = stored.rows[0];
    if (!row) continue;
    const landed = await ctx.envelopes.landEnvelope({
      body: row.body as RawAlertmanagerEnvelope,
      source: String(row.source),
      signatureVerified: row.signature_verified === true,
      replayedFrom: envelopeId,
    });
    envelopes += 1;
    events += landed.eventIds.length;
  }
  const claimed = await claimPendingEvents(ctx, events);
  if (plan.deadletterId) {
    await ctx.pool.query('UPDATE oshal_alert_deadletter SET replayed_at = now() WHERE deadletter_id = $1', [plan.deadletterId]);
  }
  return { envelopes, events, claimed };
}

/**
 * @description Reads a topology node list from a request body, forcing `loader_tag = 'operator'` so
 * an operator write can never claim another loader's slice and be swept by it.
 * @param raw - The submitted nodes.
 * @returns The rows to upsert, or null when the shape is wrong.
 */
function readTopologyNodes(raw: unknown): TopologyNodeRow[] | null {
  if (!Array.isArray(raw)) return null;
  const nodes: TopologyNodeRow[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    const node = entry as Record<string, unknown>;
    const nodeKey = String(node.nodeKey ?? '').trim();
    if (nodeKey.length === 0) return null;
    const status = String(node.status ?? 'active');
    nodes.push({
      nodeKey,
      displayName: node.displayName === undefined || node.displayName === null ? null : String(node.displayName),
      kinds: readStrings(node.kinds) ?? [],
      traverseVia: readStrings(node.traverseVia),
      // Transit defaults to allowed: marking a node a hub stops the walk expanding through it, so
      // an omitted flag must mean "ordinary node", never "silently stop correlating here".
      transitAllowed: node.transitAllowed !== false,
      status: status === 'decommissioned' ? 'decommissioned' : 'active',
      props: (node.props && typeof node.props === 'object' && !Array.isArray(node.props)
        ? node.props : {}) as Record<string, unknown>,
      loaderTag: 'operator',
      loaderScope: String(node.loaderScope ?? ''),
    });
  }
  return nodes;
}

/**
 * @description Reads a topology edge list from a request body under the operator loader tag.
 * @param raw - The submitted edges.
 * @returns The rows to upsert, or null when the shape is wrong.
 */
function readTopologyEdges(raw: unknown): TopologyEdgeRow[] | null {
  if (!Array.isArray(raw)) return null;
  const edges: TopologyEdgeRow[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    const edge = entry as Record<string, unknown>;
    const srcKey = String(edge.srcKey ?? '').trim();
    const dstKey = String(edge.dstKey ?? '').trim();
    if (srcKey.length === 0 || dstKey.length === 0) return null;
    edges.push({
      srcKey,
      dstKey,
      edgeType: String(edge.edgeType ?? 'depends_on').trim() || 'depends_on',
      directionCertified: edge.directionCertified === true,
      attrs: (edge.attrs && typeof edge.attrs === 'object' && !Array.isArray(edge.attrs)
        ? edge.attrs : {}) as Record<string, unknown>,
      loaderTag: 'operator',
      loaderScope: String(edge.loaderScope ?? ''),
    });
  }
  return edges;
}

/**
 * @description Builds one knob report. A rule override outranks the environment because a rule wins
 * at match time; naming the env value as effective while a rule quietly overrides it is how a knob
 * gets tuned for hours with no effect.
 * @param key - The environment variable that configures it.
 * @param effective - The value in force right now.
 * @param ruleOverrides - How many enabled rules override it.
 * @returns The knob report.
 */
function knob(key: string, effective: unknown, ruleOverrides = 0): ConfigKnob {
  if (ruleOverrides > 0) return { key, effective, source: 'rule' };
  const raw = String(process.env[key] ?? '').trim();
  return { key, effective, source: raw.length > 0 ? 'env' : 'default' };
}

/**
 * @description Every knob the pipeline reads, with its effective value and where that value came
 * from. Values are read through the same functions the pipeline itself calls, so this reports what
 * is in force rather than a second interpretation of the environment.
 * @param overrides - Counts of enabled rules overriding each rule-overridable knob.
 * @returns The knob list.
 */
function buildConfigKnobs(overrides: Record<string, number>): ConfigKnob[] {
  return [
    knob(DEPLOYMENT_ID_ENV, resolveDeploymentId()),
    knob('PROMETHEUS_URL', prometheusBaseUrl()),
    knob('ALERT_CONSOLIDATION_TTL', consolidationTtlSeconds(), overrides.dedupTtl),
    knob('ALERT_CORRELATION_WINDOW', correlationWindowSeconds()),
    knob('ALERT_CORRELATION_DEPTH', correlationDepth(), overrides.correlationDepth),
    knob('ALERT_MAX_MEMBERS', maxIncidentMembers()),
    knob('ALERT_UNCLAIMED_POLICY', unclaimedPolicy(), overrides.intake),
    knob('ALERT_RCA_HOURLY_BUDGET_USD', rcaHourlyBudgetUsd()),
    knob('ALERT_FLAP_THRESHOLD', flapThreshold()),
    knob('ALERT_FLAP_WINDOW', flapWindowSeconds()),
    knob('ALERT_FLAP_QUIET', flapQuietSeconds()),
    knob('ALERT_AUTO_RESOLVE', autoResolveEnabled()),
    knob('SELF_HEAL_AUTO_APPLY', autoApplyEnabled(), overrides.autonomy),
    knob('SELF_HEAL_APPLY_HOURLY_CAP', autoApplyHourlyCap()),
    knob('SELF_HEAL_VERIFY_TIMEOUT', autoApplyVerifyTimeoutSeconds()),
  ];
}

/**
 * @description Scrape targets, firing alerts traced through the pipeline, and the absence alarms.
 * @param ctx - The stores.
 * @param _req - The request.
 * @param res - The response.
 * @returns Nothing.
 */
async function getHealth(ctx: OpsPipelineContext, _req: Request, res: Response): Promise<void> {
  const [snapshot, alarms] = await Promise.all([readPrometheusSnapshot(), ctx.funnel.absenceAlarms()]);
  const firing = await traceFiringAlerts(ctx.pool, snapshot.alerts);
  res.json({ targets: snapshot.targets, firing, alarms: [...alarms, ...snapshot.alarms] });
}

/**
 * @description The live funnel and the three dispatch counters over the same window.
 * @param ctx - The stores.
 * @param req - The request; `windowMinutes` selects the trailing window.
 * @param res - The response.
 * @returns Nothing.
 */
async function getFunnel(ctx: OpsPipelineContext, req: Request, res: Response): Promise<void> {
  const windowMinutes = parseBounded(req.query.windowMinutes, DEFAULT_WINDOW_MINUTES, 1, MAX_WINDOW_MINUTES);
  const [points, counters] = await Promise.all([
    ctx.funnel.currentFunnel(windowMinutes),
    ctx.funnel.countersSummary(windowMinutes),
  ]);
  res.json({ points, counters });
}

/**
 * @description One funnel stage's captured history, per lane.
 * @param ctx - The stores.
 * @param req - The request; `stage` and `hours`.
 * @param res - The response.
 * @returns Nothing.
 */
async function getTrend(ctx: OpsPipelineContext, req: Request, res: Response): Promise<void> {
  const stage = String(req.query.stage ?? '') as FunnelStage;
  if (!FUNNEL_STAGES.includes(stage)) {
    res.status(400).json({ error: 'unknown funnel stage', stages: FUNNEL_STAGES });
    return;
  }
  const hours = parseBounded(req.query.hours, DEFAULT_TREND_HOURS, 1, MAX_TREND_HOURS);
  res.json({ points: await ctx.funnel.trend(stage, hours) });
}

/**
 * @description Incidents worst-first: most severe by ordinal, then most recently active.
 * @param ctx - The stores.
 * @param req - The request; optional `state`, bounded `limit`.
 * @param res - The response.
 * @returns Nothing.
 */
async function listIncidents(ctx: OpsPipelineContext, req: Request, res: Response): Promise<void> {
  const state = String(req.query.state ?? '').trim();
  if (state.length > 0 && !INCIDENT_STATES.includes(state as IncidentState)) {
    res.status(400).json({ error: 'unknown incident state', states: INCIDENT_STATES });
    return;
  }
  const limit = parseBounded(req.query.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
  const result = await ctx.pool.query(
    `${INCIDENT_SELECT} WHERE ($1::text IS NULL OR state = $1::text)
      ORDER BY severity_num ASC, last_seen DESC LIMIT $2`,
    [state.length > 0 ? state : null, limit],
  );
  res.json({ incidents: result.rows });
}

/**
 * @description One incident with its membership, the events that composed it, the outbound decisions
 * taken about it and the evidence snapshots frozen from it. `lastError` is reported only alongside a
 * non-zero failed bucket — on its own it is a stale artefact that implies a problem which is over.
 * @param ctx - The stores.
 * @param req - The request; `:id` is the incident UUID.
 * @param res - The response.
 * @returns Nothing.
 */
async function getIncidentDetail(ctx: OpsPipelineContext, req: Request, res: Response): Promise<void> {
  const incidentId = String(req.params.id ?? '');
  if (!UUID_PATTERN.test(incidentId)) {
    res.status(400).json({ error: 'incident id must be a UUID' });
    return;
  }
  const found = await ctx.pool.query(`${INCIDENT_SELECT} WHERE incident_id = $1`, [incidentId]);
  const incident = found.rows[0] as { dedupKey: string } | undefined;
  if (!incident) {
    res.status(404).json({ error: 'no such incident' });
    return;
  }
  const [members, events, snapshots, counts] = await Promise.all([
    ctx.pool.query(MEMBER_SELECT, [incidentId]),
    ctx.pool.query('SELECT * FROM oshal_alert_event WHERE incident_id = $1 ORDER BY received_at DESC LIMIT $2', [incidentId, MAX_INCIDENT_EVENTS]),
    ctx.pool.query(SNAPSHOT_SELECT, [incidentId, MAX_INCIDENT_SNAPSHOTS]),
    ctx.dispatch.bucketCounts(DISPATCH_LOOKBACK_MINUTES, { incidentId }),
  ]);
  const lastError = counts.failed > 0 ? await ctx.dispatch.lastError(incident.dedupKey) : null;
  res.json({
    incident,
    members: members.rows,
    events: (events.rows as AlertEventDbRow[]).map(mapAlertEventRow),
    dispatch: { ...counts, lastError },
    snapshots: snapshots.rows,
  });
}

/**
 * @description The autonomy ladder: each rule's declared level, the kill switch, the sliding-hour
 * apply cap with what it has spent, and how much is currently parked.
 * @param ctx - The stores.
 * @param _req - The request.
 * @param res - The response.
 * @returns Nothing.
 */
async function getLadder(ctx: OpsPipelineContext, _req: Request, res: Response): Promise<void> {
  const [rules, used, budget, flap] = await Promise.all([
    ctx.pool.query('SELECT rule_id AS "ruleId", autonomy_level AS "autonomyLevel", enabled FROM oshal_alert_claim_rule ORDER BY priority ASC, rule_id ASC'),
    ctx.dispatch.countApplies(LADDER_WINDOW_MINUTES),
    ctx.dispatch.bucketCounts(LADDER_WINDOW_MINUTES, { action: 'park-budget' }),
    ctx.dispatch.bucketCounts(LADDER_WINDOW_MINUTES, { action: 'park-flap' }),
  ]);
  res.json({
    rules: rules.rows,
    killSwitch: autoApplyEnabled(),
    hourlyCap: { limit: autoApplyHourlyCap(), used },
    parked: { budget: budget.total, flap: flap.total },
    windowMinutes: LADDER_WINDOW_MINUTES,
  });
}

/**
 * @description Every stored claim rule, in evaluation order.
 * @param ctx - The stores.
 * @param _req - The request.
 * @param res - The response.
 * @returns Nothing.
 */
async function listRules(ctx: OpsPipelineContext, _req: Request, res: Response): Promise<void> {
  res.json({ rules: await loadClaimRules(ctx.pool) });
}

/**
 * @description Replaces the whole rule set transactionally. Validation runs first over every rule;
 * on ANY failure nothing is written and every reason is returned, because a partial save leaves the
 * pipeline routing on a set no one designed.
 * @param ctx - The stores.
 * @param req - The request; body `{ rules: [...] }`.
 * @param res - The response.
 * @returns Nothing.
 */
async function putRules(ctx: OpsPipelineContext, req: Request, res: Response): Promise<void> {
  const { rules, errors } = validateClaimRuleSet(req.body);
  if (errors.length > 0) {
    logger.warn({ submitted: rules.length, refused: errors.length }, 'Claim-rule reconcile refused — nothing written');
    res.status(400).json({ errors });
    return;
  }
  const { sub, email } = getCaller(req);
  const outcome = await reconcileClaimRules(ctx.pool, rules, email ?? sub ?? 'operator');
  logger.info({ saved: outcome.saved, removed: outcome.removed.length }, 'Claim rules reconciled');
  res.json(outcome);
}

/**
 * @description Resolves the event a rule test runs against: a stored event by id, or a set of
 * labels normalized exactly as the intake would normalize them.
 * @param pool - Postgres pool.
 * @param body - The request body.
 * @returns The matchable event, or null when the body names none.
 */
async function resolveTestEvent(pool: Pool, body: Record<string, unknown>): Promise<MatchableEvent | null> {
  const eventId = String(body.eventId ?? '').trim();
  if (eventId.length > 0) {
    if (!UUID_PATTERN.test(eventId)) return null;
    const found = await pool.query('SELECT * FROM oshal_alert_event WHERE event_id = $1', [eventId]);
    if (found.rows.length === 0) return null;
    const event = mapAlertEventRow(found.rows[0] as AlertEventDbRow);
    return { alertname: event.alertname, target: event.target, severityNum: event.severityNum, labels: event.labels };
  }
  const labels = readLabelMap(body.labels);
  if (!labels) return null;
  const normalized = normalizeAlert({ labels }, {});
  return {
    alertname: normalized.alertname,
    target: normalized.target,
    severityNum: normalized.severityNum,
    labels: normalized.labels,
  };
}

/**
 * @description Reports which rules match an event and whether EXACTLY ONE claims it. Overlap is the
 * finding: with two matching rules the loser silently never runs, and the only moment that is
 * cheap to see is before the rules are saved.
 * @param ctx - The stores.
 * @param req - The request; body `{ eventId?, labels? }`.
 * @param res - The response.
 * @returns Nothing.
 */
async function postRulesTest(ctx: OpsPipelineContext, req: Request, res: Response): Promise<void> {
  const body = readObjectBody(req);
  const event = body ? await resolveTestEvent(ctx.pool, body) : null;
  if (!event) {
    res.status(400).json({ error: 'supply a stored eventId or a labels object' });
    return;
  }
  const rules = await loadClaimRules(ctx.pool);
  const { matched, claimedBy } = selectClaimingRules(rules, event);
  res.json({
    matched,
    ok: matched.length === 1,
    claimedBy: claimedBy?.ruleId ?? null,
    event: { alertname: event.alertname, target: event.target, severityNum: event.severityNum },
  });
}

/**
 * @description Previews the identity a set of labels would take, and what the dispatch ledger has
 * already recorded against it — the answer to "why did that alert not page anyone".
 * @param ctx - The stores.
 * @param req - The request; body `{ labels, identityFields? }`.
 * @param res - The response.
 * @returns Nothing.
 */
async function postKeyPreview(ctx: OpsPipelineContext, req: Request, res: Response): Promise<void> {
  const body = readObjectBody(req);
  const labels = body ? readLabelMap(body.labels) : null;
  if (!labels) {
    res.status(400).json({ error: 'supply a labels object' });
    return;
  }
  const fields = readStrings(body?.identityFields) ?? [...DEFAULT_IDENTITY_FIELDS];
  const normalized = normalizeAlert({ labels }, {});
  const identitySource = renderIdentitySource(normalized, fields);
  const dedupKey = renderDedupKey(normalized, fields, resolveDeploymentId());
  const counts = await ctx.dispatch.bucketCounts(DISPATCH_LOOKBACK_MINUTES, { dedupKey });
  res.json({
    identitySource,
    dedupKey,
    identityFields: fields,
    suppression: {
      attempts: counts.delivered + counts.failed,
      suppressed: counts.suppressed,
      delivered: counts.delivered,
      failed: counts.failed,
      windowMinutes: DISPATCH_LOOKBACK_MINUTES,
    },
  });
}

/**
 * @description The topology mirror correlation traverses, with per-slice freshness and the loader
 * runs that produced it. Freshness is beside the graph on purpose: a stale mirror does not fail, it
 * quietly stops finding neighbours.
 * @param ctx - The stores.
 * @param _req - The request.
 * @param res - The response.
 * @returns Nothing.
 */
async function getTopology(ctx: OpsPipelineContext, _req: Request, res: Response): Promise<void> {
  const [nodes, edges, freshness, runs, totals] = await Promise.all([
    ctx.pool.query(TOPOLOGY_NODE_SELECT, [TOPOLOGY_PAGE_LIMIT]),
    ctx.pool.query(TOPOLOGY_EDGE_SELECT, [TOPOLOGY_PAGE_LIMIT]),
    ctx.topology.loaderFreshness(),
    ctx.pool.query(LOADER_RUN_SELECT, [MAX_LOADER_RUNS]),
    ctx.pool.query(TOPOLOGY_TOTALS_SELECT),
  ]);
  res.json({
    nodes: nodes.rows,
    edges: edges.rows,
    freshness,
    lastRuns: runs.rows,
    totals: totals.rows[0] ?? { nodes: 0, edges: 0 },
    pageLimit: TOPOLOGY_PAGE_LIMIT,
  });
}

/**
 * @description Upserts operator-authored topology. The operator slice is authored, never discovered,
 * so this writes and does not sweep: deleting whatever was not in this request would turn an edit of
 * one node into a deletion of the rest of the map.
 * @param ctx - The stores.
 * @param req - The request; body `{ nodes[], edges[] }`.
 * @param res - The response.
 * @returns Nothing.
 */
async function putTopology(ctx: OpsPipelineContext, req: Request, res: Response): Promise<void> {
  const body = readObjectBody(req);
  const nodes = readTopologyNodes(body?.nodes ?? []);
  const edges = readTopologyEdges(body?.edges ?? []);
  if (!nodes || !edges) {
    res.status(400).json({ error: 'nodes[] need a nodeKey; edges[] need srcKey and dstKey' });
    return;
  }
  if (nodes.length + edges.length > MAX_TOPOLOGY_UPSERT) {
    res.status(400).json({ error: `at most ${MAX_TOPOLOGY_UPSERT} nodes plus edges per request` });
    return;
  }
  const startedAt = Date.now();
  try {
    const nodesUpserted = await ctx.topology.upsertNodes(nodes);
    const edgesUpserted = await ctx.topology.upsertEdges(edges);
    await recordOperatorRun(ctx, startedAt, nodesUpserted, edgesUpserted, null);
    res.json({ nodesUpserted, edgesUpserted, edgesSkipped: edges.length - edgesUpserted });
  } catch (error) {
    await recordOperatorRun(ctx, startedAt, 0, 0, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/**
 * @description Records the operator loader run so a failed write leaves durable evidence rather than
 * only a log line in a process that may be gone by the time anyone looks.
 * @param ctx - The stores.
 * @param startedAt - When the write began.
 * @param nodesUpserted - Nodes written.
 * @param edgesUpserted - Edges written.
 * @param error - The failure text, or null on success.
 * @returns Nothing.
 */
async function recordOperatorRun(
  ctx: OpsPipelineContext,
  startedAt: number,
  nodesUpserted: number,
  edgesUpserted: number,
  error: string | null,
): Promise<void> {
  await ctx.topology.recordLoaderRun({
    loaderTag: 'operator',
    loaderScope: '',
    durationMs: Date.now() - startedAt,
    success: error === null,
    nodesUpserted,
    edgesUpserted,
    nodesSwept: 0,
    edgesSwept: 0,
    sweepRefused: false,
    error,
    counts: { nodes: nodesUpserted, edges: edgesUpserted },
  });
}

/**
 * @description What arrived, how intake decided it, and which alert names nothing claimed.
 * @param ctx - The stores.
 * @param req - The request; `windowMinutes`.
 * @param res - The response.
 * @returns Nothing.
 */
async function getUnclaimed(ctx: OpsPipelineContext, req: Request, res: Response): Promise<void> {
  const windowMinutes = parseBounded(req.query.windowMinutes, DEFAULT_WINDOW_MINUTES, 1, MAX_WINDOW_MINUTES);
  res.json(await ctx.funnel.intakeBreakdown(windowMinutes));
}

/**
 * @description The parked items: what could not be understood or processed, and why.
 * @param ctx - The stores.
 * @param req - The request; bounded `limit`.
 * @param res - The response.
 * @returns Nothing.
 */
async function getDeadletter(ctx: OpsPipelineContext, req: Request, res: Response): Promise<void> {
  const limit = parseBounded(req.query.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
  const result = await ctx.pool.query(DEADLETTER_SELECT, [limit]);
  res.json({ rows: result.rows });
}

/**
 * @description Re-runs landing, normalization and claim for stored envelopes.
 * @param ctx - The stores.
 * @param req - The request; body `{ envelopeId? | deadletterId? | fromIso,toIso }`.
 * @param res - The response.
 * @returns Nothing.
 */
async function postReplay(ctx: OpsPipelineContext, req: Request, res: Response): Promise<void> {
  const body = readObjectBody(req);
  if (!body) {
    res.status(400).json({ error: 'supply envelopeId, deadletterId, or both fromIso and toIso' });
    return;
  }
  const plan = await planReplay(ctx.pool, body);
  if (!plan.ok) {
    res.status(plan.status).json({ error: plan.error });
    return;
  }
  const outcome = await runReplay(ctx, plan);
  logger.info({ ...outcome, skipped: plan.skipped }, 'Replay complete');
  res.json({
    replayedEnvelopes: outcome.envelopes,
    expandedEvents: outcome.events,
    claimedEvents: outcome.claimed,
    skipped: plan.skipped,
    maxEnvelopes: MAX_REPLAY_ENVELOPES,
  });
}

/**
 * @description Every knob the pipeline reads, its effective value, and whether that value came from
 * a default, the environment, or a claim rule that overrides it.
 * @param ctx - The stores.
 * @param _req - The request.
 * @param res - The response.
 * @returns Nothing.
 */
async function getConfig(ctx: OpsPipelineContext, _req: Request, res: Response): Promise<void> {
  const result = await ctx.pool.query(RULE_OVERRIDE_SELECT);
  const overrides = (result.rows[0] ?? {}) as Record<string, number>;
  res.json({ knobs: buildConfigKnobs(overrides) });
}

const MEMBER_SELECT = `
  SELECT member_key AS "memberKey", alertname, target, severity, severity_num::int AS "severityNum",
         fingerprint, first_seen AS "firstSeen", last_seen AS "lastSeen",
         occurrence_count::int AS "occurrenceCount", attach_reason AS "attachReason",
         dependency_hops::int AS "dependencyHops", resolved_at AS "resolvedAt"
    FROM oshal_incident_member
   WHERE incident_id = $1
   ORDER BY severity_num ASC, last_seen DESC`;

const SNAPSHOT_SELECT = `
  SELECT snapshot_id::text AS "snapshotId", taken_at AS "takenAt", reason,
         correlation_engine AS "correlationEngine", correlation_depth::int AS "correlationDepth",
         correlation_version AS "correlationVersion", root_candidate AS "rootCandidate",
         counters, ticket_id AS "ticketId",
         jsonb_array_length(members)::int AS "memberCount",
         array_length(event_ids, 1)::int AS "eventCount"
    FROM oshal_incident_snapshot
   WHERE incident_id = $1
   ORDER BY taken_at DESC
   LIMIT $2`;

const DEADLETTER_SELECT = `
  SELECT deadletter_id::text AS "deadletterId", at, stage, envelope_id AS "envelopeId",
         event_id AS "eventId", failure_reason AS "failureReason", error, raw,
         attempts::int AS attempts, replayed_at AS "replayedAt"
    FROM oshal_alert_deadletter
   ORDER BY at DESC
   LIMIT $1`;

const TOPOLOGY_NODE_SELECT = `
  SELECT node_key AS "nodeKey", display_name AS "displayName", kinds,
         traverse_via AS "traverseVia", transit_allowed AS "transitAllowed", status, props,
         loader_tag AS "loaderTag", loader_scope AS "loaderScope",
         refreshed_at AS "refreshedAt"
    FROM oshal_topology_node
   ORDER BY node_key ASC
   LIMIT $1`;

const TOPOLOGY_EDGE_SELECT = `
  SELECT src_key AS "srcKey", dst_key AS "dstKey", edge_type AS "edgeType",
         direction_certified AS "directionCertified", attrs,
         loader_tag AS "loaderTag", loader_scope AS "loaderScope",
         refreshed_at AS "refreshedAt"
    FROM oshal_topology_edge
   ORDER BY src_key ASC, dst_key ASC, edge_type ASC
   LIMIT $1`;

const TOPOLOGY_TOTALS_SELECT = `
  SELECT (SELECT COUNT(*)::int FROM oshal_topology_node) AS nodes,
         (SELECT COUNT(*)::int FROM oshal_topology_edge) AS edges`;

const LOADER_RUN_SELECT = `
  SELECT loader_tag AS "loaderTag", loader_scope AS "loaderScope", ran_at AS "ranAt",
         duration_ms::int AS "durationMs", success, nodes_upserted::int AS "nodesUpserted",
         edges_upserted::int AS "edgesUpserted", nodes_swept::int AS "nodesSwept",
         edges_swept::int AS "edgesSwept", sweep_refused AS "sweepRefused", error, counts
    FROM oshal_topology_loader_run
   ORDER BY ran_at DESC
   LIMIT $1`;

const RULE_OVERRIDE_SELECT = `
  SELECT COUNT(*) FILTER (WHERE dedup_ttl_seconds IS NOT NULL)::int AS "dedupTtl",
         COUNT(*) FILTER (WHERE reopen_window_seconds IS NOT NULL)::int AS "reopenWindow",
         COUNT(*) FILTER (WHERE correlation_depth IS NOT NULL)::int AS "correlationDepth",
         COUNT(*) FILTER (WHERE intake <> 'inherit')::int AS "intake",
         COUNT(*) FILTER (WHERE autonomy_level <> 'A0')::int AS "autonomy"
    FROM oshal_alert_claim_rule
   WHERE enabled`;

/**
 * @description Registers the authenticated read surface.
 * @param router - The router being built.
 * @param ctx - The stores.
 * @param gate - Auth middleware and the logging wrapper.
 * @returns Nothing.
 */
function registerReadRoutes(router: Router, ctx: OpsPipelineContext, gate: RouteGate): void {
  const { requiresAuth, handle } = gate;
  router.get('/health', requiresAuth, handle('health', (req, res) => getHealth(ctx, req, res)));
  router.get('/funnel', requiresAuth, handle('funnel', (req, res) => getFunnel(ctx, req, res)));
  router.get('/trend', requiresAuth, handle('trend', (req, res) => getTrend(ctx, req, res)));
  router.get('/incidents', requiresAuth, handle('incidents', (req, res) => listIncidents(ctx, req, res)));
  router.get('/incidents/:id', requiresAuth, handle('incident-detail', (req, res) => getIncidentDetail(ctx, req, res)));
  router.get('/ladder', requiresAuth, handle('ladder', (req, res) => getLadder(ctx, req, res)));
}

/**
 * @description Registers the operator surface. Every route chains `requiresAuth, requiresOperator`
 * on the route itself rather than relying on the mount, so re-mounting this router somewhere else
 * cannot silently drop the operator gate.
 * @param router - The router being built.
 * @param ctx - The stores.
 * @param gate - Auth middleware and the logging wrapper.
 * @returns Nothing.
 */
function registerOperatorRoutes(router: Router, ctx: OpsPipelineContext, gate: RouteGate): void {
  const { requiresAuth, handle } = gate;
  const guard: RequestHandler[] = [requiresAuth, requiresOperator];
  router.get('/rules', guard, handle('rules-list', (req, res) => listRules(ctx, req, res)));
  router.put('/rules', guard, handle('rules-put', (req, res) => putRules(ctx, req, res)));
  router.post('/rules/test', guard, handle('rules-test', (req, res) => postRulesTest(ctx, req, res)));
  router.post('/key-preview', guard, handle('key-preview', (req, res) => postKeyPreview(ctx, req, res)));
  router.get('/topology', guard, handle('topology-get', (req, res) => getTopology(ctx, req, res)));
  router.put('/topology', guard, handle('topology-put', (req, res) => putTopology(ctx, req, res)));
  router.get('/unclaimed', guard, handle('unclaimed', (req, res) => getUnclaimed(ctx, req, res)));
  router.get('/deadletter', guard, handle('deadletter', (req, res) => getDeadletter(ctx, req, res)));
  router.post('/replay', guard, handle('replay', (req, res) => postReplay(ctx, req, res)));
  router.get('/config', guard, handle('config', (req, res) => getConfig(ctx, req, res)));
}

/**
 * @description Builds the Operations Stream operator API
 * (mount: `app.use('/api/ops/alert-pipeline', createOpsPipelineRoutes({ pool: ctx.pool, requiresAuth }))`).
 *
 * The schema is brought up once per process on the first request rather than at import time, so a
 * fresh install, a restored volume or a hot-swapped container reaches a working surface on its own;
 * it runs under the system identity because bring-up has no request in scope and an identity-less
 * connection is stamped anonymous. A bring-up failure is not cached — the next request retries it
 * rather than serving a permanently broken mount.
 * @param deps - Postgres pool and the OIDC auth middleware.
 * @returns The router to mount at /api/ops/alert-pipeline.
 */
export function createOpsPipelineRoutes(deps: OpsPipelineRoutesDeps): Router {
  const router = Router();
  const ctx: OpsPipelineContext = {
    pool: deps.pool,
    envelopes: new EnvelopeStore(deps.pool),
    incidents: new IncidentStore(deps.pool),
    dispatch: new DispatchLog(deps.pool),
    topology: new TopologyStore(deps.pool),
    funnel: new FunnelStats(deps.pool),
  };
  let schemaReady: Promise<void> | null = null;
  const ready = (): Promise<void> => {
    if (!schemaReady) {
      schemaReady = runWithSystemIdentity(() => ensureAlertPipelineSchema(deps.pool)).catch((error: unknown) => {
        schemaReady = null;
        throw error;
      });
    }
    return schemaReady;
  };
  const handle: RouteGate['handle'] = (name, fn) => async (req, res) => {
    const startedAt = Date.now();
    logger.info({ route: name, ...sanitizedParams(req) }, 'ops pipeline request');
    try {
      await ready();
      await fn(req, res);
      logger.info({ route: name, status: res.statusCode, durationMs: Date.now() - startedAt }, 'ops pipeline request complete');
    } catch (error) {
      logger.error(
        { err: error, stack: error instanceof Error ? error.stack : undefined, route: name, durationMs: Date.now() - startedAt },
        'ops pipeline request failed',
      );
      if (!res.headersSent) res.status(500).json({ error: `${name} failed` });
    }
  };
  const gate: RouteGate = { requiresAuth: deps.requiresAuth, handle };
  registerReadRoutes(router, ctx, gate);
  registerOperatorRoutes(router, ctx, gate);
  return router;
}
