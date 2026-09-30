/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added operational-intelligence services barrel exports (WS-7)
 */

export {
  CostTrackingService,
  UNKNOWN_PROVIDER,
  type CostEvent,
  type CostSummary,
} from './cost-tracking-service';
export {
  AgentMetricsService,
  type AgentExecutionEvent,
  type AgentMetrics,
} from './agent-metrics-service';
export {
  RoutingAuditLog,
  type RoutingAuditEntry,
  type RoutingAuditQuery,
} from './routing-audit-log';
export {
  CompetencyRanker,
  SWARM_PHASES,
  type CompetencyScore,
  type CompetencyWeights,
  type SwarmPhase,
  type RankedPhaseAgent,
} from './competency-ranker';
export {
  StuckAgentWatchdog,
  type StuckWorkItem,
  type WatchdogAction,
  type WatchdogConfig,
} from './stuck-agent-watchdog';
export {
  FeedbackLoopService,
  type FeedbackRecord,
  type HumanVerdict,
  type AgentFeedbackStats,
} from './feedback-loop-service';
export {
  PrivateMeshManager,
  type BreakoutChannel,
  type CreateBreakoutOptions,
} from './private-mesh-manager';
export {
  AgentHealthMonitor,
  type AgentHealthCheck,
  type AgentHealthStatus,
  type HealthCheckItem,
} from './agent-health-monitor';
export {
  SelfHealingPipeline,
  type RemediationAction,
  type HealingResult,
} from './self-healing-pipeline';
export {
  aggregateFeatureTokenEvidence,
  type FeatureTokenEvidence,
  type StoredFeatureTokenEvidence,
  type FeatureTokenEvidenceRow,
  type FeatureTokenEvidenceScope,
  type FeatureTokenProfile,
  type FeatureTokenReport,
} from './feature-token-evidence';
export {
  readOwnFeatureTokenEvidence,
  MAX_FEATURE_TOKEN_EVIDENCE_ROWS,
  FeatureTokenEvidenceOverflowError,
  FeatureTokenEvidenceInputError,
  type ReadFeatureTokenEvidenceInput,
  type FeatureTokenEvidenceReadResult,
  type FeatureTokenEvidenceQueryable,
} from './feature-token-evidence-reader';
// The legacy monitoring-platform funnel snapshotter was archived —
// that product integration is retired and not in use.
