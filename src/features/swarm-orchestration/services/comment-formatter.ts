/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Ported CommentFormatter.js from the legacy implementation. 10 comment types for Plane ticket comments: routing, completion, error, escalation, recovery, decomposition, circuit-breaker, lock warning, workspace link, customer summary.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'comment-formatter' });

const MAX_SUMMARY_LENGTH = 1000;
const MAX_DETAIL_LENGTH = 15000;
const FORMATTER_VERSION = '2.0';

/**
 * @description Consistent Plane ticket comment formatting for all QM-generated comments.
 * Every ticket lifecycle event gets a structured, branded comment posted back to Plane.
 * Ported from the legacy CommentFormatter.js — 10 comment types.
 */
export class CommentFormatter {
  /**
   * @description Task Brief — structured first comment that sets the north star for the agent.
   * Ported from the legacy CommentFormatter.js:routingComment().
   *
   * @param agentId - Assigned agent
   * @param capabilities - Matched capabilities
   * @param priority - Ticket priority
   * @param ticketTitle - Ticket title
   * @param ticketDescription - Ticket description
   * @param complexity - Analyzed complexity
   * @param phase - Current lifecycle phase number
   * @returns Structured task brief markdown
   */
  routingComment(
    agentId: string,
    capabilities: string[],
    priority: string,
    ticketTitle: string,
    ticketDescription: string,
    complexity: string,
    phase?: number | null,
  ): string {
    const descPreview = ticketDescription
      ? ticketDescription.slice(0, 500) + (ticketDescription.length > 500 ? '...' : '')
      : ticketTitle;

    const { expectations, qualityBar } = phaseAwareGuidance(phase ?? null);

    return [
      `**TASK BRIEF -- Queue Manager**`,
      '',
      '## Goal',
      ticketTitle || 'See ticket description',
      '',
      '## Description',
      descPreview,
      '',
      '## Assignment',
      '| Field | Value |',
      '|-------|-------|',
      `| **Assigned Agent** | @agent:${agentId} |`,
      `| **Matched Skills** | ${capabilities.join(', ')} |`,
      `| **Priority** | ${priority} |`,
      `| **Complexity** | ${complexity} |`,
      ...(phase ? [`| **Phase** | ${phase} |`] : []),
      '',
      '## Expectations',
      expectations,
      '',
      '## Quality Bar',
      qualityBar,
      '',
      '**This comment IS the brief. Read it. Execute it. Hand it over properly.**',
      '',
      footer(),
    ].join('\n');
  }

  /**
   * @description Completion comment — agent finished work on a ticket.
   * @param agentId - Agent that completed the work
   * @param content - Agent output content
   * @param isParent - True for customer-facing summary on parent tickets
   * @returns Formatted completion comment markdown
   */
  completionComment(agentId: string, content: string, isParent = false): string {
    if (isParent) return this.customerSummary(content);
    const truncated = truncate(content, MAX_DETAIL_LENGTH);
    return [
      `**Agent Work Complete**`,
      '',
      `**Agent:** ${agentId}`,
      '',
      truncated,
      '',
      footer(),
    ].join('\n');
  }

  /**
   * @description Handoff comment — agent returning ticket to queue for another phase.
   * @param agentId - Agent handing off
   * @param reason - Reason for handoff
   * @param nextPhase - Next lifecycle phase
   * @returns Formatted handoff comment markdown
   */
  handoffComment(agentId: string, reason: string, nextPhase?: string): string {
    return [
      `**Agent Handoff**`,
      '',
      `**Agent:** ${agentId}`,
      `**Reason:** ${reason}`,
      ...(nextPhase ? [`**Next Phase:** ${nextPhase}`] : []),
      '',
      footer(),
    ].join('\n');
  }

  /**
   * @description Error comment — agent processing failed.
   * @param agentId - Agent that encountered the error
   * @param errorMessage - Error details
   * @param phase - Phase where error occurred
   * @returns Formatted error comment markdown
   */
  errorComment(agentId: string, errorMessage: string, phase?: string): string {
    return [
      `**Processing Error**`,
      '',
      `**Agent:** ${agentId}`,
      ...(phase ? [`**Phase:** ${phase}`] : []),
      `**Error:** ${truncate(errorMessage, MAX_SUMMARY_LENGTH)}`,
      '',
      'The ticket has been returned to the queue for retry or escalation.',
      '',
      footer(),
    ].join('\n');
  }

  /**
   * @description Escalation comment — ticket escalated to human review.
   * @param reason - Escalation reason
   * @param agentId - Agent that triggered escalation
   * @param attempts - Number of retry attempts before escalation
   * @returns Formatted escalation comment markdown
   */
  escalationComment(reason: string, agentId?: string, attempts?: number): string {
    return [
      `**Escalation to Human Review**`,
      '',
      `**Reason:** ${reason}`,
      ...(agentId ? [`**Last Agent:** ${agentId}`] : []),
      ...(attempts !== undefined ? [`**Attempts:** ${attempts}`] : []),
      '',
      'This ticket requires human intervention to proceed.',
      '',
      footer(),
    ].join('\n');
  }

  /**
   * @description Recovery comment — stalled task timeout recovery.
   * @param agentId - Agent that was stuck
   * @param stalledDurationMs - How long the agent was stalled
   * @returns Formatted recovery comment markdown
   */
  recoveryComment(agentId: string, stalledDurationMs: number): string {
    const minutes = Math.round(stalledDurationMs / 60_000);
    return [
      `**Stalled Task Recovery**`,
      '',
      `**Agent:** ${agentId}`,
      `**Stalled Duration:** ${minutes} minutes`,
      '',
      'The agent was unresponsive. The ticket has been recovered and returned to the queue.',
      '',
      footer(),
    ].join('\n');
  }

  /**
   * @description Decomposition comment — ticket broken into subtasks.
   * @param parentTitle - Parent ticket title
   * @param subtasks - Array of subtask titles
   * @param depth - Decomposition depth
   * @returns Formatted decomposition comment markdown
   */
  decompositionComment(parentTitle: string, subtasks: string[], depth: number): string {
    const list = subtasks.map((s, i) => `${i + 1}. ${s}`).join('\n');
    return [
      `**Subtask Decomposition**`,
      '',
      `**Parent:** ${parentTitle}`,
      `**Depth:** ${depth}`,
      `**Subtasks Created:** ${subtasks.length}`,
      '',
      list,
      '',
      'Each subtask will be routed to a specialist agent for execution.',
      '',
      footer(),
    ].join('\n');
  }

  /**
   * @description Circuit breaker comment — processing loop detected and halted.
   * @param agentId - Agent in the loop
   * @param cycleCount - Number of cycles before circuit breaker triggered
   * @returns Formatted circuit breaker comment markdown
   */
  circuitBreakerComment(agentId: string, cycleCount: number): string {
    return [
      `**Circuit Breaker Triggered**`,
      '',
      `**Agent:** ${agentId}`,
      `**Cycles:** ${cycleCount}`,
      '',
      'Processing loop detected. The ticket has been halted to prevent infinite cycling.',
      '',
      footer(),
    ].join('\n');
  }

  /**
   * @description Over-decomposition warning — decomposition blocked at depth cutoff.
   * @param currentDepth - Current ticket depth
   * @param maxDepth - Maximum allowed depth
   * @returns Formatted warning comment markdown
   */
  overDecompositionWarning(currentDepth: number, maxDepth: number): string {
    return [
      `**Decomposition Blocked**`,
      '',
      `Ticket at depth ${currentDepth}/${maxDepth}. Max decomposition depth reached.`,
      'Agent must execute directly — no further decomposition allowed.',
      '',
      footer(),
    ].join('\n');
  }

  /**
   * @description Customer-facing summary for parent tickets.
   * @param content - Summary content
   * @returns Formatted customer summary markdown
   */
  customerSummary(content: string): string {
    const truncated = truncate(content, MAX_SUMMARY_LENGTH);
    return [
      `**Deliverable Summary**`,
      '',
      truncated,
      '',
      footer(),
    ].join('\n');
  }

  /**
   * @description Phase transition comment — posted when a ticket enters a new phase.
   * @param phase - Phase number
   * @param phaseName - Phase name
   * @param action - 'entering' or 'completing'
   * @param detail - Additional detail text
   * @returns Formatted phase comment markdown
   */
  phaseComment(phase: number, phaseName: string, action: string, detail: string): string {
    return [
      `**Phase ${phase}: ${phaseName} (${action})**`,
      '',
      detail,
      '',
      footer(),
    ].join('\n');
  }
}

/**
 * @description Phase-aware expectations and quality bar text.
 * Ported from the legacy CommentFormatter.js:_phaseAwareGuidance().
 */
function phaseAwareGuidance(phase: number | null): { expectations: string; qualityBar: string } {
  if (phase === 2) {
    return {
      expectations: `- **Deliver a structured approach plan** -- this IS the work product for this phase
- **Include numbered steps** (minimum 3) with specialist assignments
- **Include a Developer Handover** at the end of your response (mandatory RALF requirement)
- **Do NOT execute the plan** -- planning only, execution happens in a later phase`,
      qualityBar: `The Queue Manager will **reject** your response if:
1. It has fewer than 3 numbered steps
2. It doesn't include a Developer Handover section
3. It tries to execute the work instead of planning it`,
    };
  }

  if (phase === 3) {
    return {
      expectations: `- **Deliver a specialist review verdict** -- APPROVE, CONCERN, or SUGGEST
- **Keep it concise** (2-5 sentences focused on your domain expertise)
- **Include a Developer Handover** at the end of your response`,
      qualityBar: `The Queue Manager will **reject** your response if:
1. It doesn't include a clear verdict (APPROVE/CONCERN/SUGGEST)
2. It tries to execute work instead of reviewing the plan`,
    };
  }

  if (phase === 5 || phase === 6) {
    return {
      expectations: `- **Deliver a quality review** with a clear PASS or REVISE verdict
- **Evaluate against the original ticket requirements**
- **Include a Developer Handover** at the end of your response`,
      qualityBar: `The Queue Manager will **reject** your response if:
1. It doesn't include a PASS or REVISE verdict
2. It tries to redo the work instead of reviewing it`,
    };
  }

  // Phase 4 (EXECUTION) and default
  return {
    expectations: `- **Deliver real work product** -- the actual code, document, analysis, or answer
- **Include a summary inline** -- always provide a human-readable summary
- **Include a Developer Handover** at the end of your response
- **Use your full context window** -- be thorough, not lazy`,
    qualityBar: `The Queue Manager will **reject** your response if:
1. It's just an outline or plan without actual deliverable content
2. It doesn't include a Developer Handover section
3. It references workspace files without providing a summary`,
  };
}

/**
 * @description Truncate text to a max length with ellipsis.
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '\n\n*[Truncated — full output in workspace]*';
}

/**
 * @description Standard footer for all QM-generated comments.
 */
function footer(): string {
  return `---\n*Queue Manager v${FORMATTER_VERSION} -- OSHAL Swarm*`;
}
