/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from QueueManagerService.js (1000-line cap decomposition): completion evaluation (substantive-vs-outline detection), user-facing summary generation, completion reporting, human escalation, and ticket description extraction
 */

/**
 * CompletionReporter — completion evaluation and reporting helpers of the queue manager.
 *
 * Extracted verbatim from QueueManagerService for the 1000-code-line cap.
 * Every method is static and takes the live QueueManagerService instance
 * (`svc`) as its first argument — `svc` carries all state and collaborators
 * (redis, planeDb, phaseManager, commentFormatter, ...) exactly as `this` did
 * before extraction. QueueManagerService keeps same-named delegate methods, so
 * the public API and behavior (including dynamic dispatch through the class)
 * are unchanged.
 */

const logger = require('../../utils/logger');
const { getQueueManagerUserId } = require('./AgentPlaneUserMap');

/**
 * @description Completion evaluation and reporting helpers of the queue manager. All methods are static; the first parameter `svc` is the
 * QueueManagerService instance whose state and collaborators the logic operates on.
 */
class CompletionReporter {
  /**
   * Evaluate if agent's work is complete or needs human input
   * FIX 2: Also treat file creation as completion (safety net)
   * @param {string} agentResponse - Full agent response text
   * @param {object} ticket - Plane ticket object
   * @param {object} result - Full result object from TaskController with messages array
   * @returns {object} - { status: 'CUSTOMER_ACTION' | 'TODO', summary: string, reason?: string }
   */
  static async evaluateAgentCompletion(svc, agentResponse, ticket, result) {
    try {
      // PRIMARY: Check if agent used attempt_completion with SUBSTANTIVE work
      if (result && result.messages) {
        const completionMessage = result.messages.find(msg => msg.say === 'completion_result');
        
        if (completionMessage && completionMessage.text) {
          const completionText = completionMessage.text;
          
          // Check if this is SUBSTANTIVE completion (actual deliverable) vs just an outline
          const isSubstantive = completionText.length > 500 && 
            !svc._isJustAnOutline(completionText);
          
          if (isSubstantive) {
            // Agent produced real work product — send to Customer Action for review
            logger.info(`✅ Ticket ${ticket.id}: Agent completed with substantive work (${completionText.length} chars)`);
            return {
              status: 'CUSTOMER_ACTION',
              summary: svc.generateUserSummary(completionText, ticket, result)
            };
          } else {
            // Agent completed but only produced an outline/plan — return to Todo for execution
            logger.info(`🔄 Ticket ${ticket.id}: Agent completed but work is outline/plan only, returning to Todo for execution`);
            return {
              status: 'TODO',
              summary: svc.generateUserSummary(completionText, ticket, result),
              reason: 'Agent produced analysis/plan but work not yet executed. Returning to queue for next agent to continue.'
            };
          }
        }

        // FIX 2: Check if agent wrote files (write_to_file) but didn't use attempt_completion
        // Treat file creation as implicit completion — read the file content for the summary
        const fileWriteMessages = result.messages.filter(msg => 
          msg.say === 'tool_result' && msg.text && 
          (msg.text.includes('write_to_file') || msg.text.includes('created') || msg.text.includes('wrote'))
        );

        if (fileWriteMessages.length > 0) {
          logger.info(`✅ Ticket ${ticket.id}: Agent wrote ${fileWriteMessages.length} file(s) — treating as completion`);
          return {
            status: 'CUSTOMER_ACTION',
            summary: svc.generateUserSummary(agentResponse, ticket, result)
          };
        }
      }
      
      // SECONDARY: Check for explicit blocking signals requiring human
      const response = agentResponse.toLowerCase();
      const humanRequired = [
        'cannot proceed without',
        'missing credentials',
        'missing access',
        'permission denied',
        'access denied',
        'need human approval',
        'requires human decision',
        'blocked by'
      ];
      
      const needsHuman = humanRequired.some(sig => response.includes(sig));
      
      if (needsHuman) {
        logger.info(`⚠️ Ticket ${ticket.id}: Agent blocked, needs human intervention`);
        return {
          status: 'CUSTOMER_ACTION',
          summary: svc.generateUserSummary(agentResponse, ticket, result),
          reason: 'Agent blocked — requires human intervention'
        };
      }
      
      // DEFAULT: Return to Todo for continued multi-agent processing
      // This is the normal flow — agents work iteratively, ticket loops until fulfilled
      logger.info(`🔄 Ticket ${ticket.id}: Agent cycle complete, returning to Todo for next agent`);
      return {
        status: 'TODO',
        summary: svc.generateUserSummary(agentResponse, ticket, result),
        reason: 'Agent completed processing cycle. Ticket returned to queue for continued work.'
      };
      
    } catch (error) {
      logger.error(`Failed to evaluate completion for ${ticket.id}:`, error.message);
      // On error, return to Todo (let QM re-route)
      return {
        status: 'TODO',
        summary: 'Agent processing error. Returned to queue.',
        reason: `Evaluation error: ${error.message}`
      };
    }
  }

  /**
   * Check if agent response is just an outline/plan rather than actual executed work
   * FIX: Issue #017 — Previously false-positive on analysis/documentation tickets
   * because words like 'assessment', 'evaluation', 'analysis report' are legitimate
   * deliverable headings. Now uses content-length aware thresholds and distinguishes
   * planning language from section headings.
   * @private
   */
  static _isJustAnOutline(svc, text) {
    // STRONG outline signals — these indicate planning/proposal, not execution
    const strongOutlineSignals = [
      'here is a plan',
      'here\'s a plan',
      'here is an outline',
      'here\'s an outline',
      'proposed approach',
      'recommended steps',
      'steps to implement',
      'implementation plan',
      'i recommend we',
      'i suggest we',
      'we should consider',
      'you should consider',
      'here\'s what i propose',
      'here is what i propose'
    ];
    
    // WEAK signals — these appear in BOTH outlines AND real deliverables
    // Only count these for short responses where they indicate planning
    const weakSignals = [
      'action items',
      'next steps',
      'i recommend',
      'i suggest',
      'we should',
      'you should',
      'analysis report',
      'assessment',
      'evaluation'
    ];
    
    const lower = text.toLowerCase();
    const strongCount = strongOutlineSignals.filter(sig => lower.includes(sig)).length;
    const weakCount = weakSignals.filter(sig => lower.includes(sig)).length;
    
    // Content density check: count substantive paragraphs (lines > 80 chars)
    // Real deliverables have many long paragraphs; outlines are mostly short bullets
    const lines = text.split('\n').filter(l => l.trim().length > 0);
    const substantiveParagraphs = lines.filter(l => l.trim().length > 80).length;
    const bulletLines = lines.filter(l => /^\s*[-*•]\s/.test(l) || /^\s*\d+\.\s/.test(l)).length;
    const bulletRatio = lines.length > 0 ? bulletLines / lines.length : 0;
    
    // SHORT responses (<3000 chars): Original threshold — 3+ signals (strong + weak)
    if (text.length < 3000) {
      return (strongCount + weakCount) >= 3;
    }
    
    // MEDIUM responses (3000-8000 chars): Need strong signals OR high bullet ratio
    if (text.length < 8000) {
      // Strong signals alone are enough
      if (strongCount >= 2) return true;
      // Many weak signals + mostly bullets = outline
      if (weakCount >= 4 && bulletRatio > 0.6) return true;
      return false;
    }
    
    // LONG responses (8000+ chars): Almost certainly a real deliverable
    // Only flag if overwhelmingly outline-like (strong signals + low paragraph density)
    if (strongCount >= 3 && substantiveParagraphs < 5) return true;
    
    // 8000+ chars with substantive paragraphs = real deliverable, not an outline
    return false;
  }

  /**
   * Generate clean user-friendly summary from agent response
   * FIX 3: Aggressively read file content from workspace when agent wrote files
   * @param {string} agentResponse - Full agent response
   * @param {object} ticket - Plane ticket object
   * @param {object} result - Full result object with messages (optional)
   * @returns {string} - Clean formatted summary
   */
  static generateUserSummary(svc, agentResponse, ticket, result) {
    try {
      const fs = require('fs');
      const path = require('path');
      let fullContent = agentResponse;
      
      // FIX 3: Parse ALL tool_result messages for file paths (aggressive file reading)
      const filePaths = new Set();
      
      if (result && result.messages) {
        for (const msg of result.messages) {
          if (msg.text) {
            // Match various file path patterns in tool results
            const pathMatches = msg.text.match(/(?:\/app\/workspace\/[^\s"']+|workspace\/task_[^\s"']+|task_\d+\/[^\s"']+)/g);
            if (pathMatches) {
              pathMatches.forEach(p => filePaths.add(p));
            }
            // Also match write_to_file targets
            const writeMatch = msg.text.match(/(?:wrote|created|saved|write_to_file)[:\s]+([^\s"']+\.(md|txt|json|html|yaml|yml|js|py|csv))/gi);
            if (writeMatch) {
              writeMatch.forEach(m => {
                const fileOnly = m.replace(/^(?:wrote|created|saved|write_to_file)[:\s]+/i, '');
                filePaths.add(fileOnly);
              });
            }
          }
        }
      }
      
      // Also extract from agentResponse itself
      const responsePathMatches = agentResponse.match(/(?:\/app\/workspace\/[^\s"']+|workspace\/task_[^\s"']+|task_\d+\/[^\s"']+)/g);
      if (responsePathMatches) {
        responsePathMatches.forEach(p => filePaths.add(p));
      }
      
      // Try to read each discovered file path
      let bestFileContent = '';
      for (const rawPath of filePaths) {
        const possiblePaths = [
          rawPath.startsWith('/') ? rawPath : path.join('/app/workspace', rawPath),
          path.join('/app/workspace', rawPath),
        ];
        
        for (const filePath of possiblePaths) {
          try {
            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
              const fileContent = fs.readFileSync(filePath, 'utf8');
              if (fileContent && fileContent.length > bestFileContent.length) {
                logger.info(`FIX3: Reading workspace file for ticket ${ticket.id}: ${filePath} (${fileContent.length} chars)`);
                bestFileContent = fileContent;
              }
            }
          } catch (readErr) {
            logger.debug(`Could not read workspace file ${filePath}: ${readErr.message}`);
          }
        }
      }
      
      // Also scan THIS ticket's task workspace directory for any .md files
      // FIX: Issue #009 — Previously scanned ALL task_* dirs causing cross-ticket contamination
      try {
        const workspaceDir = '/app/workspace';
        const currentTaskId = task ? task.id : null;
        const allowedDirs = currentTaskId ? [currentTaskId] : [];
        if (fs.existsSync(workspaceDir) && allowedDirs.length > 0) {
          const taskDirs = allowedDirs.filter(d => fs.existsSync(path.join(workspaceDir, d)));
          for (const dir of taskDirs) { // ONLY scan current ticket's task dir
            const taskPath = path.join(workspaceDir, dir);
            try {
              const files = fs.readdirSync(taskPath).filter(f => 
                f.endsWith('.md') || f.endsWith('.txt') || f.endsWith('.html')
              );
              for (const file of files) {
                try {
                  const content = fs.readFileSync(path.join(taskPath, file), 'utf8');
                  if (content && content.length > bestFileContent.length) {
                    logger.info(`FIX3: Found richer content in ${dir}/${file} (${content.length} chars)`);
                    bestFileContent = content;
                  }
                } catch (e) { /* skip unreadable files */ }
              }
            } catch (e) { /* skip unreadable dirs */ }
          }
        }
      } catch (scanErr) {
        logger.debug(`Workspace scan error: ${scanErr.message}`);
      }
      
      // Use file content if it's richer than the response text
      if (bestFileContent.length > fullContent.length) {
        fullContent = bestFileContent;
      }
      
      // Truncate if absurdly long (Plane comment limit) but keep most of it
      const MAX_COMMENT_LENGTH = 25000;
      if (fullContent.length > MAX_COMMENT_LENGTH) {
        fullContent = fullContent.substring(0, MAX_COMMENT_LENGTH) + '\n\n---\n*Response truncated at 25,000 characters*';
      }
      
      // Strip JSON artifacts that agents sometimes include (file metadata, tool results)
      fullContent = fullContent
        .replace(/\{\s*"path"\s*:\s*"[^"]+"\s*,\s*"size"\s*:\s*\d+\s*,\s*"created"\s*:\s*\w+\s*\}/g, '') // file creation JSON
        .replace(/\{\s*"path"\s*:\s*"[^"]+"\s*,\s*"content"\s*:\s*"[\s\S]*?(?:"\s*\}|$)/g, '') // file content JSON blobs
        .replace(/\{"[a-z_]+"\s*:\s*(?:"[^"]*"|true|false|null|\d+)\s*(?:,\s*"[a-z_]+"\s*:\s*(?:"[^"]*"|true|false|null|\d+)\s*){1,5}\}/g, '') // generic small JSON objects (tool metadata)
        .replace(/\[Tool Used\]\n/g, '') // tool result headers
        .replace(/\\n/g, '\n') // convert escaped newlines to real newlines
        .replace(/\n{3,}/g, '\n\n') // collapse excessive newlines
        .replace(/^\s*---\s*$/gm, '\n---\n') // normalize horizontal rules
        .trim();
      
      // Build clean comment with workspace deliverables link
      const taskId = ticket._taskId || ticket.task_id;
      const baseUrl = process.env.WORKSPACE_BASE_URL || 'http://localhost:3010';
      const workspaceUrl = taskId 
        ? `\n\n---\n📂 **Deliverables & Generated Files:** [View workspace](${baseUrl}/workspace/${taskId}/)`
        : '';
      
      let summary = `✅ **Agent Work Complete**\n\n${fullContent}${workspaceUrl}`;
      
      return summary;
      
    } catch (error) {
      logger.error('Failed to generate user summary:', error.message);
      return '✅ Work Complete\n**Summary:** Agent has completed work on this ticket.\n**Next Steps:** Review the detailed response above.';
    }
  }

  /**
   * Report agent completion back to Plane
   */
  static async reportCompletion(svc, client, ticket, agent, response, taskId) {
    try {
      // Evaluate if work is truly complete
      const evaluation = await svc.evaluateAgentCompletion(response, ticket);
      
      logger.info(`Ticket ${ticket.id} evaluation: ${evaluation.status} (reason: ${evaluation.reason || 'complete'})`);
      
      if (evaluation.status === 'CUSTOMER_ACTION') {
        // Work is complete - post clean summary
        const completionComment = evaluation.summary;
        await svc.postComment(client, ticket, completionComment);
        
        logger.info(`✓ Ticket ${ticket.id} marked complete, moving to Customer Action`);

        // ⭐ PHASE_31 FIX: When a subtask completes, post its results on the parent
        // and trigger immediate parent completion check (don't wait for 60s poll)
        try {
          const parentCheck = await client.query(
            'SELECT parent_id FROM issues WHERE id = $1', [ticket.id]
          );
          const parentId = parentCheck.rows[0]?.parent_id;
          
          if (parentId) {
            logger.info(`📤 Subtask ${ticket.id} completed — posting results to parent ${parentId}`);
            
            // Get parent ticket info for comment posting
            const parentInfo = await client.query(
              'SELECT id, name, project_id, workspace_id FROM issues WHERE id = $1', [parentId]
            );
            
            if (parentInfo.rows.length > 0) {
              const parent = parentInfo.rows[0];
              
              // Post subtask completion summary on the parent ticket
              const subtaskSummary = `📋 **Subtask Completed** — ${ticket.name || 'Subtask'}

**Agent:** ${agent.agent_id}
**Status:** ✅ Complete

**Summary:**
${(evaluation.summary || response || '').substring(0, 1500)}${(evaluation.summary || response || '').length > 1500 ? '\n\n*(truncated)*' : ''}

---
*Subtask result auto-posted by Queue Manager — Subtask Aggregation Pipeline*`;
              
              await svc.postComment(
                client,
                { id: parent.id, project_id: parent.project_id, workspace_id: parent.workspace_id },
                subtaskSummary,
                getQueueManagerUserId()
              );
              
              logger.info(`✅ Posted subtask ${ticket.id} results on parent ${parentId}`);
              
              // Trigger IMMEDIATE parent completion check (don't wait for 60s poll)
              logger.info(`🔍 Triggering immediate parent completion check for ${parentId}`);
              await svc.checkParentCompletion(client);
            }
          }
        } catch (parentErr) {
          logger.warn(`Failed to post subtask results on parent for ${ticket.id}: ${parentErr.message}`);
          // Non-fatal — the 60s poll will eventually catch it
        }
      } else {
        // More work needed - post detailed handoff
        const handoffComment = `🔄 **Agent Work In Progress**

**Agent:** ${agent.agent_id}  
**Task ID:** ${taskId}

**Work Completed:**
${response}

**Status:** ${evaluation.reason}

**Next:** Queue Manager will route this ticket for continued work.

---
*This ticket remains in Todo queue for further agent routing.*

*Queue Manager v1.0*`;

        await svc.postComment(client, ticket, handoffComment);
        
        logger.info(`✓ Ticket ${ticket.id} needs more work, keeping in Todo queue`);
      }

    } catch (error) {
      logger.error(`Failed to report completion for ${ticket.id}:`, error.message);
    }
  }

  /**
   * Escalate ticket to human review
   */
  static async escalateToHuman(svc, client, ticket, reason) {
    try {
      // Update ticket status to Customer Action (human needed)
      await svc.updateTicketStatus(client, ticket.id, 'Customer Action', ticket.project_id);

      // Post escalation comment
      const escalationComment = `⚠️ **Queue Manager: Human Assistance Required**

@human

**Why Human Help is Needed:**
${reason}

**What Agents Have Done So Far:**
(Review comments above for agent work completed)

**Available Agents in System:**
${await svc.getAgentSummary()}

**What Human Should Do:**
1. Review agent work completed above
2. Decide next action:
   - Assign to human team member if technical work needed
   - Deploy new specialist agent if capability missing
   - Break into smaller tickets if too complex
   - Provide missing information/credentials if agents blocked
   - Close if out of scope

**Ticket Status:** Customer Action (Human Assistance Required)

---
**Note:** This ticket has been escalated because agents cannot proceed further without human intervention. This is NOT a handoff for review - this is a BLOCKER requiring human action.

**Queue Manager v1.0**`;

      await svc.postComment(client, ticket, escalationComment);

      logger.info(`✓ Ticket ${ticket.id} escalated to human: ${reason}`);

    } catch (error) {
      logger.error(`Failed to escalate ticket ${ticket.id}:`, error.message);
    }
  }

  /**
   * Get summary of available agents (for escalation)
   */
  static async getAgentSummary(svc) {
    try {
      const agents = await svc.agentRegistry.getAll();
      
      if (agents.length === 0) {
        return 'No agents currently registered in system.';
      }

      return agents.map(agent => 
        `- **${agent.agent_id}**: ${agent.capabilities.join(', ')} (${agent.status}, load: ${agent.current_load}/${agent.max_concurrent})`
      ).join('\n');

    } catch (error) {
      return 'Error retrieving agent list.';
    }
  }

  /**
   * Get project slug from project ID (Plane database lookup)
   * @param {Object} client - PostgreSQL client
   * @param {string} projectId - Plane project UUID
   * @returns {string} Project slug or 'default'
   */
  static async getProjectSlug(svc, client, projectId) {
    try {
      const query = `SELECT name, identifier FROM projects WHERE id = $1 LIMIT 1`;
      const result = await client.query(query, [projectId]);
      if (result.rows.length > 0) {
        // Use project name, slugified (lowercase, spaces→hyphens, strip non-alphanumeric)
        const name = result.rows[0].name || result.rows[0].identifier;
        const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        logger.debug(`Project slug for ${projectId}: "${name}" → "${slug}"`);
        return slug;
      }
      return 'default';
    } catch (error) {
      logger.warn(`Failed to get project slug for ${projectId}: ${error.message}`);
      return 'default';
    }
  }

  /**
   * Extract description text from ticket
   * Prefers description_stripped (plain text from Plane DB) over parsing jsonb description
   */
  static extractDescription(svc, ticket) {
    // PRIORITY 1: Use description_stripped (Plane's pre-extracted plain text)
    if (ticket.description_stripped && ticket.description_stripped.trim()) {
      logger.debug(`Ticket ${ticket.id}: Using description_stripped (${ticket.description_stripped.length} chars)`);
      return ticket.description_stripped.trim();
    }

    // PRIORITY 2: Use description_html stripped of tags
    if (ticket.description_html && ticket.description_html.trim()) {
      const stripped = ticket.description_html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      if (stripped) {
        logger.debug(`Ticket ${ticket.id}: Using description_html stripped (${stripped.length} chars)`);
        return stripped;
      }
    }

    // PRIORITY 3: Try parsing jsonb description (legacy fallback)
    let descriptionText = ticket.name || 'No description';
    
    try {
      if (ticket.description && typeof ticket.description === 'object') {
        const content = ticket.description.content;
        if (Array.isArray(content)) {
          const texts = content
            .filter(block => block.content)
            .map(block => {
              if (Array.isArray(block.content)) {
                return block.content
                  .filter(item => item.text)
                  .map(item => item.text)
                  .join(' ');
              }
              return '';
            })
            .join(' ');
          
          if (texts && texts.trim()) {
            descriptionText = texts.trim();
          }
        }
      } else if (typeof ticket.description === 'string' && ticket.description.trim()) {
        descriptionText = ticket.description.trim();
      }
    } catch (e) {
      logger.warn(`Failed to parse description for ticket ${ticket.id}:`, e.message);
    }

    logger.debug(`Ticket ${ticket.id}: Using fallback description (${descriptionText.length} chars)`);
    return descriptionText;
  }
}

module.exports = CompletionReporter;
