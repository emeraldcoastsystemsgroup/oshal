/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial FailureGovernanceService — stale-loop detection, approval-required flows, stuck-agent watchdog, workspace recovery scans. Stage 5 of the complex-ticket reference gap plan.
 */

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { createChildLogger } from '@/shared/logger';
import { resolveSharedWorkspaceRoot } from '@/shared/workspace-root';

const logger = createChildLogger({ module: 'failure-governance-service' });

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * @description Configuration for failure governance behavior.
 */
export interface FailureGovernanceConfig {
  /** Similarity threshold (0-1) for stale-loop detection. Default: 0.85. */
  staleLoopSimilarityThreshold: number;
  /** Minimum outputs to compare before triggering stale-loop. Default: 2. */
  staleLoopMinOutputs: number;
  /** Duration (ms) after which an agent is considered stuck. Default: 300000 (5 min). */
  stuckAgentThresholdMs: number;
  /** Workspace root directory. */
  workspaceRoot: string;
  /** Keywords that trigger approval-required flow. */
  approvalRequiredKeywords: string[];
}

const DEFAULT_CONFIG: Omit<FailureGovernanceConfig, 'workspaceRoot'> = {
  staleLoopSimilarityThreshold: 0.85,
  staleLoopMinOutputs: 2,
  stuckAgentThresholdMs: 300_000,
  approvalRequiredKeywords: [
    'rm -rf', 'DROP TABLE', 'DELETE FROM', 'format disk',
    'destroy', 'purge', 'wipe', 'truncate',
  ],
};

// ---------------------------------------------------------------------------
// Stale Loop Detection
// ---------------------------------------------------------------------------

/**
 * @description Result of stale-loop analysis on recent outputs.
 */
export interface StaleLoopResult {
  isStaleLoop: boolean;
  similarity: number;
  outputCount: number;
  reason?: string;
}

/**
 * @description Tracks recent outputs per ticket for stale-loop detection.
 */
interface OutputHistory {
  ticketId: string;
  outputs: string[];
  maxHistory: number;
}

// ---------------------------------------------------------------------------
// Approval Required
// ---------------------------------------------------------------------------

/**
 * @description Result of checking whether an action requires operator approval.
 */
export interface ApprovalCheckResult {
  requiresApproval: boolean;
  matchedKeywords: string[];
  reason?: string;
}

/**
 * @description An approval request pending operator decision.
 */
export interface ApprovalRequest {
  ticketId: string;
  phase: string;
  agentId: string;
  action: string;
  matchedKeywords: string[];
  requestedAt: string;
  status: 'pending' | 'approved' | 'rejected';
  decidedAt?: string;
  decidedBy?: string;
}

// ---------------------------------------------------------------------------
// Stuck Agent Detection
// ---------------------------------------------------------------------------

/**
 * @description Tracked agent execution for stuck detection.
 */
export interface TrackedExecution {
  ticketId: string;
  agentId: string;
  phase: string;
  startedAt: number;
  lastActivityAt: number;
}

/**
 * @description Result of stuck-agent scan.
 */
export interface StuckAgentResult {
  ticketId: string;
  agentId: string;
  phase: string;
  elapsedMs: number;
  stuck: boolean;
}

// ---------------------------------------------------------------------------
// Workspace Recovery
// ---------------------------------------------------------------------------

/**
 * @description Result of workspace recovery scan.
 */
export interface WorkspaceRecoveryResult {
  ticketId: string;
  hasWorkspaceFiles: boolean;
  hasExecutionOutput: boolean;
  recoverable: boolean;
  filesFound: string[];
  recommendation: string;
}

// ---------------------------------------------------------------------------
// Failure Governance Service
// ---------------------------------------------------------------------------

/**
 * @description FailureGovernanceService — defensive controls for non-happy-path conditions.
 *
 * Responsibilities:
 * - Detect stale loops (agent producing same/similar output repeatedly)
 * - Check for approval-required actions (risky/destructive commands)
 * - Track and detect stuck agents (execution exceeding duration threshold)
 * - Scan workspace for recovery when execution output is empty but files exist
 *
 * Complements QueueGovernanceService (Stage 2) circuit-breaker with output-level analysis.
 */
export class FailureGovernanceService {
  private readonly config: FailureGovernanceConfig;
  private readonly outputHistory = new Map<string, OutputHistory>();
  private readonly activeExecutions = new Map<string, TrackedExecution>();
  private readonly approvalQueue = new Map<string, ApprovalRequest>();

  constructor(config?: Partial<FailureGovernanceConfig>) {
    // workspaceRoot defaults to the canonical shared root so recovery scans hit the
    // same volume bots write to and code-server browses; an explicit config value wins.
    this.config = {
      ...DEFAULT_CONFIG,
      workspaceRoot: resolveSharedWorkspaceRoot(),
      ...config,
    };
  }

  // -------------------------------------------------------------------------
  // Stale Loop Detection
  // -------------------------------------------------------------------------

  /**
   * @description Record an output and check for stale loops.
   * @param ticketId - The ticket identifier.
   * @param output - The latest execution output text.
   * @returns Stale loop analysis result.
   */
  checkForStaleLoop(ticketId: string, output: string): StaleLoopResult {
    const history = this.getOrCreateHistory(ticketId);
    history.outputs.push(this.normalizeOutput(output));

    if (history.outputs.length > history.maxHistory) {
      history.outputs.shift();
    }

    if (history.outputs.length < this.config.staleLoopMinOutputs) {
      return { isStaleLoop: false, similarity: 0, outputCount: history.outputs.length };
    }

    const similarity = this.computeRecentSimilarity(history.outputs);
    const isStale = similarity >= this.config.staleLoopSimilarityThreshold;

    if (isStale) {
      logger.warn(
        { ticketId, similarity, outputCount: history.outputs.length },
        'Stale loop detected — agent producing near-identical outputs',
      );
    }

    return {
      isStaleLoop: isStale,
      similarity,
      outputCount: history.outputs.length,
      reason: isStale ? `Output similarity ${(similarity * 100).toFixed(1)}% exceeds threshold` : undefined,
    };
  }

  /**
   * @description Clear output history for a ticket (e.g., on successful completion).
   * @param ticketId - The ticket identifier.
   */
  clearOutputHistory(ticketId: string): void {
    this.outputHistory.delete(ticketId);
  }

  // -------------------------------------------------------------------------
  // Approval Required
  // -------------------------------------------------------------------------

  /**
   * @description Check whether an action requires operator approval.
   * Scans the action text for dangerous/destructive keywords.
   * @param actionText - The proposed action or command text.
   * @returns Approval check result with matched keywords.
   */
  checkApprovalRequired(actionText: string): ApprovalCheckResult {
    const lowerText = actionText.toLowerCase();
    const matched = this.config.approvalRequiredKeywords.filter(
      (kw) => lowerText.includes(kw.toLowerCase()),
    );

    if (matched.length > 0) {
      logger.warn({ matchedKeywords: matched }, 'Approval-required keywords detected');
    }

    return {
      requiresApproval: matched.length > 0,
      matchedKeywords: matched,
      reason: matched.length > 0 ? `Detected risky keywords: ${matched.join(', ')}` : undefined,
    };
  }

  /**
   * @description Submit an approval request for operator decision.
   * @param ticketId - The ticket identifier.
   * @param phase - Current phase.
   * @param agentId - The agent requesting approval.
   * @param action - The action requiring approval.
   * @param matchedKeywords - Keywords that triggered the approval requirement.
   * @returns The created approval request.
   */
  submitApprovalRequest(
    ticketId: string, phase: string, agentId: string,
    action: string, matchedKeywords: string[],
  ): ApprovalRequest {
    const request: ApprovalRequest = {
      ticketId, phase, agentId, action, matchedKeywords,
      requestedAt: new Date().toISOString(),
      status: 'pending',
    };
    this.approvalQueue.set(ticketId, request);
    logger.info({ ticketId, agentId, phase }, 'Approval request submitted');
    return request;
  }

  /**
   * @description Decide on a pending approval request.
   * @param ticketId - The ticket identifier.
   * @param approved - Whether to approve or reject.
   * @param decidedBy - Who made the decision (optional).
   * @returns The updated approval request, or null if not found.
   */
  decideApproval(ticketId: string, approved: boolean, decidedBy?: string): ApprovalRequest | null {
    const request = this.approvalQueue.get(ticketId);
    if (!request || request.status !== 'pending') return null;

    request.status = approved ? 'approved' : 'rejected';
    request.decidedAt = new Date().toISOString();
    request.decidedBy = decidedBy;

    logger.info({ ticketId, status: request.status, decidedBy }, 'Approval decided');
    return request;
  }

  /**
   * @description Get pending approval requests for cockpit display.
   * @returns All pending approval requests.
   */
  getPendingApprovals(): ApprovalRequest[] {
    return Array.from(this.approvalQueue.values()).filter((r) => r.status === 'pending');
  }

  // -------------------------------------------------------------------------
  // Stuck Agent Detection
  // -------------------------------------------------------------------------

  /**
   * @description Register an agent execution for stuck detection.
   * @param ticketId - The ticket identifier.
   * @param agentId - The agent identifier.
   * @param phase - Current phase.
   */
  trackExecution(ticketId: string, agentId: string, phase: string): void {
    const now = Date.now();
    this.activeExecutions.set(ticketId, {
      ticketId, agentId, phase, startedAt: now, lastActivityAt: now,
    });
  }

  /**
   * @description Record activity for an execution (resets stuck timer).
   * @param ticketId - The ticket identifier.
   */
  recordActivity(ticketId: string): void {
    const exec = this.activeExecutions.get(ticketId);
    if (exec) exec.lastActivityAt = Date.now();
  }

  /**
   * @description Complete an execution (remove from tracking).
   * @param ticketId - The ticket identifier.
   */
  completeExecution(ticketId: string): void {
    this.activeExecutions.delete(ticketId);
  }

  /**
   * @description Scan for stuck agents.
   * @returns Array of stuck agent results.
   */
  detectStuckAgents(): StuckAgentResult[] {
    const now = Date.now();
    const results: StuckAgentResult[] = [];

    for (const exec of this.activeExecutions.values()) {
      const elapsed = now - exec.lastActivityAt;
      const stuck = elapsed >= this.config.stuckAgentThresholdMs;
      if (stuck) {
        logger.warn(
          { ticketId: exec.ticketId, agentId: exec.agentId, elapsedMs: elapsed },
          'Stuck agent detected',
        );
      }
      results.push({
        ticketId: exec.ticketId,
        agentId: exec.agentId,
        phase: exec.phase,
        elapsedMs: elapsed,
        stuck,
      });
    }

    return results.filter((r) => r.stuck);
  }

  // -------------------------------------------------------------------------
  // Workspace Recovery
  // -------------------------------------------------------------------------

  /**
   * @description Scan workspace for recoverable state when execution produced no output.
   * @param workspaceTaskId - The workspace task folder ID.
   * @param ticketId - The ticket identifier.
   * @param hasExecutionOutput - Whether execution produced any output.
   * @returns Recovery scan result with recommendation.
   */
  scanForRecovery(
    workspaceTaskId: string,
    ticketId: string,
    hasExecutionOutput: boolean,
  ): WorkspaceRecoveryResult {
    const workspaceDir = join(this.config.workspaceRoot, workspaceTaskId);
    const filesFound: string[] = [];

    if (existsSync(workspaceDir)) {
      try {
        const entries = readdirSync(workspaceDir);
        filesFound.push(...entries);
      } catch { /* ignore */ }
    }

    const hasFiles = filesFound.length > 0;
    const recoverable = hasFiles && !hasExecutionOutput;

    let recommendation = 'No recovery action needed';
    if (recoverable) {
      recommendation = 'Workspace has files but execution produced no output — retry with continuation brief';
    } else if (!hasFiles && !hasExecutionOutput) {
      recommendation = 'No workspace artifacts and no output — full re-execution required';
    }

    if (recoverable) {
      logger.info(
        { ticketId, filesFound: filesFound.length },
        'Workspace recovery possible — files exist but no execution output',
      );
    }

    return {
      ticketId,
      hasWorkspaceFiles: hasFiles,
      hasExecutionOutput,
      recoverable,
      filesFound,
      recommendation,
    };
  }

  // -------------------------------------------------------------------------
  // Private Helpers
  // -------------------------------------------------------------------------

  /**
   * @description Get or create output history for a ticket.
   */
  private getOrCreateHistory(ticketId: string): OutputHistory {
    let history = this.outputHistory.get(ticketId);
    if (!history) {
      history = { ticketId, outputs: [], maxHistory: 5 };
      this.outputHistory.set(ticketId, history);
    }
    return history;
  }

  /**
   * @description Normalize output for comparison (trim, lowercase, remove timestamps).
   */
  private normalizeOutput(output: string): string {
    return output
      .toLowerCase()
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\dZ]*/g, '[TIMESTAMP]')
      .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g, '[UUID]')
      .trim();
  }

  /**
   * @description Compute similarity between recent outputs using Jaccard similarity on word sets.
   */
  private computeRecentSimilarity(outputs: string[]): number {
    if (outputs.length < 2) return 0;

    const last = outputs[outputs.length - 1];
    const prev = outputs[outputs.length - 2];

    const wordsA = new Set(last.split(/\s+/));
    const wordsB = new Set(prev.split(/\s+/));

    let intersection = 0;
    for (const word of wordsA) {
      if (wordsB.has(word)) intersection++;
    }

    const union = wordsA.size + wordsB.size - intersection;
    return union === 0 ? 1 : intersection / union;
  }
}