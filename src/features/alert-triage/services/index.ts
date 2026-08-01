/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P1 (ADR-119): services barrel for the alert-triage feature slice
 */

export {
  ALERT_CONSOLIDATION_TTL_DEFAULT_SECONDS,
  ALERT_INCIDENT_KEY_FIELD,
  ALERT_MAX_INCIDENT_MEMBERS,
  TERMINAL_TICKET_STATES,
  consolidationTtlSeconds,
  isWithinConsolidationTtl,
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
  AlertConsolidationService,
  incidentOf,
  type AlertTicketShape,
  type ConsolidationOutcome,
  type IncidentEscalation,
  type IncidentMember,
  type IncidentRecord,
  type TriageTicketGateway,
} from './alert-consolidation';
