/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added regression coverage for verification-request prompt assembly in swarm LLM execution handler
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added regression preventing execution-only RALF handover instructions from leaking into verification prompts
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added regression coverage for minimal-workspace no-bootstrap execution guidance
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added regression coverage for consensus-review prompt assembly with work-intent review focus
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added regression coverage for deterministic consensus-review output structure instructions
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added regression ensuring swarm execution returns raw provider output even when MOCK_OIDC is enabled
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 moved the ticket body out of the user turn: llm-execution-handler.ts (seq 34) now sends a fixed instruction as the message and carries the body JSON-encoded in the untrusted section of the contained system prompt. The three prompt-assembly cases still read messages[0] and were the ratchet's recorded llm-execution-handler reds. They now decode the ticket-or-user-body block from the system prompt and assert the same text there, and each also asserts the user turn carries none of the ticket, which is the containment the move exists for.
 */

import { test, expect } from '@playwright/test';
import { createLLMExecutionHandler } from '@/features/swarm-orchestration/services';
import { LLMService, type LLMResponse, type SendRequestOptions } from '@/features/llm-provider';
import type { MeshEnvelope } from '@/features/agent-management';
import type { AgentProfile, AgentProfileRepository } from '@/entities/agent';

class RecordingProvider extends LLMService {
  lastRequest: SendRequestOptions | null = null;

  constructor() {
    super('recording-provider', {});
  }

  async sendRequest(options: SendRequestOptions): Promise<LLMResponse> {
    this.lastRequest = options;
    return {
      content: [{ type: 'text', text: 'Verdict: APPROVED' }],
      usage: { inputTokens: 1, outputTokens: 1 },
      model: options.model || 'test-model',
    };
  }
}

/**
 * @description The ticket body the handler assembled, as the model receives it since SEC-05: a
 * JSON record inside the untrusted section of the system prompt, never the user turn. Fails if the
 * body is missing, duplicated, or leaks into the user message.
 * @param request The provider request the handler sent.
 * @param ticketId The envelope's externalId, which must not appear in the user turn.
 * @returns The decoded ticket body text.
 */
function containedTicketBody(request: SendRequestOptions | null, ticketId: string): string {
  const system = String(request?.systemPrompt || '');
  const records = [...system.matchAll(/<UNTRUSTED_CONTENT>([\s\S]*?)<\/UNTRUSTED_CONTENT>/g)]
    .map((match) => JSON.parse(match[1]) as { source: string; content: string });
  const bodies = records.filter((record) => record.source === 'ticket-or-user-body');
  expect(bodies, 'exactly one contained ticket body in the system prompt').toHaveLength(1);
  expect(String(request?.messages[0]?.content || ''), 'the user turn carries no ticket data').not.toContain(ticketId);
  return bodies[0].content;
}

function createProfile(name: string): AgentProfile {
  return {
    agentId: 'a0000000-0000-0000-0000-000000000006',
    name,
    status: 'active',
    providerId: 'openai-codex',
    modelId: 'codex-mini-latest',
    persona: {
      role: 'qa',
      systemPrompt: 'Review outputs and return a QA verdict.',
    },
    baseCapabilities: ['qa-validation'],
    selectorDescriptor: 'Validates acceptance criteria and delivery quality',
    routingKeywords: ['verify', 'qa', 'acceptance'],
    metadata: {
      role: 'worker',
      topology: 'localhost',
    },
    projectUrl: '',
    avatarUrl: '',
    selectorSkillsText: 'Validates deliverables',
    themePreference: 'midnight',
    excludeFromBulkConfig: false,
    updatedAt: new Date().toISOString(),
  };
}

function createRepository(profile: AgentProfile): AgentProfileRepository {
  return {
    getAgentProfile: async () => profile,
  } as unknown as AgentProfileRepository;
}

function createEnvelope(payload: Record<string, unknown>): MeshEnvelope {
  return {
    correlationId: 'run-123:ticket-123',
    fromAgentId: 'swarm-controller',
    toAgentId: 'a0000000-0000-0000-0000-000000000006',
    channel: 'swarm.ticket.execute',
    payload,
  };
}

test.describe('createLLMExecutionHandler', () => {
  test('passes verification context and execution output to the verifier prompt', async () => {
    const provider = new RecordingProvider();
    const handler = createLLMExecutionHandler({
      resolveProvider: () => provider,
      agentProfileRepository: createRepository(createProfile('task-manager')),
      handoverManager: {
        readHandovers: () => [],
        readAgentHandover: () => null,
        generateSummary: () => '',
        generateContextRecall: () => '',
        getHandoverInstructions: () => 'MANDATORY: RALF DEVELOPER HANDOVER',
      } as never,
    });

    await handler(createEnvelope({
      externalId: 'verify:ticket-123',
      type: 'verification-request',
      originalTicket: {
        externalId: 'ticket-123',
        title: 'Smoke artifact ticket',
        description: 'Confirm Step 1 is implemented and validated.',
      },
      executionOutput: {
        content: 'Implemented src/step1Smoke.ts, tests/step1Smoke.test.ts, README.md. npm test passed with 3/3 tests.',
      },
      workUnits: [
        {
          title: 'Implement Step 1',
          description: 'Create the smoke artifact and validate it.',
          acceptanceCriteria: ['Step 1 is implemented and validated.'],
        },
      ],
    }));

    const prompt = containedTicketBody(provider.lastRequest, 'verify:ticket-123');
    const systemPrompt = String(provider.lastRequest?.systemPrompt || '');
    expect(prompt).toContain('Verification Ticket: verify:ticket-123');
    expect(prompt).toContain('Original Ticket: ticket-123');
    expect(prompt).toContain('Execution Output To Review:');
    expect(prompt).toContain('npm test passed with 3/3 tests');
    expect(prompt).toContain('Do not re-implement the ticket or bootstrap a new project');
    expect(prompt).toContain('Verdict: APPROVED');
    expect(prompt).toContain('Verdict: REJECTED');
    expect(prompt).toContain('Verdict: NEEDS REVISION');
    expect(systemPrompt).toContain('vitest run --config vitest.config.ts');
    expect(systemPrompt).toContain('npm install --include=dev');
    expect(systemPrompt).not.toContain('MANDATORY: RALF DEVELOPER HANDOVER');
  });

  test('keeps standard execution prompts focused on work units', async () => {
    const provider = new RecordingProvider();
    const handler = createLLMExecutionHandler({
      resolveProvider: () => provider,
      agentProfileRepository: createRepository(createProfile('test-engineer')),
    });

    await handler(createEnvelope({
      externalId: 'ticket-456',
      workUnits: [
        {
          title: 'Add smoke tests',
          description: 'Write one happy-path and one edge-case test.',
          acceptanceCriteria: ['Tests are added.', 'Tests pass.'],
        },
      ],
    }));

    const prompt = containedTicketBody(provider.lastRequest, 'ticket-456');
    const systemPrompt = String(provider.lastRequest?.systemPrompt || '');
    expect(prompt).toContain('Ticket: ticket-456');
    expect(prompt).toContain('## Add smoke tests');
    expect(prompt).not.toContain('Execution Output To Review:');
    expect(prompt).not.toContain('Do not re-implement the ticket');
    expect(systemPrompt).toContain('Workspace execution notes:');
  });

  test('passes work-intent review focus into consensus-review prompts', async () => {
    const provider = new RecordingProvider();
    const handler = createLLMExecutionHandler({
      resolveProvider: () => provider,
      agentProfileRepository: createRepository(createProfile('task-manager')),
    });

    await handler(createEnvelope({
      externalId: 'review:ticket-999:r1',
      type: 'consensus-review-request',
      round: 1,
      role: 'qa-gatekeeper',
      reviewFocus: 'Review the deliverable with emphasis on testing, documentation. Prior verification findings: missing-testing-evidence:unit-1.',
      originalTicket: {
        externalId: 'ticket-999',
        title: 'Auth refresh hardening',
        description: 'Implement the feature, write tests, and update the README.',
      },
      executionOutput: {
        content: 'Implemented src/authRefresh.ts, added tests/authRefresh.test.ts, and updated README.md.',
      },
      workUnits: [
        {
          title: 'Write auth tests',
          workType: 'testing',
          description: 'Add tests for token refresh behavior.',
          acceptanceCriteria: ['Relevant tests are added and pass.'],
        },
        {
          title: 'Update README',
          workType: 'documentation',
          description: 'Document the refresh behavior.',
          acceptanceCriteria: ['README is updated with setup and usage notes.'],
        },
      ],
    }));

    const prompt = containedTicketBody(provider.lastRequest, 'review:ticket-999:r1');
    expect(prompt).toContain('Consensus Review Ticket: review:ticket-999:r1');
    expect(prompt).toContain('Reviewer Role: qa-gatekeeper');
    expect(prompt).toContain('Review Focus: Review the deliverable with emphasis on testing, documentation.');
    expect(prompt).toContain('Work Type: testing');
    expect(prompt).toContain('Work Type: documentation');
    expect(prompt).toContain('You are participating in consensus review only.');
    expect(prompt).toContain('Use this exact structure: Verdict: <...>, Findings:, - <finding>, Summary: <one-line conclusion>.');
    expect(prompt).toContain('Call out evidence and gaps that match the review focus');
  });

  test('adds no-bootstrap guidance for minimal smoke-artifact execution tasks', async () => {
    const provider = new RecordingProvider();
    const handler = createLLMExecutionHandler({
      resolveProvider: () => provider,
      agentProfileRepository: createRepository(createProfile('test-engineer')),
    });

    await handler(createEnvelope({
      externalId: 'ticket-789',
      workUnits: [
        {
          title: 'Create tiny smoke artifact',
          description: 'Build a tiny standalone formatter with a matching Vitest test.',
          acceptanceCriteria: ['The minimal smoke artifact is implemented and validated.'],
        },
      ],
    }));

    const systemPrompt = String(provider.lastRequest?.systemPrompt || '');
    expect(systemPrompt).toContain('Minimal workspace policy:');
    expect(systemPrompt).toContain('Do not run `npm init`');
    expect(systemPrompt).toContain('tests/*.test.ts');
    expect(systemPrompt).toContain('do not expand scope with optional hardening');
  });

  test('returns raw provider output without MOCK_OIDC deliverable substitution', async () => {
    const provider = new RecordingProvider();
    const previousMockOidc = process.env.MOCK_OIDC;
    process.env.MOCK_OIDC = 'true';

    try {
      const handler = createLLMExecutionHandler({
        resolveProvider: () => provider,
        agentProfileRepository: createRepository(createProfile('test-engineer')),
      });

      provider.sendRequest = async (options: SendRequestOptions): Promise<LLMResponse> => {
        provider.lastRequest = options;
        return {
          content: [{
            type: 'text',
            text: '[noop] You said: deterministic stub response from the Noop provider',
          }],
          usage: { inputTokens: 1, outputTokens: 1 },
          model: options.model || 'test-model',
        };
      };

      const result = await handler(createEnvelope({
        externalId: 'ticket-raw-output',
        workUnits: [{
          title: 'Verify direct runtime output',
          description: 'Ensure execution returns provider response verbatim.',
          acceptanceCriteria: ['Raw provider output is returned unchanged.'],
        }],
      }));

      expect(result.success).toBe(true);
      expect(result.output?.content).toBe('[noop] You said: deterministic stub response from the Noop provider');
    } finally {
      if (previousMockOidc === undefined) {
        delete process.env.MOCK_OIDC;
      } else {
        process.env.MOCK_OIDC = previousMockOidc;
      }
    }
  });

  test('threads ownerSub from the envelope into cost recording', async () => {
    const provider = new RecordingProvider();
    const costEvents: Array<Record<string, unknown>> = [];
    const handler = createLLMExecutionHandler({
      resolveProvider: () => provider,
      agentProfileRepository: createRepository(createProfile('test-engineer')),
      recordCost: async (event) => {
        costEvents.push(event);
      },
    });

    await handler(createEnvelope({
      externalId: 'ticket-owned-cost',
      userSub: 'user-alpha',
      originalTicket: {
        externalId: 'ticket-owned-cost',
        ownerSub: 'user-alpha',
        title: 'Owned task',
        description: 'Record cost under the caller.',
      },
      workUnits: [{
        title: 'Do owned work',
        description: 'Generate a tiny answer.',
        acceptanceCriteria: ['Cost is attributed to the caller.'],
      }],
    }));

    expect(costEvents).toHaveLength(1);
    expect(costEvents[0].ownerSub).toBe('user-alpha');
    expect(costEvents[0].ticketExternalId).toBe('ticket-owned-cost');
  });
});
