/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * SwarmMemoryService — Cross-Ticket Organizational Memory (GAP F)
 *
 * Extracts key learnings from completed tickets and stores them in ChromaDB
 * `swarm-memory` collection. On new ticket dispatch, queries for relevant
 * past experiences and injects them into the agent's prompt.
 * 
 * This closes the "circle of life" — completed work feeds future work.
 * 
 * PHASE_20: Sprint 1 — Circle of Life
 */

const logger = require('../../utils/logger');
const crypto = require('crypto');

/**
 * @description Service that gives the swarm a durable, cross-ticket memory so
 * completed work informs future work ("circle of life"). It distills learnings
 * from finished tickets and persists them to a ChromaDB vector collection, then
 * retrieves the most semantically relevant past experiences when a new ticket is
 * dispatched so they can be injected into the agent's prompt. ChromaDB access is
 * attempted via an MCP HTTP server first and falls back to the ChromaDB REST API,
 * keeping memory best-effort so it never blocks the primary ticket workflow.
 */
class SwarmMemoryService {
  /**
   * @description Configure the memory service and its connection/budget defaults,
   * allowing each dependency to be overridden for testing or alternate
   * deployments, and falling back to environment variables where appropriate. The
   * service can be disabled entirely so memory remains an optional, non-blocking
   * enhancement to the queue pipeline.
   * @param {Object} [options={}] - Construction options.
   * @param {Object|null} [options.redis] - Redis client used to de-duplicate stored memories; null disables idempotency tracking.
   * @param {string} [options.chromaMcpUrl] - Base URL of the ChromaDB MCP HTTP server (defaults to CHROMA_MCP_URL env or the in-cluster address).
   * @param {string} [options.collectionName] - Name of the ChromaDB collection holding swarm memories.
   * @param {number} [options.maxMemoriesPerQuery] - Maximum number of memories to retrieve per query.
   * @param {number} [options.maxMemoryChars] - Character budget for the formatted memory block injected into a prompt.
   * @param {boolean} [options.enabled] - Whether the service is active; defaults to true unless explicitly set to false.
   */
  constructor(options = {}) {
    this.redis = options.redis || null;
    this.chromaMcpUrl = options.chromaMcpUrl || process.env.CHROMA_MCP_URL || 'http://chroma-mcp:8091';
    this.collectionName = options.collectionName || 'swarm-memory';
    this.maxMemoriesPerQuery = options.maxMemoriesPerQuery || 5;
    this.maxMemoryChars = options.maxMemoryChars || 3000; // Budget per injection
    this.enabled = options.enabled !== false; // Default enabled
    
    logger.info(`[SwarmMemory] Initialized (collection: ${this.collectionName}, enabled: ${this.enabled})`);
  }

  /**
   * Extract learnings from a completed ticket and store in ChromaDB.
   * Called when ticket status transitions to Customer Action or Done.
   * 
   * @param {Object} ticket - Plane ticket object { id, name, description_stripped }
   * @param {string} agentResponse - The final agent response text
   * @param {Object} metadata - { agentId, phase, complexity, gateFailures, escalations }
   * @returns {Promise<{ stored: boolean, memoryId: string|null }>}
   */
  async extractAndStore(ticket, agentResponse, metadata = {}) {
    if (!this.enabled) return { stored: false, memoryId: null };

    try {
      const ticketId = ticket.id;
      const ticketName = ticket.name || 'Unknown Ticket';
      
      // Skip if already stored (idempotent)
      if (this.redis) {
        const alreadyStored = await this.redis.get(`swarm-memory:stored:${ticketId}`);
        if (alreadyStored) {
          logger.debug(`[SwarmMemory] Ticket ${ticketId} already stored, skipping`);
          return { stored: false, memoryId: null };
        }
      }

      // Extract structured learnings
      const learning = this._extractLearning(ticket, agentResponse, metadata);
      
      if (!learning.content || learning.content.length < 100) {
        logger.debug(`[SwarmMemory] Ticket ${ticketId} learning too short (${learning.content?.length || 0} chars), skipping`);
        return { stored: false, memoryId: null };
      }

      // Generate memory ID
      const memoryId = `mem_${crypto.createHash('md5').update(ticketId).digest('hex').substring(0, 12)}`;

      // Store in ChromaDB via MCP HTTP endpoint
      const stored = await this._storeInChromaDB(memoryId, learning);
      
      if (stored) {
        // Mark as stored in Redis to prevent duplicates
        if (this.redis) {
          try {
            await this.redis.set(`swarm-memory:stored:${ticketId}`, memoryId, 'EX', 86400 * 30); // 30-day TTL
          } catch (e) { /* best effort */ }
        }
        
        logger.info(`[SwarmMemory] ✅ Stored learning from ticket ${ticketId}: ${learning.content.length} chars (memoryId: ${memoryId})`);
      }
      
      return { stored, memoryId };
    } catch (error) {
      logger.warn(`[SwarmMemory] extractAndStore failed for ticket ${ticket.id}: ${error.message}`);
      return { stored: false, memoryId: null };
    }
  }

  /**
   * Query ChromaDB for relevant memories for a new ticket.
   * Returns a formatted "Organizational Memory" block for prompt injection.
   * 
   * @param {Object} ticket - New ticket being dispatched { id, name, description_stripped }
   * @param {Object} analysis - CapabilityMatcher analysis { categories, complexity }
   * @returns {Promise<string>} - Formatted memory block or empty string
   */
  async queryRelevantMemories(ticket, analysis = {}) {
    if (!this.enabled) return '';

    try {
      const queryText = `${ticket.name || ''} ${ticket.description_stripped || ''}`.trim();
      if (!queryText || queryText.length < 20) return '';

      // Query ChromaDB for similar past tickets
      const memories = await this._queryChromaDB(queryText);
      
      if (!memories || memories.length === 0) {
        logger.debug(`[SwarmMemory] No relevant memories found for ticket ${ticket.id}`);
        return '';
      }

      // Format memories into prompt injection block
      const memoryBlock = this._formatMemoryBlock(memories);
      
      if (memoryBlock) {
        logger.info(`[SwarmMemory] Injecting ${memories.length} memories for ticket ${ticket.id} (${memoryBlock.length} chars)`);
      }
      
      return memoryBlock;
    } catch (error) {
      logger.warn(`[SwarmMemory] queryRelevantMemories failed for ticket ${ticket.id}: ${error.message}`);
      return '';
    }
  }

  /**
   * Extract structured learning from a completed ticket.
   * @private
   */
  _extractLearning(ticket, agentResponse, metadata) {
    const ticketName = ticket.name || 'Unknown';
    const description = ticket.description_stripped || ticket.name || '';
    const agentId = metadata.agentId || 'unknown';
    const complexity = metadata.complexity || 'medium';
    
    // Extract key sections from agent response
    const whatWorked = this._extractSection(agentResponse, ['What I Did', 'What I Produced', 'Completed', 'Accomplishments']);
    const whatFailed = this._extractSection(agentResponse, ['What\'s Left', 'Issues', 'Blockers', 'Failed', 'Challenges']);
    const keyContext = this._extractSection(agentResponse, ['Key Context', 'Important Notes', 'Lessons Learned', 'Key Findings']);
    
    // Detect if there were gate failures or escalations
    const hadGateFailures = metadata.gateFailures > 0 || agentResponse.includes('gate FAILED');
    const hadEscalations = metadata.escalations > 0 || agentResponse.includes('ESCALATION:');
    
    // Build learning document
    const parts = [];
    parts.push(`## Ticket: ${ticketName}`);
    parts.push(`**Task:** ${description.substring(0, 500)}`);
    parts.push(`**Agent:** ${agentId} | **Complexity:** ${complexity}`);
    
    if (whatWorked) {
      parts.push(`\n### What Worked\n${whatWorked.substring(0, 500)}`);
    }
    
    if (whatFailed) {
      parts.push(`\n### Challenges/Issues\n${whatFailed.substring(0, 500)}`);
    }
    
    if (keyContext) {
      parts.push(`\n### Key Learnings\n${keyContext.substring(0, 500)}`);
    }
    
    if (hadGateFailures) {
      parts.push(`\n### ⚠️ Gate failures occurred — quality gate needed extra iterations`);
    }
    
    if (hadEscalations) {
      parts.push(`\n### 🚨 Escalations occurred — complex scenario requiring special handling`);
    }
    
    // Extract a summary from the response (first substantive paragraph)
    const summary = this._extractSummary(agentResponse);
    if (summary && !whatWorked && !keyContext) {
      parts.push(`\n### Summary\n${summary.substring(0, 800)}`);
    }
    
    const content = parts.join('\n');
    
    return {
      content,
      metadata: {
        ticketId: ticket.id,
        ticketName,
        agentId,
        complexity,
        hadGateFailures,
        hadEscalations,
        timestamp: new Date().toISOString(),
        categories: (metadata.categories || []).join(','),
      }
    };
  }

  /**
   * Extract a named section from agent response text.
   * @private
   */
  _extractSection(text, sectionHeaders) {
    if (!text) return '';
    
    for (const header of sectionHeaders) {
      // Match "### What I Did" or "**What I Did**" or "What I Did:"
      const patterns = [
        new RegExp(`###\\s*${header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?(?=###|$)`, 'i'),
        new RegExp(`\\*\\*${header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*\\*[:\\s]*([\\s\\S]*?)(?=\\*\\*|###|---|\n\n\n|$)`, 'i'),
        new RegExp(`${header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:[\\s]*([\\s\\S]*?)(?=###|---|\n\n\n|$)`, 'i'),
      ];
      
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
          const content = (match[1] || match[0]).replace(/^###\s*.*\n/, '').trim();
          if (content.length > 30) return content;
        }
      }
    }
    
    return '';
  }

  /**
   * Extract a brief summary from the first substantive paragraph.
   * @private
   */
  _extractSummary(text) {
    if (!text) return '';
    
    const paragraphs = text.split(/\n\n+/).filter(p => {
      const trimmed = p.trim();
      return trimmed.length > 100 && 
             !trimmed.startsWith('#') && 
             !trimmed.startsWith('*') &&
             !trimmed.startsWith('---') &&
             !trimmed.startsWith('|');
    });
    
    return paragraphs[0]?.trim() || '';
  }

  /**
   * Store a learning document in ChromaDB via the chroma-mcp HTTP server.
   * @private
   */
  async _storeInChromaDB(memoryId, learning) {
    try {
      const http = require('http');
      
      // Use ChromaDB MCP's add_documents endpoint
      const payload = {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'chroma_add_documents',
          arguments: {
            collection_name: this.collectionName,
            documents: [learning.content],
            ids: [memoryId],
            metadatas: [learning.metadata],
          }
        },
        id: Date.now(),
      };

      const result = await this._httpPost(this.chromaMcpUrl, payload, 10000);
      
      if (result && !result.error) {
        return true;
      }
      
      // Fallback: Try direct ChromaDB API if MCP fails
      logger.debug(`[SwarmMemory] MCP store failed, trying direct ChromaDB API`);
      return await this._storeDirectChromaDB(memoryId, learning);
    } catch (error) {
      logger.warn(`[SwarmMemory] ChromaDB store failed: ${error.message}`);
      // Fallback to direct API
      try {
        return await this._storeDirectChromaDB(memoryId, learning);
      } catch (fallbackErr) {
        logger.warn(`[SwarmMemory] Direct ChromaDB store also failed: ${fallbackErr.message}`);
        return false;
      }
    }
  }

  /**
   * Store directly via ChromaDB REST API (fallback).
   * @private
   */
  async _storeDirectChromaDB(memoryId, learning) {
    const chromaHost = process.env.CHROMADB_HOST || 'chromadb';
    const chromaPort = process.env.CHROMADB_PORT || '8000';
    const baseUrl = `http://${chromaHost}:${chromaPort}`;
    
    // Ensure collection exists
    try {
      await this._httpPost(`${baseUrl}/api/v1/collections`, {
        name: this.collectionName,
        metadata: { description: 'Cross-ticket organizational memory for swarm agents' },
      }, 5000);
    } catch (e) {
      // Collection may already exist — that's fine
    }
    
    // Get collection ID
    const collections = await this._httpGet(`${baseUrl}/api/v1/collections`, 5000);
    const collection = (Array.isArray(collections) ? collections : []).find(c => c.name === this.collectionName);
    
    if (!collection) {
      logger.warn(`[SwarmMemory] Could not find or create collection ${this.collectionName}`);
      return false;
    }
    
    // Add document
    const addPayload = {
      ids: [memoryId],
      documents: [learning.content],
      metadatas: [learning.metadata],
    };
    
    await this._httpPost(`${baseUrl}/api/v1/collections/${collection.id}/add`, addPayload, 10000);
    return true;
  }

  /**
   * Query ChromaDB for similar documents.
   * @private
   */
  async _queryChromaDB(queryText) {
    try {
      const http = require('http');
      
      // Try ChromaDB MCP first
      const payload = {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'chroma_query_documents',
          arguments: {
            collection_name: this.collectionName,
            query_texts: [queryText.substring(0, 1000)],
            n_results: this.maxMemoriesPerQuery,
          }
        },
        id: Date.now(),
      };

      const result = await this._httpPost(this.chromaMcpUrl, payload, 10000);
      
      if (result && !result.error && result.result) {
        // Parse MCP response
        const content = result.result?.content;
        if (Array.isArray(content)) {
          const textContent = content.find(c => c.type === 'text');
          if (textContent?.text) {
            try {
              const parsed = JSON.parse(textContent.text);
              if (parsed.documents && parsed.documents[0]) {
                return parsed.documents[0].map((doc, i) => ({
                  content: doc,
                  metadata: parsed.metadatas?.[0]?.[i] || {},
                  distance: parsed.distances?.[0]?.[i] || 0,
                })).filter(m => m.distance < 1.5); // Filter by relevance
              }
            } catch (parseErr) {
              logger.debug(`[SwarmMemory] Failed to parse MCP query response: ${parseErr.message}`);
            }
          }
        }
      }
      
      // Fallback: Direct ChromaDB API
      return await this._queryDirectChromaDB(queryText);
    } catch (error) {
      logger.debug(`[SwarmMemory] MCP query failed, trying direct: ${error.message}`);
      try {
        return await this._queryDirectChromaDB(queryText);
      } catch (fallbackErr) {
        logger.debug(`[SwarmMemory] Direct query also failed: ${fallbackErr.message}`);
        return [];
      }
    }
  }

  /**
   * Query directly via ChromaDB REST API (fallback).
   * @private
   */
  async _queryDirectChromaDB(queryText) {
    const chromaHost = process.env.CHROMADB_HOST || 'chromadb';
    const chromaPort = process.env.CHROMADB_PORT || '8000';
    const baseUrl = `http://${chromaHost}:${chromaPort}`;
    
    // Get collection
    const collections = await this._httpGet(`${baseUrl}/api/v1/collections`, 5000);
    const collection = (Array.isArray(collections) ? collections : []).find(c => c.name === this.collectionName);
    
    if (!collection) return [];
    
    const queryPayload = {
      query_texts: [queryText.substring(0, 1000)],
      n_results: this.maxMemoriesPerQuery,
    };
    
    const result = await this._httpPost(`${baseUrl}/api/v1/collections/${collection.id}/query`, queryPayload, 10000);
    
    if (result && result.documents && result.documents[0]) {
      return result.documents[0].map((doc, i) => ({
        content: doc,
        metadata: result.metadatas?.[0]?.[i] || {},
        distance: result.distances?.[0]?.[i] || 0,
      })).filter(m => m.distance < 1.5);
    }
    
    return [];
  }

  /**
   * Format memories into a prompt-injectable block.
   * @private
   */
  _formatMemoryBlock(memories) {
    if (!memories || memories.length === 0) return '';
    
    let totalChars = 0;
    const formattedMemories = [];
    
    for (const memory of memories) {
      if (totalChars >= this.maxMemoryChars) break;
      
      const ticketName = memory.metadata?.ticketName || 'Past Ticket';
      const agentId = memory.metadata?.agentId || 'agent';
      const relevance = memory.distance ? `(relevance: ${(1 - memory.distance / 2).toFixed(1)})` : '';
      
      // Truncate individual memory if needed
      const content = memory.content.substring(0, 800);
      
      formattedMemories.push(`**${ticketName}** ${relevance} — Agent: ${agentId}\n${content}`);
      totalChars += content.length + ticketName.length + 50;
    }
    
    if (formattedMemories.length === 0) return '';
    
    return `\n\n## 🧠 Organizational Memory (Past Experiences)\n\nThe following learnings from similar past tickets may be relevant:\n\n${formattedMemories.join('\n\n---\n\n')}\n\n*Use these learnings to avoid past mistakes and build on proven approaches.*`;
  }

  /**
   * HTTP POST helper.
   * @private
   */
  async _httpPost(url, data, timeoutMs = 10000) {
    const http = require('http');
    const https = require('https');
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;
    
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(data);
      const req = client.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
        timeout: timeoutMs,
      }, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch { resolve(body); }
        });
      });
      
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout')); });
      req.write(postData);
      req.end();
    });
  }

  /**
   * HTTP GET helper.
   * @private
   */
  async _httpGet(url, timeoutMs = 5000) {
    const http = require('http');
    const https = require('https');
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;
    
    return new Promise((resolve, reject) => {
      const req = client.get({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname,
        timeout: timeoutMs,
      }, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch { resolve(body); }
        });
      });
      
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout')); });
    });
  }
}

/**
 * @description Default export exposing the SwarmMemoryService class so callers in
 * the queue-manager pipeline can construct an instance to store and recall
 * cross-ticket organizational memory.
 */
module.exports = SwarmMemoryService;
