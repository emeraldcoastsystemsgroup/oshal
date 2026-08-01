/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P1 (ADR-119): feature barrel — Stage A canonicalization + identity gate, Stage C identity-based consolidation, and the FR-A3 intake decision counters for the Alertmanager intake (spec: docs/architecture/alert-triage-and-consolidation-spec.md)
 */

/**
 * Alert triage & consolidation (ADR-119, P1).
 *
 * The in-process intake stage between the Alertmanager webhook payload and the
 * intelligent-processing ticket queue: canonicalize + identity-gate each alert
 * (Stage A), consolidate refires onto ONE open ticket per incident key with
 * escalate-only severity and recurrence linking (Stage C), and count every
 * intake decision (FR-A3). Bundling (Stage D), the claim registry (Stage B),
 * and the dispatch gates (Stage E) land in P2/P3.
 *
 * @module alert-triage
 */
export {
  ALERT_CONSOLIDATION_TTL_DEFAULT_SECONDS,
  ALERT_INCIDENT_KEY_FIELD,
  ALERT_MAX_INCIDENT_MEMBERS,
  AlertConsolidationService,
  AlertIntakeStats,
  TERMINAL_TICKET_STATES,
  canonicalizeAlert,
  consolidationTtlSeconds,
  incidentOf,
  isWithinConsolidationTtl,
  priorityRank,
  renderIncidentKey,
  resolveTarget,
  severityToPriority,
  type AlertIntakeDecision,
  type AlertIntakeStatsSnapshot,
  type AlertTicketShape,
  type CanonicalAlert,
  type ConsolidationOutcome,
  type IncidentEscalation,
  type IncidentKeyRender,
  type IncidentMember,
  type IncidentRecord,
  type RawAlertmanagerAlert,
  type TriageTicketGateway,
} from './services';
