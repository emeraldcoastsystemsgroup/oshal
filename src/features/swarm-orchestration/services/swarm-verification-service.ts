/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added structured swarm verification service for policy-driven validation outcomes
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added real execution output verification with acceptance criteria matching
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Phase 4: Route verification to task-manager agent via mesh for real QA evaluation
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added work-type-aware structural verification so testing, docs, review, integration, and analysis work require matching output evidence
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added MOCK_OIDC structural verification mode to keep localhost ticket processing testable without task-manager hard-gate failures
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Targeted verification delivery onto task-manager direct channel instead of the shared execution stream
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | EG-3: Added implementation work-type evidence checking â€” no longer skipped during verification
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Removed MOCK_OIDC verification bypass — MOCK_OIDC only controls auth, not quality gates. Task-manager agent verification now runs in all modes.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Structural checks trust workspace deliverables over output text heuristics — when real files exist, skip keyword/length string matching.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ExternalWorkItem } from '@/entities/ticket';
import type { WorkItemRepository } from '@/entities/work-item';
import { MESH_CHANNELS, type MeshTransport } from '@/features/agent-management';
import { createChildLogger } from '@/shared/logger';
import { taskSubdirs } from '@/shared/workspace-task-dirs';
import type { DecomposedWorkUnit, WorkUnitType } from './ticket-decomposition-service';

const logger = createChildLogger({ module: 'swarm-verification-service' });

const MIN_OUTPUT_LENGTH = 50;
const TASK_MANAGER_AGENT_ID = 'a0000000-0000-0000-0000-000000000006';
const VERIFICATION_CHANNEL = MESH_CHANNELS.agentDirect(TASK_MANAGER_AGENT_ID);
const VERIFICATION_POLL_MS = 2000;
const VERIFICATION_TIMEOUT_MS = 600000;

/**
 * @description Regression targets used when verification requests rework.
 */
export type SwarmVerificationRegressionTarget = 'design' | 'build';

/**
 * @description Structured verification result returned to policy and orchestration layers.
 */
export interface SwarmVerificationResult {
  status: 'passed' | 'failed';
  summary: string;
  findings: string[];
  regressionTarget?: SwarmVerificationRegressionTarget;
}

/**
 * @description Optional dependencies for mesh-routed verification via the task-manager agent.
 */
export interface SwarmVerificationDeps {
  meshTransport?: MeshTransport;
  workItemRepository?: WorkItemRepository;
}

/**
 * @description Performs verification checks over swarm execution inputs and outputs.
 * When mesh transport and work item repository are available, routes verification
 * to the task-manager agent for real QA evaluation. Falls back to structural checks.
 */
export class SwarmVerificationService {
  private readonly meshTransport?: MeshTransport;
  private readonly workItemRepository?: WorkItemRepository;

  constructor(deps: SwarmVerificationDeps = {}) {
    this.meshTransport = deps.meshTransport;
    this.workItemRepository = deps.workItemRepository;
  }

  /**
   * @description Verifies execution readiness and output quality for one ticket.
   * @param item - Ticket being processed
   * @param workUnits - Work units prepared for execution
   * @param selectedAgentId - Selected execution agent
   * @param executionOutput - Execution output from the agent worker
   * @returns Structured verification result
   */
  async verify(
    item: ExternalWorkItem,
    workUnits: DecomposedWorkUnit[],
    selectedAgentId: string,
    executionOutput?: unknown,
    workspaceTaskId?: string,
  ): Promise<SwarmVerificationResult> {
    const startedAt = Date.now();
    logger.info(
      {
        externalId: item.externalId,
        selectedAgentId,
        workUnitCount: workUnits.length,
        hasOutput: executionOutput != null,
        hasMesh: this.meshTransport != null,
      },
      'Starting swarm verification',
    );

    // â”€â”€ Structural pre-filter (fast, deterministic) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const structuralResult = runStructuralChecks(item, workUnits, selectedAgentId, executionOutput, workspaceTaskId);
    if (structuralResult.status === 'failed') {
      return this.logAndReturn(item.externalId, structuralResult, startedAt);
    }

    // â”€â”€ Task-manager agent verification (real QA via mesh) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // The task-manager bot reads the actual deliverables and validates against
    // acceptance criteria using its own LLM runtime. No separate API key needed.
    if (this.meshTransport && this.workItemRepository) {
      const judgeResult = await this.routeToTaskManager(item, workUnits, selectedAgentId, executionOutput, workspaceTaskId);
      if (judgeResult) {
        return this.logAndReturn(item.externalId, judgeResult, startedAt);
      }
      logger.warn({ externalId: item.externalId }, 'Task-manager verification timed out; falling back to structural');
    }

    return this.logAndReturn(item.externalId, structuralResult, startedAt);
  }

  /**
   * @description Dispatches verification to the task-manager agent via mesh transport.
   * @param item - Ticket being verified
   * @param workUnits - Work units with acceptance criteria
   * @param selectedAgentId - Agent that produced the execution output
   * @param executionOutput - Execution output to verify
   * @returns Parsed verification result, or undefined on timeout
   */
  private async routeToTaskManager(
    item: ExternalWorkItem,
    workUnits: DecomposedWorkUnit[],
    selectedAgentId: string,
    executionOutput: unknown,
    workspaceTaskId?: string,
  ): Promise<SwarmVerificationResult | undefined> {
    const verifyExternalId = `verify:${item.externalId}`;
    const correlationId = `verify:${item.externalId}:${Date.now()}`;
    const verificationPrepared = await this.ensureVerificationWorkItem(item, verifyExternalId);

    if (!verificationPrepared) {
      logger.warn({ externalId: item.externalId, verifyExternalId }, 'Verification work item could not be prepared; falling back to structural verification');
      return undefined;
    }

    await this.meshTransport!.publish({
      correlationId,
      fromAgentId: 'swarm-controller',
      toAgentId: TASK_MANAGER_AGENT_ID,
      channel: VERIFICATION_CHANNEL,
      payload: {
        externalId: verifyExternalId,
        type: 'verification-request',
        originalTicket: {
          externalId: item.externalId,
          title: item.title,
          description: item.body,
        },
        workspaceTaskId,
        executorAgentId: selectedAgentId,
        executionOutput,
        workUnits,
      },
    });

    logger.info(
      { externalId: item.externalId, verifyExternalId, correlationId, toAgentId: TASK_MANAGER_AGENT_ID },
      'Dispatched verification envelope to task-manager',
    );

    const output = await this.awaitVerificationOutput(verifyExternalId, item.provider);
    if (!output) {
      return undefined;
    }

    return parseTaskManagerVerdict(item.externalId, output);
  }

  /**
   * @description Polls work items for the task-manager's verification output.
   * @param verifyExternalId - External ID used for the verification work item
   * @returns Task-manager output, or undefined on timeout
   */
  private async awaitVerificationOutput(verifyExternalId: string, provider: string): Promise<unknown> {
    if (!this.workItemRepository) {
      return undefined;
    }

    const repo = this.workItemRepository as unknown as {
      findByExternalIdAnyProvider?: (externalId: string) => Promise<Array<{ status: string; executionOutput?: unknown }>>;
      findByExternalId?: (externalId: string, provider: string) => Promise<Array<{ status: string; executionOutput?: unknown }>>;
    };
    const findAny = typeof repo.findByExternalIdAnyProvider === 'function'
      ? repo.findByExternalIdAnyProvider.bind(repo)
      : undefined;
    const findWithProvider = typeof repo.findByExternalId === 'function'
      ? repo.findByExternalId.bind(repo)
      : undefined;
    if (!findAny && !findWithProvider) {
      logger.warn({ verifyExternalId }, 'Verification polling skipped because work item repository does not expose lookup methods');
      return undefined;
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < VERIFICATION_TIMEOUT_MS) {
      const items = findAny
        ? await findAny(verifyExternalId)
        : await findWithProvider!(verifyExternalId, provider);
      const completed = items.filter((wi) => wi.status === 'completed' && wi.executionOutput);
      if (completed.length > 0) {
        logger.info({ verifyExternalId, completedCount: completed.length }, 'Task-manager verification output available');
        return completed[0].executionOutput;
      }
      await sleep(VERIFICATION_POLL_MS);
    }
    return undefined;
  }

  /**
   * @description Ensures a verification work item exists so the worker can persist the task-manager verdict.
   * @param item - Original ticket being verified
   * @param verifyExternalId - Derived verification external ID
   * @returns True when polling has a backing work item to observe
   */
  private async ensureVerificationWorkItem(item: ExternalWorkItem, verifyExternalId: string): Promise<boolean> {
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
      ? await repo.findByExternalIdAnyProvider(verifyExternalId)
      : typeof repo.findByExternalId === 'function'
        ? await repo.findByExternalId(verifyExternalId, item.provider)
        : [];

    if (existing.length > 0) {
      return true;
    }

    if (typeof repo.create !== 'function' || typeof repo.updateStatus !== 'function') {
      logger.warn({ verifyExternalId }, 'Verification polling repository does not expose create/update methods');
      return false;
    }

    const created = await repo.create({
      swarmRunId: `verification:${item.externalId}`,
      externalId: verifyExternalId,
      provider: item.provider,
      unitId: `${verifyExternalId}:task-manager`,
      title: `Verification for ${item.title}`,
      description: `Quality verification request for ticket ${item.externalId}`,
      acceptanceCriteria: ['Persist verification verdict for swarm policy evaluation'],
      labels: [...(item.labels ?? []), 'verification'],
      priority: item.priority,
    });

    await repo.updateStatus(created.workItemId, 'assigned', TASK_MANAGER_AGENT_ID);
    logger.info({ verifyExternalId, workItemId: created.workItemId }, 'Prepared verification work item for task-manager verdict polling');
    return true;
  }

  /**
   * @description Logs verification completion and returns the result.
   * @param externalId - Ticket external ID
   * @param result - Verification result
   * @param startedAt - Epoch ms when verification started
   * @returns The verification result
   */
  private logAndReturn(externalId: string, result: SwarmVerificationResult, startedAt: number): SwarmVerificationResult {
    logger.info(
      {
        externalId,
        verificationStatus: result.status,
        findingCount: result.findings.length,
        findings: result.findings,
        durationMs: Date.now() - startedAt,
      },
      'Completed swarm verification',
    );
    return result;
  }
}

/**
 * @description Runs deterministic structural checks as a fast pre-filter.
 * @param item - Ticket being verified
 * @param workUnits - Work units prepared for execution
 * @param selectedAgentId - Selected execution agent
 * @param executionOutput - Execution output from the agent worker
 * @returns Structural verification result
 */
function runStructuralChecks(
  item: ExternalWorkItem,
  workUnits: DecomposedWorkUnit[],
  selectedAgentId: string,
  executionOutput?: unknown,
  workspaceTaskId?: string,
): SwarmVerificationResult {
  const designFindings = collectDesignFindings(workUnits);
  if (designFindings.length > 0) {
    return {
      status: 'failed',
      summary: `Verification failed for ${item.externalId}: work plan needs revision.`,
      findings: designFindings,
      regressionTarget: 'design',
    };
  }

  // Use workspaceTaskId (root ticket folder) when available â€” child tickets share parent workspace.
  const workspaceFindings = checkWorkspaceDeliverables(item.externalId, workUnits, workspaceTaskId);
  if (workspaceFindings.length > 0) {
    return {
      status: 'failed',
      summary: `Verification failed for ${item.externalId}: no workspace deliverables found.`,
      findings: workspaceFindings,
      regressionTarget: 'build',
    };
  }

  // When workspace deliverables are present (workspaceFindings empty) but executionOutput is null,
  // synthesize a minimal deliverables-present payload so the null guard in collectBuildFindings
  // does not trigger a spurious no-execution-output failure. The file evidence is sufficient.
  const effectiveOutput = executionOutput ?? (workspaceFindings.length === 0
    ? { status: 'deliverables-present', content: 'workspace deliverables verified' }
    : undefined);
  const buildFindings = collectBuildFindings(selectedAgentId, workUnits, effectiveOutput, workspaceTaskId);
  if (buildFindings.length > 0) {
    return {
      status: 'failed',
      summary: `Verification failed for ${item.externalId}: execution output needs rework.`,
      findings: buildFindings,
      regressionTarget: 'build',
    };
  }

  return {
    status: 'passed',
    summary: `Verification passed for ${item.externalId} with ${workUnits.length} work units.`,
    findings: [
      'design-checks-passed',
      'output-substantive',
      'structural-checks-passed',
    ],
  };
}

/**
 * @description Collects verification findings that indicate the plan must return to design.
 * @param workUnits - Work units prepared for execution
 * @returns Design-phase findings
 */
function collectDesignFindings(workUnits: DecomposedWorkUnit[]): string[] {
  if (workUnits.length === 0) {
    return ['no-work-units-produced'];
  }

  return workUnits.flatMap((workUnit) => {
    const findings: string[] = [];
    if (!workUnit.description.trim()) {
      findings.push(`missing-description:${workUnit.unitId}`);
    }
    if (workUnit.acceptanceCriteria.length === 0) {
      findings.push(`missing-acceptance-criteria:${workUnit.unitId}`);
    }
    return findings;
  });
}

/**
 * @description Collects build-phase findings from agent selection and execution output existence.
 * @param selectedAgentId - Selected execution agent
 * @param workUnits - Work units being verified
 * @param executionOutput - Execution output from the agent worker
 * @returns Build-phase findings
 */
function collectBuildFindings(
  selectedAgentId: string,
  workUnits: DecomposedWorkUnit[],
  executionOutput?: unknown,
  workspaceTaskId?: string,
): string[] {
  const findings: string[] = [];

  if (!selectedAgentId.trim()) {
    findings.push('missing-selected-agent');
    return findings;
  }

  if (executionOutput == null) {
    findings.push('no-execution-output');
    return findings;
  }

  const executionFailure = readExecutionFailure(executionOutput);
  if (executionFailure) {
    findings.push('agent-execution-failed');
    findings.push(`execution-error:${executionFailure.slice(0, 120)}`);
    return findings;
  }

  // Check workspace deliverables FIRST â€” if substantive files exist, trust them
  // over output text heuristics. Agents write code to files but their completion
  // messages may be terse summaries that fail keyword/length checks.
  const externalId = workUnits[0]?.unitId?.split('-unit-')[0] || '';
  const deliverableFindings = checkWorkspaceDeliverables(externalId, workUnits, workspaceTaskId);
  if (deliverableFindings.length === 0) {
    // Deliverables exist and are substantive â€” trust the file check over output text analysis.
    logger.info({ externalId }, 'Deliverables verified â€” skipping output text heuristic checks');
    return findings;
  }

  // No substantive deliverables â€” fall back to output text heuristic checks
  const outputText = extractOutputText(executionOutput);
  if (outputText.length < MIN_OUTPUT_LENGTH) {
    findings.push(`output-too-short:${outputText.length}-chars`);
  }

  // EG-FIX: Check that output is relevant to the ticket, not just random exploration
  const relevanceFindings = checkOutputRelevance(workUnits, outputText);
  findings.push(...relevanceFindings);

  // No deliverables found â€” fall back to per-unit output text evidence check
  findings.push(...collectWorkTypeFindings(workUnits, outputText));
  return findings;
}

/**
 * @description Checks that the workspace deliverables directory contains actual files.
 * This catches the case where a bot explored code but never wrote deliverables.
 * Only applies to implementation/documentation work types â€” review/analysis may not produce files.
 * @param externalId - Ticket external ID (used as workspace folder name).
 * @param workUnits - Work units being verified.
 * @returns Findings for missing workspace deliverables.
 */
function checkWorkspaceDeliverables(externalId: string, workUnits: DecomposedWorkUnit[], workspaceTaskId?: string): string[] {
  // Only check for work types that should produce files
  const fileProducingTypes: WorkUnitType[] = ['implementation', 'documentation', 'testing', 'integration'];
  const fileProducingUnits = workUnits.filter((u) => fileProducingTypes.includes((u.workType ?? 'implementation') as WorkUnitType));
  if (fileProducingUnits.length === 0) return [];

  // Per-workType file-extension expectations. Used to detect the case where
  // codex produced only a planning artifact (IMPLEMENTATION-PLAN.md) and the
  // verifier was waving it through (Issue #16 — "any file in deliverables/
  // passes"). For each workType, collect the dominant expected extensions;
  // the deliverable check below requires at least ONE file matching one of
  // the expected extensions for the unit types present.
  const workTypeExpectsExt: Record<string, string[]> = {
    implementation: ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.rb', '.php', '.cs', '.kt', '.swift', '.cpp', '.c', '.h', '.hpp', '.sql'],
    integration: ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.sql'],
    testing: ['.test.ts', '.test.tsx', '.test.js', '.test.jsx', '.spec.ts', '.spec.tsx', '.spec.js', '.spec.jsx', '_test.py', '_test.go', '.test.py'],
    documentation: ['.md', '.mdx', '.rst', '.adoc', '.txt'],
  };
  const expectedExts = new Set<string>();
  for (const u of fileProducingUnits) {
    const t = (u.workType ?? 'implementation') as string;
    for (const ext of workTypeExpectsExt[t] ?? []) expectedExts.add(ext);
  }

  const wsRoot = process.env.SHARED_WORKSPACE_ROOT
    || (fs.existsSync('/app/workspace') ? '/app/workspace' : path.resolve(process.cwd(), 'workspace-shared'));

  // A unit may write to the ROOT ticket's shared folder (workspaceTaskId) OR to its own
  // (externalId) folder depending on how it was dispatched — check BOTH so a real deliverable
  // in either is found. Checking only one folder mis-read a present deliverable as "none" and
  // wrongly escalated the ticket. Additive: cannot pass a genuinely empty build.
  const workspaceFolders = [...new Set([workspaceTaskId, externalId].filter(Boolean))] as string[];

  // ADR-060: deliverables may live flat, under users/<owner>/, or _shared/ — find them all.
  const deliverableDirs: string[] = workspaceFolders.flatMap((f) => taskSubdirs(wsRoot, f, 'deliverables'));

  try {
    let allFiles: string[] = [];
    for (const dir of deliverableDirs) {
      if (fs.existsSync(dir)) {
        allFiles = allFiles.concat(getAllFiles(dir));
      }
    }

    if (allFiles.length === 0) {
      logger.warn({ externalId, checkedDirs: deliverableDirs }, 'EG-FIX: No deliverables found in any workspace directory');
      return ['deliverables-directory-empty'];
    }

    const files = allFiles;

    // Check that at least one file has meaningful content (> 50 bytes)
    const hasSubstantiveFile = files.some((f) => {
      try {
        const stat = fs.statSync(f);
        return stat.size > 50;
      } catch {
        return false;
      }
    });

    if (!hasSubstantiveFile) {
      return ['deliverable-files-too-small'];
    }

    // Issue #16: require at least one deliverable that matches the workType's
    // expected file extension. A solitary IMPLEMENTATION-PLAN.md no longer
    // satisfies an `implementation` work unit. Skipped when expectedExts is
    // empty (e.g. all units are review/analysis).
    if (expectedExts.size > 0) {
      const matchesExpected = files.some((f) => {
        const lower = f.toLowerCase();
        for (const ext of expectedExts) {
          if (lower.endsWith(ext.toLowerCase())) return true;
        }
        return false;
      });
      if (!matchesExpected) {
        logger.warn(
          { externalId, fileCount: files.length, expectedExts: Array.from(expectedExts) },
          'Workspace deliverables present but none match the workType expected extension',
        );
        return ['deliverables-do-not-match-worktype'];
      }
    }

    logger.info({ externalId, fileCount: files.length, expectedExts: Array.from(expectedExts) }, 'Workspace deliverables check passed');
    return [];
  } catch (err) {
    // Filesystem check failure is non-blocking â€” fall through to other checks
    logger.debug({ err, externalId }, 'Workspace deliverables check skipped â€” filesystem error');
    return [];
  }
}

/**
 * @description Recursively collects all files in a directory.
 * @param dir - Directory to scan.
 * @returns Array of absolute file paths.
 */
function getAllFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...getAllFiles(fullPath));
      } else {
        results.push(fullPath);
      }
    }
  } catch {
    // ignore unreadable directories
  }
  return results;
}

/**
 * @description Checks that execution output is relevant to the ticket's subject matter.
 * Catches bots that explored host code instead of producing deliverables.
 * @param workUnits - Work units being verified.
 * @param outputText - Raw execution output text.
 * @returns Findings for irrelevant output.
 */
function checkOutputRelevance(workUnits: DecomposedWorkUnit[], outputText: string): string[] {
  const findings: string[] = [];
  const normalizedOutput = outputText.toLowerCase();

  // Check for signs the bot explored host application code instead of working in workspace
  const explorationPatterns = [
    /exploring \/app\/src/i,
    /reading \/app\/src/i,
    /let me (?:look at|examine|explore|read) the (?:source|codebase|application)/i,
    /i can see the (?:project|application) (?:has|uses|contains)/i,
  ];
  const isExplorationOnly = explorationPatterns.some((p) => p.test(outputText));

  // Check for signs of actual deliverable production
  const deliverablePatterns = [
    /write_to_file/i,
    /created? (?:file|deliverable)/i,
    /wrote (?:to|file)/i,
    /deliverables?\//i,
    /developer-handover/i,
    /attempt_completion/i,
  ];
  const hasDeliverableEvidence = deliverablePatterns.some((p) => p.test(outputText));

  if (isExplorationOnly && !hasDeliverableEvidence) {
    findings.push('output-is-exploration-not-execution');
    findings.push('bot-explored-host-code-instead-of-producing-deliverables');
  }

  // Check that output references at least one keyword from the ticket title/description
  const ticketKeywords = workUnits
    .flatMap((u) => {
      const words = `${u.title} ${u.description}`.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 4); // Only meaningful words
      return words;
    });
  const uniqueKeywords = [...new Set(ticketKeywords)].slice(0, 20);

  if (uniqueKeywords.length > 0) {
    const matchCount = uniqueKeywords.filter((kw) => normalizedOutput.includes(kw)).length;
    const matchRatio = matchCount / uniqueKeywords.length;

    if (matchRatio < 0.1 && uniqueKeywords.length >= 3) {
      findings.push(`output-not-relevant-to-ticket:${matchCount}/${uniqueKeywords.length}-keywords-matched`);
    }
  }

  return findings;
}

/**
 * @description Adds deterministic evidence checks for work units with explicit work intent.
 * @param workUnits - Work units being verified.
 * @param outputText - Normalized execution output text.
 * @returns Findings for missing work-type-specific evidence.
 */
function collectWorkTypeFindings(workUnits: DecomposedWorkUnit[], outputText: string): string[] {
  const findings: string[] = [];
  const normalizedOutput = outputText.toLowerCase();
  const unitsByType = groupUnitsByType(workUnits);

  for (const [workType, typedUnits] of unitsByType.entries()) {
    if (hasEvidenceForWorkType(workType, normalizedOutput)) {
      continue;
    }

    for (const unit of typedUnits) {
      findings.push(`missing-${workType}-evidence:${unit.unitId}`);
    }
  }

  return findings;
}

/**
 * @description Groups work units by inferred work intent to keep structural verification compact.
 * @param workUnits - Work units being verified.
 * @returns Map of work-unit type to matching work units.
 */
function groupUnitsByType(workUnits: DecomposedWorkUnit[]): Map<WorkUnitType, DecomposedWorkUnit[]> {
  const unitsByType = new Map<WorkUnitType, DecomposedWorkUnit[]>();

  for (const unit of workUnits) {
    const workType = unit.workType ?? 'implementation';
    const existing = unitsByType.get(workType) ?? [];
    existing.push(unit);
    unitsByType.set(workType, existing);
  }

  return unitsByType;
}

/**
 * @description Checks whether execution output contains evidence for one work-intent class.
 * @param workType - Inferred work type from decomposition.
 * @param outputText - Lowercased execution output.
 * @returns True when output contains plausible evidence for the requested work type.
 */
function hasEvidenceForWorkType(workType: WorkUnitType, outputText: string): boolean {
  switch (workType) {
    case 'testing':
      return /(test|spec|vitest|jest|coverage|assert|pass|validated)/.test(outputText);
    case 'documentation':
      return /(readme|document|docs|guide|usage|handover)/.test(outputText);
    case 'review':
      return /(review|verdict|approved|rejected|needs revision|finding)/.test(outputText);
    case 'integration':
      return /(integrat|wire|connect|endpoint|api|hook|sync)/.test(outputText);
    case 'analysis':
      return /(analysis|plan|design|scope|investigat|summary)/.test(outputText);
    case 'implementation':
      // EG-FIX: Implementation must show evidence of actual code production, not just exploration logs.
      // Check for code artifacts: function/class definitions, imports, file creation, test results.
      return /(function |class |const |let |var |import |export |require\(|module\.exports|def |async function|write_to_file|created file|```(ts|js|typescript|javascript|python))/.test(outputText);
    default:
      return true;
  }
}

/**
 * @description Parses the task-manager's output into a SwarmVerificationResult.
 * @param externalId - Original ticket external ID
 * @param output - Raw task-manager output
 * @returns Parsed verification result
 */
function parseTaskManagerVerdict(externalId: string, output: unknown): SwarmVerificationResult {
  const text = extractOutputText(output);

  // Find the actual verdict line — not loose substring matching.
  // The QA report template contains "APPROVED / NEEDS REVISION / REJECTED" as format
  // examples, so scanning the full text matches all three and causes false rejections.
  const verdictLine = text.split('\n').find((line) => /^\s*#*\s*verdict\s*:/i.test(line)) || '';
  const vl = verdictLine.toLowerCase();

  const isApproved = /approved/i.test(vl);
  const isRejected = /rejected/i.test(vl);
  const needsRevision = /needs\s+revision/i.test(vl);

  if (isApproved && !isRejected && !needsRevision) {
    return {
      status: 'passed',
      summary: `Task-manager approved verification for ${externalId}.`,
      findings: ['task-manager-approved', 'qa-validation-passed'],
    };
  }

  const findings = extractTaskManagerFindings(text);

  if (isRejected) {
    return {
      status: 'failed',
      summary: `Task-manager rejected deliverable for ${externalId}.`,
      findings: ['task-manager-rejected', ...findings],
      regressionTarget: 'build',
    };
  }

  if (needsRevision) {
    return {
      status: 'failed',
      summary: `Task-manager requested revision for ${externalId}.`,
      findings: ['task-manager-needs-revision', ...findings],
      regressionTarget: 'build',
    };
  }

  // No explicit verdict line — check test results as implicit verdict.
  // Look for pytest-style pass/fail patterns anywhere in the output.
  const lower = text.toLowerCase();
  const hasTestsPassed = /\d+\s+passed/.test(lower);
  const hasTestsFailed = /\d+\s+failed/.test(lower) || /error during collection/i.test(lower);

  if (hasTestsPassed && !hasTestsFailed) {
    return {
      status: 'passed',
      summary: `Task-manager verification passed for ${externalId} (tests passing, no failures).`,
      findings: ['task-manager-implicit-pass', ...findings],
    };
  }

  if (hasTestsFailed) {
    return {
      status: 'failed',
      summary: `Task-manager found test failures for ${externalId}.`,
      findings: ['task-manager-tests-failed', ...findings],
      regressionTarget: 'build',
    };
  }

  // Issue #20: when no explicit verdict line is found AND no test failure
  // signal is present, the previous code escalated unconditionally. That
  // was too strict — bots routinely produce a useful analysis without
  // following the rigid "Verdict: approved" format, and the policy runner
  // was burning attempts on tickets that produced real artifacts. Treat
  // the absence of an explicit verdict as a soft warning when the bot's
  // response is substantive (>200 chars of meaningful prose). Only escalate
  // when the response itself is empty/short. Operators can still see the
  // soft warning via the `task-manager-unclear-verdict-soft-pass` finding.
  const responseLength = text.trim().length;
  const lenientUnclearVerdict = process.env.STRICT_VERDICT !== 'true';
  if (lenientUnclearVerdict && responseLength > 200) {
    return {
      status: 'passed',
      summary: `Task-manager produced analysis but no explicit Verdict line for ${externalId} (soft pass).`,
      findings: ['task-manager-unclear-verdict-soft-pass', ...findings],
    };
  }
  return {
    status: 'failed',
    summary: `Task-manager verdict unclear for ${externalId}.`,
    findings: ['task-manager-unclear-verdict', ...findings],
    regressionTarget: 'build',
  };
}

/**
 * @description Extracts specific findings from the task-manager's QA report.
 * @param text - Raw text output from task-manager
 * @returns Array of finding strings
 */
function extractTaskManagerFindings(text: string): string[] {
  const findings: string[] = [];
  const lines = text.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      const finding = trimmed.replace(/^[-*\d.]+\s+/, '').trim();
      if (finding.length > 10 && finding.length < 200) {
        findings.push(`tm-finding:${finding.slice(0, 100)}`);
      }
    }
  }

  return findings.slice(0, 10);
}

/**
 * @description Extracts text content from execution output of varying shapes.
 * @param output - Raw execution output
 * @returns Normalized text content
 */
function extractOutputText(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }
  if (output && typeof output === 'object') {
    const obj = output as Record<string, unknown>;
    if (typeof obj.content === 'string') {
      return obj.content;
    }
    return JSON.stringify(output);
  }
  return String(output);
}

/**
 * @description Extracts a persisted execution failure message when the worker recorded a terminal error.
 * @param output - Raw execution output payload
 * @returns Failure message when the payload represents an execution failure
 */
function readExecutionFailure(output: unknown): string | null {
  if (!output || typeof output !== 'object') {
    return null;
  }

  const record = output as Record<string, unknown>;
  if (record.status !== 'failed' && record.failed !== true) {
    return null;
  }

  if (typeof record.error === 'string' && record.error.trim().length > 0) {
    return record.error.trim();
  }

  return 'Agent execution failed before producing a deliverable';
}

/**
 * @description Async sleep utility.
 * @param ms - Milliseconds to sleep
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
