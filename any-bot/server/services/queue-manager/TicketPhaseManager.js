/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * TicketPhaseManager — 7-Phase Ticket Lifecycle State Machine
 * 
 * Manages the phased processing of tickets through the agentic swarm:
 *   Phase 1: INTAKE        — QM posts structured brief (automated, no LLM)
 *   Phase 2: PLANNING      — PM writes approach plan (not execution)
 *   Phase 3: SPECIALIST    — Domain bots review the plan (HIGH complexity only)
 *   Phase 4: EXECUTION     — Best-fit agent executes the plan
 *   Phase 5: REVIEW        — Different agent reviews deliverable (MEDIUM+ complexity)
 *   Phase 6: DELIVERY      — QM packages for customer (automated)
 * 
 * Created: 2026-02-11 — PHASE_20_SESSION_02
 * Design: docs/architecture/TICKET_LIFECYCLE_PHASES.md
 */

const logger = require('../../utils/logger');

// Phase constants — 8-phase lifecycle with deploy + test
/**
 * @description Canonical numeric identifiers for each lifecycle phase. Exported so
 * other modules can reference phases by name (e.g. PHASES.EXECUTION) rather than
 * hard-coding magic numbers, keeping phase routing and gate logic in sync as the
 * lifecycle evolves. Phase 8 is intentionally reserved for future monitoring.
 */
const PHASES = {
  INTAKE: 1,
  PLANNING: 2,
  SPECIALIST_INPUT: 3,
  EXECUTION: 4,
  TESTING: 5,       // ⭐ NEW: Functional testing of deliverable
  REVIEW: 6,        // Consensus review cycle (was 5)
  DELIVERY: 7,      // Was 6
  // Phase 8 reserved for future (monitoring/post-deploy)
};

/**
 * @description Reverse lookup mapping each phase number to its human-readable name.
 * Exported so logs, Plane comments, and external consumers can render a phase
 * label without duplicating the PHASES map. Kept as a separate structure so the
 * numeric→name direction stays O(1) for hot-path logging.
 */
const PHASE_NAMES = {
  1: 'INTAKE',
  2: 'PLANNING',
  3: 'SPECIALIST_INPUT',
  4: 'EXECUTION',
  5: 'TESTING',
  6: 'REVIEW',
  7: 'DELIVERY',
};

const PHASE_SUB_STATUS = {
  1: 'intake',
  2: 'planning',
  3: 'specialist-review',
  4: 'executing',
  5: 'testing',
  6: 'peer-review',
  7: 'delivered',
};

// Fast-track paths based on complexity
// ⭐ All paths now include TESTING (5) between EXECUTION and REVIEW
/**
 * @description Per-complexity ordered phase sequences. Exported because phase
 * advancement and terminal-state detection depend on the exact path a ticket
 * follows. Encoding the fast-track routing here lets cheaper tickets skip
 * specialist input and/or peer review while guaranteeing every ticket is still
 * tested, so cost scales with complexity without sacrificing the quality gate.
 */
const PHASE_PATHS = {
  low:    [1, 2, 4, 5, 7],          // Skip specialist + review, but still test
  medium: [1, 2, 4, 5, 6, 7],       // Skip specialist input
  high:   [1, 2, 3, 4, 5, 6, 7],    // Full lifecycle with all phases
};

/**
 * @description State machine that drives a ticket through the phased agentic
 * swarm lifecycle. It owns the source of truth for "where is this ticket now"
 * (persisted in Redis), the rules for moving forward and backward between
 * phases, the role-priming prompt each agent receives per phase, the pass/fail
 * gate logic that decides whether a phase's output is acceptable, and the agent
 * selection policy per phase. Centralizing these concerns keeps phase behavior
 * consistent across the queue manager and prevents phase logic from leaking into
 * callers.
 */
class TicketPhaseManager {
  /**
   * @description Construct a phase manager bound to a Redis client. All phase
   * state is stored in Redis (with a TTL) rather than in memory so that phase
   * progress survives process restarts and can be shared across workers.
   * @param {Object} redisClient - Connected Redis client used to read/write phase state.
   */
  constructor(redisClient) {
    this.redis = redisClient;
  }

  /**
   * Get the current phase of a ticket
   * @param {string} ticketId 
   * @returns {Object|null} { phase, subStatus, assignedAgent, phaseStartedAt, complexity, executingAgent }
   */
  async getPhase(ticketId) {
    try {
      const key = `qm:ticket_phase:${ticketId}`;
      const data = await this.redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch (err) {
      logger.warn(`Failed to get ticket phase for ${ticketId}: ${err.message}`);
      return null;
    }
  }

  /**
   * Set the phase of a ticket
   * @param {string} ticketId 
   * @param {number} phase - Phase number (1-6)
   * @param {Object} opts - { complexity, assignedAgent, executingAgent }
   */
  async setPhase(ticketId, phase, opts = {}) {
    try {
      const key = `qm:ticket_phase:${ticketId}`;
      const data = {
        phase,
        phaseName: PHASE_NAMES[phase],
        subStatus: PHASE_SUB_STATUS[phase],
        assignedAgent: opts.assignedAgent || null,
        executingAgent: opts.executingAgent || null,
        complexity: opts.complexity || 'medium',
        phaseStartedAt: Date.now(),
      };
      await this.redis.set(key, JSON.stringify(data), 'EX', 86400); // 24h TTL
      logger.info(`📍 Ticket ${ticketId} → Phase ${phase} (${PHASE_NAMES[phase]}) [${data.complexity}]`);
      return data;
    } catch (err) {
      logger.error(`Failed to set ticket phase for ${ticketId}: ${err.message}`);
      return null;
    }
  }

  /**
   * Advance ticket to the next phase based on its complexity path
   * @param {string} ticketId
   * @returns {Object|null} New phase data, or null if at end
   */
  async advancePhase(ticketId) {
    const current = await this.getPhase(ticketId);
    if (!current) {
      logger.warn(`Cannot advance phase for ${ticketId}: no phase data`);
      return null;
    }

    const path = PHASE_PATHS[current.complexity] || PHASE_PATHS.medium;
    const currentIdx = path.indexOf(current.phase);
    
    if (currentIdx === -1 || currentIdx >= path.length - 1) {
      logger.info(`📍 Ticket ${ticketId} at terminal phase ${current.phase} (${PHASE_NAMES[current.phase]})`);
      return null; // At end of path
    }

    const nextPhase = path[currentIdx + 1];
    return await this.setPhase(ticketId, nextPhase, {
      complexity: current.complexity,
      executingAgent: current.executingAgent,
    });
  }

  /**
   * ⭐ Regress ticket to an earlier phase (e.g., TESTING fails → back to EXECUTION or PLANNING)
   * Unlike advancePhase which only moves forward, this can jump backwards in the lifecycle.
   * Used when testing or review finds issues requiring rework.
   * @param {string} ticketId
   * @param {number} targetPhase - The phase to regress to (e.g., PHASES.EXECUTION or PHASES.PLANNING)
   * @returns {Object|null} New phase data at the regression target
   */
  async regressPhase(ticketId, targetPhase) {
    const current = await this.getPhase(ticketId);
    if (!current) {
      logger.warn(`Cannot regress phase for ${ticketId}: no phase data`);
      return null;
    }

    if (targetPhase >= current.phase) {
      logger.warn(`Cannot regress ${ticketId} from phase ${current.phase} to ${targetPhase} (must go backwards)`);
      return null;
    }

    logger.warn(`⏪ REGRESSION: Ticket ${ticketId} regressing from Phase ${current.phase} (${PHASE_NAMES[current.phase]}) → Phase ${targetPhase} (${PHASE_NAMES[targetPhase]})`);

    return await this.setPhase(ticketId, targetPhase, {
      complexity: current.complexity,
      executingAgent: current.executingAgent,
    });
  }

  /**
   * Get the phase-specific prompt prefix that tells the agent its role
   * @param {number} phase 
   * @param {Object} ticket - Ticket object
   * @param {string} agentId - Assigned agent
   * @returns {string} Phase-specific instruction block
   */
  getPhasePrompt(phase, ticket, agentId) {
    switch (phase) {
      case PHASES.PLANNING:
        return `═══════════════════════════════════════════
🎯 YOUR ROLE: PLANNING (Phase 2 of 6)
═══════════════════════════════════════════

You are in the **PLANNING** phase. Your job is to create an APPROACH PLAN — NOT to do the actual work.

**What to produce:**
1. A numbered list of steps (minimum 3) to accomplish this ticket
2. Which specialist agent(s) should execute each step
3. What the final deliverable should look like
4. Estimated complexity and any risks/blockers

**What NOT to do:**
- ❌ Do NOT execute the plan yourself
- ❌ Do NOT write the actual code/document/analysis
- ❌ Do NOT answer the question directly

**Example GOOD plan:**
## 📋 Approach Plan

1. **Research** — Use Google Search to gather current data on the topic
2. **Analyze** — Compare findings against our existing documentation  
3. **Draft** — Write the deliverable document with sections A, B, C
4. **Review** — Have a specialist validate the technical accuracy

**Specialist needed:** research-bot (step 1), documentation-bot (step 3)
**Deliverable:** A comprehensive analysis document (~3000 words)
**Risks:** External API rate limits on research phase

**Example BAD response:**
"Here is the full analysis..." ← NO! That's execution, not planning.

═══════════════════════════════════════════
SUBTASK DECOMPOSITION (Optional)
═══════════════════════════════════════════

When analyzing this ticket, determine if it requires decomposition into sub-issues:

**DECOMPOSE when:**
- The ticket requires 3+ distinct deliverables across different domains
- Multiple specialist skills are needed (e.g., security + devops + documentation)
- The work would take multiple agents working sequentially on DIFFERENT topics
- The scope is clearly multi-disciplinary

**DO NOT DECOMPOSE when:**
- The ticket is a single focused question or task
- One specialist can handle the entire scope
- The work is already a subtask (check "Decomposition Depth" in description)
- The ticket description contains "Decomposition Depth:" — this means it's ALREADY a subtask. DO NOT re-decompose.
- The complexity is low or medium with a single domain
- You have already seen similar subtask names in the thread above — decomposing again would create DUPLICATES

⚠️ **CRITICAL — ANTI-RECURSION RULE (Issue #031):**
The system enforces a MAX DEPTH of 2 levels. If "Decomposition Depth" in the description shows 1/4 or higher,
the system WILL REJECT your decomposition. Do NOT waste tokens outputting subtask decomposition for tickets
that are already subtasks. Instead, write your plan steps and let the execution agent do the work directly.

**If decomposing, output EXACTLY this format at the END of your plan:**

## SUBTASK DECOMPOSITION

### Subtask 1: [Clear, Actionable Title]
- **Priority:** High/Medium/Low
- **Complexity:** Low/Medium/High  
- **Skills:** [comma-separated specialist skills needed]
- **Objective:** [1-2 sentence goal]
- **Deliverables:** [What the agent must produce]
- **Acceptance Criteria:** [How to know it's done]

### Subtask 2: [Title]
...

### Subtask N: Integration & Validation
- **Priority:** Medium
- **Skills:** project-management, quality-review
- **Objective:** Verify all subtask deliverables integrate correctly
- **Deliverables:** Consolidated report confirming all pieces fit together

**Rules:**
- Limit to 2-5 subtasks (system hard cap: 7)
- The LAST subtask should always be "Integration & Validation"
- Each subtask must be completable by a SINGLE specialist agent
- Do NOT decompose if 1-2 agents can handle the whole ticket

Your plan will be reviewed by the Queue Manager before execution begins.
═══════════════════════════════════════════`;

      case PHASES.SPECIALIST_INPUT:
        return `═══════════════════════════════════════════
🔍 YOUR ROLE: PLAN REVIEW (Phase 3 of 6)
═══════════════════════════════════════════

You are a **SPECIALIST REVIEWER**. A Project Manager has created an approach plan for this ticket.

**Read the PM's plan in the thread above**, then post ONE of these verdicts:

**APPROVE** — "The approach is sound for my domain. Proceed to execution."
**CONCERN** — "Risk: [specific issue]. Must be addressed before execution."
**SUGGEST** — "Add step: [specific improvement]. This would improve quality."

Keep your review SHORT (2-5 sentences). Focus on your domain expertise.
Do NOT execute any work — just evaluate the plan.
═══════════════════════════════════════════`;

      case PHASES.TESTING:
        return `═══════════════════════════════════════════
🧪 YOUR ROLE: TESTING (Phase 5 of 7)
═══════════════════════════════════════════

You are in the **TESTING** phase. An agent has executed work and produced a deliverable.

**Read the full thread above** — the execution deliverable, the plan, and the original request.

**Your job:** TEST the deliverable for correctness, completeness, and quality.

═══════════════════════════════════════════
TESTING CHECKLIST
═══════════════════════════════════════════

1. **Does it meet the ticket requirements?** — Compare the deliverable against every requirement in the original ticket
2. **Is it functionally correct?** — If code: does it compile/run? If document: is it factually accurate?
3. **Is it complete?** — Are there any missing sections, TODO placeholders, or incomplete implementations?
4. **Does it integrate properly?** — Check workspace files for consistency and proper integration
5. **Are there any bugs or errors?** — Review for logical errors, edge cases, security issues

═══════════════════════════════════════════
YOUR VERDICT
═══════════════════════════════════════════

**TEST PASS** — All tests pass, deliverable is correct and complete:
\`\`\`
## Test Verdict: PASS
All requirements met. Deliverable is functionally correct and complete.
[Brief summary of what was tested and confirmed working]
\`\`\`

**TEST FAIL** — Issues found that MUST be fixed before review:
\`\`\`
## Test Verdict: FAIL
### Issues Found
1. [Specific issue — what's wrong, expected vs actual]
2. [Another issue]
### Regression Target: EXECUTION
The executor must fix these issues before the deliverable can proceed to review.
\`\`\`

**TEST FAIL (Design Issue)** — Fundamental design flaw requiring re-planning:
\`\`\`
## Test Verdict: FAIL
### Design Issues
1. [Fundamental problem with the approach]
### Regression Target: PLANNING
The plan itself needs revision — this is not just an execution bug.
\`\`\`

**IMPORTANT:** If tests fail, specify whether to regress to EXECUTION (implementation fix) or PLANNING (design rethink).
═══════════════════════════════════════════`;

      case PHASES.EXECUTION:
        return `═══════════════════════════════════════════
⚡ YOUR ROLE: EXECUTION (Phase 4 of 7)
═══════════════════════════════════════════

You are in the **EXECUTION** phase. A plan has been created and approved.

**Read the full thread above** — it contains:
1. The original ticket request
2. The QM's task brief
3. The PM's approach plan
4. Any specialist feedback

**Your job:** FOLLOW THE PLAN and produce the actual deliverable.
- Execute each step in the plan
- Produce real, substantive work (not outlines)
- Include ALL content inline in your response
- Write a Developer Handover at the end

**Quality bar:** Your work will be reviewed by a DIFFERENT agent before going to the customer.
═══════════════════════════════════════════`;

      case PHASES.REVIEW:
        return `═══════════════════════════════════════════
🔥 YOUR ROLE: QUALITY AGITATOR (Phase 5 of 6)
═══════════════════════════════════════════

You are the **QUALITY AGITATOR**. Your job is to PUSH BACK on mediocre work and force excellence.

You are NOT a rubber stamp. You are the last line of defense before this goes to a paying customer.

**Read the FULL thread above** — the original ticket request, the PM's plan, the specialist feedback, AND the execution deliverable. Then ask yourself:

═══════════════════════════════════════════
THE AGITATOR'S QUESTIONS
═══════════════════════════════════════════

1. **"Is this the BEST you can do?"** — Does the deliverable show genuine effort, or is it a lazy first draft? Would YOU be proud to put your name on this?

2. **"Did you actually follow the instructions?"** — Does the deliverable match what the ticket ASKED FOR? Or did the agent go off on a tangent, produce an outline instead of execution, or skip key requirements?

3. **"Would a customer pay for this?"** — Is this professional-grade work? Or would a customer look at this and feel like they got ChatGPT's first response copy-pasted?

4. **"What's MISSING?"** — What did the original ticket ask for that ISN'T in the deliverable? Are there gaps, incomplete sections, or placeholder text?

5. **"Is the formatting clean?"** — Is this well-organized with clear headings, proper code blocks, and readable structure? Or is it a wall of text?

═══════════════════════════════════════════
YOUR VERDICT
═══════════════════════════════════════════

**PASS** — "This is excellent work. The deliverable is complete, professional, and directly addresses the ticket requirements. Ready for customer delivery."
  (Only say PASS if you'd stake your reputation on this quality)

**REVISE** — "This is NOT your best work. Specific issues:
  1. [Concrete problem #1 — what's wrong and how to fix it]
  2. [Concrete problem #2 — what's missing]
  The agent should [specific corrective action] before this can go to the customer."
  (Be brutally specific. Vague feedback like "needs improvement" is useless.)

**Your review should be 5-10 sentences.** Don't hold back — honest, direct feedback produces better results than polite acceptance of mediocrity.

═══════════════════════════════════════════`;

      default:
        return ''; // Phase 1 and 6 are automated (no LLM prompt needed)
    }
  }

  /**
   * Check if a phase gate passes based on the agent's response
   * @param {number} phase - Current phase
   * @param {string} agentResponse - The agent's response text
   * @param {string} complexity - Ticket complexity
   * @returns {{ passed: boolean, reason: string }}
   */
  checkGate(phase, agentResponse, complexity = 'medium') {
    switch (phase) {
      case PHASES.PLANNING: {
        // Gate 2→next: Plan must have ≥3 numbered steps
        const numberedSteps = agentResponse.match(/^\s*\d+\.\s+/gm) || [];
        const hasEnoughSteps = numberedSteps.length >= 3;
        const hasPlanMarker = agentResponse.toLowerCase().includes('plan') || 
                              agentResponse.toLowerCase().includes('approach') ||
                              agentResponse.toLowerCase().includes('steps');
        
        if (hasEnoughSteps && hasPlanMarker) {
          return { passed: true, reason: `Plan has ${numberedSteps.length} steps` };
        }
        return { 
          passed: false, 
          reason: `Plan rejected: found ${numberedSteps.length} numbered steps (need ≥3). Write a proper approach plan with numbered steps.` 
        };
      }

      case PHASES.SPECIALIST_INPUT: {
        // Gate 3→4: ALWAYS PASS — specialist input is ADVISORY, not blocking
        // The specialist's feedback (approve, concern, suggest) is recorded in comments
        // and available to the executing agent. Phase 3 is "get input" not "get approval".
        const lower = agentResponse.toLowerCase();
        const hasApprove = lower.includes('approve');
        const hasConcern = lower.includes('concern') && !lower.includes('no concern');
        const hasSuggest = lower.includes('suggest');
        
        if (hasApprove && !hasConcern) {
          return { passed: true, reason: 'Specialist approved, no concerns' };
        }
        if (hasConcern) {
          return { passed: true, reason: 'Specialist raised concerns (advisory — recorded for execution phase)' };
        }
        if (hasSuggest) {
          return { passed: true, reason: 'Specialist suggested improvements (advisory — recorded for execution phase)' };
        }
        return { passed: true, reason: 'Specialist input recorded, advancing to execution' };
      }

      case PHASES.EXECUTION: {
        // Gate 4→5: Deliverable >500 chars + Developer Handover
        const hasSubstance = agentResponse.length > 500;
        const hasHandover = agentResponse.includes('Developer Handover') || 
                           agentResponse.includes('What I Did') ||
                           agentResponse.includes('## 🔄');
        
        if (hasSubstance && hasHandover) {
          return { passed: true, reason: `Deliverable: ${agentResponse.length} chars with handover` };
        }
        if (!hasSubstance) {
          return { passed: false, reason: `Deliverable too short (${agentResponse.length} chars, need >500)` };
        }
        return { passed: false, reason: 'Missing Developer Handover section' };
      }

      case PHASES.TESTING: {
        // ⭐ Gate 5→6: Test verdict must be PASS. If FAIL, regress to EXECUTION or PLANNING.
        const lower = agentResponse.toLowerCase();
        if (lower.includes('test verdict: pass') || lower.includes('verdict: pass')) {
          return { passed: true, reason: 'Testing: PASS — all tests passed' };
        }
        if (lower.includes('test verdict: fail') || lower.includes('verdict: fail')) {
          // Determine regression target from tester's response
          const regressToPlanning = lower.includes('regression target: planning') || lower.includes('design issue');
          const regressionTarget = regressToPlanning ? 'PLANNING' : 'EXECUTION';
          return { 
            passed: false, 
            reason: `Testing: FAIL — regressing to ${regressionTarget}`,
            regressionTarget: regressToPlanning ? PHASES.PLANNING : PHASES.EXECUTION,
          };
        }
        // Default: if no explicit verdict, pass (don't block on ambiguous test output)
        return { passed: true, reason: 'Testing completed (no explicit failure)' };
      }

      case PHASES.REVIEW: {
        // ⭐ PHASE_12: Review gate now managed by PhaseReviewCycle (consensus-driven)
        return { passed: true, reason: 'Review cycle managed by PhaseReviewCycle — gate deferred' };
      }

      default:
        return { passed: true, reason: 'No gate for this phase' };
    }
  }

  /**
   * Determine which agent should handle a specific phase
   * @param {number} phase 
   * @param {Object} allAgents - All available agents
   * @param {Object} phaseData - Current phase data from Redis
   * @param {Object} analysis - CapabilityMatcher analysis
   * @returns {Object|null} Selected agent
   */
  selectAgentForPhase(phase, allAgents, phaseData, analysis) {
    switch (phase) {
      case PHASES.PLANNING:
        // Always PM for planning
        return allAgents.find(a => a.agent_id === 'project-manager') || allAgents[0];

      case PHASES.SPECIALIST_INPUT:
        // Route to a specialist that matches the ticket domain (not PM)
        return allAgents.find(a => 
          a.agent_id !== 'project-manager' &&
          a.capabilities.some(c => analysis.capabilities.includes(c))
        ) || allAgents.find(a => a.agent_id !== 'project-manager') || allAgents[0];

      case PHASES.EXECUTION:
        // Best-fit specialist based on capability matching
        // (Let the existing CapabilityMatcher handle this — caller provides the match)
        return null; // Signal to use CapabilityMatcher

      case PHASES.TESTING:
        // Testing: use a DIFFERENT agent than executor (fresh eyes for testing)
        const testExec = phaseData?.executingAgent;
        return allAgents.find(a => 
          a.agent_id !== testExec && 
          a.agent_id !== 'project-manager'
        ) || allAgents.find(a => a.agent_id !== testExec) || allAgents[0];

      case PHASES.REVIEW:
        // Must be a DIFFERENT agent than the one who executed
        const executingAgent = phaseData?.executingAgent;
        return allAgents.find(a => 
          a.agent_id !== executingAgent && 
          a.agent_id !== 'project-manager'
        ) || allAgents.find(a => a.agent_id !== executingAgent) || allAgents[0];

      default:
        return null; // Phases 1 and 7 are automated
    }
  }

  /**
   * Get a human-readable phase comment for Plane
   * @param {number} phase 
   * @param {string} action - 'entering' | 'passed' | 'failed'
   * @param {string} detail - Additional detail
   * @returns {string}
   */
  getPhaseComment(phase, action, detail = '') {
    const emoji = {
      1: '📋', 2: '📝', 3: '🔍', 4: '⚡', 5: '🧪', 6: '🔄', 7: '📦'
    };
    const name = PHASE_NAMES[phase];
    
    if (action === 'entering') {
      return `${emoji[phase]} **Phase ${phase}: ${name}** — Starting\n\n${detail}\n\n---\n*Ticket Lifecycle v1.0*`;
    }
    if (action === 'passed') {
      return `${emoji[phase]} **Phase ${phase}: ${name}** — Gate PASSED ✅\n\n${detail}\n\n---\n*Ticket Lifecycle v1.0*`;
    }
    if (action === 'failed') {
      return `${emoji[phase]} **Phase ${phase}: ${name}** — Gate FAILED ❌\n\n${detail}\n\nTicket returned for rework.\n\n---\n*Ticket Lifecycle v1.0*`;
    }
    return '';
  }
}

module.exports = { TicketPhaseManager, PHASES, PHASE_NAMES, PHASE_PATHS };