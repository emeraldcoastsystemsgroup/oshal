import { describe, expect, it } from 'vitest';
import { buildInlineControllerBotProfileSeed } from '../../src/app/extensions/swarm/inline-controller-bot-seeder';

describe('inline controller bot profile seeding', () => {
  it('builds selector-ready agent rows from registry plus persona metadata', () => {
    const seed = buildInlineControllerBotProfileSeed(
      {
        agentId: 'a0000000-0000-0000-0000-000000000051',
        name: 'workflow-assistant',
        port: 3010,
        container: 'oshal-api',
        role: 'workflow/orchestration-specialist',
        capabilities: ['workflow-design'],
        harnessType: 'claude-code',
        apiType: 'claude-code',
      },
      {
        role: 'Workflow Orchestration Specialist',
        perspective: 'You turn process descriptions into workflow graphs.',
        capabilities: ['workflow-validation'],
        selector_descriptor: 'Select this bot for workflow design.',
        routing_keywords: ['workflow', 'automation'],
      },
    );

    expect(seed).toMatchObject({
      agentId: 'a0000000-0000-0000-0000-000000000051',
      name: 'workflow-assistant',
      apiProviderId: 'claude-code',
      selectorDescriptor: 'Select this bot for workflow design.',
      routingKeywords: ['workflow', 'automation', 'workflow-validation', 'workflow-design'],
    });
    expect(seed?.capabilities).toEqual(['workflow-validation', 'workflow-design']);
    expect(seed?.metadata.inlineControllerBot).toBe(true);
  });

  it('does not seed dedicated bot-node containers', () => {
    const seed = buildInlineControllerBotProfileSeed(
      {
        agentId: 'a0000000-0000-0000-0000-000000000050',
        name: 'oshal-assistant',
        port: 3052,
        container: 'jarvis-bot',
        role: 'assistant/unified-front-door',
        capabilities: ['intent-routing'],
      },
      null,
    );

    expect(seed).toBeNull();
  });
});
