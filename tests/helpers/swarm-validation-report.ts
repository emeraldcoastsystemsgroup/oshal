/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of swarm validation report builder utility
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * @description Per-phase validation snapshot capturing execution details.
 */
export interface PhaseSnapshot {
  phase: string;
  agentId: string;
  routingTier: string;
  confidence: number;
  outputLength: number;
  outputPreview: string;
  verificationPassed: boolean;
  ticketStateAfter: string;
  writebackSucceeded: boolean;
  meshMessagesDispatched: number;
  durationMs: number;
}

/**
 * @description Final validation report summarizing the end-to-end swarm test run.
 */
export interface ValidationReport {
  testName: string;
  ticketId: string;
  runId: string;
  ticketTitle: string;
  complexityScore: number;
  complexityLevel: string;
  phasesExecuted: number;
  phasesSkipped: string[];
  totalPhases: number;
  uniqueAgentsEngaged: string[];
  routingTierDistribution: Record<string, number>;
  phaseSnapshots: PhaseSnapshot[];
  ralfHandovers: Array<{ phase: string; agentId: string; outputPreview: string }>;
  escalations: Array<{ phase: string; reason: string }>;
  meshDispatches: number;
  finalTicketState: string;
  passed: boolean;
  issuesFound: string[];
  suggestions: string[];
  timestamp: string;
}

/**
 * @description Builder interface for constructing validation reports incrementally.
 */
export interface ReportBuilder {
  setTicket(ticketId: string, title: string): void;
  setRun(runId: string): void;
  setComplexity(score: number, level: string, skippedPhases: string[]): void;
  addPhaseSnapshot(snapshot: PhaseSnapshot): void;
  addRalfHandover(phase: string, agentId: string, outputPreview: string): void;
  addEscalation(phase: string, reason: string): void;
  addMeshDispatch(): void;
  addIssue(issue: string): void;
  addSuggestion(suggestion: string): void;
  build(passed: boolean): ValidationReport;
  writeToFile(outputDir: string): string;
}

/**
 * @description Creates a new report builder for capturing swarm validation results.
 * @param testName - Name of the test generating the report
 * @returns ReportBuilder instance
 */
export function createReportBuilder(testName: string): ReportBuilder {
  let ticketId = '';
  let ticketTitle = '';
  let runId = '';
  let complexityScore = 0;
  let complexityLevel = 'unknown';
  let skippedPhases: string[] = [];
  const phaseSnapshots: PhaseSnapshot[] = [];
  const ralfHandovers: Array<{ phase: string; agentId: string; outputPreview: string }> = [];
  const escalations: Array<{ phase: string; reason: string }> = [];
  let meshDispatches = 0;
  const issuesFound: string[] = [];
  const suggestions: string[] = [];
  let report: ValidationReport | null = null;

  const builder: ReportBuilder = {
    /**
     * @description Sets the ticket context for the report.
     * @param id - Ticket external ID
     * @param title - Ticket title
     */
    setTicket(id: string, title: string): void {
      ticketId = id;
      ticketTitle = title;
    },

    /**
     * @description Sets the swarm run ID for the report.
     * @param id - Run identifier
     */
    setRun(id: string): void {
      runId = id;
    },

    /**
     * @description Records complexity scoring data.
     * @param score - Numeric complexity score (1-10)
     * @param level - Complexity level (low/medium/high)
     * @param skipped - Phases skipped due to complexity gating
     */
    setComplexity(score: number, level: string, skipped: string[]): void {
      complexityScore = score;
      complexityLevel = level;
      skippedPhases = skipped;
    },

    /**
     * @description Records a phase execution snapshot.
     * @param snapshot - Phase execution details
     */
    addPhaseSnapshot(snapshot: PhaseSnapshot): void {
      phaseSnapshots.push(snapshot);
    },

    /**
     * @description Records a RALF handover context write.
     * @param phase - Phase that wrote the handover
     * @param agentId - Agent that produced the handover
     * @param outputPreview - Preview of the handover content
     */
    addRalfHandover(phase: string, agentId: string, outputPreview: string): void {
      ralfHandovers.push({ phase, agentId, outputPreview });
    },

    /**
     * @description Records an escalation event.
     * @param phase - Phase where escalation occurred
     * @param reason - Reason for escalation
     */
    addEscalation(phase: string, reason: string): void {
      escalations.push({ phase, reason });
    },

    /**
     * @description Increments the mesh dispatch counter.
     */
    addMeshDispatch(): void {
      meshDispatches++;
    },

    /**
     * @description Records a discovered issue.
     * @param issue - Issue description
     */
    addIssue(issue: string): void {
      issuesFound.push(issue);
    },

    /**
     * @description Records an improvement suggestion.
     * @param suggestion - Suggestion description
     */
    addSuggestion(suggestion: string): void {
      suggestions.push(suggestion);
    },

    /**
     * @description Builds the final validation report.
     * @param passed - Whether all validation criteria passed
     * @returns Completed ValidationReport
     */
    build(passed: boolean): ValidationReport {
      const uniqueAgents = [...new Set(phaseSnapshots.map((s) => s.agentId).filter(Boolean))];
      const tierDistribution: Record<string, number> = {};
      for (const snapshot of phaseSnapshots) {
        const tier = snapshot.routingTier || 'unknown';
        tierDistribution[tier] = (tierDistribution[tier] ?? 0) + 1;
      }

      const finalState = phaseSnapshots.length > 0
        ? phaseSnapshots[phaseSnapshots.length - 1].ticketStateAfter
        : 'unknown';

      report = {
        testName,
        ticketId,
        runId,
        ticketTitle,
        complexityScore,
        complexityLevel,
        phasesExecuted: phaseSnapshots.length,
        phasesSkipped: skippedPhases,
        totalPhases: 7,
        uniqueAgentsEngaged: uniqueAgents,
        routingTierDistribution: tierDistribution,
        phaseSnapshots,
        ralfHandovers,
        escalations,
        meshDispatches,
        finalTicketState: finalState,
        passed,
        issuesFound,
        suggestions,
        timestamp: new Date().toISOString(),
      };

      return report;
    },

    /**
     * @description Writes the validation report to a JSON file.
     * @param outputDir - Directory to write the report file
     * @returns Full path to the written report file
     */
    writeToFile(outputDir: string): string {
      if (!report) {
        throw new Error('Report must be built before writing to file');
      }

      mkdirSync(outputDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `validation-report-${timestamp}.json`;
      const filepath = join(outputDir, filename);
      writeFileSync(filepath, JSON.stringify(report, null, 2), 'utf-8');
      return filepath;
    },
  };

  return builder;
}