/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P1 (ADR-119): services barrel for the alert-triage feature slice
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P2 (ADR-119 Stage D): bundling exports — AlertBundlingService, the DependencyResolver seam + StaticDependencyMap, the correlation knobs, and the incident record shape now sourced from incident-record.ts (unchanged public names)
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P3 (ADR-119 Stage B + E): claim-registry exports (AlertClaimRegistry, rule validation, unclaimed policy), the RcaBudgetGate + RcaSpendReader seam, flap damping, the FR-E4 member-resolution helpers, and the new dispatch-gate knobs
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P4 (ADR-119 A2): auto-apply exports — SelfHealAutoApplyEngine + the RemediationExecutor/AutoApplyTicketGateway seams, the sanctioned-class set, the surfacing flag constants, isCoreInfraTarget (the absolute core-infra guard over the dependency map's own names), the autoApply audit slot, and the SELF_HEAL_* knob readers
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
  ALERT_MAX_INCIDENT_MEMBERS,
  ALERT_RCA_HOURLY_BUDGET_DEFAULT_USD,
  ALERT_RCA_RESERVATION_TTL_SECONDS,
  TERMINAL_TICKET_STATES,
  autoResolveEnabled,
  consolidationTtlSeconds,
  correlationDepth,
  correlationWindowSeconds,
  flapQuietSeconds,
  flapThreshold,
  flapWindowSeconds,
  SELF_HEAL_APPLY_HOURLY_CAP_DEFAULT,
  SELF_HEAL_VERIFY_TIMEOUT_DEFAULT_SECONDS,
  autoApplyEnabled,
  autoApplyHourlyCap,
  autoApplyVerifyTimeoutSeconds,
  isWithinConsolidationTtl,
  isWithinCorrelationWindow,
  maxIncidentMembers,
  rcaHourlyBudgetUsd,
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
  allMembersResolved,
  incidentOf,
  markMemberResolved,
  type IncidentAutoApplyAudit,
  type IncidentEscalation,
  type IncidentFlapState,
  type IncidentMember,
  type IncidentRecord,
  type RootCandidate,
} from './incident-record';

export {
  AUTO_APPLIED_FLAG,
  AUTO_APPLY_APPLY_FAILED_FLAG,
  AUTO_APPLY_CAP_PARKED_FLAG,
  AUTO_APPLY_CLASSES,
  AUTO_APPLY_CORE_INFRA_FLAG,
  AUTO_APPLY_RECURRENCE_FLAG,
  AUTO_APPLY_VERIFY_FAILED_FLAG,
  SelfHealAutoApplyEngine,
  resolveApplyTarget,
  type AutoApplyResolution,
  type AutoApplyTicketGateway,
  type RemediationExecutor,
} from './auto-apply';

export {
  AlertClaimRegistry,
  DEFAULT_INCIDENT_KEY_TEMPLATE,
  renderClaimIncidentKey,
  unclaimedPolicy,
  validateClaimRule,
  type ClaimBundleHints,
  type ClaimMatch,
  type ClaimResolution,
  type ClaimRule,
  type ClaimRuleValidation,
  type UnclaimedPolicy,
} from './claim-registry';

export {
  BUDGET_PARK_FLAG,
  RcaBudgetGate,
  type RcaBudgetVerdict,
  type RcaReservation,
  type RcaSpendReader,
} from './rca-budget-gate';

export {
  FLAPPING_FLAG,
  observeRefireForFlap,
  type FlapVerdict,
} from './flap-damping';

export {
  StaticDependencyMap,
  isCoreInfraTarget,
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
