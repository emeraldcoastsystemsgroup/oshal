/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * KnowledgeBootstrap — Layer 3: Research-Bot → ChromaDB Knowledge Pipeline
 * 
 * Orchestrates domain knowledge loading for newly-created bots:
 * 1. Dispatches research queries to research-bot (port 3017) via HTTP
 * 2. Collects research results (web search summaries, documentation)
 * 3. Chunks research into embeddable segments
 * 4. Loads chunks into ChromaDB collection tagged with agentId
 * 5. New bot gets instant domain expertise via RAG retrieval
 * 
 * Layer 3: Self-Evolving Agent Factory — Knowledge Pipeline
 */

const http = require('http');
const logger = require('../utils/logger');

// Default configuration
const DEFAULTS = {
  researchBotHost: process.env.RESEARCH_BOT_HOST || 'host.docker.internal',
  researchBotPort: parseInt(process.env.RESEARCH_BOT_PORT || '3017'),
  chromaHost: process.env.CHROMA_HOST || 'chroma-mcp',
  chromaPort: parseInt(process.env.CHROMA_PORT || '8091'),
  chunkSize: 500,       // ~500 chars per chunk
  chunkOverlap: 50,     // 50 char overlap between chunks
  maxResearchQueries: 5, // Max parallel research queries
  researchTimeoutMs: 120000, // 2 min per research query
};

/**
 * @description Knowledge-bootstrap orchestrator that gives a freshly-minted bot
 * instant, domain-specific expertise. It exists so that new agents in the
 * self-evolving factory do not start "cold": instead of relying solely on the
 * base model, it drives research-bot to gather authoritative material, splits
 * that material into embeddable chunks, and seeds a per-agent ChromaDB
 * collection so the agent can answer via RAG retrieval from day one.
 */
class KnowledgeBootstrap {
  /**
   * @param {Object} options
   * @param {string} options.researchBotHost
   * @param {number} options.researchBotPort
   * @param {string} options.chromaHost
   * @param {number} options.chromaPort
   * @param {number} options.chunkSize
   * @param {number} options.chunkOverlap
   */
  constructor(options = {}) {
    this.researchBotHost = options.researchBotHost || DEFAULTS.researchBotHost;
    this.researchBotPort = options.researchBotPort || DEFAULTS.researchBotPort;
    this.chromaHost = options.chromaHost || DEFAULTS.chromaHost;
    this.chromaPort = options.chromaPort || DEFAULTS.chromaPort;
    this.chunkSize = options.chunkSize || DEFAULTS.chunkSize;
    this.chunkOverlap = options.chunkOverlap || DEFAULTS.chunkOverlap;
    this.maxResearchQueries = options.maxResearchQueries || DEFAULTS.maxResearchQueries;
    this.researchTimeoutMs = options.researchTimeoutMs || DEFAULTS.researchTimeoutMs;
  }

  /**
   * Full knowledge bootstrap pipeline for a new agent
   * 
   * @param {Object} spec
   * @param {string} spec.agentId — Target agent that will receive the knowledge
   * @param {string} spec.domain — Domain to research (e.g., "OpenWeatherMap API", "IBM DB2 administration")
   * @param {string[]} [spec.queries] — Specific research queries (auto-generated if omitted)
   * @param {Object} [spec.metadata] — Extra metadata to attach to ChromaDB documents
   * @returns {Object} Pipeline result with stats
   */
  async bootstrap(spec) {
    if (!spec || !spec.agentId || !spec.domain) {
      throw new Error('KnowledgeBootstrap requires agentId and domain');
    }

    const startTime = Date.now();
    const result = {
      agentId: spec.agentId,
      domain: spec.domain,
      status: 'in-progress',
      steps: {},
    };

    try {
      // Step 1: Generate research queries from domain
      const queries = spec.queries && spec.queries.length > 0
        ? spec.queries.slice(0, this.maxResearchQueries)
        : this._generateQueries(spec.domain);
      
      result.steps.queriesGenerated = { count: queries.length, queries };
      logger.info(`[KnowledgeBootstrap] Agent ${spec.agentId}: ${queries.length} research queries for domain "${spec.domain}"`);

      // Step 2: Dispatch research queries to research-bot
      const researchResults = await this._dispatchResearch(queries, spec.agentId);
      result.steps.researchCompleted = {
        total: queries.length,
        successful: researchResults.filter(r => r.success).length,
        failed: researchResults.filter(r => !r.success).length,
        totalChars: researchResults.reduce((sum, r) => sum + (r.content || '').length, 0),
      };
      logger.info(`[KnowledgeBootstrap] Research: ${result.steps.researchCompleted.successful}/${queries.length} succeeded, ${result.steps.researchCompleted.totalChars} chars`);

      // Step 3: Chunk research results
      const allContent = researchResults
        .filter(r => r.success && r.content)
        .map(r => r.content)
        .join('\n\n---\n\n');

      if (!allContent || allContent.length < 50) {
        result.status = 'partial';
        result.error = 'Research returned insufficient content';
        result.steps.chunking = { chunks: 0 };
        result.steps.chromaLoaded = { documents: 0 };
        result.durationMs = Date.now() - startTime;
        return result;
      }

      const chunks = this._chunkText(allContent);
      result.steps.chunking = { chunks: chunks.length, avgChunkSize: Math.round(allContent.length / chunks.length) };
      logger.info(`[KnowledgeBootstrap] Chunked into ${chunks.length} segments`);

      // Step 4: Load into ChromaDB
      const collectionName = `agent-knowledge-${spec.agentId}`;
      const loadResult = await this._loadToChromaDB(collectionName, chunks, {
        agentId: spec.agentId,
        domain: spec.domain,
        bootstrapDate: new Date().toISOString(),
        ...(spec.metadata || {}),
      });
      result.steps.chromaLoaded = loadResult;
      logger.info(`[KnowledgeBootstrap] ChromaDB: ${loadResult.documents} documents loaded into ${collectionName}`);

      result.status = 'complete';
      result.durationMs = Date.now() - startTime;
      return result;

    } catch (error) {
      result.status = 'failed';
      result.error = error.message;
      result.durationMs = Date.now() - startTime;
      logger.error(`[KnowledgeBootstrap] Failed for ${spec.agentId}: ${error.message}`);
      return result;
    }
  }

  /**
   * Generate research queries from a domain description
   */
  _generateQueries(domain) {
    const queries = [
      `What is ${domain}? Overview, key concepts, and main use cases`,
      `${domain} getting started guide, setup, and configuration`,
      `${domain} API reference, endpoints, authentication`,
      `${domain} best practices, common patterns, and troubleshooting`,
      `${domain} examples, tutorials, and code samples`,
    ];
    return queries.slice(0, this.maxResearchQueries);
  }

  /**
   * Dispatch research queries to research-bot via HTTP
   */
  async _dispatchResearch(queries, agentId) {
    const results = [];

    for (const query of queries) {
      try {
        const response = await this._httpPost(
          this.researchBotHost,
          this.researchBotPort,
          '/api/process-ticket',
          {
            ticket: {
              id: `kb-${agentId}-${Date.now()}`,
              name: `Knowledge Research: ${query}`,
              description_stripped: `Research the following topic thoroughly and provide a comprehensive summary:\n\n${query}\n\nProvide factual, detailed information suitable for training an AI agent.`,
            },
            agentId: 'research-bot',
            analysis: { complexity: 'standard' },
          },
          this.researchTimeoutMs
        );

        if (response && response.success && response.response) {
          results.push({
            query,
            success: true,
            content: response.response,
            chars: response.response.length,
          });
        } else {
          results.push({
            query,
            success: false,
            error: 'Empty or unsuccessful response from research-bot',
          });
        }
      } catch (error) {
        results.push({
          query,
          success: false,
          error: error.message,
        });
      }
    }

    return results;
  }

  /**
   * Chunk text into overlapping segments for embedding
   */
  _chunkText(text) {
    if (!text || text.length === 0) return [];

    const chunks = [];
    const sentences = text.split(/(?<=[.!?\n])\s+/);
    let currentChunk = '';

    for (const sentence of sentences) {
      if (currentChunk.length + sentence.length > this.chunkSize && currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
        // Keep overlap from end of previous chunk
        const overlapStart = Math.max(0, currentChunk.length - this.chunkOverlap);
        currentChunk = currentChunk.substring(overlapStart) + ' ' + sentence;
      } else {
        currentChunk += (currentChunk ? ' ' : '') + sentence;
      }
    }

    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }

  /**
   * Load document chunks into ChromaDB via its HTTP API
   */
  async _loadToChromaDB(collectionName, chunks, metadata = {}) {
    try {
      // Step 1: Ensure collection exists (create or get)
      let collectionId;
      try {
        const createResult = await this._httpPost(
          this.chromaHost,
          this.chromaPort,
          '/api/v1/collections',
          {
            name: collectionName,
            metadata: { source: 'knowledge-bootstrap', ...metadata },
          },
          10000
        );
        collectionId = createResult?.id || collectionName;
      } catch (err) {
        // Collection may already exist — try to get it
        try {
          const getResult = await this._httpGet(
            this.chromaHost,
            this.chromaPort,
            `/api/v1/collections/${collectionName}`,
            10000
          );
          collectionId = getResult?.id || collectionName;
        } catch (getErr) {
          // Fallback: use collection name as ID
          collectionId = collectionName;
        }
      }

      // Step 2: Add documents in batches
      const batchSize = 20;
      let totalLoaded = 0;

      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        const ids = batch.map((_, idx) => `${collectionName}-${i + idx}`);
        const documents = batch;
        const metadatas = batch.map((_, idx) => ({
          ...metadata,
          chunkIndex: i + idx,
          chunkTotal: chunks.length,
        }));

        try {
          await this._httpPost(
            this.chromaHost,
            this.chromaPort,
            `/api/v1/collections/${collectionId}/add`,
            { ids, documents, metadatas },
            30000
          );
          totalLoaded += batch.length;
        } catch (batchErr) {
          logger.warn(`[KnowledgeBootstrap] Batch ${i}-${i + batch.length} failed: ${batchErr.message}`);
        }
      }

      return {
        collection: collectionName,
        collectionId,
        documents: totalLoaded,
        totalChunks: chunks.length,
        success: totalLoaded > 0,
      };

    } catch (error) {
      logger.error(`[KnowledgeBootstrap] ChromaDB load failed: ${error.message}`);
      return {
        collection: collectionName,
        documents: 0,
        totalChunks: chunks.length,
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Check if research-bot is reachable
   */
  async checkResearchBot() {
    try {
      const result = await this._httpGet(
        this.researchBotHost,
        this.researchBotPort,
        '/api/health',
        5000
      );
      return { available: true, status: result?.status || 'unknown' };
    } catch (error) {
      return { available: false, error: error.message };
    }
  }

  /**
   * Check if ChromaDB is reachable
   */
  async checkChromaDB() {
    try {
      const result = await this._httpGet(
        this.chromaHost,
        this.chromaPort,
        '/api/v1/heartbeat',
        5000
      );
      return { available: true, heartbeat: result };
    } catch (error) {
      return { available: false, error: error.message };
    }
  }

  /**
   * List all knowledge collections (agent-knowledge-*)
   */
  async listKnowledgeCollections() {
    try {
      const result = await this._httpGet(
        this.chromaHost,
        this.chromaPort,
        '/api/v1/collections',
        10000
      );
      const collections = (result || []).filter(c =>
        c.name && c.name.startsWith('agent-knowledge-')
      );
      return { collections, count: collections.length };
    } catch (error) {
      return { collections: [], count: 0, error: error.message };
    }
  }

  // ═══════════════════════════════════════
  // HTTP Helpers
  // ═══════════════════════════════════════

  _httpPost(host, port, path, body, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const options = {
        hostname: host,
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: timeoutMs,
      };

      const req = http.request(options, (res) => {
        let responseData = '';
        res.on('data', chunk => responseData += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(responseData));
          } catch {
            resolve(responseData);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`HTTP POST ${host}:${port}${path} timeout after ${timeoutMs}ms`));
      });

      req.write(data);
      req.end();
    });
  }

  _httpGet(host, port, path, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: host,
        port,
        path,
        method: 'GET',
        timeout: timeoutMs,
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`HTTP GET ${host}:${port}${path} timeout after ${timeoutMs}ms`));
      });

      req.end();
    });
  }
}

module.exports = KnowledgeBootstrap;
