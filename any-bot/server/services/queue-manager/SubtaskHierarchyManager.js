/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from QueueManagerService.js (1000-line cap decomposition): subtask decomposition parsing, LLM parent summaries, child task-brief building, workspace file manifest scan, root-ticket resolution, and parent completion assembly
 */

/**
 * SubtaskHierarchyManager — subtask hierarchy (decomposition + parent assembly) logic of the queue manager.
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
 * @description Subtask hierarchy (decomposition + parent assembly) logic of the queue manager. All methods are static; the first parameter `svc` is the
 * QueueManagerService instance whose state and collaborators the logic operates on.
 */
class SubtaskHierarchyManager {
  /**
   * Detect subtask decomposition in agent response
   * Parses ## SUBTASK DECOMPOSITION marker with rich structured briefs
   * Supports both new format (### Subtask N: Title) and legacy (- [ ] Title)
   * @param {string} response - Agent response text
   * @returns {Array<{title: string, description: string}>|null} - Array of subtask objects, or null
   */
  static detectSubtaskDecomposition(svc, response) {
    if (!response) return null;
    
    const marker = '## SUBTASK DECOMPOSITION';
    if (!response.includes(marker)) return null;
    
    const afterMarker = response.split(marker)[1];
    if (!afterMarker) return null;
    
    // Try NEW format first: ### Subtask N: Title followed by structured brief
    const subtaskSections = afterMarker.split(/###\s+Subtask\s+\d+:\s*/i).filter(s => s.trim());
    
    if (subtaskSections.length >= 2) {
      const subtasks = subtaskSections.map(section => {
        const lines = section.trim().split('\n');
        let title = lines[0].replace(/\s*[-—]+\s*$/, '').trim();
        // ⭐ PHASE_44 FIX 2: Strip bracket placeholders from subtask titles
        // PM agents sometimes output literal template placeholders like "[Clear, Actionable Title]"
        // Strip brackets first, then validate the result
        if (/^\[.*\]$/.test(title)) {
          title = title.replace(/^\[|\]$/g, '').trim();
        }
        // Also strip leading/trailing brackets that are part of template patterns
        title = title.replace(/^\[+|\]+$/g, '').trim();
        // Everything after the title line is the description/brief
        const description = lines.slice(1).join('\n').trim();
        return { title, description: description || title };
      }).filter(s => {
        // PHASE_44 FIX 2: Reject titles that are still template placeholders
        if (s.title.length < 10) {
          logger.warn(`⚠️ PHASE_44 FIX 2: Rejecting subtask with short/placeholder title: "${s.title}"`);
          return false;
        }
        // Reject titles that look like template instructions
        const templatePatterns = /^(title|clear|actionable|descriptive|your|enter|add|insert|placeholder)/i;
        if (templatePatterns.test(s.title)) {
          logger.warn(`⚠️ PHASE_44 FIX 2: Rejecting subtask with template-like title: "${s.title}"`);
          return false;
        }
        return true;
      });
      
      if (subtasks.length >= 2 && subtasks.length <= 7) {
        logger.info(`Detected ${subtasks.length} structured subtasks (rich format) in agent response`);
        return subtasks;
      }
      // Over-decomposition: truncate to 7 but still return
      if (subtasks.length > 7) {
        logger.warn(`⚠️ Over-decomposition: PM requested ${subtasks.length} subtasks, truncating to 7`);
        return subtasks.slice(0, 7);
      }
    }
    
    // LEGACY fallback: - [ ] Task title
    const matches = afterMarker.match(/- \[ \] (.+)/g);
    if (matches && matches.length >= 2) {
      const subtasks = matches.map(m => {
        const title = m.replace('- [ ] ', '').trim();
        return { title, description: title };
      });
      
      if (subtasks.length >= 2 && subtasks.length <= 7 && subtasks.every(s => s.title.length >= 10)) {
        logger.info(`Detected ${subtasks.length} subtasks (legacy format) in agent response`);
        return subtasks;
      }
    }
    
    return null;
  }

  /**
   * ⭐ ISSUE #032: Generate an LLM-summarized parent context for child subtask briefs.
   * Uses Bedrock to condense parent description into 2-3 focused sentences.
   * Redis-cached per parent ticket so sibling subtasks share the same summary.
   * Graceful fallback: if LLM or Redis unavailable, throws (caller catches and truncates).
   * @param {Object} parentTicket - Parent ticket object with .id and .name
   * @param {string} parentDescription - Full parent description text
   * @returns {Promise<string>} - 2-3 sentence summary of the parent's goal
   * @private
   */
  static async _getParentSummary(svc, parentTicket, parentDescription) {
    // 1. Check Redis cache first (siblings share the same summary)
    const cacheKey = `qm:parent_summary:${parentTicket.id || parentTicket.name}`;
    try {
      const cached = await svc.redis.get(cacheKey);
      if (cached) {
        logger.info(`ISSUE #032: Using cached parent summary for ${parentTicket.id || parentTicket.name} (${cached.length} chars)`);
        return cached;
      }
    } catch (e) {
      logger.debug(`ISSUE #032: Redis cache miss/error for parent summary: ${e.message}`);
    }

    // 2. Call Bedrock for LLM summary
    // Access BedrockProvider via taskController.llm (set in app.js init)
    const llm = svc.taskController?.llm;
    if (!llm || typeof llm.generateResponse !== 'function') {
      throw new Error('LLM service not available for parent summary generation');
    }

    const systemPrompt = `You are a concise project summarizer. Given a parent ticket's full description, produce a 2-3 sentence summary that captures ONLY the project's overall goal and key deliverables. Do NOT list specific subtasks, do NOT use the word "multi-disciplinary", do NOT suggest decomposition. Just state what the project aims to achieve.`;

    // Truncate input to ~2000 chars to keep token cost minimal (~200 input tokens)
    const inputText = parentDescription.substring(0, 2000);

    const response = await llm.generateResponse(
      [{ role: 'user', content: `Summarize this parent ticket in 2-3 sentences:\n\n**${parentTicket.name}**\n\n${inputText}` }],
      { systemPrompt, maxTokens: 200, disableExtendedThinking: true, temperature: 0.3 }
    );

    const summary = (response.content || '').trim();
    if (!summary || summary.length < 20) {
      throw new Error(`LLM returned empty/short summary: "${summary}"`);
    }

    logger.info(`ISSUE #032: Generated LLM parent summary (${summary.length} chars, cost: $${(response.cost || 0).toFixed(6)})`);

    // 3. Cache in Redis (1 hour TTL — siblings will reuse)
    try {
      await svc.redis.set(cacheKey, summary, 'EX', 3600);
      logger.debug(`ISSUE #032: Cached parent summary in Redis: ${cacheKey}`);
    } catch (e) {
      logger.debug(`ISSUE #032: Redis cache set failed (non-fatal): ${e.message}`);
    }

    return summary;
  }

  /**
   * Build a rich task brief for a child subtask issue
   * Creates a detailed, markdown-formatted description that gives the child agent
   * full context to complete the work independently.
   * @param {Object} subtask - { title, description } from detectSubtaskDecomposition
   * @param {Object} parentTicket - Parent ticket object
   * @param {string} parentDescription - Parent ticket description text
   * @param {number} depth - Current decomposition depth
   * @returns {string} - Markdown-formatted task brief
   * @private
   */
  static async _buildChildTaskBrief(svc, subtask, parentTicket, parentDescription, depth, siblingInfo = []) {
    const agentDescription = subtask.description || '';
    const childDepth = depth + 1;
    const MAX_DEPTH = 4;
    // ⭐ PHASE_47 FIX: Only allow decomposition at depth 0→1 (root→first children).
    // Depth 2+ MUST execute directly. This prevents the recursive re-decomposition loop
    // where level 3 agents repeat level 2's breakdown ad infinitum.
    // The old MAX_DEPTH=4 was too permissive — agents at depth 2 and 3 would re-plan
    // instead of executing, creating exponential subtask trees.
    const DECOMPOSITION_CUTOFF = 1; // Only root (0) can decompose to children (1). Children execute.
    const isAtMaxDepth = childDepth >= MAX_DEPTH;
    const mustExecuteDirectly = childDepth > DECOMPOSITION_CUTOFF;

    // ⭐ ISSUE #032: LLM-summarized parent context replaces raw 3000-char truncation
    // This prevents PM agents from re-analyzing parent scope and re-proposing the same decomposition.
    // Cache in Redis so sibling subtasks share the same summary (only 1 Bedrock call per parent).
    let parentContext;
    try {
      parentContext = await svc._getParentSummary(parentTicket, parentDescription);
    } catch (summaryErr) {
      logger.warn(`ISSUE #032: LLM parent summary failed, falling back to truncation: ${summaryErr.message}`);
      const CONTEXT_LIMIT = 3000;
      parentContext = parentDescription.substring(0, CONTEXT_LIMIT) + 
        (parentDescription.length > CONTEXT_LIMIT ? '\n\n*(parent description truncated)*' : '');
    }
    
    // Build sibling awareness section so children know what parallel work exists
    let siblingSection = '';
    if (siblingInfo.length > 0) {
      const siblingList = siblingInfo
        .filter(s => s.title !== subtask.title) // exclude self
        .map((s, i) => `${i + 1}. **${s.title}**`)
        .join('\n');
      if (siblingList) {
        siblingSection = `\n\n## Sibling Subtasks (Parallel Work)\n\nOther agents are working on these related subtasks simultaneously. **Do NOT duplicate their work.** Focus ONLY on your assigned task.\n\n${siblingList}\n\n*Your deliverable will be combined with sibling results on the parent ticket.*`;
      }
    }
    
    // If the agent already provided a structured brief, use it with context header
    // ⭐ PHASE_46B: Build max-depth warning block for agents at depth 4
    const maxDepthWarning = isAtMaxDepth ? `
## ⛔ MAXIMUM DEPTH REACHED — EXECUTE DIRECTLY

**You are at depth ${childDepth}/${MAX_DEPTH} — the deepest level allowed.**

DO NOT attempt to decompose, plan, outline, or propose subtasks.
DO NOT output "## SUBTASK DECOMPOSITION" — it will be IGNORED at this depth.
Your ONLY option is to **execute the work directly** and produce a concrete deliverable.
If the task feels too large, do your best with the most important parts and note what was deprioritized in your handover.
` : '';

    // If the agent already provided a structured brief, use it with context header
    if (agentDescription.length > 100 && agentDescription !== subtask.title) {
      return `# Task Brief: ${subtask.title}

**Parent Ticket:** ${parentTicket.name}
**Decomposition Depth:** ${childDepth}/${MAX_DEPTH}${isAtMaxDepth ? ' ⛔ MAX DEPTH — EXECUTE DIRECTLY' : ''}
**Type:** Subtask — Logical Unit of Work

---

## Parent Context

${parentContext}

---

## Task Details

${agentDescription}
${siblingSection}
${maxDepthWarning}
---

## Developer Handover Protocol

**BEFORE starting work**, check \`developer-handovers/\` folder for previous session handovers.
**AFTER completing work**, write your handover to: \`developer-handovers/TICKET-${parentTicket.name.substring(0,20).replace(/[^a-zA-Z0-9]/g,'-')}.SUBTASK-${subtask.title.substring(0,20).replace(/[^a-zA-Z0-9]/g,'-')}.SESSION-01-developer-handover.md\`

If a handover with SESSION-01 already exists, increment to SESSION-02, SESSION-03, etc.

Your handover file MUST include:
- What you accomplished
- What files you created/modified
- What's left to do
- Key decisions and context for the next agent

---

## Completion Requirements

- Complete this task as a **single, focused deliverable**
- Include **all work inline** in your response (not file references)
- Do NOT overlap with sibling subtasks — stay focused on YOUR task only
${mustExecuteDirectly
  ? `- ⛔ **EXECUTE DIRECTLY — NO FURTHER DECOMPOSITION ALLOWED (depth ${childDepth}/${MAX_DEPTH}).** You MUST produce a concrete deliverable. No planning, no outlines, no subtask proposals — JUST DO THE WORK. Do NOT output "## SUBTASK DECOMPOSITION" — it will be IGNORED.`
  : `- If this task is STILL too complex, you may further decompose it (system supports recursive decomposition up to depth ${MAX_DEPTH})`}
- Write your developer handover to the \`developer-handovers/\` folder
- When done, use \`attempt_completion\` with your full deliverable
${mustExecuteDirectly ? `
## ⭐ SESSION CONTINUITY (Focus Chain)

**If this task is too large to complete in one session**, you do NOT need to finish everything.
Instead, use the **focus chain** pattern:

1. **Do as much work as you can** in this session
2. **Write a Developer Handover** summarizing what you accomplished, what files you created, and what remains
3. **Write a Task Brief** for the next agent session — include specific next steps, key decisions made, and file locations
4. **Use attempt_completion** with Status: **Partial** — include both the handover and task brief inline

The Queue Manager will post your handover as a comment on this ticket and return it to Todo.
The next agent session will read your handover from the comment thread and continue where you left off.
**This is how large tasks get completed across multiple sessions — NOT by creating more subtasks.**

Example completion for partial work:
\`\`\`
## 🔄 Developer Handover
**Agent:** [your-id]
**Status:** Partial — Session 1 of N

### What I Did
- Created initial project structure
- Implemented authentication module

### What I Produced
- /auth/login.js, /auth/middleware.js

### What's Left To Do
- Payment integration (Stripe API)
- Dashboard UI

### Task Brief for Next Session
Continue from the auth module. Payment integration needs Stripe SDK setup.
Start with /payments/stripe-client.js. Reference /auth/middleware.js for the auth pattern.
\`\`\`
` : ''}
*This subtask was auto-generated by Queue Manager v2.0 — Subtask Orchestration Pipeline*`;
    }
    
    // Minimal brief when agent only provided a title
    return `# Task Brief: ${subtask.title}

**Parent Ticket:** ${parentTicket.name}
**Decomposition Depth:** ${childDepth}/${MAX_DEPTH}${isAtMaxDepth ? ' ⛔ MAX DEPTH' : ''}
**Type:** Subtask — Logical Unit of Work

---

## Parent Context

${parentContext}

---

## Objective

${subtask.title}
${siblingSection}
${maxDepthWarning}
## Developer Handover Protocol

**BEFORE starting**, check \`developer-handovers/\` folder for previous session notes.
**Also read ALL previous comments on this ticket** — they contain handovers from earlier sessions.
**AFTER completing**, write your handover to \`developer-handovers/\` with naming: \`TICKET-${parentTicket.name.substring(0,20).replace(/[^a-zA-Z0-9]/g,'-')}.SUBTASK-${subtask.title.substring(0,20).replace(/[^a-zA-Z0-9]/g,'-')}.SESSION-01-developer-handover.md\`

## Deliverables

- Complete the work described above as a focused, single deliverable
- Provide all results inline in your response
- Do NOT overlap with sibling subtasks
- Write your developer handover file
${mustExecuteDirectly ? `
## ⭐ SESSION CONTINUITY (Focus Chain)

**If this task is too large for one session**, do as much as you can, then:
1. Include a **Developer Handover** (what you did, what files you created)
2. Include a **Task Brief for Next Session** (specific next steps, decisions made, file locations)
3. Set Status: **Partial** in attempt_completion

The system will hand this ticket to the next agent session automatically.
**Do NOT create subtasks — just hand off via the comment thread.**
` : ''}
## Acceptance Criteria

- [ ] Task objective fully addressed (or partial with handover + task brief)
- [ ] Deliverable is complete and self-contained
- [ ] No overlap with sibling subtask work
- [ ] Developer handover written to developer-handovers/ folder
- [ ] Results included in attempt_completion (not file references)

---

*This subtask was auto-generated by Queue Manager v2.0 — Subtask Orchestration Pipeline*`;
  }

  /**
   * Check parent tickets in "In Review" state for child completion
   * When all children are Done/Customer Action/Cancelled, auto-assemble and resolve the parent
   */
  /**
   * ⭐ PHASE_45 FIX: Walk up parent chain to find the root (depth-0) ticket.
   * When subtask decomposition creates 3+ levels, we need to merge workspace 
   * deliverables all the way to the root, not just to the immediate parent.
   * @param {Client} client - Database client
   * @param {string} ticketId - Starting ticket ID  
   * @returns {Promise<{rootId: string, depth: number}>} - Root ticket ID and depth traversed
   */
  /**
   * ⭐ ISSUE #033: Scan workspace files for a ticket to build file manifest
   * Looks in swarm-workspace/task_{first8chars}/ for all non-meta files
   * @param {string} ticketId - Plane ticket UUID
   * @returns {{ files: string[], workspacePath: string } | null}
   */
  static _scanWorkspaceFiles(svc, ticketId) {
    const fs = require('fs');
    const path = require('path');
    // SOP-compliant workspace scan: /app/swarm-workspace/{ticketId}
    const possiblePaths = [
      path.join('/app/swarm-workspace', ticketId),
      path.join('/app/swarm-workspace', `task_${ticketId.substring(0, 8)}`), // legacy
      path.join('/app/workspace', ticketId), // legacy
      path.join('/app/workspace', `task_${ticketId.substring(0, 8)}`) // legacy
    ];
    let workspacePath = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        workspacePath = p;
        break;
      }
    }
    if (!workspacePath) {
      logger.debug(`No workspace found for ticket ${ticketId} (tried SOP and legacy paths)`);
      return null;
    }
    
    // Recursively scan for files, excluding noise
    const EXCLUDE_DIRS = new Set(['node_modules', '.git', '__pycache__', 'venv', '.pytest_cache', '.cache']);
    const EXCLUDE_FILES = new Set(['_meta.json', '.DS_Store', '.gitignore']);
    
    const files = [];
    const MAX_FILES = 100;
    
    const scan = (dir, prefix = '') => {
      if (files.length >= MAX_FILES) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (files.length >= MAX_FILES) break;
          if (entry.name.startsWith('.') && entry.name !== '.env') continue;
          
          const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
          
          if (entry.isDirectory()) {
            if (!EXCLUDE_DIRS.has(entry.name)) {
              scan(path.join(dir, entry.name), relativePath);
            }
          } else if (entry.isFile()) {
            if (!EXCLUDE_FILES.has(entry.name)) {
              files.push(relativePath);
            }
          }
        }
      } catch (e) { /* skip unreadable dirs */ }
    };
    
    scan(workspacePath);
    
    return { files, workspacePath: `task_${shortId}` };
  }

  static async findRootTicketId(svc, client, ticketId) {
    let current = ticketId;
    let depth = 0;
    const MAX_DEPTH = 10; // safety limit to prevent infinite loops

    while (depth < MAX_DEPTH) {
      const parentId = await svc.planeDb.getParentId(client, current);
      if (!parentId) {
        // No parent = this is the root
        return { rootId: current, depth };
      }
      current = parentId;
      depth++;
    }

    logger.warn(`⚠️ PHASE_45: Hit max depth ${MAX_DEPTH} walking parent chain from ${ticketId}, using ${current} as root`);
    return { rootId: current, depth };
  }

  static async checkParentCompletion(svc, client) {
    try {
      // Find tickets in "In Review" that have children
      const query = `
        SELECT DISTINCT p.id, p.name, p.project_id, p.workspace_id, s.name as status
        FROM issues p
        LEFT JOIN states s ON p.state_id = s.id
        WHERE s.name = 'In Review'
        AND p.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM issues c WHERE c.parent_id = p.id)
        LIMIT 20
      `;
      
      const result = await client.query(query);
      
      for (const parent of result.rows) {
        const completion = await svc.planeDb.checkChildCompletion(client, parent.id);
        
        if (completion.allDone) {
          logger.info(`✅ All ${completion.total} children of parent ${parent.id} are complete — assembling deliverables`);
          
          // ⭐ WORKSPACE SCAN: Scan shared workspace for file manifest
          let fileManifest = null;
          try {
            fileManifest = svc._scanWorkspaceFiles(parent.id);
            if (fileManifest && fileManifest.files.length > 0) {
              logger.info(`📁 Workspace scan: ${fileManifest.files.length} files found for parent ${parent.id}`);
            }
          } catch (scanErr) {
            logger.debug(`Workspace scan failed for ${parent.id}: ${scanErr.message}`);
          }

          // ⭐ ASSEMBLY: Gather child deliverables and create aggregated summary with file manifest
          let assemblyComment;
          try {
            const childDeliverables = await svc.planeDb.getChildDeliverables(client, parent.id);
            assemblyComment = svc.commentFormatter.assemblyComment(parent.name, childDeliverables, fileManifest);
          } catch (assemblyErr) {
            logger.warn(`Assembly failed for parent ${parent.id}: ${assemblyErr.message}`);
            assemblyComment = svc.commentFormatter.parentCompletionComment(completion.total);
          }
          
          // ⭐ WORKSPACE LINK: Include workspace browser link if task exists
          try {
            const parentTaskId = await svc.getTicketTaskId(client, parent.id);
            if (parentTaskId) {
              const baseUrl = process.env.WORKSPACE_BASE_URL || 'http://localhost:3010';
              assemblyComment += `\n\n📂 **All Deliverables:** [Browse shared workspace](${baseUrl}/workspace/${parentTaskId}/)`;
            }
          } catch (e) { /* non-fatal */ }
          
          await svc.postComment(
            client, 
            { id: parent.id, project_id: parent.project_id, workspace_id: parent.workspace_id }, 
            assemblyComment,
            getQueueManagerUserId()
          );
          
          await svc.updateTicketStatus(client, parent.id, 'Customer Action', parent.project_id);
          
          logger.info(`✅ Parent ${parent.id} assembled and moved to Customer Action`);
          
          // Clean up tracking keys
          try {
            await svc.redis.del(`qm:decomp_depth:${parent.id}`);
            await svc.redis.del(`qm:ticket_phase:${parent.id}`);
          } catch (e) { /* best effort */ }
        } else if (completion.total > 0) {
          logger.debug(`Parent ${parent.id}: ${completion.completed}/${completion.total} children complete`);
          
          // ⭐ STUCK CHILDREN TIMEOUT: Check if parent has been waiting too long
          const STUCK_TIMEOUT_MS = parseInt(process.env.STUCK_CHILDREN_TIMEOUT_MS || '7200000'); // 2 hours default
          const STUCK_TIMEOUT_MINUTES = Math.floor(STUCK_TIMEOUT_MS / 60000);
          
          try {
            // Check how long parent has been in "In Review" (using updated_at as proxy)
            const ageQuery = `
              SELECT EXTRACT(EPOCH FROM (NOW() - i.updated_at))::int * 1000 as age_ms
              FROM issues i WHERE i.id = $1
            `;
            const ageResult = await client.query(ageQuery, [parent.id]);
            const parentAgeMs = parseInt(ageResult.rows[0]?.age_ms || 0);
            
            if (parentAgeMs > STUCK_TIMEOUT_MS) {
              // Check if we already posted a timeout warning (prevent duplicate warnings)
              const alreadyWarned = await svc.redis.get(`qm:stuck_warned:${parent.id}`);
              
              if (!alreadyWarned) {
                // Get stuck children details
                const childDeliverables = await svc.planeDb.getChildDeliverables(client, parent.id);
                const stuckChildren = childDeliverables.filter(c => 
                  c.status !== 'Done' && c.status !== 'Customer Action' && c.status !== 'Cancelled'
                );
                
                if (stuckChildren.length > 0) {
                  logger.warn(`⏱️ STUCK CHILDREN: Parent ${parent.id} in "In Review" for ${Math.floor(parentAgeMs / 60000)} min with ${stuckChildren.length} stuck children`);
                  
                  // Post timeout warning comment
                  const timeoutComment = svc.commentFormatter.stuckChildrenComment(stuckChildren, STUCK_TIMEOUT_MINUTES);
                  await svc.postComment(
                    client,
                    { id: parent.id, project_id: parent.project_id, workspace_id: parent.workspace_id },
                    timeoutComment,
                    getQueueManagerUserId()
                  );
                  
                  // Escalate parent to Customer Action
                  await svc.updateTicketStatus(client, parent.id, 'Customer Action', parent.project_id);
                  
                  // Mark as warned (prevent re-posting on next poll, 24h TTL)
                  await svc.redis.set(`qm:stuck_warned:${parent.id}`, '1', 'EX', 86400);
                  
                  logger.info(`✅ Parent ${parent.id} escalated due to stuck children timeout (${STUCK_TIMEOUT_MINUTES} min)`);
                }
              }
            }
          } catch (stuckErr) {
            logger.debug(`Stuck children check failed for parent ${parent.id}: ${stuckErr.message}`);
          }
        }
      }
    } catch (error) {
      logger.error('Failed to check parent completion:', error.message);
    }
  }
}

module.exports = SubtaskHierarchyManager;
