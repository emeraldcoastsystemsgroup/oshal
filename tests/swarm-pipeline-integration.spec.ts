/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added integration tests for M3 swarm pipeline: 7-phase lifecycle, routing cascade, RALF handover, consensus review, swarm memory
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Updated lifecycle expectations so medium-complexity tickets require the review phase before delivery
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added consensus-review dispatch coverage for work-intent review focus metadata
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added consensus-review parsing coverage for normalized evidence-class findings
 */

import { expect, test } from '@playwright/test';
import {
  buildExternalTicketHierarchy,
  buildExternalTicketWorkflow,
  type ExternalWorkItem,
} from '../src/entities/ticket';
import {
  InMemorySwarmRunStore,
  SwarmCyclePolicyService,
  SwarmTicketProcessingService,
  SwarmVerificationService,
  type SwarmVerificationResult,
  type TicketWritebackUpdate,
  type SwarmPhase,
  SWARM_PHASE_ORDER,
  TicketCycleStateMachine,
  scoreComplexity,
  complexityFromScore,
  resolvePhaseGateConfig,
} from '../src/features/swarm-orchestration/services';
import {
  AgentRouter,
  type RouteCandidate,
  type RouteContext,
} from '../src/features/agent-management/services/agent-router';
import { SelectionBidService } from '../src/features/agent-management/services/selection-bid-service';
import { RALFHandoverManager } from '../src/features/swarm-orchestration/services/ralf-handover-manager';
import { PhaseRoundOrchestrator } from '../src/features/swarm-orchestration/services/phase-round-orchestrator';
import { ConsensusReviewService } from '../src/features/swarm-orchestration/services/consensus-review-service';
import type { IntakeService } from '../src/features/intake';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';

// ═══════════════════════════════════════════════════════════════════════
// 1. SEVEN-PHASE LIFECYCLE WITH COMPLEXITY-DRIVEN PHASE SKIPPING
// ═══════════════════════════════════════════════════════════════════════

test.describe('7-Phase Lifecycle', () => {
  test('SWARM_PHASE_ORDER contains exactly 7 phases in correct order', () => {
    expect(SWARM_PHASE_ORDER).toEqual([
      'intake', 'planning', 'specialist_input', 'execution', 'testing', 'review', 'delivery',
    ]);
  });

  test('low complexity ticket skips specialist_input, testing, and review phases', () => {
    const config = resolvePhaseGateConfig(1, [], 100, 1);
    expect(config.complexity).toBe('low');
    expect(config.activePhases).toEqual(['intake', 'planning', 'execution', 'delivery']);
    expect(config.activePhases).not.toContain('specialist_input');
    expect(config.activePhases).not.toContain('testing');
    expect(config.activePhases).not.toContain('review');
  });

  test('medium complexity ticket includes testing and review but skips specialist_input', () => {
    const config = resolvePhaseGateConfig(3, ['complex'], 1000, 3);
    expect(config.complexity).toBe('medium');
    expect(config.activePhases).toContain('testing');
    expect(config.activePhases).toContain('review');
    expect(config.activePhases).not.toContain('specialist_input');
  });

  test('high complexity ticket activates all 7 phases', () => {
    const config = resolvePhaseGateConfig(5, ['complex', 'architecture'], 3000, 8);
    expect(config.complexity).toBe('high');
    expect(config.activePhases).toHaveLength(7);
    expect(config.activePhases).toEqual(SWARM_PHASE_ORDER as unknown as string[]);
  });

  test('complexity scoring produces reasonable scores', () => {
    expect(scoreComplexity(0, [], 0, 0)).toBe(1);
    expect(scoreComplexity(1, [], 100, 1)).toBeGreaterThanOrEqual(2);
    expect(scoreComplexity(5, ['complex', 'architecture'], 3000, 8)).toBeGreaterThanOrEqual(7);
    expect(scoreComplexity(10, ['complex', 'security', 'migration'], 5000, 10)).toBeLessThanOrEqual(10);
  });

  test('complexity level mapping is correct', () => {
    expect(complexityFromScore(1)).toBe('low');
    expect(complexityFromScore(3)).toBe('low');
    expect(complexityFromScore(4)).toBe('medium');
    expect(complexityFromScore(6)).toBe('medium');
    expect(complexityFromScore(7)).toBe('high');
    expect(complexityFromScore(10)).toBe('high');
  });

  test('state machine marks inactive phases as skipped at construction', () => {
    const config = resolvePhaseGateConfig(1, [], 100, 1);
    const sm = new TicketCycleStateMachine('plane', 'test-1', config);
    const snapshot = sm.snapshot();

    const skipped = snapshot.cycles.filter((c) => c.status === 'skipped');
    const pending = snapshot.cycles.filter((c) => c.status === 'pending');

    expect(skipped.length).toBe(3); // specialist_input, testing, review
    expect(pending.length).toBe(4); // intake, planning, execution, delivery
  });

  test('state machine allows progression past skipped phases', () => {
    const config = resolvePhaseGateConfig(1, [], 100, 1); // low = skip 3 phases
    const sm = new TicketCycleStateMachine('plane', 'test-2', config);

    sm.begin('intake');
    sm.complete('intake', {});
    sm.begin('planning');
    sm.complete('planning', {});
    // specialist_input is skipped — should be able to go straight to execution
    sm.begin('execution');
    sm.complete('execution', {});
    // testing and review are skipped — straight to delivery
    sm.begin('delivery');
    sm.complete('delivery', {});

    const snapshot = sm.snapshot();
    expect(snapshot.overallStatus).toBe('completed');
  });

  test('state machine blocks progression past incomplete active phases', () => {
    const sm = new TicketCycleStateMachine('plane', 'test-3');
    sm.begin('intake');
    // Try to start planning before intake is complete
    expect(() => sm.begin('planning')).toThrow(/Cannot start phase planning before intake/);
  });

  test('full 7-phase pipeline processes low complexity ticket through lifecycle', async () => {
    const verificationService = new AlwaysPassVerificationService();
    const writebackAdapter = new CapturingWritebackAdapter();
    const service = createProcessingService(verificationService, writebackAdapter);

    const result = await service.processProvider('plane', {
      interactionMode: 'ticket',
      limit: 1,
    });

    expect(result.processedCount).toBe(1);
    expect(result.processed[0]?.lifecycle.overallStatus).toBe('completed');

    const phases = result.processed[0]?.lifecycle.cycles;
    expect(phases?.find((c) => c.cycle === 'intake')?.status).toBe('completed');
    expect(phases?.find((c) => c.cycle === 'planning')?.status).toBe('completed');
    expect(phases?.find((c) => c.cycle === 'execution')?.status).toBe('completed');
    expect(phases?.find((c) => c.cycle === 'delivery')?.status).toBe('completed');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. ROUTING CASCADE TIER FALLTHROUGH
// ═══════════════════════════════════════════════════════════════════════

test.describe('Routing Cascade', () => {
  test('Tier 1: bid auction selects highest confidence bid above threshold', async () => {
    const router = new AgentRouter();
    const candidates: RouteCandidate[] = [
      { agentId: 'agent-a', score: 5, reason: 'score' },
      { agentId: 'agent-b', score: 3, reason: 'score' },
    ];
    const context: RouteContext = {
      taskId: 'test-1',
      bids: [
        { agentId: 'agent-b', confidence: 0.9, estimatedCost: 10, estimatedLatencyMs: 100 },
        { agentId: 'agent-a', confidence: 0.6, estimatedCost: 10, estimatedLatencyMs: 100 },
      ],
    };

    const decision = await router.route(context, candidates);
    expect(decision.strategy).toBe('bid');
    expect(decision.winner.agentId).toBe('agent-b'); // Higher confidence wins
  });

  test('Tier 1: bids below threshold fall through to lower tiers', async () => {
    const router = new AgentRouter();
    const candidates: RouteCandidate[] = [
      { agentId: 'agent-a', score: 5, reason: 'score', capabilities: ['code'] },
    ];
    const context: RouteContext = {
      taskId: 'test-2',
      bids: [
        { agentId: 'agent-a', confidence: 0.3, estimatedCost: 10, estimatedLatencyMs: 100 }, // Below 0.5 threshold
      ],
    };

    const decision = await router.route(context, candidates);
    expect(decision.strategy).not.toBe('bid'); // Should fall through
  });

  test('Tier 3: keyword matching scores candidates by capability overlap', async () => {
    const router = new AgentRouter();
    const candidates: RouteCandidate[] = [
      { agentId: 'agent-a', score: 1, reason: 'generic', capabilities: ['documentation'], routingKeywords: ['docs'] },
      { agentId: 'agent-b', score: 1, reason: 'generic', capabilities: ['code', 'testing'], routingKeywords: ['implement', 'test'] },
    ];
    const context: RouteContext = {
      taskId: 'test-3',
      requiredCapabilities: ['code'],
      ticketTitle: 'Implement new feature with tests',
    };

    const decision = await router.route(context, candidates);
    expect(decision.strategy).toBe('keyword');
    expect(decision.winner.agentId).toBe('agent-b'); // More keyword overlap
  });

  test('Tier 4: catch-all returns project-manager when no candidates match', async () => {
    const router = new AgentRouter();
    const decision = await router.route({ taskId: 'test-4' }, []);
    expect(decision.strategy).toBe('catch-all');
    expect(decision.winner.agentId).toBe('a0000000-0000-0000-0000-000000000001');
  });

  test('Tier 2: LLM routing function is called when provided', async () => {
    let llmCalled = false;
    const llmRouter = async (ctx: RouteContext, cands: RouteCandidate[]) => {
      llmCalled = true;
      return cands[1]?.agentId ?? null;
    };
    const router = new AgentRouter(new SelectionBidService(), llmRouter);
    const candidates: RouteCandidate[] = [
      { agentId: 'agent-a', score: 5, reason: 'score' },
      { agentId: 'agent-b', score: 3, reason: 'score' },
    ];

    const decision = await router.route({ taskId: 'test-5' }, candidates);
    expect(llmCalled).toBe(true);
    expect(decision.strategy).toBe('llm');
    expect(decision.winner.agentId).toBe('agent-b');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. RALF HANDOVER READ/WRITE/SUMMARIZE ROUND-TRIP
// ═══════════════════════════════════════════════════════════════════════

test.describe('RALF Handover Manager', () => {
  const WORKSPACE_ROOT = join('/tmp', 'oshal-test-handover-' + Date.now());
  const TASK_ID = 'task_test123';

  test.beforeAll(() => {
    mkdirSync(join(WORKSPACE_ROOT, TASK_ID, 'developer-handovers'), { recursive: true });
  });

  test.afterAll(() => {
    if (existsSync(WORKSPACE_ROOT)) {
      rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
    }
  });

  test('writeHandover creates file with correct naming convention', () => {
    const mgr = new RALFHandoverManager(WORKSPACE_ROOT);
    const path = mgr.writeHandover(TASK_ID, 'architect-bot', 2, 1, '# Developer Handover — architect-bot\n**Phase:** 2 | **Round:** 1\n**Status:** Complete\n\n## What I Did\n- Designed the architecture');
    expect(path).not.toBeNull();
    expect(path).toContain('architect-bot_PHASE_2_ROUND_1.md');
  });

  test('readHandovers returns written handovers with parsed metadata', () => {
    const mgr = new RALFHandoverManager(WORKSPACE_ROOT);
    const handovers = mgr.readHandovers(TASK_ID);
    expect(handovers.length).toBeGreaterThanOrEqual(1);
    const h = handovers.find((h) => h.agentId === 'architect-bot');
    expect(h).toBeDefined();
    expect(h!.phase).toBe(2);
    expect(h!.round).toBe(1);
    expect(h!.content).toContain('Designed the architecture');
  });

  test('readAgentHandover returns most recent handover for a specific agent', () => {
    const mgr = new RALFHandoverManager(WORKSPACE_ROOT);
    mgr.writeHandover(TASK_ID, 'architect-bot', 2, 2, '# Developer Handover — architect-bot\n**Phase:** 2 | **Round:** 2\n**Status:** Complete\n\n## What I Did\n- Refined the design');
    const latest = mgr.readAgentHandover('architect-bot', TASK_ID);
    expect(latest).not.toBeNull();
    expect(latest!.round).toBe(2);
    expect(latest!.content).toContain('Refined the design');
  });

  test('generateSummary produces executive summary with work history', () => {
    const mgr = new RALFHandoverManager(WORKSPACE_ROOT);
    const handovers = mgr.readHandovers(TASK_ID);
    const summary = mgr.generateSummary(handovers, 'Test Ticket', 3, 1);
    expect(summary).toContain('QUEUE MANAGER EXECUTIVE SUMMARY');
    expect(summary).toContain('Test Ticket');
    expect(summary).toContain('Phase 2');
    expect(summary).toContain('architect-bot');
    expect(summary).toContain('YOUR TURN');
  });

  test('generateSummary produces fresh start summary when no handovers exist', () => {
    const mgr = new RALFHandoverManager(WORKSPACE_ROOT);
    const summary = mgr.generateSummary([], 'New Ticket', 1, 1);
    expect(summary).toContain('Fresh start');
    expect(summary).toContain('New Ticket');
    expect(summary).toContain('YOUR TURN');
  });

  test('generateContextRecall produces recall block for returning agent', () => {
    const mgr = new RALFHandoverManager(WORKSPACE_ROOT);
    const handover = mgr.readAgentHandover('architect-bot', TASK_ID);
    expect(handover).not.toBeNull();
    const recall = mgr.generateContextRecall(handover!, 'architect-bot');
    expect(recall).toContain('CONTEXT RECALL');
    expect(recall).toContain('architect-bot');
    expect(recall).toContain('Pick up where you left off');
  });

  test('getHandoverInstructions produces mandatory handover format', () => {
    const mgr = new RALFHandoverManager(WORKSPACE_ROOT);
    const instructions = mgr.getHandoverInstructions('code-developer', 4, 1);
    expect(instructions).toContain('MANDATORY');
    expect(instructions).toContain('code-developer_PHASE_4_ROUND_1.md');
    expect(instructions).toContain('What I Did');
    expect(instructions).toContain('What I Produced');
    expect(instructions).toContain('Key Context for Next Agent');
  });

  test('writeHandover auto-generates handover when agent output has no handover section', () => {
    const mgr = new RALFHandoverManager(WORKSPACE_ROOT);
    const path = mgr.writeHandover(TASK_ID, 'worker-bot', 4, 1, 'Here is my raw output with no handover section. I implemented the feature successfully.');
    expect(path).not.toBeNull();
    const handovers = mgr.readHandovers(TASK_ID);
    const workerHandover = handovers.find((h) => h.agentId === 'worker-bot');
    expect(workerHandover).toBeDefined();
    expect(workerHandover!.content).toContain('Auto-generated');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. PHASE ROUND ORCHESTRATOR — MULTI-ROUND STATE TRACKING
// ═══════════════════════════════════════════════════════════════════════

test.describe('Phase Round Orchestrator', () => {
  test('initializes 2-round orchestration and tracks state', () => {
    const orch = new PhaseRoundOrchestrator();
    const state = orch.initPhaseRounds('ticket-1', 4, [
      { agentId: 'executor-bot', role: 'primary-executor' },
      { agentId: 'reviewer-bot', role: 'quality-agitator' },
    ]);

    expect(state.maxRounds).toBe(2);
    expect(state.currentRound).toBe(1);
    expect(state.state).toBe('round_in_progress');
    expect(state.rounds[0].status).toBe('in_progress');
    expect(state.rounds[1].status).toBe('pending');
  });

  test('completeRound advances to next round', () => {
    const orch = new PhaseRoundOrchestrator();
    orch.initPhaseRounds('ticket-2', 4, [
      { agentId: 'executor-bot', role: 'primary' },
      { agentId: 'reviewer-bot', role: 'reviewer' },
    ]);

    const result = orch.completeRound('ticket-2', 4, 'executor-bot', 'Round 1 output');
    expect(result.action).toBe('NEXT_ROUND');
    expect(result.nextAgent?.agentId).toBe('reviewer-bot');
    expect(result.nextAgent?.round).toBe(2);
  });

  test('completing final round returns PHASE_COMPLETE', () => {
    const orch = new PhaseRoundOrchestrator();
    orch.initPhaseRounds('ticket-3', 4, [
      { agentId: 'executor-bot', role: 'primary' },
      { agentId: 'reviewer-bot', role: 'reviewer' },
    ]);

    orch.completeRound('ticket-3', 4, 'executor-bot');
    const result = orch.completeRound('ticket-3', 4, 'reviewer-bot');
    expect(result.action).toBe('PHASE_COMPLETE');
    expect(result.state.state).toBe('all_rounds_complete');
  });

  test('buildRoundContext includes colleagues and previous round info', () => {
    const orch = new PhaseRoundOrchestrator();
    orch.initPhaseRounds('ticket-4', 4, [
      { agentId: 'executor-bot', role: 'primary' },
      { agentId: 'reviewer-bot', role: 'reviewer' },
    ]);
    orch.completeRound('ticket-4', 4, 'executor-bot');

    const ctx = orch.buildRoundContext('ticket-4', 4);
    expect(ctx).not.toBeNull();
    expect(ctx!.currentRound).toBe(2);
    expect(ctx!.maxRounds).toBe(2);
    expect(ctx!.role).toBe('reviewer');
    expect(ctx!.previousRoundAgent).toBe('executor-bot');
    expect(ctx!.colleagues).toHaveLength(2);
  });

  test('failRound marks phase as failed', () => {
    const orch = new PhaseRoundOrchestrator();
    orch.initPhaseRounds('ticket-5', 4, [
      { agentId: 'executor-bot', role: 'primary' },
    ]);

    const result = orch.failRound('ticket-5', 4, 'Agent timed out');
    expect(result.action).toBe('FAILED');
    expect(result.state.state).toBe('failed');
  });

  test('isActive returns true only when rounds are in progress', () => {
    const orch = new PhaseRoundOrchestrator();
    expect(orch.isActive('ticket-6', 4)).toBe(false);

    orch.initPhaseRounds('ticket-6', 4, [{ agentId: 'bot', role: 'r' }]);
    expect(orch.isActive('ticket-6', 4)).toBe(true);

    orch.completeRound('ticket-6', 4, 'bot');
    expect(orch.isActive('ticket-6', 4)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. CONSENSUS REVIEW — MULTI-AGENT AGREEMENT
// ═══════════════════════════════════════════════════════════════════════

test.describe('Consensus Review', () => {
  test('consensus review with no mesh falls back to structural verdict', async () => {
    const service = new ConsensusReviewService(); // No mesh deps
    const outcome = await service.review(
      createWorkItem(),
      [{ unitId: 'u1', title: 'Test', description: 'Test work', acceptanceCriteria: ['AC1'], labels: [], priority: 'medium', parentUnitId: null, depth: 0 }],
      'code-developer',
      'Implementation complete',
      { status: 'passed', summary: 'All checks passed', findings: ['structural-passed'] },
    );

    expect(outcome.reviewerCount).toBe(2);
    expect(outcome.consensus).toBe('approved');
    expect(outcome.verdicts).toHaveLength(2);
  });

  test('consensus review rejects when execution verification failed', async () => {
    const service = new ConsensusReviewService();
    const outcome = await service.review(
      createWorkItem(),
      [{ unitId: 'u1', title: 'Test', description: 'Test work', acceptanceCriteria: ['AC1'], labels: [], priority: 'medium', parentUnitId: null, depth: 0 }],
      'code-developer',
      'Incomplete output',
      { status: 'failed', summary: 'Output too short', findings: ['output-too-short'], regressionTarget: 'build' },
    );

    // When execution verification failed, structural fallback returns 'needs_revision' for both reviewers.
    // Split verdicts (no full approval) = consensus 'split', which is treated as a rejection.
    expect(outcome.consensus).toBe('split');
    expect(outcome.approvedCount).toBe(0);
  });

  test('consensus review dispatch includes work-intent review focus in the envelope payload', async () => {
    const meshTransport = new CapturingReviewMeshTransport();
    const workItemRepository = new ReviewWorkItemRepositoryStub();
    workItemRepository.items.push({
      externalId: 'review:issue-integ-001:r1',
      status: 'completed',
      executionOutput: 'Verdict: APPROVED\n- Testing evidence is present\n- README updates are present',
    });
    workItemRepository.items.push({
      externalId: 'review:issue-integ-001:r2',
      status: 'completed',
      executionOutput: 'Verdict: APPROVED\n- Testing evidence is present\n- README updates are present',
    });

    const service = new ConsensusReviewService({
      meshTransport: meshTransport as never,
      workItemRepository: workItemRepository as never,
    });

    await service.review(
      createWorkItem(),
      [
        {
          unitId: 'u1',
          title: 'Write tests',
          workType: 'testing',
          description: 'Add tests for the feature',
          acceptanceCriteria: ['Relevant tests are added and pass.'],
          labels: [],
          priority: 'medium',
          parentUnitId: null,
          depth: 0,
        },
        {
          unitId: 'u2',
          title: 'Update docs',
          workType: 'documentation',
          description: 'Update the README',
          acceptanceCriteria: ['README is updated.'],
          labels: [],
          priority: 'medium',
          parentUnitId: null,
          depth: 0,
        },
      ],
      'code-developer',
      'Implemented the feature, added tests, updated README.',
      { status: 'failed', summary: 'Testing evidence was incomplete', findings: ['missing-testing-evidence:u1'], regressionTarget: 'build' },
    );

    const payload = meshTransport.envelopes[0]?.payload as Record<string, unknown>;
    expect(payload?.type).toBe('consensus-review-request');
    expect(String(payload?.reviewFocus || '')).toContain('testing, documentation');
    expect(String(payload?.reviewFocus || '')).toContain('missing-testing-evidence:u1');
  });

  test('consensus review normalizes reviewer findings into evidence-class signals', async () => {
    const meshTransport = new CapturingReviewMeshTransport();
    const workItemRepository = new ReviewWorkItemRepositoryStub();
    const reviewerOutput = [
      'Verdict: NEEDS REVISION',
      'Findings:',
      '- Missing test coverage for token refresh failures',
      '- README update is not shown in the output',
      'Summary: Delivery is close but missing required proof.',
    ].join('\n');
    workItemRepository.items.push({
      externalId: 'review:issue-integ-001:r1',
      status: 'completed',
      executionOutput: reviewerOutput,
    });
    workItemRepository.items.push({
      externalId: 'review:issue-integ-001:r2',
      status: 'completed',
      executionOutput: reviewerOutput,
    });

    const service = new ConsensusReviewService({
      meshTransport: meshTransport as never,
      workItemRepository: workItemRepository as never,
    });

    const outcome = await service.review(
      createWorkItem(),
      [
        {
          unitId: 'u1',
          title: 'Write auth tests',
          workType: 'testing',
          description: 'Add tests for token refresh behavior.',
          acceptanceCriteria: ['Relevant tests are added and pass.'],
          labels: [],
          priority: 'medium',
          parentUnitId: null,
          depth: 0,
        },
        {
          unitId: 'u2',
          title: 'Update README',
          workType: 'documentation',
          description: 'Document the refresh behavior.',
          acceptanceCriteria: ['README is updated with setup and usage notes.'],
          labels: [],
          priority: 'medium',
          parentUnitId: null,
          depth: 0,
        },
      ],
      'code-developer',
      'Implemented the feature and produced output for review.',
      { status: 'passed', summary: 'Execution checks passed', findings: ['structural-checks-passed'] },
    );

    expect(outcome.consensus).toBe('split');
    expect(outcome.verdicts[0]?.verdict).toBe('needs_revision');
    expect(outcome.verdicts[0]?.summary).toContain('Delivery is close but missing required proof.');
    expect(outcome.findings).toContain('review-missing-testing-evidence:Missing test coverage for token refresh failures');
    expect(outcome.findings).toContain('review-missing-documentation-evidence:README update is not shown in the output');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════════════════════

function createWorkItem(): ExternalWorkItem {
  return {
    provider: 'plane',
    externalId: 'issue-integ-001',
    title: 'Integration test ticket',
    body: '1. Implement feature\n2. Write tests\n3. Document',
    labels: ['swarm'],
    priority: 'medium',
    status: 'Todo',
    workflow: buildExternalTicketWorkflow('backlog'),
    hierarchy: buildExternalTicketHierarchy('issue-integ-001'),
    rawPayload: { id: 'issue-integ-001' },
  };
}

class AlwaysPassVerificationService {
  async verify(): Promise<SwarmVerificationResult> {
    return { status: 'passed', summary: 'All checks passed.', findings: ['all-passed'] };
  }
}

class CapturingWritebackAdapter {
  readonly provider = 'plane' as const;
  readonly updates: TicketWritebackUpdate[] = [];
  async writeCycleUpdate(update: TicketWritebackUpdate): Promise<void> {
    this.updates.push(update);
  }
}

class CapturingReviewMeshTransport {
  readonly envelopes: Array<{ payload: unknown }> = [];

  async publish(envelope: { payload: unknown }): Promise<void> {
    this.envelopes.push(envelope);
  }
}

class ReviewWorkItemRepositoryStub {
  readonly items: Array<{ externalId: string; status: string; executionOutput?: unknown }> = [];

  async findByExternalIdAnyProvider(externalId: string) {
    return this.items.filter((item) => item.externalId === externalId);
  }
}

function createProcessingService(
  verificationService: SwarmVerificationService | AlwaysPassVerificationService,
  writebackAdapter: CapturingWritebackAdapter,
): SwarmTicketProcessingService {
  const intakeService = {
    async pull() {
      return {
        provider: 'plane' as const,
        effectiveCursor: null,
        items: [createWorkItem()],
        source: 'test-fixture',
      };
    },
  } as IntakeService;

  return new SwarmTicketProcessingService(
    intakeService,
    new InMemorySwarmRunStore(),
    undefined,
    undefined,
    undefined,
    new SwarmCyclePolicyService(),
    verificationService as SwarmVerificationService,
    [writebackAdapter],
  );
}
