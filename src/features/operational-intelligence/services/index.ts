/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added operational-intelligence services barrel exports (WS-7)
 */

export {
  CostTrackingService,
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
// The legacy monitoring-platform funnel snapshotter was archived —
// that product integration is retired and not in use.
