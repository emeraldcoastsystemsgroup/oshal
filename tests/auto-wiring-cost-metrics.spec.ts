/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added tests for auto-wiring: cost recording, metrics recording, competency cold-start (#11 fix)
 */

import { expect, test } from '@playwright/test';
import { CostTrackingService, type CostEvent } from '../src/features/operational-intelligence/services/cost-tracking-service';
import { AgentMetricsService, type AgentExecutionEvent } from '../src/features/operational-intelligence/services/agent-metrics-service';
import { CompetencyRanker } from '../src/features/operational-intelligence/services/competency-ranker';
import { AgentHealthMonitor } from '../src/features/operational-intelligence/services/agent-health-monitor';
import { SelfHealingPipeline, createDefaultRestartFn } from '../src/features/operational-intelligence/services/self-healing-pipeline';
import { RoutingAuditLog } from '../src/features/operational-intelligence/services/routing-audit-log';

// ═══════════════════════════════════════════════════════════════════════
// 1. COST RECORDING AUTO-WIRING — CostRecordFn callback pattern
// ═══════════════════════════════════════════════════════════════════════

test.describe('Cost Recording Auto-Wiring', () => {
  test('CostRecordFn callback from execution handler writes to CostTrackingService', async () => {
    const costService = new CostTrackingService();

    // Simulate the auto-wiring callback that the execution handler uses
    const recordCost = async (event: CostEvent) => {
      await costService.recordCost(event);
    };

    // Simulate a real token count event (not estimated)
    await recordCost({
      taskId: 'swarm-test-123',
      agentId: 'code-developer',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
      inputTokens: 1500,
      outputTokens: 800,
      inputCost: 0.0045,
      outputCost: 0.012,
      totalCost: 0.0165,
      currency: 'USD',
      ticketExternalId: 'ISSUE-42',
    });

    const summary = costService.getSummary();
    expect(summary.totalInputTokens).toBe(1500);
    expect(summary.totalOutputTokens).toBe(800);
    expect(summary.totalCost).toBeCloseTo(0.0165, 4);
    expect(summary.byAgent['code-developer'].requests).toBe(1);
    expect(summary.byModel['claude-sonnet-4-20250514'].tokens).toBe(2300);
    expect(summary.byProvider['anthropic'].cost).toBeCloseTo(0.0165, 4);
  });

  test('cost events accumulate correctly across multiple executions', async () => {
    const costService = new CostTrackingService();
    const recordCost = async (event: CostEvent) => costService.recordCost(event);

    await recordCost(buildCostEvent('agent-a', 'claude-sonnet', 1000, 500, 0.003, 0.0075));
    await recordCost(buildCostEvent('agent-a', 'claude-sonnet', 2000, 1000, 0.006, 0.015));
    await recordCost(buildCostEvent('agent-b', 'claude-opus', 500, 200, 0.0075, 0.006));

    const summary = costService.getSummary();
    expect(summary.totalRequests).toBe(3);
    expect(summary.totalInputTokens).toBe(3500);
    expect(summary.totalOutputTokens).toBe(1700);
    expect(summary.byAgent['agent-a'].requests).toBe(2);
    expect(summary.byAgent['agent-b'].requests).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. METRICS RECORDING AUTO-WIRING — MetricsRecordFn callback pattern
// ═══════════════════════════════════════════════════════════════════════

test.describe('Metrics Recording Auto-Wiring', () => {
  test('MetricsRecordFn callback from execution handler writes to AgentMetricsService', () => {
    const metricsService = new AgentMetricsService();

    // Simulate the auto-wiring callback
    const recordMetrics = (event: AgentExecutionEvent) => {
      metricsService.recordExecution(event);
    };

    recordMetrics({
      agentId: 'code-developer',
      ticketExternalId: 'ISSUE-42',
      swarmRunId: 'run-abc',
      durationMs: 5000,
      outcome: 'completed',
      retryCount: 0,
      verificationAttempts: 1,
    });

    const metrics = metricsService.getMetrics('code-developer');
    expect(metrics.totalExecutions).toBe(1);
    expect(metrics.successCount).toBe(1);
    expect(metrics.successRate).toBe(1);
    expect(metrics.avgDurationMs).toBe(5000);
  });

  test('delivery-phase metrics capture escalation outcome', () => {
    const metricsService = new AgentMetricsService();
    const recordMetrics = (event: AgentExecutionEvent) => metricsService.recordExecution(event);

    // Agent succeeded at execution but failed at delivery (escalated)
    recordMetrics({
      agentId: 'code-developer',
      ticketExternalId: 'ISSUE-99',
      swarmRunId: 'run-xyz',
      durationMs: 15000,
      outcome: 'escalated',
      retryCount: 3,
      verificationAttempts: 4,
    });

    const metrics = metricsService.getMetrics('code-developer');
    expect(metrics.escalationCount).toBe(1);
    expect(metrics.successRate).toBe(0);
    expect(metrics.avgRetryCount).toBe(3);
  });

  test('both execution and delivery metrics are recorded for same agent', () => {
    const metricsService = new AgentMetricsService();
    const recordMetrics = (event: AgentExecutionEvent) => metricsService.recordExecution(event);

    // Execution handler records success
    recordMetrics({
      agentId: 'code-developer',
      ticketExternalId: 'ISSUE-50',
      swarmRunId: 'run-1',
      durationMs: 3000,
      outcome: 'completed',
      retryCount: 0,
      verificationAttempts: 1,
    });

    // Delivery phase also records (different ticket)
    recordMetrics({
      agentId: 'code-developer',
      ticketExternalId: 'ISSUE-51',
      swarmRunId: 'run-2',
      durationMs: 8000,
      outcome: 'failed',
      retryCount: 2,
      verificationAttempts: 3,
    });

    const metrics = metricsService.getMetrics('code-developer');
    expect(metrics.totalExecutions).toBe(2);
    expect(metrics.successCount).toBe(1);
    expect(metrics.failureCount).toBe(1);
    expect(metrics.successRate).toBe(0.5);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. COMPETENCY RANKER COLD-START
// ═══════════════════════════════════════════════════════════════════════

test.describe('CompetencyRanker Cold-Start', () => {
  test('new agents get persona-based bootstrap score instead of neutral 0.5', () => {
    const metricsService = new AgentMetricsService();
    const ranker = new CompetencyRanker(metricsService);

    // Agent with no executions should get bootstrap score, not 0.5
    const score = ranker.scoreAgent('task-manager');
    expect(score.score).toBe(0.70); // task-manager bootstrap = 0.70
  });

  test('project-manager gets different bootstrap score than code-developer', () => {
    const metricsService = new AgentMetricsService();
    const ranker = new CompetencyRanker(metricsService);

    const pmScore = ranker.scoreAgent('project-manager');
    const devScore = ranker.scoreAgent('code-developer');
    expect(pmScore.score).toBe(0.65);
    expect(devScore.score).toBe(0.60);
    expect(pmScore.score).not.toBe(devScore.score);
  });

  test('unknown agents still get 0.5 neutral score', () => {
    const metricsService = new AgentMetricsService();
    const ranker = new CompetencyRanker(metricsService);

    const score = ranker.scoreAgent('unknown-agent-uuid');
    expect(score.score).toBe(0.5);
  });

  test('custom bootstrap scores can be provided', () => {
    const metricsService = new AgentMetricsService();
    const ranker = new CompetencyRanker(metricsService, undefined, {
      'custom-agent': 0.85,
    });

    const score = ranker.scoreAgent('custom-agent');
    expect(score.score).toBe(0.85);
  });

  test('agents with enough executions use real metrics instead of bootstrap', () => {
    const metricsService = new AgentMetricsService();
    // Record 5+ executions to exceed cold-start threshold
    for (let i = 0; i < 6; i++) {
      metricsService.recordExecution({
        agentId: 'task-manager',
        ticketExternalId: `ISSUE-${i}`,
        swarmRunId: `run-${i}`,
        durationMs: 5000,
        outcome: 'completed',
        retryCount: 0,
        verificationAttempts: 1,
      });
    }

    const ranker = new CompetencyRanker(metricsService);
    const score = ranker.scoreAgent('task-manager');
    // With 100% success rate and good efficiency, score should be > 0.7 from real data
    expect(score.score).not.toBe(0.70); // Not the bootstrap score
    expect(score.score).toBeGreaterThan(0.8); // Real metrics are better
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. SELF-HEALING DEFAULT RESTART
// ═══════════════════════════════════════════════════════════════════════

test.describe('Self-Healing Default Restart', () => {
  test('createDefaultRestartFn returns a function', () => {
    const metricsService = new AgentMetricsService();
    const healthMonitor = new AgentHealthMonitor(metricsService);
    const restartFn = createDefaultRestartFn(healthMonitor);
    expect(typeof restartFn).toBe('function');
  });

  test('SelfHealingPipeline with default restart can heal unhealthy agents', async () => {
    const metricsService = new AgentMetricsService();
    // Create an agent that will be unhealthy (high error rate)
    for (let i = 0; i < 5; i++) {
      metricsService.recordExecution({
        agentId: 'sick-agent',
        ticketExternalId: `ISSUE-${i}`,
        swarmRunId: `run-${i}`,
        durationMs: 5000,
        outcome: 'failed',
        retryCount: 0,
        verificationAttempts: 1,
      });
    }

    const healthMonitor = new AgentHealthMonitor(metricsService);
    const restartFn = createDefaultRestartFn(healthMonitor);
    const pipeline = new SelfHealingPipeline(healthMonitor, restartFn);

    const results = await pipeline.runHealingCycle();
    // The agent should be detected as unhealthy and remediation attempted
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].agentId).toBe('sick-agent');
    expect(results[0].actions.length).toBeGreaterThanOrEqual(3);
    expect(results[0].actions[0].phase).toBe('identify');
  });

  test('AgentHealthMonitor.resetAgent clears health history', () => {
    const metricsService = new AgentMetricsService();
    metricsService.recordExecution({
      agentId: 'agent-x',
      ticketExternalId: 'T1',
      swarmRunId: 'R1',
      durationMs: 5000,
      outcome: 'failed',
      retryCount: 0,
      verificationAttempts: 1,
    });

    const healthMonitor = new AgentHealthMonitor(metricsService);
    healthMonitor.checkAll();
    expect(healthMonitor.getHistory().length).toBeGreaterThan(0);

    healthMonitor.resetAgent('agent-x');
    const remaining = healthMonitor.getHistory().filter((h) => h.agentId === 'agent-x');
    expect(remaining).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. ROUTING AUDIT LOG WITHOUT INLINE SCHEMA
// ═══════════════════════════════════════════════════════════════════════

test.describe('RoutingAuditLog — in-memory without schema creation', () => {
  test('works in-memory without a database pool', async () => {
    const auditLog = new RoutingAuditLog();
    await auditLog.record({
      taskId: 'task-1',
      winnerAgentId: 'agent-a',
      strategy: 'keyword',
      winnerScore: 0.85,
      candidateCount: 3,
      candidates: [{ agentId: 'agent-a', score: 0.85, reason: 'keyword-match' }],
      tiersAttempted: ['bid', 'keyword'],
      durationMs: 50,
      createdAt: new Date().toISOString(),
    });

    const entries = auditLog.query();
    expect(entries).toHaveLength(1);
    expect(entries[0].winnerAgentId).toBe('agent-a');
    expect(entries[0].strategy).toBe('keyword');
  });

  test('getStrategyDistribution tracks strategy usage', async () => {
    const auditLog = new RoutingAuditLog();
    await auditLog.record(buildAuditEntry('task-1', 'agent-a', 'bid'));
    await auditLog.record(buildAuditEntry('task-2', 'agent-b', 'keyword'));
    await auditLog.record(buildAuditEntry('task-3', 'agent-a', 'keyword'));

    const dist = auditLog.getStrategyDistribution();
    expect(dist['bid']).toBe(1);
    expect(dist['keyword']).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════════════════════

function buildCostEvent(
  agentId: string, modelId: string,
  inputTokens: number, outputTokens: number,
  inputCost: number, outputCost: number,
): CostEvent {
  return {
    taskId: `task-${Date.now()}`,
    agentId,
    providerId: 'anthropic',
    modelId,
    inputTokens,
    outputTokens,
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
    currency: 'USD',
  };
}

function buildAuditEntry(taskId: string, agentId: string, strategy: string) {
  return {
    taskId,
    winnerAgentId: agentId,
    strategy,
    winnerScore: 0.8,
    candidateCount: 2,
    candidates: [{ agentId, score: 0.8, reason: 'test' }],
    tiersAttempted: [strategy],
    durationMs: 10,
    createdAt: new Date().toISOString(),
  };
}
