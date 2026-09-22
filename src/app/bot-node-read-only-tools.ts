/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the read-only question tools a bot node may answer with. Until now the bot-node built `new ToolRegistry()` and registered NOTHING into it (registerFileTools/registerCLITools run only from any-bot/server/app.js, which BOT_RUNTIME=bot-node never boots), so captureDispatchCapabilities advertised attempt_completion and nothing else no matter what a bot was granted. These three handlers are the first real capabilities on that registry, and they are deliberately the ones that let a bot ANSWER rather than act: retrieval, the caller's own graph, and the caller's own conversation history. No shell, no file write, no cloud CLI, no ingestion. Owner scoping is never a WHERE clause this module writes — RAG and conversation reads run inside runWithRequestIdentity so the GUC pool stamps the caller and PostgreSQL row-level security refuses another owner's rows, and the graph is resolved by personDbName(sub) into a physically separate ArangoDB database.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Adversarial verification of the first cut. (1) graph_query materialized the ENTIRE result before bounding it - readQuery drained cursor.all() and the slice ran afterwards, so a model-authored `FOR i IN 1..100000000 RETURN i` was an unbounded allocation in the bot-node process and the registry's Promise.race timeout rejected the caller without touching the running query; the read now passes maxRows and maxRuntimeSeconds, enforced at the cursor and by the engine respectively, before any row exists in memory. (2) The comments overstated the scoping as one layer: ChatSearchSource carries its own owner_sub predicate and RagService its own permission filter, so it is defense in depth - the database boundary AND the adapter predicate - and the comments now say so.
 */

/**
 * The bot-node's read-only question tools.
 *
 * Registered into the any-bot `ToolRegistry` that `bot-node-runtime` hands to AgenticController and
 * TaskController, which is the ONLY registry a bot-node dispatch captures from. Nothing here widens
 * the SEC-05 boundary: a tool becomes a candidate by being registered, and authority still comes
 * from declared set ∩ allowlist ∩ exact `tool:<name>` scope, resolved by
 * `captureDispatchCapabilities` / `authorizeCapability` before `dispatch-tool-executor` reaches a
 * handler. Registration is necessary, never sufficient.
 *
 * Owner scoping is defense in depth, and this module writes neither layer. The services it calls
 * carry their own owner predicate (ChatSearchSource's `owner_sub = $1`, RagService's permission
 * filter); independently, every read runs inside runWithRequestIdentity so the GUC pool stamps the
 * caller onto the CONNECTION and PostgreSQL row-level security refuses another owner's rows even if
 * an adapter predicate were dropped. The graph is the third shape: personDbName(sub) resolves to a
 * physically separate database, so there is no predicate to forget.
 *
 * Every handler fails closed with no caller subject: an unattended turn with no owner is exactly
 * the content-driven case the bot-node refusals exist for, and a read with no owner would be read
 * as anonymous by the GUC pool anyway (OSHAL_DB_GUC_STRICT=deny) — refusing by name is clearer than
 * silently returning nothing.
 *
 * @module app/bot-node-read-only-tools
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { ChatSearchSource } from '@/features/global-search';
import { pgvectorRagEngine, type RagService } from '@/features/rag';
import type { GraphConnector } from '@/features/graph';

const logger = createChildLogger({ module: 'bot-node-read-only-tools' });

/** Exact any-bot runtime names these handlers register under. */
export const BOT_NODE_RAG_QUERY_TOOL = 'rag_query';
/** Exact any-bot runtime name for the caller's own graph read. */
export const BOT_NODE_GRAPH_QUERY_TOOL = 'graph_query';
/** Exact any-bot runtime name for the caller's own conversation read. */
export const BOT_NODE_CONVERSATION_QUERY_TOOL = 'conversation_query';

/** Every read-only question tool this module registers, in registration order. */
export const BOT_NODE_READ_ONLY_TOOL_NAMES: readonly string[] = Object.freeze([
  BOT_NODE_RAG_QUERY_TOOL,
  BOT_NODE_GRAPH_QUERY_TOOL,
  BOT_NODE_CONVERSATION_QUERY_TOOL,
]);

/**
 * Upper bound on rows/hits any one read returns, so a tool result cannot flood a prompt. For the
 * graph it is also the CURSOR bound: no more rows than this are ever fetched from the engine.
 */
export const BOT_NODE_READ_ONLY_MAX_RESULTS = 25;
const MAX_RESULTS = BOT_NODE_READ_ONLY_MAX_RESULTS;
/** Registry timeout for the graph read, and the engine-side maxRuntime derived from it. */
export const BOT_NODE_GRAPH_QUERY_TIMEOUT_MS = 30_000;
/** Default when the model asks for no bound. */
const DEFAULT_RESULTS = 5;
/** Longest caller-supplied text this module forwards to a service. */
const MAX_TEXT_CHARS = 4_000;

/**
 * The slice of the any-bot ToolRegistry this module needs. Typed structurally rather than imported:
 * the registry is CommonJS JavaScript, and a structural type keeps the FSD import direction clean
 * while still failing to compile if the register() contract changes shape.
 */
export interface ReadOnlyToolRegistration {
  register(definition: {
    name: string;
    description: string;
    category: string;
    inputSchema: Record<string, unknown>;
    handler: (input: Record<string, unknown>, context: unknown) => Promise<unknown>;
    requiresApproval: boolean;
    timeout: number;
  }): void;
}

/** Everything the three handlers read through. Each may be absent; the matching tool then refuses. */
export interface BotNodeReadOnlyToolDeps {
  /** The bot-node's GUC-wrapped Postgres pool, or null on a database-less node. */
  pool: Pool | null;
  /** The bot-node's RagService instance. */
  ragService: Pick<RagService, 'search' | 'searchAllCollections'>;
  /** The graph connector, or null when this deployment has no graph engine (ARANGO_URL unset). */
  graphConnector: Pick<GraphConnector, 'getPersonGraph' | 'personGraphExists'> | null;
  /**
   * Whether RAG owner scoping is enforced by the DATABASE for this process. Injectable so a guard
   * can establish both dispositions; defaults to the real pgvector engine probe.
   */
  ragOwnerScopingIsDatabaseEnforced?: () => Promise<boolean>;
}

/** The trusted execution context ToolRegistry mints; only the exact caller subject reaches a tool. */
interface ToolExecutionContext {
  extraEnv?: { OSHAL_USER_SUB?: string };
}

/**
 * @description The exact caller subject for this tool run, or a refusal.
 * @param context - Trusted execution context minted by ToolRegistry.
 * @param toolName - Runtime tool name, named in the refusal.
 * @returns The caller's exact OIDC sub.
 * @throws Error when the dispatch carried no owner.
 */
function requireCallerSub(context: unknown, toolName: string): string {
  const sub = (context as ToolExecutionContext | undefined)?.extraEnv?.OSHAL_USER_SUB;
  if (typeof sub !== 'string' || sub.trim().length === 0) {
    throw new Error(`${toolName} requires an authenticated caller; this dispatch carried no owner.`);
  }
  return sub;
}

/**
 * @description Bounded required text from model-supplied input.
 * @param value - Raw model-supplied value.
 * @param field - Field name, named in the refusal.
 * @returns Trimmed, length-capped text.
 * @throws Error when the field is absent or blank.
 */
function requireText(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`Field '${field}' is required and must be a non-empty string.`);
  return text.slice(0, MAX_TEXT_CHARS);
}

/**
 * @description Clamp a model-supplied result count into the bounded window.
 * @param value - Raw model-supplied value.
 * @returns A count between 1 and MAX_RESULTS.
 */
function boundedCount(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RESULTS;
  return Math.min(parsed, MAX_RESULTS);
}

/** Optional plain-object bind variables; anything else is dropped rather than forwarded. */
function optionalBindVars(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * @description Whether `rag_chunks` row-level security is what scopes this process's RAG reads.
 * True only on the pgvector engine: the Chroma path has no database boundary at all, so the only
 * thing standing between one caller and another's private chunks there would be an application
 * filter — the exact shape this tool must not rely on.
 * @returns True when RAG reads are refused by PostgreSQL rather than by application code.
 */
async function pgvectorOwnerScopingActive(): Promise<boolean> {
  if ((process.env.RAG_ENGINE || '').trim().toLowerCase() !== 'pgvector') return false;
  return pgvectorRagEngine.isAvailable();
}

/**
 * @description Register the read-only question tools on a bot-node's any-bot ToolRegistry.
 *
 * All three are `requiresApproval: false` because all three are genuinely side-effect-free reads:
 * `RagService.search` only reads, `GraphHandle.readQuery` asks ArangoDB to plan the query and
 * refuses a modifying plan before executing it, and the conversation read is a SELECT this module
 * never composes itself. `rag-ingestion` is deliberately NOT here — ingestion writes.
 * @param registry - The any-bot ToolRegistry this bot-node dispatches from.
 * @param deps - Pool, RagService and graph connector this node was constructed with.
 * @returns The runtime names actually registered.
 */
export function registerBotNodeReadOnlyTools(
  registry: ReadOnlyToolRegistration,
  deps: BotNodeReadOnlyToolDeps,
): readonly string[] {
  const ragScopedByDatabase = deps.ragOwnerScopingIsDatabaseEnforced ?? pgvectorOwnerScopingActive;

  registry.register({
    name: BOT_NODE_RAG_QUERY_TOOL,
    description:
      'Search the retrieval corpus the caller is allowed to read and return matching passages with '
      + 'their metadata, so an answer can cite real corpus content instead of inventing it. '
      + 'Read-only. Omit `collection` to search every collection.',
    category: 'knowledge',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'What to look for, in plain language.' },
        collection: { type: 'string', description: 'Optional single collection to search.' },
        topK: { type: 'integer', description: `Maximum passages to return (1-${MAX_RESULTS}).` },
      },
    },
    requiresApproval: false,
    timeout: 60_000,
    handler: async (input, context) => {
      const sub = requireCallerSub(context, BOT_NODE_RAG_QUERY_TOOL);
      if (!(await ragScopedByDatabase())) {
        throw new Error(
          'rag_query is unavailable on this node: owner scoping for retrieval is enforced by '
          + 'rag_chunks row-level security, which only the pgvector engine reaches. Set '
          + 'RAG_ENGINE=pgvector for this runtime, or answer without retrieval.',
        );
      }
      const query = requireText(input.query, 'query');
      const topK = boundedCount(input.topK);
      const collection = typeof input.collection === 'string' ? input.collection.trim() : '';
      // Two layers. The caller identity rides the CONNECTION: the pgvector engine's pool is
      // GUC-wrapped, rag_chunks is FORCE ROW LEVEL SECURITY, and its policy compares owner_sub to
      // oshal.current_sub - that is the layer that holds even if the application filter were
      // dropped. The permission context below is the second: RagService's own filter, which also
      // narrows on source ACLs Postgres cannot see. Neither is written here.
      return runWithRequestIdentity({ sub, isOperator: false }, async () => {
        const permission = { userSub: sub, isOperator: false, allowPublic: true };
        const results = collection
          ? await deps.ragService.search(query, collection, topK, permission)
          : await deps.ragService.searchAllCollections(query, topK, permission);
        logger.info(
          { tool: BOT_NODE_RAG_QUERY_TOOL, collection: collection || 'all', resultCount: results.length },
          'read-only tool completed',
        );
        return {
          results: results.slice(0, topK).map((hit) => ({
            id: hit.id,
            collection: hit.collection,
            text: hit.text,
            score: hit.score,
            metadata: hit.metadata,
          })),
        };
      });
    },
  });

  registry.register({
    name: BOT_NODE_GRAPH_QUERY_TOOL,
    description:
      "Run one read-only AQL query against the caller's OWN graph (ArangoDB; AQL, never Cypher or "
      + 'Gremlin). The collections are literally `nodes` and `edges`; filter on the `id` field, '
      + 'never `_key`. A data-modifying query is refused. An absent graph is a supported state to '
      + 'report once, not an error to retry.',
    category: 'knowledge',
    inputSchema: {
      type: 'object',
      required: ['aql'],
      properties: {
        aql: { type: 'string', description: 'AQL read query over `nodes` / `edges`.' },
        bindVars: { type: 'object', description: 'AQL bind variables.' },
      },
    },
    requiresApproval: false,
    timeout: BOT_NODE_GRAPH_QUERY_TIMEOUT_MS,
    handler: async (input, context) => {
      const sub = requireCallerSub(context, BOT_NODE_GRAPH_QUERY_TOOL);
      const connector = deps.graphConnector;
      if (!connector) {
        return { rows: [], unavailable: 'no_graph_engine' };
      }
      const aql = requireText(input.aql, 'aql');
      // personGraphExists is a pure probe. getPersonGraph PROVISIONS on first use (creates the
      // database and its collections), and a tool advertised as side-effect-free must not create
      // anything — so a caller with no graph yet is answered, not provisioned.
      if (!(await connector.personGraphExists(sub))) {
        return { rows: [], unavailable: 'no_graph_for_caller' };
      }
      // The ONLY input to the database name is the caller's own sub (personDbName). There is no
      // predicate to forget here: another person's graph is a different physical database.
      const handle = await connector.getPersonGraph(sub);
      // readQuery, never rawQuery: readQuery asks ArangoDB to plan the query and refuses when the
      // plan reports isModificationQuery. rawQuery is the trusted in-process escape hatch and must
      // never be handed a string that came off a model turn.
      // The bounds ride INTO the read. maxRows is the streaming cursor's batch size, so the engine
      // computes one batch and the adapter never fetches a row past it; maxRuntime is the engine's
      // own kill switch. Slicing here after an unbounded read would already be too late - the
      // registry's timeout is a Promise.race that rejects the caller and leaves the query running.
      const rows = await handle.readQuery(aql, optionalBindVars(input.bindVars), {
        maxRows: MAX_RESULTS,
        maxRuntimeSeconds: BOT_NODE_GRAPH_QUERY_TIMEOUT_MS / 1000,
      });
      logger.info({ tool: BOT_NODE_GRAPH_QUERY_TOOL, rowCount: rows.length }, 'read-only tool completed');
      return { rows };
    },
  });

  registry.register({
    name: BOT_NODE_CONVERSATION_QUERY_TOOL,
    description:
      "Search the caller's OWN past conversations with this swarm and return the matching "
      + 'conversations with a snippet and a link, so a question about what was already said or '
      + 'decided can be answered from the record. Read-only.',
    category: 'knowledge',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Words to look for in past conversations.' },
        limit: { type: 'integer', description: `Maximum conversations to return (1-${MAX_RESULTS}).` },
      },
    },
    requiresApproval: false,
    timeout: 30_000,
    handler: async (input, context) => {
      const sub = requireCallerSub(context, BOT_NODE_CONVERSATION_QUERY_TOOL);
      const pool = deps.pool;
      if (!pool) {
        return { conversations: [], unavailable: 'no_database' };
      }
      const query = requireText(input.query, 'query');
      const limit = boundedCount(input.limit);
      // Two layers, same as RAG. ChatSearchSource carries its own `owner_sub = $1` predicate, and
      // independently the identity rides the connection: chat_tasks is FORCE ROW LEVEL SECURITY on
      // owner_sub and chat_messages is walled by oshal_owns_task(task_id), so a conversation this
      // caller does not own is refused by PostgreSQL even if the adapter predicate were dropped.
      // The owner-scope guard proves the database layer on its own by handing the adapter one
      // identity while the connection carries another.
      return runWithRequestIdentity({ sub, isOperator: false }, async () => {
        const hits = await new ChatSearchSource(pool).search(sub, query, limit);
        logger.info(
          { tool: BOT_NODE_CONVERSATION_QUERY_TOOL, resultCount: hits.length },
          'read-only tool completed',
        );
        return {
          conversations: hits.map((hit) => ({
            taskId: hit.id,
            title: hit.title,
            snippet: hit.snippet,
            updatedAt: hit.ts,
            url: hit.url,
          })),
        };
      });
    },
  });

  logger.info({ tools: BOT_NODE_READ_ONLY_TOOL_NAMES }, 'Bot-node read-only question tools registered');
  return BOT_NODE_READ_ONLY_TOOL_NAMES;
}
