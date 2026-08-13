/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-127 inline hosted brain guards: (1) ByoHostedProvider wire mapping against a REAL node:http chat-completions endpoint (request shape incl. tool_calls/role:'tool' history, response shape incl. tool_use + usage, non-2xx typed errors that never leak the key); (2) the REAL TaskOrchestrator runs a turn on the BYO provider when options.byoLlmConnection is present and on deps.getProvider otherwise; (3) the ONE shared resolve-condition helper both chat entry points ride (CLI harness ⇒ resolve, hosted harness ⇒ no override, empty ladder ⇒ NO_HOSTED_BRAIN naming Settings → AI Providers).
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ByoHostedProvider } from '../../src/features/llm-provider/services/byo-hosted-provider';
import { isUnbrokeredAutonomousProvider } from '../../src/features/llm-provider/services/unattended-provider-policy';
import {
  LLMService,
  type LLMResponse,
  type SendRequestOptions,
} from '../../src/features/llm-provider/services/llm-service';
import {
  TaskOrchestrator,
  type TaskOrchestratorDeps,
} from '../../src/features/chat-orchestration/services/task-orchestrator';
import {
  NoHostedBrainError,
  agentRequiresHostedBrain,
  resolveHostedBrainForCliAgent,
} from '../../src/app/routes/inline-bot-execution';
import type { AppContext } from '../../src/app/composition/app-context';
import type { LLMMessage } from '../../src/shared/types';

const SECRET_KEY = 'sk-test-secret-key-9x7';

/** One captured chat-completions request from the stub endpoint. */
interface RecordedRequest {
  url: string;
  authorization?: string;
  body: Record<string, any>;
}

/** A REAL local OpenAI-compatible endpoint (node:http) — the protocol boundary under guard. */
function createStubEndpoint() {
  const requests: RecordedRequest[] = [];
  let nextResponse: { status: number; payload: unknown } = { status: 200, payload: textCompletion('ok') };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      requests.push({
        url: req.url ?? '',
        authorization: req.headers.authorization,
        body: raw ? JSON.parse(raw) : {},
      });
      res.writeHead(nextResponse.status, { 'content-type': 'application/json' });
      res.end(typeof nextResponse.payload === 'string' ? nextResponse.payload : JSON.stringify(nextResponse.payload));
    });
  });
  return {
    requests,
    reset(): void {
      requests.length = 0;
      nextResponse = { status: 200, payload: textCompletion('ok') };
    },
    setResponse(status: number, payload: unknown): void {
      nextResponse = { status, payload };
    },
    async listen(): Promise<string> {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      return `http://127.0.0.1:${port}/v1`;
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

/** Minimal OpenAI chat-completions text payload. */
function textCompletion(text: string): Record<string, unknown> {
  return {
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    model: 'stub-model',
  };
}

const endpoint = createStubEndpoint();
let baseUrl = '';

beforeAll(async () => {
  // GovernedProvider must stay a governance no-op here (repo default posture).
  delete process.env.OSHAL_LLM_BUDGETS;
  baseUrl = await endpoint.listen();
});

afterAll(async () => {
  await endpoint.close();
});

beforeEach(() => {
  endpoint.reset();
});

describe('ByoHostedProvider — OpenAI wire mapping over a real http boundary', () => {
  it('maps system prompt, history (tool_use → tool_calls, tool_result → role:tool), and tools onto the wire; maps the text answer back', async () => {
    endpoint.setResponse(200, textCompletion('It is 72F.'));
    const provider = new ByoHostedProvider({ baseUrl, apiKey: SECRET_KEY, model: 'user-model' });
    const messages: LLMMessage[] = [
      { role: 'user', content: 'find the weather' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Tampa' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_1', content: '72F sunny', isError: false }] },
    ];

    const response = await provider.sendRequest({
      messages,
      systemPrompt: 'SYSTEM RULES',
      tools: [{
        name: 'get_weather',
        description: 'Look up weather',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      }],
      maxTokens: 512,
      temperature: 0.2,
    });

    expect(endpoint.requests).toHaveLength(1);
    const sent = endpoint.requests[0];
    expect(sent.url).toBe('/v1/chat/completions');
    expect(sent.authorization).toBe(`Bearer ${SECRET_KEY}`);
    expect(sent.body.model).toBe('user-model');
    expect(sent.body.max_tokens).toBe(512);
    expect(sent.body.temperature).toBe(0.2);
    expect(sent.body.tool_choice).toBe('auto');
    expect(sent.body.tools).toEqual([{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Look up weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    }]);
    expect(sent.body.messages[0]).toEqual({ role: 'system', content: 'SYSTEM RULES' });
    expect(sent.body.messages[1]).toEqual({ role: 'user', content: 'find the weather' });
    expect(sent.body.messages[2].role).toBe('assistant');
    expect(sent.body.messages[2].content).toBe('checking');
    expect(sent.body.messages[2].tool_calls).toHaveLength(1);
    expect(sent.body.messages[2].tool_calls[0]).toMatchObject({ id: 'call_1', type: 'function' });
    expect(sent.body.messages[2].tool_calls[0].function.name).toBe('get_weather');
    expect(JSON.parse(sent.body.messages[2].tool_calls[0].function.arguments)).toEqual({ city: 'Tampa' });
    expect(sent.body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '72F sunny' });

    expect(response.content).toEqual([{ type: 'text', text: 'It is 72F.' }]);
    expect(response.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(response.model).toBe('stub-model');
    expect(response.stopReason).toBe('stop');
  });

  it('maps a tool_calls answer to tool_use blocks with parsed input, computing totals when the endpoint omits them', async () => {
    endpoint.setResponse(200, {
      choices: [{
        message: {
          content: null,
          tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
      model: 'stub-model',
    });
    const provider = new ByoHostedProvider({ baseUrl, apiKey: SECRET_KEY, model: 'user-model' });

    const response = await provider.sendRequest({ messages: [{ role: 'user', content: 'go' }] });

    expect(response.content).toEqual([{ type: 'tool_use', id: 'call_9', name: 'lookup', input: { q: 'x' } }]);
    expect(response.stopReason).toBe('tool_calls');
    expect(response.usage).toMatchObject({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
  });

  it('turns a non-2xx answer into a typed error with the status and a bounded body excerpt — never the api key', async () => {
    endpoint.setResponse(429, 'rate limited hard');
    const provider = new ByoHostedProvider({ baseUrl, apiKey: SECRET_KEY, model: 'user-model' });

    let caught: (Error & { code?: string; statusCode?: number }) | null = null;
    try {
      await provider.sendRequest({ messages: [{ role: 'user', content: 'hi' }] });
    } catch (err) {
      caught = err as Error & { code?: string; statusCode?: number };
    }

    expect(caught).not.toBeNull();
    expect(caught?.code).toBe('BYO_HOSTED_HTTP_ERROR');
    expect(caught?.statusCode).toBe(429);
    expect(caught?.message).toContain('429');
    expect(caught?.message).toContain('rate limited hard');
    expect(caught?.message).not.toContain(SECRET_KEY);
  });

  it('never places the api key on the inherited provider name or config bag', () => {
    const provider = new ByoHostedProvider({ baseUrl, apiKey: SECRET_KEY, model: 'user-model' });
    expect(provider.getProviderName()).toBe('byo-hosted:user-model');
    expect(JSON.stringify((provider as unknown as { config: unknown }).config)).not.toContain(SECRET_KEY);
  });
});

/** Registry-provider double — a fixed reply so "which provider ran?" is observable. */
class RegistryStubProvider extends LLMService {
  constructor() {
    super('registry-stub', {});
  }

  async sendRequest(_options: SendRequestOptions): Promise<LLMResponse> {
    return {
      content: [{ type: 'text', text: 'registry-provider-reply' }],
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'registry-model',
    };
  }
}

/** A REAL TaskOrchestrator over in-memory store/stream doubles (collaborators OUTSIDE the guarded boundary). */
function buildOrchestrator() {
  const saved: Array<Record<string, any>> = [];
  const tasks = new Map<string, Record<string, any>>();
  const taskStore = {
    create: async (input: Record<string, any>) => {
      tasks.set(String(input.taskId), { ...input });
      return { ...input };
    },
    get: async (taskId: string) => tasks.get(taskId) ?? null,
    updateStatus: async () => {},
    incrementMessageCount: async () => {},
    incrementTurnCount: async () => {},
    recordUsage: async () => {},
  };
  const messageStore = {
    save: async (input: Record<string, any>) => {
      saved.push(input);
      return { ...input, messageId: `m-${saved.length}`, createdAt: new Date().toISOString() };
    },
    getRecent: async () => [...saved],
  };
  const streamManager = {
    associateTaskWithSession: () => {},
    broadcastTaskUpdate: () => {},
    broadcastMessage: () => {},
    broadcastError: () => {},
  };
  const getProvider = vi.fn(() => new RegistryStubProvider());
  const deps = {
    taskStore,
    messageStore,
    streamManager,
    getProvider,
    getTools: async () => [],
    executeTool: async () => 'ok',
    getSystemPrompt: async () => 'SYSTEM',
  } as unknown as TaskOrchestratorDeps;
  return { orchestrator: new TaskOrchestrator(deps), getProvider };
}

describe('TaskOrchestrator — byoLlmConnection selects the hosted BYO provider', () => {
  it('agentic turn with byoLlmConnection runs on the hosted endpoint, not deps.getProvider', async () => {
    endpoint.setResponse(200, textCompletion('hosted-brain-reply'));
    const { orchestrator, getProvider } = buildOrchestrator();

    const result = await orchestrator.processMessage('task-byo-agentic', 'hi there', {
      agenticMode: true,
      autoApprove: false,
      source: 'test',
      agentId: 'agent-1',
      byoLlmConnection: { baseUrl, apiKey: SECRET_KEY, model: 'user-model' },
    });

    expect(result.success).toBe(true);
    expect(result.response).toBe('hosted-brain-reply');
    expect(getProvider).not.toHaveBeenCalled();
    expect(endpoint.requests).toHaveLength(1);
    expect(endpoint.requests[0].body.model).toBe('user-model');
    expect(endpoint.requests[0].authorization).toBe(`Bearer ${SECRET_KEY}`);
  });

  it('direct turn with byoLlmConnection also runs on the hosted endpoint', async () => {
    endpoint.setResponse(200, textCompletion('hosted-direct-reply'));
    const { orchestrator, getProvider } = buildOrchestrator();

    const result = await orchestrator.processMessage('task-byo-direct', 'hi', {
      agenticMode: false,
      autoApprove: false,
      source: 'test',
      agentId: 'agent-1',
      byoLlmConnection: { baseUrl, apiKey: SECRET_KEY, model: 'user-model' },
    });

    expect(result.success).toBe(true);
    expect(result.response).toBe('hosted-direct-reply');
    expect(getProvider).not.toHaveBeenCalled();
    expect(endpoint.requests).toHaveLength(1);
  });

  it('without byoLlmConnection the registry provider from deps.getProvider runs and the endpoint is never hit', async () => {
    const { orchestrator, getProvider } = buildOrchestrator();

    const result = await orchestrator.processMessage('task-registry', 'hi', {
      agenticMode: true,
      autoApprove: false,
      source: 'test',
      agentId: 'agent-1',
    });

    expect(result.success).toBe(true);
    expect(result.response).toBe('registry-provider-reply');
    expect(getProvider).toHaveBeenCalledWith('agent-1');
    expect(endpoint.requests).toHaveLength(0);
  });
});

describe('shared resolve-condition helper — one condition for both chat entry points', () => {
  const REGISTRY = [
    { agentId: 'cli-bot', harnessType: 'claude-code' },
    { agentId: 'hosted-bot', harnessType: 'a2a' },
    { agentId: 'bare-bot' },
  ];
  const loadRegistry = () => REGISTRY;
  const pool = null as unknown as AppContext['pool'];

  it('CLI-harness agent resolves the ladder connection, stripped to exactly the wire fields', async () => {
    const resolveConnection = vi.fn(async () => ({
      baseUrl: 'https://llm.example.test/v1',
      apiKey: 'ladder-key',
      model: 'ladder-model',
      resolutionSource: 'explicit',
    })) as unknown as (pool: AppContext['pool'], userSub: string) => Promise<any>;

    const connection = await resolveHostedBrainForCliAgent(pool, 'cli-bot', 'user-1', { loadRegistry, resolveConnection });

    expect(connection).toEqual({ baseUrl: 'https://llm.example.test/v1', apiKey: 'ladder-key', model: 'ladder-model' });
    expect(resolveConnection).toHaveBeenCalledWith(pool, 'user-1');
  });

  it('hosted-harness and harness-less agents get NO override and the ladder is never walked', async () => {
    const resolveConnection = vi.fn(async () => ({ baseUrl: 'x', apiKey: 'y', model: 'z' }));

    await expect(resolveHostedBrainForCliAgent(pool, 'hosted-bot', 'user-1', { loadRegistry, resolveConnection }))
      .resolves.toBeUndefined();
    await expect(resolveHostedBrainForCliAgent(pool, 'bare-bot', 'user-1', { loadRegistry, resolveConnection }))
      .resolves.toBeUndefined();
    expect(resolveConnection).not.toHaveBeenCalled();
  });

  it('CLI-harness agent with an empty ladder throws NO_HOSTED_BRAIN carrying the Settings pointer', async () => {
    const resolveConnection = vi.fn(async () => undefined);

    const attempt = resolveHostedBrainForCliAgent(pool, 'cli-bot', 'user-1', { loadRegistry, resolveConnection });

    await expect(attempt).rejects.toBeInstanceOf(NoHostedBrainError);
    await expect(attempt).rejects.toMatchObject({ code: 'NO_HOSTED_BRAIN' });
    await expect(attempt).rejects.toThrow(/Settings → AI Providers/);
  });

  it('an unknown agent or an empty registry answers "no override" instead of breaking the turn', () => {
    // Loader failures resolve to [] inside defaultLoadSwarmRegistry; the predicate itself is
    // pure over the entries, so an empty registry is the unavailable-registry contract.
    // BOT_NAME is cleared explicitly: with a name set, an unknown agent legitimately inherits
    // that entry (the case below) — this row is the no-fallback-available contract.
    const priorBotName = process.env.BOT_NAME;
    const priorAgentId = process.env.AGENT_ID;
    delete process.env.BOT_NAME;
    delete process.env.AGENT_ID;
    try {
      expect(agentRequiresHostedBrain('cli-bot', [])).toBe(false);
      expect(agentRequiresHostedBrain('not-in-registry', REGISTRY)).toBe(false);
    } finally {
      if (priorBotName === undefined) delete process.env.BOT_NAME; else process.env.BOT_NAME = priorBotName;
      if (priorAgentId === undefined) delete process.env.AGENT_ID; else process.env.AGENT_ID = priorAgentId;
    }
  });

  describe('the BOT_NAME fallback — the guard must see the harness the EXECUTOR will use', () => {
    // Live 2026-08-13: provider-runtime's resolveHarnessForAgent falls back to the entry named
    // by process BOT_NAME when the agentId is absent from the registry. The controller runs
    // BOT_NAME=project-manager (harness codex-cli), so 84 of 116 active agent rows EXECUTED on
    // a CLI harness while this predicate said "not a CLI bot" — the ladder never ran and the raw
    // SEC-05 refusal reached the user (reproduced on email-bot a695dd5f-…). These rows fail if
    // resolveGoverningEntry loses the fallback.
    const NAMED_REGISTRY = [
      { agentId: 'cli-bot', name: 'cli-bot', harnessType: 'claude-code' },
      { agentId: 'hosted-bot', name: 'hosted-bot', harnessType: 'a2a' },
      { agentId: 'pm-uuid', name: 'project-manager', harnessType: 'codex-cli' },
    ];
    const priorBotName = process.env.BOT_NAME;
    const priorAgentId = process.env.AGENT_ID;

    afterEach(() => {
      if (priorBotName === undefined) delete process.env.BOT_NAME; else process.env.BOT_NAME = priorBotName;
      if (priorAgentId === undefined) delete process.env.AGENT_ID; else process.env.AGENT_ID = priorAgentId;
    });

    it('a registry-orphaned agent inherits the BOT_NAME entry, so a CLI harness NEEDS a brain', () => {
      process.env.BOT_NAME = 'project-manager';
      delete process.env.AGENT_ID;
      expect(agentRequiresHostedBrain('a695dd5f-orphan-row', NAMED_REGISTRY)).toBe(true);
    });

    it('the fallback resolves the harness — a hosted BOT_NAME entry still yields no override', () => {
      process.env.BOT_NAME = 'hosted-bot';
      delete process.env.AGENT_ID;
      expect(agentRequiresHostedBrain('a695dd5f-orphan-row', NAMED_REGISTRY)).toBe(false);
    });

    it('an explicit agentId match always wins over the BOT_NAME entry', () => {
      // hosted-bot is in the registry on its own terms; the codex-cli BOT_NAME must not
      // promote it into needing a brain.
      process.env.BOT_NAME = 'project-manager';
      delete process.env.AGENT_ID;
      expect(agentRequiresHostedBrain('hosted-bot', NAMED_REGISTRY)).toBe(false);
      expect(agentRequiresHostedBrain('cli-bot', NAMED_REGISTRY)).toBe(true);
    });

    it('AGENT_ID stands in for an unset BOT_NAME, exactly as the executor reads it', () => {
      delete process.env.BOT_NAME;
      process.env.AGENT_ID = 'project-manager';
      expect(agentRequiresHostedBrain('a695dd5f-orphan-row', NAMED_REGISTRY)).toBe(true);
    });

    it('a BOT_NAME naming nothing in the registry leaves the turn unchanged', () => {
      process.env.BOT_NAME = 'no-such-bot';
      delete process.env.AGENT_ID;
      expect(agentRequiresHostedBrain('a695dd5f-orphan-row', NAMED_REGISTRY)).toBe(false);
    });
  });

  it('the predicate matches exactly the unbrokered CLI set the SEC-05 policy refuses', () => {
    for (const cli of ['cline', 'codex-cli', 'claude-code', 'gemini-cli']) {
      expect(isUnbrokeredAutonomousProvider(cli), cli).toBe(true);
    }
    for (const hosted of ['a2a', 'noop', 'anthropic', 'byo-hosted:user-model', '']) {
      expect(isUnbrokeredAutonomousProvider(hosted), hosted || '(empty)').toBe(false);
    }
  });
});
