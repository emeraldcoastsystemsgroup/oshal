/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * ClineIntegration - Cline CLI integration for codebase-aware ticket processing
 * Helper module to add Cline CLI support to QueueManagerService
 * 
 * Note: MCP servers are configured via ~/.cline/mcp_settings.json at container startup
 * by setup-cline-auth.sh script. Cline CLI reads this configuration automatically.
 * 
 * Key fixes (PHASE_05):
 * - Retry with exponential backoff for intermittent exit code 1 failures
 * - Pre-flight config validation before spawning Cline CLI
 * - Enhanced stderr capture and diagnostic logging
 * - Configurable retry count and backoff delays
 */

const fs = require('fs');
const path = require('path');
const ClineCLIWrapper = require('../codebase/ClineCLIWrapper');
const TicketProcessor = require('./TicketProcessor');
const logger = require('../../utils/logger');

/**
 * @description Adapter that lets QueueManagerService delegate Plane-ticket work to the
 * Cline CLI so the agent can reason over the actual codebase (and any configured MCP
 * tools). Exists to make that delegation resilient: it pre-validates auth/config before
 * spawning the subprocess, classifies failures as retryable vs. fatal, and feeds
 * continuation context into retries after a context-exhaustion stall so the agent
 * resumes rather than restarting from scratch.
 */
class ClineIntegration {
  /**
   * @description Configure retry/backoff behavior for ticket processing. Defaults are
   * tuned to absorb the intermittent exit-code-1 and throttling failures observed in
   * production while keeping the worst-case retry budget bounded.
   * @param {Object} [options={}] - Optional overrides for retry tuning.
   * @param {number} [options.maxRetries=2] - Additional attempts after the first (total attempts = maxRetries + 1).
   * @param {number} [options.retryDelayMs=3000] - Initial backoff delay before the first retry, in milliseconds.
   * @param {number} [options.retryBackoffMultiplier=2] - Exponential multiplier applied to the delay per retry.
   */
  constructor(options = {}) {
    this.clineWrapper = new ClineCLIWrapper();
    this.maxRetries = options.maxRetries || 2; // Total attempts = maxRetries + 1
    this.retryDelayMs = options.retryDelayMs || 3000; // 3 seconds initial delay
    this.retryBackoffMultiplier = options.retryBackoffMultiplier || 2; // Exponential backoff
  }

  /**
   * Check if Cline CLI is available
   * @returns {Promise<{available: boolean, version: string|null}>}
   */
  async checkAvailability() {
    try {
      const available = await this.clineWrapper.isAvailable();
      const version = available ? await this.clineWrapper.getVersion() : null;
      
      logger.info(`Cline CLI availability check: ${available ? `v${version}` : 'Not available'}`);
      
      return { available, version };
    } catch (error) {
      logger.error(`Error checking Cline CLI availability: ${error.message}`);
      return { available: false, version: null };
    }
  }

  /**
   * Pre-flight validation: check that all required Cline CLI config files exist
   * This catches auth issues BEFORE spawning the subprocess
   * @returns {{valid: boolean, issues: string[]}}
   */
  validateConfig() {
    const homeDir = process.env.HOME || '/root';
    const issues = [];

    // Check globalState.json (contains API provider config)
    const globalStatePath = path.join(homeDir, '.cline', 'data', 'globalState.json');
    if (!fs.existsSync(globalStatePath)) {
      issues.push(`Missing globalState.json at ${globalStatePath} — run setup-cline-auth.sh`);
    } else {
      try {
        const state = JSON.parse(fs.readFileSync(globalStatePath, 'utf8'));
        if (!state.awsAccessKey && !state.awsProfile) {
          issues.push('globalState.json exists but has no AWS credentials (awsAccessKey or awsProfile)');
        }
        if (!state.actModeApiProvider) {
          issues.push('globalState.json missing actModeApiProvider');
        }
      } catch (e) {
        issues.push(`globalState.json parse error: ${e.message}`);
      }
    }

    // Check config.json
    const configPath = path.join(homeDir, '.cline', 'config.json');
    if (!fs.existsSync(configPath)) {
      issues.push(`Missing config.json at ${configPath} — run setup-cline-auth.sh`);
    }

    // Check MCP settings (optional but important)
    const mcpPath = path.join(homeDir, '.cline', 'mcp_settings.json');
    if (!fs.existsSync(mcpPath)) {
      logger.warn('ClineIntegration: MCP settings not found — Cline CLI will run without MCP tools');
    }

    // Check AWS environment variables
    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
      issues.push('AWS credentials not in environment (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)');
    }
    if (!process.env.AWS_REGION) {
      issues.push('AWS_REGION not set in environment');
    }

    // Check patched cline wrapper exists
    const patchedCline = path.join(homeDir, '.local', 'bin', 'cline');
    if (!fs.existsSync(patchedCline)) {
      logger.warn('ClineIntegration: Patched cline wrapper not found at ~/.local/bin/cline — using system cline');
    }

    if (issues.length > 0) {
      logger.error(`ClineIntegration: Pre-flight validation failed (${issues.length} issues):`);
      issues.forEach((issue, i) => logger.error(`  ${i + 1}. ${issue}`));
    } else {
      logger.info('ClineIntegration: Pre-flight validation passed ✓');
    }

    return { valid: issues.length === 0, issues };
  }

  /**
   * Sleep utility for retry backoff
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Classify an error to determine if it's retryable
   * @param {Error} error - The error from Cline CLI
   * @returns {boolean} True if the error is transient and worth retrying
   */
  _isRetryableError(error) {
    const msg = error.message || '';
    
    // Retryable: stall/inactivity circuit breaker (Cline ran out of context or got stuck)
    if (msg.includes('stalled') || msg.includes('INACTIVITY')) return true;
    
    // Retryable: hard timeout (Cline was working but hit wall clock)
    if (msg.includes('hard timeout') || msg.includes('HARD TIMEOUT')) return true;
    
    // Retryable: exit code 1 (generic failure — often transient auth/init issues)
    if (msg.includes('exited with code 1')) return true;
    
    // Retryable: Bedrock throttling
    if (msg.includes('ThrottlingException') || msg.includes('rate exceeded')) return true;
    
    // Retryable: network/timeout issues
    if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('socket hang up')) return true;
    
    // Retryable: MCP server initialization failures
    if (msg.includes('MCP') && msg.includes('failed to start')) return true;

    // NOT retryable: spawn failures, missing binary, permission errors
    if (msg.includes('ENOENT') || msg.includes('EACCES') || msg.includes('Failed to spawn')) return false;
    
    // Default: retry for unknown exit code 1 errors
    if (msg.includes('exited with code')) return true;
    
    return false;
  }

  /**
   * Determine if an error was a stall/timeout (context exhaustion).
   * These need a continuation prompt rather than a blind retry.
   * @param {Error} error - The error from Cline CLI
   * @returns {boolean}
   */
  _isContextExhaustion(error) {
    const msg = error.message || '';
    return msg.includes('stalled') || msg.includes('INACTIVITY') || 
           msg.includes('hard timeout') || msg.includes('HARD TIMEOUT');
  }

  /**
   * Extract partial work summary from streaming messages collected before a stall/timeout.
   * Looks for the last meaningful output from the agent.
   * @param {Array} messages - NDJSON messages from ClineCLIWrapper streaming
   * @param {object} activityStats - Activity stats from the tracker
   * @returns {string} Human-readable summary of partial work
   */
  _extractPartialWork(messages, activityStats) {
    if (!messages || messages.length === 0) {
      return 'No output was produced before the session ended.';
    }

    const parts = [];

    // Stats summary
    if (activityStats) {
      parts.push(`Session ran for ${activityStats.elapsedFormatted}, produced ${activityStats.totalMessages} messages, used ${activityStats.toolUseCount} tools, had ${activityStats.thinkingCount} thinking blocks.`);
    }

    // Find last completion_result or text content
    const completionMsgs = messages.filter(m => m.type === 'completion_result');
    if (completionMsgs.length > 0) {
      const last = completionMsgs[completionMsgs.length - 1];
      parts.push(`Last completion attempt: ${(last.text || JSON.stringify(last)).substring(0, 500)}`);
    }

    // Find last substantive text output
    const textMsgs = messages.filter(m => m.type === 'text' || m.type === 'assistant');
    if (textMsgs.length > 0) {
      const last = textMsgs[textMsgs.length - 1];
      const text = last.text || last.content || JSON.stringify(last);
      parts.push(`Last agent output: ${text.substring(0, 500)}`);
    }

    // Find tool uses (what files were touched)
    const toolMsgs = messages.filter(m => m.type === 'tool_use');
    if (toolMsgs.length > 0) {
      const toolNames = toolMsgs.map(m => m.name || m.tool || 'unknown');
      const uniqueTools = [...new Set(toolNames)];
      parts.push(`Tools used: ${uniqueTools.join(', ')} (${toolMsgs.length} total calls)`);
      
      // Last tool use for context
      const lastTool = toolMsgs[toolMsgs.length - 1];
      parts.push(`Last tool call: ${lastTool.name || lastTool.tool || 'unknown'}`);
    }

    return parts.join('\n') || 'Session produced output but no extractable work summary.';
  }

  /**
   * Build a continuation prompt that includes context from a failed previous attempt.
   * This gives the next Cline session awareness of what happened.
   * @param {string} originalPrompt - The original task prompt
   * @param {string} failureReason - Why the previous attempt failed (stall/timeout/error)
   * @param {string} partialWork - Summary of work done before failure
   * @param {number} attemptNumber - Which retry this is (1-indexed)
   * @returns {string} Enhanced prompt with failure context
   */
  _buildContinuationPrompt(originalPrompt, failureReason, partialWork, attemptNumber) {
    return `⚠️ CONTINUATION FROM PREVIOUS SESSION (Attempt ${attemptNumber})

The previous session on this ticket ended because: ${failureReason}

Here is what was accomplished before the session ended:
---
${partialWork}
---

IMPORTANT INSTRUCTIONS FOR THIS CONTINUATION:
1. Review the workspace for any partial work from the previous session
2. Do NOT start from scratch — continue where the previous session left off
3. If the previous session ran out of context, focus on completing the MOST IMPORTANT remaining work first
4. Keep your responses concise to avoid hitting context limits again
5. If the task is too large for one session, complete the highest-priority portion and use attempt_completion to summarize what was done and what remains

ORIGINAL TASK:
${originalPrompt}`;
  }

  /**
   * Process Plane ticket using Cline CLI with full codebase awareness
   * Includes retry logic for intermittent failures (exit code 1)
   * Cline CLI automatically loads MCP servers from ~/.cline/mcp_settings.json
   * @param {Object} task - Task object
   * @param {Object} ticket - Plane ticket object
   * @param {string|null} agentId - Optional agent ID for persona injection
   * @returns {Promise<Object>} - Result object with success, result text, and metadata
   */
  async processTicket(task, ticket, agentId = null) {
    logger.info(`Processing ticket ${ticket.id} with Cline CLI (codebase-aware + MCP tools)${agentId ? ` as ${agentId}` : ''}`);
    
    // Pre-flight validation
    const configCheck = this.validateConfig();
    if (!configCheck.valid) {
      logger.error(`ClineIntegration: Config validation failed for ticket ${ticket.id} — ${configCheck.issues.length} issues`);
      throw new Error(`Cline CLI config invalid: ${configCheck.issues.join('; ')}`);
    }

    // Build comprehensive prompt from ticket with persona injection
    const prompt = TicketProcessor.buildTicketPrompt(ticket, task, agentId);
    const workspaceDir = task.workspace_dir || path.join('/app/workspace', task.id);
    
    // FIX: EISDIR prevention — ensure workspace dir exists and has a readable file
    // Cline CLI sometimes does read_file on the workspace path itself, causing EISDIR
    try {
      if (!fs.existsSync(workspaceDir)) {
        fs.mkdirSync(workspaceDir, { recursive: true });
        logger.info(`ClineIntegration: Created workspace directory: ${workspaceDir}`);
      }
      
      // Check if directory is empty or has no readable file at root
      const wsFiles = fs.readdirSync(workspaceDir).filter(f => {
        try { return fs.statSync(path.join(workspaceDir, f)).isFile(); } catch { return false; }
      });
      
      if (wsFiles.length === 0) {
        // Create a minimal README so Cline has something to read_file on
        const readmePath = path.join(workspaceDir, 'README.md');
        fs.writeFileSync(readmePath, `# Agent Workspace\n\nThis workspace is used for Plane ticket #${ticket.id}: ${ticket.name || 'Untitled'}\n\nAgent will create files here as needed.\n`);
        logger.info(`ClineIntegration: Created workspace README.md to prevent EISDIR errors`);
      }
    } catch (wsErr) {
      logger.warn(`ClineIntegration: Workspace prep warning: ${wsErr.message}`);
      // Non-fatal — continue with processing
    }

    let lastError = null;
    let currentPrompt = prompt; // May be replaced with continuation prompt on stall retries
    let previousAttemptMessages = []; // Messages from the previous attempt (for context extraction)
    let previousAttemptStats = null; // Activity stats from previous attempt
    
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = this.retryDelayMs * Math.pow(this.retryBackoffMultiplier, attempt - 1);
          logger.info(`ClineIntegration: Retry ${attempt}/${this.maxRetries} for ticket ${ticket.id} after ${delay}ms delay`);
          await this._sleep(delay);

          // If the previous failure was a stall/timeout, build a continuation prompt
          // with context about what was accomplished
          if (lastError && this._isContextExhaustion(lastError)) {
            const failureReason = lastError.message.includes('stalled') 
              ? 'Session stalled — no output for 3 minutes (likely hit context window limit or got stuck)'
              : 'Session hit the hard timeout limit (task took too long)';
            
            const partialWork = this._extractPartialWork(previousAttemptMessages, previousAttemptStats);
            currentPrompt = this._buildContinuationPrompt(prompt, failureReason, partialWork, attempt + 1);
            
            logger.info(`ClineIntegration: Built continuation prompt for ticket ${ticket.id} (attempt ${attempt + 1}) with ${partialWork.length} chars of context from previous session`);
          }
        }

        logger.info(`ClineIntegration: Attempt ${attempt + 1}/${this.maxRetries + 1} for ticket ${ticket.id}${attempt > 0 && lastError && this._isContextExhaustion(lastError) ? ' (CONTINUATION with context)' : ''}`);
        
        // Execute via Cline CLI streaming mode — captures messages for partial work extraction
        const collectedMessages = [];
        const result = await this.clineWrapper.executeTaskStreaming(
          currentPrompt,
          workspaceDir,
          { 
            timeout: 3600, // 1 hour hard max (safety net)
            inactivityTimeout: 180, // 3 min inactivity = stalled
            onMessage: (msg) => {
              collectedMessages.push(msg);
            },
          }
        );
        
        // Extract result text from streaming messages
        let resultText = '';
        
        // Look for completion_result messages first
        const completions = result.messages.filter(m => m.type === 'completion_result');
        if (completions.length > 0) {
          resultText = completions[completions.length - 1].text || JSON.stringify(completions[completions.length - 1]);
        } else {
          // Fallback: last text/assistant message
          const textMsgs = result.messages.filter(m => m.type === 'text' || m.type === 'assistant');
          if (textMsgs.length > 0) {
            resultText = textMsgs[textMsgs.length - 1].text || textMsgs[textMsgs.length - 1].content || '';
          } else {
            resultText = result.raw || 'Cline completed but produced no extractable text.';
          }
        }

        if (!result.success) {
          // Streaming finished but with failure flags (stalledOut or timedOut)
          // Store messages for context extraction in next retry
          previousAttemptMessages = result.messages;
          previousAttemptStats = result.activityStats;
          
          const reason = result.stalledOut ? 'stalled (inactivity circuit breaker)' : 
                         result.timedOut ? 'hard timeout' : `exit code ${result.exitCode}`;
          throw new Error(`Cline CLI ${reason}. Stats: ${JSON.stringify(result.activityStats)}`);
        }
        
        logger.info(`✓ Cline CLI completed ticket ${ticket.id} on attempt ${attempt + 1} (${resultText.length} chars, ${result.activityStats?.totalMessages || 0} messages, ${result.activityStats?.toolUseCount || 0} tools)`);
        
        return {
          success: true,
          result: resultText,
          usedClineCLI: true,
          codebaseAware: true,
          metadata: {
            processingMethod: 'ClineCLI_Streaming',
            workspaceDir,
            promptLength: currentPrompt.length,
            resultLength: resultText.length,
            attempt: attempt + 1,
            totalAttempts: attempt + 1,
            wasContinuation: attempt > 0 && lastError && this._isContextExhaustion(lastError),
            activityStats: result.activityStats,
          }
        };
        
      } catch (error) {
        lastError = error;
        logger.warn(`ClineIntegration: Attempt ${attempt + 1} failed for ticket ${ticket.id}: ${error.message}`);
        
        // Log stderr content if available in the error
        if (error.message.includes('stderr:')) {
          const stderrMatch = error.message.match(/stderr: ([\s\S]*?)(?:\nstdout:|$)/);
          if (stderrMatch) {
            logger.error(`ClineIntegration: stderr from attempt ${attempt + 1}: ${stderrMatch[1].trim().substring(0, 1000)}`);
          }
        }

        // Check if error is retryable
        if (!this._isRetryableError(error)) {
          logger.error(`ClineIntegration: Non-retryable error for ticket ${ticket.id}, giving up immediately`);
          break;
        }

        if (attempt === this.maxRetries) {
          logger.error(`ClineIntegration: All ${this.maxRetries + 1} attempts exhausted for ticket ${ticket.id}`);
          
          // On final failure, attach partial work info to the error for upstream consumers
          if (this._isContextExhaustion(error) && previousAttemptMessages.length > 0) {
            const partialWork = this._extractPartialWork(previousAttemptMessages, previousAttemptStats);
            error.partialWork = partialWork;
            error.activityStats = previousAttemptStats;
            error.wasContextExhaustion = true;
            logger.info(`ClineIntegration: Attached partial work context (${partialWork.length} chars) to final error for ticket ${ticket.id}`);
          }
        }
      }
    }
    
    // All attempts failed — throw the last error to trigger AgenticController fallback
    throw lastError || new Error(`Cline CLI failed after ${this.maxRetries + 1} attempts`);
  }
}

module.exports = ClineIntegration;