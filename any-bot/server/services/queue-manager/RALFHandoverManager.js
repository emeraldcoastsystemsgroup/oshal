/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * RALFHandoverManager — RALF Developer Handover as Bot Memory
 * 
 * Implements the RALF (Rules And Logic Framework) pattern for persistent bot context:
 * - After each round, the bot WRITES a DEVELOPER_HANDOVER.md to workspace
 * - Before each round, the QM READS the previous handover and injects it into the prompt
 * - The QM generates an executive summary of all handovers for context injection
 * 
 * ## How It Works
 * ```
 * Bot completes work → writes handover to workspace/developer-handovers/
 *   ↓
 * QM picks up ticket for next round
 *   ↓
 * RALFHandoverManager.readHandovers(ticketId, workspaceTaskId)
 *   → scans developer-handovers/ folder
 *   → reads all handover files for this ticket
 *   → returns structured context
 *   ↓
 * RALFHandoverManager.generateSummary(handovers, ticket, phase, round)
 *   → builds executive summary of all work so far
 *   → includes: what's done, what's pending, key decisions, open concerns
 *   ↓
 * QM injects summary into next bot's start prompt
 * ```
 * 
 * ## File Naming Convention
 * `developer-handovers/{agentId}_PHASE_{phase}_ROUND_{round}.md`
 * 
 * Created: 2026-02-18 — Issue #012, PHASE_18
 */

const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

/**
 * @description Persists cross-round bot context using the RALF (Rules And Logic Framework)
 * pattern so that successive agents working the same ticket inherit each other's progress
 * instead of starting cold. Agents write a Developer Handover to the workspace after each
 * round; this manager reads those handovers, distills them into a Queue Manager executive
 * summary for prompt injection, supplies per-agent context recall, emits the mandatory
 * handover-writing instructions, and (as a fallback) writes a handover on the bot's behalf.
 * Optionally caches generated summaries in Redis to avoid recomputing them within a phase.
 * This is the exported (CommonJS) member of the module.
 */
class RALFHandoverManager {
  /**
   * @param {Object} opts
   * @param {Object} opts.redis - Redis client (for caching summaries)
   * @param {string} opts.workspaceRoot - Root workspace directory (default: /app/workspace)
   */
  constructor(opts = {}) {
    this.redis = opts.redis || null;
    this.workspaceRoot = opts.workspaceRoot || '/app/workspace';
  }

  /**
   * Read all handover documents for a ticket from its workspace
   * @param {string} ticketId - Plane ticket ID
   * @param {string} workspaceTaskId - Task folder ID (e.g., task_abc12345)
   * @returns {Array<{agentId: string, phase: number, round: number, content: string, filename: string, modifiedAt: Date}>}
   */
  readHandovers(ticketId, workspaceTaskId) {
    if (!workspaceTaskId) return [];

    const handoverDir = path.join(this.workspaceRoot, workspaceTaskId, 'developer-handovers');
    if (!fs.existsSync(handoverDir)) {
      logger.debug(`[RALFHandover] No developer-handovers/ dir for workspace ${workspaceTaskId}`);
      return [];
    }

    try {
      const files = fs.readdirSync(handoverDir)
        .filter(f => f.endsWith('.md'))
        .sort(); // Alphabetical = chronological due to naming convention

      const handovers = [];
      for (const filename of files) {
        try {
          const filePath = path.join(handoverDir, filename);
          const stat = fs.statSync(filePath);
          const content = fs.readFileSync(filePath, 'utf8');

          // Parse metadata from filename: {agentId}_PHASE_{n}_ROUND_{n}.md
          const parsed = this._parseHandoverFilename(filename);

          handovers.push({
            agentId: parsed.agentId || 'unknown',
            phase: parsed.phase || 0,
            round: parsed.round || 0,
            content: content,
            filename: filename,
            modifiedAt: stat.mtime,
            charCount: content.length,
          });
        } catch (readErr) {
          logger.debug(`[RALFHandover] Failed to read ${filename}: ${readErr.message}`);
        }
      }

      logger.info(`[RALFHandover] Read ${handovers.length} handover docs from workspace ${workspaceTaskId}`);
      return handovers;
    } catch (err) {
      logger.warn(`[RALFHandover] Failed to scan handover dir: ${err.message}`);
      return [];
    }
  }

  /**
   * Read the most recent handover for a specific agent on a ticket
   * Used for "You worked on this before" context recall
   * @param {string} agentId
   * @param {string} workspaceTaskId
   * @returns {Object|null} Most recent handover for this agent, or null
   */
  readAgentHandover(agentId, workspaceTaskId) {
    const allHandovers = this.readHandovers(null, workspaceTaskId);
    const agentHandovers = allHandovers
      .filter(h => h.agentId === agentId)
      .sort((a, b) => b.modifiedAt - a.modifiedAt); // Most recent first

    return agentHandovers.length > 0 ? agentHandovers[0] : null;
  }

  /**
   * Generate an executive summary of all handovers for injection into the next bot's prompt.
   * This is the QM's summary — structured, concise, actionable.
   * 
   * @param {Array} handovers - Array from readHandovers()
   * @param {Object} ticket - { id, name }
   * @param {number} currentPhase - Current phase number
   * @param {number} currentRound - Current round number
   * @param {Object} [opts] - { roleAssignments, complexity }
   * @returns {string} Formatted executive summary for prompt injection
   */
  generateSummary(handovers, ticket, currentPhase, currentRound, opts = {}) {
    const { roleAssignments = null, complexity = 'medium' } = opts;

    if (!handovers || handovers.length === 0) {
      return this._generateFreshStartSummary(ticket, currentPhase, currentRound, roleAssignments);
    }

    // Group handovers by phase
    const byPhase = new Map();
    for (const h of handovers) {
      const key = h.phase || 0;
      if (!byPhase.has(key)) byPhase.set(key, []);
      byPhase.get(key).push(h);
    }

    // Build summary sections
    const sections = [];

    sections.push(`═══════════════════════════════════════════
📋 QUEUE MANAGER EXECUTIVE SUMMARY
═══════════════════════════════════════════

**Ticket:** ${ticket.name || ticket.id}
**Current Phase:** ${currentPhase} | **Round:** ${currentRound}
**Complexity:** ${complexity}
**Total Handovers:** ${handovers.length} from ${new Set(handovers.map(h => h.agentId)).size} agent(s)`);

    // Role assignments
    if (roleAssignments) {
      sections.push(`
**Assigned Roles:**
${Object.entries(roleAssignments).map(([role, agentId]) => 
  `- **${role}:** ${Array.isArray(agentId) ? agentId.join(', ') : agentId}`
).join('\n')}`);
    }

    // Phase-by-phase work history
    sections.push(`\n═══════════════════════════════════════════
WORK HISTORY
═══════════════════════════════════════════`);

    const phaseNames = { 1: 'INTAKE', 2: 'PLANNING', 3: 'SPECIALIST_INPUT', 4: 'EXECUTION', 5: 'TESTING', 6: 'REVIEW', 7: 'DELIVERY' };

    for (const [phase, phaseHandovers] of [...byPhase.entries()].sort((a, b) => a[0] - b[0])) {
      sections.push(`\n### Phase ${phase}: ${phaseNames[phase] || 'UNKNOWN'}`);
      
      for (const h of phaseHandovers.sort((a, b) => a.round - b.round)) {
        // Extract key sections from handover content
        const extracted = this._extractHandoverSections(h.content);
        
        sections.push(`**Round ${h.round} — Agent: ${h.agentId}**`);
        if (extracted.whatIDid) {
          sections.push(`- Did: ${extracted.whatIDid}`);
        }
        if (extracted.whatsLeft) {
          sections.push(`- Remaining: ${extracted.whatsLeft}`);
        }
        if (extracted.keyContext) {
          sections.push(`- Context: ${extracted.keyContext}`);
        }
        if (extracted.status) {
          sections.push(`- Status: ${extracted.status}`);
        }
      }
    }

    // Most recent handover (full content, truncated)
    const mostRecent = handovers.sort((a, b) => b.modifiedAt - a.modifiedAt)[0];
    if (mostRecent) {
      const truncatedContent = mostRecent.content.length > 3000
        ? mostRecent.content.substring(0, 3000) + '\n\n*(handover truncated — full version in workspace)*'
        : mostRecent.content;

      sections.push(`\n═══════════════════════════════════════════
MOST RECENT HANDOVER (${mostRecent.agentId}, Phase ${mostRecent.phase} Round ${mostRecent.round})
═══════════════════════════════════════════

${truncatedContent}`);
    }

    // Instructions for current agent
    sections.push(`\n═══════════════════════════════════════════
YOUR TURN
═══════════════════════════════════════════

You are entering **Phase ${currentPhase}, Round ${currentRound}**.
- READ the work history above carefully
- BUILD ON previous agents' work — do NOT repeat it
- WRITE your own Developer Handover when done (see format below)
- Your handover file: \`developer-handovers/${'{agentId}'}_PHASE_${currentPhase}_ROUND_${currentRound}.md\`

═══════════════════════════════════════════`);

    return sections.join('\n');
  }

  /**
   * Generate context recall prompt for an agent who has worked on this ticket before
   * @param {Object} previousHandover - From readAgentHandover()
   * @param {string} agentId
   * @returns {string} Context recall block for prompt injection
   */
  generateContextRecall(previousHandover, agentId) {
    if (!previousHandover) return '';

    const truncated = previousHandover.content.length > 2000
      ? previousHandover.content.substring(0, 2000) + '\n\n*(truncated)*'
      : previousHandover.content;

    return `═══════════════════════════════════════════
🧠 CONTEXT RECALL — You've worked on this before
═══════════════════════════════════════════

Agent **${agentId}**, you previously contributed to this ticket.
Here is your last Developer Handover (Phase ${previousHandover.phase}, Round ${previousHandover.round}):

${truncated}

**Pick up where you left off.** Build on your previous work.
═══════════════════════════════════════════`;
  }

  /**
   * Write a handover document to workspace (called by QM on behalf of bot)
   * This is a fallback — normally the bot writes its own handover.
   * But if the bot doesn't write one, QM extracts key info and writes it.
   * 
   * @param {string} workspaceTaskId
   * @param {string} agentId
   * @param {number} phase
   * @param {number} round
   * @param {string} content - Handover content (full agent response or extracted handover)
   * @returns {string|null} Path to written file, or null on failure
   */
  writeHandover(workspaceTaskId, agentId, phase, round, content) {
    if (!workspaceTaskId) return null;

    try {
      const handoverDir = path.join(this.workspaceRoot, workspaceTaskId, 'developer-handovers');
      if (!fs.existsSync(handoverDir)) {
        fs.mkdirSync(handoverDir, { recursive: true });
      }

      const filename = `${agentId}_PHASE_${phase}_ROUND_${round}.md`;
      const filePath = path.join(handoverDir, filename);

      // Extract handover section from agent response if full response provided
      const handoverContent = this._extractOrFormatHandover(content, agentId, phase, round);

      fs.writeFileSync(filePath, handoverContent, 'utf8');
      logger.info(`[RALFHandover] Wrote handover: ${filename} (${handoverContent.length} chars)`);
      return filePath;
    } catch (err) {
      logger.warn(`[RALFHandover] Failed to write handover: ${err.message}`);
      return null;
    }
  }

  /**
   * Generate the handover writing instruction block that gets injected into every agent prompt.
   * Tells the bot exactly how to write its RALF handover.
   * @param {string} agentId
   * @param {number} phase
   * @param {number} round
   * @returns {string}
   */
  getHandoverInstructions(agentId, phase, round) {
    return `═══════════════════════════════════════════
📝 MANDATORY: RALF DEVELOPER HANDOVER
═══════════════════════════════════════════

After completing your work, you MUST write a Developer Handover file.

**Write to:** \`developer-handovers/${agentId}_PHASE_${phase}_ROUND_${round}.md\`

**Required format:**

\`\`\`markdown
# Developer Handover — ${agentId}
**Phase:** ${phase} | **Round:** ${round}
**Timestamp:** [current time]
**Status:** Complete | Partial

## What I Did
- [Concrete actions taken]

## What I Produced
- [Files created/modified, deliverables]

## Decisions Made
- [Key technical or design decisions]

## Open Concerns
- [Risks, blockers, things the next agent should watch for]

## What's Left To Do
- [Remaining work, or "Nothing — fully complete"]

## Key Context for Next Agent
- [Critical information the next agent MUST know]
\`\`\`

**This handover IS your memory.** The next agent will read it before starting.
If you don't write a handover, context is lost and work gets repeated.

═══════════════════════════════════════════`;
  }

  /**
   * Cache a generated summary in Redis for reuse within the same phase
   * @param {string} ticketId
   * @param {number} phase
   * @param {string} summary
   */
  async cacheSummary(ticketId, phase, summary) {
    if (!this.redis) return;
    try {
      const key = `qm:handover_summary:${ticketId}:${phase}`;
      await this.redis.set(key, summary, 'EX', 3600); // 1h TTL
    } catch (err) {
      logger.debug(`[RALFHandover] Cache summary failed: ${err.message}`);
    }
  }

  /**
   * Get cached summary
   * @param {string} ticketId
   * @param {number} phase
   * @returns {Promise<string|null>}
   */
  async getCachedSummary(ticketId, phase) {
    if (!this.redis) return null;
    try {
      const key = `qm:handover_summary:${ticketId}:${phase}`;
      return await this.redis.get(key);
    } catch (err) {
      return null;
    }
  }

  // ── Private Methods ──────────────────────────────────────────────

  /**
   * Parse handover filename into components
   * Format: {agentId}_PHASE_{n}_ROUND_{n}.md
   * Also supports legacy formats from existing code
   * @private
   */
  _parseHandoverFilename(filename) {
    // New format: agentId_PHASE_2_ROUND_1.md
    const newMatch = filename.match(/^(.+?)_PHASE_(\d+)_ROUND_(\d+)\.md$/);
    if (newMatch) {
      return { agentId: newMatch[1], phase: parseInt(newMatch[2]), round: parseInt(newMatch[3]) };
    }

    // Legacy format: REVIEW_CYCLE_ROUND_01_agentId.md
    const legacyMatch = filename.match(/^REVIEW_CYCLE_ROUND_(\d+)_(.+?)\.md$/);
    if (legacyMatch) {
      return { agentId: legacyMatch[2], phase: 6, round: parseInt(legacyMatch[1]) };
    }

    // Legacy format: TICKET-xxx.SUBTASK-xxx.SESSION-01-developer-handover.md
    const subtaskMatch = filename.match(/SESSION-(\d+)-developer-handover\.md$/);
    if (subtaskMatch) {
      return { agentId: 'unknown', phase: 0, round: parseInt(subtaskMatch[1]) };
    }

    // Unknown format — extract what we can
    return { agentId: filename.replace('.md', ''), phase: 0, round: 0 };
  }

  /**
   * Extract key sections from a handover markdown document
   * @private
   */
  _extractHandoverSections(content) {
    const result = {
      whatIDid: null,
      whatsLeft: null,
      keyContext: null,
      status: null,
    };

    // Extract "What I Did" section
    const whatIDidMatch = content.match(/##?\s*What I Did\s*\n([\s\S]*?)(?=\n##|\n---|\Z)/i);
    if (whatIDidMatch) {
      result.whatIDid = this._summarizeSection(whatIDidMatch[1]);
    }

    // Extract "What's Left" section
    const whatsLeftMatch = content.match(/##?\s*What'?s Left\s*(?:To Do)?\s*\n([\s\S]*?)(?=\n##|\n---|\Z)/i);
    if (whatsLeftMatch) {
      result.whatsLeft = this._summarizeSection(whatsLeftMatch[1]);
    }

    // Extract "Key Context" section
    const keyContextMatch = content.match(/##?\s*Key Context\s*(?:for Next Agent)?\s*\n([\s\S]*?)(?=\n##|\n---|\Z)/i);
    if (keyContextMatch) {
      result.keyContext = this._summarizeSection(keyContextMatch[1]);
    }

    // Extract status
    const statusMatch = content.match(/\*\*Status:\*\*\s*(.+)/i);
    if (statusMatch) {
      result.status = statusMatch[1].trim();
    }

    return result;
  }

  /**
   * Summarize a section to ~200 chars (first few bullet points)
   * @private
   */
  _summarizeSection(sectionText) {
    const lines = sectionText.trim().split('\n')
      .filter(l => l.trim())
      .slice(0, 3)
      .map(l => l.trim().replace(/^[-*•]\s*/, ''));
    
    const summary = lines.join('; ');
    return summary.length > 200 ? summary.substring(0, 200) + '...' : summary;
  }

  /**
   * Generate summary for a fresh start (no previous handovers)
   * @private
   */
  _generateFreshStartSummary(ticket, currentPhase, currentRound, roleAssignments) {
    const phaseNames = { 1: 'INTAKE', 2: 'PLANNING', 3: 'SPECIALIST_INPUT', 4: 'EXECUTION', 5: 'TESTING', 6: 'REVIEW', 7: 'DELIVERY' };

    let summary = `═══════════════════════════════════════════
📋 QUEUE MANAGER EXECUTIVE SUMMARY
═══════════════════════════════════════════

**Ticket:** ${ticket.name || ticket.id}
**Current Phase:** ${currentPhase} (${phaseNames[currentPhase] || 'UNKNOWN'}) | **Round:** ${currentRound}
**Status:** Fresh start — no previous work on this ticket`;

    if (roleAssignments) {
      summary += `\n\n**Assigned Roles:**\n${Object.entries(roleAssignments).map(([role, agentId]) => 
        `- **${role}:** ${Array.isArray(agentId) ? agentId.join(', ') : agentId}`
      ).join('\n')}`;
    }

    summary += `\n\n═══════════════════════════════════════════
YOUR TURN
═══════════════════════════════════════════

You are the first agent on this ticket. Read the ticket description carefully and begin work.
Write a Developer Handover when complete — it will be read by the next agent.

═══════════════════════════════════════════`;

    return summary;
  }

  /**
   * Extract handover section from full agent response, or format as handover if not found
   * @private
   */
  _extractOrFormatHandover(content, agentId, phase, round) {
    // Try to find existing handover section
    const handoverMatch = content.match(/##?\s*(?:🔄\s*)?Developer Handover[\s\S]*/i);
    if (handoverMatch) {
      return handoverMatch[0];
    }

    // No handover section found — create a minimal one from the response
    const truncated = content.length > 2000 ? content.substring(0, 2000) + '\n\n*(truncated)*' : content;
    
    return `# Developer Handover — ${agentId}
**Phase:** ${phase} | **Round:** ${round}
**Timestamp:** ${new Date().toISOString()}
**Status:** Auto-generated (agent did not write explicit handover)

## What I Did
(Extracted from agent response — see full response in Plane comments)

## Agent Response Summary
${truncated}

## What's Left To Do
- Review by next agent required

## Key Context for Next Agent
- This handover was auto-generated because the agent did not write one explicitly
- Check Plane comments for the full response
`;
  }
}

module.exports = RALFHandoverManager;
