/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Ported SwarmAwarenessPrompt.js from the legacy implementation. Core Layer 3 situational awareness context injected into every bot's prompt. Includes phase position, role, colleagues, escalation protocol, peer communication, and RALF documentation rules.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added Phase 8 (Architecture Pre-Round) to PHASE_DESCRIPTIONS — agents now aware of architecture discovery phase
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'swarm-awareness-prompt' });

/**
 * @description Phase descriptions for the 7-phase lifecycle.
 * Ported from the legacy SwarmAwarenessPrompt.js:PHASE_DESCRIPTIONS.
 */
const PHASE_DESCRIPTIONS: Record<number, { name: string; verb: string; goal: string }> = {
  1: { name: 'INTAKE', verb: 'triaging', goal: 'analyze the ticket and prepare it for the pipeline' },
  2: { name: 'PLANNING', verb: 'planning', goal: 'create a detailed approach plan with numbered steps -- do NOT execute yet' },
  3: { name: 'SPECIALIST_INPUT', verb: 'reviewing the plan', goal: 'review the approach plan from your domain expertise and provide feedback' },
  4: { name: 'EXECUTION', verb: 'executing', goal: 'follow the approved plan and produce the actual deliverable' },
  5: { name: 'TESTING', verb: 'testing', goal: 'validate the deliverable for correctness, completeness, and quality' },
  6: { name: 'REVIEW', verb: 'reviewing', goal: 'evaluate the deliverable quality -- APPROVE only if it meets professional standards' },
  7: { name: 'DELIVERY', verb: 'delivering', goal: 'package the final deliverable for customer handoff' },
  8: { name: 'ARCHITECTURE_PRE_ROUND', verb: 'architecting', goal: 'write TECHNICAL-SPECIFICATION.md before PM planning — system design, constraints, and implementation boundaries' },
};

/**
 * @description Colleague information for swarm awareness.
 */
export interface SwarmColleague {
  agentId: string;
  role: string;
  round?: number;
}

/**
 * @description Agent roster entry for the swarm roster section.
 */
export interface SwarmRosterEntry {
  agentId: string;
  capabilities: string[];
  status?: string;
}

/**
 * @description Options for building a swarm awareness prompt.
 */
export interface SwarmAwarenessOptions {
  agentId: string;
  currentPhase: number;
  currentRound: number;
  maxRounds: number;
  role: string;
  colleagues: SwarmColleague[];
  roleAssignments?: Record<string, string | string[]>;
  ticketName: string;
  complexity: string;
  totalAgentsInSwarm?: number;
  previousRoundAgent?: string;
  previousRoundRole?: string;
  swarmRoster?: SwarmRosterEntry[];
}

/**
 * @description Builds the full swarm awareness context block injected into every bot's prompt.
 * This is the MOST IMPORTANT context block — it eliminates guessing and produces
 * more accurate results by giving each bot perfect situational awareness.
 *
 * Ported from the legacy SwarmAwarenessPrompt.js.
 *
 * @param opts - Swarm awareness configuration
 * @returns Full swarm awareness prompt block
 */
export function buildSwarmAwarenessPrompt(opts: SwarmAwarenessOptions): string {
  const phaseInfo = PHASE_DESCRIPTIONS[opts.currentPhase] ?? PHASE_DESCRIPTIONS[2];
  const isFirstRound = opts.currentRound === 1;
  const totalAgents = opts.swarmRoster?.length ?? opts.totalAgentsInSwarm ?? 23;

  const colleagueSection = buildColleagueSection(opts.colleagues);
  const rolesSection = buildRolesSection(opts.roleAssignments, opts.agentId);
  const rosterSection = opts.swarmRoster ? buildRosterSection(opts.swarmRoster, opts.agentId) : '';
  const roundContext = buildRoundContext(isFirstRound, opts);

  return `== SWARM AWARENESS -- YOU ARE PART OF A MULTI-AGENT TEAM ==

**You are:** ${opts.agentId}
**You are one of ${totalAgents} specialized agents** in an AI swarm. You are NOT working alone.
**Ticket:** ${opts.ticketName}
**Complexity:** ${opts.complexity}
${rosterSection}

== WHERE YOU ARE IN THE PROCESS ==

**Current Phase:** ${opts.currentPhase}/7 -- ${phaseInfo.name}
**Current Round:** ${opts.currentRound}/${opts.maxRounds}
**Your Role:** ${opts.role}

The 7-phase lifecycle:
  1. INTAKE > 2. PLANNING > 3. SPECIALIST > 4. EXECUTION > 5. TESTING > 6. REVIEW > 7. DELIVERY
  ${' '.repeat((opts.currentPhase - 1) * 14)}^ YOU ARE HERE

**Your goal in this phase:** ${phaseInfo.goal}

== YOUR COLLEAGUES ON THIS TICKET ==

${colleagueSection}
${rolesSection}

Each phase has **${opts.maxRounds} mandatory rounds** of collaboration:
${roundContext}

== ESCALATION PROTOCOL ==

If the work needs more attention, you can escalate:

**REQUEST_EXTRA_ROUND** -- Include: ## ESCALATION: REQUEST_EXTRA_ROUND
**REQUEST_PHASE_REGRESSION** -- Include: ## ESCALATION: REGRESS_TO_PHASE_[N]
**REQUEST_HUMAN_REVIEW** -- Include: ## ESCALATION: HUMAN_REVIEW_REQUIRED

== COLLABORATION RULES ==

1. **READ everything above you** -- previous rounds, phases, all comments
2. **BUILD ON prior work** -- never repeat what's already been done
3. **Be specific** -- vague feedback wastes rounds
4. **Stay in your lane** -- focus on YOUR phase's goal
5. **Quality over speed** -- your colleagues will review your output
6. **The comment thread IS your memory** -- your full response is posted as a comment
7. **Document your reasoning** -- explain WHY, not just WHAT
`;
}

/**
 * @description Build a minimal awareness block for subtasks (less verbose).
 * @param agentId - Agent ID
 * @param ticketName - Ticket title
 * @param totalAgents - Total agents in swarm
 * @returns Minimal swarm awareness prompt
 */
export function buildMinimalSwarmAwareness(
  agentId: string,
  ticketName: string,
  totalAgents = 23,
): string {
  return `== SWARM CONTEXT ==
**You are:** ${agentId}
**You are one of ${totalAgents} agents** in an AI swarm.
**Ticket:** ${ticketName}
**Mode:** Direct specialist execution (subtask -- no decomposition).
Execute the work described in the ticket. Write a Developer Handover when done.
`;
}

/**
 * @description Build colleague section for awareness prompt.
 */
function buildColleagueSection(colleagues: SwarmColleague[]): string {
  if (colleagues.length === 0) {
    return '  - (colleagues will be assigned as phases progress)';
  }
  return colleagues
    .map((c) => `  - **${c.agentId}** -- ${c.role}${c.round ? ` (Round ${c.round})` : ''}`)
    .join('\n');
}

/**
 * @description Build role assignments section.
 */
function buildRolesSection(
  roleAssignments: Record<string, string | string[]> | undefined,
  currentAgentId: string,
): string {
  if (!roleAssignments) return '';
  const entries = Object.entries(roleAssignments)
    .filter(([, v]) => v)
    .map(([role, agentId]) => {
      const ids = Array.isArray(agentId) ? agentId : [agentId];
      const isYou = ids.includes(currentAgentId);
      return `  - **${role}:** ${ids.join(', ')}${isYou ? ' <-- YOU' : ''}`;
    });
  if (entries.length === 0) return '';
  return `\n**Ticket Role Assignments:**\n${entries.join('\n')}`;
}

/**
 * @description Build swarm roster section showing all agents and capabilities.
 */
function buildRosterSection(roster: SwarmRosterEntry[], currentAgentId: string): string {
  if (roster.length === 0) return '';
  const lines = roster.map((agent) => {
    const caps = agent.capabilities.slice(0, 5).join(', ') || 'general';
    const isYou = agent.agentId === currentAgentId;
    return `  | ${agent.agentId.padEnd(28)} | ${caps.padEnd(50)} |${isYou ? ' <-- YOU' : ''}`;
  });
  return `
== SWARM ROSTER -- WHO CAN DO WHAT ==

  | Agent ID                     | Capabilities                                       |
  |------------------------------|------------------------------------------------------|
${lines.join('\n')}
`;
}

/**
 * @description Build round-specific context (first round vs quality agitator).
 */
function buildRoundContext(isFirstRound: boolean, opts: SwarmAwarenessOptions): string {
  if (isFirstRound) {
    return `- **Round 1 (YOU):** You are the PRIMARY agent. Create the initial work product.
- **Round 2:** A DIFFERENT agent will act as quality agitator -- they will challenge and improve your output.`;
  }
  return `- **Round 1:** ${opts.previousRoundAgent ?? 'Previous agent'} (${opts.previousRoundRole ?? 'primary'}) created the initial work.
- **Round 2 (YOU -- QUALITY AGITATOR):** Your job is to CHALLENGE Round 1's output:
  * Find flaws, gaps, missed edge cases, weak reasoning
  * Push back on assumptions
  * Then FIX what you found -- don't just criticize, IMPROVE`;
}
