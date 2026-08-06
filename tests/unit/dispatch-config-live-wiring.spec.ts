/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for ADR-034 gap-b LIVE WIRING (the step the substrate spec left open). Proves the load-bearing invariants across both halves: OSHAL_PUSH_ON_DISPATCH=on stamps providerId/model/configVersion onto the controller's BotNodeClient.execute request; OFF (or unset) short-circuits so the request is byte-identical to the legacy shape and the resolver is never even consulted; a throwing resolver fails open (dispatch proceeds, no fields); the shared pushOnDispatchFields gate honours the flag; and on the bot half a carried divergent config self-corrects the runtime via setActiveProvider BEFORE processMessage runs, while an absent seam / absent carried config leaves the runtime untouched.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Exercise dispatch reconciliation with hosted-provider fixtures so the test preserves the production preflight denial for unbrokered autonomous CLIs.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Prove the promoted default-on/fail-closed rail: missing authority and runtime seams refuse before task creation, explicit off is the only legacy rollback, concurrent mismatches refuse, and successful results record config provenance.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InternalTicket } from '../../src/entities/ticket/internal-ticket';
import type { BotNodeClient } from '../../src/features/agent-management/services/bot-node-client';
import type { MeshEnvelope } from '../../src/features/agent-management/services/mesh-communication-service';
import type { RuntimeParamsResolver } from '../../src/features/agent-management/services/dispatch-runtime-params';
import type { TicketService } from '../../src/features/ticketing';
import type { WorkflowDefinition } from '../../src/features/swarm-orchestration/services/dispatch-routing';
import {
  dispatchManifestWorkerTicket,
  pushOnDispatchFields,
} from '../../src/features/swarm-orchestration/services/dispatch-manifest-worker';
import { createBotNodeExecutionHandler } from '../../src/app/bot-node-execution-handler';
import type { DispatchConfigRuntime } from '../../src/app/bot-node-dispatch-config';

const FLAG = 'OSHAL_PUSH_ON_DISPATCH';
const originalFlag = process.env[FLAG];

function restoreFlag(): void {
  if (originalFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = originalFlag;
}

function buildTicket(overrides: Partial<InternalTicket> = {}): InternalTicket {
  return {
    ticketId: '11111111-1111-4111-8111-111111111111',
    ticketType: 'task',
    title: 'Summarize the inbox',
    description: 'Find the important stuff.',
    status: 'approved',
    stateGroup: 'active',
    executionPhase: null,
    priority: 'medium',
    labels: [],
    workspaceId: null,
    assignedAgentId: null,
    parentTicketId: null,
    externalProvider: null,
    externalId: null,
    externalUrl: null,
    metadata: {},
    ownerSub: 'owner-123',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function buildWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    ticketType: 'task',
    name: 'Assistant Task',
    pipeline: 'manifest-worker',
    workerBot: 'rides-concierge',
    ...overrides,
  };
}

function buildTicketService() {
  return { updateStatus: vi.fn(async () => undefined) } as unknown as
    TicketService & { updateStatus: ReturnType<typeof vi.fn> };
}

/**
 * A bot-node execute() double. Response is deliberately empty so the manifest worker's
 * durable-persist path short-circuits (no task/message store needed) and the test can focus
 * purely on the dispatched request shape.
 */
function buildExecute() {
  return vi.fn(async () => ({
    success: true,
    response: '',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    cost: 0,
    model: 'test',
    provider: 'test',
    durationMs: 1,
  }));
}

describe('ADR-034 gap-b controller stamping (dispatch-manifest-worker)', () => {
  afterEach(() => {
    restoreFlag();
    vi.restoreAllMocks();
  });

  it('stamps providerId/model/configVersion on the execute request when the flag is ON', async () => {
    process.env[FLAG] = 'on';
    const execute = buildExecute();
    const botNodeClient = { hasEndpoint: () => true, execute } as unknown as BotNodeClient;
    const resolver: RuntimeParamsResolver = vi.fn(async () => ({
      providerId: 'openai-codex', model: 'gpt-5', configVersion: 7,
    }));

    await dispatchManifestWorkerTicket(buildTicket(), buildWorkflow(), {
      activeTicketIds: new Set(),
      dispatchStartTimes: new Map(),
      resolveAgentIdByName: async () => 'rides-agent',
      botNodeClient,
      ticketService: buildTicketService(),
      runtimeParamsResolver: resolver,
    });

    expect(resolver).toHaveBeenCalledWith('rides-agent');
    expect(execute).toHaveBeenCalledWith('rides-agent', expect.objectContaining({
      providerId: 'openai-codex', model: 'gpt-5', configVersion: 7,
      providerConfigRequired: true,
    }));
  });

  it('leaves the request byte-identical when the compatibility flag is explicitly OFF', async () => {
    process.env[FLAG] = 'off';
    const execute = buildExecute();
    const botNodeClient = { hasEndpoint: () => true, execute } as unknown as BotNodeClient;
    const resolver: RuntimeParamsResolver = vi.fn(async () => ({ providerId: 'openai-codex' }));

    await dispatchManifestWorkerTicket(buildTicket(), buildWorkflow(), {
      activeTicketIds: new Set(),
      dispatchStartTimes: new Map(),
      resolveAgentIdByName: async () => 'rides-agent',
      botNodeClient,
      ticketService: buildTicketService(),
      runtimeParamsResolver: resolver,
    });

    expect(resolver).not.toHaveBeenCalled();
    const request = execute.mock.calls[0][1] as Record<string, unknown>;
    expect(request.providerId).toBeUndefined();
    expect(request.model).toBeUndefined();
    expect(request.configVersion).toBeUndefined();
    expect(request.providerConfigRequired).toBeUndefined();
  });

  it('carries a required-authority marker when the resolver throws', async () => {
    process.env[FLAG] = 'on';
    const execute = buildExecute();
    const botNodeClient = { hasEndpoint: () => true, execute } as unknown as BotNodeClient;
    const resolver: RuntimeParamsResolver = vi.fn(async () => { throw new Error('config store down'); });
    const ticketService = buildTicketService();

    await dispatchManifestWorkerTicket(buildTicket(), buildWorkflow(), {
      activeTicketIds: new Set(),
      dispatchStartTimes: new Map(),
      resolveAgentIdByName: async () => 'rides-agent',
      botNodeClient,
      ticketService,
      runtimeParamsResolver: resolver,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    const request = execute.mock.calls[0][1] as Record<string, unknown>;
    expect(request.providerId).toBeUndefined();
    expect(request.providerConfigRequired).toBe(true);
    // This execute double accepts every request. A real bot will refuse the explicit missing
    // authority marker before task creation; the controller must not silently label it legacy.
    expect(ticketService.updateStatus).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111', 'complete', expect.anything(),
    );
  });
});

describe('ADR-034 gap-b flag gate (pushOnDispatchFields)', () => {
  afterEach(restoreFlag);

  it('short-circuits to {} without consulting the resolver when explicitly OFF', async () => {
    process.env[FLAG] = 'disabled';
    const resolver = vi.fn(async () => ({ providerId: 'openai-codex' }));
    expect(await pushOnDispatchFields(resolver, 'a1')).toEqual({});
    expect(resolver).not.toHaveBeenCalled();
  });

  it('defaults ON and resolves spreadable fields with the authority marker', async () => {
    delete process.env[FLAG];
    const fields = await pushOnDispatchFields(
      async () => ({ providerId: 'openai-codex', model: 'gpt-5', configVersion: 4 }), 'a1',
    );
    expect(fields).toEqual({
      providerConfigRequired: true,
      providerId: 'openai-codex',
      model: 'gpt-5',
      configVersion: 4,
    });
  });

  it('ON but no resolver / null record carries an unavailable-authority marker', async () => {
    process.env[FLAG] = 'on';
    expect(await pushOnDispatchFields(undefined, 'a1')).toEqual({ providerConfigRequired: true });
    expect(await pushOnDispatchFields(async () => null, 'a1')).toEqual({ providerConfigRequired: true });
  });
});

describe('ADR-034 gap-b bot reconciliation (bot-node-execution-handler)', () => {
  function baseEnvelope(payload: Record<string, unknown>): MeshEnvelope {
    return {
      correlationId: 'c1',
      fromAgentId: 'swarm-controller',
      toAgentId: 'a1',
      channel: 'oshal:mesh:agent.a1',
      payload,
      messageType: 'request',
    };
  }

  function fakeController(onProcess?: () => void) {
    return {
      getTask: vi.fn(async () => null),
      createTask: vi.fn(async () => ({ id: 't-1' })),
      processMessage: vi.fn(async () => {
        onProcess?.();
        return {
          messages: [{ say: 'completion_result', text: 'ok' }],
          apiMetrics: { totalCost: 0, totalTokens: 0 },
          provider: 'openai',
          model: 'gpt-5',
        };
      }),
    };
  }

  function fakeRuntime(switches: Array<{ p: string; m?: string }>): DispatchConfigRuntime {
    let current = { provider: 'anthropic', model: 'sonnet' as string | null };
    return {
      getActiveProvider: () => ({ provider: current.provider, model: current.model }),
      setActiveProvider: (provider: string, model?: string) => {
        switches.push({ p: provider, m: model });
        current = { provider, model: model ?? current.model };
        return { provider: current.provider, model: current.model };
      },
    };
  }

  it('self-corrects a divergent carried config via setActiveProvider BEFORE executing', async () => {
    const switches: Array<{ p: string; m?: string }> = [];
    let switchesAtProcessTime = -1;
    const controller = fakeController(() => { switchesAtProcessTime = switches.length; });
    const handler = createBotNodeExecutionHandler({
      anyBotTaskController: controller,
      dispatchConfigRuntime: fakeRuntime(switches),
      providerName: 'anthropic',
      modelName: 'sonnet',
    });

    const result = await handler(baseEnvelope({
      text: 'hi', direct: true, agenticMode: false, workspaceTaskId: 't-1',
      providerId: 'openai', model: 'gpt-5', configVersion: 9,
    }));

    expect(switches).toEqual([{ p: 'openai', m: 'gpt-5' }]);
    // The correction must precede the LLM turn — the switch was already recorded when
    // processMessage ran.
    expect(switchesAtProcessTime).toBe(1);
    expect(controller.processMessage).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: true,
      output: {
        provider: 'openai',
        model: 'gpt-5',
        providerConfigSource: 'authoritative-dispatch',
        providerConfigAction: 'corrected',
        providerConfigVersion: 9,
      },
    });
  });

  it('leaves the runtime untouched when the dispatch carried no providerId (legacy path)', async () => {
    const switches: Array<{ p: string; m?: string }> = [];
    const controller = fakeController();
    const handler = createBotNodeExecutionHandler({
      anyBotTaskController: controller,
      dispatchConfigRuntime: fakeRuntime(switches),
      providerName: 'anthropic',
      modelName: 'sonnet',
    });

    const result = await handler(baseEnvelope({
      text: 'hi', direct: true, agenticMode: false, workspaceTaskId: 't-1',
    }));

    expect(switches).toHaveLength(0);
    expect(controller.processMessage).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: true,
      output: {
        providerConfigSource: 'runtime-default',
        providerConfigAction: 'absent',
        providerConfigVersion: null,
      },
    });
  });

  it('refuses a carried config when no dispatchConfigRuntime seam is injected', async () => {
    const controller = fakeController();
    const handler = createBotNodeExecutionHandler({
      anyBotTaskController: controller,
      providerName: 'anthropic',
      modelName: 'sonnet',
    });

    const result = await handler(baseEnvelope({
      text: 'hi', direct: true, agenticMode: false, workspaceTaskId: 't-1',
      providerId: 'openai', model: 'gpt-5', configVersion: 9,
    }));

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('runtime seam is unavailable'),
    });
    expect(controller.getTask).not.toHaveBeenCalled();
    expect(controller.createTask).not.toHaveBeenCalled();
    expect(controller.processMessage).not.toHaveBeenCalled();
  });

  it('refuses a pin-required dispatch when the authoritative record is unavailable', async () => {
    const controller = fakeController();
    const handler = createBotNodeExecutionHandler({
      anyBotTaskController: controller,
      dispatchConfigRuntime: fakeRuntime([]),
      providerName: 'anthropic',
      modelName: 'sonnet',
    });

    const result = await handler(baseEnvelope({
      text: 'hi', direct: true, agenticMode: false, workspaceTaskId: 't-1',
      providerConfigRequired: true,
    }));

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('no actionable record was available'),
    });
    expect(controller.getTask).not.toHaveBeenCalled();
    expect(controller.createTask).not.toHaveBeenCalled();
    expect(controller.processMessage).not.toHaveBeenCalled();
  });

  it('refuses an unavailable authoritative provider before task creation', async () => {
    const controller = fakeController();
    const runtime = fakeRuntime([]);
    runtime.setActiveProvider = () => { throw new Error('provider unavailable'); };
    const handler = createBotNodeExecutionHandler({
      anyBotTaskController: controller,
      dispatchConfigRuntime: runtime,
      providerName: 'anthropic',
      modelName: 'sonnet',
    });

    const result = await handler(baseEnvelope({
      text: 'hi', direct: true, agenticMode: false, workspaceTaskId: 't-1',
      providerId: 'openai', model: 'gpt-5', configVersion: 10,
      providerConfigRequired: true,
    }));

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('Authoritative provider config is unavailable'),
    });
    expect(controller.getTask).not.toHaveBeenCalled();
    expect(controller.createTask).not.toHaveBeenCalled();
    expect(controller.processMessage).not.toHaveBeenCalled();
  });

  it('refuses a result that reports execution on a different provider/model', async () => {
    const controller = fakeController();
    controller.processMessage.mockResolvedValueOnce({
      messages: [{ say: 'completion_result', text: 'wrong runtime' }],
      apiMetrics: { totalCost: 0, totalTokens: 0 },
      provider: 'anthropic',
      model: 'sonnet',
    });
    const handler = createBotNodeExecutionHandler({
      anyBotTaskController: controller,
      dispatchConfigRuntime: fakeRuntime([]),
      providerName: 'anthropic',
      modelName: 'sonnet',
    });

    const result = await handler(baseEnvelope({
      text: 'hi', direct: true, agenticMode: false, workspaceTaskId: 't-1',
      providerId: 'openai', model: 'gpt-5', configVersion: 11,
      providerConfigRequired: true,
    }));

    expect(controller.processMessage).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('different from the authoritative dispatch record'),
    });
  });

  it('refuses a concurrent mismatch instead of switching a running task', async () => {
    let releaseFirst = (): void => undefined;
    let markFirstEntered = (): void => undefined;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
    const controller = fakeController();
    controller.processMessage.mockImplementationOnce(async () => {
      markFirstEntered();
      await firstHeld;
      return {
        messages: [{ say: 'completion_result', text: 'first complete' }],
        apiMetrics: { totalCost: 0, totalTokens: 0 },
        provider: 'anthropic',
        model: 'sonnet',
      };
    });
    const switches: Array<{ p: string; m?: string }> = [];
    const handler = createBotNodeExecutionHandler({
      anyBotTaskController: controller,
      dispatchConfigRuntime: fakeRuntime(switches),
      providerName: 'anthropic',
      modelName: 'sonnet',
    });

    const first = handler(baseEnvelope({
      text: 'first', direct: true, agenticMode: false, workspaceTaskId: 't-1',
      providerId: 'anthropic', model: 'sonnet', providerConfigRequired: true,
    }));
    await firstEntered;
    const second = await handler(baseEnvelope({
      text: 'second', direct: true, agenticMode: false, workspaceTaskId: 't-2',
      providerId: 'openai', model: 'gpt-5', providerConfigRequired: true,
    }));

    expect(second).toMatchObject({
      success: false,
      error: expect.stringContaining('while another execution is in flight'),
    });
    expect(switches).toHaveLength(0);
    expect(controller.processMessage).toHaveBeenCalledTimes(1);

    releaseFirst();
    await expect(first).resolves.toMatchObject({ success: true });
  });
});
