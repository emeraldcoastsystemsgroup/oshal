/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Session 18: Vitest unit tests for Phase 8 trigger, metrics collector functional test, cost rollup schema, credential broadcast, refactoring compliance
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: update the historical credential-broadcast guard to require the unordered raw Redis publication path to remain absent.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Phase 8 Architecture Pre-Round
// ---------------------------------------------------------------------------

describe('Phase 8: isArchitecturePhaseEnabled logic', () => {
  it('auto-enables for high complexity when env var unset', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.resolve(__dirname, '../../src/features/swarm-orchestration/services/planning-round-orchestrator.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).toContain("return complexity === 'high'");
  });

  it('respects explicit USE_ARCHITECTURE_PHASE=false override', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.resolve(__dirname, '../../src/features/swarm-orchestration/services/planning-round-orchestrator.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).toContain("process.env.USE_ARCHITECTURE_PHASE === 'false'");
  });

  it('logs Phase 8 trigger decision with complexity and env var', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.resolve(__dirname, '../../src/features/swarm-orchestration/services/planning-round-orchestrator.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).toContain('Phase 8 (Architecture Pre-Round) trigger decision');
  });
});

// ---------------------------------------------------------------------------
// SwarmMetricsCollector Functional Tests
// ---------------------------------------------------------------------------

describe('SwarmMetricsCollector functional behavior', () => {
  it('records metrics and computes aggregated stats', async () => {
    const { SwarmMetricsCollector } = await import(
      '../../src/features/swarm-orchestration/services/swarm-metrics-collector'
    );

    const collector = new SwarmMetricsCollector({ logOnCollect: false });

    collector.recordTicketMetrics({
      ticketId: 'test-1',
      runId: 'run-1',
      agentId: 'code-developer',
      complexity: 'medium',
      phases: [
        { phase: 'intake', phaseIndex: 1, durationMs: 100, agentId: 'code-developer', rounds: 1, status: 'completed', artifactsValid: true, handoverWritten: true },
        { phase: 'execution', phaseIndex: 2, durationMs: 2000, agentId: 'code-developer', rounds: 1, status: 'completed', artifactsValid: true, handoverWritten: true },
      ],
      totalDurationMs: 2100,
      outcome: 'completed',
      regressionCount: 0,
      executionAttempts: 1,
      verificationAttempts: 0,
      artifactComplianceScore: 1.0,
      handoverCount: 2,
      staleLoopDetected: false,
      approvalRequired: false,
      completedAt: new Date().toISOString(),
    });

    collector.recordTicketMetrics({
      ticketId: 'test-2',
      runId: 'run-2',
      agentId: 'tester-bot',
      complexity: 'high',
      phases: [
        { phase: 'testing', phaseIndex: 1, durationMs: 500, agentId: 'tester-bot', rounds: 1, status: 'failed', artifactsValid: false, handoverWritten: false },
      ],
      totalDurationMs: 500,
      outcome: 'escalated',
      regressionCount: 1,
      executionAttempts: 2,
      verificationAttempts: 1,
      artifactComplianceScore: 0.5,
      handoverCount: 1,
      staleLoopDetected: false,
      approvalRequired: true,
      completedAt: new Date().toISOString(),
    });

    const agg = collector.getAggregatedMetrics();
    expect(agg.totalRuns).toBe(2);
    expect(agg.completedRuns).toBe(1);
    expect(agg.escalatedRuns).toBe(1);
    expect(agg.averageDurationMs).toBe(1300);
    expect(agg.approvalRequiredRate).toBe(0.5);

    const agentPerf = collector.getAgentPerformance();
    expect(agentPerf.length).toBe(2);

    const devPerf = agentPerf.find(a => a.agentId === 'code-developer');
    expect(devPerf?.completedCount).toBe(1);
    expect(devPerf?.failedCount).toBe(0);

    const testerPerf = agentPerf.find(a => a.agentId === 'tester-bot');
    expect(testerPerf?.completedCount).toBe(0);
    expect(testerPerf?.failedCount).toBe(0); // escalated, not failed
  });

  it('computes phase completion rates', async () => {
    const { SwarmMetricsCollector } = await import(
      '../../src/features/swarm-orchestration/services/swarm-metrics-collector'
    );

    const collector = new SwarmMetricsCollector({ logOnCollect: false });

    collector.recordTicketMetrics({
      ticketId: 'test-3',
      runId: 'run-3',
      agentId: 'dev',
      complexity: 'low',
      phases: [
        { phase: 'execution', phaseIndex: 1, durationMs: 1000, agentId: 'dev', rounds: 1, status: 'completed', artifactsValid: true, handoverWritten: true },
        { phase: 'testing', phaseIndex: 2, durationMs: 300, agentId: 'dev', rounds: 1, status: 'failed', artifactsValid: false, handoverWritten: false },
      ],
      totalDurationMs: 1300,
      outcome: 'failed',
      regressionCount: 0,
      executionAttempts: 1,
      verificationAttempts: 1,
      artifactComplianceScore: 0.5,
      handoverCount: 1,
      staleLoopDetected: false,
      approvalRequired: false,
      completedAt: new Date().toISOString(),
    });

    const agg = collector.getAggregatedMetrics();
    expect(agg.phaseCompletionRates['execution']).toBe(1.0);
    expect(agg.phaseCompletionRates['testing']).toBe(0);
    expect(agg.topFailurePhases[0].phase).toBe('testing');
    expect(agg.topFailurePhases[0].failureCount).toBe(1);
  });

  it('respects maxRetainedMetrics circular buffer', async () => {
    const { SwarmMetricsCollector } = await import(
      '../../src/features/swarm-orchestration/services/swarm-metrics-collector'
    );

    const collector = new SwarmMetricsCollector({ maxRetainedMetrics: 2, logOnCollect: false });

    for (let i = 0; i < 5; i++) {
      collector.recordTicketMetrics({
        ticketId: `ticket-${i}`,
        runId: `run-${i}`,
        agentId: 'agent',
        complexity: 'low',
        phases: [],
        totalDurationMs: 100 * (i + 1),
        outcome: 'completed',
        regressionCount: 0,
        executionAttempts: 1,
        verificationAttempts: 0,
        artifactComplianceScore: 1.0,
        handoverCount: 0,
        staleLoopDetected: false,
        approvalRequired: false,
        completedAt: new Date().toISOString(),
      });
    }

    const recent = collector.getRecentMetrics();
    expect(recent.length).toBe(2);
    // Most recent first
    expect(recent[0].ticketId).toBe('ticket-4');
    expect(recent[1].ticketId).toBe('ticket-3');
  });
});

// ---------------------------------------------------------------------------
// Cost Rollup
// ---------------------------------------------------------------------------

describe('Cost rollup schema', () => {
  it('has recursive WITH RECURSIVE ticket_tree CTE', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.resolve(__dirname, '../../src/shared/services/database/ticket-schema.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).toContain('WITH RECURSIVE ticket_tree');
    expect(content).toContain('child_ticket_count');
  });
});

// ---------------------------------------------------------------------------
// OAuth Broadcast Retirement
// ---------------------------------------------------------------------------

describe('OpenAI Codex credential Redis broadcast retirement', () => {
  it('keeps raw credential publication and subscription absent', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.resolve(__dirname, '../../src/features/openai-codex-oauth/services/openai-codex-oauth-service.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    expect(content).not.toContain('this.broadcastCodexCredentials(credentials)');
    expect(content).not.toContain('CODEX_CREDENTIAL_CHANNEL');
    expect(content).not.toContain('swarm.codex-credentials.update');
    expect(content).not.toContain('subscribeToBroadcast');
  });
});

// ---------------------------------------------------------------------------
// 1000-line Governance
// ---------------------------------------------------------------------------

describe('File size governance', () => {
  it('swarm-ticket-processing-service.ts under 1000 lines', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const filePath = path.resolve(__dirname, '../../src/features/swarm-orchestration/services/swarm-ticket-processing-service.ts');
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').length;

    expect(lines).toBeLessThanOrEqual(1000);
  });
});
