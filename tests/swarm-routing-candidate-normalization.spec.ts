/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added regression coverage for routing candidate normalization and work-unit-text-aware routing
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added regression to keep task-manager from overmatching build-and-validate execution tickets
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added regression ensuring decomposition-generated testing acceptance criteria strengthen routing toward test specialists
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added online-agent filtering and direct-channel execution envelope regression coverage for targeted swarm dispatch
 */

import { expect, test } from '@playwright/test';
import { MESH_CHANNELS } from '../src/features/agent-management/services/mesh-communication-service';
import { AgentRouter, type RouteCandidate } from '../src/features/agent-management/services/agent-router';
import { TicketDecompositionService } from '../src/features/swarm-orchestration/services/ticket-decomposition-service';
import { buildExecutionEnvelope, normalizeCandidates } from '../src/features/swarm-orchestration/services/swarm-ticket-processing-support';

test.describe('Swarm routing normalization', () => {
  test('normalizeCandidates preserves seeded routing metadata and skips agent-factory for generic tickets', async () => {
    const repository = {
      async listAgents() {
        return [
          {
            agentId: 'a0000000-0000-0000-0000-000000000007',
            name: 'agent-factory',
            status: 'active',
            providerId: 'openai-codex',
            modelId: 'codex-mini-latest',
            baseCapabilities: ['agent-creation'],
            selectorDescriptor: 'Create new agents and personas.',
            routingKeywords: ['create-agent', 'new-agent'],
            projectUrl: '',
            avatarUrl: '',
            themePreference: 'midnight',
            excludeFromBulkConfig: false,
            updatedAt: new Date().toISOString(),
          },
          {
            agentId: 'a0000000-0000-0000-0000-000000000002',
            name: 'code-developer',
            status: 'active',
            providerId: 'openai-codex',
            modelId: 'codex-mini-latest',
            baseCapabilities: ['code-implementation', 'bug-fixing'],
            selectorDescriptor: 'Implements features and bug fixes.',
            routingKeywords: ['implement', 'fix', 'feature', 'code'],
            projectUrl: '',
            avatarUrl: '',
            themePreference: 'midnight',
            excludeFromBulkConfig: false,
            updatedAt: new Date().toISOString(),
          },
        ];
      },
    };

    const candidates = await normalizeCandidates(
      undefined,
      undefined,
      'Implement smoke-test artifact',
      repository as any,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.agentId).toBe('a0000000-0000-0000-0000-000000000002');
    expect(candidates[0]?.capabilities).toEqual(['code-implementation', 'bug-fixing']);
    expect(candidates[0]?.routingKeywords).toEqual(['implement', 'fix', 'feature', 'code']);
  });

  test('normalizeCandidates filters DB candidates to live runtime agents when online registry is available', async () => {
    const repository = {
      async listAgents() {
        return [
          {
            agentId: 'a0000000-0000-0000-0000-000000000001',
            name: 'project-manager',
            status: 'active',
            providerId: 'openai-codex',
            modelId: 'codex-mini-latest',
            baseCapabilities: ['planning'],
            selectorDescriptor: 'Coordinate work.',
            routingKeywords: ['plan'],
            projectUrl: '',
            avatarUrl: '',
            themePreference: 'midnight',
            excludeFromBulkConfig: false,
            updatedAt: new Date().toISOString(),
          },
          {
            agentId: 'a0000000-0000-0000-0000-000000000002',
            name: 'code-developer',
            status: 'active',
            providerId: 'openai-codex',
            modelId: 'codex-mini-latest',
            baseCapabilities: ['code-implementation'],
            selectorDescriptor: 'Implement changes.',
            routingKeywords: ['implement'],
            projectUrl: '',
            avatarUrl: '',
            themePreference: 'midnight',
            excludeFromBulkConfig: false,
            updatedAt: new Date().toISOString(),
          },
        ];
      },
    };

    const candidates = await normalizeCandidates(
      undefined,
      undefined,
      'Implement real feature work',
      repository as any,
      async () => ['a0000000-0000-0000-0000-000000000002'],
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.agentId).toBe('a0000000-0000-0000-0000-000000000002');
  });

  test('buildExecutionEnvelope routes execution to the selected agent direct mesh channel', () => {
    const envelope = buildExecutionEnvelope(
      'run-123',
      'a0000000-0000-0000-0000-000000000002',
      'ticket-123',
      [
        {
          unitId: 'unit-1',
          title: 'Implement feature',
          description: 'Write code.',
          acceptanceCriteria: ['Feature works'],
          labels: ['code'],
        },
      ],
    );

    expect(envelope.toAgentId).toBe('a0000000-0000-0000-0000-000000000002');
    expect(envelope.channel).toBe(MESH_CHANNELS.agentDirect('a0000000-0000-0000-0000-000000000002'));
  });

  test('AgentRouter uses taskText hints when ticket title alone is ambiguous', async () => {
    const router = new AgentRouter();
    const candidates: RouteCandidate[] = [
      {
        agentId: 'a0000000-0000-0000-0000-000000000001',
        score: 1.6,
        reason: 'project manager fallback',
        capabilities: ['planning', 'coordination'],
        routingKeywords: ['coordinate', 'plan'],
      },
      {
        agentId: 'a0000000-0000-0000-0000-000000000002',
        score: 1.5,
        reason: 'developer candidate',
        capabilities: ['code-implementation', 'bug-fixing'],
        routingKeywords: ['implement', 'feature', 'fix', 'test'],
      },
    ];

    const decision = await router.route(
      {
        taskId: 'ticket-123',
        ticketTitle: 'Smoke validation',
        taskText: 'Create a tiny verification artifact. Step 1 is implemented and validated with tests.',
      },
      candidates,
    );

    expect(decision.strategy).toBe('keyword');
    expect(decision.winner.agentId).toBe('a0000000-0000-0000-0000-000000000002');
  });

  test('AgentRouter prefers a test/build specialist over task-manager for build-and-validate execution work', async () => {
    const router = new AgentRouter();
    const candidates: RouteCandidate[] = [
      {
        agentId: 'a0000000-0000-0000-0000-000000000006',
        score: 0.58,
        reason: 'task-manager candidate',
        capabilities: ['QA Validator & Final Gatekeeper — validates deliverables against acceptance criteria', 'quality assurance'],
        routingKeywords: ['validation', 'review', 'acceptance', 'quality'],
      },
      {
        agentId: 'a0000000-0000-0000-0000-000000000005',
        score: 0.78,
        reason: 'test-engineer candidate',
        capabilities: ['Writes and runs tests', 'validates coverage and correctness'],
        routingKeywords: ['test', 'vitest', 'coverage', 'validate'],
      },
    ];

    const decision = await router.route(
      {
        taskId: 'ticket-456',
        ticketTitle: 'Implement smoke artifact validation',
        taskText: 'Create a tiny TypeScript implementation file, a matching Vitest test, and a README. Validate that the result is implemented and tested.',
      },
      candidates,
    );

    expect(decision.strategy).toBe('keyword');
    expect(decision.winner.agentId).toBe('a0000000-0000-0000-0000-000000000005');
  });

  test('decomposition-generated testing criteria push ambiguous tickets toward test-engineer', async () => {
    const router = new AgentRouter();
    const decomposition = new TicketDecompositionService();
    const workUnits = decomposition.decompose({
      provider: 'plane',
      externalId: 'ticket-789',
      title: 'Auth follow-up',
      body: '1. Write tests for token refresh behavior',
      labels: ['auth'],
      priority: 'medium',
      status: 'Todo',
    } as any);
    const taskText = workUnits.map((unit) => [
      unit.title,
      unit.description,
      ...(unit.acceptanceCriteria ?? []),
    ].join(' ')).join(' ');
    const candidates: RouteCandidate[] = [
      {
        agentId: 'a0000000-0000-0000-0000-000000000002',
        score: 0.82,
        reason: 'developer candidate',
        capabilities: ['code-implementation', 'bug-fixing'],
        routingKeywords: ['implement', 'feature', 'fix', 'code'],
      },
      {
        agentId: 'a0000000-0000-0000-0000-000000000005',
        score: 0.78,
        reason: 'test-engineer candidate',
        capabilities: ['Writes and runs tests', 'validates coverage and correctness'],
        routingKeywords: ['test', 'vitest', 'coverage', 'validate'],
      },
    ];

    const decision = await router.route(
      {
        taskId: 'ticket-789',
        ticketTitle: 'Auth follow-up',
        taskText,
      },
      candidates,
    );

    expect(workUnits[0]?.workType).toBe('testing');
    expect(decision.strategy).toBe('keyword');
    expect(decision.winner.agentId).toBe('a0000000-0000-0000-0000-000000000005');
  });
});
