/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | IMP-1: Unit tests for intelligent escalation routing — failure classification, eligibility, and adaptive rerouting
 */

import { test, expect } from '@playwright/test';
import {
  classifyRoutingFailure,
  isReroutable,
} from '../src/features/swarm-orchestration/services/routing-failure-classifier-service';
import {
  attemptAdaptiveReroute,
  buildSuccessfulRouteDecision,
} from '../src/features/swarm-orchestration/services/adaptive-reroute-service';
import {
  AgentEligibilityService,
} from '../src/features/agent-management/services/agent-eligibility-service';

// ─── Failure Classification ────────────────────────────────────────

test.describe('Routing Failure Classifier', () => {
  test('classifies "no online swarm agents" as no_online_candidates', () => {
    const failure = classifyRoutingFailure(
      new Error('No online swarm agents matched the routing candidates for ticket "test"'),
    );
    expect(failure.type).toBe('no_online_candidates');
    expect(failure.reroutable).toBe(false);
  });

  test('classifies timeout errors as reroutable', () => {
    const failure = classifyRoutingFailure(new Error('Agent dispatch timed out after 60s'));
    expect(failure.type).toBe('timeout');
    expect(failure.reroutable).toBe(true);
  });

  test('classifies dead channel as reroutable', () => {
    const failure = classifyRoutingFailure(new Error('Channel oshal:mesh:agent:direct:bot has no consumer'));
    expect(failure.type).toBe('runtime_channel_dead');
    expect(failure.reroutable).toBe(true);
  });

  test('classifies credential errors as reroutable', () => {
    const failure = classifyRoutingFailure(new Error('Not authenticated with OpenAI Codex - API key missing'));
    expect(failure.type).toBe('missing_required_tool_or_config');
    expect(failure.reroutable).toBe(true);
  });

  test('classifies parse/decomposition errors as non-reroutable', () => {
    const failure = classifyRoutingFailure(new Error('PM planning output could not be parsed — decomposition failed'));
    expect(failure.type).toBe('malformed_task_context');
    expect(failure.reroutable).toBe(false);
  });

  test('includes context evidence in classification', () => {
    const failure = classifyRoutingFailure(new Error('timeout'), {
      agentId: 'code-developer',
      phase: 4,
      candidateCount: 12,
    });
    expect(failure.evidence).toContain('target_agent=code-developer');
    expect(failure.evidence).toContain('phase=4');
    expect(failure.evidence).toContain('candidates=12');
  });

  test('classifies unknown errors as non-reroutable', () => {
    const failure = classifyRoutingFailure(new Error('something unexpected'));
    expect(failure.type).toBe('unknown');
    expect(failure.reroutable).toBe(false);
  });

  test('isReroutable helper matches failure.reroutable', () => {
    const timeout = classifyRoutingFailure(new Error('timed out'));
    expect(isReroutable(timeout)).toBe(true);
    const parse = classifyRoutingFailure(new Error('decomposition failed'));
    expect(isReroutable(parse)).toBe(false);
  });
});

// ─── Adaptive Rerouting ────────────────────────────────────────────

test.describe('Adaptive Reroute Service', () => {
  test('reroutes to best eligible alternative on timeout', () => {
    const decision = attemptAdaptiveReroute({
      requestedAgentId: 'agent-a',
      requestedRole: 'code-developer',
      error: new Error('Agent dispatch timed out'),
      phase: 4,
      ticketId: 'ticket-123',
      eligibleCandidates: [
        { agentId: 'agent-b', agentName: 'code-reviewer', online: true, dbActive: true, eligible: true, score: 0.8, rejectionReasons: [] },
        { agentId: 'agent-c', agentName: 'test-engineer', online: true, dbActive: true, eligible: true, score: 0.6, rejectionReasons: [] },
      ],
      allCandidates: [
        { agentId: 'agent-a', agentName: 'code-developer', online: false, dbActive: true, eligible: false, score: 0, rejectionReasons: ['bot_offline'] },
        { agentId: 'agent-b', agentName: 'code-reviewer', online: true, dbActive: true, eligible: true, score: 0.8, rejectionReasons: [] },
        { agentId: 'agent-c', agentName: 'test-engineer', online: true, dbActive: true, eligible: true, score: 0.6, rejectionReasons: [] },
      ],
    });

    expect(decision.decision).toBe('rerouted');
    expect(decision.chosenAgentId).toBe('agent-b');
    expect(decision.failureType).toBe('timeout');
    expect(decision.rationale.length).toBeGreaterThan(0);
    expect(decision.consideredCandidates.length).toBe(3);
  });

  test('escalates when no eligible alternatives exist', () => {
    const decision = attemptAdaptiveReroute({
      requestedAgentId: 'agent-a',
      requestedRole: 'code-developer',
      error: new Error('Agent dispatch timed out'),
      phase: 4,
      ticketId: 'ticket-456',
      eligibleCandidates: [],
      allCandidates: [
        { agentId: 'agent-a', agentName: 'code-developer', online: false, dbActive: true, eligible: false, score: 0, rejectionReasons: ['bot_offline'] },
      ],
    });

    expect(decision.decision).toBe('escalated');
    expect(decision.chosenAgentId).toBeNull();
    expect(decision.nextAction).toContain('Escalated');
  });

  test('escalates on non-reroutable failure even with available agents', () => {
    const decision = attemptAdaptiveReroute({
      requestedAgentId: 'agent-a',
      requestedRole: 'pm',
      error: new Error('PM planning output could not be parsed — decomposition failed'),
      phase: 2,
      ticketId: 'ticket-789',
      eligibleCandidates: [
        { agentId: 'agent-b', agentName: 'code-reviewer', online: true, dbActive: true, eligible: true, score: 0.8, rejectionReasons: [] },
      ],
      allCandidates: [
        { agentId: 'agent-a', agentName: 'pm', online: true, dbActive: true, eligible: true, score: 0.9, rejectionReasons: [] },
        { agentId: 'agent-b', agentName: 'code-reviewer', online: true, dbActive: true, eligible: true, score: 0.8, rejectionReasons: [] },
      ],
    });

    expect(decision.decision).toBe('escalated');
    expect(decision.failureType).toBe('malformed_task_context');
  });

  test('buildSuccessfulRouteDecision returns clean decision', () => {
    const decision = buildSuccessfulRouteDecision('agent-a', 'code-developer', 'developer', 'ticket-001');
    expect(decision.decision).toBe('routed');
    expect(decision.chosenAgentId).toBe('agent-a');
    expect(decision.failureType).toBeNull();
  });

  test('decision includes all considered candidates with rejection reasons', () => {
    const decision = attemptAdaptiveReroute({
      requestedAgentId: 'agent-a',
      error: new Error('timed out'),
      ticketId: 'ticket-999',
      eligibleCandidates: [
        { agentId: 'agent-c', agentName: 'bot-c', online: true, dbActive: true, eligible: true, score: 0.7, rejectionReasons: [] },
      ],
      allCandidates: [
        { agentId: 'agent-a', agentName: 'bot-a', online: false, dbActive: true, eligible: false, score: 0, rejectionReasons: ['bot_offline'] },
        { agentId: 'agent-b', agentName: 'bot-b', online: true, dbActive: false, eligible: false, score: 0, rejectionReasons: ['bot_disabled'] },
        { agentId: 'agent-c', agentName: 'bot-c', online: true, dbActive: true, eligible: true, score: 0.7, rejectionReasons: [] },
      ],
    });

    expect(decision.consideredCandidates.length).toBe(3);
    const rejected = decision.consideredCandidates.filter((c) => !c.eligible);
    expect(rejected.length).toBe(2);
    expect(rejected[0].rejectionReasons.length).toBeGreaterThan(0);
  });
});

// ─── Agent Eligibility ─────────────────────────────────────────────

test.describe('Agent Eligibility Service', () => {
  test('returns empty array with no registries', async () => {
    const service = new AgentEligibilityService();
    const result = await service.evaluateAll();
    expect(result).toEqual([]);
  });

  test('getEligible filters to eligible only', async () => {
    const service = new AgentEligibilityService();
    const result = await service.getEligible();
    expect(result).toEqual([]);
  });
});
