/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added integration tests for WS-7 operational intelligence services
 */

import { expect, test } from '@playwright/test';
import { CostTrackingService, type CostEvent } from '../src/features/operational-intelligence/services/cost-tracking-service';
import { AgentMetricsService, type AgentExecutionEvent } from '../src/features/operational-intelligence/services/agent-metrics-service';
import { RoutingAuditLog, type RoutingAuditEntry } from '../src/features/operational-intelligence/services/routing-audit-log';
import { CompetencyRanker } from '../src/features/operational-intelligence/services/competency-ranker';
import { StuckAgentWatchdog } from '../src/features/operational-intelligence/services/stuck-agent-watchdog';
import { FeedbackLoopService, type FeedbackRecord } from '../src/features/operational-intelligence/services/feedback-loop-service';
import { PrivateMeshManager } from '../src/features/operational-intelligence/services/private-mesh-manager';
import { AgentHealthMonitor } from '../src/features/operational-intelligence/services/agent-health-monitor';
import { SelfHealingPipeline } from '../src/features/operational-intelligence/services/self-healing-pipeline';
import { resolveUsageCost } from '../src/features/llm-provider';

// ═══════════════════════════════════════════════════════════════════════
// 1. COST TRACKING
// ═══════════════════════════════════════════════════════════════════════

test.describe('CostTrackingService', () => {
  test('records cost events and tracks running total', async () => {
    const service = new CostTrackingService();
    await service.recordCost(buildCostEvent('agent-a', 'claude-sonnet', 0.003));
    await service.recordCost(buildCostEvent('agent-b', 'claude-opus', 0.015));

    expect(service.getRunningTotal()).toBeCloseTo(0.018, 4);
  });

  test('getSummary aggregates by agent, model, and provider', async () => {
    const service = new CostTrackingService();
    await service.recordCost(buildCostEvent('agent-a', 'claude-sonnet', 0.003));
    await service.recordCost(buildCostEvent('agent-a', 'claude-sonnet', 0.004));
    await service.recordCost(buildCostEvent('agent-b', 'claude-opus', 0.015));

    const summary = service.getSummary();
    expect(summary.totalRequests).toBe(3);
    expect(summary.totalCost).toBeCloseTo(0.022, 4);
    expect(summary.byAgent['agent-a'].requests).toBe(2);
    expect(summary.byAgent['agent-b'].requests).toBe(1);
    expect(summary.byModel['claude-sonnet'].requests).toBe(2);
    expect(summary.byModel['claude-opus'].requests).toBe(1);
  });

  test('getSummary filters by agentId', async () => {
    const service = new CostTrackingService();
    await service.recordCost(buildCostEvent('agent-a', 'claude-sonnet', 0.003));
    await service.recordCost(buildCostEvent('agent-b', 'claude-opus', 0.015));

    const summary = service.getSummary({ agentId: 'agent-a' });
    expect(summary.totalRequests).toBe(1);
    expect(summary.totalCost).toBeCloseTo(0.003, 4);
  });

  test('getRecentEvents returns last N events', async () => {
    const service = new CostTrackingService();
    for (let i = 0; i < 5; i++) {
      await service.recordCost(buildCostEvent(`agent-${i}`, 'model', i * 0.001));
    }
    expect(service.getRecentEvents(3)).toHaveLength(3);
  });

  test('upserts missing swarm task rows and persists usage_by_model', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes('FROM chat_tasks') && sql.includes('WHERE task_id = $1')) {
          return { rows: [] };
        }
        return { rows: [], rowCount: 1 };
      },
    } as any;

    const service = new CostTrackingService(pool);
    await service.recordCost({
      taskId: 'swarm-task-1',
      agentId: 'code-developer',
      providerId: 'claude-code',
      modelId: 'gpt-5.3-codex',
      inputTokens: 1200,
      outputTokens: 300,
      inputCost: 0.0024,
      outputCost: 0.0024,
      totalCost: 0.0048,
      currency: 'USD',
      ticketExternalId: 'ISSUE-500',
      estimated: true,
    });

    const insert = queries.find((entry) => entry.sql.includes('INSERT INTO chat_tasks'));
    expect(insert).toBeTruthy();
    const usageByModel = JSON.parse(String(insert?.params[15] ?? '{}')) as Record<string, { totalTokens: number; requestCount: number }>;
    expect(usageByModel['gpt-5.3-codex'].totalTokens).toBe(1500);
    expect(usageByModel['gpt-5.3-codex'].requestCount).toBe(1);
  });

  test('queryCostFromDB rebuilds by-model and by-provider summaries from persisted usage', async () => {
    const pool = {
      query: async () => ({
        rows: [
          {
            agent_id: 'code-developer',
            provider_id: 'claude-code',
            total_cost: '0.0060',
            total_input_tokens: '1000',
            total_output_tokens: '500',
            total_requests: '2',
            usage_by_model: {
              'gpt-5.3-codex': {
                inputTokens: 1000,
                outputTokens: 500,
                totalTokens: 1500,
                inputCost: 0.002,
                outputCost: 0.004,
                totalCost: 0.006,
                requestCount: 2,
              },
            },
          },
          {
            agent_id: 'code-reviewer',
            provider_id: 'anthropic',
            total_cost: '0.0030',
            total_input_tokens: '600',
            total_output_tokens: '200',
            total_requests: '1',
            usage_by_model: {
              'claude-sonnet-4-20250514': {
                inputTokens: 600,
                outputTokens: 200,
                totalTokens: 800,
                inputCost: 0.0018,
                outputCost: 0.0012,
                totalCost: 0.003,
                requestCount: 1,
              },
            },
          },
        ],
      }),
    } as any;

    const service = new CostTrackingService(pool);
    const summary = await service.queryCostFromDB();
    expect(summary).not.toBeNull();
    expect(summary?.totalRequests).toBe(3);
    expect(summary?.byProvider['claude-code'].requests).toBe(2);
    expect(summary?.byModel['gpt-5.3-codex'].tokens).toBe(1500);
    expect(summary?.byModel['claude-sonnet-4-20250514'].cost).toBeCloseTo(0.003, 6);
  });
});

test.describe('Usage Cost Resolver', () => {
  test('estimates codex cost when tokens are present but provider cost is zero', () => {
    const resolved = resolveUsageCost({
      providerCost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: 'USD' },
      usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
      providerId: 'claude-code',
      modelId: 'gpt-5.3-codex',
    });

    expect(resolved.estimated).toBe(true);
    expect(resolved.pricingSource).toBe('fallback-map');
    expect(resolved.inputCost).toBeCloseTo(0.002, 6);
    expect(resolved.outputCost).toBeCloseTo(0.004, 6);
    expect(resolved.totalCost).toBeCloseTo(0.006, 6);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. AGENT METRICS
// ═══════════════════════════════════════════════════════════════════════

test.describe('AgentMetricsService', () => {
  test('records execution events and computes metrics', () => {
    const service = new AgentMetricsService();
    service.recordExecution(buildExecEvent('agent-a', 'completed', 5000, 0));
    service.recordExecution(buildExecEvent('agent-a', 'completed', 3000, 1));
    service.recordExecution(buildExecEvent('agent-a', 'failed', 10000, 2));

    const metrics = service.getMetrics('agent-a');
    expect(metrics.totalExecutions).toBe(3);
    expect(metrics.successCount).toBe(2);
    expect(metrics.failureCount).toBe(1);
    expect(metrics.successRate).toBeCloseTo(0.667, 2);
    expect(metrics.avgDurationMs).toBeCloseTo(6000, 0);
  });

  test('getAllMetrics returns metrics for all agents', () => {
    const service = new AgentMetricsService();
    service.recordExecution(buildExecEvent('agent-a', 'completed', 5000, 0));
    service.recordExecution(buildExecEvent('agent-b', 'failed', 8000, 1));

    const all = service.getAllMetrics();
    expect(all).toHaveLength(2);
    expect(all.find((m) => m.agentId === 'agent-a')?.successRate).toBe(1);
    expect(all.find((m) => m.agentId === 'agent-b')?.successRate).toBe(0);
  });

  test('getRankedMetrics sorts by success rate descending', () => {
    const service = new AgentMetricsService();
    service.recordExecution(buildExecEvent('agent-a', 'completed', 5000, 0));
    service.recordExecution(buildExecEvent('agent-b', 'failed', 8000, 1));
    service.recordExecution(buildExecEvent('agent-c', 'completed', 3000, 0));
    service.recordExecution(buildExecEvent('agent-c', 'completed', 2000, 0));

    const ranked = service.getRankedMetrics();
    expect(ranked[0].agentId).toBe('agent-a'); // 100% or agent-c 100%
    expect(ranked[ranked.length - 1].agentId).toBe('agent-b'); // 0%
  });

  test('returns zero metrics for unknown agent', () => {
    const service = new AgentMetricsService();
    const metrics = service.getMetrics('unknown');
    expect(metrics.totalExecutions).toBe(0);
    expect(metrics.successRate).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. ROUTING AUDIT LOG
// ═══════════════════════════════════════════════════════════════════════

test.describe('RoutingAuditLog', () => {
  test('records and queries routing decisions', async () => {
    const log = new RoutingAuditLog();
    await log.record(buildAuditEntry('task-1', 'agent-a', 'bid'));
    await log.record(buildAuditEntry('task-2', 'agent-b', 'keyword'));
    await log.record(buildAuditEntry('task-3', 'agent-a', 'score'));

    const all = log.query();
    expect(all).toHaveLength(3);
  });

  test('filters by agentId', async () => {
    const log = new RoutingAuditLog();
    await log.record(buildAuditEntry('task-1', 'agent-a', 'bid'));
    await log.record(buildAuditEntry('task-2', 'agent-b', 'keyword'));

    const filtered = log.query({ agentId: 'agent-a' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].winnerAgentId).toBe('agent-a');
  });

  test('filters by strategy', async () => {
    const log = new RoutingAuditLog();
    await log.record(buildAuditEntry('task-1', 'agent-a', 'bid'));
    await log.record(buildAuditEntry('task-2', 'agent-b', 'keyword'));

    const filtered = log.query({ strategy: 'keyword' });
    expect(filtered).toHaveLength(1);
  });

  test('getStrategyDistribution returns correct counts', async () => {
    const log = new RoutingAuditLog();
    await log.record(buildAuditEntry('t1', 'a', 'bid'));
    await log.record(buildAuditEntry('t2', 'b', 'bid'));
    await log.record(buildAuditEntry('t3', 'c', 'keyword'));

    const dist = log.getStrategyDistribution();
    expect(dist['bid']).toBe(2);
    expect(dist['keyword']).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. COMPETENCY RANKER
// ═══════════════════════════════════════════════════════════════════════

test.describe('CompetencyRanker', () => {
  test('scores agent based on metrics (above cold-start threshold)', () => {
    const metrics = new AgentMetricsService();
    // Need 5+ executions to exceed cold-start threshold
    for (let i = 0; i < 6; i++) {
      metrics.recordExecution(buildExecEvent('agent-a', 'completed', 4000, 0));
    }

    const ranker = new CompetencyRanker(metrics);
    const score = ranker.scoreAgent('agent-a');
    expect(score.score).toBeGreaterThan(0.5); // Good agent should score above neutral
    expect(score.breakdown.successRateScore).toBe(1); // 100% success rate
  });

  test('new agent gets neutral score (0.5)', () => {
    const metrics = new AgentMetricsService();
    const ranker = new CompetencyRanker(metrics);
    const score = ranker.scoreAgent('unknown');
    expect(score.score).toBe(0.5);
  });

  test('rankAll orders agents by competency (above cold-start threshold)', () => {
    const metrics = new AgentMetricsService();
    // Need 5+ executions per agent to exceed cold-start threshold
    for (let i = 0; i < 6; i++) {
      metrics.recordExecution(buildExecEvent('good-agent', 'completed', 2500, 0));
      metrics.recordExecution(buildExecEvent('bad-agent', 'failed', 35000, 3));
    }

    const ranker = new CompetencyRanker(metrics);
    const ranked = ranker.rankAll();
    expect(ranked[0].agentId).toBe('good-agent');
    expect(ranked[0].rank).toBe(1);
    expect(ranked[1].agentId).toBe('bad-agent');
    expect(ranked[1].rank).toBe(2);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  test('applyBoosts adds competency score to routing candidates (above cold-start threshold)', () => {
    const metrics = new AgentMetricsService();
    // Need 5+ executions to exceed cold-start threshold
    for (let i = 0; i < 6; i++) {
      metrics.recordExecution(buildExecEvent('agent-a', 'completed', 2000, 0));
    }

    const ranker = new CompetencyRanker(metrics);
    const candidates = [
      { agentId: 'agent-a', score: 5 },
      { agentId: 'unknown', score: 5 },
    ];

    ranker.applyBoosts(candidates);
    expect(candidates[0].score).toBeGreaterThan(candidates[1].score);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. STUCK AGENT WATCHDOG
// ═══════════════════════════════════════════════════════════════════════

test.describe('StuckAgentWatchdog', () => {
  test('creates watchdog without pool (in-memory only)', () => {
    const watchdog = new StuckAgentWatchdog();
    expect(watchdog).toBeDefined();
  });

  test('check returns empty array without pool', async () => {
    const watchdog = new StuckAgentWatchdog();
    const stuck = await watchdog.check();
    expect(stuck).toEqual([]);
  });

  test('getActions returns empty initially', () => {
    const watchdog = new StuckAgentWatchdog();
    expect(watchdog.getActions()).toEqual([]);
  });

  test('start and stop without errors', () => {
    const watchdog = new StuckAgentWatchdog(null, { pollIntervalMs: 60000 });
    watchdog.start();
    watchdog.stop();
    // Should not throw
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. FEEDBACK LOOP
// ═══════════════════════════════════════════════════════════════════════

test.describe('FeedbackLoopService', () => {
  test('records feedback and computes agent stats', async () => {
    const metrics = new AgentMetricsService();
    const service = new FeedbackLoopService(null, metrics);

    await service.submitFeedback(buildFeedback('agent-a', 'accept'));
    await service.submitFeedback(buildFeedback('agent-a', 'accept'));
    await service.submitFeedback(buildFeedback('agent-a', 'reject'));

    const stats = service.getAgentStats('agent-a');
    expect(stats.totalFeedback).toBe(3);
    expect(stats.acceptCount).toBe(2);
    expect(stats.rejectCount).toBe(1);
    expect(stats.acceptRate).toBeCloseTo(0.667, 2);
  });

  test('feeds verdicts back into agent metrics', async () => {
    const metrics = new AgentMetricsService();
    const service = new FeedbackLoopService(null, metrics);

    await service.submitFeedback(buildFeedback('agent-a', 'accept'));
    await service.submitFeedback(buildFeedback('agent-a', 'reject'));

    const agentMetrics = metrics.getMetrics('agent-a');
    expect(agentMetrics.totalExecutions).toBe(2);
    expect(agentMetrics.successCount).toBe(1); // accept = completed
    expect(agentMetrics.failureCount).toBe(1); // reject = failed
  });

  test('getAllStats returns stats for all agents sorted by accept rate', async () => {
    const service = new FeedbackLoopService();
    await service.submitFeedback(buildFeedback('good-agent', 'accept'));
    await service.submitFeedback(buildFeedback('good-agent', 'accept'));
    await service.submitFeedback(buildFeedback('bad-agent', 'reject'));

    const allStats = service.getAllStats();
    expect(allStats[0].agentId).toBe('good-agent');
    expect(allStats[0].acceptRate).toBe(1);
    expect(allStats[1].agentId).toBe('bad-agent');
    expect(allStats[1].acceptRate).toBe(0);
  });

  test('getRecentFeedback returns last N records', async () => {
    const service = new FeedbackLoopService();
    for (let i = 0; i < 5; i++) {
      await service.submitFeedback(buildFeedback(`agent-${i}`, 'accept'));
    }
    expect(service.getRecentFeedback(3)).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. PRIVATE MESH MANAGER
// ═══════════════════════════════════════════════════════════════════════

test.describe('PrivateMeshManager', () => {
  test('creates a breakout channel with participants', () => {
    const mgr = new PrivateMeshManager();
    const channel = mgr.createChannel({
      createdBy: 'project-manager',
      participants: ['architect-bot', 'code-developer'],
      ticketExternalId: 'ticket-1',
      phase: 4,
    });

    expect(channel.channelId).toBeDefined();
    expect(channel.channelName).toContain('swarm.breakout.');
    expect(channel.participants).toHaveLength(2);
    expect(channel.expired).toBe(false);
  });

  test('getActiveChannels returns non-expired channels', () => {
    const mgr = new PrivateMeshManager();
    mgr.createChannel({ createdBy: 'pm', participants: ['a'], expiryMs: 60000 });
    mgr.createChannel({ createdBy: 'pm', participants: ['b'], expiryMs: 60000 });

    expect(mgr.getActiveChannels()).toHaveLength(2);
  });

  test('closeChannel marks channel as expired', () => {
    const mgr = new PrivateMeshManager();
    const channel = mgr.createChannel({ createdBy: 'pm', participants: ['a'] });
    mgr.closeChannel(channel.channelId);

    expect(mgr.getChannel(channel.channelId)?.expired).toBe(true);
    expect(mgr.getActiveChannels()).toHaveLength(0);
  });

  test('closeChannelsForPhase closes all channels for a ticket+phase', () => {
    const mgr = new PrivateMeshManager();
    mgr.createChannel({ createdBy: 'pm', participants: ['a'], ticketExternalId: 't1', phase: 4 });
    mgr.createChannel({ createdBy: 'pm', participants: ['b'], ticketExternalId: 't1', phase: 4 });
    mgr.createChannel({ createdBy: 'pm', participants: ['c'], ticketExternalId: 't1', phase: 5 }); // different phase

    const closed = mgr.closeChannelsForPhase('t1', 4);
    expect(closed).toBe(2);
    expect(mgr.getActiveChannels()).toHaveLength(1); // phase 5 still active
  });

  test('sendOnChannel rejects non-participant', async () => {
    const mgr = new PrivateMeshManager();
    const channel = mgr.createChannel({ createdBy: 'pm', participants: ['agent-a'] });
    await mgr.sendOnChannel(channel.channelId, 'intruder', { msg: 'hello' });
    expect(channel.messageCount).toBe(0); // message not sent
  });

  test('sendOnChannel increments message count for participants', async () => {
    const mgr = new PrivateMeshManager();
    const channel = mgr.createChannel({ createdBy: 'pm', participants: ['agent-a'] });
    await mgr.sendOnChannel(channel.channelId, 'agent-a', { msg: 'hello' });
    expect(mgr.getChannel(channel.channelId)?.messageCount).toBe(1);
  });

  test('start and stop cleanup without errors', () => {
    const mgr = new PrivateMeshManager();
    mgr.startCleanup(60000);
    mgr.stopCleanup();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════════════════════

function buildCostEvent(agentId: string, modelId: string, totalCost: number): CostEvent {
  return {
    taskId: `task-${agentId}`,
    agentId,
    providerId: 'anthropic',
    modelId,
    inputTokens: Math.round(totalCost * 100000),
    outputTokens: Math.round(totalCost * 50000),
    inputCost: totalCost * 0.6,
    outputCost: totalCost * 0.4,
    totalCost,
    currency: 'USD',
  };
}

function buildExecEvent(
  agentId: string,
  outcome: 'completed' | 'failed' | 'escalated',
  durationMs: number,
  retryCount: number,
): AgentExecutionEvent {
  return {
    agentId,
    ticketExternalId: `ticket-${agentId}`,
    swarmRunId: `run-${agentId}`,
    durationMs,
    outcome,
    retryCount,
    verificationAttempts: retryCount + 1,
  };
}

function buildAuditEntry(taskId: string, winnerAgentId: string, strategy: string): RoutingAuditEntry {
  return {
    taskId,
    winnerAgentId,
    strategy,
    winnerScore: 5,
    candidateCount: 3,
    candidates: [
      { agentId: winnerAgentId, score: 5, reason: 'test' },
      { agentId: 'other-1', score: 3, reason: 'test' },
      { agentId: 'other-2', score: 1, reason: 'test' },
    ],
    tiersAttempted: [strategy],
    durationMs: 10,
    createdAt: new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 8. AGENT HEALTH MONITOR
// ═══════════════════════════════════════════════════════════════════════

test.describe('AgentHealthMonitor', () => {
  test('assesses healthy agent correctly', () => {
    const metrics = new AgentMetricsService();
    metrics.recordExecution(buildExecEvent('agent-a', 'completed', 5000, 0));
    metrics.recordExecution(buildExecEvent('agent-a', 'completed', 3000, 0));

    const monitor = new AgentHealthMonitor(metrics);
    const check = monitor.assessAgent('agent-a');
    expect(check.status).toBe('healthy');
    expect(check.checks.every((c) => c.passed)).toBe(true);
  });

  test('detects error-looping agent', () => {
    const metrics = new AgentMetricsService();
    metrics.recordExecution(buildExecEvent('bad-agent', 'failed', 5000, 1));
    metrics.recordExecution(buildExecEvent('bad-agent', 'failed', 5000, 2));
    metrics.recordExecution(buildExecEvent('bad-agent', 'failed', 5000, 3));

    const monitor = new AgentHealthMonitor(metrics);
    const check = monitor.assessAgent('bad-agent');
    expect(check.status).toBe('error_looping');
  });

  test('checkAll returns results for all agents', () => {
    const metrics = new AgentMetricsService();
    metrics.recordExecution(buildExecEvent('a', 'completed', 1000, 0));
    metrics.recordExecution(buildExecEvent('b', 'failed', 1000, 1));

    const monitor = new AgentHealthMonitor(metrics);
    const results = monitor.checkAll();
    expect(results).toHaveLength(2);
  });

  test('getUnhealthyAgents filters to non-healthy only', () => {
    const metrics = new AgentMetricsService();
    metrics.recordExecution(buildExecEvent('good', 'completed', 1000, 0));
    metrics.recordExecution(buildExecEvent('bad', 'failed', 1000, 1));
    metrics.recordExecution(buildExecEvent('bad', 'failed', 1000, 1));
    metrics.recordExecution(buildExecEvent('bad', 'failed', 1000, 1));

    const monitor = new AgentHealthMonitor(metrics);
    monitor.checkAll();
    const unhealthy = monitor.getUnhealthyAgents();
    expect(unhealthy.length).toBeGreaterThanOrEqual(1);
    expect(unhealthy.every((u) => u.agentId === 'bad')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 9. SELF-HEALING PIPELINE
// ═══════════════════════════════════════════════════════════════════════

test.describe('SelfHealingPipeline', () => {
  test('no-ops when all agents are healthy', async () => {
    const metrics = new AgentMetricsService();
    metrics.recordExecution(buildExecEvent('good', 'completed', 1000, 0));

    const monitor = new AgentHealthMonitor(metrics);
    const pipeline = new SelfHealingPipeline(monitor);
    const results = await pipeline.runHealingCycle();
    expect(results).toHaveLength(0);
  });

  test('escalates unhealthy agent when no restart function', async () => {
    const metrics = new AgentMetricsService();
    metrics.recordExecution(buildExecEvent('bad', 'failed', 1000, 1));
    metrics.recordExecution(buildExecEvent('bad', 'failed', 1000, 1));
    metrics.recordExecution(buildExecEvent('bad', 'failed', 1000, 1));

    const monitor = new AgentHealthMonitor(metrics);
    const pipeline = new SelfHealingPipeline(monitor);
    const results = await pipeline.runHealingCycle();

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].outcome).toBe('escalated');
    expect(results[0].actions.some((a) => a.phase === 'escalate')).toBe(true);
  });

  test('attempts restart and verifies when restart function provided', async () => {
    const metrics = new AgentMetricsService();
    metrics.recordExecution(buildExecEvent('sick', 'failed', 1000, 1));
    metrics.recordExecution(buildExecEvent('sick', 'failed', 1000, 1));
    metrics.recordExecution(buildExecEvent('sick', 'failed', 1000, 1));

    const monitor = new AgentHealthMonitor(metrics);
    const restartFn = async () => true;
    const pipeline = new SelfHealingPipeline(monitor, restartFn);
    const results = await pipeline.runHealingCycle();

    expect(results.length).toBeGreaterThanOrEqual(1);
    const actions = results[0].actions;
    expect(actions.some((a) => a.phase === 'remediate' && a.success)).toBe(true);
    expect(actions.some((a) => a.phase === 'verify')).toBe(true);
  });

  test('getActions returns all remediation history', async () => {
    const metrics = new AgentMetricsService();
    metrics.recordExecution(buildExecEvent('x', 'failed', 1000, 3));
    metrics.recordExecution(buildExecEvent('x', 'failed', 1000, 3));
    metrics.recordExecution(buildExecEvent('x', 'failed', 1000, 3));

    const monitor = new AgentHealthMonitor(metrics);
    const pipeline = new SelfHealingPipeline(monitor);
    await pipeline.runHealingCycle();
    expect(pipeline.getActions().length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════════════════════

let feedbackCounter = 0;
function buildFeedback(agentId: string, verdict: 'accept' | 'reject' | 'revise'): FeedbackRecord {
  feedbackCounter += 1;
  return {
    feedbackId: `fb-${feedbackCounter}`,
    ticketExternalId: `ticket-${agentId}-${feedbackCounter}`,
    agentId,
    verdict,
    createdAt: new Date().toISOString(),
  };
}
