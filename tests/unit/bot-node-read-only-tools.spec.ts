/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the read-only question tools. Four failures it must catch: a new tool left UNBOUND in the persisted->runtime map (the state every one of rag-query/graph-query/conversation-query was in, which is why a granted bot was advertised nothing but attempt_completion); a tool reachable OUTSIDE the declared set or without its exact operation scope; a WRITE-capable path reachable through a read-only binding (rag-ingestion binding, rawQuery instead of readQuery, a modifying AQL, graph provisioning as a side effect of a read); and an identity-less dispatch executing at all. Crosses the boundary each claim lives on: the map is the real module, the advertise/authorize decision runs through the REAL any-bot ToolRegistry + captureDispatchCapabilities + authorizeCapability, and the handlers are the REAL registered ones invoked through executeSnapshot. Owner scoping over PostgreSQL is NOT claimed here - that boundary is a database and it is proven in bot-node-read-only-tools-owner-scope-postgres.spec.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  BOT_NODE_CONVERSATION_QUERY_TOOL,
  BOT_NODE_GRAPH_QUERY_TOOL,
  BOT_NODE_RAG_QUERY_TOOL,
  BOT_NODE_READ_ONLY_TOOL_NAMES,
  registerBotNodeReadOnlyTools,
  type BotNodeReadOnlyToolDeps,
  type ReadOnlyToolRegistration,
} from '@/app/bot-node-read-only-tools';
import { anyBotRuntimeToolFor, anyBotRuntimeToolScope } from '@/shared/llm-runtime';
import { GraphReadOnlyError } from '@/features/graph';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports */
const ToolRegistry = require('../../any-bot/server/services/ToolRegistry');
const {
  authorizeCapability,
  captureDispatchCapabilities,
  normalizeAuthorizedScopes,
} = require('../../any-bot/server/utils/dispatch-capabilities');
const { normalizeAllowedTools } = require('../../any-bot/server/utils/untrusted-content');
/* eslint-enable @typescript-eslint/no-require-imports */

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
    walk(join(__dirname, '..', '..', 'src'));
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
      await expect(
        runThroughDispatch(registry, toolName, { query: 'x', aql: 'FOR n IN nodes RETURN n' },
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
