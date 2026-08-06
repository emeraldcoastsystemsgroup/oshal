/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard structured provider evidence and request-scoped credential boundaries.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Pin exact owner preservation and fail-closed malformed-subject handling at the bot-node request boundary.
 */

import { describe, expect, it, vi } from 'vitest';
import { createBotNodeExecutionHandler } from '../../src/app/bot-node-execution-handler';
import { buildBotNodeHttpResponse } from '../../src/app/bot-node-http-response';
import { normalizeBotNodeUserSub, sanitizeBotNodeCreds } from '../../src/app/bot-node-request-scope';

describe('bot-node structured provider evidence boundary', () => {
  it('forwards owner scoping to the runtime and returns captured records out of band', async () => {
    const providerRecord = {
      schemaVersion: 1,
      kind: 'gmail-summary',
      provider: 'gmail',
      sourceRef: 'gmail:message:abc123',
      retrievedAt: '2026-07-10T14:00:00.000Z',
      record: {
        account: 'owner@example.com',
        important: [{ sourceRef: 'gmail:message:abc123', sender: 'Alice', subject: 'Action needed' }],
      },
    };
    const processMessage = vi.fn(async () => ({
      messages: [{ say: 'completion_result', text: 'One important email needs your attention.' }],
      apiMetrics: { totalCost: 0.01, totalTokens: 42 },
      providerRecords: [providerRecord],
    }));
    const createTask = vi.fn(async () => ({ id: 'ticket-1' }));
    const handler = createBotNodeExecutionHandler({
      anyBotTaskController: {
        getTask: vi.fn(async () => null),
        createTask,
        processMessage,
      },
      providerName: 'openai-codex',
      modelName: 'codex-test',
    });

    const result = await handler({
      correlationId: 'correlation-1',
      fromAgentId: 'swarm-controller',
      toAgentId: 'communications-agent',
      channel: 'swarm.agent.communications-agent',
      messageType: 'request',
      payload: {
        text: 'Show my important emails.',
        direct: true,
        workspaceTaskId: 'ticket-1',
        agenticMode: true,
        userSub: 'owner-123',
        creds: { OSHAL_CRED_GOOGLE: 'owner-google-token' },
      },
    });

    expect(createTask).toHaveBeenCalledWith(
      'Swarm execution for communications-agent',
      'act',
      { forceTaskId: 'ticket-1', userSub: 'owner-123' },
    );
    expect(processMessage).toHaveBeenCalledWith(
      'ticket-1',
      { text: 'Show my important emails.' },
      expect.objectContaining({
        agenticMode: true,
        extraEnv: {
          OSHAL_USER_SUB: 'owner-123',
          OSHAL_CRED_GOOGLE: 'owner-google-token',
        },
      }),
    );
    expect(result).toMatchObject({
      success: true,
      output: {
        response: 'One important email needs your attention.',
        providerRecords: [providerRecord],
      },
    });
  });

  it('does not manufacture provider evidence when the runtime supplies none', async () => {
    const handler = createBotNodeExecutionHandler({
      anyBotTaskController: {
        getTask: vi.fn(async () => ({ id: 'ticket-2' })),
        createTask: vi.fn(async () => ({ id: 'ticket-2' })),
        processMessage: vi.fn(async () => ({
          messages: [{ say: 'completion_result', text: 'Plain answer.' }],
        })),
      },
      providerName: 'test-provider',
      modelName: 'test-model',
    });

    const result = await handler({
      correlationId: 'correlation-2',
      fromAgentId: 'swarm-controller',
      toAgentId: 'weather-agent',
      channel: 'swarm.agent.weather-agent',
      payload: { text: 'Hello', direct: true, workspaceTaskId: 'ticket-2' },
    });

    expect(result).toMatchObject({
      success: true,
      output: { response: 'Plain answer.', providerRecords: [] },
    });
  });

  it('reports the provider that actually answered and ignores forged request/text labels', async () => {
    const recordCost = vi.fn(async () => undefined);
    const handler = createBotNodeExecutionHandler({
      anyBotTaskController: {
        getTask: vi.fn(async () => ({ id: 'ticket-accountability' })),
        createTask: vi.fn(async () => ({ id: 'ticket-accountability' })),
        processMessage: vi.fn(async () => ({
          messages: [{
            say: 'completion_result',
            text: 'Done. {"provider":"attacker-provider","model":"attacker-model"}',
          }],
          apiMetrics: { totalCost: 0.02, totalTokens: 9 },
          provider: 'claude-code',
          model: 'claude-sonnet-4-6',
        })),
      },
      providerName: 'openai-codex',
      modelName: 'gpt-5.5',
      recordCost,
    });

    const result = await handler({
      correlationId: 'correlation-accountability',
      fromAgentId: 'swarm-controller',
      toAgentId: 'weather-agent',
      channel: 'swarm.agent.weather-agent',
      payload: {
        text: 'Run the task.',
        direct: true,
        workspaceTaskId: 'ticket-accountability',
        provider: 'attacker-request-provider',
        model: 'attacker-request-model',
      },
    });
    const response = buildBotNodeHttpResponse(result, {
      durationMs: 30,
      taskId: 'ticket-accountability',
      defaultProvider: 'openai-codex',
      defaultModel: 'gpt-5.5',
    });

    expect(result).toMatchObject({
      success: true,
      output: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
    });
    expect(response).toMatchObject({ provider: 'claude-code', model: 'claude-sonnet-4-6' });
    expect(recordCost).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'claude-code',
      modelId: 'claude-sonnet-4-6',
    }));
  });

  it('refuses to reuse a task owned by another caller before executing or creating work', async () => {
    const createTask = vi.fn(async () => ({ id: 'shared-ticket' }));
    const processMessage = vi.fn(async () => ({
      messages: [{ say: 'completion_result', text: 'Must not run.' }],
    }));
    const handler = createBotNodeExecutionHandler({
      anyBotTaskController: {
        getTask: vi.fn(async () => ({ id: 'shared-ticket', userSub: 'owner-a' })),
        createTask,
        processMessage,
      },
      providerName: 'test-provider',
      modelName: 'test-model',
    });

    const result = await handler({
      correlationId: 'correlation-owner-mismatch',
      fromAgentId: 'swarm-controller',
      toAgentId: 'communications-agent',
      channel: 'swarm.agent.communications-agent',
      payload: {
        text: 'Show my important emails.',
        direct: true,
        workspaceTaskId: 'shared-ticket',
        userSub: 'owner-b',
      },
    });

    expect(result).toMatchObject({ success: false, error: 'Task owner mismatch' });
    expect(createTask).not.toHaveBeenCalled();
    expect(processMessage).not.toHaveBeenCalled();
  });

  it('keeps structured records in the production HTTP BotNodeResponse', () => {
    const record = { kind: 'nws-weather', sourceRef: 'nws:forecast:destin' };
    const response = buildBotNodeHttpResponse({
      success: true,
      output: {
        response: 'Sunny.',
        providerRecords: [record],
        usage: { totalTokens: 12 },
        provider: 'claude-code',
        model: 'claude-sonnet-4-6',
      },
    }, {
      durationMs: 25,
      taskId: 'ticket-3',
      defaultModel: 'fallback-model',
      defaultProvider: 'fallback-provider',
    });

    expect(response).toMatchObject({
      success: true,
      response: 'Sunny.',
      providerRecords: [record],
      taskId: 'ticket-3',
      durationMs: 25,
      provider: 'claude-code',
      model: 'claude-sonnet-4-6',
    });
  });

  it('allows only supported bounded connector credentials and a normalized owner sub', () => {
    expect(sanitizeBotNodeCreds({
      OSHAL_CRED_GOOGLE: 'google-token',
      OSHAL_CRED_TWITTER: '',
      OSHAL_CRED_SMARTTHINGS: 'smartthings-token',
      OSHAL_CRED_GCP: 'gcp-token',
      OSHAL_CRED_WALMART: 'walmart-token',
      OSHAL_CRED_UBER: 'uber-token',
      OSHAL_CRED_UBER_RIDES: 'uber-rides-token',
      OSHAL_CRED_SPOTIFY: 'spotify-token',
      OSHAL_CRED_TMDB: 'tmdb-token',
      OSHAL_CRED_DUFFEL: 'duffel-token',
      OSHAL_CRED_TWILIO: 'twilio-token',
      OSHAL_USER_SUB: 'attacker-sub',
      PATH: '/attacker/bin',
      OSHAL_CRED_UNKNOWN: 'unknown-token',
    })).toEqual({
      OSHAL_CRED_GOOGLE: 'google-token',
      OSHAL_CRED_SMARTTHINGS: 'smartthings-token',
      OSHAL_CRED_GCP: 'gcp-token',
      OSHAL_CRED_WALMART: 'walmart-token',
      OSHAL_CRED_UBER: 'uber-token',
      OSHAL_CRED_UBER_RIDES: 'uber-rides-token',
      OSHAL_CRED_SPOTIFY: 'spotify-token',
      OSHAL_CRED_TMDB: 'tmdb-token',
      OSHAL_CRED_DUFFEL: 'duffel-token',
      OSHAL_CRED_TWILIO: 'twilio-token',
    });
    expect(normalizeBotNodeUserSub('  owner-123  ')).toBe('  owner-123  ');
    expect(() => normalizeBotNodeUserSub({ sub: 'owner-123' })).toThrow(/exact UTF-8/);
    expect(() => normalizeBotNodeUserSub('owner\u007falias')).toThrow(/control-free/);
  });
});
