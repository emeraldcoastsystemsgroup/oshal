/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added AgentMemoryService — per-agent ChromaDB memory (ported from the legacy AgentMemory)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

import { createChildLogger } from '@/shared/logger';
import type { RagService, RagSearchResult } from '@/features/rag';

const logger = createChildLogger({ module: 'agent-memory-service' });

/**
 * @description Collection naming convention for agent memory.
 * Each agent gets its own ChromaDB collection for isolated memory.
 */
const AGENT_MEMORY_PREFIX = 'agent-memory-';
const AGENT_KNOWLEDGE_PREFIX = 'agent-knowledge-';

/**
 * @description A memory entry stored in the agent's ChromaDB collection.
 */
export interface AgentMemoryEntry {
  id: string;
  text: string;
  metadata: Record<string, string>;
  score: number;
}

/**
 * @description Knowledge bootstrap source — a text document to load into the agent's knowledge.
 */
export interface KnowledgeSource {
  /** Title or label for the knowledge document */
  title: string;
  /** Raw text content to ingest */
  content: string;
  /** Source URL or identifier */
  source?: string;
  /** Domain category tag */
  category?: string;
}

/**
 * @description Result of a knowledge bootstrap operation.
 */
export interface BootstrapResult {
  collectionName: string;
  sourcesProcessed: number;
  totalChunks: number;
  errors: string[];
}

/**
 * @description Per-agent memory service backed by ChromaDB via the existing RagService.
 * Ported from the legacy implementation's AgentMemory.js — each agent gets its own collection
 * for storing domain knowledge, learned context, and bootstrapped documentation.
 *
 * Two collection types per agent:
 * - `agent-memory-{agentId}`: Runtime memories (remember/recall during execution)
 * - `agent-knowledge-{agentId}`: Bootstrapped domain knowledge (loaded at creation time)
 */
export class AgentMemoryService {
  private readonly ragService: RagService;
  private readonly initializedCollections: Set<string> = new Set();

  constructor(ragService: RagService) {
    this.ragService = ragService;
  }

  // ─── Per-Agent Memory (Runtime) ──────────────────────────────────────

  /**
   * @description Stores a memory for an agent. Used during execution to persist
   * learnings, context, and insights that the agent discovers while working.
   * @param agentId - Agent identifier
   * @param text - Memory content to store
   * @param metadata - Optional metadata (category, source, ticket, etc.)
   */
  async remember(
    agentId: string,
    text: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    const collection = this.memoryCollectionName(agentId);
    await this.ensureInitialized(collection);

    await this.ragService.ingest(
      [text],
      collection,
      {
        agentId,
        type: 'memory',
        timestamp: new Date().toISOString(),
        ...metadata,
      },
    );

    logger.info({ agentId, collection, textLength: text.length }, 'Memory stored');
  }

  /**
   * @description Stores multiple memories at once for efficiency.
   * @param agentId - Agent identifier
   * @param items - Array of { text, metadata } entries
   */
  async rememberBatch(
    agentId: string,
    items: Array<{ text: string; metadata?: Record<string, string> }>,
  ): Promise<void> {
    if (items.length === 0) return;

    const collection = this.memoryCollectionName(agentId);
    await this.ensureInitialized(collection);

    // Ingest all texts with merged metadata
    await this.ragService.ingest(
      items.map((i) => i.text),
      collection,
      { agentId, type: 'memory', timestamp: new Date().toISOString() },
    );

    logger.info({ agentId, count: items.length }, 'Batch memories stored');
  }

  /**
   * @description Recalls memories relevant to a query via semantic search.
   * @param agentId - Agent identifier
   * @param query - Search query
   * @param limit - Max results (default 5)
   * @returns Ranked memory entries
   */
  async recall(
    agentId: string,
    query: string,
    limit = 5,
  ): Promise<AgentMemoryEntry[]> {
    const collection = this.memoryCollectionName(agentId);

    const results = await this.ragService.search(query, collection, limit);

    logger.info({ agentId, query, resultCount: results.length }, 'Memory recall');
    return results.map(mapSearchResult);
  }

  // ─── Per-Agent Knowledge (Bootstrap) ─────────────────────────────────

  /**
   * @description Bootstraps domain knowledge for a newly created agent.
   * Loads documents into the agent's knowledge collection for RAG retrieval
   * during task execution.
   * @param agentId - Agent identifier
   * @param sources - Array of knowledge documents to ingest
   * @returns Bootstrap result with counts and errors
   */
  async bootstrapKnowledge(
    agentId: string,
    sources: KnowledgeSource[],
  ): Promise<BootstrapResult> {
    const collection = this.knowledgeCollectionName(agentId);
    await this.ensureInitialized(collection);

    const result: BootstrapResult = {
      collectionName: collection,
      sourcesProcessed: 0,
      totalChunks: 0,
      errors: [],
    };

    for (const source of sources) {
      try {
        const ingestResult = await this.ragService.ingest(
          [source.content],
          collection,
          {
            agentId,
            type: 'knowledge',
            title: source.title,
            source: source.source || 'bootstrap',
            category: source.category || 'general',
            bootstrappedAt: new Date().toISOString(),
          },
        );
        result.sourcesProcessed++;
        result.totalChunks += ingestResult.chunkCount;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        result.errors.push(`Failed to ingest "${source.title}": ${msg}`);
        logger.warn({ err, agentId, title: source.title }, 'Knowledge bootstrap source failed');
      }
    }

    logger.info(
      { agentId, collection, sourcesProcessed: result.sourcesProcessed, totalChunks: result.totalChunks },
      'Knowledge bootstrap complete',
    );
    return result;
  }

  /**
   * @description Queries an agent's knowledge collection for domain-specific information.
   * @param agentId - Agent identifier
   * @param query - Search query
   * @param limit - Max results (default 5)
   * @returns Ranked knowledge entries
   */
  async queryKnowledge(
    agentId: string,
    query: string,
    limit = 5,
  ): Promise<AgentMemoryEntry[]> {
    const collection = this.knowledgeCollectionName(agentId);
    const results = await this.ragService.search(query, collection, limit);
    logger.info({ agentId, query, resultCount: results.length }, 'Knowledge query');
    return results.map(mapSearchResult);
  }

  /**
   * @description Queries BOTH memory and knowledge collections for an agent,
   * merges and ranks the results. Useful for comprehensive context retrieval.
   * @param agentId - Agent identifier
   * @param query - Search query
   * @param limit - Max combined results (default 5)
   * @returns Merged and ranked entries from both collections
   */
  async recallAll(
    agentId: string,
    query: string,
    limit = 5,
  ): Promise<AgentMemoryEntry[]> {
    const [memories, knowledge] = await Promise.all([
      this.recall(agentId, query, limit),
      this.queryKnowledge(agentId, query, limit),
    ]);

    const merged = [...memories, ...knowledge]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return merged;
  }

  // ─── Collection Utilities ────────────────────────────────────────────

  /**
   * @description Gets collection names for a given agent.
   * @param agentId - Agent identifier
   * @returns Object with memory and knowledge collection names
   */
  getCollectionNames(agentId: string): { memory: string; knowledge: string } {
    return {
      memory: this.memoryCollectionName(agentId),
      knowledge: this.knowledgeCollectionName(agentId),
    };
  }

  private memoryCollectionName(agentId: string): string {
    return `${AGENT_MEMORY_PREFIX}${agentId}`;
  }

  private knowledgeCollectionName(agentId: string): string {
    return `${AGENT_KNOWLEDGE_PREFIX}${agentId}`;
  }

  private async ensureInitialized(collection: string): Promise<void> {
    if (this.initializedCollections.has(collection)) return;
    await this.ragService.ensureCollection(collection);
    this.initializedCollections.add(collection);
  }
}

/**
 * @description Maps a RagSearchResult to an AgentMemoryEntry.
 */
function mapSearchResult(r: RagSearchResult): AgentMemoryEntry {
  return { id: r.id, text: r.text, metadata: r.metadata, score: r.score };
}
