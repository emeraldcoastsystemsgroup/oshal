/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | CKR-5 parity guard for the two persona-layer gather sequences. createBotNodeExecutionHandler and createLLMExecutionHandler build the same seven-step layer set with nothing keeping them in step, so a layer added to one would land on one runtime only. Both are driven with one identical non-direct envelope and the layer arrays are compared on (layerType, priority, metadata.contentSource) — the shape both runtimes must agree on, not the content, which is legitimately transport-specific. Deliberately no change under src/: the drift risk is real, the extraction the repair spec proposed is a core change with no defect behind it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MeshEnvelope } from '@/features/agent-management';

/**
 * Both handlers hand their assembled layer array to resolvePromptAuthorityBinding. The bot-node
 * handler imports it through the swarm-orchestration barrel and the LLM handler imports it from
 * the owning module directly, so mocking the owning module intercepts both.
 */
const capturedLayers: Record<string, unknown[]> = {};
let captureKey = '';

vi.mock('@/features/swarm-orchestration/services/prompt-containment', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolvePromptAuthorityBinding: async (opts: { layers?: unknown[] }) => {
      capturedLayers[captureKey] = [...(opts.layers ?? [])];
      return { userSub: null, ticketId: 't', workloadId: 'w', allowedTools: [], scopes: [] };
    },
  };
});

const AGENT_ID = 'parity-guard-agent';
const PERSONA_DIR = 'ai-lab/bot-personas';

/** One envelope, used for both runtimes. `direct` is absent on purpose: the bot-node
 *  handler short-circuits the whole layer gather when it is true, which would compare nothing. */
function buildEnvelope(): MeshEnvelope {
  return {
    correlationId: 'parity-guard-correlation',
    fromAgentId: 'parity-guard-sender',
    toAgentId: AGENT_ID,
    type: 'execution-request',
    payload: {
      type: 'execution-request',
      role: 'executor',
      phase: 4,
      round: 1,
      externalId: 'parity-guard-ticket',
      workspaceTaskId: 'parity-guard-workspace',
      text: 'Do the work described in the ticket.',
    },
  } as unknown as MeshEnvelope;
}

/** The three fields both runtimes must agree on. Content is excluded deliberately:
 *  the two differ in workspace id derivation, which is transport-appropriate. */
function shapeOf(layers: unknown[]): Array<Record<string, unknown>> {
  return layers.map((layer) => {
    const l = layer as { layerType?: unknown; priority?: unknown; metadata?: Record<string, unknown> };
    return {
      layerType: l.layerType,
      priority: l.priority,
      contentSource: l.metadata?.contentSource,
    };
  });
}

/**
 * @description Run one handler far enough to capture its layer array, absorbing the provider
 * failure that follows. Execution is irrelevant here; only the assembled layers are under test.
 * @param key - Which runtime is being captured.
 * @param run - Invokes the handler under test.
 * @returns The captured layer shapes for that runtime.
 */
async function captureFrom(key: string, run: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
  captureKey = key;
  delete capturedLayers[key];
  try {
    await run();
  } catch {
    // Both handlers fail once they reach a provider; the layers were captured before that.
  }
  expect(capturedLayers[key], `${key} never reached prompt-authority binding`).toBeDefined();
  return shapeOf(capturedLayers[key]);
}

describe('CKR-5 — the two persona-layer gather sequences stay in step', () => {
  beforeEach(() => {
    for (const k of Object.keys(capturedLayers)) delete capturedLayers[k];
  });

  it('createLLMExecutionHandler and createBotNodeExecutionHandler assemble the same layer shape', async () => {
    const { createLLMExecutionHandler } = await import(
      '@/features/swarm-orchestration/services/llm-execution-handler'
    );
    const { createBotNodeExecutionHandler } = await import('@/app/bot-node-execution-handler');

    const agentProfileRepository = {
      getAgentProfile: async () => null,
    } as unknown as Parameters<typeof createLLMExecutionHandler>[0]['agentProfileRepository'];

    const llmHandler = createLLMExecutionHandler({
      resolveProvider: () => { throw new Error('parity guard: no provider'); },
      agentProfileRepository,
      personaDir: PERSONA_DIR,
    });

    const botNodeHandler = createBotNodeExecutionHandler({
      anyBotTaskController: {
        getTask: async () => null,
        createTask: async () => { throw new Error('parity guard: no task controller'); },
        processMessage: async () => { throw new Error('parity guard: no task controller'); },
      },
      agentProfileRepository,
      personaDir: PERSONA_DIR,
      providerName: 'noop',
      modelName: 'noop',
    } as unknown as Parameters<typeof createBotNodeExecutionHandler>[0]);

    const llmShape = await captureFrom('llm', () => llmHandler(buildEnvelope()));
    const botNodeShape = await captureFrom('bot-node', () => botNodeHandler(buildEnvelope()));

    // Non-vacuity first: two empty arrays would satisfy the equality below while proving nothing,
    // so a sequence that stopped producing layers must fail here rather than pass silently.
    expect(llmShape.length, 'llm runtime assembled no persona layers').toBeGreaterThan(0);
    expect(botNodeShape.length, 'bot-node runtime assembled no persona layers').toBeGreaterThan(0);

    // The guard that matters: a layer added to one sequence and not the other changes this.
    expect(botNodeShape).toEqual(llmShape);
  });
});
