/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * AgentMemory — Per-agent persistent memory via ChromaDB
 * 
 * Each bot gets its own ChromaDB collection (`agent-memory-{agent_id}`)
 * for domain knowledge, learned context, and bootstrapped documentation.
 * 
 * Uses ChromaDB REST API directly (not the mock chroma-mcp-server).
 * 
 * PHASE_52: ProvisioningManager + Agent Memory & Knowledge Bootstrap
 */

const logger = require('../utils/logger');

/**
 * @description Encapsulates one agent's long-term, semantically searchable memory so that
 * each bot can retain domain knowledge and learned context independently of others. A
 * dedicated ChromaDB collection per agent keeps memories isolated, lets knowledge be
 * bootstrapped once (guarded by a Redis flag), and degrades gracefully — failures are
 * logged and swallowed so an agent can keep operating even when memory is unavailable.
 */
class AgentMemory {
  /**
   * @param {string} agentId - Unique agent identifier
   * @param {Object} [options] - Configuration options
   * @param {string} [options.chromaHost] - ChromaDB host
   * @param {number} [options.chromaPort] - ChromaDB port
   * @param {Object} [options.redisClient] - Redis client for bootstrap flags
   */
  constructor(agentId, options = {}) {
    if (!agentId) throw new Error('agentId is required for AgentMemory');

    this.agentId = agentId;
    this.collectionName = `agent-memory-${agentId}`;
    this.chromaHost = options.chromaHost || process.env.CHROMADB_HOST || 'swarm-chromadb';
    this.chromaPort = options.chromaPort || parseInt(process.env.CHROMADB_PORT || '8000');
    this.chromaBaseUrl = `http://${this.chromaHost}:${this.chromaPort}`;
    this.redis = options.redisClient || null;
    this.collectionId = null;
    this.initialized = false;
  }

  /**
   * Initialize the agent's ChromaDB collection.
   * Creates the collection if it doesn't exist.
   * @returns {Promise<boolean>} Success status
   */
  async initialize() {
    try {
      logger.info(`[AgentMemory:${this.agentId}] Initializing collection: ${this.collectionName}`);

      // Try to get or create the collection via ChromaDB REST API
      const response = await this._chromaRequest('POST', '/api/v1/collections', {
        name: this.collectionName,
        metadata: {
          agent_id: this.agentId,
          created_at: new Date().toISOString(),
          type: 'agent-memory',
        },
        get_or_create: true,
      });

      if (response && response.id) {
        this.collectionId = response.id;
        this.initialized = true;
        logger.info(`[AgentMemory:${this.agentId}] ✅ Collection ready: ${this.collectionName} (${this.collectionId})`);
        return true;
      }

      // Fallback: try listing collections to find ours
      const collections = await this._chromaRequest('GET', '/api/v1/collections');
      if (Array.isArray(collections)) {
        const existing = collections.find(c => c.name === this.collectionName);
        if (existing) {
          this.collectionId = existing.id;
          this.initialized = true;
          logger.info(`[AgentMemory:${this.agentId}] ✅ Found existing collection: ${this.collectionId}`);
          return true;
        }
      }

      logger.warn(`[AgentMemory:${this.agentId}] Could not create/find collection`);
      return false;
    } catch (error) {
      logger.error(`[AgentMemory:${this.agentId}] Initialization failed: ${error.message}`);
      // Don't throw — agent should still function without memory
      return false;
    }
  }

  /**
   * Store a memory (text + metadata) in the agent's collection.
   * @param {string} text - The text content to remember
   * @param {Object} [metadata] - Optional metadata (source, type, timestamp)
   * @param {string} [id] - Optional custom document ID
   * @returns {Promise<boolean>} Success status
   */
  async remember(text, metadata = {}, id = null) {
    if (!this.initialized || !this.collectionId) {
      logger.warn(`[AgentMemory:${this.agentId}] Not initialized, cannot remember`);
      return false;
    }

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      logger.warn(`[AgentMemory:${this.agentId}] Empty text, skipping remember`);
      return false;
    }

    try {
      const docId = id || `mem-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
      const enrichedMetadata = {
        ...metadata,
        agent_id: this.agentId,
        stored_at: new Date().toISOString(),
        source: metadata.source || 'agent-memory',
      };

      await this._chromaRequest('POST', `/api/v1/collections/${this.collectionId}/add`, {
        ids: [docId],
        documents: [text.trim()],
        metadatas: [enrichedMetadata],
      });

      logger.debug(`[AgentMemory:${this.agentId}] Remembered: ${docId} (${text.substring(0, 50)}...)`);
      return true;
    } catch (error) {
      logger.error(`[AgentMemory:${this.agentId}] Remember failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Store multiple memories in a batch.
   * @param {Array<{text: string, metadata?: Object, id?: string}>} items
   * @returns {Promise<number>} Number of items successfully stored
   */
  async rememberBatch(items) {
    if (!this.initialized || !this.collectionId) return 0;
    if (!Array.isArray(items) || items.length === 0) return 0;

    try {
      const ids = [];
      const documents = [];
      const metadatas = [];

      for (const item of items) {
        if (!item.text || typeof item.text !== 'string' || item.text.trim().length === 0) continue;

        const docId = item.id || `mem-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
        ids.push(docId);
        documents.push(item.text.trim());
        metadatas.push({
          ...(item.metadata || {}),
          agent_id: this.agentId,
          stored_at: new Date().toISOString(),
          source: (item.metadata && item.metadata.source) || 'batch-memory',
        });
      }

      if (ids.length === 0) return 0;

      await this._chromaRequest('POST', `/api/v1/collections/${this.collectionId}/add`, {
        ids,
        documents,
        metadatas,
      });

      logger.info(`[AgentMemory:${this.agentId}] Batch remembered: ${ids.length} items`);
      return ids.length;
    } catch (error) {
      logger.error(`[AgentMemory:${this.agentId}] Batch remember failed: ${error.message}`);
      return 0;
    }
  }

  /**
   * Recall relevant memories using semantic search.
   * @param {string} query - Search query
   * @param {number} [limit=5] - Max results to return
   * @param {Object} [whereFilter] - Optional metadata filter
   * @returns {Promise<Array<{text: string, metadata: Object, distance: number}>>} Matching memories
   */
  async recall(query, limit = 5, whereFilter = null) {
    if (!this.initialized || !this.collectionId) {
      return [];
    }

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return [];
    }

    try {
      const body = {
        query_texts: [query.trim()],
        n_results: Math.min(limit, 20), // Cap at 20
      };

      if (whereFilter && Object.keys(whereFilter).length > 0) {
        body.where = whereFilter;
      }

      const response = await this._chromaRequest(
        'POST',
        `/api/v1/collections/${this.collectionId}/query`,
        body
      );

      if (!response || !response.documents || !response.documents[0]) {
        return [];
      }

      // ChromaDB returns nested arrays: documents[0], metadatas[0], distances[0]
      const docs = response.documents[0] || [];
      const metas = (response.metadatas && response.metadatas[0]) || [];
      const dists = (response.distances && response.distances[0]) || [];

      const results = docs.map((text, i) => ({
        text,
        metadata: metas[i] || {},
        distance: dists[i] || 0,
      }));

      logger.debug(`[AgentMemory:${this.agentId}] Recalled ${results.length} memories for: "${query.substring(0, 40)}..."`);
      return results;
    } catch (error) {
      logger.error(`[AgentMemory:${this.agentId}] Recall failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Get collection statistics.
   * @returns {Promise<Object>} Stats: { documentCount, collectionName, lastUpdated, initialized }
   */
  async getCollectionStats() {
    const stats = {
      agentId: this.agentId,
      collectionName: this.collectionName,
      collectionId: this.collectionId,
      initialized: this.initialized,
      documentCount: 0,
      lastUpdated: null,
    };

    if (!this.initialized || !this.collectionId) {
      return stats;
    }

    try {
      const response = await this._chromaRequest(
        'GET',
        `/api/v1/collections/${this.collectionId}/count`
      );

      // ChromaDB count endpoint returns a number directly
      if (typeof response === 'number') {
        stats.documentCount = response;
      } else if (response && typeof response.count === 'number') {
        stats.documentCount = response.count;
      }

      stats.lastUpdated = new Date().toISOString();
    } catch (error) {
      logger.debug(`[AgentMemory:${this.agentId}] Stats fetch failed: ${error.message}`);
    }

    return stats;
  }

  /**
   * Check if the agent's knowledge has already been bootstrapped.
   * Uses Redis flag: `agent-memory-bootstrapped:{agent_id}`
   * @returns {Promise<boolean>} True if already bootstrapped
   */
  async isBootstrapped() {
    if (!this.redis) return false;

    try {
      const flag = await this.redis.get(`agent-memory-bootstrapped:${this.agentId}`);
      return flag === 'true';
    } catch (error) {
      logger.debug(`[AgentMemory:${this.agentId}] Bootstrap check failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Mark the agent's knowledge as bootstrapped.
   * @returns {Promise<boolean>} Success status
   */
  async markBootstrapped() {
    if (!this.redis) return false;

    try {
      await this.redis.set(`agent-memory-bootstrapped:${this.agentId}`, 'true');
      logger.info(`[AgentMemory:${this.agentId}] ✅ Marked as bootstrapped`);
      return true;
    } catch (error) {
      logger.error(`[AgentMemory:${this.agentId}] Failed to mark bootstrapped: ${error.message}`);
      return false;
    }
  }

  /**
   * Bootstrap knowledge from a list of knowledge sources.
   * Chunks text and ingests into the agent's ChromaDB collection.
   * @param {string[]} knowledgeSources - Array of knowledge source descriptions or URLs
   * @param {Object} [options] - Bootstrap options
   * @param {number} [options.chunkSize=500] - Characters per chunk
   * @param {number} [options.chunkOverlap=50] - Overlap between chunks
   * @returns {Promise<Object>} Bootstrap results { ingested, failed, total }
   */
  async bootstrapKnowledge(knowledgeSources, options = {}) {
    if (!this.initialized) {
      logger.warn(`[AgentMemory:${this.agentId}] Not initialized, cannot bootstrap`);
      return { ingested: 0, failed: 0, total: 0 };
    }

    // Check if already bootstrapped
    const alreadyDone = await this.isBootstrapped();
    if (alreadyDone) {
      logger.info(`[AgentMemory:${this.agentId}] Already bootstrapped, skipping`);
      return { ingested: 0, failed: 0, total: 0, skipped: true };
    }

    if (!Array.isArray(knowledgeSources) || knowledgeSources.length === 0) {
      return { ingested: 0, failed: 0, total: 0 };
    }

    const chunkSize = options.chunkSize || 500;
    const chunkOverlap = options.chunkOverlap || 50;
    let totalIngested = 0;
    let totalFailed = 0;

    logger.info(`[AgentMemory:${this.agentId}] Bootstrapping from ${knowledgeSources.length} knowledge sources...`);

    for (const source of knowledgeSources) {
      try {
        // Each knowledge source is treated as a text description that should be
        // stored as domain knowledge. The agent can later use search tools to
        // enrich this with real content.
        const chunks = this._chunkText(source, chunkSize, chunkOverlap);
        
        const items = chunks.map((chunk, idx) => ({
          text: chunk,
          metadata: {
            source: 'knowledge-bootstrap',
            knowledge_source: source.substring(0, 100),
            chunk_index: idx,
            total_chunks: chunks.length,
          },
        }));

        const stored = await this.rememberBatch(items);
        totalIngested += stored;
      } catch (error) {
        logger.error(`[AgentMemory:${this.agentId}] Failed to bootstrap source: ${error.message}`);
        totalFailed++;
      }
    }

    // Mark as bootstrapped
    if (totalIngested > 0) {
      await this.markBootstrapped();
    }

    logger.info(`[AgentMemory:${this.agentId}] Bootstrap complete: ${totalIngested} chunks ingested, ${totalFailed} failed`);

    return {
      ingested: totalIngested,
      failed: totalFailed,
      total: knowledgeSources.length,
    };
  }

  /**
   * Delete the agent's entire collection.
   * @returns {Promise<boolean>} Success status
   */
  async deleteCollection() {
    if (!this.collectionName) return false;

    try {
      await this._chromaRequest('DELETE', `/api/v1/collections/${this.collectionName}`);
      this.initialized = false;
      this.collectionId = null;
      logger.info(`[AgentMemory:${this.agentId}] Collection deleted: ${this.collectionName}`);
      return true;
    } catch (error) {
      logger.error(`[AgentMemory:${this.agentId}] Delete failed: ${error.message}`);
      return false;
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────

  /**
   * Make HTTP request to ChromaDB REST API.
   * @param {string} method - HTTP method
   * @param {string} path - API path
   * @param {Object} [body] - Request body
   * @returns {Promise<Object>} Response data
   */
  async _chromaRequest(method, path, body = null) {
    const url = `${this.chromaBaseUrl}${path}`;

    const options = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };

    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`ChromaDB ${method} ${path} failed (${response.status}): ${errorText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return response.json();
    }

    // Some endpoints return plain numbers
    const text = await response.text();
    const num = Number(text);
    if (!isNaN(num)) return num;
    return text;
  }

  /**
   * Split text into chunks with overlap.
   * @param {string} text - Text to chunk
   * @param {number} chunkSize - Characters per chunk
   * @param {number} overlap - Overlap between chunks
   * @returns {string[]} Array of text chunks
   */
  _chunkText(text, chunkSize = 500, overlap = 50) {
    if (!text || text.length <= chunkSize) {
      return [text];
    }

    const chunks = [];
    let start = 0;

    while (start < text.length) {
      const end = Math.min(start + chunkSize, text.length);
      chunks.push(text.substring(start, end));
      start += chunkSize - overlap;
    }

    return chunks;
  }
}

module.exports = AgentMemory;
