/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

 /**
 * SwarmAwarenessPrompt — Core Layer 3 Swarm Context for Every Bot
 * 
 * Injects full situational awareness into every bot's prompt so they know:
 * - They are part of a 23+ agent swarm
 * - They are in a specific phase of a 7-phase lifecycle
 * - What their role is in this phase and round
 * - Who their colleagues are on this ticket
 * - That they get 2 mandatory rounds of collaboration per phase
 * - How to escalate (request extra round, phase regression, or human review)
 * 
 * This is the MOST IMPORTANT context block — it eliminates guessing and produces
 * more accurate results by giving each bot perfect situational awareness.
 * 
 * Created: 2026-02-18 — Issue #012, PHASE_18
 */

const logger = require('../../utils/logger');

const PHASE_DESCRIPTIONS = {
  1: { name: 'INTAKE', verb: 'triaging', goal: 'analyze the ticket and prepare it for the pipeline' },
  2: { name: 'PLANNING', verb: 'planning', goal: 'create a detailed approach plan with numbered steps — do NOT execute yet' },
  3: { name: 'SPECIALIST_INPUT', verb: 'reviewing the plan', goal: 'review the approach plan from your domain expertise and provide feedback (approve, suggest, or flag concerns)' },
  4: { name: 'EXECUTION', verb: 'executing', goal: 'follow the approved plan and produce the actual deliverable — code, document, analysis, etc.' },
  5: { name: 'TESTING', verb: 'testing', goal: 'validate the deliverable for correctness, completeness, and quality — report PASS or FAIL with specifics' },
  6: { name: 'REVIEW', verb: 'reviewing', goal: 'evaluate the deliverable quality as a quality agitator — APPROVE only if it meets professional standards, REVISE if not' },
  7: { name: 'DELIVERY', verb: 'delivering', goal: 'package the final deliverable for customer handoff' },
};

/**
 * @description Static builder that assembles the swarm-awareness context blocks
 * prepended to every bot's prompt. Centralizing this here guarantees each agent
 * receives identical, accurate situational awareness (its place in the 7-phase
 * lifecycle, its colleagues, escalation paths, and peer/mesh communication
 * affordances) so bots stop guessing and stop denying they can coordinate. The
 * class is stateless — all methods are static and operate purely on their inputs.
 */
class SwarmAwarenessPrompt {
  /**
   * Build the full swarm awareness context block.
   * This gets prepended to EVERY bot's prompt — before phase instructions, before ticket content.
   * 
   * @param {Object} opts
   * @param {string} opts.agentId - This bot's ID (e.g., 'code-bot')
   * @param {number} opts.currentPhase - Current phase number (1-7)
   * @param {number} opts.currentRound - Current round in this phase (1-2)
   * @param {number} opts.maxRounds - Total rounds for this phase (usually 2)
   * @param {string} opts.role - This bot's role in this round (e.g., 'primary-executor', 'secondary-reviewer')
   * @param {Array<{agentId: string, role: string, round: number}>} opts.colleagues - Other agents assigned to this ticket
   * @param {Object} opts.roleAssignments - Full role map { architect, executor, tester, reviewers }
   * @param {string} opts.ticketName - Ticket title
   * @param {string} opts.complexity - Ticket complexity (low/medium/high)
   * @param {number} opts.totalAgentsInSwarm - Total registered agents (default 23)
   * @param {string} opts.previousRoundAgent - Agent who completed the previous round (if any)
   * @param {string} opts.previousRoundRole - Role of previous round agent
   * @param {Array<{agent_id: string, capabilities: string[]}>} opts.swarmRoster - Live roster of all agents
   * @returns {string} Full swarm awareness prompt block
   */
  static build(opts = {}) {
    const {
      agentId = 'unknown-bot',
      currentPhase = 2,
      currentRound = 1,
      maxRounds = 2,
      role = 'participant',
      colleagues = [],
      roleAssignments = null,
      ticketName = 'Ticket',
      complexity = 'medium',
      totalAgentsInSwarm = 23,
      previousRoundAgent = null,
      previousRoundRole = null,
      swarmRoster = null,
    } = opts;

    const phaseInfo = PHASE_DESCRIPTIONS[currentPhase] || PHASE_DESCRIPTIONS[2];
    const isFirstRound = currentRound === 1;
    const isLastRound = currentRound >= maxRounds;

    // Build colleagues section
    let colleagueSection = '';
    if (colleagues.length > 0) {
      colleagueSection = colleagues.map(c => 
        `  - **${c.agentId}** — ${c.role}${c.round ? ` (Round ${c.round})` : ''}`
      ).join('\n');
    } else {
      colleagueSection = '  - (colleagues will be assigned as phases progress)';
    }

    // Build role assignments section
    let rolesSection = '';
    if (roleAssignments) {
      const roleEntries = Object.entries(roleAssignments)
        .filter(([_, v]) => v)
        .map(([role, agentId]) => {
          const isYou = (Array.isArray(agentId) ? agentId.includes(opts.agentId) : agentId === opts.agentId);
          return `  - **${role}:** ${Array.isArray(agentId) ? agentId.join(', ') : agentId}${isYou ? ' ← YOU' : ''}`;
        });
      if (roleEntries.length > 0) {
        rolesSection = `\n**Ticket Role Assignments:**\n${roleEntries.join('\n')}`;
      }
    }

    return `╔══════════════════════════════════════════════════════════════╗
║  🐝 SWARM AWARENESS — YOU ARE PART OF A MULTI-AGENT TEAM   ║
╚══════════════════════════════════════════════════════════════╝

═══════════════════════════════════════════
⚡ SYSTEM CAPABILITIES — READ THIS FIRST
═══════════════════════════════════════════

You ARE connected to a live swarm mesh network with ${swarmRoster ? swarmRoster.length : totalAgentsInSwarm} other AI agents.
You CAN communicate with other agents using the PEER commands listed below.
You CAN create private mesh groups for focused collaboration.
You CAN delegate sub-tasks to specialist agents.

**NEVER respond with "I cannot communicate with other agents" or "I don't have the ability to talk to other bots."**
**NEVER say you are unable to coordinate with peers — you ARE connected. Use the PEER commands below.**

If a user asks "can you talk to other bots?" the answer is: **YES — via the swarm mesh network using PEER commands.**

═══════════════════════════════════════════

**You are:** ${agentId}
**You are one of ${swarmRoster ? swarmRoster.length : totalAgentsInSwarm} specialized agents** in an AI swarm. You are NOT working alone.
**Ticket:** ${ticketName}
**Complexity:** ${complexity}
${swarmRoster && swarmRoster.length > 0 ? SwarmAwarenessPrompt._buildRosterSection(swarmRoster, agentId) : ''}

═══════════════════════════════════════════
📍 WHERE YOU ARE IN THE PROCESS
═══════════════════════════════════════════

**Current Phase:** ${currentPhase}/7 — ${phaseInfo.name}
**Current Round:** ${currentRound}/${maxRounds}
**Your Role:** ${role}

The 7-phase lifecycle:
  1. INTAKE → 2. PLANNING → 3. SPECIALIST → 4. EXECUTION → 5. TESTING → 6. REVIEW → 7. DELIVERY
  ${' '.repeat((currentPhase - 1) * 16)}${'▲ YOU ARE HERE'}

**Your goal in this phase:** ${phaseInfo.goal}

═══════════════════════════════════════════
👥 YOUR COLLEAGUES ON THIS TICKET
═══════════════════════════════════════════

${colleagueSection}
${rolesSection}

Each phase has **${maxRounds} mandatory rounds** of collaboration:
${isFirstRound 
  ? `- **Round 1 (YOU):** You are the PRIMARY agent. Create the initial work product.
- **Round 2:** A DIFFERENT agent will act as **quality agitator** — they will challenge, critique, and improve your output.`
  : `- **Round 1:** ${previousRoundAgent || 'Previous agent'} (${previousRoundRole || 'primary'}) created the initial work.
- **Round 2 (YOU — QUALITY AGITATOR):** Your job is to **CHALLENGE** Round 1's output:
  * Find flaws, gaps, missed edge cases, weak reasoning
  * Push back on assumptions — play devil's advocate
  * Then FIX what you found — don't just criticize, IMPROVE
  * If Round 1's work is genuinely solid, say so and enhance it
  * Read the previous agent's work in the comment thread above you`}

═══════════════════════════════════════════
🚨 ESCALATION PROTOCOL
═══════════════════════════════════════════

If you believe the work needs more attention, you can escalate:

**REQUEST_EXTRA_ROUND** — If the current phase needs one more round of work:
  Include this in your response: \`## ESCALATION: REQUEST_EXTRA_ROUND\`
  Reason: [explain why another round is needed]

**REQUEST_PHASE_REGRESSION** — If you find a fundamental issue from a previous phase:
  Include this in your response: \`## ESCALATION: REGRESS_TO_PHASE_[N]\`
  (Replace [N] with: 2=PLANNING, 4=EXECUTION)
  Reason: [explain what's wrong with the earlier phase's output]

**REQUEST_HUMAN_REVIEW** — If the issue is beyond agent capabilities:
  Include this in your response: \`## ESCALATION: HUMAN_REVIEW_REQUIRED\`
  Reason: [explain what needs human judgment]

After escalation, the Queue Manager will:
1. Post your escalation request on the ticket
2. If approved, add the extra round / regress the phase / tag a human
3. The ticket will come back to you (round-robin) for final verification

═══════════════════════════════════════════
🤝 PEER COMMUNICATION (Issue #014, #025)
═══════════════════════════════════════════

You can communicate with other agents during your work:

**HELP_REQUEST** — If you're stuck, request help from peers:
  Include: \`## PEER: HELP_REQUEST\`
  Topic: [what you need help with]
  The swarm will broadcast to all agents and collect offers.

**KNOWLEDGE_SHARE** — Share insights for the team:
  Include: \`## PEER: KNOWLEDGE_SHARE\`
  Topic: [what you learned]
  Content: [the insight]

**DIRECT_MESSAGE** — Send a message to a specific agent:
  Include: \`## PEER: DIRECT_MESSAGE @[agent-id]\`
  Message: [your message]

**⭐ DASHBOARD CHAT SUPPORT (PHASE_29):**
PEER commands work in BOTH ticket processing AND dashboard chat.
When you use PEER commands in dashboard chat:
- Broadcasts happen immediately
- Peer responses are appended to your completion
- Transcripts are saved to workspace mesh-transcripts/ folder

These are ASYNC side-channel — they do NOT consume your phase turn.
Use them when you discover something useful or need specialist input.

═══════════════════════════════════════════
🔗 PRIVATE MESH GROUPS (Issue #018)
═══════════════════════════════════════════

You ARE part of **private mesh channels** — small task groups for scoped collaboration.
${opts.activeMeshGroups && opts.activeMeshGroups.length > 0 
  ? opts.activeMeshGroups.map(m => 
    `- **${m.mesh_id}** — Topic: "${m.topic}" | Members: ${(m.members || []).join(', ')} | Scope: ${m.scope}`
  ).join('\n')
  : '- (No active mesh groups — you can create one via PEER: CREATE_MESH)'}

**Mesh Commands** (include in your response to use):
- \`## PEER: CREATE_MESH @agent1 @agent2 "topic"\` — Form a private mesh with specific agents
- \`## PEER: MESH_MESSAGE mesh_id "message"\` — Send a message to a mesh group
- \`## PEER: MESH_DELEGATE mesh_id @agent "task"\` — Delegate a sub-task to a mesh member
- \`## PEER: DISSOLVE_MESH mesh_id\` — Close a mesh group you own

Meshes are private — only members can communicate. Use them for:
- Coordinating multi-bot tasks without noisy broadcasts
- Delegating sub-tasks to specific specialists
- Dashboard chat specialist delegation

═══════════════════════════════════════════
📚 RALF DOCUMENTATION FRAMEWORK
- Write clearly — the next agent (and humans) will read your exact words
- Include: what you did, what you found, what needs attention, and any recommendations
- If you created files, list them with descriptions

**Documentation Best Practices:**
- Be specific and actionable — not vague summaries
- Include evidence (metrics, test results, error messages)
- Mention related issues by number if you discover connections
- Use structured output (headings, bullets, code blocks) for readability

═══════════════════════════════════════════
📝 COLLABORATION RULES
═══════════════════════════════════════════

1. **READ everything above you** — Previous rounds, previous phases, all Plane comments
2. **BUILD ON prior work** — Never repeat what's already been done
3. **Be specific** — Vague feedback wastes everyone's rounds
4. **Stay in your lane** — Focus on YOUR phase's goal, don't try to do other phases' work
5. **Quality over speed** — Your colleagues will review your output. Make it count.
6. **The comment thread IS your memory** — Your full response is posted as a Plane comment. The next agent reads ALL comments.
7. **Use peer communication** — If you need help or discover something useful, use HELP_REQUEST or KNOWLEDGE_SHARE.
8. **Document your reasoning** — Explain WHY you made decisions, not just WHAT you did.

═══════════════════════════════════════════`;
  }

  /**
   * Build the swarm roster section — tells every bot WHO all the other bots are
   * and WHAT they can do. This prevents duplicate capability building and enables
   * smart delegation.
   * @param {Array} roster - Array of { agent_id, capabilities, status }
   * @param {string} currentAgentId - This bot's ID (marked with ← YOU)
   * @returns {string} Formatted roster section
   */
  static _buildRosterSection(roster, currentAgentId) {
    if (!roster || roster.length === 0) return '';

    const lines = roster.map(agent => {
      const id = agent.agent_id || agent.agentId || 'unknown';
      const caps = Array.isArray(agent.capabilities) 
        ? agent.capabilities.slice(0, 5).join(', ')
        : '';
      const isYou = id === currentAgentId || `swarm-${id}` === currentAgentId || id === `swarm-${currentAgentId}`;
      const marker = isYou ? ' ← **YOU**' : '';
      return `  | ${id.padEnd(28)} | ${(caps || 'general').padEnd(50)} |${marker}`;
    });

    return `
═══════════════════════════════════════════
🏢 SWARM ROSTER — WHO CAN DO WHAT
═══════════════════════════════════════════

**BEFORE building something new, check if another bot already has that capability.**
**BEFORE requesting a new bot, check this roster for existing specialists.**

  | Agent ID                     | Capabilities                                       |
  |------------------------------|------------------------------------------------------|
${lines.join('\n')}

**Key principle:** Don't reinvent. If a capability exists in the swarm, USE IT via delegation or HELP_REQUEST.
`;
  }

  /**
   * Build a minimal awareness block for subtasks (less verbose)
   */
  static buildMinimal(agentId, ticketName, totalAgents = 23) {
    return `╔═════════════════════════════════════════╗
║  🐝 SWARM AWARENESS                    ║
╚═════════════════════════════════════════╝
**You are:** ${agentId} — one of ${totalAgents} agents in an AI swarm.
**Ticket:** ${ticketName}
**Mode:** Direct execution (subtask — no multi-phase lifecycle)
**Rules:** Read prior work, build on it, write a Developer Handover when done.
═══════════════════════════════════════════`;
  }
}

module.exports = SwarmAwarenessPrompt;
