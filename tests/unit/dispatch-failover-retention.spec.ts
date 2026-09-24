/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit tests for retaining completed work when failover provider succeeds after initial dispatch failure (BACKLOG #1660). Proves fallbackOrder parsing, fallback matching in dispatchConfigMatchesActive, and end-to-end work retention and cost attribution in createBotNodeExecutionHandler.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it, vi } from 'vitest';
import {
  parseCarriedDispatchConfig,
  dispatchConfigMatchesActive,
} from '../../src/app/bot-node-dispatch-config';
import { createBotNodeExecutionHandler } from '../../src/app/bot-node-execution-handler';
import type { MeshEnvelope } from '../../src/features/agent-management/services/mesh-communication-service';
import type { DispatchConfigRuntime } from '../../src/app/bot-node-dispatch-config';

function fakeRuntime(switches: Array<{ p: string; m?: string }> = []): DispatchConfigRuntime {
  let current = { provider: 'openai', model: 'gpt-5' };
  return {
    getActiveProvider: () => current,
    setActiveProvider: (provider: string, model?: string) => {
      switches.push({ p: provider, m: model });
      current = { provider, model: model ?? current.model };
      return current;
    },
  };
}

function fakeController() {
  const task = { id: 't-1', userSub: 'owner-123' };
  return {
    getTask: vi.fn(async () => task),
    createTask: vi.fn(async () => task),
    processMessage: vi.fn(async () => ({
      messages: [{ say: 'completion_result', text: 'ok' }],
      apiMetrics: { totalCost: 0.05, totalTokens: 120 },
      provider: 'openai',
      model: 'gpt-5',
    })),
  };
}

function baseEnvelope(payload: Record<string, unknown>): MeshEnvelope {
  return {
    correlationId: 'corr-1',
    fromAgentId: 'controller',
    toAgentId: 'worker',
    channel: 'oshal:mesh:agent.worker',
    messageType: 'request',
    payload: {
      agentId: 'worker',
      userSub: 'owner-123',
      ...payload,
    },
  };
}

describe('Retain completed work from configured failover (BACKLOG #1660)', () => {
  describe('parseCarriedDispatchConfig with fallbackOrder', () => {
    it('parses fallbackOrder from body and filters invalid entries', () => {
      const parsed = parseCarriedDispatchConfig({
        providerId: 'openai-codex',
        model: 'gpt-5',
        configVersion: 1,
        fallbackOrder: ['gemini', '  ', 123, 'cline-cli'],
      });

      expect(parsed).toEqual({
        providerId: 'openai-codex',
        model: 'gpt-5',
        configVersion: 1,
        fallbackOrder: ['gemini', 'cline-cli'],
      });
    });

    it('parses fallbackChain alias if fallbackOrder is not set', () => {
      const parsed = parseCarriedDispatchConfig({
        providerId: 'openai-codex',
        fallbackChain: ['claude-code'],
      });

      expect(parsed).toEqual({
        providerId: 'openai-codex',
        fallbackOrder: ['claude-code'],
      });
    });

    it('omits fallbackOrder when not provided or empty', () => {
      const parsed = parseCarriedDispatchConfig({
        providerId: 'openai-codex',
      });

      expect(parsed).toEqual({
        providerId: 'openai-codex',
      });
      expect(parsed?.fallbackOrder).toBeUndefined();
    });
  });

  describe('dispatchConfigMatchesActive with fallbackOrder', () => {
    it('matches when active matches primary provider', () => {
      const carried = {
        providerId: 'openai-codex',
        model: 'gpt-5',
        fallbackOrder: ['cline-cli'],
      };
      const active = { provider: 'openai-codex', model: 'gpt-5' };

      expect(dispatchConfigMatchesActive(carried, active)).toBe(true);
    });

    it('matches when active matches a fallback provider in fallbackOrder', () => {
      const carried = {
        providerId: 'openai-codex',
        fallbackOrder: ['cline-cli', 'claude-code'],
      };
      const active = { provider: 'cline-cli', model: 'any-model' };

      expect(dispatchConfigMatchesActive(carried, active)).toBe(true);
    });

    it('matches when fallback is a Cline-backed provider', () => {
      const carried = {
        providerId: 'openai-codex',
        fallbackOrder: ['gemini'],
      };
      const active = { provider: 'cline-cli', model: 'gemini-2.5-pro', apiProvider: 'gemini' };

      expect(dispatchConfigMatchesActive(carried, active)).toBe(true);
    });

    it('fails when active matches neither primary nor fallbackOrder', () => {
      const carried = {
        providerId: 'openai-codex',
        fallbackOrder: ['cline-cli'],
      };
      const active = { provider: 'claude-code', model: 'sonnet' };

      expect(dispatchConfigMatchesActive(carried, active)).toBe(false);
    });
  });

  describe('bot-node-execution-handler retention on failover', () => {
    it('retains completed work and records cost for actual fallback provider', () => {
      return new Promise<void>(async (resolve, reject) => {
        try {
          const controller = fakeController();
          controller.processMessage.mockResolvedValueOnce({
            messages: [{ say: 'completion_result', text: 'failover execution output' }],
            apiMetrics: { totalCost: 0.08, totalTokens: 250 },
            provider: 'cline-cli',
            model: 'gemini-2.5-flash',
            apiProvider: 'gemini',
          } as any);

          const recordCost = vi.fn(async () => undefined);
          const handler = createBotNodeExecutionHandler({
            anyBotTaskController: controller as any,
            dispatchConfigRuntime: fakeRuntime([]),
            providerName: 'openai',
            modelName: 'gpt-5',
            recordCost,
          });

          const result = await handler(baseEnvelope({
            text: 'do research',
            direct: true,
            agenticMode: false,
            workspaceTaskId: 'task-failover-1',
            providerId: 'openai',
            model: 'gpt-5',
            configVersion: 12,
            providerConfigRequired: true,
            fallbackOrder: ['cline-cli', 'gemini'],
          }));

          expect(result.success).toBe(true);
          expect(result.error).toBeUndefined();
          expect(result.output).toMatchObject({
            content: 'failover execution output',
            response: 'failover execution output',
            provider: 'cline-cli',
            model: 'gemini-2.5-flash',
            cost: 0.08,
            usage: {
              totalTokens: 250,
            },
          });

          expect(recordCost).toHaveBeenCalledWith(expect.objectContaining({
            providerId: 'cline-cli',
            modelId: 'gemini-2.5-flash',
            totalCost: 0.08,
            inputTokens: 250,
            ownerSub: 'owner-123',
          }));

          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });

    it('refuses when execution reports a provider not in fallbackOrder', async () => {
      const controller = fakeController();
      controller.processMessage.mockResolvedValueOnce({
        messages: [{ say: 'completion_result', text: 'rogue execution' }],
        apiMetrics: { totalCost: 0, totalTokens: 0 },
        provider: 'unauthorized-provider',
        model: 'rogue-model',
      });

      const handler = createBotNodeExecutionHandler({
        anyBotTaskController: controller as any,
        dispatchConfigRuntime: fakeRuntime([]),
        providerName: 'openai',
        modelName: 'gpt-5',
      });

      const result = await handler(baseEnvelope({
        text: 'do work',
        direct: true,
        agenticMode: false,
        workspaceTaskId: 'task-failover-2',
        providerId: 'openai',
        model: 'gpt-5',
        configVersion: 13,
        providerConfigRequired: true,
        fallbackOrder: ['cline-cli'],
      }));

      expect(result.success).toBe(false);
      expect(result.error).toContain('different from the authoritative dispatch record');
    });
  });
});
