/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added KnowledgeEnhancementService — autonomous research + RAG ingestion loop (M9 Tier 1)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

import { createChildLogger } from '@/shared/logger';
import type { GoogleSearchIntegration, SearchResult } from './google-search-integration';
import type { RagService } from '@/features/rag';

const logger = createChildLogger({ module: 'knowledge-enhancement-service' });

/**
 * @description Configuration for the knowledge enhancement loop.
 */
export interface KnowledgeEnhancementConfig {
  collectionName: string;
  maxSearchesPerRun: number;
  maxResultsPerSearch: number;
}

const DEFAULT_CONFIG: KnowledgeEnhancementConfig = {
  collectionName: 'swarm-knowledge',
  maxSearchesPerRun: 5,
  maxResultsPerSearch: 5,
};

/**
 * @description One enhancement run result.
 */
export interface EnhancementRunResult {
  runId: string;
  queriesExecuted: number;
  resultsFound: number;
  documentsIngested: number;
  durationMs: number;
  queries: string[];
  errors: string[];
}

/**
 * @description KnowledgeEnhancementService — autonomous knowledge loop.
 *
 * Ported from the legacy implementation's research-bot + rag-upload-worker pattern.
 * Flow:
 * 1. Analyze recent failures/knowledge gaps from swarm memory
 * 2. Generate search queries targeting those gaps
 * 3. Execute searches via GoogleSearchIntegration
 * 4. Ingest search results into ChromaDB via RagService
 * 5. Future agent prompts benefit from enriched knowledge
 *
 * Can be triggered manually or scheduled via ScheduleRunner.
 */
export class KnowledgeEnhancementService {
  private readonly searchService: GoogleSearchIntegration;
  private readonly ragService: RagService;
  private readonly config: KnowledgeEnhancementConfig;
  private runCount = 0;

  constructor(
    searchService: GoogleSearchIntegration,
    ragService: RagService,
    config?: Partial<KnowledgeEnhancementConfig>,
  ) {
    this.searchService = searchService;
    this.ragService = ragService;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * @description Run one knowledge enhancement cycle with explicit queries.
   * @param queries - Search queries to execute
   * @returns Enhancement run result
   */
  async enhance(queries: string[]): Promise<EnhancementRunResult> {
    const startedAt = Date.now();
    this.runCount += 1;
    const runId = `ke-${this.runCount}-${Date.now()}`;
    const limited = queries.slice(0, this.config.maxSearchesPerRun);
    const errors: string[] = [];
    let totalResults = 0;
    let totalIngested = 0;

    logger.info({ runId, queryCount: limited.length }, 'Starting knowledge enhancement run');

    await this.ensureCollection();

    for (const query of limited) {
      try {
        const response = await this.searchService.search(query, this.config.maxResultsPerSearch);
        totalResults += response.results.length;
        const ingested = await this.ingestResults(query, response.results);
        totalIngested += ingested;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        errors.push(`Query "${query}": ${msg}`);
        logger.warn({ err, query }, 'Knowledge enhancement query failed');
      }
    }

    const result: EnhancementRunResult = {
      runId,
      queriesExecuted: limited.length,
      resultsFound: totalResults,
      documentsIngested: totalIngested,
      durationMs: Date.now() - startedAt,
      queries: limited,
      errors,
    };

    logger.info(
      { runId, queries: limited.length, results: totalResults, ingested: totalIngested, durationMs: result.durationMs },
      'Knowledge enhancement run completed',
    );

    return result;
  }

  /**
   * @description Get usage stats for the enhancement service.
   * @returns Run count and search service stats
   */
  getStats(): { runCount: number; searchStats: { requestCount: number } } {
    return {
      runCount: this.runCount,
      searchStats: this.searchService.getUsageStats(),
    };
  }

  /**
   * @description Ingest search results into RAG collection.
   */
  private async ingestResults(query: string, results: SearchResult[]): Promise<number> {
    if (results.length === 0) return 0;

    let ingested = 0;
    for (const result of results) {
      try {
        const document = formatResultDocument(query, result);
        await this.ragService.ingest(
          [document],
          this.config.collectionName,
          {
            source: 'google-search',
            query,
            url: result.link,
            title: result.title,
            ingestedAt: new Date().toISOString(),
          },
        );
        ingested += 1;
      } catch (err) {
        logger.warn({ err, url: result.link }, 'Failed to ingest search result');
      }
    }

    return ingested;
  }

  /**
   * @description Ensure the knowledge collection exists in ChromaDB.
   */
  private async ensureCollection(): Promise<void> {
    try {
      await this.ragService.ensureCollection(this.config.collectionName);
    } catch (err) {
      logger.warn({ err, collection: this.config.collectionName }, 'Collection ensure failed');
    }
  }
}

/**
 * @description Format a search result as a document for RAG ingestion.
 */
function formatResultDocument(query: string, result: SearchResult): string {
  return [
    `# ${result.title}`,
    `Source: ${result.link}`,
    `Query: ${query}`,
    '',
    result.snippet,
  ].join('\n');
}
