/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added RALFHandoverManager — bot memory via workspace handover files (ported from the legacy implementation)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | IMP-2: Added scope-aware readHandovers/writeHandover — child/review tickets use scoped filenames to prevent sibling context bleed
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed retired legacy product references (provider name is noop; narration removed)
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { createChildLogger } from '@/shared/logger';
import { resolveSharedWorkspaceRoot } from '@/shared/workspace-root';

const logger = createChildLogger({ module: 'ralf-handover-manager' });

/**
 * @description Phase name mapping for executive summaries.
 */
const PHASE_NAMES: Record<number, string> = {
  1: 'INTAKE',
  2: 'PLANNING',
  3: 'SPECIALIST_INPUT',
  4: 'EXECUTION',
  5: 'TESTING',
  6: 'REVIEW',
  7: 'DELIVERY',
  8: 'ARCHITECTURE_PRE_ROUND',
};

/**
 * @description A parsed handover document read from workspace.
 */
export interface HandoverDocument {
  agentId: string;
  phase: number;
  round: number;
  content: string;
  filename: string;
  modifiedAt: Date;
  charCount: number;
}

/**
 * @description Extracted sections from a handover markdown document.
 */
interface ExtractedSections {
  whatIDid: string | null;
  whatsLeft: string | null;
  keyContext: string | null;
  status: string | null;
}

/**
 * @description Options for generating executive summaries.
 */
export interface HandoverSummaryOptions {
  roleAssignments?: Record<string, string | string[]>;
  complexity?: string;
}

/**
 * @description RALFHandoverManager — RALF Developer Handover as Bot Memory.
 *
 * Implements the legacy implementation's RALF pattern for persistent bot context:
 * - After each round, the bot WRITES a DEVELOPER_HANDOVER.md to workspace
 * - Before each round, the QM READS the previous handover and injects it into the prompt
 * - The QM generates an executive summary of all handovers for context injection
 *
 * File naming: `developer-handovers/{agentId}_PHASE_{n}_ROUND_{n}.md`
 *
 * This is the "wet edge" — the context that allows the next agent to pick up seamlessly.
 */
/**
 * @description Manages RALF developer-handover files as persistent bot memory across rounds.
 * Reads, scopes, and writes per-agent handover markdown in a task's workspace, and generates
 * the queue-manager executive summaries and per-agent context-recall blocks injected into prompts.
 *
 * The workspace root defaults to the canonical shared root (see
 * {@link resolveSharedWorkspaceRoot}) — the same `/app/workspace-shared` volume
 * bots write deliverables to and code-server browses — so handovers land where
 * the rest of the swarm (and operators) can find them.
 */
export class RALFHandoverManager {
  private readonly workspaceRoot: string;

  constructor(workspaceRoot?: string) {
    this.workspaceRoot = workspaceRoot && workspaceRoot.trim().length > 0
      ? workspaceRoot
      : resolveSharedWorkspaceRoot();
  }

  /**
   * @description Read all handover documents for a ticket from its workspace.
   * @param workspaceTaskId - Task folder ID (e.g., task_abc12345)
   * @returns Parsed handover documents sorted chronologically
   */
  readHandovers(workspaceTaskId: string): HandoverDocument[] {
    if (!workspaceTaskId) return [];

    const handoverDir = join(this.workspaceRoot, workspaceTaskId, 'developer-handovers');
    if (!existsSync(handoverDir)) {
      logger.debug({ workspaceTaskId }, 'No developer-handovers/ dir for workspace');
      return [];
    }

    try {
      const files = readdirSync(handoverDir)
        .filter((f) => f.endsWith('.md'))
        .sort();

      const handovers: HandoverDocument[] = [];
      for (const filename of files) {
        try {
          const filePath = join(handoverDir, filename);
          const stat = statSync(filePath);
          const content = readFileSync(filePath, 'utf8');
          const parsed = parseHandoverFilename(filename);
          handovers.push({
            agentId: parsed.agentId,
            phase: parsed.phase,
            round: parsed.round,
            content,
            filename,
            modifiedAt: stat.mtime,
            charCount: content.length,
          });
        } catch {
          logger.debug({ filename }, 'Failed to read handover file');
        }
      }

      logger.info({ workspaceTaskId, count: handovers.length }, 'Read handover docs from workspace');
      return handovers;
    } catch (err) {
      logger.warn({ err, workspaceTaskId }, 'Failed to scan handover dir');
      return [];
    }
  }

  /**
   * @description Read the most recent handover for a specific agent on a ticket.
   * Used for "You worked on this before" context recall.
   * @param agentId - Agent identifier
   * @param workspaceTaskId - Task folder ID
   * @returns Most recent handover for this agent, or null
   */
  readAgentHandover(agentId: string, workspaceTaskId: string): HandoverDocument | null {
    const all = this.readHandovers(workspaceTaskId);
    const agentHandovers = all
      .filter((h) => h.agentId === agentId)
      .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
    return agentHandovers.length > 0 ? agentHandovers[0] : null;
  }

  /**
   * @description Generate an executive summary of all handovers for injection into the next bot's prompt.
   * This is the QM's summary — structured, concise, actionable.
   * @param handovers - Array from readHandovers()
   * @param ticketTitle - Ticket name
   * @param currentPhase - Current phase number (1-7)
   * @param currentRound - Current round number
   * @param opts - Optional role assignments and complexity
   * @returns Formatted executive summary for prompt injection
   */
  generateSummary(
    handovers: HandoverDocument[],
    ticketTitle: string,
    currentPhase: number,
    currentRound: number,
    opts: HandoverSummaryOptions = {},
  ): string {
    const { roleAssignments, complexity = 'medium' } = opts;

    if (!handovers || handovers.length === 0) {
      return generateFreshStartSummary(ticketTitle, currentPhase, currentRound, roleAssignments);
    }

    const sections: string[] = [];
    sections.push(buildSummaryHeader(ticketTitle, currentPhase, currentRound, complexity, handovers, roleAssignments));
    sections.push(buildWorkHistory(handovers));
    sections.push(buildMostRecentSection(handovers));
    sections.push(buildYourTurnSection(currentPhase, currentRound));
    return sections.join('\n');
  }

  /**
   * @description Generate context recall prompt for an agent who has worked on this ticket before.
   * @param previousHandover - From readAgentHandover()
   * @param agentId - Agent identifier
   * @returns Context recall block for prompt injection
   */
  generateContextRecall(previousHandover: HandoverDocument, agentId: string): string {
    const truncated = previousHandover.content.length > 2000
      ? previousHandover.content.substring(0, 2000) + '\n\n*(truncated)*'
      : previousHandover.content;

    return (
      `CONTEXT RECALL — You've worked on this before\n\n` +
      `Agent ${agentId}, you previously contributed to this ticket.\n` +
      `Here is your last Developer Handover (Phase ${previousHandover.phase}, Round ${previousHandover.round}):\n\n` +
      `${truncated}\n\n` +
      `Pick up where you left off. Build on your previous work.`
    );
  }

  /**
   * @description Write a handover document to workspace.
   * Normally the bot writes its own handover; this is a fallback used by the QM
   * when the bot doesn't write one explicitly.
   * @param workspaceTaskId - Task folder ID
   * @param agentId - Agent identifier
   * @param phase - Phase number
   * @param round - Round number
   * @param content - Agent response or explicit handover content
   * @returns Path to written file, or null on failure
   */
  writeHandover(
    workspaceTaskId: string,
    agentId: string,
    phase: number,
    round: number,
    content: string,
  ): string | null {
    if (!workspaceTaskId) return null;

    try {
      const handoverDir = join(this.workspaceRoot, workspaceTaskId, 'developer-handovers');
      if (!existsSync(handoverDir)) {
        mkdirSync(handoverDir, { recursive: true });
      }

      const filename = `${agentId}_PHASE_${phase}_ROUND_${round}.md`;
      const filePath = join(handoverDir, filename);

      const handoverContent = extractOrFormatHandover(content, agentId, phase, round);
      writeFileSync(filePath, handoverContent, 'utf8');

      logger.info({ filename, chars: handoverContent.length }, 'Wrote handover');
      return filePath;
    } catch (err) {
      logger.warn({ err, workspaceTaskId, agentId }, 'Failed to write handover');
      return null;
    }
  }

  /**
   * @description Read handovers filtered to a specific execution scope (child or review ticket).
   * When scopePrefix is empty, reads all handovers (backwards compatible).
   * @param workspaceTaskId - Task folder ID
   * @param scopePrefix - Prefix filter from resolveScopedHandoverPrefix (e.g., "abc123--")
   * @returns Parsed handover documents matching the scope, sorted chronologically
   */
  readScopedHandovers(workspaceTaskId: string, scopePrefix: string): HandoverDocument[] {
    if (!scopePrefix) return this.readHandovers(workspaceTaskId);

    const all = this.readHandovers(workspaceTaskId);
    const scoped = all.filter((h) => h.filename.startsWith(scopePrefix));
    logger.info(
      { workspaceTaskId, scopePrefix, total: all.length, scoped: scoped.length },
      'Filtered handovers by execution scope',
    );
    return scoped;
  }

  /**
   * @description Write a scope-aware handover document.
   * @param workspaceTaskId - Task folder ID
   * @param agentId - Agent identifier
   * @param phase - Phase number
   * @param round - Round number
   * @param content - Agent response or explicit handover content
   * @param scopedFilename - Optional pre-built scoped filename from resolveScopedHandoverFileName
   * @returns Path to written file, or null on failure
   */
  writeScopedHandover(
    workspaceTaskId: string,
    agentId: string,
    phase: number,
    round: number,
    content: string,
    scopedFilename?: string,
  ): string | null {
    if (!workspaceTaskId) return null;

    try {
      const handoverDir = join(this.workspaceRoot, workspaceTaskId, 'developer-handovers');
      if (!existsSync(handoverDir)) {
        mkdirSync(handoverDir, { recursive: true });
      }

      const filename = scopedFilename || `${agentId}_PHASE_${phase}_ROUND_${round}.md`;
      const filePath = join(handoverDir, filename);

      const handoverContent = extractOrFormatHandover(content, agentId, phase, round);
      writeFileSync(filePath, handoverContent, 'utf8');

      logger.info({ filename, chars: handoverContent.length, scoped: !!scopedFilename }, 'Wrote scoped handover');
      return filePath;
    } catch (err) {
      logger.warn({ err, workspaceTaskId, agentId }, 'Failed to write scoped handover');
      return null;
    }
  }

  /**
   * @description Generate the handover writing instruction block injected into every agent prompt.
   * Tells the bot exactly how to write its RALF handover.
   * @param agentId - Agent identifier
   * @param phase - Phase number
   * @param round - Round number
   * @param scopedFilename - Optional pre-built scoped filename for child/review isolation
   * @returns Instruction block for prompt injection
   */
  getHandoverInstructions(agentId: string, phase: number, round: number, scopedFilename?: string): string {
    const filename = scopedFilename || `${agentId}_PHASE_${phase}_ROUND_${round}.md`;
    return (
      `MANDATORY: RALF DEVELOPER HANDOVER\n\n` +
      `After completing your work, you MUST write a Developer Handover file.\n\n` +
      `Write to: developer-handovers/${filename}\n\n` +
      `Required format:\n\n` +
      `# Developer Handover — ${agentId}\n` +
      `**Phase:** ${phase} | **Round:** ${round}\n` +
      `**Timestamp:** [current time]\n` +
      `**Status:** Complete | Partial\n\n` +
      `## What I Did\n- [Concrete actions taken]\n\n` +
      `## What I Produced\n- [Files created/modified, deliverables]\n\n` +
      `## Decisions Made\n- [Key technical or design decisions]\n\n` +
      `## Open Concerns\n- [Risks, blockers, things the next agent should watch for]\n\n` +
      `## What's Left To Do\n- [Remaining work, or "Nothing — fully complete"]\n\n` +
      `## Key Context for Next Agent\n- [Critical information the next agent MUST know]\n\n` +
      `This handover IS your memory. The next agent will read it before starting.\n` +
      `If you don't write a handover, context is lost and work gets repeated.`
    );
  }
}

// ── Summary Builder Helpers ──────────────────────────────────────────────

/**
 * @description Builds the header section of the QM executive summary.
 */
function buildSummaryHeader(
  ticketTitle: string, currentPhase: number, currentRound: number,
  complexity: string, handovers: HandoverDocument[],
  roleAssignments?: Record<string, string | string[]>,
): string {
  const parts = [
    `QUEUE MANAGER EXECUTIVE SUMMARY\n` +
    `Ticket: ${ticketTitle}\n` +
    `Current Phase: ${currentPhase} (${PHASE_NAMES[currentPhase] || 'UNKNOWN'}) | Round: ${currentRound}\n` +
    `Complexity: ${complexity}\n` +
    `Total Handovers: ${handovers.length} from ${new Set(handovers.map((h) => h.agentId)).size} agent(s)`,
  ];
  if (roleAssignments) {
    parts.push(
      '\nAssigned Roles:\n' +
      Object.entries(roleAssignments)
        .map(([role, agentId]) => `- ${role}: ${Array.isArray(agentId) ? agentId.join(', ') : agentId}`)
        .join('\n'),
    );
  }
  return parts.join('\n');
}

/**
 * @description Builds the work history section grouped by phase.
 */
function buildWorkHistory(handovers: HandoverDocument[]): string {
  const byPhase = new Map<number, HandoverDocument[]>();
  for (const h of handovers) {
    const key = h.phase || 0;
    if (!byPhase.has(key)) byPhase.set(key, []);
    byPhase.get(key)!.push(h);
  }
  const lines: string[] = ['\nWORK HISTORY'];
  for (const [phase, phaseHandovers] of [...byPhase.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`\n### Phase ${phase}: ${PHASE_NAMES[phase] || 'UNKNOWN'}`);
    for (const h of phaseHandovers.sort((a, b) => a.round - b.round)) {
      const extracted = extractHandoverSections(h.content);
      lines.push(`**Round ${h.round} — Agent: ${h.agentId}**`);
      if (extracted.whatIDid) lines.push(`- Did: ${extracted.whatIDid}`);
      if (extracted.whatsLeft) lines.push(`- Remaining: ${extracted.whatsLeft}`);
      if (extracted.keyContext) lines.push(`- Context: ${extracted.keyContext}`);
      if (extracted.status) lines.push(`- Status: ${extracted.status}`);
    }
  }
  return lines.join('\n');
}

/**
 * @description Builds the most recent handover section (truncated to 3KB).
 */
function buildMostRecentSection(handovers: HandoverDocument[]): string {
  const mostRecent = [...handovers].sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime())[0];
  if (!mostRecent) return '';
  const truncated = mostRecent.content.length > 3000
    ? mostRecent.content.substring(0, 3000) + '\n\n*(handover truncated — full version in workspace)*'
    : mostRecent.content;
  return `\nMOST RECENT HANDOVER (${mostRecent.agentId}, Phase ${mostRecent.phase} Round ${mostRecent.round})\n\n${truncated}`;
}

/**
 * @description Builds the "YOUR TURN" instruction section.
 */
function buildYourTurnSection(currentPhase: number, currentRound: number): string {
  return (
    `\nYOUR TURN\n\n` +
    `You are entering Phase ${currentPhase}, Round ${currentRound}.\n` +
    `- READ the work history above carefully\n` +
    `- BUILD ON previous agents' work — do NOT repeat it\n` +
    `- WRITE your own Developer Handover when done\n` +
    `- Your handover file: developer-handovers/{agentId}_PHASE_${currentPhase}_ROUND_${currentRound}.md`
  );
}

// ── Helper Functions ────────────────────────────────────────────────────

/**
 * @description Parse handover filename into components.
 * Format: {agentId}_PHASE_{n}_ROUND_{n}.md
 */
function parseHandoverFilename(filename: string): { agentId: string; phase: number; round: number } {
  const match = filename.match(/^(.+?)_PHASE_(\d+)_ROUND_(\d+)\.md$/);
  if (match) {
    return { agentId: match[1], phase: parseInt(match[2], 10), round: parseInt(match[3], 10) };
  }
  return { agentId: filename.replace('.md', ''), phase: 0, round: 0 };
}

/**
 * @description Extract key sections from a handover markdown document.
 */
function extractHandoverSections(content: string): ExtractedSections {
  const result: ExtractedSections = { whatIDid: null, whatsLeft: null, keyContext: null, status: null };

  const whatIDidMatch = content.match(/##?\s*What I Did\s*\n([\s\S]*?)(?=\n##|\n---|\Z)/i);
  if (whatIDidMatch) result.whatIDid = summarizeSection(whatIDidMatch[1]);

  const whatsLeftMatch = content.match(/##?\s*What'?s Left\s*(?:To Do)?\s*\n([\s\S]*?)(?=\n##|\n---|\Z)/i);
  if (whatsLeftMatch) result.whatsLeft = summarizeSection(whatsLeftMatch[1]);

  const keyContextMatch = content.match(/##?\s*Key Context\s*(?:for Next Agent)?\s*\n([\s\S]*?)(?=\n##|\n---|\Z)/i);
  if (keyContextMatch) result.keyContext = summarizeSection(keyContextMatch[1]);

  const statusMatch = content.match(/\*\*Status:\*\*\s*(.+)/i);
  if (statusMatch) result.status = statusMatch[1].trim();

  return result;
}

/**
 * @description Summarize a section to ~200 chars (first few bullet points).
 */
function summarizeSection(text: string): string {
  const lines = text.trim().split('\n')
    .filter((l) => l.trim())
    .slice(0, 3)
    .map((l) => l.trim().replace(/^[-*\u2022]\s*/, ''));
  const summary = lines.join('; ');
  return summary.length > 200 ? summary.substring(0, 200) + '...' : summary;
}

/**
 * @description Generate summary for a fresh start (no previous handovers).
 */
function generateFreshStartSummary(
  ticketTitle: string,
  currentPhase: number,
  currentRound: number,
  roleAssignments?: Record<string, string | string[]>,
): string {
  let summary =
    `QUEUE MANAGER EXECUTIVE SUMMARY\n\n` +
    `Ticket: ${ticketTitle}\n` +
    `Current Phase: ${currentPhase} (${PHASE_NAMES[currentPhase] || 'UNKNOWN'}) | Round: ${currentRound}\n` +
    `Status: Fresh start — no previous work on this ticket`;

  if (roleAssignments) {
    summary += '\n\nAssigned Roles:\n' +
      Object.entries(roleAssignments)
        .map(([role, agentId]) => `- ${role}: ${Array.isArray(agentId) ? agentId.join(', ') : agentId}`)
        .join('\n');
  }

  summary +=
    '\n\nYOUR TURN\n\n' +
    'You are the first agent on this ticket. Read the ticket description carefully and begin work.\n' +
    'Write a Developer Handover when complete — it will be read by the next agent.';

  return summary;
}

/**
 * @description Extract handover section from full agent response, or format as handover.
 */
function extractOrFormatHandover(content: string, agentId: string, phase: number, round: number): string {
  const handoverMatch = content.match(/##?\s*(?:Developer Handover)[\s\S]*/i);
  if (handoverMatch) return handoverMatch[0];

  const truncated = content.length > 2000 ? content.substring(0, 2000) + '\n\n*(truncated)*' : content;
  return (
    `# Developer Handover — ${agentId}\n` +
    `**Phase:** ${phase} | **Round:** ${round}\n` +
    `**Timestamp:** ${new Date().toISOString()}\n` +
    `**Status:** Auto-generated (agent did not write explicit handover)\n\n` +
    `## What I Did\n(Extracted from agent response)\n\n` +
    `## Agent Response Summary\n${truncated}\n\n` +
    `## What's Left To Do\n- Review by next agent required\n\n` +
    `## Key Context for Next Agent\n- This handover was auto-generated because the agent did not write one explicitly`
  );
}
