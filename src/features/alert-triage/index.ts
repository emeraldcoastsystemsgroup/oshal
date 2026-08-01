/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P1 (ADR-119): feature barrel — Stage A canonicalization + identity gate, Stage C identity-based consolidation, and the FR-A3 intake decision counters for the Alertmanager intake (spec: docs/architecture/alert-triage-and-consolidation-spec.md)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P2 (ADR-119): Stage D bundling exports — related alerts attach to ONE open incident (same-target + dependency correlation over the DependencyResolver seam) with attach-time membership and the FR-D4 ordered root-candidate policy
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P3 (ADR-119): Stage B claim registry + Stage E dispatch gates — claim rules {match, incidentKey?, intake?, bundleHints?} replace the bare allowlist (which survives as a pure-claim shorthand), the FR-E2 budget gate parks over-budget auto-flows visibly, FR-E3 flap damping defers flapping incidents, and FR-E4 resolved handling marks members and (opt-in) self-closes fully-resolved backlog tickets
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P4 (ADR-119 A2): the bounded auto-apply engine + seams, the audit slot, the core-infra guard and the SELF_HEAL_* knobs — behind the default-FALSE kill switch; core infra never applies, one apply per key per TTL, global hourly cap, verification-before-complete
 */

/**
 * Alert triage & consolidation (ADR-119, P1+P2+P3).
 *
 * The in-process intake stage between the Alertmanager webhook payload and the
 * intelligent-processing ticket queue: canonicalize + identity-gate each alert
 * (Stage A), claim-gate it against the declarative rule registry (Stage B —
 * unclaimed is counted noise, never an uncounted vanish), consolidate refires
 * onto ONE open ticket per incident key with escalate-only severity and
 * recurrence linking (Stage C), bundle RELATED alerts — same target, or
 * dependency-connected within the correlation depth — onto the open incident
 * inside the correlation window with attach-time membership and an ordered
 * root-candidate policy (Stage D), gate dispatch on the sliding-hour analyst
 * budget, flap damping and resolved handling (Stage E), and count every intake
 * decision (FR-A3).
 *
 * @module alert-triage
 */
export {
  ALERT_BUNDLE_CANDIDATE_LIMIT,
  ALERT_CONSOLIDATION_TTL_DEFAULT_SECONDS,
  ALERT_CORRELATION_DEPTH_DEFAULT,
  ALERT_CORRELATION_WINDOW_DEFAULT_SECONDS,
  ALERT_FLAP_QUIET_DEFAULT_SECONDS,
  ALERT_FLAP_THRESHOLD_DEFAULT,
  ALERT_FLAP_WINDOW_DEFAULT_SECONDS,
  ALERT_INCIDENT_KEY_FIELD,
  ALERT_INTAKE_OWNER_SUB,
  ALERT_MAX_INCIDENT_MEMBERS,
  ALERT_RCA_HOURLY_BUDGET_DEFAULT_USD,
  ALERT_RCA_RESERVATION_TTL_SECONDS,
  AUTO_APPLIED_FLAG,
  AUTO_APPLY_APPLY_FAILED_FLAG,
  AUTO_APPLY_CAP_PARKED_FLAG,
  AUTO_APPLY_CLASSES,
  AUTO_APPLY_CORE_INFRA_FLAG,
  AUTO_APPLY_RECURRENCE_FLAG,
  AUTO_APPLY_VERIFY_FAILED_FLAG,
  AlertBundlingService,
  AlertClaimRegistry,
  AlertConsolidationService,
  AlertIntakeStats,
  BUDGET_PARK_FLAG,
  DEFAULT_INCIDENT_KEY_TEMPLATE,
  FLAPPING_FLAG,
  RcaBudgetGate,
  SELF_HEAL_APPLY_HOURLY_CAP_DEFAULT,
  SELF_HEAL_VERIFY_TIMEOUT_DEFAULT_SECONDS,
  SelfHealAutoApplyEngine,
  StaticDependencyMap,
  TERMINAL_TICKET_STATES,
  allMembersResolved,
  autoApplyEnabled,
  autoApplyHourlyCap,
  autoApplyVerifyTimeoutSeconds,
  autoResolveEnabled,
  canonicalizeAlert,
  consolidationTtlSeconds,
  correlationDepth,
  correlationWindowSeconds,
  flapQuietSeconds,
  flapThreshold,
  flapWindowSeconds,
  incidentOf,
  isCoreInfraTarget,
  isWithinConsolidationTtl,
  isWithinCorrelationWindow,
  markMemberResolved,
  maxIncidentMembers,
  normalizeTarget,
  observeRefireForFlap,
  priorityRank,
  rcaHourlyBudgetUsd,
  renderClaimIncidentKey,
  resolveApplyTarget,
  renderIncidentKey,
  resolveTarget,
  severityToPriority,
  unclaimedPolicy,
  validateClaimRule,
  type AlertIntakeDecision,
  type AlertIntakeStatsSnapshot,
  type AlertTicketShape,
  type AutoApplyResolution,
  type AutoApplyTicketGateway,
  type BundleTarget,
  type CanonicalAlert,
  type ClaimBundleHints,
  type ClaimMatch,
  type ClaimResolution,
  type ClaimRule,
  type ClaimRuleValidation,
  type ConsolidationOutcome,
  type DependencyResolver,
  type FlapVerdict,
  type IncidentAutoApplyAudit,
  type IncidentEscalation,
  type IncidentFlapState,
  type IncidentKeyRender,
  type IncidentMember,
  type IncidentRecord,
  type RawAlertmanagerAlert,
  type RcaBudgetVerdict,
  type RcaReservation,
  type RcaSpendReader,
  type RemediationExecutor,
  type RootCandidate,
  type TriageTicketGateway,
  type UnclaimedPolicy,
} from './services';
