/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Validation tests for Stages 2-6 governance services. Exercises core methods of each new service without requiring infrastructure dependencies.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Governance closeout: backfilled changelog continuity for stage-validation coverage used during BF-029 stabilization
 */

import { test, expect } from '@playwright/test';

// These tests validate the new governance services created in Stages 2-6.
// They import the services directly and test their pure logic without UI or infra.

test.describe('Stage 2: QueueGovernanceService', () => {
  test('lifecycle state transitions are validated', async () => {
    const { QueueGovernanceService, InMemoryGovernanceStore } = await import(
      '../src/features/swarm-orchestration/services/queue-governance-service'
    );

    const store = new InMemoryGovernanceStore();
    const service = new QueueGovernanceService(store);

    // Initialize ticket
    const record = await service.initializeTicket('ticket-1');
    expect(record.state).toBe('todo');
    expect(record.ticketId).toBe('ticket-1');

    // Valid transition: todo → routing
    const routed = await service.transitionState('ticket-1', 'routing');
    expect(routed?.state).toBe('routing');

    // Valid transition: routing → in_progress
    const inProgress = await service.transitionState('ticket-1', 'in_progress');
    expect(inProgress?.state).toBe('in_progress');

    // Invalid transition: in_progress → todo (not allowed)
    const invalid = await service.transitionState('ticket-1', 'todo');
    expect(invalid).toBeNull();

    // Valid transition: in_progress → done (via in_review)
    await service.transitionState('ticket-1', 'in_review');
    const done = await service.transitionState('ticket-1', 'done');
    expect(done?.state).toBe('done');
  });

  test('cooldown enforcement blocks reprocessing', async () => {
    const { QueueGovernanceService, InMemoryGovernanceStore } = await import(
      '../src/features/swarm-orchestration/services/queue-governance-service'
    );

    const store = new InMemoryGovernanceStore();
    const service = new QueueGovernanceService(store, { cooldownMs: 60000 });

    await service.initializeTicket('ticket-2');
    await service.applyCooldown('ticket-2');

    const inCooldown = await service.isInCooldown('ticket-2');
    expect(inCooldown).toBe(true);
  });

  test('circuit breaker trips after consecutive failures', async () => {
    const { QueueGovernanceService, InMemoryGovernanceStore } = await import(
      '../src/features/swarm-orchestration/services/queue-governance-service'
    );

    const store = new InMemoryGovernanceStore();
    const service = new QueueGovernanceService(store, { circuitBreakerThreshold: 2 });

    await service.initializeTicket('ticket-3');

    const trip1 = await service.recordFailure('ticket-3', 'error 1');
    expect(trip1).toBe(false);

    const trip2 = await service.recordFailure('ticket-3', 'error 2');
    expect(trip2).toBe(true);

    const isTripped = await service.isCircuitBreakerTripped('ticket-3');
    expect(isTripped).toBe(true);
  });

  test('queue summary reports correct counts', async () => {
    const { QueueGovernanceService, InMemoryGovernanceStore } = await import(
      '../src/features/swarm-orchestration/services/queue-governance-service'
    );

    const store = new InMemoryGovernanceStore();
    const service = new QueueGovernanceService(store);

    await service.initializeTicket('t1');
    await service.initializeTicket('t2');
    await service.transitionState('t1', 'routing');
    await service.transitionState('t1', 'in_progress');

    const summary = await service.getQueueSummary();
    expect(summary.todo).toBe(1);
    expect(summary.in_progress).toBe(1);
  });

  test('processing eligibility checks combined gates', async () => {
    const { QueueGovernanceService, InMemoryGovernanceStore } = await import(
      '../src/features/swarm-orchestration/services/queue-governance-service'
    );

    const store = new InMemoryGovernanceStore();
    const service = new QueueGovernanceService(store);

    // New ticket is eligible
    const newEligibility = await service.checkProcessingEligibility('new-ticket');
    expect(newEligibility.eligible).toBe(true);

    // Done ticket is not eligible
    await service.initializeTicket('done-ticket');
    await service.transitionState('done-ticket', 'routing');
    await service.transitionState('done-ticket', 'in_progress');
    await service.transitionState('done-ticket', 'in_review');
    await service.transitionState('done-ticket', 'done');

    const doneEligibility = await service.checkProcessingEligibility('done-ticket');
    expect(doneEligibility.eligible).toBe(false);
  });
});

test.describe('Stage 3: PhaseRegressionService', () => {
  test('regression triggers for testing failure', async () => {
    const { PhaseRegressionService } = await import(
      '../src/features/swarm-orchestration/services/phase-regression-service'
    );

    const service = new PhaseRegressionService({ maxRegressions: 3 });

    const decision = await service.evaluateRegression(
      'ticket-1', 'testing', 'Tests failed',
      ['Unit test X failed', 'Integration test Y failed'],
      'agent-tester',
    );

    expect(decision.shouldRegress).toBe(true);
    expect(decision.regressionTarget).toBe('execution');
    expect(decision.regressionCount).toBe(1);
    expect(decision.shouldEscalate).toBe(false);
    expect(decision.feedback).toContain('testing');
    expect(decision.feedback).toContain('Tests failed');
  });

  test('regression triggers for review failure', async () => {
    const { PhaseRegressionService } = await import(
      '../src/features/swarm-orchestration/services/phase-regression-service'
    );

    const service = new PhaseRegressionService();

    const decision = await service.evaluateRegression(
      'ticket-1', 'review', 'Review rejected',
      ['Code quality insufficient'],
    );

    expect(decision.shouldRegress).toBe(true);
    expect(decision.regressionTarget).toBe('planning');
  });

  test('escalation after max regressions', async () => {
    const { PhaseRegressionService } = await import(
      '../src/features/swarm-orchestration/services/phase-regression-service'
    );

    const service = new PhaseRegressionService({ maxRegressions: 2 });

    await service.evaluateRegression('ticket-1', 'testing', 'fail 1', []);
    await service.evaluateRegression('ticket-1', 'testing', 'fail 2', []);
    const third = await service.evaluateRegression('ticket-1', 'testing', 'fail 3', []);

    expect(third.shouldRegress).toBe(false);
    expect(third.shouldEscalate).toBe(true);
  });

  test('regression count increments correctly', async () => {
    const { PhaseRegressionService } = await import(
      '../src/features/swarm-orchestration/services/phase-regression-service'
    );

    const service = new PhaseRegressionService({ maxRegressions: 5 });

    const first = await service.evaluateRegression('ticket-1', 'testing', 'fail 1', []);
    expect(first.regressionCount).toBe(1);
    expect(first.shouldRegress).toBe(true);

    const second = await service.evaluateRegression('ticket-1', 'testing', 'fail 2', []);
    expect(second.regressionCount).toBe(2);
    expect(second.shouldRegress).toBe(true);
  });

  test('feedback string includes findings and agent', async () => {
    const { PhaseRegressionService } = await import(
      '../src/features/swarm-orchestration/services/phase-regression-service'
    );

    const service = new PhaseRegressionService();
    const decision = await service.evaluateRegression(
      'ticket-1', 'testing', 'Tests failed',
      ['Test A failed', 'Test B failed'],
      'agent-qa',
    );

    expect(decision.feedback).toContain('testing');
    expect(decision.feedback).toContain('Tests failed');
    expect(decision.feedback).toContain('Test A failed');
    expect(decision.feedback).toContain('agent-qa');
  });
});

test.describe('Stage 4: WorkspaceArtifactEnforcer', () => {
  test('artifact rules exist for all 7 phases', async () => {
    const { WorkspaceArtifactEnforcer } = await import(
      '../src/features/swarm-orchestration/services/workspace-artifact-enforcer'
    );

    const enforcer = new WorkspaceArtifactEnforcer();
    const rules = enforcer.getAllRules();

    expect(rules.length).toBe(7);
    expect(rules.map((r) => r.phase)).toEqual([
      'intake', 'planning', 'specialist_input', 'execution',
      'testing', 'review', 'delivery',
    ]);
  });

  test('planning phase requires TASK-BRIEF.md and handover', async () => {
    const { WorkspaceArtifactEnforcer } = await import(
      '../src/features/swarm-orchestration/services/workspace-artifact-enforcer'
    );

    const enforcer = new WorkspaceArtifactEnforcer();
    const planningRule = enforcer.getPhaseRule('planning');

    expect(planningRule).toBeDefined();
    expect(planningRule!.requiredFiles).toContain('TASK-BRIEF.md');
    expect(planningRule!.requiresHandover).toBe(true);
  });

  test('continuation brief contains required sections', async () => {
    const { WorkspaceArtifactEnforcer } = await import(
      '../src/features/swarm-orchestration/services/workspace-artifact-enforcer'
    );

    const enforcer = new WorkspaceArtifactEnforcer({
      workspaceRoot: '/tmp/oshal-test-nonexistent',
    });

    const brief = enforcer.generateContinuationBrief(
      'test-workspace', 'ticket-123', 'execution', 4, 'timeout',
      ['Agent was processing file X'],
    );

    expect(brief.ticketId).toBe('ticket-123');
    expect(brief.phase).toBe('execution');
    expect(brief.reason).toBe('timeout');
    expect(brief.content).toContain('Continuation Brief');
    expect(brief.content).toContain('Execution Timeout');
    expect(brief.content).toContain('Instructions for Next Session');
  });
});

test.describe('Stage 5: FailureGovernanceService', () => {
  test('stale loop detected on similar outputs', async () => {
    const { FailureGovernanceService } = await import(
      '../src/features/swarm-orchestration/services/failure-governance-service'
    );

    const service = new FailureGovernanceService({
      staleLoopSimilarityThreshold: 0.8,
      staleLoopMinOutputs: 2,
    });

    const result1 = service.checkForStaleLoop('ticket-1', 'I completed the task successfully and wrote tests.');
    expect(result1.isStaleLoop).toBe(false);

    const result2 = service.checkForStaleLoop('ticket-1', 'I completed the task successfully and wrote tests.');
    expect(result2.isStaleLoop).toBe(true);
    expect(result2.similarity).toBeGreaterThan(0.8);
  });

  test('approval required for dangerous commands', async () => {
    const { FailureGovernanceService } = await import(
      '../src/features/swarm-orchestration/services/failure-governance-service'
    );

    const service = new FailureGovernanceService();

    const safe = service.checkApprovalRequired('npm install express');
    expect(safe.requiresApproval).toBe(false);

    const dangerous = service.checkApprovalRequired('rm -rf /var/data');
    expect(dangerous.requiresApproval).toBe(true);
    expect(dangerous.matchedKeywords).toContain('rm -rf');

    const sql = service.checkApprovalRequired('DROP TABLE users');
    expect(sql.requiresApproval).toBe(true);
    expect(sql.matchedKeywords).toContain('DROP TABLE');
  });

  test('approval request lifecycle', async () => {
    const { FailureGovernanceService } = await import(
      '../src/features/swarm-orchestration/services/failure-governance-service'
    );

    const service = new FailureGovernanceService();

    const request = service.submitApprovalRequest(
      'ticket-1', 'execution', 'agent-dev',
      'rm -rf old-data/', ['rm -rf'],
    );
    expect(request.status).toBe('pending');

    const pending = service.getPendingApprovals();
    expect(pending.length).toBe(1);

    const decided = service.decideApproval('ticket-1', true, 'operator-the operator');
    expect(decided?.status).toBe('approved');

    const afterDecision = service.getPendingApprovals();
    expect(afterDecision.length).toBe(0);
  });

  test('stuck agent detection', async () => {
    const { FailureGovernanceService } = await import(
      '../src/features/swarm-orchestration/services/failure-governance-service'
    );

    const service = new FailureGovernanceService({ stuckAgentThresholdMs: 100 });

    service.trackExecution('ticket-1', 'agent-dev', 'execution');

    // Immediately after tracking, agent is not stuck
    const immediate = service.detectStuckAgents();
    expect(immediate.length).toBe(0);

    // Wait and check again
    await new Promise((r) => setTimeout(r, 150));
    const stuck = service.detectStuckAgents();
    expect(stuck.length).toBe(1);
    expect(stuck[0].ticketId).toBe('ticket-1');
    expect(stuck[0].stuck).toBe(true);

    // Complete execution removes from tracking
    service.completeExecution('ticket-1');
    const afterComplete = service.detectStuckAgents();
    expect(afterComplete.length).toBe(0);
  });
});

test.describe('Stage 6: SwarmMetricsCollector', () => {
  test('records and aggregates ticket metrics', async () => {
    const { SwarmMetricsCollector } = await import(
      '../src/features/swarm-orchestration/services/swarm-metrics-collector'
    );

    const collector = new SwarmMetricsCollector({ logOnCollect: false });

    collector.recordTicketMetrics({
      ticketId: 'ticket-1', runId: 'run-1', agentId: 'agent-dev',
      complexity: 'high',
      phases: [
        { phase: 'intake', phaseIndex: 1, durationMs: 100, agentId: 'system', rounds: 1, status: 'completed', artifactsValid: true, handoverWritten: false },
        { phase: 'execution', phaseIndex: 4, durationMs: 5000, agentId: 'agent-dev', rounds: 2, status: 'completed', artifactsValid: true, handoverWritten: true },
      ],
      totalDurationMs: 10000, outcome: 'completed',
      regressionCount: 1, executionAttempts: 2, verificationAttempts: 2,
      artifactComplianceScore: 0.9, handoverCount: 2,
      staleLoopDetected: false, approvalRequired: false,
      completedAt: new Date().toISOString(),
    });

    collector.recordTicketMetrics({
      ticketId: 'ticket-2', runId: 'run-2', agentId: 'agent-dev',
      complexity: 'medium',
      phases: [
        { phase: 'execution', phaseIndex: 4, durationMs: 3000, agentId: 'agent-dev', rounds: 1, status: 'failed', artifactsValid: false, handoverWritten: false },
      ],
      totalDurationMs: 5000, outcome: 'failed',
      regressionCount: 0, executionAttempts: 1, verificationAttempts: 1,
      artifactComplianceScore: 0.5, handoverCount: 0,
      staleLoopDetected: false, approvalRequired: false,
      completedAt: new Date().toISOString(),
    });

    const aggregated = collector.getAggregatedMetrics();
    expect(aggregated.totalRuns).toBe(2);
    expect(aggregated.completedRuns).toBe(1);
    expect(aggregated.failedRuns).toBe(1);
    expect(aggregated.averageDurationMs).toBe(7500);

    const recent = collector.getRecentMetrics();
    expect(recent.length).toBe(2);
    expect(recent[0].ticketId).toBe('ticket-2'); // Most recent first

    const agentPerf = collector.getAgentPerformance();
    expect(agentPerf.length).toBe(1);
    expect(agentPerf[0].ticketsHandled).toBe(2);
    expect(agentPerf[0].completedCount).toBe(1);
  });
});

test.describe('Stage 6: ParityValidationChecklist', () => {
  test('runs validation with all 7 criteria', async () => {
    const { ParityValidationChecklist } = await import(
      '../src/features/swarm-orchestration/services/parity-validation-checklist'
    );

    const checklist = new ParityValidationChecklist({});
    const report = await checklist.runValidation();

    expect(report.items.length).toBe(7);
    expect(report.passCount + report.partialCount + report.failCount + report.notTestedCount).toBe(7);
    expect(report.summary).toContain('Parity:');

    // Without governance service, criterion 1 should be not_tested
    const queueState = report.items.find((i) => i.id === 'queue-state');
    expect(queueState?.status).toBe('not_tested');

    // Complexity gating should always pass (static check)
    const complexity = report.items.find((i) => i.id === 'complexity-gating');
    expect(complexity?.status).toBe('pass');

    // Regression support should always pass
    const regression = report.items.find((i) => i.id === 'regression');
    expect(regression?.status).toBe('pass');

    // Localhost inspection is partial (routes not mounted)
    const localhost = report.items.find((i) => i.id === 'localhost-inspection');
    expect(localhost?.status).toBe('partial');
  });

  test('runs validation with governance service wired', async () => {
    const { ParityValidationChecklist } = await import(
      '../src/features/swarm-orchestration/services/parity-validation-checklist'
    );
    const { QueueGovernanceService, InMemoryGovernanceStore } = await import(
      '../src/features/swarm-orchestration/services/queue-governance-service'
    );

    const store = new InMemoryGovernanceStore();
    const governance = new QueueGovernanceService(store);
    await governance.initializeTicket('test-ticket');

    const checklist = new ParityValidationChecklist({ governance });
    const report = await checklist.runValidation();

    // With governance, criterion 1 should pass
    const queueState = report.items.find((i) => i.id === 'queue-state');
    expect(queueState?.status).toBe('pass');
    expect(queueState?.evidence).toContain('QueueGovernanceService is available');
  });
});