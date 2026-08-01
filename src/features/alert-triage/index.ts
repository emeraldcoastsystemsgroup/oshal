/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P1 (ADR-119): feature barrel — Stage A canonicalization + identity gate, Stage C identity-based consolidation, and the FR-A3 intake decision counters for the Alertmanager intake (spec: docs/architecture/alert-triage-and-consolidation-spec.md)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P2 (ADR-119): Stage D bundling exports — related alerts attach to ONE open incident (same-target + dependency correlation over the DependencyResolver seam) with attach-time membership and the FR-D4 ordered root-candidate policy
 */

/**
 * Alert triage & consolidation (ADR-119, P1+P2).
 *
 * The in-process intake stage between the Alertmanager webhook payload and the
 * intelligent-processing ticket queue: canonicalize + identity-gate each alert
 * (Stage A), consolidate refires onto ONE open ticket per incident key with
 * escalate-only severity and recurrence linking (Stage C), bundle RELATED
 * alerts — same target, or dependency-connected within the correlation depth —
 * onto the open incident inside the correlation window with attach-time
 * membership and an ordered root-candidate policy (Stage D), and count every
 * intake decision (FR-A3). The claim registry (Stage B) and the dispatch gates
 * (Stage E) land in P3.
 *
 * @module alert-triage
 */
export {
  ALERT_BUNDLE_CANDIDATE_LIMIT,
  ALERT_CONSOLIDATION_TTL_DEFAULT_SECONDS,
  ALERT_CORRELATION_DEPTH_DEFAULT,
  ALERT_CORRELATION_WINDOW_DEFAULT_SECONDS,
  ALERT_INCIDENT_KEY_FIELD,
  ALERT_MAX_INCIDENT_MEMBERS,
  AlertBundlingService,
  AlertConsolidationService,
  AlertIntakeStats,
  StaticDependencyMap,
  TERMINAL_TICKET_STATES,
  canonicalizeAlert,
  consolidationTtlSeconds,
  correlationDepth,
  correlationWindowSeconds,
  incidentOf,
  isWithinConsolidationTtl,
  isWithinCorrelationWindow,
  maxIncidentMembers,
  normalizeTarget,
  priorityRank,
  renderIncidentKey,
  resolveTarget,
  severityToPriority,
  type AlertIntakeDecision,
  type AlertIntakeStatsSnapshot,
  type AlertTicketShape,
  type BundleTarget,
  type CanonicalAlert,
  type ConsolidationOutcome,
  type DependencyResolver,
  type IncidentEscalation,
  type IncidentKeyRender,
  type IncidentMember,
  type IncidentRecord,
  type RawAlertmanagerAlert,
  type RootCandidate,
  type TriageTicketGateway,
} from './services';
