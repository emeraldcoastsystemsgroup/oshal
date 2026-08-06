import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../../src/app/composition/app-context';
import { executeBotOrInline } from '../../src/app/routes/inline-bot-execution';
import type { BotNodeClient, BotNodeRequest } from '../../src/features/agent-management';

const request: BotNodeRequest = {
  text: 'draft the thing',
  taskId: 'inline-task',
  workspaceFolderId: 'inline-task',
  agentId: 'inline-agent',
  agenticMode: true,
  direct: true,
  userSub: 'user-1',
};

describe('executeBotOrInline', () => {
  it('uses remote bot-node execution when the agent has an endpoint', async () => {
    const remoteResponse = {
      success: true,
      response: 'remote',
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
      cost: 0.01,
      model: 'remote-model',
      provider: 'remote-provider',
      durationMs: 10,
    };
    const botClient = {
      hasEndpoint: vi.fn(() => true),
      execute: vi.fn(async () => remoteResponse),
    } as unknown as BotNodeClient;
    const ctx = {
      orchestrator: {
        processMessage: vi.fn(async () => {
          throw new Error('local orchestrator should not run');
        }),
      },
    } as unknown as AppContext;

    const response = await executeBotOrInline(ctx, botClient, 'inline-agent', request);

    expect(response).toBe(remoteResponse);
    expect(botClient.hasEndpoint).toHaveBeenCalledWith('inline-agent');
    expect(botClient.execute).toHaveBeenCalledWith('inline-agent', request);
    expect(ctx.orchestrator.processMessage).not.toHaveBeenCalled();
  });

  it('routes controller-inline agents through the local orchestrator with owner identity and no credential carrier', async () => {
    const botClient = {
      hasEndpoint: vi.fn(() => false),
      execute: vi.fn(async () => {
        throw new Error('remote bot execute should not run');
      }),
    } as unknown as BotNodeClient;
    const processMessage = vi.fn(async () => ({
      success: true,
      response: 'local',
      turnCount: 1,
      toolsUsed: [],
      usageSummary: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        inputCost: 0.001,
        outputCost: 0.002,
        totalCost: 0.003,
        currency: 'USD',
        requestCount: 1,
        byModel: {
          'inline-model': {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            inputCost: 0.001,
            outputCost: 0.002,
            totalCost: 0.003,
            requestCount: 1,
          },
        },
      },
    }));
    const ctx = { orchestrator: { processMessage } } as unknown as AppContext;

    const response = await executeBotOrInline(ctx, botClient, 'inline-agent', request);

    expect(botClient.execute).not.toHaveBeenCalled();
    expect(processMessage).toHaveBeenCalledWith('inline-task', 'draft the thing', expect.objectContaining({
      source: 'inline-bot',
      agentId: 'inline-agent',
      userSub: 'user-1',
      interactionMode: 'task',
    }));
    expect(processMessage.mock.calls[0][2]).not.toHaveProperty('creds');
    expect(response).toMatchObject({
      success: true,
      response: 'local',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      cost: 0.003,
      model: 'inline-model',
      provider: 'inline-orchestrator',
      taskId: 'inline-task',
    });
  });

  it('rejects generic connector credentials before remote or inline work is accepted', async () => {
    const botClient = {
      hasEndpoint: vi.fn(() => true),
      execute: vi.fn(),
    } as unknown as BotNodeClient;
    const processMessage = vi.fn();
    const ctx = { orchestrator: { processMessage } } as unknown as AppContext;

    await expect(executeBotOrInline(ctx, botClient, 'inline-agent', {
      ...request,
      creds: { OSHAL_CRED_GOOGLE: 'must-not-enter-model' },
    })).rejects.toMatchObject({ code: 'UNSCOPED_CREDENTIAL_CARRIER' });
    expect(botClient.execute).not.toHaveBeenCalled();
    expect(processMessage).not.toHaveBeenCalled();
  });
});
