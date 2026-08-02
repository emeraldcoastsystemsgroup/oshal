/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The Operations Stream row contract — the shapes every pipeline stage reads and writes, mirroring migrations 104-108. One file, no behaviour, so the stores and the read models can never drift on a column name.
 */

/**
 * @description The lane an event arrived on. Selects the claim-rule candidate set and scopes
 * every per-lane funnel counter. An unrecognized value is stored as `UNKNOWN_SOURCE` rather
 * than dropped — an unroutable event must still be countable.
 * @module alert-pipeline-types
 */
export type AlertSource = string;

/** @description Sentinel stored when an event arrives on a lane the registry does not know. */
export const UNKNOWN_SOURCE = '__unknown__';

/** @description The synthetic machine owner the alert intake writes under (no user identity). */
export const PIPELINE_OWNER_SUB = 'alert:prometheus';

/**
 * @description Severity as an ORDINAL, deliberately inverted: 1 is the most severe. Every rule
 * filter therefore reads `severity_num <= N`. A `>=` filter selects info-only, which is the
 * classic inversion that silently narrows a rule to nothing.
 */
export const SEVERITY_RANK: Readonly<Record<string, number>> = Object.freeze({
  critical: 1,
  error: 2,
  warning: 3,
  info: 4,
});

/** @description Fallback rank for an unrecognized severity string (treated as `warning`). */
export const SEVERITY_RANK_DEFAULT = 3;

/** @description Lifecycle of a single arriving alert. */
export type AlertStatus = 'firing' | 'resolved';

/** @description The durable outcome of one event's trip through intake. */
export type ClaimDecision =
  | 'pending'
  | 'created'
  | 'consolidated'
  | 'bundled'
  | 'reopened'
  | 'resolved'
  | 'noise'
  | 'dropped'
  | 'failed';

/** @description Why an event was not claimed — a coverage gap and a routing bug look different. */
export type UnclaimedReason =
  | 'no_identity'
  | 'no_rule_match'
  | 'rule_disabled'
  | 'unknown_source'
  | 'identity_empty';

/** @description Incident lifecycle. `archived` is a superseded instance, never a live one. */
export type IncidentState = 'open' | 'resolved' | 'closed' | 'archived';

/** @description Who closed an incident. An operator close is a decision and is never auto-reopened. */
export type IncidentClosedBy = 'auto' | 'operator' | 'ticket';

/** @description Why a member joined an incident, recorded at attach time rather than inferred later. */
export type AttachReason = 'genesis' | 'same-key' | 'same-target' | 'dependency';

/** @description Which engine produced a grouping, recorded so the decision is reproducible. */
export type CorrelationEngine = 'none' | 'same-target' | 'graph' | 'postgres-cte';

/** @description The moment a snapshot froze evidence. */
export type SnapshotReason = 'ticket-cut' | 'membership-change' | 'reopen' | 'close' | 'manual';

/** @description Which outbound channel a dispatch row describes. */
export type DispatchChannel = 'ticket' | 'analysis' | 'self-heal' | 'notify';

/** @description What the pipeline did, or declined to do, on that channel. */
export type DispatchAction =
  | 'create'
  | 'update'
  | 'reopen'
  | 'close'
  | 'park-budget'
  | 'park-flap'
  | 'restore'
  | 'apply'
  | 'verify';

/** @description Stage at which an item failed and was parked for inspection or replay. */
export type DeadletterStage = 'ingest' | 'normalize' | 'claim' | 'consolidate' | 'dispatch';

/**
 * @description Autonomy for a claim rule — the switch.
 * `A0` parks for a human. `A1` writes the root cause and the remediation plan and stops.
 * `A2` applies it, bounded. There is no `A3`: unbounded autonomy is a non-goal, not a future default.
 */
export type AutonomyLevel = 'A0' | 'A1' | 'A2';

/** @description Which loader owns a topology row. A loader sweeps only its own slice. */
export type TopologyLoader = 'compose' | 'operator' | 'discovery' | 'observed';

/** @description A landed webhook delivery, stored verbatim before anything parses it. */
export interface AlertEnvelopeRow {
  envelopeId: string;
  receivedAt: Date;
  source: AlertSource;
  receiver: string | null;
  envelopeStatus: string | null;
  groupKey: string | null;
  externalUrl: string | null;
  alertCount: number;
  truncatedAlerts: number;
  body: unknown;
  remoteAddr: string | null;
  signatureVerified: boolean;
  expandedCount: number;
  normalizeError: string | null;
  replayedFrom: string | null;
}

/** @description One normalized alert. The shape every downstream stage reads. */
export interface AlertEventRow {
  eventId: string;
  envelopeId: string | null;
  receivedAt: Date;
  source: AlertSource;
  fingerprint: string;
  alertname: string;
  target: string;
  targetKind: string | null;
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
  envelopeGroupKey: string | null;
  receiver: string | null;
  dedupKey: string | null;
  identitySource: string | null;
  usedFingerprintFallback: boolean;
  claimDecision: ClaimDecision;
  claimedByRule: string | null;
  unclaimedReason: UnclaimedReason | null;
  incidentId: string | null;
  attempts: number;
  lastError: string | null;
  processedAt: Date | null;
}

/** @description The consolidated incident — one live row per identity. */
export interface IncidentRow {
  incidentId: string;
  dedupKey: string;
  identitySource: string;
  incidentLabel: string;
  instanceSeq: number;
  state: IncidentState;
  primaryAlertname: string;
  primaryTarget: string;
  claimRuleId: string | null;
  severity: string;
  severityNum: number;
  priority: string;
  firstSeen: Date;
  lastSeen: Date;
  occurrenceCount: number;
  memberCount: number;
  membersOverflow: number;
  reopenCount: number;
  reopenedAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  closedBy: IncidentClosedBy | null;
  recurrenceOf: string | null;
  correlationGroupId: string;
  correlationEngine: CorrelationEngine;
  correlationDepth: number | null;
  correlationVersion: string | null;
  rootCandidateTarget: string | null;
  rootCandidateReason: string | null;
  rootCandidateAmbiguous: boolean;
  intakeStatus: string;
  flags: string[];
  flapParked: boolean;
  ticketId: string | null;
  revision: number;
}

/**
 * @description The outcome of one consolidation upsert. `wasCreated` and `wasReopened` are
 * returned by the statement itself rather than inferred by a follow-up read, so a concurrent
 * writer cannot make the caller draw the wrong conclusion.
 */
export interface ConsolidationOutcome {
  incident: IncidentRow;
  wasCreated: boolean;
  wasReopened: boolean;
  /** True when arm C fired: the prior instance was archived and this row is a fresh instance. */
  wasRecurrence: boolean;
}

/** @description One distinct alert identity belonging to an incident. */
export interface IncidentMemberRow {
  incidentId: string;
  memberKey: string;
  alertname: string;
  target: string;
  severity: string;
  severityNum: number;
  fingerprint: string | null;
  firstSeen: Date;
  lastSeen: Date;
  occurrenceCount: number;
  attachReason: AttachReason;
  dependencyHops: number | null;
  resolvedAt: Date | null;
}

/** @description A node in the infrastructure topology mirror. */
export interface TopologyNodeRow {
  nodeKey: string;
  displayName: string | null;
  kinds: string[];
  /**
   * The hub gate. When non-empty, a traversal step may enter this node ONLY over one of these
   * edge types. Without it a large estate collapses into a single component and the failure
   * presents as correlation working unusually well.
   */
  traverseVia: string[] | null;
  status: 'active' | 'decommissioned';
  props: Record<string, unknown>;
  loaderTag: TopologyLoader;
  loaderScope: string;
}

/** @description A directed dependency edge: `srcKey` DEPENDS ON `dstKey`. */
export interface TopologyEdgeRow {
  srcKey: string;
  dstKey: string;
  edgeType: string;
  /** Root-cause ranking may consult direction ONLY when this is true. */
  directionCertified: boolean;
  attrs: Record<string, unknown>;
  loaderTag: TopologyLoader;
  loaderScope: string;
}

/** @description One reachable node from a traversal, with the cheapest hop count that found it. */
export interface TopologyHop {
  nodeKey: string;
  hops: number;
}

/** @description The subgraph a correlation traversed, frozen verbatim into a snapshot. */
export interface TraversedSubgraph {
  nodes: TopologyNodeRow[];
  edges: TopologyEdgeRow[];
  seeds: string[];
  depth: number;
  engine: CorrelationEngine;
  version: string;
}

/** @description An outbound decision. Exactly one of `attempted` / `suppressed` is true. */
export interface DispatchRecord {
  incidentId: string | null;
  dedupKey: string;
  targetChannel: DispatchChannel;
  action: DispatchAction;
  attempted: boolean;
  suppressed: boolean;
  success: boolean | null;
  statusCode: number | null;
  error: string | null;
  ticketId: string | null;
  ttlSeconds: number | null;
  payload: unknown;
}

/** @description A claim rule: which events this pipeline admits, and how it treats them. */
export interface ClaimRuleRow {
  ruleId: string;
  enabled: boolean;
  priority: number;
  matchPredicate: ClaimPredicate;
  identityFields: string[];
  dedupTtlSeconds: number | null;
  reopenWindowSeconds: number | null;
  intake: 'auto' | 'backlog' | 'inherit';
  autonomyLevel: AutonomyLevel;
  rootFilter: string[] | null;
  correlationDepth: number | null;
  predicateHash: string;
  notes: string | null;
  updatedAt: Date;
  updatedBy: string;
}

/**
 * @description What a rule matches on. Deliberately has no time or range field: a freshness
 * clause inside a matcher is evaluated against the event's own timestamp and silently kills an
 * entire lane while the rule sits visibly registered. Freshness belongs to intake windows and
 * TTLs, never to a claim.
 */
export interface ClaimPredicate {
  alertname?: string[];
  labels?: Record<string, string | string[]>;
  /** Inclusive ceiling on `severityNum` — remember 1 is most severe. */
  severityMax?: number;
}

/** @description The ordered funnel stages. A stage at zero below a non-zero one is the alarm. */
export const FUNNEL_STAGES = [
  'envelopes',
  'events',
  'identity_dropped',
  'noise',
  'claimed',
  'incidents_opened',
  'incidents_reopened',
  'incidents_bundled',
  'tickets_created',
  'dispatch_attempted',
  'dispatch_suppressed',
  'dispatch_failed',
  'actions_applied',
] as const;

/** @description One ordered funnel stage name. */
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

/** @description A per-stage per-lane count over one capture window. */
export interface FunnelPoint {
  stage: FunnelStage;
  source: AlertSource;
  count: number;
  ts: Date;
  windowMinutes: number;
}
