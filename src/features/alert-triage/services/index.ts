/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P1 (ADR-119): services barrel for the alert-triage feature slice
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P2 (ADR-119 Stage D): bundling exports — AlertBundlingService, the DependencyResolver seam + StaticDependencyMap, the correlation knobs, and the incident record shape now sourced from incident-record.ts (unchanged public names)
 */

export {
  ALERT_BUNDLE_CANDIDATE_LIMIT,
  ALERT_CONSOLIDATION_TTL_DEFAULT_SECONDS,
  ALERT_CORRELATION_DEPTH_DEFAULT,
  ALERT_CORRELATION_WINDOW_DEFAULT_SECONDS,
  ALERT_INCIDENT_KEY_FIELD,
  ALERT_MAX_INCIDENT_MEMBERS,
  TERMINAL_TICKET_STATES,
  consolidationTtlSeconds,
  correlationDepth,
  correlationWindowSeconds,
  isWithinConsolidationTtl,
  isWithinCorrelationWindow,
  maxIncidentMembers,
} from './alert-triage-constants';

export {
  canonicalizeAlert,
  priorityRank,
  renderIncidentKey,
  resolveTarget,
  severityToPriority,
  type CanonicalAlert,
  type IncidentKeyRender,
  type RawAlertmanagerAlert,
} from './canonical-alert';

export {
  AlertIntakeStats,
  type AlertIntakeDecision,
  type AlertIntakeStatsSnapshot,
} from './intake-stats';

export {
  incidentOf,
  type IncidentEscalation,
  type IncidentMember,
  type IncidentRecord,
  type RootCandidate,
} from './incident-record';

export {
  StaticDependencyMap,
  normalizeTarget,
  type DependencyResolver,
} from './dependency-map';

export {
  AlertBundlingService,
  type BundleTarget,
} from './alert-bundling';

export {
  AlertConsolidationService,
  type AlertTicketShape,
  type ConsolidationOutcome,
  type TriageTicketGateway,
} from './alert-consolidation';
