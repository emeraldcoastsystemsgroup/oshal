/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for the operator's 2026-09-22 decision — a BYO connection may carry tools, with the per-call boundary enforced — replacing the blanket "BYO means no tools". resolveToolLessMarker answered the routing question and the authority question off one call, so any BYO connection emptied the tool set before the #757 boundary could matter, and the operator (whose default LLM is a BYO row) got a Jarvis told it had N tools and handed none. Crosses the boundary whose failure the fix prevents: a REAL OpenAI-compatible HTTP endpoint on loopback that the SHIPPED per-request provider reaches through the real `openai` client (so "the turn was offered tools" is read off the wire, not off a mock's arguments), the REAL _buildByoLlm, a REAL ToolRegistry with real capture/authorize/snapshot revalidation, the REAL dispatch executor and the REAL TaskController direct path. Doubled, and all OUTSIDE that boundary: the task/message stores and the tool bodies. Self-validating: the endpoint answers 401 to a request that does not carry the connection's own key, and fails a turn that asks for more legs than the case scripted.
 */

/** Loopback HTTP only. No deployment endpoint, no operator credential, no live datastore. */
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const requireModule = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-var-requires */
const TaskController = requireModule('../../any-bot/server/controllers/TaskController.js');
const ToolRegistry = requireModule('../../any-bot/server/services/ToolRegistry');
/* eslint-enable @typescript-eslint/no-var-requires */

type Json = Record<string, unknown>;

/** Bearer key the fixture endpoint demands. Invented here; never an environment value. */
const ENDPOINT_KEY = 'fixture-byo-endpoint-key';
/** The model the caller's own endpoint runs. */
const BYO_MODEL = 'fixture-owned-model';

const ASK = { text: 'What is the live status right now?' };

/** One chat-completions request exactly as the endpoint received it off the wire. */
interface RecordedRequest {
  authorized: boolean;
  model: string;
  toolsOffered: string[];
  toolChoice: unknown;
  messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
}

let wire: RecordedRequest[] = [];
let scripted: unknown[] = [];
let endpoint: Server;
let baseUrl: string;

/**
 * @description The caller's own OpenAI-compatible endpoint, on loopback. It enforces the
 * connection's bearer key, records what each leg actually declared, and answers from the case's
 * script — so an assertion about "the turn offered these tools" is a fact about the HTTP request
 * the shipped provider built, not about a stubbed method's arguments.
 * @returns The listening server, once bound.
 */
function startEndpoint(): Promise<Server> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const authorized = req.headers.authorization === `Bearer ${ENDPOINT_KEY}`;
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Json;
      wire.push({
        authorized,
        model: String(body.model ?? ''),
        toolsOffered: (Array.isArray(body.tools) ? body.tools : [])
          .map((tool: { function?: { name?: string } }) => String(tool?.function?.name ?? '')),
        toolChoice: body.tool_choice,
        messages: (body.messages ?? []) as RecordedRequest['messages'],
      });
      res.setHeader('content-type', 'application/json');
      if (!authorized) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: { message: 'missing or wrong bearer key' } }));
        return;
      }
      if (scripted.length === 0) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { message: 'the turn took more legs than this case scripted' } }));
        return;
      }
      res.statusCode = 200;
      res.end(JSON.stringify(scripted.shift()));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** A registry tool that records what it was called with, so "executed" is a fact not an inference. */
function recordingTool(name: string, result: unknown) {
  const calls: Json[] = [];
  return {
    calls,
    definition: {
      name,
      description: `fixture tool ${name}`,
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
    id: 'chatcmpl-fixture', object: 'chat.completion', created: 0, model: BYO_MODEL,
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

/** A plain text answer — the shape every endpoint that works today returns. */
function textTurn(text: string) {
  return {
    id: 'chatcmpl-fixture', object: 'chat.completion', created: 0, model: BYO_MODEL,
    choices: [{ finish_reason: 'stop', index: 0, message: { role: 'assistant', content: text } }],
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
  };
}

interface Harness {
  controller: {
    processMessage(taskId: string, userMessage: { text: string }, options?: Json): Promise<Json>;
    agenticCalls: number;
  };
  registry: InstanceType<typeof ToolRegistry>;
}

/**
 * @description The REAL direct path on a REAL BYO connection: a real ToolRegistry, the real
 * _buildByoLlm (so the per-request provider is the shipped one, pointed at the loopback endpoint),
 * and TaskController.processMessage itself.
 *
 * `llm` is null on purpose. The bot has no provider of its own here, so anything that reaches the
 * endpoint reached it over the caller's connection and nothing else.
 * @param toolDefinitions - registry tools to register.
 * @returns The controller and the registry it captures from.
 */
function harness(toolDefinitions: unknown[]): Harness {
  const registry = new ToolRegistry();
  for (const definition of toolDefinitions) registry.register(definition);

  const task = { id: 'task-byo', text: 'demo', messages: [] as unknown[], apiMetrics: {} as Json };
  const controller = Object.create(TaskController.prototype) as Harness['controller'] & Json;
  controller.getTask = async () => task;
  controller.updateTask = async (_id: string, updates: Json) => Object.assign(task, updates);
  controller.updateMetrics = async () => undefined;
  controller.messageStore = { saveMessage: async () => undefined };
  controller.stream = null;
  controller.llm = null;
  controller.toolRegistry = registry;
  controller.agenticCalls = 0;
  // Present, so "the BYO turn took the direct path" is a routing decision the guard observes
  // rather than an absence. A BYO turn reaching the loop would never see the caller's endpoint.
  controller.agenticController = { sentinel: true };
  controller.processWithAgenticMode = async () => {
    (controller as { agenticCalls: number }).agenticCalls += 1;
    return { success: true, path: 'agentic' };
  };
  return { controller: controller as Harness['controller'], registry };
}

/** The dispatch options a non-protected swarm-execute carries for a BYO caller. */
function byoDispatch(allowedTools: string[], authorizedScopes: string[], extra: Json = {}) {
  return {
    // agenticMode is the caller's default `true`: the BYO turn is routed direct by the marker's
    // BYO fallback, not by the caller asking for the direct path.
    agenticMode: true,
    source: 'swarm-dispatch',
    autoApprove: {},
    allowedTools,
    authorizedScopes,
    byoLlmConnection: { baseUrl, apiKey: ENDPOINT_KEY, model: BYO_MODEL },
    ...extra,
  };
}

/** The `say: 'text'` lines a completed turn surfaced to the caller. */
function saidText(result: Json): string[] {
  return (result.messages as Array<{ say: string; text: string }>)
    .filter((message) => message.say === 'text').map((message) => message.text);
}

/** The last `role: 'tool'` message the endpoint saw, i.e. what was fed back for a tool call. */
function lastToolMessage(): { role: string; content: unknown; tool_call_id?: string } {
  const legs = wire.at(-1)!.messages;
  return legs.at(-1)!;
}

beforeAll(async () => {
  endpoint = await startEndpoint();
  baseUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  if (endpoint) await new Promise<void>((resolve) => endpoint.close(() => resolve()));
});

afterEach(() => {
  wire = [];
  scripted = [];
});

describe('the fixture endpoint enforces rather than agrees', () => {
  it('refuses a request that does not carry the connection key', async () => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: BYO_MODEL, messages: [] }),
    });
    expect(response.status).toBe(401);
    expect(wire[0].authorized).toBe(false);
  });
});

describe('a BYO connection is handed the tools its caller was granted', () => {
  it('declares the captured tool set on the wire, on the direct path, over the caller endpoint', async () => {
    const live = recordingTool('read_file', 'contents');
    const h = harness([live.definition]);
    scripted = [textTurn('Answered.')];

    const result = await h.controller.processMessage(
      'task-byo', ASK, byoDispatch(['read_file'], ['tool:read_file']),
    );

    // THE FIX: the tool set reached the model. Before the change this was [].
    expect(wire).toHaveLength(1);
    expect(wire[0].toolsOffered).toEqual(['read_file']);
    expect(wire[0].toolChoice).toBe('auto');
    // On the caller's own endpoint, under the caller's own key and model.
    expect(wire[0].authorized).toBe(true);
    expect(wire[0].model).toBe(BYO_MODEL);
    // And the ROUTING half of the marker is untouched: a BYO turn still bypasses the agentic loop.
    expect(h.controller.agenticCalls).toBe(0);
    expect(result).toMatchObject({ success: true, provider: 'byo-llm', model: BYO_MODEL });
  }, 20_000);

  it('executes a declared tool through the real channel and answers from its result', async () => {
    const live = recordingTool('read_file', { status: 'live-value-42' });
    const h = harness([live.definition]);
    scripted = [toolCallTurn('read_file', { q: 'status' }), textTurn('The live status is live-value-42.')];

    const result = await h.controller.processMessage(
      'task-byo', ASK, byoDispatch(['read_file'], ['tool:read_file']),
    );

    // The handler actually ran, with the model's own arguments.
    expect(live.calls).toHaveLength(1);
    expect(live.calls[0]).toMatchObject({ q: 'status' });
    // A second leg carried the result back as a protocol `tool` message, fenced as untrusted
    // content exactly as the agentic loop fences it.
    expect(wire).toHaveLength(2);
    const fed = lastToolMessage();
    expect(fed.role).toBe('tool');
    expect(fed.tool_call_id).toBe('call_1');
    expect(String(fed.content)).toContain('UNTRUSTED_CONTENT');
    expect(String(fed.content)).toContain('live-value-42');
    // And the operator gets the answer, not "go to the application".
    expect(saidText(result)).toContain('The live status is live-value-42.');
  }, 20_000);
});

describe('a BYO connection gets nothing it was not granted', () => {
  it('honours an explicit toolLess:true — a caller that asks for no tools gets none', async () => {
    const live = recordingTool('read_file', 'contents');
    const h = harness([live.definition]);
    scripted = [textTurn('Answered without tools.')];

    await h.controller.processMessage(
      'task-byo', ASK, byoDispatch(['read_file'], ['tool:read_file'], { toolLess: true }),
    );

    expect(wire[0].toolsOffered).toEqual([]);
    expect(wire[0].toolChoice).toBeUndefined();
    expect(live.calls).toHaveLength(0);
  }, 20_000);

  it('honours OSHAL_TOOL_LESS=true, the process-level default, on a BYO turn', async () => {
    const previous = process.env.OSHAL_TOOL_LESS;
    process.env.OSHAL_TOOL_LESS = 'true';
    try {
      const live = recordingTool('read_file', 'contents');
      const h = harness([live.definition]);
      scripted = [textTurn('Answered without tools.')];

      await h.controller.processMessage(
        'task-byo', ASK, byoDispatch(['read_file'], ['tool:read_file']),
      );

      expect(wire[0].toolsOffered).toEqual([]);
      expect(live.calls).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.OSHAL_TOOL_LESS;
      else process.env.OSHAL_TOOL_LESS = previous;
    }
  }, 20_000);

  it('never executes a tool outside the declared set, and tells the model why', async () => {
    const declared = recordingTool('read_file', 'contents');
    const undeclared = recordingTool('execute_command', 'should never run');
    const h = harness([declared.definition, undeclared.definition]);
    scripted = [toolCallTurn('execute_command', { q: 'whoami' }), textTurn('I could not run that.')];

    const result = await h.controller.processMessage(
      'task-byo', ASK, byoDispatch(['read_file'], ['tool:read_file']),
    );

    expect(undeclared.calls).toHaveLength(0);
    expect(wire[0].toolsOffered).toEqual(['read_file']);
    const refusal = lastToolMessage();
    expect(JSON.parse(String(refusal.content))).toMatchObject({ error: 'tool_call_refused' });
    expect(String(refusal.content)).toContain('was not offered on this request');
    expect(saidText(result)).toContain('I could not run that.');
  }, 20_000);

  it('never executes a tool outside the authorized scopes, even when the allowlist names it', async () => {
    // The allowlist says yes and the scope says no. That is the scope boundary on its own: the
    // capture must not advertise it, and the provider must not run it when the model names it
    // anyway — which is exactly the shape a prompt injection produces.
    const unscoped = recordingTool('read_file', 'contents');
    const scopedTool = recordingTool('list_directory', 'listing');
    const h = harness([unscoped.definition, scopedTool.definition]);
    scripted = [toolCallTurn('read_file', { q: 'x' }), textTurn('I could not do that.')];

    const result = await h.controller.processMessage(
      'task-byo', ASK, byoDispatch(['read_file', 'list_directory'], ['tool:list_directory']),
    );

    expect(unscoped.calls).toHaveLength(0);
    expect(wire[0].toolsOffered).toEqual(['list_directory']);
    const refusal = lastToolMessage();
    expect(JSON.parse(String(refusal.content))).toMatchObject({ error: 'tool_call_refused' });
    expect(saidText(result)).toContain('I could not do that.');
  }, 20_000);

  it('declares nothing when the caller was granted nothing — an unauthorized BYO turn is unchanged', async () => {
    const live = recordingTool('read_file', 'contents');
    const h = harness([live.definition]);
    scripted = [textTurn('Answered without tools.')];

    await h.controller.processMessage('task-byo', ASK, byoDispatch([], []));

    expect(wire[0].toolsOffered).toEqual([]);
    expect(live.calls).toHaveLength(0);
  }, 20_000);
});
