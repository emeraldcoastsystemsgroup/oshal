/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * CommentFormatter — Consistent Plane ticket comment formatting
 * All QM comments go through this formatter for consistent branding and structure.
 * 
 * Created: 2026-02-08 — PHASE_08 Issue #010
 * 
 * Comment types:
 *   1. routingComment       — Agent routed to ticket
 *   2. completionComment    — Agent completed work (CUSTOMER_ACTION)
 *   3. handoffComment       — Agent work in progress, returning to queue (TODO)
 *   4. errorComment         — Agent processing failed
 *   5. escalationComment    — Escalation to human review
 *   6. recoveryComment      — Stalled task timeout recovery
 *   7. decompositionComment — Subtask decomposition performed
 *   8. circuitBreakerComment— Circuit breaker triggered
 *   9. lockWarningComment   — Task locked by another agent
 *  10. customerSummary      — Customer-facing summary for parent tickets
 */

const logger = require('../../utils/logger');

/**
 * @description Central factory for every Queue Manager comment posted to Plane tickets.
 * Routing all comment text through one class guarantees consistent branding, structure,
 * and version stamping across the agent swarm — so customers and reviewers always see a
 * recognizable, uniform voice regardless of which lifecycle event produced the comment.
 */
class CommentFormatter {
  /**
   * @description Initialize formatter state, fixing the QM version stamp and reading the
   * customer-summary / technical-detail length caps from the environment so deployments can
   * tune comment verbosity without code changes.
   */
  constructor() {
    this.version = '2.0';
    this.maxSummaryLength = parseInt(process.env.QM_SUMMARY_MAX_CHARS || '1000');  // Configurable via env
    this.maxDetailLength = parseInt(process.env.QM_DETAIL_MAX_CHARS || '15000');   // Configurable via env
  }

  // ─────────────────────────────────────────────
  // 1. ROUTING — Agent assigned to ticket
  // ─────────────────────────────────────────────
  /**
   * Task Brief — QM's structured first comment that sets the north star for the processing chain.
   * This is NOT just a routing notification. It's the brief that every agent reads first.
   * @param {string} agentId - Assigned agent
   * @param {Array<string>} capabilities - Matched capabilities
   * @param {string} priority - Ticket priority
   * @param {string} ticketTitle - Ticket title/name
   * @param {string} ticketDescription - Ticket description text
   * @param {string} complexity - Analyzed complexity (low/medium/high)
   * @returns {string} Structured task brief comment
   */
  routingComment(agentId, capabilities, priority, ticketTitle = '', ticketDescription = '', complexity = 'medium', phase = null) {
    const descPreview = ticketDescription 
      ? ticketDescription.substring(0, 500) + (ticketDescription.length > 500 ? '...' : '')
      : ticketTitle;

    // Phase-aware expectations and quality bar
    const { expectations, qualityBar } = this._phaseAwareGuidance(phase);

    return `📋 **TASK BRIEF — Queue Manager**

## Goal
${ticketTitle || 'See ticket description'}

## Description
${descPreview}

## Assignment
| Field | Value |
|-------|-------|
| **Assigned Agent** | @agent:${agentId} |
| **Matched Skills** | ${capabilities.join(', ')} |
| **Priority** | ${priority} |
| **Complexity** | ${complexity} |
${phase ? `| **Phase** | ${phase} |` : ''}

## Expectations
${expectations}

## Quality Bar
${qualityBar}

**This comment IS the brief. Read it. Execute it. Hand it over properly.**

${this._footer()}`;
  }

  /**
   * Generate phase-appropriate expectations and quality bar text
   * Each phase has different deliverable types — a plan IS the deliverable during PLANNING
   * @param {number|null} phase - Current ticket phase (null = non-phased/subtask)
   * @returns {{ expectations: string, qualityBar: string }}
   * @private
   */
  _phaseAwareGuidance(phase) {
    // Phase 2: PLANNING — the deliverable IS a plan
    if (phase === 2) {
      return {
        expectations: `- **Deliver a structured approach plan** — this IS the work product for this phase
- **Include numbered steps** (minimum 3) with specialist assignments
- **Include a Developer Handover** at the end of your response (mandatory RALF requirement)
- **Read the full thread** before starting — previous agents may have done work already
- **Do NOT execute the plan** — planning only, execution happens in a later phase`,
        qualityBar: `The Queue Manager will **reject** your response if:
1. It has fewer than 3 numbered steps
2. It doesn't include a Developer Handover section
3. It tries to execute the work instead of planning it

**A well-structured plan IS a valid deliverable in this phase.**`
      };
    }

    // Phase 3: SPECIALIST_INPUT — the deliverable is a short review verdict
    if (phase === 3) {
      return {
        expectations: `- **Deliver a specialist review verdict** — APPROVE, CONCERN, or SUGGEST
- **Keep it concise** (2-5 sentences focused on your domain expertise)
- **Include a Developer Handover** at the end of your response (mandatory RALF requirement)
- **Read the PM's plan** in the thread above before reviewing`,
        qualityBar: `The Queue Manager will **reject** your response if:
1. It doesn't include a clear verdict (APPROVE/CONCERN/SUGGEST)
2. It tries to execute work instead of reviewing the plan
3. It doesn't include a Developer Handover section`
      };
    }

    // Phase 5: REVIEW — the deliverable is a quality assessment
    if (phase === 5) {
      return {
        expectations: `- **Deliver a quality review** with a clear PASS or REVISE verdict
- **Evaluate against the original ticket requirements** — does the work actually answer what was asked?
- **Include a Developer Handover** at the end of your response (mandatory RALF requirement)
- **Read the full thread** to understand what was planned and executed`,
        qualityBar: `The Queue Manager will **reject** your response if:
1. It doesn't include a PASS or REVISE verdict
2. It tries to redo the work instead of reviewing it
3. It doesn't include a Developer Handover section`
      };
    }

    // Phase 4: EXECUTION and all other phases (default) — real work product expected
    return {
      expectations: `- **Deliver real work product** — the actual code, document, analysis, or answer
- **Include a summary inline** — even if you write files, always provide a human-readable summary in your response
- **Link to workspace files** if you created them — file references WITH summaries are fine
- **Include a Developer Handover** at the end of your response (mandatory RALF requirement)
- **Read the full thread** before starting — previous agents may have done work already
- **Use your 200K context window** — be thorough, not lazy`,
      qualityBar: `The Queue Manager will **reject** your response if:
1. It's just an outline or plan without actual deliverable content
2. It doesn't include a Developer Handover section
3. It references workspace files without providing a summary of what's in them

**Writing to files is fine — just include a summary + link so reviewers can see what you produced.**`
    };
  }

  // ─────────────────────────────────────────────
  // 2. COMPLETION — Agent finished, ticket → Customer Action
  //    isParent: true → customer-facing summary
  //    isParent: false → full technical detail
  //    taskId: optional - if provided, scans workspace for deliverable files
  // ─────────────────────────────────────────────
  /**
   * @description Format the comment posted when an agent finishes its work and the ticket
   * moves to Customer Action. Parent tickets get a jargon-free customer summary; leaf tickets
   * get full technical detail plus an auto-scanned workspace file listing, so each audience
   * sees the right level of depth.
   * @param {string} agentId - Identifier of the agent that produced the work.
   * @param {string} content - The agent's deliverable / response text.
   * @param {boolean} [isParent=false] - When true, render a customer-facing summary instead of technical detail.
   * @param {string|null} [taskId=null] - When provided, scan that task's workspace for deliverable/note files to link.
   * @returns {string} Formatted completion comment.
   */
  completionComment(agentId, content, isParent = false, taskId = null) {
    if (isParent) {
      return this.customerSummary(content);
    }

    // PHASE_34: Scan workspace with notes/ + deliverables/ structure awareness
    let workspaceSection = '';
    if (taskId) {
      workspaceSection = this._scanWorkspaceStructured(taskId);
    }

    const truncated = this.truncate(content, this.maxDetailLength);

    return `✅ **Agent Work Complete**

**Agent:** ${agentId}
${workspaceSection}
${truncated}

${this._footer()}`;
  }

  // ─────────────────────────────────────────────
  // 2b. WORKSPACE LINK — Posted when agent is first assigned
  // ─────────────────────────────────────────────
  /**
   * @description Announce the per-ticket workspace when an agent is first assigned, so
   * humans and downstream agents know where working notes and final deliverables will live.
   * @param {string} taskId - Task identifier used to build the workspace URL.
   * @param {string} ticketTitle - Ticket title shown in the comment header.
   * @returns {string} Formatted workspace-created comment.
   */
  workspaceLinkComment(taskId, ticketTitle) {
    return `📂 **Workspace Created**

**Ticket:** ${ticketTitle || 'See above'}
**Workspace:** http://localhost:3010/workspace/${taskId}/

| Folder | Purpose |
|--------|---------|
| \`notes/\` | Agent working notes, research, drafts |
| \`deliverables/\` | Final artifacts for customer review |

All agent work will be organized in this workspace.

${this._footer()}`;
  }

  // ─────────────────────────────────────────────
  // PRIVATE: Scan workspace with notes/deliverables structure
  // ─────────────────────────────────────────────
  /**
   * @description Build a markdown section listing a task's workspace artifacts, grouped into
   * deliverables, notes, and other root files, so completion comments surface concrete links
   * to what the agent produced. Fails soft (returns empty string) if the workspace is missing
   * or unreadable, since linking is a convenience and must never block a comment.
   * @param {string} taskId - Task identifier whose workspace directory is scanned.
   * @returns {string} Markdown section with file links, or empty string when nothing to show.
   * @private
   */
  _scanWorkspaceStructured(taskId) {
    try {
      const fs = require('fs');
      const path = require('path');
      const workspaceDir = `/app/workspace/${taskId}`;
      
      if (!fs.existsSync(workspaceDir)) return '';

      let section = '';
      const baseUrl = `http://localhost:3010/workspace/${taskId}`;

      // Scan deliverables/ folder
      const deliverablesDir = path.join(workspaceDir, 'deliverables');
      if (fs.existsSync(deliverablesDir)) {
        const deliverableFiles = this._listFilesRecursive(deliverablesDir, 'deliverables');
        if (deliverableFiles.length > 0) {
          section += `\n### 📦 Deliverables\n\n`;
          section += `**Browse:** [deliverables/](${baseUrl}/deliverables/)\n\n`;
          for (const file of deliverableFiles) {
            section += `- [${file.relativePath}](${baseUrl}/${file.relativePath}) (${file.sizeKB}KB)\n`;
          }
          section += `\n`;
        }
      }

      // Scan notes/ folder
      const notesDir = path.join(workspaceDir, 'notes');
      if (fs.existsSync(notesDir)) {
        const noteFiles = this._listFilesRecursive(notesDir, 'notes');
        if (noteFiles.length > 0) {
          section += `### 📝 Agent Notes\n\n`;
          section += `**Browse:** [notes/](${baseUrl}/notes/)\n\n`;
          for (const file of noteFiles) {
            section += `- [${file.relativePath}](${baseUrl}/${file.relativePath}) (${file.sizeKB}KB)\n`;
          }
          section += `\n`;
        }
      }

      // Fallback: scan root for any files not in notes/ or deliverables/
      const rootFiles = fs.readdirSync(workspaceDir).filter(f => {
        if (f.startsWith('.') || f === 'index.html' || f === 'README.md' || f === 'workspace_all.html') return false;
        const stat = fs.statSync(path.join(workspaceDir, f));
        return stat.isFile(); // only files at root, not the dirs themselves
      });

      if (rootFiles.length > 0) {
        section += `### 📁 Other Files\n\n`;
        for (const file of rootFiles) {
          try {
            const stats = fs.statSync(path.join(workspaceDir, file));
            const sizeKB = Math.round(stats.size / 1024);
            section += `- [${file}](${baseUrl}/${file}) (${sizeKB}KB)\n`;
          } catch (e) {
            section += `- [${file}](${baseUrl}/${file})\n`;
          }
        }
        section += `\n`;
      }

      if (section) {
        section = `\n**📂 Workspace:** ${baseUrl}/\n` + section;
      }

      return section;
    } catch (error) {
      logger.warn(`Failed to scan workspace for task ${taskId}: ${error.message}`);
      return '';
    }
  }

  /**
   * Recursively list files in a directory with relative paths
   * @param {string} dir - Absolute directory path
   * @param {string} prefix - Relative path prefix (e.g., 'deliverables')
   * @returns {Array<{relativePath: string, sizeKB: number}>}
   */
  _listFilesRecursive(dir, prefix) {
    const fs = require('fs');
    const path = require('path');
    const results = [];

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(dir, entry.name);
        const relativePath = `${prefix}/${entry.name}`;
        
        if (entry.isDirectory()) {
          results.push(...this._listFilesRecursive(fullPath, relativePath));
        } else {
          try {
            const stats = fs.statSync(fullPath);
            results.push({ relativePath, sizeKB: Math.round(stats.size / 1024) });
          } catch (e) {
            results.push({ relativePath, sizeKB: 0 });
          }
        }
      }
    } catch (e) {
      // Directory read failed, return what we have
    }

    return results;
  }

  // ─────────────────────────────────────────────
  // 3. HANDOFF — Agent did partial work, ticket stays in queue
  // ─────────────────────────────────────────────
  /**
   * @description Format the comment used when an agent completes only partial work and the
   * ticket stays in the queue for continuation, recording what was done and why so the next
   * agent (and any reviewer) has continuity.
   * @param {string} agentId - Agent that performed the partial work.
   * @param {string} workDone - Description of work completed so far (truncated for length).
   * @param {string} reason - Why the agent is handing off / status note.
   * @returns {string} Formatted in-progress handoff comment.
   */
  handoffComment(agentId, workDone, reason) {
    const truncatedWork = this.truncate(workDone, 5000);

    return `🔄 **Agent Work In Progress**

**Agent:** ${agentId}
**Status:** ${reason}

**Work Completed:**
${truncatedWork}

**Next:** Queue Manager will route this ticket for continued work.

${this._footer()}`;
  }

  // ─────────────────────────────────────────────
  // 4. ERROR — Agent processing failed
  // ─────────────────────────────────────────────
  /**
   * @description Format the comment posted when an agent's processing fails, surfacing the
   * error and signaling that the ticket has been returned to the Todo queue for re-routing,
   * so the failure is visible and recovery is automatic rather than silent.
   * @param {string} agentId - Agent that encountered the failure.
   * @param {string} errorMessage - Human-readable error detail.
   * @returns {string} Formatted error comment.
   */
  errorComment(agentId, errorMessage) {
    return `⚠️ **Agent Processing Failed**

**Agent:** ${agentId}
**Error:** ${errorMessage}

**Action:** Ticket returned to Todo queue for re-routing.

${this._footer()}`;
  }

  // ─────────────────────────────────────────────
  // 5. ESCALATION — Needs human intervention
  // ─────────────────────────────────────────────
  /**
   * @description Format the comment that pulls a human into the loop, explaining why
   * automation cannot proceed and giving explicit next steps, so escalations are actionable
   * rather than just a dead-end notification.
   * @param {string} reason - Why human help is required.
   * @param {string} agentSummary - Summary of agent work so far (falls back to a pointer to prior comments).
   * @returns {string} Formatted escalation comment with an @human mention.
   */
  escalationComment(reason, agentSummary) {
    return `⚠️ **Human Assistance Required**

@human

**Why Human Help is Needed:**
${reason}

**Agent Work Summary:**
${agentSummary || '(Review comments above for agent work completed)'}

**What To Do Next:**
1. Review agent work in comments above
2. Provide missing information, credentials, or direction
3. Re-assign or close ticket as appropriate

**Status:** Customer Action (Escalated)

${this._footer()}`;
  }

  // ─────────────────────────────────────────────
  // 6. RECOVERY — Stalled task timeout
  // ─────────────────────────────────────────────
  /**
   * @description Format the comment logged when a stalled ticket is auto-recovered after
   * exceeding the in-progress timeout, documenting how long it was stuck and the threshold
   * crossed so the automatic re-queue is transparent and auditable.
   * @param {number} minutesStalled - How long the ticket sat in progress without completion.
   * @param {number} stallTimeoutMinutes - The configured timeout threshold that was exceeded.
   * @returns {string} Formatted timeout-recovery comment.
   */
  recoveryComment(minutesStalled, stallTimeoutMinutes) {
    return `⏱️ **Task Timeout Recovery**

This ticket was stuck in "In Progress" for **${minutesStalled} minutes** without completion.

**Action:** Automatically returned to Todo queue for re-processing.
**Timeout threshold:** ${stallTimeoutMinutes} minutes

A fresh agent will be assigned on the next poll cycle.

${this._footer()}`;
  }

  // ─────────────────────────────────────────────
  // 7. DECOMPOSITION — Subtask breakdown created
  // ─────────────────────────────────────────────
  /**
   * @description Format the comment announcing that a complex ticket was split into
   * independently routable sub-issues, listing the children and noting the recursion depth,
   * so the work breakdown and parent-waits-on-children relationship are clear to humans.
   * @param {Array<{title: string}>} childIds - Created child sub-issues (each with a title).
   * @param {number} depth - Current decomposition depth (out of the max of 3 levels).
   * @returns {string} Formatted decomposition comment.
   */
  decompositionComment(childIds, depth) {
    const childList = childIds.map((c, i) => `${i + 1}. **${c.title}**`).join('\n');

    return `🔀 **Subtask Decomposition** (Depth: ${depth}/3)

This ticket has been broken into **${childIds.length} sub-issues**:

${childList}

Each sub-issue will be routed independently through the agent swarm. Sub-issues may be further decomposed if still too complex (max 3 levels).

**Parent status:** In Review (waiting for all children to complete)

${this._footer()}`;
  }

  // ─────────────────────────────────────────────
  // 8. CIRCUIT BREAKER — Too many routing attempts
  // ─────────────────────────────────────────────
  /**
   * @description Format the comment posted when the circuit breaker fires after too many
   * routing attempts, recording the trip reason and attempt count and handing the ticket to
   * a human, so runaway re-routing loops are stopped and made visible instead of spinning.
   * @param {string} reason - Why the circuit breaker tripped.
   * @param {number} routeCount - Total routing attempts made before tripping.
   * @returns {string} Formatted circuit-breaker comment.
   */
  circuitBreakerComment(reason, routeCount) {
    return `⛔ **Circuit Breaker Triggered**

**Reason:** ${reason}
**Total routing attempts:** ${routeCount}

**Action:** Escalating to human review. Please review agent work in comments above and provide additional direction or close the ticket.

${this._footer()}`;
  }

  // ─────────────────────────────────────────────
  // 9. LOCK WARNING — Task locked by another agent
  // ─────────────────────────────────────────────
  /**
   * @description Format the comment noting that a task is already locked by another agent
   * and this routing attempt is being skipped, so concurrent processing collisions are
   * documented rather than causing duplicate or conflicting work.
   * @param {string} owner - Agent currently holding the task lock.
   * @param {string} taskId - Identifier of the locked task.
   * @returns {string} Formatted lock-warning comment.
   */
  lockWarningComment(owner, taskId) {
    return `🔒 **Task Locked**

Task \`${taskId}\` is currently being processed by agent **${owner}**.

**Action:** Skipping this routing attempt. Will retry after current agent completes.

${this._footer()}`;
  }

  // ─────────────────────────────────────────────
  // 10. CUSTOMER SUMMARY — Plain-English summary for parent tickets
  //     Strips jargon, limits length, focuses on outcomes
  // ─────────────────────────────────────────────
  /**
   * @description Distill an agent's technical output into a plain-English, outcome-focused
   * summary for parent tickets by stripping internal markers, code noise, and infra jargon
   * and capping length, so non-technical customers see results rather than implementation chatter.
   * @param {string} technicalContent - Raw technical content to sanitize and summarize.
   * @returns {string} Formatted customer-facing summary comment.
   */
  customerSummary(technicalContent) {
    if (!technicalContent || technicalContent.trim().length === 0) {
      return `✅ **Work Complete**\n\nAll requested work has been completed. Please review the sub-ticket details for specifics.\n\n${this._footer()}`;
    }

    // Strip common technical jargon patterns
    let cleaned = technicalContent;

    // Remove internal markers
    cleaned = cleaned.replace(/Queue Manager v[\d.]+/gi, '');
    cleaned = cleaned.replace(/\*Queue Manager.*?\*/g, '');
    cleaned = cleaned.replace(/@agent:[a-z0-9_-]+/gi, 'an agent');
    cleaned = cleaned.replace(/task_[a-f0-9-]+/gi, '');
    cleaned = cleaned.replace(/ticket [a-f0-9-]{36}/gi, 'this ticket');

    // Remove code-level noise
    cleaned = cleaned.replace(/```[\s\S]*?```/g, '[code snippet]');
    cleaned = cleaned.replace(/`[^`]{50,}`/g, '[technical detail]');

    // Remove lines that are purely internal
    const lines = cleaned.split('\n').filter(line => {
      const lower = line.toLowerCase().trim();
      if (lower.startsWith('**agent:**')) return false;
      if (lower.startsWith('**task id:**')) return false;
      if (lower.startsWith('**workspace:**')) return false;
      if (lower.includes('redis') && lower.includes('key')) return false;
      if (lower.includes('docker') && lower.includes('container')) return false;
      if (lower.startsWith('---') && line.trim() === '---') return false;
      return true;
    });

    cleaned = lines.join('\n').trim();

    // Truncate to configured max characters
    if (cleaned.length > this.maxSummaryLength) {
      cleaned = cleaned.substring(0, this.maxSummaryLength) + '\n\n*[Summary truncated at ' + this.maxSummaryLength + ' chars — see sub-tickets for full details]*';
    }

    return `✅ **Work Complete — Summary**

${cleaned}

${this._footer()}`;
  }

  // ─────────────────────────────────────────────
  // 11. ASSEMBLY — Parent auto-assembles deliverables from children
  // ─────────────────────────────────────────────
  /**
   * @description Format the parent ticket's assembled deliverable, stitching every child's
   * result into one reviewable comment with per-subtask sections, a status summary table, and
   * an optional categorized file manifest, so a reviewer sees the whole body of work in one place.
   * @param {string} parentTitle - Title of the parent ticket being assembled.
   * @param {Array<{name: string, status?: string, deliverable?: string}>} childDeliverables - Completed child results.
   * @param {{files: Array<string>}|null} [fileManifest=null] - Optional workspace file manifest to categorize and list.
   * @returns {string} Formatted assembled-deliverable comment (or a simple fallback when there are no children).
   */
  assemblyComment(parentTitle, childDeliverables, fileManifest = null) {
    if (!childDeliverables || childDeliverables.length === 0) {
      return this.parentCompletionComment(0);
    }

    const childSections = childDeliverables.map((child, i) => {
      const status = child.status || 'Unknown';
      const statusIcon = status === 'Done' || status === 'Customer Action' ? '✅' : '🔄';
      const deliverablePreview = child.deliverable
        ? this.truncate(child.deliverable, 2000)
        : '*No deliverable captured*';

      return `### ${i + 1}. ${child.name} ${statusIcon}
**Status:** ${status}

${deliverablePreview}`;
    }).join('\n\n---\n\n');

    // Build file manifest section if available
    let fileSection = '';
    if (fileManifest && fileManifest.files && fileManifest.files.length > 0) {
      const codeFiles = fileManifest.files.filter(f => /\.(js|ts|py|java|go|rs|rb|sh|yaml|yml|json|sql|html|css)$/i.test(f));
      const docFiles = fileManifest.files.filter(f => /\.(md|txt|rst|doc)$/i.test(f));
      const otherFiles = fileManifest.files.filter(f => !codeFiles.includes(f) && !docFiles.includes(f));

      fileSection = `\n\n---\n\n## 📁 Workspace File Manifest\n\n`;
      fileSection += `**${fileManifest.files.length} files** produced in shared workspace\n\n`;

      if (codeFiles.length > 0) {
        fileSection += `### Code Files (${codeFiles.length})\n`;
        fileSection += codeFiles.map(f => `- \`${f}\``).join('\n');
        fileSection += '\n\n';
      }
      if (docFiles.length > 0) {
        fileSection += `### Documentation (${docFiles.length})\n`;
        fileSection += docFiles.map(f => `- \`${f}\``).join('\n');
        fileSection += '\n\n';
      }
      if (otherFiles.length > 0) {
        fileSection += `### Other Files (${otherFiles.length})\n`;
        fileSection += otherFiles.slice(0, 20).map(f => `- \`${f}\``).join('\n');
        if (otherFiles.length > 20) fileSection += `\n- *...and ${otherFiles.length - 20} more*`;
        fileSection += '\n\n';
      }
    }

    return `📦 **Assembled Deliverable — ${parentTitle}**

All **${childDeliverables.length}** subtasks have been completed by specialist agents.

## Subtask Results

${childSections}

---

## Summary

| # | Subtask | Status |
|---|---------|--------|
${childDeliverables.map((c, i) => `| ${i + 1} | ${c.name} | ${c.status || 'Unknown'} |`).join('\n')}

**Total:** ${childDeliverables.length} subtasks completed
${fileSection}
💬 **To request changes:** Move this ticket back to **Todo** and add a comment describing what needs to change. The agents will iterate on the existing workspace.

${this._footer()}`;
  }

  // ─────────────────────────────────────────────
  // 12. STUCK CHILDREN — Parent timeout escalation
  // ─────────────────────────────────────────────
  /**
   * @description Format the escalation comment for a parent whose children have not all
   * completed within the review timeout, tabulating the stuck children and prompting a human
   * to investigate — deliberately never auto-cancelling, since that judgment belongs to a person.
   * @param {Array<{name?: string, title?: string, status?: string}>} stuckChildren - Children still incomplete.
   * @param {number} timeoutMinutes - How long the parent has waited in review.
   * @returns {string} Formatted stuck-children escalation comment.
   */
  stuckChildrenComment(stuckChildren, timeoutMinutes) {
    const stuckList = stuckChildren.map((child, i) => {
      const name = child.name || child.title || `Child #${i + 1}`;
      const status = child.status || 'Unknown';
      return `| ${i + 1} | ${name} | ${status} |`;
    }).join('\n');

    return `⏱️ **Stuck Children Timeout — Escalating to Human**

This parent ticket has been in **"In Review"** for over **${timeoutMinutes} minutes**, but **${stuckChildren.length}** child issue(s) are still not complete.

## Stuck Children

| # | Child Issue | Current Status |
|---|-------------|----------------|
${stuckList}

## Action Required

A human must investigate why these children are stuck:
- **Agent failure?** Check agent logs for errors
- **Circuit breaker?** The child may have been escalated to Customer Action
- **Blocked?** The child may need external input or credentials

**⚠️ Children are NOT auto-cancelled.** Only a human should decide whether to cancel, reassign, or wait longer.

${this._footer()}`;
  }

  // ─────────────────────────────────────────────
  // 13. OVER-DECOMPOSITION WARNING — PM created too many subtasks
  // ─────────────────────────────────────────────
  /**
   * @description Format the warning shown when a PM agent asks for more subtasks than the
   * system permits, explaining that only the allowed number were created, so the cap and its
   * consequence are transparent rather than silently dropping extra work items.
   * @param {number} requestedCount - Number of subtasks the PM agent requested.
   * @param {number} maxAllowed - System cap on subtasks actually created.
   * @returns {string} Formatted over-decomposition warning comment.
   */
  overDecompositionWarning(requestedCount, maxAllowed) {
    return `⚠️ **Over-Decomposition Warning**

The PM agent requested **${requestedCount}** subtasks, but the system caps at **${maxAllowed}**.

Only the first **${maxAllowed}** subtasks were created. If additional work items are needed, they can be created manually or by further decomposing existing subtasks.

${this._footer()}`;
  }

  // ─────────────────────────────────────────────
  // PARENT COMPLETION — All children done (simple fallback)
  // ─────────────────────────────────────────────
  /**
   * @description Format the simple fallback comment marking a parent ticket Done once all its
   * children resolve, used when no richer assembled deliverable is available so closure is
   * still recorded clearly.
   * @param {number} totalChildren - Number of child issues that were resolved.
   * @returns {string} Formatted parent-completion comment.
   */
  parentCompletionComment(totalChildren) {
    return `✅ **All Subtasks Complete**

All **${totalChildren}** child issues have been resolved. Parent ticket automatically marked as Done.

${this._footer()}`;
  }

  // ─────────────────────────────────────────────
  // RE-ROUTE — Agent requesting different specialist
  // ─────────────────────────────────────────────
  /**
   * @description Format the comment for when an agent hands a ticket to a different specialist,
   * preserving what was finished, what remains, and why, so the receiving agent picks up with
   * full context instead of restarting.
   * @param {string} completedWork - Description of work already done.
   * @param {string} remainingWork - Description of work still needed.
   * @param {string} reason - Why a different specialist is being requested.
   * @param {string} targetAgent - Identifier of the agent being routed to.
   * @returns {string} Formatted re-routing comment.
   */
  rerouteComment(completedWork, remainingWork, reason, targetAgent) {
    return `🔄 **Re-Routing Requested**

**Previous Work Completed:**
${completedWork}

**Remaining Work:**
${remainingWork}

**Reason:** ${reason}

**Now routing to:** @agent:${targetAgent}

${this._footer()}`;
  }

  // ─────────────────────────────────────────────
  // WORK COMPLETE (human review ready)
  // ─────────────────────────────────────────────
  /**
   * @description Format the comment signaling that all agent work is done and the ticket is
   * ready for human review, crediting the agents involved and their contribution count so the
   * reviewer knows the scope of collaboration before reading.
   * @param {Array<string>} agentsInvolved - Identifiers of agents that contributed.
   * @param {number} contributionCount - Total number of contributions made.
   * @returns {string} Formatted ready-for-review comment.
   */
  humanReviewComment(agentsInvolved, contributionCount) {
    return `✅ **Work Complete — Ready for Review**

**Agents Involved:** ${agentsInvolved.join(', ')}
**Total Contributions:** ${contributionCount}

All agent work has been completed. This ticket is ready for human review.

${this._footer()}`;
  }

  // ─────────────────────────────────────────────
  // UTILITIES
  // ─────────────────────────────────────────────

  /**
   * Truncate text with indicator
   * @param {string} text - Text to truncate
   * @param {number} maxLength - Max character length
   * @returns {string} Truncated text
   */
  truncate(text, maxLength) {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '\n\n*[Truncated at ' + maxLength.toLocaleString() + ' characters]*';
  }

  /**
   * Standard footer with QM version
   * @returns {string}
   */
  _footer() {
    return `---\n*Queue Manager v${this.version}*`;
  }

  /**
   * Convert markdown to basic HTML suitable for Plane's rich text renderer
   * Handles: bold, italic, code, headings, lists, links, horizontal rules
   * @param {string} markdown - Markdown text
   * @returns {string} HTML string
   */
  toPlaneHtml(markdown) {
    if (!markdown) return '<p></p>';

    let html = markdown;

    // Code blocks
    html = html.replace(/```[\s\S]*?```/g, match => {
      const code = match.replace(/```\w*\n?/, '').replace(/\n?```$/, '');
      return `<pre><code>${code.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`;
    });

    // Headings
    html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
    html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
    html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

    // Bold and italic
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    // Horizontal rules
    html = html.replace(/^---$/gm, '<hr/>');

    // Lists
    html = html.replace(/^\s*[-*]\s+(.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');

    // Paragraphs (lines not already wrapped in block elements)
    const lines = html.split('\n');
    const result = lines.map(line => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      if (trimmed.startsWith('<h') || trimmed.startsWith('<ul') || trimmed.startsWith('<li') ||
          trimmed.startsWith('<pre') || trimmed.startsWith('<hr') || trimmed.startsWith('</')) {
        return line;
      }
      return `<p>${line}</p>`;
    });

    return result.filter(l => l).join('\n');
  }
}

module.exports = CommentFormatter;