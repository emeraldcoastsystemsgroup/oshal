/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial WorkspaceArtifactEnforcer — validates required workspace outputs per phase, generates continuation briefs on timeout/stall. Stage 4 of the complex-ticket reference gap plan.
 */

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { createChildLogger } from '@/shared/logger';
import { resolveSharedWorkspaceRoot } from '@/shared/workspace-root';
import type { RALFHandoverManager } from './ralf-handover-manager';

const logger = createChildLogger({ module: 'workspace-artifact-enforcer' });

// ---------------------------------------------------------------------------
// Artifact Rules per Phase
// ---------------------------------------------------------------------------

/**
 * @description Required artifacts for each phase of complex-ticket processing.
 * Matches the target contract in swarm-processing-design-contract.md.
 */
export interface PhaseArtifactRule {
  /** Phase name (e.g., 'intake', 'planning'). */
  phase: string;
  /** Phase number (1-7). */
  phaseIndex: number;
  /** Files that must exist in workspace after this phase completes. */
  requiredFiles: string[];
  /** Directories that must exist (may be empty). */
  requiredDirs: string[];
  /** Whether a handover document is required after this phase. */
  requiresHandover: boolean;
  /** Description of what this phase should produce. */
  description: string;
}

/**
 * @description Default artifact rules for the 7-phase lifecycle.
 */
const DEFAULT_ARTIFACT_RULES: PhaseArtifactRule[] = [
  {
    phase: 'intake',
    phaseIndex: 1,
    requiredFiles: ['_meta.json'],
    requiredDirs: [],
    requiresHandover: false,
    description: 'Normalized ticket with complexity assessment',
  },
  {
    phase: 'planning',
    phaseIndex: 2,
    requiredFiles: ['TASK-BRIEF.md', '_meta.json'],
    requiredDirs: [],
    requiresHandover: true,
    description: 'Task brief with subtask specs and acceptance criteria',
  },
  {
    phase: 'specialist_input',
    phaseIndex: 3,
    requiredFiles: [],
    requiredDirs: ['notes'],
    requiresHandover: true,
    description: 'Domain notes and constraint flags',
  },
  {
    phase: 'execution',
    phaseIndex: 4,
    requiredFiles: [],
    requiredDirs: ['deliverables', 'developer-handovers'],
    requiresHandover: true,
    description: 'Deliverables and developer handover notes',
  },
  {
    phase: 'testing',
    phaseIndex: 5,
    requiredFiles: [],
    requiredDirs: [],
    requiresHandover: true,
    description: 'Test results and pass/fail verdict',
  },
  {
    phase: 'review',
    phaseIndex: 6,
    requiredFiles: [],
    requiredDirs: [],
    requiresHandover: true,
    description: 'Review verdict and approval/revision decision',
  },
  {
    phase: 'delivery',
    phaseIndex: 7,
    requiredFiles: ['ROUTING-DECISIONS.md'],
    requiredDirs: ['deliverables'],
    requiresHandover: false,
    description: 'Final workspace assembly and provider write-back',
  },
];

// ---------------------------------------------------------------------------
// Validation Result
// ---------------------------------------------------------------------------

/**
 * @description Result of validating workspace artifacts for a phase.
 */
export interface ArtifactValidationResult {
  phase: string;
  phaseIndex: number;
  valid: boolean;
  missingFiles: string[];
  missingDirs: string[];
  handoverPresent: boolean;
  handoverRequired: boolean;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Continuation Brief
// ---------------------------------------------------------------------------

/**
 * @description A continuation brief generated when execution stalls or times out.
 */
export interface ContinuationBrief {
  ticketId: string;
  phase: string;
  phaseIndex: number;
  reason: 'timeout' | 'stall' | 'error';
  workCompleted: string[];
  remainingWork: string[];
  keyContext: string[];
  generatedAt: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Enforcer Configuration
// ---------------------------------------------------------------------------

/**
 * @description Configuration for workspace artifact enforcement.
 */
export interface ArtifactEnforcerConfig {
  /** Whether to enforce artifact rules strictly (fail on missing) or warn only. */
  strictMode: boolean;
  /** Custom artifact rules (overrides defaults). */
  customRules?: PhaseArtifactRule[];
  /** Workspace root directory. */
  workspaceRoot: string;
}

const DEFAULT_CONFIG: Omit<ArtifactEnforcerConfig, 'workspaceRoot'> = {
  strictMode: false,
};

// ---------------------------------------------------------------------------
// Workspace Artifact Enforcer
// ---------------------------------------------------------------------------

/**
 * @description WorkspaceArtifactEnforcer — validates that required workspace
 * outputs exist after each phase and generates continuation briefs when
 * execution stalls or times out.
 *
 * Responsibilities:
 * - Validate required files and directories exist per phase
 * - Check that handover documents were written when required
 * - Generate continuation briefs with partial progress context
 * - Report artifact compliance for operator visibility
 *
 * This service is designed to be called after each phase completes (or fails)
 * to enforce the workspace artifact contract from the design document.
 */
export class WorkspaceArtifactEnforcer {
  private readonly config: ArtifactEnforcerConfig;
  private readonly rules: PhaseArtifactRule[];
  private readonly handoverManager?: RALFHandoverManager;

  constructor(
    config?: Partial<ArtifactEnforcerConfig>,
    handoverManager?: RALFHandoverManager,
  ) {
    // workspaceRoot defaults to the canonical shared root so validation scans the
    // same volume bots write to and code-server browses; an explicit config value wins.
    this.config = {
      ...DEFAULT_CONFIG,
      workspaceRoot: resolveSharedWorkspaceRoot(),
      ...config,
    };
    this.rules = this.config.customRules ?? DEFAULT_ARTIFACT_RULES;
    this.handoverManager = handoverManager;
  }

  /**
   * @description Validate that required workspace artifacts exist for a phase.
   * @param workspaceTaskId - The workspace task folder ID.
   * @param phase - The phase name (e.g., 'planning', 'execution').
   * @returns Validation result with missing files/dirs and warnings.
   */
  validatePhaseArtifacts(
    workspaceTaskId: string,
    phase: string,
  ): ArtifactValidationResult {
    const rule = this.rules.find((r) => r.phase === phase);
    if (!rule) {
      return {
        phase, phaseIndex: 0, valid: true,
        missingFiles: [], missingDirs: [],
        handoverPresent: false, handoverRequired: false, warnings: [],
      };
    }

    const workspaceDir = join(this.config.workspaceRoot, workspaceTaskId);
    const missingFiles = this.checkFiles(workspaceDir, rule.requiredFiles);
    const missingDirs = this.checkDirs(workspaceDir, rule.requiredDirs);
    const handoverPresent = this.checkHandover(workspaceTaskId, rule.phaseIndex);

    const warnings: string[] = [];
    if (missingFiles.length > 0) {
      warnings.push(`Missing files: ${missingFiles.join(', ')}`);
    }
    if (missingDirs.length > 0) {
      warnings.push(`Missing directories: ${missingDirs.join(', ')}`);
    }
    if (rule.requiresHandover && !handoverPresent) {
      warnings.push('Handover document not found for this phase');
    }

    const valid = missingFiles.length === 0 && missingDirs.length === 0
      && (!rule.requiresHandover || handoverPresent);

    if (!valid) {
      logger.warn({ workspaceTaskId, phase, missingFiles, missingDirs, handoverPresent }, 'Phase artifacts incomplete');
    } else {
      logger.info({ workspaceTaskId, phase }, 'Phase artifacts validated');
    }

    return {
      phase,
      phaseIndex: rule.phaseIndex,
      valid,
      missingFiles,
      missingDirs,
      handoverPresent,
      handoverRequired: rule.requiresHandover,
      warnings,
    };
  }

  /**
   * @description Generate a continuation brief when execution stalls or times out.
   * Captures partial progress from the workspace for the next session.
   * @param workspaceTaskId - The workspace task folder ID.
   * @param ticketId - The ticket identifier.
   * @param phase - The phase where the stall/timeout occurred.
   * @param phaseIndex - Numeric phase index.
   * @param reason - Why the continuation brief is being generated.
   * @param additionalContext - Extra context to include.
   * @returns The generated continuation brief.
   */
  generateContinuationBrief(
    workspaceTaskId: string,
    ticketId: string,
    phase: string,
    phaseIndex: number,
    reason: 'timeout' | 'stall' | 'error',
    additionalContext: string[] = [],
  ): ContinuationBrief {
    const workCompleted = this.detectCompletedWork(workspaceTaskId);
    const remainingWork = this.detectRemainingWork(workspaceTaskId, phase);
    const keyContext = this.collectKeyContext(workspaceTaskId, additionalContext);

    const content = this.formatContinuationBrief(
      ticketId, phase, phaseIndex, reason,
      workCompleted, remainingWork, keyContext,
    );

    // Write continuation brief to workspace if handover manager available
    if (this.handoverManager) {
      this.handoverManager.writeHandover(
        workspaceTaskId, 'system-continuation', phaseIndex, 0, content,
      );
    }

    logger.info(
      { ticketId, phase, reason, workCompletedCount: workCompleted.length },
      'Continuation brief generated',
    );

    return {
      ticketId, phase, phaseIndex, reason,
      workCompleted, remainingWork, keyContext,
      generatedAt: new Date().toISOString(),
      content,
    };
  }

  /**
   * @description Get the artifact rules for a specific phase.
   * @param phase - The phase name.
   * @returns The artifact rule, or undefined if not found.
   */
  getPhaseRule(phase: string): PhaseArtifactRule | undefined {
    return this.rules.find((r) => r.phase === phase);
  }

  /**
   * @description Get all artifact rules.
   * @returns All configured artifact rules.
   */
  getAllRules(): PhaseArtifactRule[] {
    return [...this.rules];
  }

  /**
   * @description Validate all phases for a ticket and return a compliance report.
   * @param workspaceTaskId - The workspace task folder ID.
   * @param completedPhases - List of phases that have completed.
   * @returns Array of validation results for each completed phase.
   */
  validateAllPhases(
    workspaceTaskId: string,
    completedPhases: string[],
  ): ArtifactValidationResult[] {
    return completedPhases.map((phase) =>
      this.validatePhaseArtifacts(workspaceTaskId, phase),
    );
  }

  // -----------------------------------------------------------------------
  // Private Helpers
  // -----------------------------------------------------------------------

  /**
   * @description Check which required files are missing from workspace.
   */
  private checkFiles(workspaceDir: string, requiredFiles: string[]): string[] {
    return requiredFiles.filter((f) => !existsSync(join(workspaceDir, f)));
  }

  /**
   * @description Check which required directories are missing from workspace.
   */
  private checkDirs(workspaceDir: string, requiredDirs: string[]): string[] {
    return requiredDirs.filter((d) => !existsSync(join(workspaceDir, d)));
  }

  /**
   * @description Check if a handover document exists for a specific phase.
   */
  private checkHandover(workspaceTaskId: string, phaseIndex: number): boolean {
    if (!this.handoverManager) return true; // No manager = skip check
    const handovers = this.handoverManager.readHandovers(workspaceTaskId);
    return handovers.some((h) => h.phase === phaseIndex);
  }

  /**
   * @description Detect what work has been completed by scanning workspace.
   */
  private detectCompletedWork(workspaceTaskId: string): string[] {
    const workspaceDir = join(this.config.workspaceRoot, workspaceTaskId);
    const completed: string[] = [];

    if (existsSync(join(workspaceDir, 'TASK-BRIEF.md'))) {
      completed.push('Task brief created');
    }
    if (existsSync(join(workspaceDir, '_meta.json'))) {
      completed.push('Workspace metadata initialized');
    }
    if (existsSync(join(workspaceDir, 'DECOMPOSITION.md'))) {
      completed.push('Ticket decomposed into subtasks');
    }

    const deliverables = join(workspaceDir, 'deliverables');
    if (existsSync(deliverables)) {
      try {
        const files = readdirSync(deliverables);
        if (files.length > 0) {
          completed.push(`${files.length} deliverable(s) written`);
        }
      } catch { /* ignore */ }
    }

    const handovers = join(workspaceDir, 'developer-handovers');
    if (existsSync(handovers)) {
      try {
        const files = readdirSync(handovers).filter((f) => f.endsWith('.md'));
        if (files.length > 0) {
          completed.push(`${files.length} handover(s) written`);
        }
      } catch { /* ignore */ }
    }

    return completed;
  }

  /**
   * @description Detect remaining work based on current phase and artifacts.
   */
  private detectRemainingWork(workspaceTaskId: string, currentPhase: string): string[] {
    const remaining: string[] = [];
    const currentRule = this.rules.find((r) => r.phase === currentPhase);
    const currentIndex = currentRule?.phaseIndex ?? 0;

    // Add remaining phases
    for (const rule of this.rules) {
      if (rule.phaseIndex > currentIndex) {
        remaining.push(`Phase ${rule.phaseIndex} (${rule.phase}): ${rule.description}`);
      }
    }

    // Check missing artifacts for current phase
    const validation = this.validatePhaseArtifacts(workspaceTaskId, currentPhase);
    for (const warning of validation.warnings) {
      remaining.push(`Current phase: ${warning}`);
    }

    return remaining;
  }

  /**
   * @description Collect key context from workspace for continuation brief.
   */
  private collectKeyContext(
    workspaceTaskId: string,
    additionalContext: string[],
  ): string[] {
    const context: string[] = [...additionalContext];

    // Add handover context if available
    if (this.handoverManager) {
      const handovers = this.handoverManager.readHandovers(workspaceTaskId);
      if (handovers.length > 0) {
        const latest = handovers[handovers.length - 1];
        context.push(
          `Latest handover: ${latest.agentId} (Phase ${latest.phase}, Round ${latest.round})`,
        );
      }
    }

    return context;
  }

  /**
   * @description Format a continuation brief as markdown content.
   */
  private formatContinuationBrief(
    ticketId: string,
    phase: string,
    phaseIndex: number,
    reason: 'timeout' | 'stall' | 'error',
    workCompleted: string[],
    remainingWork: string[],
    keyContext: string[],
  ): string {
    const reasonLabel = reason === 'timeout' ? 'Execution Timeout'
      : reason === 'stall' ? 'Processing Stall' : 'Error During Processing';

    const lines: string[] = [
      `# Continuation Brief — ${ticketId}`,
      '',
      `**Generated:** ${new Date().toISOString()}`,
      `**Reason:** ${reasonLabel}`,
      `**Phase at interruption:** ${phaseIndex} (${phase})`,
      '',
      '## Work Completed',
    ];

    if (workCompleted.length > 0) {
      for (const item of workCompleted) {
        lines.push(`- ✅ ${item}`);
      }
    } else {
      lines.push('- No completed work artifacts detected');
    }

    lines.push('', '## Remaining Work');
    if (remainingWork.length > 0) {
      for (const item of remainingWork) {
        lines.push(`- ⬜ ${item}`);
      }
    } else {
      lines.push('- Unable to determine remaining work');
    }

    lines.push('', '## Key Context');
    if (keyContext.length > 0) {
      for (const item of keyContext) {
        lines.push(`- ${item}`);
      }
    } else {
      lines.push('- No additional context available');
    }

    lines.push(
      '',
      '## Instructions for Next Session',
      '- Read workspace artifacts (TASK-BRIEF.md, handovers, deliverables)',
      '- Pick up from the interrupted phase',
      '- Build on completed work — do not repeat',
      '- Write a handover when done',
    );

    return lines.join('\n');
  }
}