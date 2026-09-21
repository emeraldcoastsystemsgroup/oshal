/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Real-boundary guard for BACKLOG "BYO/free-tier tool-capable turns": a BYO (and a free-tier-resolved) connection completes a GUARDED tool task on the inline lane, with caller identity on the tool call and cost metadata on the ledger. Three boundaries are real, not doubled — (1) the OpenAI-compatible HTTP seam: a local node:http endpoint the shipped ByoHostedProvider reaches with a real fetch, which checks the Bearer key and answers tool_calls only when the request actually offered tools; (2) the authorization boundary: the shipped ToolAuthInterceptor decides auto/off/unregistered and only an authorized call reaches the executor; (3) the cost boundary: a disposable postgres:16-alpine with the real migrations, a NOSUPERUSER NOBYPASSRLS runtime role behind the production GUC wrapper, the real createInlineTurnCostLedger and the real BudgetService read. Doubled, outside those boundaries: the registry row the interceptor looks up, the tool body itself, the message store and the stream manager. Self-validating: a keyless request is refused 401 by the endpoint, and a ledger insert whose owner disagrees with the connection identity is refused 42501, so the fixture enforces rather than agrees with itself. Docker is REQUIRED — a missing engine fails, never skips.
 */

/** Disposable local PostgreSQL only. Never consumes DATABASE_URL or deployment credentials. */
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { createMemoryOnlyTaskStore } from '../helpers/jarvis-session-task-store';
import { wrapPoolWithGuc } from '../../src/shared/services/database/guc-pool';
import { runWithRequestIdentity } from '../../src/shared/services/database/request-identity';
import { TaskOrchestrator, type TaskOrchestratorDeps } from '../../src/features/chat-orchestration/services/task-orchestrator';
import { createInlineTurnCostLedger } from '../../src/app/composition/inline-turn-cost-ledger';
import { BudgetService } from '../../src/features/cost-governance/services/budget-service';
import { classifyCostUnit } from '../../src/features/cost-governance/services/cost-unit';
import { ToolAuthInterceptor } from '../../src/features/tool-approval/services/tool-auth-interceptor';
import { AuthMode, InstallMethod, ToolType, type Tool } from '../../src/shared/types/tool';
import type { LLMToolDefinition } from '../../src/features/llm-provider/services/llm-service';
import type { ResolvedUserLlmConnection } from '../../src/app/routes/free-tier-rotation';

const OWNER = 'byo-tool-owner-sub';
const OTHER = 'byo-tool-other-sub';
const RUNTIME_ROLE = 'byo_tool_runtime';
const RUNTIME_PASS = 'fixture-only';

/** The bot identity that runs these turns; it is what lands in the ledger's agent_id. */
const BYO_BOT = 'byo-concierge';
/** The model the caller's endpoint runs — the provider stamps `byo-hosted:<model>`. */
const BYO_MODEL = 'fixture-owned-model';
/** Bearer key the fixture endpoint demands. Invented here; never an environment value. */
const ENDPOINT_KEY = 'fixture-endpoint-key';

/** A registry tool the agent MAY run (authMode auto). */
const PERMITTED_TOOL = 'fixture-owner-lookup';
/** A registry tool the agent may NOT run (authMode off) — the guarded refusal. */
const FORBIDDEN_TOOL = 'fixture-forbidden-lookup';

/** Per-call token report from the fixture endpoint, so a two-call turn sums to 200/40. */
const TURN_INPUT_TOKENS = 100;
const TURN_OUTPUT_TOKENS = 20;

/** What the endpoint asks for on its first reply of a turn. Set per scenario. */
let scriptedToolCall: { name: string; input: Record<string, unknown> } = {
  name: PERMITTED_TOOL,
  input: { sub: 'from-the-model' },
};

/** One recorded chat-completions request, as the endpoint received it off the wire. */
interface RecordedRequest {
  authorization: string | null;
  model: string;
  toolsOffered: string[];
  toolChoice: unknown;
  messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
}

const wireRequests: RecordedRequest[] = [];
/** Every tool invocation that actually reached the executor body, with its caller context. */
const executorCalls: Array<{ toolName: string; toolInput: Record<string, unknown>; userSub?: string; taskId?: string; agentId?: string }> = [];
/**
 * @description The tool-result strings (authorized result, or `[BLOCKED] …`) the loop fed back
 * onto the wire during one turn, read out of what the endpoint actually received.
 * @param fromIndex - Index into `wireRequests` at which the turn started.
 * @returns Every `role:'tool'` message content the endpoint saw from that point on.
 */
function toolResultsSince(fromIndex: number): string[] {
  return wireRequests
    .slice(fromIndex)
    .flatMap((req) => req.messages.filter((m) => m.role === 'tool').map((m) => String(m.content)));
}

let endpoint: Server;
let baseUrl: string;
let fixturePg: DisposablePostgres;
let owner: Pool;
let runtime: Pool;
let orchestrator: TaskOrchestrator;
let budgets: BudgetService;

/**
 * @description The OpenAI-compatible endpoint the caller owns, as a real local HTTP server.
 * It is the seam the shipped provider crosses with `fetch`, so a change that stops offering
 * tools on this lane is observable here and nowhere else: a request that carries no `tools`
 * array gets the tool-less answer a chat-only lane gives, not a tool call.
 * @returns A started server; `baseUrl` is set to its `/v1` root.
 */
async function startEndpoint(): Promise<Server> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const auth = req.headers.authorization ?? null;
      if (auth !== `Bearer ${ENDPOINT_KEY}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
        model?: string;
        messages?: Array<{ role: string; content: unknown; tool_call_id?: string }>;
        tools?: Array<{ function?: { name?: string } }>;
        tool_choice?: unknown;
      };
      const toolsOffered = (body.tools ?? []).map((t) => t.function?.name ?? '');
      const messages = body.messages ?? [];
      wireRequests.push({
        authorization: auth, model: body.model ?? '', toolsOffered, toolChoice: body.tool_choice, messages,
      });

      const answered = messages.filter((m) => m.role === 'tool');

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(replyFor(toolsOffered, answered)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return server;
}

/**
 * @description The endpoint's scripted answer. No tools offered means a chat-only lane, so it
 * answers in words; tools offered and nothing executed yet means a tool call; a tool result on
 * the wire means the final answer, which quotes that result so the guard can tell the loop
 * really carried it back.
 * @param toolsOffered - Tool names this request carried.
 * @param answered - `role:'tool'` messages already on the wire.
 * @returns An OpenAI chat-completions payload.
 */
function replyFor(
  toolsOffered: string[],
  answered: Array<{ content: unknown }>,
): Record<string, unknown> {
  const usage = { prompt_tokens: TURN_INPUT_TOKENS, completion_tokens: TURN_OUTPUT_TOKENS };
  const envelope = (message: Record<string, unknown>) => ({
    model: BYO_MODEL, usage, choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
  });
  if (toolsOffered.length === 0) {
    return envelope({ role: 'assistant', content: 'NO_TOOLS_OFFERED: this lane gave me no tools, so I can only talk.' });
  }
  if (answered.length === 0) {
    return envelope({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-1', type: 'function',
        function: { name: scriptedToolCall.name, arguments: JSON.stringify(scriptedToolCall.input) },
      }],
    });
  }
  return envelope({ role: 'assistant', content: `ANSWER: ${String(answered[answered.length - 1].content)}` });
}

/**
 * @description A registry row for the interceptor's injected lookup. The registry store is
 * outside the authorization boundary under guard; the decision made from this row is not.
 * @param name - Tool name the model calls.
 * @param authMode - The mode the registry reports for this agent/tool pair.
 * @returns A fully typed registry tool.
 */
function registryTool(name: string, authMode: AuthMode): Tool {
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    toolId: `tool-${name}`, name, displayName: name, type: ToolType.API, category: 'fixture', version: '1.0.0',
    installSpec: { method: InstallMethod.NONE }, skills: [], selectorFragment: '', routingTags: [],
    authGroup: 'fixture', defaultAuthMode: authMode, description: `${name} (fixture)`,
    inputSchema: { type: 'object', properties: { sub: { type: 'string' } } }, examples: [],
    requiresApproval: false, timeoutMs: 5_000, tags: [], enabled: true,
    registeredBy: 'fixture', registeredAt: now, createdAt: now, updatedAt: now,
  };
}

const REGISTRY: Record<string, AuthMode> = {
  [PERMITTED_TOOL]: AuthMode.AUTO,
  [FORBIDDEN_TOOL]: AuthMode.OFF,
};

const TOOL_DEFINITIONS: LLMToolDefinition[] = [PERMITTED_TOOL, FORBIDDEN_TOOL].map((name) => ({
  name,
  description: `${name} (fixture)`,
  input_schema: { type: 'object', properties: { sub: { type: 'string' } } },
}));

/** The REAL interceptor over a registry lookup double; approvals are never reached (auto/off only). */
function buildInterceptor(): ToolAuthInterceptor {
  return new ToolAuthInterceptor({
    approvalService: {
      requestApproval: async () => {
        throw new Error('fixture never uses ask mode');
      },
    } as never,
    lookupAuthMode: async (_agentId: string, toolName: string) => {
      const authMode = REGISTRY[toolName];
      return authMode ? { authMode, tool: registryTool(toolName, authMode) } : null;
    },
  });
}

/** The REAL orchestrator over the REAL ledger binding and the REAL interceptor. */
function buildOrchestrator(pool: Pool): TaskOrchestrator {
  const deps = {
    taskStore: createMemoryOnlyTaskStore(),
    messageStore: {
      save: async (input: Record<string, unknown>) => ({ ...input, messageId: 'm', createdAt: new Date().toISOString() }),
      getRecent: async () => [],
    },
    streamManager: {
      associateTaskWithSession: () => undefined,
      broadcastTaskUpdate: () => undefined,
      broadcastMessage: () => undefined,
      broadcastError: () => undefined,
    },
    getProvider: () => {
      throw new Error('fixture turns must run on the caller-resolved connection, not a registry provider');
    },
    getTools: async () => TOOL_DEFINITIONS,
    executeTool: async (toolName: string, toolInput: Record<string, unknown>, context?: { taskId?: string; agentId?: string; userSub?: string }) => {
      executorCalls.push({ toolName, toolInput, ...context });
      return `OWNER_ROWS=7 for ${context?.userSub ?? 'nobody'}`;
    },
    getSystemPrompt: async () => 'SYSTEM',
    toolAuthInterceptor: buildInterceptor(),
    costLedger: createInlineTurnCostLedger(pool),
  } as unknown as TaskOrchestratorDeps;
  return new TaskOrchestrator(deps);
}

/**
 * @description One agentic inline turn on a caller-resolved hosted connection, issued inside the
 * caller's request identity exactly as the chat entry points issue it.
 * @param sub - Authenticated caller.
 * @param taskId - Chat thread.
 * @param connection - The `{ baseUrl, apiKey, model }` the ADR-127 ladder resolved.
 * @returns The orchestrator's process result.
 */
function toolCapableTurn(
  sub: string,
  taskId: string,
  connection: { baseUrl: string; apiKey: string; model: string },
) {
  return runWithRequestIdentity({ sub, isOperator: false }, () =>
    orchestrator.processMessage(taskId, 'how many rows do I own?', {
      agenticMode: true, autoApprove: false, source: 'dashboard',
      agentId: BYO_BOT, userSub: sub, interactionMode: 'chat',
      byoLlmConnection: connection,
    } as never));
}

const asOwner = <T>(sub: string, fn: () => Promise<T>): Promise<T> =>
  runWithRequestIdentity({ sub, isOperator: false }, fn);

beforeAll(async () => {
  endpoint = await startEndpoint();
  fixturePg = new DisposablePostgres({
    purpose: 'byo-tool-capable-turn',
    migrations: ['078-cost-governance.sql', '090-cost-event-tokens-duration.sql', '112-owner-column-rls.sql'],
  });
  owner = await fixturePg.start();
  await owner.query(`CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${RUNTIME_PASS}' NOSUPERUSER NOBYPASSRLS`);
  await owner.query(`GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE}`);
  await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RUNTIME_ROLE}`);
  await owner.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RUNTIME_ROLE}`);
  const { host, port, database } = fixturePg.connection;
  runtime = wrapPoolWithGuc(new Pool({ host, port, database, user: RUNTIME_ROLE, password: RUNTIME_PASS, max: 4 }));
  orchestrator = buildOrchestrator(runtime);
  budgets = new BudgetService(runtime, { notify: async () => undefined });
}, 180_000);

afterAll(async () => {
  if (runtime) await runtime.end();
  if (fixturePg) await fixturePg.stop();
  if (endpoint) await new Promise<void>((resolve) => endpoint.close(() => resolve()));
}, 60_000);

describe('a BYO / free-tier connection runs a guarded tool turn on the inline lane (real HTTP endpoint, real interceptor, real Postgres)', () => {
  it('the fixture enforces: the endpoint refuses a keyless request, and the ledger refuses a forged owner (42501)', async () => {
    const keyless = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: BYO_MODEL }),
    });
    expect(keyless.status).toBe(401);

    const forced = await owner.query("SELECT relforcerowsecurity FROM pg_class WHERE relname = 'oshal_cost_events'");
    expect(forced.rows[0]?.relforcerowsecurity).toBe(true);
    await expect(asOwner(OTHER, () => runtime.query(
      "INSERT INTO oshal_cost_events (task_id, owner_sub, agent_id, provider_id, model_id, cost_usd) VALUES ('t-forged', $1, 'x', 'x', 'x', 1)",
      [OWNER],
    ))).rejects.toMatchObject({ code: '42501' });
  }, 30_000);

  it('a BYO turn offers tools on the wire, runs the authorized tool under the caller identity, and answers from its result', async () => {
    scriptedToolCall = { name: PERMITTED_TOOL, input: { sub: 'model-supplied' } };
    const result = await toolCapableTurn(OWNER, 'thread-byo-tool', { baseUrl, apiKey: ENDPOINT_KEY, model: BYO_MODEL });

    expect(result.success).toBe(true);
    expect(result.toolsUsed).toContain(PERMITTED_TOOL);
    // The final answer can only contain this string if the tool result travelled back to the endpoint.
    expect(result.response).toContain(`OWNER_ROWS=7 for ${OWNER}`);

    // Caller identity reached the tool body — the bot ran the tool AS the caller, not as the process.
    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0]).toMatchObject({
      toolName: PERMITTED_TOOL, userSub: OWNER, taskId: 'thread-byo-tool', agentId: BYO_BOT,
    });

    // Both wire calls really offered the tools, with the caller's key and model.
    expect(wireRequests).toHaveLength(2);
    for (const req of wireRequests) {
      expect(req.authorization).toBe(`Bearer ${ENDPOINT_KEY}`);
      expect(req.model).toBe(BYO_MODEL);
      expect(req.toolsOffered).toEqual([PERMITTED_TOOL, FORBIDDEN_TOOL]);
      expect(req.toolChoice).toBe('auto');
    }
    // The second call carried the assistant tool_calls turn AND the tool result, in wire order.
    expect(wireRequests[1].messages.map((m) => m.role)).toContain('tool');
  }, 60_000);

  it('the turn lands cost metadata on the ledger under the caller, labelled BYO, with both calls\' tokens', async () => {
    const rows = await owner.query(
      'SELECT task_id, owner_sub, agent_id, provider_id, model_id, cost_usd::float8 AS cost_usd, input_tokens, output_tokens, duration_ms FROM oshal_cost_events ORDER BY id',
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      task_id: 'thread-byo-tool',
      owner_sub: OWNER,
      agent_id: BYO_BOT,
      provider_id: `byo-hosted:${BYO_MODEL}`,
      model_id: BYO_MODEL,
      cost_usd: 0,
      input_tokens: String(TURN_INPUT_TOKENS * 2),
      output_tokens: String(TURN_OUTPUT_TOKENS * 2),
    });
    expect(rows.rows[0].duration_ms).not.toBeNull();
    expect(classifyCostUnit(rows.rows[0].provider_id as string)).toBe('byo');

    // The ledger row is the caller's: another owner's trailing window cannot see it.
    expect(await asOwner(OTHER, () => budgets.computeSpend('user', OWNER, 24))).toBe(0);
    const split = await asOwner(OWNER, () => budgets.computeSpendByUnit('user', OWNER, 24));
    expect(split).not.toBeNull();
    expect(split!.byo).toBe(0);
    expect(split!.billed).toBe(0);
  }, 30_000);

  it('a tool the registry turns off is refused at the authorization boundary and never reaches the tool body', async () => {
    const executorCallsBefore = executorCalls.length;
    const wireBefore = wireRequests.length;
    scriptedToolCall = { name: FORBIDDEN_TOOL, input: { sub: 'model-supplied' } };

    const result = await toolCapableTurn(OWNER, 'thread-byo-blocked', { baseUrl, apiKey: ENDPOINT_KEY, model: BYO_MODEL });

    expect(result.success).toBe(true);
    expect(executorCalls).toHaveLength(executorCallsBefore); // the tool body never ran
    const blocked = toolResultsSince(wireBefore);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toContain('[BLOCKED]');
    expect(result.response).toContain('[BLOCKED]');
  }, 60_000);

  it('a FREE-TIER resolved connection is the same tool-capable lane and books its own ledger row', async () => {
    scriptedToolCall = { name: PERMITTED_TOOL, input: { sub: 'model-supplied' } };
    // Exactly what resolveUserLlmConnection hands the execution path for a free-tier pick.
    const free: ResolvedUserLlmConnection = {
      baseUrl, apiKey: ENDPOINT_KEY, model: BYO_MODEL,
      resolutionSource: 'free-tier', connectionId: 'fixture-free-connection',
    };
    const executorCallsBefore = executorCalls.length;

    const result = await toolCapableTurn(OWNER, 'thread-free-tier', free);

    expect(result.success).toBe(true);
    expect(result.toolsUsed).toContain(PERMITTED_TOOL);
    expect(result.response).toContain(`OWNER_ROWS=7 for ${OWNER}`);
    expect(executorCalls).toHaveLength(executorCallsBefore + 1);
    expect(executorCalls[executorCalls.length - 1]).toMatchObject({ userSub: OWNER, agentId: BYO_BOT });

    const rows = await owner.query(
      "SELECT owner_sub, provider_id, input_tokens FROM oshal_cost_events WHERE task_id = 'thread-free-tier'",
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      owner_sub: OWNER, provider_id: `byo-hosted:${BYO_MODEL}`, input_tokens: String(TURN_INPUT_TOKENS * 2),
    });
  }, 60_000);
});
