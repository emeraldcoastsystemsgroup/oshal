/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * FrontDoorClient - HTTP client for calling any-bot's front door API
 * 
 * Provides a unified interface for all services to route LLM requests through
 * the proven /api/tasks/:taskId/messages endpoint, ensuring consistent persona
 * injection via AgenticController.
 * 
 * This replaces direct BedrockProvider calls and Cline CLI spawning with
 * HTTP calls to any-bot's own API, creating a self-contained, self-referencing
 * architecture where any-bot is the brain for all LLM requests.
 */

const http = require('http');
const logger = require('../utils/logger');

/**
 * @description Self-referencing HTTP client that lets any-bot's own services
 * (queue, mesh, router, etc.) issue LLM requests by calling any-bot's public
 * front door API instead of talking to providers directly. Centralizing every
 * request through the /api/tasks endpoints guarantees uniform persona injection
 * and metrics handling via AgenticController, so a single brain governs all LLM
 * traffic rather than each caller re-implementing provider plumbing.
 */
class FrontDoorClient {
  /**
   * @param {string} baseUrl - Base URL for any-bot API (default: http://localhost:5000)
   * @param {number} timeout - Request timeout in ms (default: 300000 = 5 min)
   */
  constructor(baseUrl = null, timeout = 300000) {
    // Auto-detect base URL from environment
    const port = process.env.PORT || '5000';
    this.baseUrl = baseUrl || `http://localhost:${port}`;
    this.timeout = timeout;
    
    logger.info(`[FrontDoorClient] Initialized with baseUrl: ${this.baseUrl}, timeout: ${timeout}ms`);
  }

  /**
   * Create a new task via the front door API
   * @param {string} description - Task description
   * @param {string} mode - Task mode ('act' or 'plan')
   * @returns {Promise<object>} - { success: true, task: { id, ... } }
   */
  async createTask(description, mode = 'act') {
    try {
      const postData = JSON.stringify({
        text: description,
        mode: mode,
      });

      const result = await this._httpRequest('POST', '/api/tasks', postData);
      
      if (!result.success || !result.task) {
        throw new Error(`Task creation failed: ${result.error || 'Unknown error'}`);
      }

      logger.info(`[FrontDoorClient] Task created: ${result.task.id}`);
      return result;
    } catch (error) {
      logger.error(`[FrontDoorClient] createTask failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Send a message to an existing task via the front door API
   * This is the CORE method - routes through AgenticController with persona
   * 
   * @param {string} taskId - Task ID
   * @param {string} text - Message text (prompt)
   * @param {object} options - Message options
   * @param {object} options.autoApprove - Auto-approval settings
   * @param {boolean} options.agenticMode - Enable agentic loop (default: true)
   * @param {string} options.source - Source identifier (e.g., 'queue', 'mesh', 'router')
   * @returns {Promise<object>} - { success: true, result: { ... } }
   */
  async sendMessage(taskId, text, options = {}) {
    try {
      const postData = JSON.stringify({
        text: text,
        images: options.images || [],
        files: options.files || [],
        autoApprove: options.autoApprove || {},
        agenticMode: options.agenticMode !== false, // Default true
        source: options.source || 'front-door-client',
      });

      const result = await this._httpRequest('POST', `/api/tasks/${taskId}/messages`, postData);
      
      if (!result.success) {
        throw new Error(`Message send failed: ${result.error || 'Unknown error'}`);
      }

      logger.info(`[FrontDoorClient] Message sent to task ${taskId} (${text.length} chars)`);
      return result;
    } catch (error) {
      logger.error(`[FrontDoorClient] sendMessage failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Extract response text from API result
   * Handles the nested result structure from AgenticController
   * 
   * @param {object} apiResult - Result from sendMessage()
   * @returns {string} - Extracted response text
   */
  extractResponse(apiResult) {
    try {
      // AgenticController returns: { success: true, result: { success, result: { result: "text" }, ... } }
      const innerResult = apiResult.result?.result;
      
      if (innerResult && innerResult.result) {
        return innerResult.result;
      }
      
      // Fallback: check messages array
      if (apiResult.result?.messages && Array.isArray(apiResult.result.messages)) {
        const completionMsg = apiResult.result.messages.find(m => 
          m.say === 'completion_result' && m.text
        );
        if (completionMsg) {
          return completionMsg.text;
        }
        
        // Last resort: concatenate text messages
        const textMsgs = apiResult.result.messages.filter(m => m.text && m.say === 'text');
        if (textMsgs.length > 0) {
          return textMsgs.map(m => m.text).join('\n\n');
        }
      }
      
      // No response found
      logger.warn('[FrontDoorClient] Could not extract response from API result');
      return 'No response extracted';
    } catch (error) {
      logger.error(`[FrontDoorClient] extractResponse failed: ${error.message}`);
      return 'Response extraction error';
    }
  }

  /**
   * Extract API metrics from result
   * @param {object} apiResult - Result from sendMessage()
   * @returns {object} - { totalTokens, totalCost, requestCount, turns }
   */
  extractMetrics(apiResult) {
    try {
      const metrics = apiResult.result?.apiMetrics || {};
      const turns = apiResult.result?.turns || 0;
      
      return {
        totalTokens: metrics.totalTokens || 0,
        totalCost: metrics.totalCost || 0,
        requestCount: metrics.requestCount || 0,
        cacheHits: metrics.cacheHits || 0,
        turns: turns,
      };
    } catch (error) {
      logger.warn(`[FrontDoorClient] extractMetrics failed: ${error.message}`);
      return { totalTokens: 0, totalCost: 0, requestCount: 0, cacheHits: 0, turns: 0 };
    }
  }

  /**
   * Make HTTP request to any-bot API
   * @private
   */
  async _httpRequest(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + path);
      
      const options = {
        hostname: url.hostname,
        port: url.port || 5000,
        path: url.pathname,
        method: method,
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: this.timeout,
      };

      if (body) {
        options.headers['Content-Length'] = Buffer.byteLength(body);
      }

      const req = http.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch (parseErr) {
            logger.error(`[FrontDoorClient] Failed to parse response: ${parseErr.message}`);
            resolve({ success: false, error: 'Invalid JSON response', raw: data });
          }
        });
      });

      req.on('error', (error) => {
        logger.error(`[FrontDoorClient] HTTP request error: ${error.message}`);
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request timeout after ${this.timeout}ms`));
      });

      if (body) {
        req.write(body);
      }
      
      req.end();
    });
  }

  /**
   * Test connection to front door API
   * @returns {Promise<boolean>} - true if API is reachable
   */
  async testConnection() {
    try {
      const result = await this._httpRequest('GET', '/api/health');
      return result.status === 'ok';
    } catch (error) {
      logger.warn(`[FrontDoorClient] Connection test failed: ${error.message}`);
      return false;
    }
  }
}

module.exports = FrontDoorClient;
