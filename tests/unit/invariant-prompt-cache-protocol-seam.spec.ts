/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Real local protocol seam for the invariant prompt cache. A loopback HTTP server serves Gemini's `/v1beta/cachedContents` and `/v1beta/openai/chat/completions`, records every raw body and header, and the SHIPPED path drives it: TaskController.processMessage on the BYO direct path, the real _buildByoLlm, the real OpenAIProvider with the real `openai` client, the process-shared Gemini cache, a real ToolRegistry and the real dispatch executor. Doubled, and all outside that boundary: the task/message stores and the tool bodies. Proves on the wire that two new tasks of two owners share ONE create, that the create holds only the system instruction and function declarations, that a tool-set or system-prompt change creates again, that a different credential never shares a handle, that a handle-carrying request declares no system/tools and that the local boundary still refuses an undeclared call, that a 4xx on the handle answers from one full send and is not re-created within the negative TTL, and that task B's request never carries task A's text.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'module';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-require-imports */
const TaskController = require('../../any-bot/server/controllers/TaskController');
const ToolRegistry = require('../../any-bot/server/services/ToolRegistry');
const { resetSharedInvariantPromptCache } = require('../../any-bot/server/services/llm/gemini-context-cache');
/* eslint-enable @typescript-eslint/no-require-imports */

type Json = Record<string, unknown>;

const KEY_OWNER_A_AND_B = 'unit-test-key-shared-connection';
const KEY_OTHER = 'unit-test-key-other-connection';
const MODEL = 'gemini-2.5-flash';

interface CreateCall { apiKey: string | undefined; url: string; body: Json }
interface ChatCall { authorization: string | undefined; body: Json }

let creates: CreateCall[] = [];
let chats: ChatCall[] = [];
let scripted: Json[] = [];
let rejectHandles = false;
let refuseCreates = false;
let handleSeq = 0;
let endpoint: Server;
let compatBase: string;

function readBody(req: IncomingMessage): Promise<Json> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Json));
  });
}

function reply(res: ServerResponse, status: number, json: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(json));
}

/** A plain text answer; cached-token usage is reported only when the request carried a handle. */
function textTurn(text: string, cachedHandle: boolean): Json {
  return {
    id: 'chatcmpl-fixture', object: 'chat.completion', created: 0, model: MODEL,
    choices: [{ finish_reason: 'stop', index: 0, message: { role: 'assistant', content: text } }],
    usage: cachedHandle
      ? { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48, prompt_tokens_details: { cached_tokens: 30 } }
      : { prompt_tokens: 400, completion_tokens: 8, total_tokens: 408 },
  };
}

function toolCallTurn(name: string, args: Json, id: string): Json {
  return {
    id: 'chatcmpl-fixture', object: 'chat.completion', created: 0, model: MODEL,
    choices: [{
      finish_reason: 'tool_calls', index: 0,
      message: { role: 'assistant', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
    }],
    usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52, prompt_tokens_details: { cached_tokens: 30 } },
  };
}

/**
 * @description The Gemini surfaces on loopback: the native cachedContents create and the
 * OpenAI-compatible chat completions, both recording what actually arrived.
 * @returns The listening server, once bound.
 */
function startEndpoint(): Promise<Server> {
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.method === 'POST' && req.url === '/v1beta/cachedContents') {
      creates.push({ apiKey: req.headers['x-goog-api-key'] as string | undefined, url: String(req.url), body });
      if (refuseCreates) return reply(res, 400, { error: { message: 'Cached content is too small.' } });
      handleSeq += 1;
      return reply(res, 200, { name: `cachedContents/${handleSeq}`, model: `models/${MODEL}` });
    }
    if (req.method === 'POST' && req.url === '/v1beta/openai/chat/completions') {
      chats.push({ authorization: req.headers.authorization, body });
      const handle = (body.extra_body as { google?: { cached_content?: string } } | undefined)?.google?.cached_content;
      if (handle && rejectHandles) return reply(res, 400, { error: { message: 'CachedContent not found' } });
      if (scripted.length > 0) return reply(res, 200, scripted.shift());
      return reply(res, 200, textTurn('answered', Boolean(handle)));
    }
    return reply(res, 404, { error: { message: `unexpected ${req.method} ${req.url}` } });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** A registry tool that records what it was called with, so "executed" is a fact not an inference. */
function recordingTool(name: string, result: unknown) {
  const calls: Json[] = [];
  return {
    calls,
    definition: {
      name, description: `fixture tool ${name}`, category: 'general', requiresApproval: false,
      inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: [] },
      handler: async (input: Json) => { calls.push(input); return result; },
    },
  };
}

interface FixtureTask { id: string; text: string; userSub: string; messages: unknown[]; apiMetrics: Json; status?: string }

/**
 * @description The REAL direct path over a process-shared cache: a real ToolRegistry, the real
 * _buildByoLlm and TaskController.processMessage itself, with the REAL updateMetrics fold so the
 * returned apiMetrics is what chat_tasks would be billed from. Tasks live in a map so several
 * owners' conversations share one controller, exactly as one bot-node process does.
 * @param toolDefinitions - registry tools to register.
 * @returns The controller and its task map.
 */
function harness(toolDefinitions: unknown[]) {
  const registry = new ToolRegistry();
  for (const definition of toolDefinitions) registry.register(definition);
  const tasks = new Map<string, FixtureTask>();
  const controller = Object.create(TaskController.prototype);
  controller.getTask = async (id: string) => tasks.get(id) ?? null;
  controller.updateTask = async (id: string, updates: Json) => Object.assign(tasks.get(id)!, updates);
  controller.messageStore = { saveMessage: async () => undefined };
  controller.stream = null;
  controller.llm = null;
  controller.agenticController = null;
  controller.toolRegistry = registry;
  const newTask = (id: string, userSub: string, text = 'Swarm execution for jarvis') => {
    tasks.set(id, { id, text, userSub, messages: [], apiMetrics: {} });
    return id;
  };
  return { controller, tasks, newTask };
}

function dispatch(apiKey: string, allowedTools: string[], authorizedScopes: string[]) {
  return {
    agenticMode: false, source: 'swarm-dispatch', autoApprove: {}, allowedTools, authorizedScopes,
    byoLlmConnection: { baseUrl: compatBase, apiKey, model: MODEL },
  };
}

function said(result: Json): string[] {
  return (result.messages as Array<{ say: string; text: string }>).filter((m) => m.say === 'text').map((m) => m.text);
}

beforeAll(async () => {
  endpoint = await startEndpoint();
  compatBase = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/v1beta/openai`;
});

afterAll(async () => {
  if (endpoint) await new Promise<void>((resolve) => endpoint.close(() => resolve()));
});

beforeEach(() => { resetSharedInvariantPromptCache(); });

afterEach(() => {
  creates = []; chats = []; scripted = []; rejectHandles = false; refuseCreates = false; handleSeq = 0;
});

describe('two new conversations share one provider-side preamble', () => {
  it('creates the cache once, holds only the preamble, and never carries another task\'s text', async () => {
    const tool = recordingTool('conversation_query', 'listing');
    const h = harness([tool.definition]);
    const taskA = h.newTask('task-a', 'owner-a');
    const taskB = h.newTask('task-b', 'owner-b');

    const resultA = await h.controller.processMessage(taskA, { text: 'Task A secret phrase alpha' },
      dispatch(KEY_OWNER_A_AND_B, ['conversation_query'], ['tool:conversation_query']));

    // ONE create, authenticated by header, holding the system instruction and the declared tool.
    expect(creates).toHaveLength(1);
    expect(creates[0].apiKey).toBe(KEY_OWNER_A_AND_B);
    expect(creates[0].url).toBe('/v1beta/cachedContents');
    const createBody = creates[0].body as { model: string; systemInstruction: { parts: Array<{ text: string }> }; tools: unknown; ttl: string };
    expect(createBody.model).toBe(`models/${MODEL}`);
    expect(createBody.systemInstruction.parts[0].text).toMatch(/^You are an OSHAL agent/);
    expect(createBody.systemInstruction.parts[0].text).toContain('The current task is: Swarm execution for jarvis');
    expect(createBody.tools).toEqual([{ functionDeclarations: [{
      name: 'conversation_query', description: 'fixture tool conversation_query',
      parameters: { type: 'object', properties: { q: { type: 'string' } }, required: [] },
    }] }]);
    expect(createBody.ttl).toBe('3360s');
    expect(createBody).not.toHaveProperty('contents');
    expect(JSON.stringify(createBody)).not.toContain('alpha');
    expect(JSON.stringify(createBody)).not.toContain(KEY_OWNER_A_AND_B);

    // The chat request carried the handle in the documented nesting and nothing the handle holds.
    expect(chats).toHaveLength(1);
    expect(chats[0].authorization).toBe(`Bearer ${KEY_OWNER_A_AND_B}`);
    expect(chats[0].body.extra_body).toEqual({ google: { cached_content: 'cachedContents/1' } });
    expect(chats[0].body).not.toHaveProperty('tools');
    expect(chats[0].body).not.toHaveProperty('tool_choice');
    expect(chats[0].body.messages).toEqual([{ role: 'user', content: 'Task A secret phrase alpha' }]);
    expect(said(resultA)).toEqual(['answered']);

    // Task B, another owner, on the same connection: the same handle, no second create, no task A.
    const resultB = await h.controller.processMessage(taskB, { text: 'Task B secret phrase bravo' },
      dispatch(KEY_OWNER_A_AND_B, ['conversation_query'], ['tool:conversation_query']));
    expect(creates).toHaveLength(1);
    expect(chats).toHaveLength(2);
    expect(chats[1].body.extra_body).toEqual({ google: { cached_content: 'cachedContents/1' } });
    expect(chats[1].body.messages).toEqual([{ role: 'user', content: 'Task B secret phrase bravo' }]);
    expect(JSON.stringify(chats[1].body)).not.toContain('alpha');
    expect(said(resultB)).toEqual(['answered']);

    // The fold TaskController records is the measurement: input/output split, cached count, state.
    expect(resultA.apiMetrics).toMatchObject({ inputTokens: 40, outputTokens: 8, totalTokens: 48, cacheReads: 30, cacheHits: 1, promptCache: 'created', requestCount: 1 });
    expect(resultB.apiMetrics).toMatchObject({ inputTokens: 40, outputTokens: 8, cacheReads: 30, cacheHits: 1, promptCache: 'hit' });
  });

  it('creates again for a tool-set change, a system-prompt change, or a different credential', async () => {
    const one = recordingTool('conversation_query', 'listing');
    const two = recordingTool('conversation_fetch', 'record');
    const h = harness([one.definition, two.definition]);

    await h.controller.processMessage(h.newTask('t1', 'owner-a'), { text: 'first' },
      dispatch(KEY_OWNER_A_AND_B, ['conversation_query'], ['tool:conversation_query']));
    expect(creates).toHaveLength(1);

    // Same preamble, new task: reused.
    await h.controller.processMessage(h.newTask('t2', 'owner-a'), { text: 'second' },
      dispatch(KEY_OWNER_A_AND_B, ['conversation_query'], ['tool:conversation_query']));
    expect(creates).toHaveLength(1);

    // A wider tool set is a different preamble.
    await h.controller.processMessage(h.newTask('t3', 'owner-a'), { text: 'third' },
      dispatch(KEY_OWNER_A_AND_B, ['conversation_query', 'conversation_fetch'], ['tool:conversation_query', 'tool:conversation_fetch']));
    expect(creates).toHaveLength(2);
    const declared = (creates[1].body as { tools: Array<{ functionDeclarations: Array<{ name: string }> }> }).tools[0].functionDeclarations.map((d) => d.name);
    expect(declared).toEqual(['conversation_query', 'conversation_fetch']);
    expect(chats[2].body.extra_body).toEqual({ google: { cached_content: 'cachedContents/2' } });

    // A different task title changes the system prompt: a third handle.
    await h.controller.processMessage(h.newTask('t4', 'owner-a', 'Swarm execution for another-bot'), { text: 'fourth' },
      dispatch(KEY_OWNER_A_AND_B, ['conversation_query'], ['tool:conversation_query']));
    expect(creates).toHaveLength(3);
    expect((creates[2].body as { systemInstruction: { parts: Array<{ text: string }> } }).systemInstruction.parts[0].text)
      .toContain('Swarm execution for another-bot');

    // The same preamble on another credential never shares a handle: its own create, its own key.
    await h.controller.processMessage(h.newTask('t5', 'owner-c'), { text: 'fifth' },
      dispatch(KEY_OTHER, ['conversation_query'], ['tool:conversation_query']));
    expect(creates).toHaveLength(4);
    expect(creates[3].apiKey).toBe(KEY_OTHER);
    expect(chats[4].body.extra_body).toEqual({ google: { cached_content: 'cachedContents/4' } });
  });
});

describe('the boundary and the fallback with the preamble held provider-side', () => {
  it('still refuses an undeclared call and executes a declared one while no tools are on the wire', async () => {
    const declared = recordingTool('conversation_query', { rows: ['live-value-42'] });
    const undeclared = recordingTool('execute_command', 'must never run');
    const h = harness([declared.definition, undeclared.definition]);
    scripted = [
      toolCallTurn('execute_command', { q: 'whoami' }, 'call_bad'),
      toolCallTurn('conversation_query', { q: 'status' }, 'call_ok'),
      textTurn('The live value is live-value-42.', true),
    ];

    const result = await h.controller.processMessage(h.newTask('t-tools', 'owner-a'), { text: 'What is live?' },
      dispatch(KEY_OWNER_A_AND_B, ['conversation_query'], ['tool:conversation_query']));

    expect(chats).toHaveLength(3);
    for (const call of chats) {
      expect(call.body.extra_body).toEqual({ google: { cached_content: 'cachedContents/1' } });
      expect(call.body).not.toHaveProperty('tools');
    }
    expect(undeclared.calls).toHaveLength(0);
    const refusal = (chats[1].body.messages as Array<{ role: string; content: string }>).at(-1)!;
    expect(refusal.role).toBe('tool');
    expect(String(refusal.content)).toContain('was not offered on this request');
    expect(declared.calls).toEqual([{ q: 'status' }]);
    const fed = (chats[2].body.messages as Array<{ role: string; content: string; tool_call_id?: string }>).at(-1)!;
    expect(fed.tool_call_id).toBe('call_ok');
    expect(String(fed.content)).toContain('live-value-42');
    expect(said(result)).toEqual(['The live value is live-value-42.']);
  });

  it('answers from ONE full send when the endpoint rejects the handle, then stops creating for the negative TTL', async () => {
    const tool = recordingTool('conversation_query', 'listing');
    const h = harness([tool.definition]);
    rejectHandles = true;

    const result = await h.controller.processMessage(h.newTask('t-reject', 'owner-a'), { text: 'Ask with a stale handle' },
      dispatch(KEY_OWNER_A_AND_B, ['conversation_query'], ['tool:conversation_query']));

    expect(creates).toHaveLength(1);
    expect(chats).toHaveLength(2);
    expect(chats[0].body.extra_body).toEqual({ google: { cached_content: 'cachedContents/1' } });
    const full = chats[1].body as { extra_body?: unknown; tools: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: string }> };
    expect(full).not.toHaveProperty('extra_body');
    expect(full.messages[0].role).toBe('system');
    expect(full.messages[0].content).toMatch(/^You are an OSHAL agent/);
    expect(full.messages.at(-1)).toEqual({ role: 'user', content: 'Ask with a stale handle' });
    expect(full.tools.map((t) => t.function.name)).toEqual(['conversation_query']);
    expect(said(result)).toEqual(['answered']);
    expect(result.apiMetrics).toMatchObject({ promptCache: 'fallback', inputTokens: 400, cacheReads: 0, cacheHits: 0 });

    // The next new conversation on the same preamble goes straight to a full send: no create, no handle.
    const next = await h.controller.processMessage(h.newTask('t-after', 'owner-b'), { text: 'Next conversation' },
      dispatch(KEY_OWNER_A_AND_B, ['conversation_query'], ['tool:conversation_query']));
    expect(creates).toHaveLength(1);
    expect(chats).toHaveLength(3);
    expect(chats[2].body).not.toHaveProperty('extra_body');
    expect((chats[2].body.messages as Array<{ role: string }>)[0].role).toBe('system');
    expect(said(next)).toEqual(['answered']);
    expect(next.apiMetrics).toMatchObject({ promptCache: 'refused' });
  });

  it('answers from a full send when the provider refuses to create, and does not retry the create every turn', async () => {
    const tool = recordingTool('conversation_query', 'listing');
    const h = harness([tool.definition]);
    refuseCreates = true;

    const first = await h.controller.processMessage(h.newTask('t-small', 'owner-a'), { text: 'first' },
      dispatch(KEY_OWNER_A_AND_B, ['conversation_query'], ['tool:conversation_query']));
    const second = await h.controller.processMessage(h.newTask('t-small-2', 'owner-a'), { text: 'second' },
      dispatch(KEY_OWNER_A_AND_B, ['conversation_query'], ['tool:conversation_query']));

    expect(creates).toHaveLength(1);
    expect(chats).toHaveLength(2);
    for (const call of chats) {
      expect(call.body).not.toHaveProperty('extra_body');
      expect((call.body.messages as Array<{ role: string }>)[0].role).toBe('system');
      expect((call.body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)).toEqual(['conversation_query']);
    }
    expect(said(first)).toEqual(['answered']);
    expect(said(second)).toEqual(['answered']);
    expect(first.apiMetrics).toMatchObject({ promptCache: 'refused' });
    expect(second.apiMetrics).toMatchObject({ promptCache: 'refused' });
  });
});
