/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added GoogleSearchIntegration — web search tool for agent research (M9 Tier 1)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'google-search-integration' });

/**
 * @description Configuration for Google Custom Search API.
 */
export interface GoogleSearchConfig {
  apiKey: string;
  searchEngineId: string;
  endpoint?: string;
  maxResultsPerQuery?: number;
}

/**
 * @description One search result from Google Custom Search.
 */
export interface SearchResult {
  title: string;
  link: string;
  snippet: string;
  displayLink: string;
}

/**
 * @description Search response from the integration.
 */
export interface SearchResponse {
  query: string;
  results: SearchResult[];
  totalResults: number;
  searchTime: number;
}

/**
 * @description GoogleSearchIntegration — wraps Google Custom Search API for agent use.
 *
 * Ported from the legacy implementation's google-search-mcp. Instead of running as a separate MCP server,
 * this integrates directly as a tool in the OSHAL tool registry. Agents can call
 * `search(query)` to perform web research.
 *
 * Configuration via environment:
 * - GOOGLE_SEARCH_API_KEY — Google API key with Custom Search API enabled
 * - GOOGLE_SEARCH_ENGINE_ID — Programmable Search Engine ID
 */
export class GoogleSearchIntegration {
  private readonly config: GoogleSearchConfig;
  private requestCount = 0;

  constructor(config?: Partial<GoogleSearchConfig>) {
    this.config = {
      apiKey: config?.apiKey || process.env.GOOGLE_SEARCH_API_KEY || '',
      searchEngineId: config?.searchEngineId || process.env.GOOGLE_SEARCH_ENGINE_ID || '',
      endpoint: config?.endpoint || 'https://www.googleapis.com/customsearch/v1',
      maxResultsPerQuery: config?.maxResultsPerQuery || 10,
    };
  }

  /**
   * @description Check if the integration is configured with valid credentials.
   * @returns True if API key and search engine ID are set
   */
  isConfigured(): boolean {
    return Boolean(this.config.apiKey && this.config.searchEngineId);
  }

  /**
   * @description Perform a web search query.
   * @param query - Search query string
   * @param limit - Max results (default from config)
   * @returns Search response with results
   */
  async search(query: string, limit?: number): Promise<SearchResponse> {
    const startedAt = Date.now();
    const num = Math.min(limit ?? this.config.maxResultsPerQuery ?? 10, 10);

    if (!this.isConfigured()) {
      logger.warn({ query }, 'Google Search not configured — returning empty results');
      return { query, results: [], totalResults: 0, searchTime: 0 };
    }

    try {
      const url = new URL(this.config.endpoint!);
      url.searchParams.set('key', this.config.apiKey);
      url.searchParams.set('cx', this.config.searchEngineId);
      url.searchParams.set('q', query);
      url.searchParams.set('num', String(num));

      const response = await fetch(url.toString());
      this.requestCount += 1;

      if (!response.ok) {
        const text = await response.text();
        logger.error({ status: response.status, body: text.slice(0, 200), query }, 'Google Search API error');
        return { query, results: [], totalResults: 0, searchTime: Date.now() - startedAt };
      }

      const data = await response.json() as GoogleSearchApiResponse;
      const results = (data.items || []).map(mapSearchItem);
      const totalResults = parseInt(data.searchInformation?.totalResults || '0', 10);

      logger.info(
        { query, resultCount: results.length, totalResults, durationMs: Date.now() - startedAt, requestCount: this.requestCount },
        'Google Search completed',
      );

      return { query, results, totalResults, searchTime: Date.now() - startedAt };
    } catch (err) {
      logger.error({ err, query }, 'Google Search request failed');
      return { query, results: [], totalResults: 0, searchTime: Date.now() - startedAt };
    }
  }

  /**
   * @description Get usage statistics.
   * @returns Request count
   */
  getUsageStats(): { requestCount: number } {
    return { requestCount: this.requestCount };
  }
}

/**
 * @description Maps a Google Custom Search API item to our SearchResult type.
 */
function mapSearchItem(item: GoogleSearchItem): SearchResult {
  return {
    title: item.title || '',
    link: item.link || '',
    snippet: item.snippet || '',
    displayLink: item.displayLink || '',
  };
}

/**
 * @description Raw Google Custom Search API response shape.
 */
interface GoogleSearchApiResponse {
  searchInformation?: { totalResults?: string };
  items?: GoogleSearchItem[];
}

/**
 * @description Raw Google Custom Search API result item.
 */
interface GoogleSearchItem {
  title?: string;
  link?: string;
  snippet?: string;
  displayLink?: string;
}
