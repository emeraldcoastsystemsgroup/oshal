/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the read-only question tools. Four failures it must catch: a new tool left UNBOUND in the persisted->runtime map (the state every one of rag-query/graph-query/conversation-query was in, which is why a granted bot was advertised nothing but attempt_completion); a tool reachable OUTSIDE the declared set or without its exact operation scope; a WRITE-capable path reachable through a read-only binding (rag-ingestion binding, rawQuery instead of readQuery, a modifying AQL, graph provisioning as a side effect of a read); and an identity-less dispatch executing at all. Crosses the boundary each claim lives on: the map is the real module, the advertise/authorize decision runs through the REAL any-bot ToolRegistry + captureDispatchCapabilities + authorizeCapability, and the handlers are the REAL registered ones invoked through executeSnapshot. Owner scoping over PostgreSQL is NOT claimed here - that boundary is a database and it is proven in bot-node-read-only-tools-owner-scope-postgres.spec.ts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Two cases from adversarial verification. (1) The graph read is bounded at the CURSOR, before materialization: a stubbed arangojs Database hands the REAL ArangoGraphAdapter a lazy cursor over a million rows, and the case asserts the bound rode into the query options, that no more rows than the bound were ever pulled, that all() was never called and that the over-bound cursor was killed. Slicing after all() - the shape that was shipped - goes red on the pull count. (2) The compose file carries RAG_ENGINE on the shared bot anchor, because rag_query refuses without the pgvector engine and the key sat on oshal-api alone, so the tool would have shipped inert on every bot.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The conversation query is metadata-only and the paired fetch is separately registered and scope-bound; the unit rail proves both exact capability names and the no-database refusal shape.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Database } from 'arangojs';
import yaml from 'js-yaml';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BOT_NODE_CONVERSATION_FETCH_TOOL,
  BOT_NODE_CONVERSATION_QUERY_TOOL,
  BOT_NODE_GRAPH_QUERY_TIMEOUT_MS,
  BOT_NODE_GRAPH_QUERY_TOOL,
  BOT_NODE_RAG_QUERY_TOOL,
  BOT_NODE_READ_ONLY_MAX_RESULTS,
  BOT_NODE_READ_ONLY_TOOL_NAMES,
  registerBotNodeReadOnlyTools,
  type BotNodeReadOnlyToolDeps,
  type ReadOnlyToolRegistration,
} from '@/app/bot-node-read-only-tools';
import { anyBotRuntimeToolFor, anyBotRuntimeToolScope } from '@/shared/llm-runtime';
import { GraphReadOnlyError } from '@/features/graph';
import { ArangoGraphAdapter } from '@/features/graph/services/arango-graph-adapter';

/* eslint-disable @typescript-eslint/no-require-imports */
const ToolRegistry = require('../../any-bot/server/services/ToolRegistry');
const {
  authorizeCapability,
  captureDispatchCapabilities,
  normalizeAuthorizedScopes,
} = require('../../any-bot/server/utils/dispatch-capabilities');
const { normalizeAllowedTools } = require('../../any-bot/server/utils/untrusted-content');
/* eslint-enable @typescript-eslint/no-require-imports */

const ROOT = join(__dirname, '..', '..');
const CALLER = 'auth0|read-only-caller';
/** The trusted context ToolRegistry mints — the ONLY place a handler learns who is asking. */
const OWNED = { extraEnv: { OSHAL_USER_SUB: CALLER } };

/** Records every graph call so a case can assert WHICH method a read reached for. */
function graphDouble(options: { exists?: boolean; modifying?: boolean } = {}) {
  const calls: string[] = [];
  const handle = {
    readQuery: vi.fn(async (query: string, bindVars: Record<string, unknown>) => {
      calls.push(`readQuery:${query}`);
      // The engine's own refusal shape: readQuery plans the query and throws before executing it.
      if (options.modifying) throw new GraphReadOnlyError('would write: nodes');
      return [{ echoed: query, bindVars }];
    }),
    rawQuery: vi.fn(async () => { calls.push('rawQuery'); return []; }),
  };
  return {
    calls,
    handle,
    connector: {
      personGraphExists: vi.fn(async (sub: string) => { calls.push(`exists:${sub}`); return options.exists !== false; }),
      getPersonGraph: vi.fn(async (sub: string) => { calls.push(`getPersonGraph:${sub}`); return handle; }),
    },
  };
}

/** Records RAG calls; `search`/`searchAllCollections` are the only read surface a tool may use. */
function ragDouble() {
  const calls: string[] = [];
  return {
    calls,
    service: {
      search: vi.fn(async (query: string, collection: string) => {
        calls.push(`search:${collection}`);
        return [{ id: 'c1', text: query, metadata: {}, score: 1, collection }];
      }),
      searchAllCollections: vi.fn(async (query: string) => {
        calls.push('searchAllCollections');
        return [{ id: 'c1', text: query, metadata: {}, score: 1, collection: 'all' }];
      }),
    },
  };
}

/**
 * A stubbed arangojs Database whose cursor is LAZY over `totalRows` rows and counts every row it
 * hands out. `all()` drains it (and says so); `batches.next()` hands out one batch of the
 * requested size; `kill()` records that the rest was abandoned. Nothing here talks to an engine -
 * the boundary under test is the adapter's cursor handling, which is the shipped code.
 */
function unboundedStubDb(totalRows: number) {
  const stats = { pulled: 0, drained: false, killed: false, queryOptions: undefined as unknown };
  function* rows(): Generator<{ i: number }> {
    for (let i = 0; i < totalRows; i += 1) yield { i };
  }
  const query = vi.fn(async (_q: string, _b: Record<string, unknown>, options?: { batchSize?: number }) => {
    stats.queryOptions = options;
    const source = rows();
    const batchSize = options?.batchSize ?? totalRows;
    let more = true;
    let served = false;
    const takeBatch = (): Array<{ i: number }> => {
      const batch: Array<{ i: number }> = [];
      while (batch.length < batchSize) {
        const next = source.next();
        if (next.done) { more = false; break; }
        batch.push(next.value);
        stats.pulled += 1;
      }
      return batch;
    };
    return {
      batches: {
        next: async () => { if (served && !more) return undefined; served = true; return takeBatch(); },
        get hasMore() { return more; },
      },
      all: async () => {
        stats.drained = true;
        const out: Array<{ i: number }> = [];
        for (const row of source) { out.push(row); stats.pulled += 1; }
        more = false;
        return out;
      },
      kill: async () => { stats.killed = true; more = false; },
    };
  });
  const explain = vi.fn(async () => ({ plan: { isModificationQuery: false, collections: [] } }));
  return { db: { explain, query } as unknown as Database, query, stats };
}

/** A registry carrying the real tools, plus the deps each case wants to observe. */
function registerOn(overrides: Partial<BotNodeReadOnlyToolDeps> = {}) {
  const registry = new ToolRegistry();
  const rag = ragDouble();
  const graph = graphDouble();
  registerBotNodeReadOnlyTools(registry as ReadOnlyToolRegistration, {
    pool: null,
    ragService: rag.service as unknown as BotNodeReadOnlyToolDeps['ragService'],
    graphConnector: graph.connector as unknown as BotNodeReadOnlyToolDeps['graphConnector'],
    ragOwnerScopingIsDatabaseEnforced: async () => true,
    ...overrides,
  });
  return { registry, rag, graph };
}

/** Run one tool the way a dispatch does: capture, authorize, then execute the captured snapshot. */
async function runThroughDispatch(
  registry: InstanceType<typeof ToolRegistry>,
  toolName: string,
  input: Record<string, unknown>,
  authority: { allowedTools: string[]; scopes: string[] },
  context: unknown = OWNED,
) {
  const caps = captureDispatchCapabilities(
    registry,
    normalizeAllowedTools(authority.allowedTools),
    normalizeAuthorizedScopes(authority.scopes),
  );
  const decision = authorizeCapability(caps, toolName);
  if (!decision.allowed) return { decision, caps, output: undefined };
  const output = await registry.executeSnapshot(decision.snapshot, input, context);
  return { decision, caps, output };
}

/** Full authority for one tool: in the declared set AND carrying its exact operation scope. */
function fullAuthority(toolName: string) {
  return { allowedTools: [toolName], scopes: [anyBotRuntimeToolScope(toolName)] };
}

describe('read-only question tools: the persisted names are BOUND', () => {
  it.each([
    ['rag-query', BOT_NODE_RAG_QUERY_TOOL],
    ['graph-query', BOT_NODE_GRAPH_QUERY_TOOL],
    ['conversation-query', BOT_NODE_CONVERSATION_QUERY_TOOL],
    ['conversation-fetch', BOT_NODE_CONVERSATION_FETCH_TOOL],
  ])('%s resolves to the runtime handler name %s', (persisted, runtime) => {
    // Unbound is the state these three were in: anyBotRuntimeToolFor returned undefined, the
    // prompt-authorization resolver logged "Unmapped runtime tool denied" and dropped it, and the
    // grant the operator set was silently worth nothing.
    expect(anyBotRuntimeToolFor(persisted), `${persisted} has no runtime binding`).toBe(runtime);
  });

  it('rag-ingestion — the WRITE sibling one word away from rag-query — has no binding', () => {
    expect(anyBotRuntimeToolFor('rag-ingestion')).toBeUndefined();
  });

  it('there is exactly ONE persisted-to-runtime binding table in the source tree', () => {
    // A second copy is how a reviewed security map drifts: the edit lands in the file that is
    // imported by nothing while the live one keeps the old set.
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && readFileSync(full, 'utf8').includes('PERSISTED_TO_RUNTIME_TOOL')) {
          hits.push(full);
        }
      }
    };
    walk(join(ROOT, 'src'));
    expect(hits.map((h) => h.replace(/\\/g, '/').replace(/^.*\/src\//, 'src/'))).toEqual([
      'src/shared/llm-runtime/any-bot-runtime-capabilities.ts',
    ]);
  });
});

describe('read-only question tools: registration is candidacy, never authority', () => {
  it('registers exactly the three read-only tools, none requiring approval', () => {
    const { registry } = registerOn();
    const registered = registry.getAll().map((tool: { name: string }) => tool.name);
    expect(registered).toEqual([...BOT_NODE_READ_ONLY_TOOL_NAMES]);
    for (const tool of registry.getAll() as Array<{ name: string; requiresApproval: boolean }>) {
      expect(tool.requiresApproval, `${tool.name} is advertised as a read; it must not need approval`).toBe(false);
    }
  });

  it.each([...BOT_NODE_READ_ONLY_TOOL_NAMES])(
    '%s is refused when it is GRANTED but carries no exact operation scope',
    async (toolName) => {
      const { registry } = registerOn();
      const { decision, caps } = await runThroughDispatch(registry, toolName, { query: 'x', aql: 'FOR n IN nodes RETURN n' },
        { allowedTools: [toolName], scopes: [] });
      expect(decision.allowed).toBe(false);
      expect(decision.error).toContain(`Missing exact operation scope: ${anyBotRuntimeToolScope(toolName)}`);
      // And it was never even advertised: an unscoped tool is not in the definitions the model sees.
      expect(caps.definitions.map((d: { name: string }) => d.name)).not.toContain(toolName);
    },
  );

  it.each([...BOT_NODE_READ_ONLY_TOOL_NAMES])(
    '%s is refused when it is SCOPED but outside the declared set',
    async (toolName) => {
      const { registry } = registerOn();
      const { decision } = await runThroughDispatch(registry, toolName, { query: 'x' },
        { allowedTools: ['attempt_completion'], scopes: [anyBotRuntimeToolScope(toolName)] });
      expect(decision.allowed).toBe(false);
      expect(decision.error).toContain('not authorized for this dispatch');
    },
  );

  it.each([...BOT_NODE_READ_ONLY_TOOL_NAMES])(
    '%s refuses a dispatch that carried no owner',
    async (toolName) => {
      const { registry } = registerOn();
      const input = toolName === BOT_NODE_CONVERSATION_FETCH_TOOL
        ? { taskId: 'task-without-owner' }
        : { query: 'x', aql: 'FOR n IN nodes RETURN n' };
      await expect(
        runThroughDispatch(registry, toolName, input,
          fullAuthority(toolName), { extraEnv: {} }),
      ).rejects.toThrow(/requires an authenticated caller/);
    },
  );
});

describe('read-only question tools: no write path is reachable', () => {
  it('graph_query reads through readQuery — never the trusted rawQuery escape hatch', async () => {
    const { registry, graph } = registerOn();
    const { output } = await runThroughDispatch(registry, BOT_NODE_GRAPH_QUERY_TOOL,
      { aql: 'FOR n IN nodes RETURN n' }, fullAuthority(BOT_NODE_GRAPH_QUERY_TOOL));
    expect((output as { rows: unknown[] }).rows).toHaveLength(1);
    expect(graph.handle.readQuery).toHaveBeenCalledTimes(1);
    expect(graph.handle.rawQuery, 'rawQuery is unplanned: it would run a REMOVE off a model turn').not.toHaveBeenCalled();
  });

  it('graph_query surfaces the engine refusal when the plan would modify data', async () => {
    const registry = new ToolRegistry();
    const graph = graphDouble({ modifying: true });
    registerBotNodeReadOnlyTools(registry as ReadOnlyToolRegistration, {
      pool: null,
      ragService: ragDouble().service as unknown as BotNodeReadOnlyToolDeps['ragService'],
      graphConnector: graph.connector as unknown as BotNodeReadOnlyToolDeps['graphConnector'],
      ragOwnerScopingIsDatabaseEnforced: async () => true,
    });
    await expect(
      runThroughDispatch(registry, BOT_NODE_GRAPH_QUERY_TOOL,
        { aql: 'FOR n IN nodes REMOVE n IN nodes' }, fullAuthority(BOT_NODE_GRAPH_QUERY_TOOL)),
    ).rejects.toThrow(/would write/);
  });

  it('graph_query does not PROVISION a graph for a caller who has none', async () => {
    const registry = new ToolRegistry();
    const graph = graphDouble({ exists: false });
    registerBotNodeReadOnlyTools(registry as ReadOnlyToolRegistration, {
      pool: null,
      ragService: ragDouble().service as unknown as BotNodeReadOnlyToolDeps['ragService'],
      graphConnector: graph.connector as unknown as BotNodeReadOnlyToolDeps['graphConnector'],
      ragOwnerScopingIsDatabaseEnforced: async () => true,
    });
    const { output } = await runThroughDispatch(registry, BOT_NODE_GRAPH_QUERY_TOOL,
      { aql: 'FOR n IN nodes RETURN n' }, fullAuthority(BOT_NODE_GRAPH_QUERY_TOOL));
    expect(output).toEqual({ rows: [], unavailable: 'no_graph_for_caller' });
    // getPersonGraph CREATES the database and its collections on first use. A tool advertised as
    // side-effect-free must not do that, so the probe is what a read is allowed to reach.
    expect(graph.connector.getPersonGraph).not.toHaveBeenCalled();
  });

  it('rag_query refuses outright when owner scoping is not enforced by the database', async () => {
    const { registry, rag } = registerOn({ ragOwnerScopingIsDatabaseEnforced: async () => false });
    await expect(
      runThroughDispatch(registry, BOT_NODE_RAG_QUERY_TOOL, { query: 'anything' },
        fullAuthority(BOT_NODE_RAG_QUERY_TOOL)),
    ).rejects.toThrow(/rag_chunks row-level security/);
    expect(rag.calls, 'a refusal must not still run the search').toEqual([]);
  });

  it('rag_query reads through search only, and passes the caller as the permission subject', async () => {
    const { registry, rag } = registerOn();
    await runThroughDispatch(registry, BOT_NODE_RAG_QUERY_TOOL, { query: 'runbook', collection: 'infra-runbooks' },
      fullAuthority(BOT_NODE_RAG_QUERY_TOOL));
    expect(rag.calls).toEqual(['search:infra-runbooks']);
    expect(rag.service.search).toHaveBeenCalledWith('runbook', 'infra-runbooks', 5,
      { userSub: CALLER, isOperator: false, allowPublic: true });
  });

  it('a database-less node reports conversation_query unavailable rather than answering unscoped', async () => {
    const { registry } = registerOn({ pool: null });
    const { output } = await runThroughDispatch(registry, BOT_NODE_CONVERSATION_QUERY_TOOL,
      { query: 'anything' }, fullAuthority(BOT_NODE_CONVERSATION_QUERY_TOOL));
    expect(output).toEqual({ conversations: [], unavailable: 'no_database' });
  });
});

describe('read-only question tools: the graph read is bounded BEFORE materialization', () => {
  it('a million-row result is never pulled past the bound, never drained, and the cursor is killed', async () => {
    // The shape that shipped: readQuery drained cursor.all() and the tool sliced afterwards, so the
    // whole result set was in process memory before the bound meant anything - and the registry's
    // Promise.race timeout rejects the caller without touching the running query. The REAL adapter
    // runs here over a stubbed Database whose cursor is lazy and counts what it hands out.
    const TOTAL_ROWS = 1_000_000;
    const stub = unboundedStubDb(TOTAL_ROWS);
    const registry = new ToolRegistry();
    registerBotNodeReadOnlyTools(registry as ReadOnlyToolRegistration, {
      pool: null,
      ragService: ragDouble().service as unknown as BotNodeReadOnlyToolDeps['ragService'],
      graphConnector: {
        personGraphExists: async () => true,
        getPersonGraph: async () => new ArangoGraphAdapter(stub.db),
      } as unknown as BotNodeReadOnlyToolDeps['graphConnector'],
      ragOwnerScopingIsDatabaseEnforced: async () => true,
    });

    const { output } = await runThroughDispatch(registry, BOT_NODE_GRAPH_QUERY_TOOL,
      { aql: 'FOR i IN 1..100000000 RETURN i' }, fullAuthority(BOT_NODE_GRAPH_QUERY_TOOL));

    expect((output as { rows: unknown[] }).rows).toHaveLength(BOT_NODE_READ_ONLY_MAX_RESULTS);
    // The bound rode INTO the query: one streaming batch of exactly the bound, and the engine's
    // own kill switch armed at the registry timeout.
    expect(stub.stats.queryOptions).toEqual({
      batchSize: BOT_NODE_READ_ONLY_MAX_RESULTS,
      stream: true,
      maxRuntime: BOT_NODE_GRAPH_QUERY_TIMEOUT_MS / 1000,
    });
    expect(stub.stats.pulled, 'rows fetched from the engine must never exceed the bound')
      .toBeLessThanOrEqual(BOT_NODE_READ_ONLY_MAX_RESULTS);
    expect(stub.stats.drained, 'all() materializes the whole result set before any slice can run').toBe(false);
    expect(stub.stats.killed, 'an over-bound cursor left alive keeps computing on the engine').toBe(true);
  });

  it('a result inside the bound is returned whole and nothing is killed', async () => {
    const stub = unboundedStubDb(3);
    const registry = new ToolRegistry();
    registerBotNodeReadOnlyTools(registry as ReadOnlyToolRegistration, {
      pool: null,
      ragService: ragDouble().service as unknown as BotNodeReadOnlyToolDeps['ragService'],
      graphConnector: {
        personGraphExists: async () => true,
        getPersonGraph: async () => new ArangoGraphAdapter(stub.db),
      } as unknown as BotNodeReadOnlyToolDeps['graphConnector'],
      ragOwnerScopingIsDatabaseEnforced: async () => true,
    });
    const { output } = await runThroughDispatch(registry, BOT_NODE_GRAPH_QUERY_TOOL,
      { aql: 'FOR n IN nodes RETURN n' }, fullAuthority(BOT_NODE_GRAPH_QUERY_TOOL));
    expect((output as { rows: unknown[] }).rows).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
    expect(stub.stats.killed).toBe(false);
  });
});

describe('read-only question tools: the deployment carries the engine the tool requires', () => {
  it('every bot-node service and the api resolve RAG_ENGINE=pgvector from the compose file', () => {
    // rag_query refuses outright without the pgvector engine. The key sat on oshal-api alone, so on
    // the deployed box every bot booted on the chroma default and the tool shipped inert.
    type Service = { environment?: Record<string, unknown> };
    const doc = yaml.load(readFileSync(join(ROOT, 'docker-compose.oshal-local.yml'), 'utf8')) as { services: Record<string, Service> };
    const bots = Object.entries(doc.services).filter(([, s]) => s.environment?.BOT_RUNTIME === 'bot-node');
    expect(bots.length, 'no bot-node services parsed - the file shape changed').toBeGreaterThanOrEqual(30);
    const missing = bots.filter(([, s]) => s.environment?.RAG_ENGINE !== 'pgvector').map(([name]) => name);
    expect(missing, 'a bot without the engine key boots on chroma and its rag_query refuses').toEqual([]);
    expect(doc.services['oshal-api'].environment?.RAG_ENGINE).toBe('pgvector');
  });
});
