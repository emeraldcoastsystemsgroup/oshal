/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added ConsensusReviewService — multi-agent consensus review with agreement protocol (legacy parity)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added work-intent-aware review focus so consensus reviewers judge the correct evidence class
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Normalized consensus-review verdict parsing so reviewer findings become evidence-class signals instead of generic free text
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Targeted consensus-review delivery onto per-agent direct mesh channels instead of the shared execution stream
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | WS3: Add ensureReviewWorkItem() — durable work item row created before dispatch so swarm-agent-worker can persist reviewer verdicts (mirrors swarm-verification-service pattern)
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

import { randomUUID } from 'crypto';
import type { ExternalWorkItem } from '@/entities/ticket';
import type { WorkItemRepository } from '@/entities/work-item';
import { MESH_CHANNELS, type MeshTransport } from '@/features/agent-management';
import { createChildLogger } from '@/shared/logger';
import type { DecomposedWorkUnit } from './ticket-decomposition-service';
import type { SwarmVerificationResult } from './swarm-verification-service';
import { PhaseRoundOrchestrator, type RoundAssignment, type RoundCompletionResult } from './phase-round-orchestrator';
import { RALFHandoverManager } from './ralf-handover-manager';

const logger = createChildLogger({ module: 'consensus-review-service' });

const TASK_MANAGER_AGENT_ID = 'a0000000-0000-0000-0000-000000000006';
const REVIEW_POLL_MS = 2000;
const REVIEW_TIMEOUT_MS = 600000;

/**
 * @description Individual reviewer verdict.
 */
export interface ReviewerVerdict {
  reviewerAgentId: string;
  role: string;
  round: number;
  verdict: 'approved' | 'needs_revision' | 'rejected';
  findings: string[];
  summary: string;
  rawOutput?: string;
}

/**
 * @description Consensus review outcome from multiple reviewers.
 */
export interface ConsensusReviewOutcome {
  consensus: 'approved' | 'rejected' | 'split';
  verdicts: ReviewerVerdict[];
  summary: string;
  findings: string[];
  reviewerCount: number;
  approvedCount: number;
  rejectedCount: number;
}

/**
 * @description Dependencies for the ConsensusReviewService.
 */
export interface ConsensusReviewDeps {
  meshTransport?: MeshTransport;
  workItemRepository?: WorkItemRepository;
  handoverManager?: RALFHandoverManager;
}

/**
 * @description ConsensusReviewService — multi-agent consensus review.
 *
 * Ported from the legacy implementation's PhaseReviewCycle.js. During the REVIEW phase (Phase 6),
 * multiple reviewers evaluate the execution output and must reach agreement
 * before the phase gate opens.
 *
 * Default reviewer configuration:
 * - Round 1: task-manager (QA gatekeeper — validates completeness, accuracy, quality)
 * - Round 2: domain specialist (the original executor reviews from a different angle)
 *
 * Consensus rules:
 * - ALL reviewers must approve for consensus = 'approved'
 * - ANY rejection = consensus 'rejected' (conservative)
 * - Mixed verdicts (some approve, some revision) = consensus 'split' → treated as rejected
 *
 * Each reviewer's verdict is written as a handover for the next reviewer to read.
 */
export class ConsensusReviewService {
  private readonly meshTransport?: MeshTransport;
  private readonly workItemRepository?: WorkItemRepository;
  private readonly handoverManager: RALFHandoverManager;
  private readonly roundOrchestrator = new PhaseRoundOrchestrator();

  constructor(deps: ConsensusReviewDeps = {}) {
    this.meshTransport = deps.meshTransport;
    this.workItemRepository = deps.workItemRepository;
    this.handoverManager = deps.handoverManager ?? new RALFHandoverManager();
  }

  /**
   * @description Run consensus review with multiple reviewers.
   * @param item - Ticket being reviewed
   * @param workUnits - Work units with acceptance criteria
   * @param executorAgentId - Agent that produced the execution output
   * @param executionOutput - Execution output to review
   * @param executionVerification - Verification result from the execution/testing phase
   * @param workspaceTaskId - Workspace task ID for handover files
   * @returns Consensus review outcome
   */
  async review(
    item: ExternalWorkItem,
    workUnits: DecomposedWorkUnit[],
    executorAgentId: string,
    executionOutput: unknown,
    executionVerification: SwarmVerificationResult,
    workspaceTaskId?: string,
  ): Promise<ConsensusReviewOutcome> {
    const reviewers = this.resolveReviewers(executorAgentId);

    logger.info(
      {
        externalId: item.externalId,
        reviewerCount: reviewers.length,
        reviewerAgents: reviewers.map((r) => r.agentId),
      },
      'Starting consensus review',
    );

    // Initialize round orchestration for the review phase (phase 6)
    this.roundOrchestrator.initPhaseRounds(item.externalId, 6, reviewers);

    const verdicts: ReviewerVerdict[] = [];

    for (let i = 0; i < reviewers.length; i++) {
      const reviewer = reviewers[i];
      const round = i + 1;

      const verdict = await this.dispatchReview(
        item, workUnits, executorAgentId, executionOutput,
        executionVerification, reviewer, round, workspaceTaskId,
      );

      verdicts.push(verdict);

      // Write reviewer verdict as handover for next reviewer
      if (workspaceTaskId) {
        this.writeReviewHandover(workspaceTaskId, verdict);
      }

      // Complete round in orchestrator
      const result = this.roundOrchestrator.completeRound(
        item.externalId, 6, reviewer.agentId, verdict.summary,
      );

      // Early exit on hard rejection — no need for further reviews
      if (verdict.verdict === 'rejected') {
        logger.info(
          { externalId: item.externalId, rejectedBy: reviewer.agentId, round },
          'Early exit: reviewer rejected — skipping remaining reviews',
        );
        break;
      }

      if (result.action === 'PHASE_COMPLETE') break;
    }

    const outcome = this.buildConsensus(item.externalId, verdicts);
    this.roundOrchestrator.clearState(item.externalId, 6);

    logger.info(
      {
        externalId: item.externalId,
        consensus: outcome.consensus,
        approvedCount: outcome.approvedCount,
        rejectedCount: outcome.rejectedCount,
        reviewerCount: outcome.reviewerCount,
      },
      'Consensus review completed',
    );

    return outcome;
  }

  /**
   * @description Dispatch a review to one reviewer agent via mesh.
   */
  private async dispatchReview(
    item: ExternalWorkItem,
    workUnits: DecomposedWorkUnit[],
    executorAgentId: string,
    executionOutput: unknown,
    executionVerification: SwarmVerificationResult,
    reviewer: RoundAssignment,
    round: number,
    workspaceTaskId?: string,
  ): Promise<ReviewerVerdict> {
    if (!this.meshTransport || !this.workItemRepository) {
      return this.buildStructuralVerdict(reviewer, round, executionVerification);
    }

    try {
      const reviewExternalId = `review:${item.externalId}:r${round}`;
      await this.publishReviewEnvelope(item, workUnits, executorAgentId, executionOutput, executionVerification, reviewer, round, reviewExternalId, workspaceTaskId);
      return await this.awaitAndParseReview(reviewExternalId, reviewer, round, executionVerification);
    } catch (err) {
      logger.error({ err, reviewer: reviewer.agentId, round }, 'Review dispatch failed');
      return this.buildStructuralVerdict(reviewer, round, executionVerification);
    }
  }

  /**
   * @description Publishes a review envelope to the mesh transport.
   * Ensures a durable work item row exists first so swarm-agent-worker can persist the verdict.
   */
  private async publishReviewEnvelope(
    item: ExternalWorkItem, workUnits: DecomposedWorkUnit[],
    executorAgentId: string, executionOutput: unknown,
    executionVerification: SwarmVerificationResult,
    reviewer: RoundAssignment, round: number,
    reviewExternalId: string, workspaceTaskId?: string,
  ): Promise<void> {
    const reviewPrepared = await this.ensureReviewWorkItem(item, reviewExternalId, reviewer.agentId, round);
    if (!reviewPrepared) {
      logger.warn(
        { externalId: item.externalId, reviewExternalId, reviewer: reviewer.agentId, round },
        'Review work item could not be prepared — dispatch skipped; caller will use structural fallback',
      );
      throw new Error(`Review work item preparation failed for ${reviewExternalId}`);
    }

    const correlationId = `review:${item.externalId}:r${round}:${randomUUID().slice(0, 8)}`;
    await this.meshTransport!.publish({
      correlationId,
      fromAgentId: 'swarm-controller',
      toAgentId: reviewer.agentId,
      channel: MESH_CHANNELS.agentDirect(reviewer.agentId),
      payload: {
        externalId: reviewExternalId, type: 'consensus-review-request',
        round, role: reviewer.role,
        originalTicket: { externalId: item.externalId, title: item.title, description: item.body },
        executorAgentId,
        executionOutput,
        executionVerification,
        workUnits,
        workspaceTaskId,
        phase: 6,
        reviewFocus: buildReviewFocusSummary(workUnits, executionVerification),
      },
    });
    logger.info({ externalId: item.externalId, reviewExternalId, reviewer: reviewer.agentId, round }, 'Dispatched consensus review envelope');
  }

  /**
   * @description Awaits review output and parses it, falling back to structural verdict on timeout.
   */
  private async awaitAndParseReview(
    reviewExternalId: string, reviewer: RoundAssignment,
    round: number, executionVerification: SwarmVerificationResult,
  ): Promise<ReviewerVerdict> {
    const output = await this.awaitReviewOutput(reviewExternalId);
    if (output) return this.parseReviewerOutput(reviewer, round, output);
    logger.warn({ reviewer: reviewer.agentId, round }, 'Review timed out — using structural fallback');
    return this.buildStructuralVerdict(reviewer, round, executionVerification);
  }

  /**
   * @description Poll for reviewer output from work items.
   */
  private async awaitReviewOutput(reviewExternalId: string): Promise<unknown> {
    if (!this.workItemRepository) return undefined;

    const startedAt = Date.now();
    while (Date.now() - startedAt < REVIEW_TIMEOUT_MS) {
      const items = await this.workItemRepository.findByExternalIdAnyProvider(reviewExternalId);
      const completed = items.filter((wi) => wi.status === 'completed' && wi.executionOutput);
      if (completed.length > 0) return completed[0].executionOutput;
      await sleep(REVIEW_POLL_MS);
    }
    return undefined;
  }

  /**
   * @description Parse a reviewer agent's raw output into a structured verdict.
   */
  private parseReviewerOutput(
    reviewer: RoundAssignment,
    round: number,
    output: unknown,
  ): ReviewerVerdict {
    const text = extractReviewOutputText(output);
    const verdict = parseVerdict(text);
    const findings = extractFindings(text);

    return {
      reviewerAgentId: reviewer.agentId,
      role: reviewer.role,
      round,
      verdict,
      findings,
      summary: extractReviewSummary(text),
      rawOutput: text,
    };
  }

  /**
   * @description Build a structural verdict when mesh dispatch is unavailable.
   * Falls back to the execution verification result.
   */
  private buildStructuralVerdict(
    reviewer: RoundAssignment,
    round: number,
    executionVerification: SwarmVerificationResult,
  ): ReviewerVerdict {
    return {
      reviewerAgentId: reviewer.agentId,
      role: reviewer.role,
      round,
      verdict: executionVerification.status === 'passed' ? 'approved' : 'needs_revision',
      findings: executionVerification.findings.map(normalizeReviewFinding),
      summary: `Structural fallback: ${executionVerification.summary}`,
    };
  }

  /**
   * @description Write a reviewer's verdict as a handover file.
   */
  private writeReviewHandover(workspaceTaskId: string, verdict: ReviewerVerdict): void {
    const content = [
      `# Developer Handover — ${verdict.reviewerAgentId}`,
      `**Phase:** 6 | **Round:** ${verdict.round}`,
      `**Timestamp:** ${new Date().toISOString()}`,
      `**Status:** Complete`,
      '',
      '## What I Did',
      `- Reviewed execution output as ${verdict.role}`,
      `- Verdict: ${verdict.verdict.toUpperCase()}`,
      '',
      '## Findings',
      ...verdict.findings.map((f) => `- ${f}`),
      '',
      '## Key Context for Next Agent',
      verdict.summary,
    ].join('\n');

    this.handoverManager.writeHandover(
      workspaceTaskId, verdict.reviewerAgentId, 6, verdict.round, content,
    );
  }

  /**
   * @description Build consensus from individual verdicts.
   */
  private buildConsensus(externalId: string, verdicts: ReviewerVerdict[]): ConsensusReviewOutcome {
    const approvedCount = verdicts.filter((v) => v.verdict === 'approved').length;
    const rejectedCount = verdicts.filter((v) => v.verdict === 'rejected').length;
    const allFindings = verdicts.flatMap((v) => v.findings);

    let consensus: ConsensusReviewOutcome['consensus'];
    let summary: string;

    if (approvedCount === verdicts.length) {
      consensus = 'approved';
      summary = `All ${verdicts.length} reviewers approved ${externalId}. Consensus reached.`;
    } else if (rejectedCount > 0) {
      consensus = 'rejected';
      const rejectors = verdicts.filter((v) => v.verdict === 'rejected').map((v) => v.reviewerAgentId);
      summary = `${externalId} rejected by ${rejectors.join(', ')}. ${rejectedCount}/${verdicts.length} rejected.`;
    } else {
      consensus = 'split';
      summary = `Split verdict for ${externalId}: ${approvedCount} approved, ${verdicts.length - approvedCount} need revision.`;
    }

    return {
      consensus,
      verdicts,
      summary,
      findings: allFindings,
      reviewerCount: verdicts.length,
      approvedCount,
      rejectedCount,
    };
  }

  /**
   * @description Ensures a durable review work item row exists before mesh dispatch.
   * Mirrors swarm-verification-service.ensureVerificationWorkItem() — swarm-agent-worker
   * only persists terminal output when it finds a matching work item row to update.
   * Without this row, reviewer verdicts are lost and polling times out silently.
   * @param item - Original ticket being reviewed
   * @param reviewExternalId - Derived review external ID (e.g. review:ticket-id:r1)
   * @param reviewerAgentId - Agent assigned to perform this review round
   * @param round - Review round number
   * @returns True when polling has a backing work item to observe
   */
  private async ensureReviewWorkItem(
    item: ExternalWorkItem,
    reviewExternalId: string,
    reviewerAgentId: string,
    round: number,
  ): Promise<boolean> {
    if (!this.workItemRepository) {
      return false;
    }

    const repo = this.workItemRepository as unknown as {
      findByExternalIdAnyProvider?: (externalId: string) => Promise<Array<{ workItemId: string; status: string }>>;
      findByExternalId?: (externalId: string, provider: string) => Promise<Array<{ workItemId: string; status: string }>>;
      create?: (input: {
        swarmRunId: string;
        externalId: string;
        provider: string;
        unitId: string;
        title: string;
        description: string;
        acceptanceCriteria: string[];
        labels: string[];
        priority?: string;
      }) => Promise<{ workItemId: string }>;
      updateStatus?: (workItemId: string, status: string, assignedAgentId?: string) => Promise<void>;
    };

    const existing = typeof repo.findByExternalIdAnyProvider === 'function'
      ? await repo.findByExternalIdAnyProvider(reviewExternalId)
      : typeof repo.findByExternalId === 'function'
        ? await repo.findByExternalId(reviewExternalId, item.provider)
        : [];

    if (existing.length > 0) {
      logger.debug({ reviewExternalId, existingCount: existing.length }, 'Review work item already exists — skipping creation');
      return true;
    }

    if (typeof repo.create !== 'function' || typeof repo.updateStatus !== 'function') {
      logger.warn({ reviewExternalId }, 'Review work item repository does not expose create/updateStatus — polling will have no backing row');
      return false;
    }

    const created = await repo.create({
      swarmRunId: `review:${item.externalId}`,
      externalId: reviewExternalId,
      provider: item.provider,
      unitId: `${reviewExternalId}:${reviewerAgentId}:round-${round}`,
      title: `Consensus review for ${item.title}`,
      description: `Review round ${round} for ticket ${item.externalId}`,
      acceptanceCriteria: ['Persist review verdict for consensus evaluation'],
      labels: [...(item.labels ?? []), 'review', `round-${round}`],
      priority: item.priority,
    });

    await repo.updateStatus(created.workItemId, 'assigned', reviewerAgentId);
    logger.info(
      { reviewExternalId, workItemId: created.workItemId, reviewerAgentId, round },
      'Prepared review work item for verdict polling',
    );
    return true;
  }

  /**
   * @description Resolve reviewer assignments for the review phase.
   * Round 1: task-manager (QA gatekeeper)
   * Round 2: domain specialist (original executor reviews from QA angle)
   */
  private resolveReviewers(executorAgentId: string): RoundAssignment[] {
    return [
      { agentId: TASK_MANAGER_AGENT_ID, role: 'qa-gatekeeper' },
      { agentId: executorAgentId, role: 'domain-specialist-review' },
    ];
  }
}

/**
 * @description Summarizes the evidence classes reviewers should pay attention to.
 * @param workUnits - Work units under review.
 * @param executionVerification - Prior execution verification result.
 * @returns Concise review-focus summary.
 */
function buildReviewFocusSummary(
  workUnits: DecomposedWorkUnit[],
  executionVerification: SwarmVerificationResult,
): string {
  const workTypes = [...new Set(workUnits
    .map((unit) => unit.workType ?? 'implementation')
    .filter((workType) => workType !== 'implementation'))];
  const focus = workTypes.length > 0 ? workTypes.join(', ') : 'implementation quality';
  const priorFindings = executionVerification.findings.slice(0, 3).join('; ');
  return priorFindings.length > 0
    ? `Review the deliverable with emphasis on ${focus}. Prior verification findings: ${priorFindings}.`
    : `Review the deliverable with emphasis on ${focus}.`;
}

/**
 * @description Extract findings from reviewer output text.
 */
function extractFindings(text: string): string[] {
  const findings: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (isFindingLine(trimmed)) {
      const finding = trimFindingLine(trimmed);
      if (finding.length > 10 && finding.length < 200) {
        findings.push(normalizeReviewFinding(finding));
      }
    }
  }
  return findings.slice(0, 10);
}

/**
 * @description Extracts review text from output payload shapes used by worker persistence.
 * @param output - Raw reviewer output.
 * @returns Normalized reviewer text.
 */
function extractReviewOutputText(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }

  if (output && typeof output === 'object' && 'content' in output) {
    return String((output as Record<string, unknown>).content);
  }

  return JSON.stringify(output);
}

/**
 * @description Parses a reviewer verdict from structured output and falls back to keyword detection.
 * @param text - Raw reviewer output text.
 * @returns Parsed reviewer verdict.
 */
function parseVerdict(text: string): ReviewerVerdict['verdict'] {
  const explicitVerdict = text.match(/verdict:\s*(approved|rejected|needs revision)/i)?.[1]?.toLowerCase();
  if (explicitVerdict === 'approved') {
    return 'approved';
  }
  if (explicitVerdict === 'rejected') {
    return 'rejected';
  }
  if (explicitVerdict === 'needs revision') {
    return 'needs_revision';
  }

  const lower = text.toLowerCase();
  const isApproved = lower.includes('approved');
  const isRejected = lower.includes('rejected');
  if (isRejected) {
    return 'rejected';
  }
  if (isApproved) {
    return 'approved';
  }
  return 'needs_revision';
}

/**
 * @description Extracts an explicit review summary when present.
 * @param text - Raw reviewer output text.
 * @returns Concise summary for orchestration and handover.
 */
function extractReviewSummary(text: string): string {
  const explicitSummary = text.match(/summary:\s*(.+)/i)?.[1]?.trim();
  if (explicitSummary && explicitSummary.length > 0) {
    return explicitSummary.slice(0, 500);
  }
  return text.slice(0, 500);
}

/**
 * @description Returns whether one line should be treated as a reviewer finding.
 * @param line - Trimmed reviewer output line.
 * @returns True when the line represents a finding or evidence gap.
 */
function isFindingLine(line: string): boolean {
  return /^[-*]\s+/.test(line)
    || /^\d+\.\s+/.test(line)
    || /^(finding|gap|evidence):/i.test(line);
}

/**
 * @description Removes list or label prefixes from reviewer finding lines.
 * @param line - Trimmed reviewer output line.
 * @returns Finding text without formatting prefix.
 */
function trimFindingLine(line: string): string {
  return line.replace(/^[-*\d.]+\s+/, '').replace(/^(finding|gap|evidence):\s*/i, '').trim();
}

/**
 * @description Normalizes reviewer findings into stable evidence-class signals when possible.
 * @param finding - Reviewer finding text.
 * @returns Normalized finding string for later policy and reporting use.
 */
function normalizeReviewFinding(finding: string): string {
  const trimmed = finding.trim();
  if (/^[a-z0-9-]+:[^:\s].+/i.test(trimmed)) {
    return trimmed.slice(0, 100);
  }

  const lower = trimmed.toLowerCase();
  const missingSignal = /(missing|absent|lack|lacks|not shown|not present|no\s+)/.test(lower);
  if (missingSignal && /(test|spec|coverage|vitest|jest|assert)/.test(lower)) {
    return `review-missing-testing-evidence:${trimmed.slice(0, 72)}`;
  }
  if (missingSignal && /(readme|docs|document|guide|handover|usage)/.test(lower)) {
    return `review-missing-documentation-evidence:${trimmed.slice(0, 72)}`;
  }
  if (missingSignal && /(integrat|endpoint|api|wire|connect|sync)/.test(lower)) {
    return `review-missing-integration-evidence:${trimmed.slice(0, 72)}`;
  }
  if (missingSignal && /(analysis|design|plan|scope|investigat)/.test(lower)) {
    return `review-missing-analysis-evidence:${trimmed.slice(0, 72)}`;
  }
  return `review-finding:${trimmed.slice(0, 84)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
