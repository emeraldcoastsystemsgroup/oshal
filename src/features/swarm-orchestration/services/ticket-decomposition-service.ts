/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added provider-agnostic ticket decomposition service for swarm work units
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Switched decomposition input to the canonical ticket entity contract
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added 2-level hierarchical decomposition with subtask support (ported from the legacy QueueManagerService)
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added work-type-aware decomposition so routing and review receive clearer implementation, testing, docs, and review intent
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added LLM-based decomposition from PM planning output — parses SUBTASK DECOMPOSITION marker from agent response (legacy parity)
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Fixed PM output parsing: reads workspace deliverable files on disk when inline JSON summary doesn't contain SUBTASK DECOMPOSITION. PM writes plan to deliverables/*.md — parser now checks there. Also extracts from nested JSON files[] array content field.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Recognized root IMPLEMENTATION-PLAN.md as a valid PM planning artifact so spec-driven planning runs complete cleanly
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | BF-030: Handle "no decomposition needed" as valid PM decision — return single work unit instead of escalating when PM output has no SUBTASK DECOMPOSITION marker
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Fixed PM decomposition parsing so acceptance-criteria test text no longer mislabels implementation subtasks as testing and inline suggested-agent-role hints become agent assignments
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed retired legacy product references (provider name is noop; narration removed)
 */

/* eslint-disable @typescript-eslint/no-redundant-type-constituents */

import * as fs from 'fs';
import * as path from 'path';
import type { ExternalWorkItem } from '@/entities/ticket';
import {
  MAX_ACTIVE_SUBTASKS_PER_PARENT,
  MAX_DECOMPOSITION_DEPTH,
} from '@/entities/work-item';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'ticket-decomposition-service' });

/**
 * @description One normalized sub-task extracted from an intake work item.
 * Supports 2-level hierarchy: depth 0 = root work unit, depth 1 = subtask.
 */
export interface DecomposedWorkUnit {
  unitId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  labels: string[];
  priority?: string;
  workType?: WorkUnitType;
  /** UUID of the parent work unit (null for root-level units). */
  parentUnitId: string | null;
  /** Decomposition depth: 0 = root, 1 = subtask. */
  depth: number;
}

/**
 * @description Normalized work intent inferred from decomposition text.
 */
export type WorkUnitType =
  | 'implementation'
  | 'testing'
  | 'documentation'
  | 'review'
  | 'integration'
  | 'analysis';

/**
 * @description Options for decomposition when creating subtasks of an existing work unit.
 */
export interface SubtaskDecompositionInput {
  /** The parent work unit ID to attach subtasks to. */
  parentUnitId: string;
  /** Current depth of the parent (must be 0 — only root items decompose). */
  parentDepth: number;
  /** Number of active subtasks the parent already has. */
  activeChildCount: number;
  /** Text body to decompose into subtask steps. */
  body: string;
  /** Title prefix for generated subtasks. */
  titlePrefix: string;
  /** External ticket ID for unit ID generation. */
  externalId: string;
  /** Labels inherited from the parent. */
  labels: string[];
  /** Priority inherited from the parent. */
  priority?: string;
}

/**
 * @description Decomposes provider tickets into deterministic work units for swarm execution.
 *
 * Supports 2-level hierarchical decomposition ported from the legacy QueueManagerService:
 * - Root tickets (depth 0) decompose into up to 5 work units
 * - Each work unit can be further decomposed into up to 5 subtasks (depth 1)
 * - Depth 1 items CANNOT decompose further (hard cutoff)
 * - Active subtask cap: max 5 active children per parent at any time
 * - Completed/failed subtasks free slots for new subtasks in subsequent cycles
 */

/**
 * @description Thrown when PM LLM planning output cannot be parsed into subtasks.
 * This is an escalation signal — the operator must review why the PM failed to produce
 * a valid decomposition. No silent fallback to deterministic parsing.
 */
export class PlanningDecompositionError extends Error {
  public readonly ticketId: string;
  constructor(ticketId: string, message: string) {
    super(message);
    this.name = 'PlanningDecompositionError';
    this.ticketId = ticketId;
  }
}

/**
 * @description Provider-agnostic service that turns intake work items into deterministic
 * work units for swarm execution. Supports root-level decomposition, 2-level hierarchical
 * subtask decomposition with depth and active-child caps, and LLM-driven decomposition
 * parsed from PM agent planning output.
 */
export class TicketDecompositionService {
  /**
   * @description Decomposes a work item into one or more root-level work units (depth 0).
   * @param workItem - Provider-agnostic intake work item
   * @returns Ordered list of decomposed work units at depth 0
   */
  decompose(workItem: ExternalWorkItem): DecomposedWorkUnit[] {
    const startedAt = Date.now();
    logger.info(
      {
        provider: workItem.provider,
        externalId: workItem.externalId,
      },
      'Starting ticket decomposition',
    );

    const parsedSteps = parseBodySteps(workItem.body);
    const units = parsedSteps.length > 0
      ? parsedSteps.map((step, index) => buildWorkUnitFromStep(workItem, step, index))
      : [buildSingleWorkUnit(workItem)];

    logger.info(
      {
        provider: workItem.provider,
        externalId: workItem.externalId,
        unitCount: units.length,
        durationMs: Date.now() - startedAt,
      },
      'Completed ticket decomposition',
    );

    return units;
  }

  /**
   * @description Decomposes text into subtasks (depth 1) of an existing parent work unit.
   * Respects the active subtask cap — only creates subtasks up to available slots.
   * Returns empty array if parent is already at max depth or cap is reached.
   *
   * @param input - Subtask decomposition parameters
   * @returns Subtask work units (depth 1) linked to the parent
   */
  decomposeSubtasks(input: SubtaskDecompositionInput): DecomposedWorkUnit[] {
    // Hard cutoff: only depth-0 items can have children
    if (input.parentDepth >= MAX_DECOMPOSITION_DEPTH) {
      logger.warn(
        { parentUnitId: input.parentUnitId, parentDepth: input.parentDepth },
        'Decomposition BLOCKED — parent already at max depth',
      );
      return [];
    }

    const availableSlots = MAX_ACTIVE_SUBTASKS_PER_PARENT - input.activeChildCount;
    if (availableSlots <= 0) {
      logger.warn(
        { parentUnitId: input.parentUnitId, activeChildCount: input.activeChildCount },
        'Decomposition deferred — active subtask cap reached',
      );
      return [];
    }

    const parsedSteps = parseBodySteps(input.body);
    if (parsedSteps.length === 0) {
      return [];
    }

    // Clamp to available slots
    const stepsToCreate = parsedSteps.slice(0, availableSlots);

    const subtasks = stepsToCreate.map((step, index) => buildSubtaskUnit(
      input.externalId,
      input.parentUnitId,
      input.titlePrefix,
      step,
      index,
      input.labels,
      input.priority,
    ));

    logger.info(
      {
        parentUnitId: input.parentUnitId,
        requestedCount: parsedSteps.length,
        createdCount: subtasks.length,
        availableSlots,
      },
      'Subtask decomposition completed',
    );

    return subtasks;
  }

  /**
   * @description Checks whether a work unit at the given depth can be further decomposed.
   * @param depth - Current depth of the work unit
   * @returns True if decomposition is allowed
   */
  canDecompose(depth: number): boolean {
    return depth < MAX_DECOMPOSITION_DEPTH;
  }

  /**
   * @description Decomposes a work item using LLM planning output from a PM agent.
   * Parses the agent response for `## SUBTASK DECOMPOSITION` marker with structured
   * `### Subtask N: Title` sections — matching the legacy implementation's QueueManagerService pattern.
   * Also extracts `AGENT_ASSIGNMENTS` if present — PM can suggest which agent/role
   * handles each subtask.
   * Falls back to deterministic decomposition if parsing fails or no marker found.
   *
   * @param planningOutput - Raw text output from the PM agent's planning round
   * @param workItem - Original work item for fallback and metadata
   * @returns Planning result with work units and optional agent assignments
   */
  async decomposeFromPlanningOutput(
    planningOutput: string,
    workItem: ExternalWorkItem,
    workspacePath?: string,
  ): Promise<PlanningDecompositionResult> {
    // Try 1: Parse from the raw planning output string
    let parsed = parsePlanningDecomposition(planningOutput, workItem);
    let assignments = parseAgentAssignments(planningOutput);
    let source = 'llm-inline';

    // Try 2: If inline parsing failed, check workspace deliverable files on disk.
    // PM agents write their plan to deliverables/*.md — the execution_output JSON
    // describes file operations, but the actual SUBTASK DECOMPOSITION text lives
    // in the file the PM wrote to disk.
    if (parsed.length < 2 && workspacePath) {
      // Short pause to let file writes flush — the PM's Cline process may still be
      // writing deliverables when the output poll returns. 3s is enough for disk I/O.
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const diskResult = parsePlanningFromWorkspace(workspacePath, workItem);
      if (diskResult.units.length >= 2) {
        parsed = diskResult.units;
        if (diskResult.assignments.length > 0) assignments = diskResult.assignments;
        source = 'llm-workspace-deliverable';
      }
    }

    if (parsed.length >= 2) {
      logger.info(
        {
          provider: workItem.provider,
          externalId: workItem.externalId,
          unitCount: parsed.length,
          assignmentCount: assignments.length,
          source,
        },
        'Decomposed work item from PM planning output',
      );
      return { workUnits: parsed, agentAssignments: assignments };
    }

    // PM produced output but no SUBTASK DECOMPOSITION marker found.
    // This is a valid PM decision — the task may be simple enough for single-agent execution.
    // Return a single work unit wrapping the original ticket so the caller can proceed
    // to single-agent routing instead of escalating.
    if (planningOutput && planningOutput.length > 0) {
      logger.info(
        {
          provider: workItem.provider,
          externalId: workItem.externalId,
          outputLength: planningOutput.length,
          workspacePath,
        },
        'PM planning produced output without SUBTASK DECOMPOSITION — treating as single work unit (no decomposition needed)',
      );
      return {
        workUnits: [{
          unitId: `${workItem.externalId}-single`,
          title: workItem.title,
          description: planningOutput.slice(0, 2000),
          acceptanceCriteria: [],
          labels: [],
          workType: 'implementation' as WorkUnitType,
          parentUnitId: null,
          depth: 0,
        }],
        agentAssignments: assignments,
      };
    }

    // PM ran but produced empty output — this IS an error.
    logger.error(
      {
        provider: workItem.provider,
        externalId: workItem.externalId,
        parsedCount: parsed.length,
        outputLength: planningOutput?.length ?? 0,
        workspacePath,
        source: 'escalation',
      },
      'PM planning produced empty output — ESCALATING. No deterministic fallback.',
    );
    throw new PlanningDecompositionError(
      workItem.externalId,
      `PM produced empty output — no planning content and no SUBTASK DECOMPOSITION found`,
    );
  }
}

/**
 * @description PM agent assignment hint extracted from AGENT_ASSIGNMENTS block.
 */
export interface AgentAssignment {
  subtaskTitle: string;
  suggestedRole: string;
  suggestedAgentId?: string;
}

/**
 * @description Result from LLM-based planning decomposition.
 */
export interface PlanningDecompositionResult {
  workUnits: DecomposedWorkUnit[];
  agentAssignments: AgentAssignment[];
}

// ─── LLM Planning Output Parser ─────────────────────────────────────────

/**
 * @description Parses PM agent planning output for structured subtask decomposition.
 * Recognizes the `## SUBTASK DECOMPOSITION` marker followed by `### Subtask N: Title` sections.
 * Mirrors the legacy implementation's QueueManagerService.detectSubtaskDecomposition() pattern.
 *
 * @param output - Raw PM agent response text
 * @param workItem - Original work item for ID generation and metadata
 * @returns Parsed work units from PM output (may be empty if marker not found)
 */
function parsePlanningDecomposition(
  output: string,
  workItem: ExternalWorkItem,
): DecomposedWorkUnit[] {
  if (!output) return [];

  // PM agents return JSON with the decomposition in various locations:
  //   1. Top-level fields: summary, result, output, content
  //   2. Nested content field (stringified JSON with files[] array)
  //   3. files[].content field — PM writes plan to a deliverable file
  let text = output;
  if (text.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(text);

      // Check top-level string fields
      const topLevel = [
        parsed.summary,
        parsed.result,
        parsed.output,
        typeof parsed === 'string' ? parsed : undefined,
      ].filter((v): v is string => typeof v === 'string');
      const foundTop = topLevel.find((c) => c.includes('## SUBTASK DECOMPOSITION'));
      if (foundTop) {
        text = foundTop;
        logger.info({ externalId: workItem.externalId }, 'Extracted SUBTASK DECOMPOSITION from JSON top-level field');
      } else {
        // Check nested content field — may be stringified JSON with files[]
        const contentStr = typeof parsed.content === 'string' ? parsed.content : undefined;
        if (contentStr) {
          const nestedCandidates = extractFromNestedContent(contentStr);
          const foundNested = nestedCandidates.find((c) => c.includes('## SUBTASK DECOMPOSITION'));
          if (foundNested) {
            text = foundNested;
            logger.info({ externalId: workItem.externalId }, 'Extracted SUBTASK DECOMPOSITION from nested content.files[]');
          }
        }
      }
    } catch {
      // Not valid JSON — use raw text
    }
  }

  const marker = '## SUBTASK DECOMPOSITION';
  if (!text.includes(marker)) return [];

  const afterMarker = text.split(marker)[1];
  if (!afterMarker) return [];

  // Try structured format: ### Subtask N: Title
  const subtaskSections = afterMarker.split(/###\s+Subtask\s+\d+:\s*/i).filter((s) => s.trim());
  if (subtaskSections.length < 2) {
    // Try legacy checklist format: - [ ] Task title
    return parseLegacyChecklist(afterMarker, workItem);
  }

  const units: DecomposedWorkUnit[] = [];
  for (let i = 0; i < Math.min(subtaskSections.length, MAX_ACTIVE_SUBTASKS_PER_PARENT); i++) {
    const section = subtaskSections[i].trim();
    const lines = section.split('\n');
    let title = lines[0].replace(/\s*[-—]+\s*$/, '').trim();

    // Strip bracket placeholders like "[Clear, Actionable Title]"
    if (/^\[.*\]$/.test(title)) {
      title = title.replace(/^\[|\]$/g, '').trim();
    }
    title = title.replace(/^\[+|\]+$/g, '').trim();

    // Reject template-like or too-short titles
    if (title.length < 10) continue;
    if (/^(title|clear|actionable|descriptive|your|enter|add|insert|placeholder)/i.test(title)) continue;

    const description = lines.slice(1).join('\n').trim() || title;
    const workType = inferWorkType(buildWorkTypeInferenceSource(title, description));
    const unitNumber = units.length + 1;

    // Extract acceptance criteria from description — handles multi-line bullet format:
    //   **Acceptance criteria:**
    //   - Criterion 1
    //   - Criterion 2
    const acceptanceCriteria = extractAcceptanceCriteria(description, workType, unitNumber);

    units.push({
      unitId: `${workItem.externalId}-unit-${unitNumber}`,
      title,
      description,
      acceptanceCriteria,
      labels: workItem.labels,
      priority: workItem.priority,
      workType,
      parentUnitId: null,
      depth: 0,
    });
  }

  return units;
}

/**
 * @description Parses legacy `- [ ] Task title` checklist format from PM output.
 */
function parseLegacyChecklist(
  text: string,
  workItem: ExternalWorkItem,
): DecomposedWorkUnit[] {
  const matches = text.match(/- \[ ] (.+)/g);
  if (!matches || matches.length < 2) return [];

  const units: DecomposedWorkUnit[] = [];
  const capped = matches.slice(0, MAX_ACTIVE_SUBTASKS_PER_PARENT);
  for (const m of capped) {
    const title = m.replace('- [ ] ', '').trim();
    if (title.length < 10) continue;
    const workType = inferWorkType(title);
    const unitNumber = units.length + 1;
    units.push({
      unitId: `${workItem.externalId}-unit-${unitNumber}`,
      title,
      description: title,
      acceptanceCriteria: [buildAcceptanceCriterion(workType, unitNumber)],
      labels: workItem.labels,
      priority: workItem.priority,
      workType,
      parentUnitId: null,
      depth: 0,
    });
  }
  return units;
}

/**
 * @description Parses AGENT_ASSIGNMENTS block from PM planning output.
 * Expected format (markdown table):
 * ```
 * ## AGENT_ASSIGNMENTS
 * | Subtask | Role | Agent |
 * |---|---|---|
 * | SmartThings CLI wrapper | executor | code-developer |
 * ```
 * Also accepts simpler `- Subtask: role` format.
 */
function parseAgentAssignments(output: string): AgentAssignment[] {
  if (!output) return [];

  // Handle JSON-wrapped output — extract assignments from JSON structure directly
  let text = output;
  if (text.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      // If PM returned structured assignments array, use them directly
      if (Array.isArray(parsed.assignments)) {
        return parsed.assignments
          .filter((a: Record<string, unknown>) => a.title && a.assignedRole)
          .slice(0, MAX_ACTIVE_SUBTASKS_PER_PARENT)
          .map((a: Record<string, unknown>) => ({
            subtaskTitle: String(a.title),
            suggestedRole: String(a.assignedRole),
            suggestedAgentId: a.agentId ? String(a.agentId) : undefined,
          }));
      }
      // Fall back to text extraction from summary field
      const candidates = [parsed.summary, parsed.result, parsed.output]
        .filter((v): v is string => typeof v === 'string');
      const found = candidates.find((c) => c.includes('AGENT_ASSIGNMENTS'));
      if (found) text = found;
    } catch {
      // Not valid JSON
    }
  }

  const marker = 'AGENT_ASSIGNMENTS';
  if (!text.includes(marker)) {
    return parseInlineSuggestedRoleAssignments(text);
  }

  const afterMarker = text.split(marker)[1];
  if (!afterMarker) return [];

  const assignments: AgentAssignment[] = [];

  // Try markdown table format: | Subtask | Role | Agent |
  const tableRows = afterMarker.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && !line.includes('---'));

  // Skip header row
  const dataRows = tableRows.length > 1 ? tableRows.slice(1) : [];
  for (const row of dataRows) {
    const cells = row.split('|').map((c) => c.trim()).filter((c) => c.length > 0);
    if (cells.length >= 2) {
      assignments.push({
        subtaskTitle: cells[0],
        suggestedRole: cells[1],
        suggestedAgentId: cells[2] || undefined,
      });
    }
  }

  if (assignments.length > 0) return assignments;

  // Fallback: `- SubtaskTitle: role` format
  const listItems = afterMarker.match(/^-\s+(.+?):\s+(.+)/gm);
  if (listItems) {
    for (const item of listItems) {
      const match = item.match(/^-\s+(.+?):\s+(.+)/);
      if (match) {
        assignments.push({
          subtaskTitle: match[1].trim(),
          suggestedRole: match[2].trim(),
        });
      }
    }
  }

  return assignments;
}

/**
 * @description Parses inline `Suggested agent role` hints from each PM subtask section.
 * @param output - Raw PM planning output.
 * @returns Parsed agent assignments discovered directly in subtask descriptions.
 */
function parseInlineSuggestedRoleAssignments(output: string): AgentAssignment[] {
  const marker = '## SUBTASK DECOMPOSITION';
  if (!output.includes(marker)) return [];

  const afterMarker = output.split(marker)[1];
  if (!afterMarker) return [];

  const subtaskSections = afterMarker.split(/###\s+Subtask\s+\d+:\s*/i).filter((section) => section.trim());
  const assignments: AgentAssignment[] = [];

  for (const section of subtaskSections) {
    const lines = section.split('\n');
    const title = normalizeSubtaskTitle(lines[0] ?? '');
    if (title.length < 10) continue;

    const description = lines.slice(1).join('\n').trim();
    const suggestedRole = extractSuggestedAgentRole(description);
    if (!suggestedRole) continue;

    assignments.push({
      subtaskTitle: title,
      suggestedRole,
    });
  }

  return assignments;
}

// ─── Internal Helpers ──────────────────────────────────────────────────

/**
 * @description Parses markdown/plaintext body text into candidate execution steps.
 * @param body - Work item body content
 * @returns Non-empty candidate step strings (max 5)
 */
function parseBodySteps(body: string): string[] {
  const normalized = body
    .split('\n')
    .map((line) => line.replace(/^[-*\d.)\s]+/, '').trim())
    .filter((line) => line.length > 0);

  return normalized.filter((_line, index) => index < MAX_ACTIVE_SUBTASKS_PER_PARENT);
}

/**
 * @description Builds one root-level work unit (depth 0) from an extracted body step.
 */
function buildWorkUnitFromStep(
  workItem: ExternalWorkItem,
  step: string,
  index: number,
): DecomposedWorkUnit {
  const unitNumber = index + 1;
  const workType = inferWorkType(step);
  return {
    unitId: `${workItem.externalId}-unit-${unitNumber}`,
    title: `${workItem.title} — Step ${unitNumber}`,
    description: step,
    acceptanceCriteria: [buildAcceptanceCriterion(workType, unitNumber)],
    labels: workItem.labels,
    priority: workItem.priority,
    workType,
    parentUnitId: null,
    depth: 0,
  };
}

/**
 * @description Builds a single fallback root work unit when no parseable body steps exist.
 */
function buildSingleWorkUnit(workItem: ExternalWorkItem): DecomposedWorkUnit {
  const description = workItem.body || workItem.title;
  const workType = inferWorkType(description);
  return {
    unitId: `${workItem.externalId}-unit-1`,
    title: workItem.title,
    description,
    acceptanceCriteria: [buildAcceptanceCriterion(workType, 1)],
    labels: workItem.labels,
    priority: workItem.priority,
    workType,
    parentUnitId: null,
    depth: 0,
  };
}

/**
 * @description Builds a subtask work unit (depth 1) linked to a parent.
 */
function buildSubtaskUnit(
  externalId: string,
  parentUnitId: string,
  titlePrefix: string,
  step: string,
  index: number,
  labels: string[],
  priority?: string,
): DecomposedWorkUnit {
  const subtaskNumber = index + 1;
  const workType = inferWorkType(step);
  return {
    unitId: `${externalId}-${parentUnitId}-sub-${subtaskNumber}`,
    title: `${titlePrefix} — Subtask ${subtaskNumber}`,
    description: step,
    acceptanceCriteria: [buildAcceptanceCriterion(workType, subtaskNumber, true)],
    labels,
    priority,
    workType,
    parentUnitId,
    depth: 1,
  };
}

/**
 * @description Builds a work-type inference source that excludes acceptance criteria noise.
 * @param title - Parsed PM subtask title.
 * @param description - Parsed PM subtask description block.
 * @returns Text optimized for work-type classification.
 */
function buildWorkTypeInferenceSource(title: string, description: string): string {
  const suggestedRole = extractSuggestedAgentRole(description);
  // PM subtask descriptions often mention tests in acceptance criteria even when the
  // actual work is implementation. Prefer the title + explicit suggested role signal
  // so implementation subtasks are not misclassified as testing.
  return [title, suggestedRole].filter((part) => typeof part === 'string' && part.trim().length > 0).join('\n');
}

/**
 * @description Extracts a suggested agent role hint from one PM subtask description block.
 * @param description - Parsed PM subtask description.
 * @returns Suggested role when present, otherwise undefined.
 */
function extractSuggestedAgentRole(description: string): string | undefined {
  const match = description.match(/\*{0,2}\s*suggested\s+agent\s+role\s*:??\s*\*{0,2}\s*([a-z0-9-]+)/i);
  return match?.[1]?.trim();
}

/**
 * @description Normalizes a PM subtask title by stripping markdown placeholders and punctuation.
 * @param rawTitle - Raw title line from the PM output.
 * @returns Cleaned title text.
 */
function normalizeSubtaskTitle(rawTitle: string): string {
  let title = rawTitle.replace(/\s*[-—]+\s*$/, '').trim();
  if (/^\[.*\]$/.test(title)) {
    title = title.replace(/^\[|\]$/g, '').trim();
  }
  return title.replace(/^\[+|\]+$/g, '').trim();
}

/**
 * @description Infers coarse work intent from a step or task description.
 * @param text - Step text to classify.
 * @returns Normalized work-unit type.
 */
function inferWorkType(text: string): WorkUnitType {
  const normalized = text.toLowerCase();

  if (/(test|vitest|jest|spec|assert|coverage|validate|verification)/.test(normalized)) {
    return 'testing';
  }
  if (/(readme|document|docs|handover|guide|explain)/.test(normalized)) {
    return 'documentation';
  }
  if (/(review|approve|qa|audit|inspect|check)/.test(normalized)) {
    return 'review';
  }
  if (/(integrate|integration|wire|connect|hook|compose|sync)/.test(normalized)) {
    return 'integration';
  }
  if (/(plan|analy|research|investigat|design|scope)/.test(normalized)) {
    return 'analysis';
  }
  return 'implementation';
}

/**
 * @description Builds one work-type-aware acceptance criterion without changing the unit count.
 * @param workType - Inferred work intent.
 * @param ordinal - 1-based step or subtask number.
 * @param isSubtask - True when the acceptance criterion is for a depth-1 subtask.
 * @returns Single acceptance criterion string.
 */
function buildAcceptanceCriterion(
  workType: WorkUnitType,
  ordinal: number,
  isSubtask = false,
): string {
  const subject = isSubtask ? `Subtask ${ordinal}` : `Step ${ordinal}`;

  switch (workType) {
    case 'testing':
      return `${subject} includes relevant tests or validation and those checks pass.`;
    case 'documentation':
      return `${subject} updates the required documentation accurately and leaves the usage clear.`;
    case 'review':
      return `${subject} records review findings and makes the approval or revision outcome explicit.`;
    case 'integration':
      return `${subject} completes the required integration wiring and validates the connected path.`;
    case 'analysis':
      return `${subject} produces concrete analysis or planning output that is actionable for the next phase.`;
    default:
      return `${subject} is implemented and validated.`;
  }
}

// ─── AC + Agent Role Extraction ────────────────────────────────────────

/**
 * @description Extracts acceptance criteria from a subtask description block.
 * Handles both single-line and multi-line bullet formats from PM output.
 */
function extractAcceptanceCriteria(
  description: string,
  workType: WorkUnitType,
  unitNumber: number,
): string[] {
  const acMarker = description.match(/\*?\*?acceptance\s+criteria\*?\*?[:\s]*/i);
  if (!acMarker) return [buildAcceptanceCriterion(workType, unitNumber)];

  const afterMarker = description.slice((acMarker.index ?? 0) + acMarker[0].length);
  const bullets = afterMarker
    .split('\n')
    .map((l) => l.replace(/^[-*]\s*/, '').trim())
    .filter((l) => l.length > 5 && !l.startsWith('**') && !l.startsWith('Suggested'));

  return bullets.length > 0 ? bullets : [buildAcceptanceCriterion(workType, unitNumber)];
}

// ─── Nested Content + Workspace File Extraction ────────────────────────

/**
 * @description Extracts candidate text from a nested JSON content field.
 * PM agents return execution_output with a stringified content field containing
 * a files[] array. Each file entry has a `content` field describing what was written.
 * We also check for the actual file text if the content is the full file body.
 */
function extractFromNestedContent(contentStr: string): string[] {
  const candidates: string[] = [];

  // Content itself might contain the marker
  if (contentStr.includes('## SUBTASK DECOMPOSITION')) {
    candidates.push(contentStr);
  }

  // Try parsing as JSON with files[] array
  if (contentStr.trimStart().startsWith('{') || contentStr.trimStart().startsWith('[')) {
    try {
      const nested = JSON.parse(contentStr);
      const files = Array.isArray(nested) ? nested : nested.files;
      if (Array.isArray(files)) {
        for (const f of files) {
          if (typeof f.content === 'string') candidates.push(f.content);
          if (typeof f.body === 'string') candidates.push(f.body);
          if (typeof f.text === 'string') candidates.push(f.text);
        }
      }
      if (typeof nested.summary === 'string') candidates.push(nested.summary);
    } catch {
      // Not parseable JSON
    }
  }

  return candidates;
}

/**
 * @description Reads workspace deliverable files on disk for PM planning output.
 * PM agents write `## SUBTASK DECOMPOSITION` into deliverables/*.md files.
 * This function scans those files and parses the first one containing the marker.
 */
function parsePlanningFromWorkspace(
  workspacePath: string,
  workItem: ExternalWorkItem,
): { units: DecomposedWorkUnit[]; assignments: AgentAssignment[] } {
  const deliverablesDir = path.join(workspacePath, 'deliverables');
  const candidateFiles = collectPlanningCandidateFiles(workspacePath, deliverablesDir);
  if (candidateFiles.length === 0) {
    return { units: [], assignments: [] };
  }

  try {
    for (const filePath of candidateFiles) {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > 500_000) continue;

      const content = fs.readFileSync(filePath, 'utf-8');
      if (!content.includes('## SUBTASK DECOMPOSITION')) continue;

      logger.info(
        { externalId: workItem.externalId, file: path.basename(filePath), filePath },
        'Found SUBTASK DECOMPOSITION in workspace deliverable file',
      );

      const units = parsePlanningDecomposition(content, workItem);
      const assignments = parseAgentAssignments(content);
      if (units.length >= 2) {
        return { units, assignments };
      }
    }
  } catch (err) {
    logger.warn(
      { err, workspacePath },
      'Failed to read workspace deliverable files for planning output',
    );
  }

  return { units: [], assignments: [] };
}

/**
 * @description Collects workspace markdown files that may contain PM planning output.
 * Prefers the root IMPLEMENTATION-PLAN.md produced by the spec-driven PM persona, then
 * falls back to root planning docs and deliverables/*.md for legacy flows.
 * @param workspacePath - Root shared workspace path for the ticket.
 * @param deliverablesDir - Deliverables directory inside the workspace.
 * @returns Ordered candidate markdown files to inspect.
 */
function collectPlanningCandidateFiles(
  workspacePath: string,
  deliverablesDir: string,
): string[] {
  const ordered = new Set<string>();

  const preferredRootFiles = [
    'IMPLEMENTATION-PLAN.md',
    'PROJECT-PLAN.md',
    'PLANNING-DELIVERABLE.md',
  ];

  for (const fileName of preferredRootFiles) {
    const candidatePath = path.join(workspacePath, fileName);
    if (fs.existsSync(candidatePath)) {
      ordered.add(candidatePath);
    }
  }

  if (fs.existsSync(deliverablesDir)) {
    const deliverableFiles = fs.readdirSync(deliverablesDir)
      .filter((entry) => entry.endsWith('.md'))
      .sort()
      .reverse()
      .map((entry) => path.join(deliverablesDir, entry));
    for (const filePath of deliverableFiles) {
      ordered.add(filePath);
    }
  }

  return Array.from(ordered);
}
