/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added SwarmMemoryService — shared cross-agent organizational memory (ported from the legacy SwarmMemoryService)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Session 140: Added default community RAG namespaces (tickets, messages, knowledge) for swarm bot intrinsic awareness
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

import { createChildLogger } from '@/shared/logger';
import type { RagService, RagSearchResult } from '@/features/rag';

const logger = createChildLogger({ module: 'swarm-memory-service' });

/**
 * @description Shared swarm memory collection name.
 * All agents read from and write to this single collection.
 */
const SWARM_MEMORY_COLLECTION = 'swarm-memory';

/**
 * @description Default community RAG namespaces that all swarm bots intrinsically know about.
 * These are pre-defined collections that provide shared context across the swarm:
 *
 * - `swarm-tickets`   — Ticket context and history. Ingested when tickets are created/completed.
 *                        Bots query this to understand past work, avoid duplicates, and learn from outcomes.
 *
 * - `swarm-messages`  — Conversation and execution messages. Ingested from agent execution outputs.
 *                        Bots query this for contextual continuity across sessions.
 *
 * - `swarm-knowledge` — Shared organizational knowledge. Manually or automatically curated.
 *                        Contains architectural decisions, best practices, domain rules, and
 *                        team conventions that bots should follow.
 *
 * Usage: Bots can ingest into and query from any of these collections via RagService.
 * The SwarmMemoryService pre-ensures these collections exist at startup.
 */
export const SWARM_RAG_NAMESPACES = {
  /** @description Ticket context and history — past work, outcomes, and patterns */
  tickets: 'swarm-tickets',
  /** @description Conversation and execution messages — contextual continuity */
  messages: 'swarm-messages',
  /** @description Shared organizational knowledge — ADRs, best practices, conventions */
  knowledge: 'swarm-knowledge',
  /** @description Legacy learning collection (still active for backward compat) */
  memory: SWARM_MEMORY_COLLECTION,
} as const;

/** @description All default namespace names for iteration */
export const SWARM_RAG_NAMESPACE_LIST = Object.values(SWARM_RAG_NAMESPACES);

/**
 * @description A learning extracted from a completed work item.
 */
export interface SwarmLearning {
  /** What worked well during execution */
  whatWorked: string[];
  /** Challenges encountered */
  challenges: string[];
  /** Key takeaways for future similar tasks */
  keyLearnings: string[];
}

/**
 * @description Context for a completed work item whose learnings should be stored.
 */
export interface CompletedWorkContext {
  /** Work item or ticket identifier */
  workItemId: string;
  /** Title or summary of the work */
  title: string;
  /** Agent that executed the work */
  agentId: string;
  /** Agent's execution output (raw text) */
  executionOutput: string;
  /** Optional complexity rating */
  complexity?: string;
  /** Whether the work had verification failures */
  hadVerificationFailures?: boolean;
  /** Whether the work was escalated */
  hadEscalations?: boolean;
  /** Domain/capability tags */
  categories?: string[];
}

/**
 * @description A relevant past experience retrieved from swarm memory.
 */
export interface SwarmMemoryEntry {
  id: string;
  text: string;
  metadata: Record<string, string>;
  score: number;
}

/**
 * @description Formatted context block for injection into agent prompts.
 */
export interface SwarmContextBlock {
  /** Number of relevant memories found */
  memoryCount: number;
  /** Formatted markdown block to inject into the system/user prompt */
  promptBlock: string;
  /** Whether the context block contains meaningful content */
  hasContent: boolean;
}

/**
 * @description Shared swarm memory service — the "circle of life" pattern from the legacy implementation.
 * Extracts key learnings from completed work items and stores them in a shared
 * ChromaDB collection. When new work is dispatched, queries for relevant past
 * experiences and formats them as injectable prompt context.
 *
 * This closes the feedback loop: completed work feeds future work.
 *
 * Flow:
 * 1. Work item completes → extractAndStore() parses learnings → stored in `swarm-memory`
 * 2. New work item arrives → queryRelevantContext() finds similar past work → context injected into agent prompt
 */
export class SwarmMemoryService {
  private readonly ragService: RagService;
  private initialized = false;
  private readonly storedWorkItems: Set<string> = new Set();

  constructor(ragService: RagService) {
    this.ragService = ragService;
  }

  // ─── Store Learnings ─────────────────────────────────────────────────

  /**
   * @description Extracts learnings from a completed work item and stores them
   * in the shared swarm memory collection. Idempotent — skips if already stored.
   * @param context - Completed work context with execution output
   * @returns True if stored, false if skipped (duplicate or error)
   */
  async extractAndStore(context: CompletedWorkContext): Promise<boolean> {
    // Idempotency: skip if already stored
    if (this.storedWorkItems.has(context.workItemId)) {
      logger.info({ workItemId: context.workItemId }, 'Swarm memory already stored — skipping');
      return false;
    }

    try {
      await this.ensureInitialized();

      const learning = this.extractLearning(context.executionOutput);
      const document = this.formatLearningDocument(context, learning);

      await this.ragService.ingest(
        [document],
        SWARM_MEMORY_COLLECTION,
        {
          workItemId: context.workItemId,
          title: context.title,
          agentId: context.agentId,
          complexity: context.complexity || 'unknown',
          hadVerificationFailures: String(context.hadVerificationFailures || false),
          hadEscalations: String(context.hadEscalations || false),
          categories: (context.categories || []).join(','),
          timestamp: new Date().toISOString(),
          type: 'swarm-learning',
        },
      );

      this.storedWorkItems.add(context.workItemId);
      logger.info(
        { workItemId: context.workItemId, agentId: context.agentId },
        'Swarm learning stored',
      );
      return true;
    } catch (err) {
      logger.error({ err, workItemId: context.workItemId }, 'Failed to store swarm learning');
      return false;
    }
  }

  // ─── Query Past Experiences ──────────────────────────────────────────

  /**
   * @description Queries swarm memory for past experiences relevant to a new work item.
   * Returns raw search results for programmatic use.
   * @param query - Search query (typically the ticket title + description)
   * @param limit - Max results (default 3)
   * @returns Ranked past experiences
   */
  async queryRelevant(query: string, limit = 3): Promise<SwarmMemoryEntry[]> {
    try {
      const results = await this.ragService.search(query, SWARM_MEMORY_COLLECTION, limit);
      logger.info({ query, resultCount: results.length }, 'Swarm memory query');
      return results.map(mapSearchResult);
    } catch (err) {
      logger.warn({ err, query }, 'Swarm memory query failed — continuing without context');
      return [];
    }
  }

  /**
   * @description Queries swarm memory and formats results as a prompt-injectable context block.
   * This is the primary integration point — called before agent execution to inject
   * relevant organizational knowledge into the agent's prompt.
   * @param ticketTitle - Title of the incoming work item
   * @param ticketDescription - Description/body of the incoming work item
   * @param limit - Max past experiences to include (default 3)
   * @returns Formatted context block ready for prompt injection
   */
  async queryRelevantContext(
    ticketTitle: string,
    ticketDescription: string,
    limit = 3,
  ): Promise<SwarmContextBlock> {
    const query = `${ticketTitle} ${ticketDescription}`.trim();
    if (!query) {
      return { memoryCount: 0, promptBlock: '', hasContent: false };
    }

    const memories = await this.queryRelevant(query, limit);
    if (memories.length === 0) {
      return { memoryCount: 0, promptBlock: '', hasContent: false };
    }

    const blocks = memories.map((m, i) => {
      const agent = m.metadata.agentId || 'unknown';
      const title = m.metadata.title || 'untitled';
      return `### Past Experience ${i + 1} (by ${agent}: "${title}")\n${m.text}`;
    });

    const promptBlock = [
      '## Organizational Memory — Relevant Past Experiences',
      '',
      'The swarm has completed similar work before. Use these learnings to inform your approach:',
      '',
      ...blocks,
      '',
      '---',
    ].join('\n');

    return {
      memoryCount: memories.length,
      promptBlock,
      hasContent: true,
    };
  }

  // ─── Collection Info ─────────────────────────────────────────────────

  /**
   * @description Gets the swarm memory collection name.
   * @returns Collection name string
   */
  getCollectionName(): string {
    return SWARM_MEMORY_COLLECTION;
  }

  // ─── Internal ────────────────────────────────────────────────────────

  /**
   * @description Extracts structured learnings from an agent's execution output.
   * Parses markdown-like sections: What Worked, Challenges, Key Learnings.
   */
  private extractLearning(output: string): SwarmLearning {
    const learning: SwarmLearning = {
      whatWorked: [],
      challenges: [],
      keyLearnings: [],
    };

    if (!output || output.trim().length === 0) {
      return learning;
    }

    // Parse markdown sections — [^\n]* skips trailing chars in the header line (e.g., "Challenges", "Key Learnings")
    const whatWorkedMatch = output.match(/(?:what worked|approach|solution)[^\n]*\n([\s\S]*?)(?=\n##|\n###|\nchallenge|\nkey learn|$)/i);
    if (whatWorkedMatch) {
      learning.whatWorked = this.extractBulletPoints(whatWorkedMatch[1]);
    }

    const challengesMatch = output.match(/(?:challenge|difficulty|obstacle|issue)[^\n]*\n([\s\S]*?)(?=\n##|\n###|\nkey learn|\nwhat worked|$)/i);
    if (challengesMatch) {
      learning.challenges = this.extractBulletPoints(challengesMatch[1]);
    }

    const learningsMatch = output.match(/(?:key learn|takeaway|lesson|insight)[^\n]*\n([\s\S]*?)(?=\n##|\n###|\nwhat worked|\nchallenge|$)/i);
    if (learningsMatch) {
      learning.keyLearnings = this.extractBulletPoints(learningsMatch[1]);
    }

    // Fallback: if no structured sections found, use the whole output as a single learning
    if (learning.whatWorked.length === 0 && learning.challenges.length === 0 && learning.keyLearnings.length === 0) {
      const summary = output.trim().slice(0, 500);
      learning.keyLearnings = [summary];
    }

    return learning;
  }

  /**
   * @description Extracts bullet points from a text block.
   */
  private extractBulletPoints(text: string): string[] {
    return text
      .split('\n')
      .map((line) => line.replace(/^[\s-*•]+/, '').trim())
      .filter((line) => line.length > 0);
  }

  /**
   * @description Formats a learning document as a structured markdown block
   * for storage in ChromaDB.
   */
  private formatLearningDocument(context: CompletedWorkContext, learning: SwarmLearning): string {
    const sections: string[] = [
      `# Work Item: ${context.title}`,
      `- Agent: ${context.agentId}`,
      `- Complexity: ${context.complexity || 'unknown'}`,
      `- Verification issues: ${context.hadVerificationFailures ? 'yes' : 'no'}`,
      `- Escalated: ${context.hadEscalations ? 'yes' : 'no'}`,
    ];

    if (learning.whatWorked.length > 0) {
      sections.push('', '## What Worked');
      learning.whatWorked.forEach((w) => sections.push(`- ${w}`));
    }

    if (learning.challenges.length > 0) {
      sections.push('', '## Challenges');
      learning.challenges.forEach((c) => sections.push(`- ${c}`));
    }

    if (learning.keyLearnings.length > 0) {
      sections.push('', '## Key Learnings');
      learning.keyLearnings.forEach((l) => sections.push(`- ${l}`));
    }

    return sections.join('\n');
  }

  // ─── Default Namespace Management ────────────────────────────────────

  /**
   * @description Ensures all default community RAG namespaces exist in ChromaDB.
   * Called at startup so bots can immediately read/write without manual setup.
   * @returns List of namespace names that were ensured
   */
  async ensureDefaultNamespaces(): Promise<string[]> {
    const ensured: string[] = [];
    for (const ns of SWARM_RAG_NAMESPACE_LIST) {
      try {
        await this.ragService.ensureCollection(ns);
        ensured.push(ns);
      } catch (err) {
        logger.warn({ err, namespace: ns }, 'Failed to ensure RAG namespace — will retry on next access');
      }
    }
    logger.info({ namespaces: ensured }, 'Default community RAG namespaces ensured');
    return ensured;
  }

  /**
   * @description Ingests ticket context into the swarm-tickets namespace.
   * Call when a ticket is created, completed, or escalated.
   * @param ticketId - Ticket identifier
   * @param title - Ticket title
   * @param content - Ticket description/body or completion summary
   * @param metadata - Additional metadata (status, agentId, etc.)
   */
  async ingestTicketContext(
    ticketId: string, title: string, content: string,
    metadata: Record<string, string> = {},
  ): Promise<void> {
    try {
      await this.ragService.ingest(
        [`# ${title}\n\n${content}`],
        SWARM_RAG_NAMESPACES.tickets,
        { ticketId, title, timestamp: new Date().toISOString(), ...metadata },
      );
      logger.info({ ticketId, namespace: SWARM_RAG_NAMESPACES.tickets }, 'Ticket context ingested');
    } catch (err) {
      logger.warn({ err, ticketId }, 'Failed to ingest ticket context — non-fatal');
    }
  }

  /**
   * @description Ingests an execution message into the swarm-messages namespace.
   * Call after agent execution to preserve conversation continuity.
   * @param messageId - Unique message identifier
   * @param agentId - Agent that produced the message
   * @param content - Message content
   */
  async ingestMessage(messageId: string, agentId: string, content: string): Promise<void> {
    try {
      await this.ragService.ingest(
        [content],
        SWARM_RAG_NAMESPACES.messages,
        { messageId, agentId, timestamp: new Date().toISOString() },
      );
    } catch (err) {
      logger.warn({ err, messageId }, 'Failed to ingest message — non-fatal');
    }
  }

  /**
   * @description Ingests shared knowledge into the swarm-knowledge namespace.
   * Use for ADRs, best practices, conventions, and domain rules.
   * @param knowledgeId - Unique knowledge entry identifier
   * @param content - Knowledge content (markdown)
   * @param category - Category tag (e.g., 'adr', 'convention', 'best-practice')
   */
  async ingestKnowledge(knowledgeId: string, content: string, category = 'general'): Promise<void> {
    try {
      await this.ragService.ingest(
        [content],
        SWARM_RAG_NAMESPACES.knowledge,
        { knowledgeId, category, timestamp: new Date().toISOString() },
      );
      logger.info({ knowledgeId, category }, 'Knowledge ingested into swarm-knowledge');
    } catch (err) {
      logger.warn({ err, knowledgeId }, 'Failed to ingest knowledge — non-fatal');
    }
  }

  /**
   * @description Queries a specific community namespace for relevant context.
   * @param namespace - One of the SWARM_RAG_NAMESPACES values
   * @param query - Search query text
   * @param limit - Max results
   * @returns Ranked search results
   */
  async queryNamespace(namespace: string, query: string, limit = 5): Promise<SwarmMemoryEntry[]> {
    try {
      const results = await this.ragService.search(query, namespace, limit);
      return results.map(mapSearchResult);
    } catch (err) {
      logger.warn({ err, namespace, query }, 'Namespace query failed');
      return [];
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.ragService.ensureCollection(SWARM_MEMORY_COLLECTION);
    this.initialized = true;
  }
}

/**
 * @description Maps a RagSearchResult to a SwarmMemoryEntry.
 */
function mapSearchResult(r: RagSearchResult): SwarmMemoryEntry {
  return { id: r.id, text: r.text, metadata: r.metadata, score: r.score };
}
