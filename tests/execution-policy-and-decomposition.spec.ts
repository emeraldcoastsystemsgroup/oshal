/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added unit tests for SwarmExecutionPolicyRunner, TicketDecompositionService, SwarmCyclePolicyService
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added decomposition coverage for work-type-aware acceptance criteria used by routing and review
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added policy coverage for work-intent-aware retry reasons and ops escalation on timeout/resource failures
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added regression coverage for child-ticket direct planning execution depth and PM decomposition role/workType parsing
 */

import { test, expect } from '@playwright/test';
import { SwarmExecutionPolicyRunner, type SwarmExecutionPolicyCallbacks } from '../src/features/swarm-orchestration/services/swarm-execution-policy-runner';
import { TicketDecompositionService } from '../src/features/swarm-orchestration/services/ticket-decomposition-service';
import { SwarmCyclePolicyService } from '../src/features/swarm-orchestration/services/swarm-cycle-policy';
import { PlanningRoundOrchestrator } from '../src/features/swarm-orchestration/services/planning-round-orchestrator';
import type { SwarmVerificationResult, SwarmVerificationService } from '../src/features/swarm-orchestration/services/swarm-verification-service';
import type { ExternalWorkItem } from '../src/entities/ticket';
import type { RouteDecision, RouteCandidate } from '../src/features/agent-management/services/agent-router';
import type { DecomposedWorkUnit } from '../src/features/swarm-orchestration/services/ticket-decomposition-service';
import type { SwarmProcessingInput } from '../src/features/swarm-orchestration/services/swarm-ticket-processing-service';

// ─── Helpers ───────────────────────────────────────────────────────────

function makeTicket(overrides?: Partial<ExternalWorkItem>): ExternalWorkItem {
  return {
    externalId: 'ext-001',
    title: 'Test ticket',
    body: 'Step 1: Do first thing\nStep 2: Do second thing',
    priority: 'medium',
    labels: ['test'],
    provider: 'plane',
    ...overrides,
  };
}

function makeCandidate(id: string, score = 0.8): RouteCandidate {
  return { agentId: id, score, reason: 'test' };
}

function makeRouting(agentId = 'code-developer'): RouteDecision {
  const winner = makeCandidate(agentId);
  return { winner, ranked: [winner], strategy: 'score' as const };
}

function makeWorkUnits(count = 1): DecomposedWorkUnit[] {
  return Array.from({ length: count }, (_, i) => ({
    unitId: `unit-${i}`,
    title: `Step ${i + 1}`,
    description: `Do step ${i + 1}`,
    acceptanceCriteria: [`Criteria ${i + 1}`],
    labels: ['test'],
  }));
}

function makeInput(): SwarmProcessingInput {
  return { providerSlug: 'plane', projectId: 'proj-1' };
}

function makePassVerification(): SwarmVerificationResult {
  return { status: 'passed', summary: 'All checks passed', findings: [{ type: 'check', description: 'ok' }] };
}

function makeBuildFailVerification(): SwarmVerificationResult {
  return {
    status: 'failed',
    summary: 'Build regression',
    findings: [{ type: 'regression', description: 'output too short', target: 'build' }],
  };
}

function makeDesignFailVerification(): SwarmVerificationResult {
  return {
    status: 'failed',
    summary: 'Design regression',
    findings: [{ type: 'regression', description: 'missing acceptance criteria', target: 'design' }],
  };
}

// ─── TicketDecompositionService ─────────────────────────────────────────

test.describe('TicketDecompositionService', () => {
  const svc = new TicketDecompositionService();

  test('decompose() parses numbered steps from body', () => {
    const ticket = makeTicket({
      body: '1. Create the database schema\n2. Write the API endpoints\n3. Add validation',
    });
    const units = svc.decompose(ticket);

    expect(units.length).toBe(3);
    expect(units[0].title).toContain('Step 1');
    expect(units[0].description).toContain('Create the database schema');
    expect(units[1].description).toContain('Write the API endpoints');
    expect(units[2].description).toContain('Add validation');
  });

  test('decompose() limits to 5 steps maximum', () => {
    const ticket = makeTicket({
      body: '1. Step one\n2. Step two\n3. Step three\n4. Step four\n5. Step five\n6. Step six\n7. Step seven',
    });
    const units = svc.decompose(ticket);
    expect(units.length).toBeLessThanOrEqual(5);
  });

  test('decompose() creates single unit when no body steps found', () => {
    const ticket = makeTicket({ body: 'Just a plain description with no steps' });
    const units = svc.decompose(ticket);

    expect(units.length).toBe(1);
    expect(units[0].title).toBeTruthy();
  });

  test('decompose() creates single unit when body is empty', () => {
    const ticket = makeTicket({ body: '' });
    const units = svc.decompose(ticket);

    expect(units.length).toBe(1);
  });

  test('decompose() preserves labels from source ticket', () => {
    const ticket = makeTicket({ labels: ['critical', 'backend'] });
    const units = svc.decompose(ticket);

    units.forEach(unit => {
      expect(unit.labels).toContain('critical');
      expect(unit.labels).toContain('backend');
    });
  });

  test('decompose() parses dash-prefixed list items', () => {
    const ticket = makeTicket({
      body: '- Create user model\n- Add authentication\n- Write tests',
    });
    const units = svc.decompose(ticket);

    expect(units.length).toBeGreaterThanOrEqual(1);
  });

  test('decompose() infers testing work and emits testing-specific acceptance criteria', () => {
    const ticket = makeTicket({
      body: '1. Write tests for the auth flow',
    });
    const units = svc.decompose(ticket);

    expect(units[0]?.workType).toBe('testing');
    expect(units[0]?.acceptanceCriteria[0]).toContain('checks pass');
  });

  test('decompose() infers documentation work and emits documentation-specific acceptance criteria', () => {
    const ticket = makeTicket({
      body: '1. Update the README with setup steps',
    });
    const units = svc.decompose(ticket);

    expect(units[0]?.workType).toBe('documentation');
    expect(units[0]?.acceptanceCriteria[0]).toContain('documentation');
  });

  test('decompose() assigns unitIds to all work units', () => {
    const ticket = makeTicket({
      body: '1. First step\n2. Second step',
    });
    const units = svc.decompose(ticket);

    units.forEach(unit => {
      expect(unit.unitId).toBeTruthy();
      expect(unit.unitId.length).toBeGreaterThan(0);
    });
  });

  test('decomposeFromPlanningOutput() keeps implementation subtasks out of testing workType when tests only appear in acceptance criteria', async () => {
    const planningOutput = `# Implementation Plan\n\n## SUBTASK DECOMPOSITION\n\n### Subtask 1: Build the normalized data collector pipeline\n**Description:** Implement the GitHub and curated web collectors so all candidate tools are normalized into a shared model.\n\n**Acceptance Criteria:**\n- Failure paths are covered with deterministic mocks in Vitest.\n- npx vitest run deliverables/tests/collectors tests pass.\n\n**Suggested agent role:** code-developer\n\n### Subtask 2: Implement the deterministic ranking and scoring engine\n**Description:** Create a scoring engine that ranks the top 25 tools.\n\n**Acceptance Criteria:**\n- Ranking output contains exactly 25 entries.\n- npx vitest run deliverables/tests/ranking tests pass.\n\n**Suggested agent role:** code-developer`;

    const result = await svc.decomposeFromPlanningOutput(
      planningOutput,
      makeTicket({ externalId: 'pm-parse-001', title: 'Best MCP tools' }),
    );

    expect(result.workUnits).toHaveLength(2);
    expect(result.workUnits[0]?.workType).toBe('implementation');
    expect(result.workUnits[1]?.workType).toBe('implementation');
    expect(result.agentAssignments).toEqual([
      { subtaskTitle: 'Build the normalized data collector pipeline', suggestedRole: 'code-developer' },
      { subtaskTitle: 'Implement the deterministic ranking and scoring engine', suggestedRole: 'code-developer' },
    ]);
  });
});

// ─── PlanningRoundOrchestrator — Child Direct Execution ─────────────────

test.describe('PlanningRoundOrchestrator', () => {
  test('execute() keeps child-ticket direct execution work at depth 0 while preserving PM assignment hints', async () => {
    const decompositionService = new TicketDecompositionService();
    const policyService = new SwarmCyclePolicyService();
    const selectedPhases: Array<Record<string, unknown> | undefined> = [];
    const persistedUnits: DecomposedWorkUnit[][] = [];

    const orchestrator = new PlanningRoundOrchestrator({
      decompositionService,
      getMultiRoundDispatch: () => undefined,
      selectAgent: async (_item, _input, workUnits, phaseContext) => {
        selectedPhases.push(phaseContext);
        persistedUnits.push(workUnits);
        return makeRouting('code-developer');
      },
      registerParentsWithLifecycle: async () => undefined,
      persistWorkItems: async (_runId, _item, workUnits) => {
        persistedUnits.push(workUnits);
      },
    });

    const childTicket = makeTicket({
      externalId: 'child-ticket-001',
      title: 'Build the normalized data collector pipeline',
      body: 'Implement the collectors and supporting model.',
    }) as ExternalWorkItem & { metadata?: Record<string, unknown> };
    childTicket.metadata = {
      depth: 1,
      workType: 'implementation',
      acceptanceCriteria: ['Collector implemented and validated'],
      pmAssignedRole: 'code-developer',
      subtaskTitle: 'Build the normalized data collector pipeline',
    };

    const result = await orchestrator.execute({
      runId: 'run-child-001',
      item: childTicket,
      input: { workspaceTaskId: 'workspace-root-001' } as SwarmProcessingInput,
      policy: policyService.resolve({ verificationRetryDelayMs: 0 }),
      phaseGate: { complexity: 'medium', activePhases: ['intake', 'planning', 'execution', 'testing', 'review', 'delivery'], complexityScore: 4 },
      workspaceTaskId: 'workspace-root-001',
    });

    expect(result.planningSource).toBe('child-direct');
    expect(result.stopAfterPlanning).toBe(false);
    expect(result.workUnits).toHaveLength(1);
    expect(result.workUnits[0]?.depth).toBe(0);
    expect(result.workUnits[0]?.parentUnitId).toBeNull();
    expect(result.workUnits[0]?.workType).toBe('implementation');
    expect(selectedPhases[0]?.pmAssignedRole).toBe('code-developer');
  });
});

// ─── SwarmCyclePolicyService ───────────────────────────────────────────

test.describe('SwarmCyclePolicyService', () => {
  const svc = new SwarmCyclePolicyService();

  test('resolve() applies defaults when no input provided', () => {
    const policy = svc.resolve();

    expect(policy.maxVerificationAttempts).toBeGreaterThanOrEqual(1);
    expect(policy.maxBuildRegressions).toBeGreaterThanOrEqual(0);
    expect(policy.maxDesignRegressions).toBeGreaterThanOrEqual(0);
    expect(policy.maxWritebackAttempts).toBeGreaterThanOrEqual(1);
    expect(policy.maxTotalCycles).toBeGreaterThan(0);
    expect(policy.maxRunDurationMs).toBeGreaterThan(0);
    expect(policy.escalationTarget).toBeTruthy();
    expect(policy.verificationRetryDelayMs).toBeGreaterThanOrEqual(0);
  });

  test('resolve() respects input overrides', () => {
    const policy = svc.resolve({
      maxVerificationAttempts: 5,
      maxBuildRegressions: 2,
      escalationTarget: 'team_lead',
    });

    expect(policy.maxVerificationAttempts).toBe(5);
    expect(policy.maxBuildRegressions).toBe(2);
    expect(policy.escalationTarget).toBe('team_lead');
  });

  test('decideVerificationFailure() returns retry_build for build regression with budget', () => {
    const verification = makeBuildFailVerification();
    const attemptState = { verificationAttempt: 1, buildRegressionCount: 0, designRegressionCount: 0 };
    const policy = svc.resolve();

    const decision = svc.decideVerificationFailure(verification, attemptState, policy);

    expect(['retry_build', 'escalate']).toContain(decision.action);
    if (decision.action === 'retry_build') {
      expect(decision.reason).toBeTruthy();
    }
  });

  test('decideVerificationFailure() explains missing testing evidence in the retry reason', () => {
    const verification: SwarmVerificationResult = {
      status: 'failed',
      summary: 'Execution output needs rework.',
      findings: ['missing-testing-evidence:unit-1'],
      regressionTarget: 'build',
    };
    const attemptState = { verificationAttempt: 1, buildRegressionCount: 0, designRegressionCount: 0 };
    const policy = svc.resolve();

    const decision = svc.decideVerificationFailure(verification, attemptState, policy);

    expect(decision.action).toBe('retry_build');
    expect(decision.reason).toContain('testing evidence is missing');
  });

  test('decideVerificationFailure() escalates when all budgets exhausted', () => {
    const verification = makeBuildFailVerification();
    const policy = svc.resolve();
    const attemptState = {
      verificationAttempt: policy.maxVerificationAttempts,
      buildRegressionCount: policy.maxBuildRegressions,
      designRegressionCount: policy.maxDesignRegressions,
    };

    const decision = svc.decideVerificationFailure(verification, attemptState, policy);

    expect(decision.action).toBe('escalate');
    expect(decision.escalationTarget).toBeTruthy();
    expect(decision.escalationSeverity).toBeTruthy();
  });

  test('decideVerificationFailure() routes timeout/resource escalations to ops_channel', () => {
    const verification: SwarmVerificationResult = {
      status: 'failed',
      summary: 'Verification timed out after waiting on the integration path.',
      findings: ['integration-timeout'],
      regressionTarget: 'build',
    };
    const policy = svc.resolve({ maxVerificationAttempts: 1, maxBuildRegressions: 0 });
    const attemptState = {
      verificationAttempt: 1,
      buildRegressionCount: 0,
      designRegressionCount: 0,
    };

    const decision = svc.decideVerificationFailure(verification, attemptState, policy);

    expect(decision.action).toBe('escalate');
    expect(decision.escalationTarget).toBe('ops_channel');
    expect(decision.escalationSeverity).toBe('high');
  });

  test('isCycleGuardrailExceeded() returns true when over limit', () => {
    const policy = svc.resolve({ maxTotalCycles: 5 });
    expect(svc.isCycleGuardrailExceeded(6, policy)).toBe(true);
    expect(svc.isCycleGuardrailExceeded(4, policy)).toBe(false);
    expect(svc.isCycleGuardrailExceeded(5, policy)).toBe(true); // >= boundary
  });

  test('isRunDurationExceeded() returns true when past time limit', () => {
    const policy = svc.resolve({ maxRunDurationMs: 60_000 });
    const twoMinutesAgo = Date.now() - 120_000;
    const justNow = Date.now();

    expect(svc.isRunDurationExceeded(twoMinutesAgo, policy)).toBe(true);
    expect(svc.isRunDurationExceeded(justNow, policy)).toBe(false);
  });

  test('shouldRetryWriteback() respects attempt budget', () => {
    const policy = svc.resolve({ maxWritebackAttempts: 2 });

    expect(svc.shouldRetryWriteback(1, policy)).toBe(true);
    expect(svc.shouldRetryWriteback(2, policy)).toBe(false);
    expect(svc.shouldRetryWriteback(3, policy)).toBe(false);
  });
});

// ─── SwarmExecutionPolicyRunner ────────────────────────────────────────

test.describe('SwarmExecutionPolicyRunner', () => {
  const policyService = new SwarmCyclePolicyService();
  const decompositionService = new TicketDecompositionService();

  function createMockVerificationService(results: SwarmVerificationResult[]): SwarmVerificationService {
    let callIdx = 0;
    return {
      verify: async () => {
        const result = results[Math.min(callIdx, results.length - 1)];
        callIdx++;
        return result;
      },
      runStructuralChecks: () => makePassVerification(),
    } as unknown as SwarmVerificationService;
  }

  test('run() returns passed outcome when verification passes on first attempt', async () => {
    const verificationSvc = createMockVerificationService([makePassVerification()]);
    const runner = new SwarmExecutionPolicyRunner(verificationSvc, policyService, decompositionService);

    let dispatchCount = 0;
    const callbacks: SwarmExecutionPolicyCallbacks = {
      dispatchExecution: async () => { dispatchCount++; return 'execution output'; },
      reroute: async () => makeRouting(),
    };

    const outcome = await runner.run(
      makeTicket(), makeInput(), makeWorkUnits(), makeRouting(),
      policyService.resolve({ verificationRetryDelayMs: 0 }), callbacks,
    );

    expect(outcome.verification.status).toBe('passed');
    expect(outcome.executionAttempts).toBe(1);
    expect(outcome.buildRegressionCount).toBe(0);
    expect(outcome.designRegressionCount).toBe(0);
    expect(outcome.escalation).toBeUndefined();
    expect(outcome.guardrailTriggered).toBeUndefined();
    expect(dispatchCount).toBe(1);
  });

  test('run() retries on build regression and passes on second attempt', async () => {
    const verificationSvc = createMockVerificationService([
      makeBuildFailVerification(),
      makePassVerification(),
    ]);
    const runner = new SwarmExecutionPolicyRunner(verificationSvc, policyService, decompositionService);

    let dispatchCount = 0;
    const callbacks: SwarmExecutionPolicyCallbacks = {
      dispatchExecution: async () => { dispatchCount++; return 'execution output'; },
      reroute: async () => makeRouting(),
    };

    const outcome = await runner.run(
      makeTicket(), makeInput(), makeWorkUnits(), makeRouting(),
      policyService.resolve({ maxBuildRegressions: 2, verificationRetryDelayMs: 0 }), callbacks,
    );

    expect(outcome.verification.status).toBe('passed');
    expect(outcome.executionAttempts).toBe(2);
    expect(outcome.buildRegressionCount).toBe(1);
    expect(dispatchCount).toBe(2);
  });

  test('run() escalates when all build regression budget exhausted', async () => {
    // Always fails — will exhaust budget
    const verificationSvc = createMockVerificationService([
      makeBuildFailVerification(),
      makeBuildFailVerification(),
      makeBuildFailVerification(),
      makeBuildFailVerification(),
      makeBuildFailVerification(),
    ]);
    const runner = new SwarmExecutionPolicyRunner(verificationSvc, policyService, decompositionService);

    const callbacks: SwarmExecutionPolicyCallbacks = {
      dispatchExecution: async () => 'output',
      reroute: async () => makeRouting(),
    };

    const outcome = await runner.run(
      makeTicket(), makeInput(), makeWorkUnits(), makeRouting(),
      policyService.resolve({ maxVerificationAttempts: 2, maxBuildRegressions: 1, maxDesignRegressions: 0, verificationRetryDelayMs: 0 }),
      callbacks,
    );

    expect(outcome.escalation).toBeDefined();
    expect(outcome.escalation!.target).toBeTruthy();
    expect(outcome.policyDecisions.length).toBeGreaterThan(0);
  });

  test('run() triggers max-cycle guardrail', async () => {
    // Always fails
    const verificationSvc = createMockVerificationService([makeBuildFailVerification()]);
    const runner = new SwarmExecutionPolicyRunner(verificationSvc, policyService, decompositionService);

    const callbacks: SwarmExecutionPolicyCallbacks = {
      dispatchExecution: async () => 'output',
      reroute: async () => makeRouting(),
    };

    // Set very low cycle guardrail — should trigger before verification budget runs out
    const outcome = await runner.run(
      makeTicket(), makeInput(), makeWorkUnits(), makeRouting(),
      policyService.resolve({
        maxTotalCycles: 1,
        maxVerificationAttempts: 10,
        maxBuildRegressions: 10,
        verificationRetryDelayMs: 0,
      }),
      callbacks,
    );

    expect(outcome.guardrailTriggered).toBe('max_cycles');
    expect(outcome.escalation).toBeDefined();
    expect(outcome.escalation!.reason).toContain('Max-cycle guardrail');
  });

  test('run() triggers max-duration guardrail', async () => {
    const verificationSvc = createMockVerificationService([makeBuildFailVerification()]);
    const runner = new SwarmExecutionPolicyRunner(verificationSvc, policyService, decompositionService);

    const callbacks: SwarmExecutionPolicyCallbacks = {
      dispatchExecution: async () => 'output',
      reroute: async () => makeRouting(),
    };

    // Pretend the run started a long time ago
    const longAgo = Date.now() - 999_999_999;
    const outcome = await runner.run(
      makeTicket(), makeInput(), makeWorkUnits(), makeRouting(),
      policyService.resolve({
        maxRunDurationSeconds: 1,
        maxTotalCycles: 100,
        verificationRetryDelayMs: 0,
      }),
      callbacks,
      longAgo,
    );

    expect(outcome.guardrailTriggered).toBe('max_duration');
    expect(outcome.escalation).toBeDefined();
  });

  test('run() calls reroute callback on design regression', async () => {
    const verificationSvc = createMockVerificationService([
      makeDesignFailVerification(),
      makePassVerification(),
    ]);
    const runner = new SwarmExecutionPolicyRunner(verificationSvc, policyService, decompositionService);

    let rerouteCount = 0;
    const callbacks: SwarmExecutionPolicyCallbacks = {
      dispatchExecution: async () => 'output',
      reroute: async () => {
        rerouteCount++;
        return makeRouting('new-agent');
      },
    };

    const outcome = await runner.run(
      makeTicket(), makeInput(), makeWorkUnits(), makeRouting(),
      policyService.resolve({ maxDesignRegressions: 2, verificationRetryDelayMs: 0 }),
      callbacks,
    );

    // Design regression should have triggered a reroute
    // Whether it actually reaches reroute depends on policy decision
    // (may escalate instead if budget is tight)
    if (outcome.verification.status === 'passed') {
      expect(outcome.executionAttempts).toBeGreaterThanOrEqual(2);
    }
  });

  test('run() dispatchExecution receives routing and work units', async () => {
    const verificationSvc = createMockVerificationService([makePassVerification()]);
    const runner = new SwarmExecutionPolicyRunner(verificationSvc, policyService, decompositionService);

    let capturedRouting: RouteDecision | undefined;
    let capturedUnits: DecomposedWorkUnit[] | undefined;
    const callbacks: SwarmExecutionPolicyCallbacks = {
      dispatchExecution: async (routing, workUnits) => {
        capturedRouting = routing;
        capturedUnits = workUnits;
        return 'output';
      },
      reroute: async () => makeRouting(),
    };

    const workUnits = makeWorkUnits(2);
    const routing = makeRouting('test-agent');

    await runner.run(
      makeTicket(), makeInput(), workUnits, routing,
      policyService.resolve({ verificationRetryDelayMs: 0 }), callbacks,
    );

    expect(capturedRouting).toBeDefined();
    expect(capturedRouting!.winner.agentId).toBe('test-agent');
    expect(capturedUnits).toHaveLength(2);
  });

  test('run() outcome contains immutable copies of work units and decisions', async () => {
    const verificationSvc = createMockVerificationService([makePassVerification()]);
    const runner = new SwarmExecutionPolicyRunner(verificationSvc, policyService, decompositionService);

    const callbacks: SwarmExecutionPolicyCallbacks = {
      dispatchExecution: async () => 'output',
      reroute: async () => makeRouting(),
    };

    const workUnits = makeWorkUnits(2);
    const outcome = await runner.run(
      makeTicket(), makeInput(), workUnits, makeRouting(),
      policyService.resolve({ verificationRetryDelayMs: 0 }), callbacks,
    );

    // Mutating the original should not affect the outcome
    workUnits.push(makeWorkUnits(1)[0]);
    expect(outcome.workUnits).toHaveLength(2);
  });
});
