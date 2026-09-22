/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for the direct (non-agentic) conversational path promising the model tools it was never handed: TaskController passed tools/enforceToolBoundary/authorizedScopes and OpenAIProvider.generateResponse read none of them, so an ask for live information came back as "I cannot report on live data, go to the application". Crosses the boundaries whose failure the fix prevents - a REAL ToolRegistry with REAL capture/authorize/snapshot revalidation, the REAL dispatch executor and the REAL TaskController direct path - and doubles only the vendor HTTP client, which is outside it. Covers the refusals too: an undeclared tool, a missing exact operation scope, and an unasserted boundary must never reach a handler.
 */

import { createRequire } from 'module';
import { describe, it, expect, vi } from 'vitest';

const require = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-var-requires */
const TaskController = require('../../any-bot/server/controllers/TaskController');
const ToolRegistry = require('../../any-bot/server/services/ToolRegistry');
const OpenAIProvider = require('../../any-bot/server/services/llm/OpenAIProvider');
/* eslint-enable @typescript-eslint/no-var-requires */

type Json = Record<string, unknown>;

/** A registry tool that records what it was called with, so "executed" is a fact not an inference. */
function recordingTool(name: string, result: unknown) {
  const calls: Json[] = [];
  return {
    calls,
    definition: {
      name,
      description: `test tool ${name}`,
      category: 'general',
      // requiresApproval:false mirrors the read-only registry tools; the approval policy itself is
      // pinned by tool-approval-policy.spec.ts and is deliberately not re-litigated here.
      requiresApproval: false,
      inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: [] },
      handler: async (input: Json) => { calls.push(input); return result; },
    },
  };
}

/** One assistant turn asking for a tool, in the shape an OpenAI-compatible gateway returns it. */
function toolCallTurn(name: string, args: Json, id = 'call_1') {
  return {
    choices: [{
      finish_reason: 'tool_calls',
      index: 0,
      message: {
        role: 'assistant',
        tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
    usage: { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 },
  };
}

/** A plain text answer — the shape every provider that works today returns. */
function textTurn(text: string) {
  return {
    choices: [{ finish_reason: 'stop', index: 0, message: { role: 'assistant', content: text } }],
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
  };
}

interface Harness {
  controller: Record<string, unknown>;
  create: ReturnType<typeof vi.fn>;
  registry: InstanceType<typeof ToolRegistry>;
  task: { id: string; text: string; messages: unknown[]; apiMetrics: Json; workspace_dir?: string };
}

/**
 * The REAL direct path: a real ToolRegistry, a real OpenAIProvider, and TaskController.processMessage
 * itself. Only the vendor HTTP client is scripted — everything the fix touches is the live code.
 */
function harness(
  toolDefinitions: unknown[],
  responses: unknown[],
  providerConfig: Json = {},
): Harness {
  const registry = new ToolRegistry();
  for (const definition of toolDefinitions) registry.register(definition);

  const provider = new OpenAIProvider({
    apiKey: 'unit-test-not-a-real-credential',
    model: 'gpt-4o-mini',
    ...providerConfig,
  });
  const create = vi.fn(async () => {
    if (!responses.length) throw new Error('the adapter made more calls than the fixture scripted');
    return responses.shift();
  });
  provider.client = { chat: { completions: { create } } };

  const task = { id: 'task-1', text: 'demo', messages: [] as unknown[], apiMetrics: {} as Json };
  const controller = Object.create(TaskController.prototype);
  controller.getTask = async () => task;
  controller.updateTask = async (_id: string, updates: Json) => Object.assign(task, updates);
  controller.updateMetrics = async () => undefined;
  controller.messageStore = { saveMessage: async () => undefined };
  controller.stream = null;
  controller.llm = provider;
  controller.agenticController = null;
  controller.toolRegistry = registry;
  return { controller, create, registry, task };
}

/** The direct-path dispatch options a non-protected swarm-execute carries. */
function dispatch(allowedTools: string[], authorizedScopes: string[]) {
  return {
    agenticMode: false,
    source: 'swarm-dispatch',
    autoApprove: {},
    allowedTools,
    authorizedScopes,
  };
}

const ASK = { text: 'What is the live status right now?' };

describe('direct path: the tools the caller was given are DECLARED to the model', () => {
  it('puts the captured tool set in the request, in the OpenAI function shape', async () => {
    const live = recordingTool('read_file', 'contents');
    const h = harness([live.definition], [textTurn('Answered.')]);

    await h.controller.processMessage(
      'task-1', ASK, dispatch(['read_file'], ['tool:read_file']),
    );

    const request = h.create.mock.calls[0][0];
    expect(request.tools).toEqual([{
      type: 'function',
      function: {
        name: 'read_file',
        description: 'test tool read_file',
        parameters: { type: 'object', properties: { q: { type: 'string' } }, required: [] },
      },
    }]);
    expect(request.tool_choice).toBe('auto');
  });

  it('declares NOTHING when the caller authorized nothing — a tool-less turn is unchanged', async () => {
    const live = recordingTool('read_file', 'contents');
    const h = harness([live.definition], [textTurn('Answered without tools.')]);

    await h.controller.processMessage('task-1', ASK, dispatch([], []));

    expect(h.create.mock.calls[0][0].tools).toBeUndefined();
    expect(live.calls).toHaveLength(0);
  });
});

describe('direct path: a tool call is EXECUTED and its result answers the user', () => {
  it('runs the declared tool through the registry and feeds the result back for a final answer', async () => {
    const live = recordingTool('read_file', { status: 'live-value-42' });
    const h = harness(
      [live.definition],
      [toolCallTurn('read_file', { q: 'status' }), textTurn('The live status is live-value-42.')],
    );

    const result = await h.controller.processMessage(
      'task-1', ASK, dispatch(['read_file'], ['tool:read_file']),
    );

    // The handler actually ran, with the model's arguments.
    expect(live.calls).toHaveLength(1);
    expect(live.calls[0]).toMatchObject({ q: 'status' });
    // A second leg was taken, carrying the tool result as a protocol `tool` message.
    expect(h.create).toHaveBeenCalledTimes(2);
    const second = h.create.mock.calls[1][0];
    const toolMessage = second.messages[second.messages.length - 1];
    expect(toolMessage.role).toBe('tool');
    expect(toolMessage.tool_call_id).toBe('call_1');
    // Tool output is fenced as untrusted content, exactly as the agentic loop fences it.
    expect(String(toolMessage.content)).toContain('UNTRUSTED_CONTENT');
    expect(String(toolMessage.content)).toContain('live-value-42');
    // And the user gets the answer, not "go to the application".
    const said = (result as { messages: Array<{ say: string; text: string }> }).messages
      .filter((m) => m.say === 'text').map((m) => m.text);
    expect(said).toContain('The live status is live-value-42.');
  });

  it('ends the exchange on attempt_completion, which is a control and runs no tool', async () => {
    const live = recordingTool('read_file', 'contents');
    const h = harness(
      [live.definition],
      [toolCallTurn('attempt_completion', { result: 'Here is the answer.' })],
    );

    const result = await h.controller.processMessage(
      'task-1', ASK,
      dispatch(['read_file', 'attempt_completion'], ['tool:read_file', 'control:attempt_completion']),
    );

    expect(live.calls).toHaveLength(0);
    expect(h.create).toHaveBeenCalledTimes(1);
    const said = (result as { messages: Array<{ say: string; text: string }> }).messages
      .filter((m) => m.say === 'text').map((m) => m.text);
    expect(said).toContain('Here is the answer.');
  });
});

describe('direct path: the tool boundary is enforced, not advertised', () => {
  it('REFUSES a tool the request never declared, and tells the model why', async () => {
    const declared = recordingTool('read_file', 'contents');
    const undeclared = recordingTool('execute_command', 'should never run');
    const h = harness(
      [declared.definition, undeclared.definition],
      [toolCallTurn('execute_command', { q: 'whoami' }), textTurn('I could not run that.')],
    );

    await h.controller.processMessage(
      'task-1', ASK, dispatch(['read_file'], ['tool:read_file']),
    );

    expect(undeclared.calls).toHaveLength(0);
    const refusal = h.create.mock.calls[1][0].messages.at(-1);
    expect(refusal.role).toBe('tool');
    expect(JSON.parse(refusal.content)).toMatchObject({ error: 'tool_call_refused' });
    expect(String(refusal.content)).toContain('was not offered on this request');
  });

  it('never executes an allowlisted tool whose exact operation scope is not held', async () => {
    // The allowlist says yes and the scope says no. captureDispatchCapabilities therefore never
    // advertises it, so a model naming it is naming a tool it was never shown — the shape a prompt
    // injection produces. It must be refused, not executed.
    const gated = recordingTool('read_file', 'contents');
    const other = recordingTool('list_directory', 'listing');
    const h = harness(
      [gated.definition, other.definition],
      [toolCallTurn('read_file', { q: 'x' }), textTurn('I could not do that.')],
    );

    await h.controller.processMessage(
      'task-1', ASK, dispatch(['read_file', 'list_directory'], ['tool:list_directory']),
    );

    expect(gated.calls).toHaveLength(0);
    expect(h.create.mock.calls[0][0].tools.map((t: { function: { name: string } }) => t.function.name))
      .toEqual(['list_directory']);
    const refusal = h.create.mock.calls[1][0].messages.at(-1);
    expect(JSON.parse(refusal.content)).toMatchObject({ error: 'tool_call_refused' });
  });

  it('refuses a DECLARED tool whose scope was dropped — the second layer, not the first', async () => {
    // Defence in depth at the provider itself: even if a caller declared a tool, a name without
    // its exact `tool:<name>` scope is refused before the execution channel is reached. This is
    // the layer that would still hold if a future caller built its own definitions list.
    const provider = new OpenAIProvider({ apiKey: 'unit-test-not-a-real-credential', model: 'gpt-4o-mini' });
    const responses: unknown[] = [toolCallTurn('read_file', { q: 'x' }), textTurn('Refused.')];
    const create = vi.fn(async () => responses.shift());
    provider.client = { chat: { completions: { create } } };
    const execute = vi.fn(async () => ({ ok: true, result: 'executed' }));

    const result = await provider.generateResponse([{ role: 'user', content: 'hi' }], {
      tools: [{ name: 'read_file', description: 'd', inputSchema: { type: 'object' } }],
      enforceToolBoundary: true,
      authorizedScopes: ['tool:something_else'],
      executeTool: execute,
    });

    expect(execute).not.toHaveBeenCalled();
    const refusal = create.mock.calls[1][0].messages.at(-1);
    expect(String(refusal.content)).toContain('Missing exact operation scope: tool:read_file');
    expect(result.content).toBe('Refused.');
  });

  it('executes NOTHING when the caller did not assert enforceToolBoundary', async () => {
    // Straight at the provider: absence is never authority, matching normalizeAllowedTools and
    // normalizeAuthorizedScopes. A caller that hands over tools without asserting the boundary
    // gets them declared and none of them executed.
    const live = recordingTool('read_file', 'contents');
    const registry = new ToolRegistry();
    registry.register(live.definition);
    const provider = new OpenAIProvider({ apiKey: 'unit-test-not-a-real-credential', model: 'gpt-4o-mini' });
    const responses: unknown[] = [toolCallTurn('read_file', { q: 'x' }), textTurn('No tool ran.')];
    provider.client = { chat: { completions: { create: vi.fn(async () => responses.shift()) } } };

    const execute = vi.fn(async () => ({ ok: true, result: 'executed' }));
    const result = await provider.generateResponse([{ role: 'user', content: 'hi' }], {
      tools: [{ name: 'read_file', description: 'd', inputSchema: { type: 'object' } }],
      authorizedScopes: ['tool:read_file'],
      executeTool: execute,
      // enforceToolBoundary deliberately absent.
    });

    expect(execute).not.toHaveBeenCalled();
    expect(live.calls).toHaveLength(0);
    const refusal = (provider.client.chat.completions.create as ReturnType<typeof vi.fn>)
      .mock.calls[1][0].messages.at(-1);
    expect(String(refusal.content)).toContain('did not assert a tool boundary');
    expect(result.content).toBe('No tool ran.');
  });

  it('executes nothing when tools were declared but no execution channel was wired', async () => {
    // A caller that declares tools it cannot run must not leave the model waiting on a result that
    // can never arrive: it is told so, and answers.
    const provider = new OpenAIProvider({ apiKey: 'unit-test-not-a-real-credential', model: 'gpt-4o-mini' });
    const responses: unknown[] = [toolCallTurn('read_file', { q: 'x' }), textTurn('Nothing ran.')];
    const create = vi.fn(async () => responses.shift());
    provider.client = { chat: { completions: { create } } };

    const result = await provider.generateResponse([{ role: 'user', content: 'hi' }], {
      tools: [{ name: 'read_file', description: 'd', inputSchema: { type: 'object' } }],
      enforceToolBoundary: true,
      authorizedScopes: ['tool:read_file'],
      // executeTool deliberately absent.
    });

    const refusal = create.mock.calls[1][0].messages.at(-1);
    expect(String(refusal.content)).toContain('No tool execution channel was provided');
    expect(result.content).toBe('Nothing ran.');
  });

  it('fails the whole request when a capability is replaced mid-exchange', async () => {
    // assertDispatchCapabilitiesCurrent is what makes a multi-leg loop safe. Re-registering the
    // tool between legs mints a different frozen definition, and the snapshot must stop being
    // current — the exchange must not carry on against the new handler.
    const original = recordingTool('read_file', 'original');
    const replacement = recordingTool('read_file', 'replacement');
    const h = harness(
      [original.definition],
      [toolCallTurn('read_file', { q: 'x' }), textTurn('unreachable')],
    );
    h.create.mockImplementationOnce(async () => {
      // Swap the registry entry after the model has asked, before the executor runs.
      h.registry.register(replacement.definition);
      return toolCallTurn('read_file', { q: 'x' });
    });

    const failure = await h.controller.processMessage(
      'task-1', ASK, dispatch(['read_file'], ['tool:read_file']),
    ).then(() => null, (e: Error) => e);

    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).toContain('replaced or revoked after request authorization');
    expect(original.calls).toHaveLength(0);
    expect(replacement.calls).toHaveLength(0);
  });

  it('bounds the exchange: a model that only ever asks for tools still terminates', async () => {
    const live = recordingTool('read_file', 'contents');
    // Far more tool turns than the budget allows; the fixture would throw if the loop ran on.
    const responses = Array.from({ length: 5 }, (_, i) => toolCallTurn('read_file', { q: String(i) }, `call_${i}`));
    responses.push(textTurn('Stopping and answering directly.'));
    const h = harness([live.definition], responses);

    const result = await h.controller.processMessage(
      'task-1', ASK, dispatch(['read_file'], ['tool:read_file']),
    );

    // 4 executed rounds, then one refused round, then the answer.
    expect(live.calls).toHaveLength(4);
    const last = h.create.mock.calls.at(-1)![0].messages.at(-1);
    expect(JSON.parse(last.content)).toMatchObject({ error: 'tool_call_refused' });
    expect(String(last.content)).toContain('tool budget');
    const said = (result as { messages: Array<{ say: string; text: string }> }).messages
      .filter((m) => m.say === 'text').map((m) => m.text);
    expect(said).toContain('Stopping and answering directly.');
  });
});

describe('direct path: the providers that answer in plain text are untouched', () => {
  it.each([
    ['OpenAI', undefined, 'gpt-4o-mini'],
    ['Groq', 'https://api.groq.com/openai/v1', 'llama-3.3-70b-versatile'],
    ['LM Studio', 'http://127.0.0.1:1234/v1', 'local-model'],
  ])('%s: a text answer with tools declared is ONE call and no execution', async (
    _name, baseUrl, model,
  ) => {
    const live = recordingTool('read_file', 'contents');
    const h = harness(
      [live.definition],
      [textTurn('A plain answer.')],
      baseUrl ? { baseUrl, model } : { model },
    );

    const result = await h.controller.processMessage(
      'task-1', ASK, dispatch(['read_file'], ['tool:read_file']),
    );

    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create.mock.calls[0][0].tools).toHaveLength(1);
    expect(live.calls).toHaveLength(0);
    const said = (result as { messages: Array<{ say: string; text: string }> }).messages
      .filter((m) => m.say === 'text').map((m) => m.text);
    expect(said).toContain('A plain answer.');
  });
});
