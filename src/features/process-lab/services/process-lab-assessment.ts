/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from process-lab-service.ts (1000-line cap decomposition): heuristic assessment builder, AI prompt builder, and provider-response text extraction
 */

import type { OshalTicketState } from '@/entities/ticket';
import type { LLMService } from '@/features/llm-provider';
import {
  BUILD_LIKE_TICKET_STATUSES,
  type ProcessLabArtifacts,
  type ProcessLabAssessment,
  type ProcessLabAssessmentFinding,
  type ProcessLabRun,
} from './process-lab-types';

/**
 * @description Builds the heuristic (non-AI) portion of a run assessment: derives findings from the collected artifacts, rolls their severities up into an overall status, and produces a one-line summary. The AI narrative fields are layered on separately.
 * @param run The Process Lab run being assessed (used for its event log and scenario context).
 * @param artifacts The evidence bundle collected for the run.
 * @returns The heuristic findings, summary, and rolled-up status (without the AI/timestamp fields).
 */
export function buildHeuristicAssessment(
  run: ProcessLabRun,
  artifacts: ProcessLabArtifacts,
): Omit<ProcessLabAssessment, 'generatedAt' | 'providerName' | 'aiSummary' | 'aiSummaryError'> {
  const ticket = artifacts.ticket;
  const transitions = artifacts.statusHistory.map((record) => record.toStatus);
  const uniqueTransitions = dedupeStatuses(transitions);
  const workItemStatusCounts = countBy(artifacts.workItems, (item) => item.status);

  const findings: ProcessLabAssessmentFinding[] = [
    ...collectTicketOutcomeFindings(ticket),
    ...collectLifecycleFindings(run, artifacts, uniqueTransitions, workItemStatusCounts),
  ];

  if (findings.length === 0) {
    findings.push({
      code: 'clean-trace',
      message: 'No immediate lifecycle issues were detected from the captured artifacts.',
      severity: 'info',
    });
  }

  const status = findings.some((finding) => finding.severity === 'error')
    ? 'failed'
    : findings.some((finding) => finding.severity === 'warning')
      ? 'attention'
      : 'healthy';

  const heuristicSummary = ticket
    ? `Ticket ${ticket.ticketId.slice(0, 8)} finished in ${ticket.status} after ${artifacts.statusHistory.length} recorded state changes, ${artifacts.workItems.length} work items, and ${artifacts.trace?.traceCount ?? 0} runtime traces.`
    : 'The run did not retain enough ticket data to produce a complete summary.';

  return {
    findings,
    heuristicSummary,
    status,
  };
}

function collectTicketOutcomeFindings(ticket: ProcessLabArtifacts['ticket']): ProcessLabAssessmentFinding[] {
  const findings: ProcessLabAssessmentFinding[] = [];

  if (!ticket) {
    findings.push({
      code: 'ticket-missing',
      message: 'The traced ticket could not be loaded during artifact collection.',
      severity: 'error',
    });
  } else if (ticket.status === 'escalated') {
    findings.push({
      code: 'ticket-escalated',
      message: 'The run ended in escalated, which usually means verification or execution policy exhausted its retry budget.',
      severity: 'error',
    });
  } else if (ticket.status === 'customer_action') {
    findings.push({
      code: 'customer-action',
      message: 'The run reached customer_action. The system finished a cycle but still expects operator review or final user action.',
      severity: 'warning',
    });
  } else if (ticket.status === 'complete') {
    findings.push({
      code: 'ticket-complete',
      message: 'The traced ticket reached complete.',
      severity: 'info',
    });
  }

  return findings;
}

function collectLifecycleFindings(
  run: ProcessLabRun,
  artifacts: ProcessLabArtifacts,
  uniqueTransitions: string[],
  workItemStatusCounts: Record<string, number>,
): ProcessLabAssessmentFinding[] {
  const findings: ProcessLabAssessmentFinding[] = [];

  if (!uniqueTransitions.includes('approval_required') && uniqueTransitions.some((status) => BUILD_LIKE_TICKET_STATUSES.has(status as OshalTicketState))) {
    findings.push({
      code: 'approval-gate-missing',
      message: 'Build-like states were observed without first recording approval_required.',
      severity: 'warning',
    });
  }

  if (artifacts.childTickets.length === 0 && artifacts.workItems.length > 1) {
    findings.push({
      code: 'child-ticket-gap',
      message: 'The run produced multiple work items but no child tickets were linked to the parent ticket.',
      severity: 'warning',
    });
  }

  if ((workItemStatusCounts['routing_failed'] ?? 0) > 0) {
    findings.push({
      code: 'routing-failed',
      message: `${workItemStatusCounts['routing_failed']} work item(s) were marked routing_failed.`,
      severity: 'error',
    });
  }

  if ((artifacts.trace?.anomalyCount ?? 0) > 0) {
    findings.push({
      code: 'trace-anomalies',
      message: `${artifacts.trace?.anomalyCount ?? 0} runtime trace anomaly or anomalies were detected.`,
      severity: 'warning',
    });
  }

  if (run.events.some((event) => event.message.includes('Approved ticket for build'))) {
    findings.push({
      code: 'auto-approved',
      message: 'Process Lab auto-approved the build gate for this run.',
      severity: 'info',
    });
  }

  return findings;
}

/**
 * @description Builds the plain-text prompt sent to the LLM for the optional AI assessment, packing the scenario context, lifecycle transitions, artifact counts, and heuristic findings into a compact briefing with fixed output sections.
 * @param run The Process Lab run being assessed (used for its scenario metadata).
 * @param artifacts The evidence bundle collected for the run.
 * @param assessment The heuristic assessment already produced for the run.
 * @returns The assembled prompt string.
 */
export function buildAiAssessmentPrompt(
  run: ProcessLabRun,
  artifacts: ProcessLabArtifacts,
  assessment: Omit<ProcessLabAssessment, 'generatedAt' | 'providerName' | 'aiSummary' | 'aiSummaryError'>,
): string {
  const ticket = artifacts.ticket;
  const transitions = artifacts.statusHistory.map((record) => `${record.toStatus} @ ${record.createdAt}`);
  const workItemStatusCounts = countBy(artifacts.workItems, (item) => item.status);
  const lines = [
    `Scenario: ${run.scenario.name}`,
    `Complexity: ${run.scenario.complexity}`,
    `Goal: ${run.scenario.goal}`,
    `Ticket ID: ${ticket?.ticketId ?? 'unknown'}`,
    `Final ticket status: ${ticket?.status ?? 'unknown'}`,
    `Child tickets: ${artifacts.childTickets.length}`,
    `Work items: ${artifacts.workItems.length}`,
    `Work item status counts: ${JSON.stringify(workItemStatusCounts)}`,
    `Related swarm runs: ${artifacts.relatedSwarmRuns.length}`,
    `Trace anomalies: ${artifacts.trace?.anomalyCount ?? 0}`,
    `Regression handoffs: ${artifacts.trace?.regressionCount ?? 0}`,
    `Observed transitions: ${transitions.join(' | ') || 'none'}`,
    `Heuristic status: ${assessment.status}`,
    'Heuristic findings:',
    ...assessment.findings.map((finding) => `- [${finding.severity}] ${finding.code}: ${finding.message}`),
    '',
    'Provide three short sections using plain text:',
    '1. Summary',
    '2. What Worked',
    '3. What Needs Attention',
  ];

  return lines.join('\n');
}

/**
 * @description Extracts the concatenated text blocks from an LLM provider response, ignoring non-text content blocks.
 * @param providerResponse The resolved response from LLMService.sendRequest.
 * @returns The text content joined with newlines (empty string when no text blocks exist).
 */
export function extractTextContent(providerResponse: Awaited<ReturnType<LLMService['sendRequest']>>): string {
  return providerResponse.content
    .filter((block): block is Extract<(typeof providerResponse.content)[number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function countBy<T>(items: T[], readKey: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = readKey(item) || 'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function dedupeStatuses(statuses: string[]): string[] {
  const deduped: string[] = [];
  for (const status of statuses) {
    if (deduped[deduped.length - 1] !== status) {
      deduped.push(status);
    }
  }
  return deduped;
}
