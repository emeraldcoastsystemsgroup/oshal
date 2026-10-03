/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from planning-round-orchestrator.ts, which had crossed 800 code lines: the planning-entry and preparation-packet readers and the work-unit builders (direct execution, PM planning, incident planning, architecture, single unit). Pure move; the exported members gained full JSDoc and the recommended-path normalizer its own description.
 */

import type { ExternalWorkItem } from '@/entities/ticket';
import type {
  IntakeArtifactBlueprint,
  IntakePlanStatus,
  IntakePlanningEntryMode,
  IntakeRecommendedPath,
} from '@/shared/types/intake';
import type { DecomposedWorkUnit, WorkUnitType } from './ticket-decomposition-service';

/** @description The file the system architect writes in the workspace root. */
export const TECHNICAL_SPECIFICATION_FILE = 'TECHNICAL-SPECIFICATION.md';
/** @description How a ticket enters planning: discovery, or validating a plan package it was filed with. */
export interface PlanningEntryDetails {
  mode: IntakePlanningEntryMode;
  planStatus: IntakePlanStatus;
  suppliedPlanSummary?: string;
  suppliedArtifacts: string[];
  suppliedArtifactPaths: string[];
}

/** @description The PM preparation packet and artifact blueprints a ticket was filed with, if any. */
export interface PreparationPacketDetails {
  pmPrepPacket?: string;
  artifactBlueprints: IntakeArtifactBlueprint[];
}

/**
 * @description Reads planning-entry metadata while preserving the legacy discovery path by default.
 * @param itemMeta - The ticket metadata.
 * @returns The planning entry mode, plan status and any supplied plan artifacts.
 */
export function derivePlanningEntry(itemMeta: Record<string, unknown>): PlanningEntryDetails {
  const suppliedArtifacts = readMergedStringArray(
    itemMeta.suppliedPlanningArtifacts,
    itemMeta.suppliedPlanArtifacts,
    itemMeta.providedPlanArtifacts,
  );
  const suppliedArtifactPaths = readMergedStringArray(
    itemMeta.suppliedPlanningArtifactPaths,
    itemMeta.providedPlanPaths,
    itemMeta.suppliedPlanPaths,
  );
  const suppliedPlanSummary = firstNonEmptyString(
    itemMeta.suppliedPlanSummary,
    itemMeta.planSummary,
    itemMeta.outcomeBrief,
  );

  const explicitMode = normalizePlanningEntryMode(itemMeta.planningEntryMode);
  const explicitStatus = normalizePlanStatus(itemMeta.planStatus);

  const inferredMode: IntakePlanningEntryMode = explicitMode
    ?? ((explicitStatus === 'supplied' || explicitStatus === 'approved' || suppliedArtifacts.length > 0 || suppliedArtifactPaths.length > 0 || Boolean(suppliedPlanSummary))
      ? 'validate-existing'
      : 'discovery');

  const inferredStatus: IntakePlanStatus = explicitStatus
    ?? (inferredMode === 'validate-existing' ? 'supplied' : 'missing');

  return {
    mode: inferredMode,
    planStatus: inferredStatus,
    suppliedPlanSummary,
    suppliedArtifacts,
    suppliedArtifactPaths,
  };
}

function buildPlanningEntrySection(planningEntry: PlanningEntryDetails): string[] {
  const lines = [
    '## Planning Entry Mode',
    `- Mode: ${planningEntry.mode}`,
    `- Plan status: ${planningEntry.planStatus}`,
  ];

  if (planningEntry.suppliedPlanSummary) {
    lines.push(`- Supplied plan summary: ${planningEntry.suppliedPlanSummary}`);
  }
  if (planningEntry.suppliedArtifacts.length > 0) {
    lines.push(`- Declared supplied artifacts: ${planningEntry.suppliedArtifacts.join(', ')}`);
  }
  if (planningEntry.suppliedArtifactPaths.length > 0) {
    lines.push(`- Supplied artifact paths: ${planningEntry.suppliedArtifactPaths.join(', ')}`);
  }

  if (planningEntry.mode === 'validate-existing') {
    lines.push('- IMPORTANT: treat the supplied plan as the starting point. Validate, tighten, resource, and fill gaps. Do NOT restart discovery from zero unless the package is clearly insufficient.');
  } else {
    lines.push('- IMPORTANT: no approved plan was supplied. Use the standard discovery-first planning path.');
  }

  return lines;
}

/**
 * @description Reads the PM preparation packet and artifact blueprints from ticket metadata.
 * @param itemMeta - The ticket metadata.
 * @returns The preparation packet details; empty when the ticket carries none.
 */
export function derivePreparationPacket(itemMeta: Record<string, unknown>): PreparationPacketDetails {
  return {
    pmPrepPacket: firstNonEmptyString(itemMeta.pmPrepPacket, itemMeta.projectPreparationPacket),
    artifactBlueprints: readArtifactBlueprints(itemMeta.artifactBlueprints),
  };
}

function buildPreparationPacketSection(preparationPacket: PreparationPacketDetails): string[] {
  if (!preparationPacket.pmPrepPacket && preparationPacket.artifactBlueprints.length === 0) {
    return [];
  }

  const lines = [
    '## Project Preparation Packet',
    '- Read PM-PREP-PACKET.md first when it exists in the workspace root. Treat it as the explicit artifact contract for how this project should be prepared before execution.',
  ];

  if (preparationPacket.artifactBlueprints.length > 0) {
    lines.push(
      `- Declared artifact blueprints: ${preparationPacket.artifactBlueprints.map((artifact) => `${artifact.displayName} (${artifact.ownerRole})`).join(', ')}`,
    );
  }

  if (preparationPacket.pmPrepPacket) {
    lines.push(
      '',
      '### Inline PM Prep Packet',
      preparationPacket.pmPrepPacket,
    );
  }

  return lines;
}

/**
 * @description Builds the single work unit used for child-ticket direct execution.
 * @param item - The ticket being executed.
 * @param itemMeta - The ticket metadata.
 * @param _ticketDepth - The ticket depth (unused; kept for the call shape).
 * @returns The one execution work unit.
 */
export function buildDirectExecutionUnit(
  item: ExternalWorkItem,
  itemMeta: Record<string, unknown>,
  _ticketDepth: number,
): DecomposedWorkUnit {
  const recommendedPath = normalizeRecommendedPath(itemMeta.recommendedPath);
  const directExecutionPreamble = recommendedPath === 'instant-answer'
    ? 'This ticket was classified as instant-answer work. First ask: can I answer this quickly as a verbal response from the current context and internal knowledge? If yes, answer immediately and concisely. Do not create a heavyweight plan, and avoid tools/files unless they are clearly necessary.'
    : (recommendedPath === 'direct-execution'
      ? 'This ticket was classified for direct execution. Keep the solution lightweight and move straight into implementation.'
      : undefined);

  return {
    unitId: `${item.externalId}-unit-1`,
    title: item.title,
    description: [directExecutionPreamble, item.body ?? item.title].filter(Boolean).join('\n\n'),
    acceptanceCriteria: readStringArray(itemMeta.acceptanceCriteria),
    labels: item.labels ?? [],
    priority: item.priority,
    workType: (itemMeta.workType as WorkUnitType | undefined) ?? 'implementation',
    parentUnitId: null,
    // Child tickets are still root execution units within their own swarm run.
    // Ticket depth drives routing context, but work-unit depth must stay 0 so the
    // execution lifecycle uses the normal assigned/completed flow instead of subtask semantics.
    depth: 0,
  };
}

/**
 * @description Builds the root planning work unit dispatched to the PM.
 * @param item - The root ticket.
 * @param planningEntry - How the ticket enters planning.
 * @param preparationPacket - The preparation packet the ticket was filed with.
 * @returns The planning work unit, carrying the required SUBTASK DECOMPOSITION output format.
 */
export function buildPlanningWorkUnit(
  item: ExternalWorkItem,
  planningEntry: PlanningEntryDetails,
  preparationPacket: PreparationPacketDetails,
): DecomposedWorkUnit {
  const planningEntrySection = buildPlanningEntrySection(planningEntry);
  const preparationPacketSection = buildPreparationPacketSection(preparationPacket);
  const validateExistingMode = planningEntry.mode === 'validate-existing';
  const isIncident = (item.labels ?? []).some((l: string) => ['incident', 'rca-requested'].includes(l.toLowerCase()));

  if (isIncident) {
    return buildIncidentPlanningWorkUnit(item, planningEntrySection, preparationPacketSection);
  }

  return {
    unitId: `${item.externalId}-planning`,
    title: `Plan and decompose: ${item.title}`,
    description: [
      validateExistingMode
        ? 'You are validating and tightening a supplied plan package before build begins. Do NOT restart planning from zero when the supplied materials are usable.'
        : 'You are the planning authority for this ticket. Read the full ticket and produce a structured implementation plan.',
      '',
      `## Ticket: ${item.title}`,
      '',
      item.body ?? '',
      '',
      ...planningEntrySection,
      ...(preparationPacketSection.length > 0 ? ['', ...preparationPacketSection] : []),
      '',
      '## Your Task',
      '0. Read PM-PREP-PACKET.md first when present. Use it as the explicit preparation contract and artifact-quality bar.',
      '0a. Follow PMP-style project controls for scope, schedule, estimates, risks, stakeholders/communications, resources, dependencies, and readiness. Respect TOGAF-style architect outputs as the architecture source of truth. Require downstream execution agents to follow RALF handovers and delivery discipline.',
      validateExistingMode
        ? '1. Read the supplied plan package and existing workspace artifacts first. Reuse good planning work instead of starting over.'
        : '1. Read TECHNICAL-SPECIFICATION.md when it exists and reference it explicitly.',
      validateExistingMode
        ? '2. Validate the supplied plan for architecture, functional scope, integration boundaries, hosting, costing, estimate, phasing, and resourcing gaps.'
        : '2. Produce IMPLEMENTATION-PLAN.md in the workspace root.',
      validateExistingMode
        ? '3. Produce a tightened IMPLEMENTATION-PLAN.md in the workspace root that becomes the approved build plan.'
        : '3. Synthesize the architecture, business requirements, constraints, and dependencies into a build-ready plan.',
      validateExistingMode
        ? '4. Fill only the missing or weak parts. Do NOT re-discover solved work unless the supplied plan is insufficient.'
        : '4. For each subtask, specify a clear title, description, files to create, acceptance criteria, and suggested agent role.',
      validateExistingMode
        ? '5. Add a ## PLAN VALIDATION section summarizing what was accepted, what was corrected, and what gaps still remain.'
        : '5. Add sequencing, dependencies, and delivery notes that help execution move cleanly.',
      validateExistingMode
        ? '6. Add a ## RESOURCING CHECK section naming the specialist roles or agents needed for build.'
        : '6. Decompose the implementation into concrete subtasks (2-7 subtasks).',
      validateExistingMode
        ? '7. Include a ## SUBTASK DECOMPOSITION section with the build-ready subtasks (2-7 subtasks).'
        : '7. Include a ## SUBTASK DECOMPOSITION section with the build-ready subtasks (2-7 subtasks).',
      '',
      '## Required Output Format',
      'Your response MUST include a section with this exact header:',
      '',
      '## SUBTASK DECOMPOSITION',
      '',
      '### Subtask 1: [Clear title describing the work]',
      'Description of what needs to be done, acceptance criteria, and suggested agent role.',
      '',
      '### Subtask 2: [Clear title describing the work]',
      'Description of what needs to be done, acceptance criteria, and suggested agent role.',
    ].join('\n'),
    acceptanceCriteria: ['Planning output includes IMPLEMENTATION-PLAN.md and a ## SUBTASK DECOMPOSITION section with 2+ subtasks'],
    labels: item.labels ?? [],
    priority: item.priority,
    workType: 'analysis',
    parentUnitId: null,
    depth: 0,
  };
}

/** @description Builds the incident investigation planning work unit — single bot assignment, no decomposition. */
function buildIncidentPlanningWorkUnit(
  item: ExternalWorkItem,
  planningEntrySection: string[],
  preparationPacketSection: string[],
): DecomposedWorkUnit {
  return {
    unitId: `${item.externalId}-planning`,
    title: `Investigate incident: ${item.title}`,
    description: [
      'You are the **Incident Investigation Lead**. This is an infrastructure incident, NOT a software development ticket.',
      '',
      '**DO NOT decompose this into multiple subtasks.** Assign the ENTIRE investigation to ONE specialist bot.',
      '**DO NOT write TypeScript, test suites, npm packages, or software applications.**',
      '',
      `## Incident: ${item.title}`,
      '',
      item.body ?? '',
      '',
      ...planningEntrySection,
      ...(preparationPacketSection.length > 0 ? ['', ...preparationPacketSection] : []),
      '',
      '## Your Task as PM',
      '1. Read the incident data above.',
      '2. Write **README.md** — Brief incident summary and evidence inventory.',
      '3. Create exactly ONE subtask that assigns the full investigation to a single specialist.',
      '',
      '## CRITICAL: ONE SUBTASK, ONE BOT',
      'Do NOT split this into separate RCA, topology, and remediation subtasks.',
      'One bot gets everything. That bot will:',
      '- Analyze the evidence and produce a root cause analysis with confidence levels',
      '- Assess topology impact and blast radius',
      '- Search memory for similar past incidents',
      '- Write remediation scripts (DO NOT EXECUTE) with rollback procedures',
      '- Produce all deliverables in the workspace',
      '',
      '## Required Output Format',
      'Your response MUST include:',
      '',
      '## SUBTASK DECOMPOSITION',
      '',
      '### Subtask 1: Investigate and remediate — [incident title]',
      'Full incident investigation: root cause analysis, topology impact assessment, remediation scripts, rollback procedures.',
      '',
      'Use all provided evidence: alert data, SISM infrastructure context, topology graph, ServiceNow changes, Splunk logs.',
      'Search memory for similar past incidents. Use graph and OpenSearch tools if available.',
      '',
      '**Deliverables:**',
      '- deliverables/RCA-REPORT.md — Root cause with confidence, contributing factors, alternatives',
      '- deliverables/IMPACT-ASSESSMENT.md — Blast radius, affected systems, business impact',
      '- deliverables/scripts/diagnose.sh — Diagnostic commands to verify current state',
      '- deliverables/scripts/remediate.sh — Fix steps with preflight checks (DO NOT EXECUTE)',
      '- deliverables/scripts/rollback.sh — Rollback procedures if remediation fails',
      '',
      '**Suggested agent role:** rca-specialist',
    ].join('\n'),
    acceptanceCriteria: ['Single investigation subtask assigned to rca-specialist with all deliverables specified'],
    labels: item.labels ?? [],
    priority: item.priority,
    workType: 'analysis',
    parentUnitId: null,
    depth: 0,
  };
}

/**
 * @description Builds the pre-planning architecture work unit dispatched to the system architect.
 * @param item - The root ticket.
 * @param planningEntry - How the ticket enters planning.
 * @returns The architecture work unit.
 */
export function buildArchitectureWorkUnit(item: ExternalWorkItem, planningEntry: PlanningEntryDetails): DecomposedWorkUnit {
  const planningEntrySection = buildPlanningEntrySection(planningEntry);
  const validateExistingMode = planningEntry.mode === 'validate-existing';
  return {
    unitId: `${item.externalId}-architecture`,
    title: `Write technical specification: ${item.title}`,
    description: [
      validateExistingMode
        ? 'You are the system architect reviewing a supplied plan package before build planning begins. Validate the existing architecture and fill only the missing technical gaps.'
        : 'You are the system architect for this ticket. Perform the technical discovery before implementation planning begins.',
      '',
      `## Ticket: ${item.title}`,
      '',
      item.body ?? '',
      '',
      ...planningEntrySection,
      '',
      '## Required Deliverable',
      `Write ${TECHNICAL_SPECIFICATION_FILE} to the workspace root.`,
      validateExistingMode
        ? 'Review the supplied plan first. Preserve valid decisions, correct weak ones, and document any missing architecture, integration, stack, hosting, or deployment detail.'
        : 'Ground every external API statement in fetched documentation and document the implementation strategy clearly.',
    ].join('\n'),
    acceptanceCriteria: [`${TECHNICAL_SPECIFICATION_FILE} exists in the workspace root and references the required dependencies and data contracts`],
    labels: item.labels ?? [],
    priority: item.priority,
    workType: 'analysis',
    parentUnitId: null,
    depth: 0,
  };
}

/**
 * @description Builds a single execution work unit when planning cannot decompose the root ticket.
 * @param item - The root ticket.
 * @returns The one execution work unit.
 */
export function buildSingleWorkUnit(item: ExternalWorkItem): DecomposedWorkUnit {
  return {
    unitId: `${item.externalId}-unit-1`,
    title: item.title,
    description: item.body ?? item.title,
    acceptanceCriteria: [],
    labels: item.labels ?? [],
    priority: item.priority,
    workType: 'implementation',
    parentUnitId: null,
    depth: 0,
  };
}

/** @description Normalizes a metadata field into a string array. */
function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** @description Reads and merges multiple metadata fields into one deduplicated string array. */
function readMergedStringArray(...values: unknown[]): string[] {
  return [...new Set(values.flatMap((value) => readStringArray(value)))];
}

/** @description Reads artifact blueprints from metadata when they are persisted as JSON objects. */
function readArtifactBlueprints(value: unknown): IntakeArtifactBlueprint[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const artifactId = typeof record.artifactId === 'string' ? record.artifactId.trim() : '';
    const displayName = typeof record.displayName === 'string' ? record.displayName.trim() : '';
    const purpose = typeof record.purpose === 'string' ? record.purpose.trim() : '';
    const ownerRole = typeof record.ownerRole === 'string' ? record.ownerRole.trim() : '';
    const governingStandards = readStringArray(record.governingStandards);
    const minimumContents = readStringArray(record.minimumContents);
    const exampleOutline = readStringArray(record.exampleOutline);

    if (!artifactId || !displayName || !purpose || !ownerRole || governingStandards.length === 0 || minimumContents.length === 0 || exampleOutline.length === 0) {
      return [];
    }

    return [{
      artifactId,
      displayName,
      purpose,
      ownerRole,
      governingStandards,
      minimumContents,
      exampleOutline,
    }];
  });
}

/** @description Reads the first non-empty string from a list of metadata values. */
function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

/** @description Normalizes planning-entry metadata into the supported contract. */
function normalizePlanningEntryMode(value: unknown): IntakePlanningEntryMode | undefined {
  return value === 'validate-existing' || value === 'discovery'
    ? value
    : undefined;
}

/** @description Normalizes plan-status metadata into the supported contract. */
function normalizePlanStatus(value: unknown): IntakePlanStatus | undefined {
  return value === 'missing' || value === 'supplied' || value === 'approved' || value === 'gap-fill-required'
    ? value
    : undefined;
}

/**
 * @description Normalizes intake recommended-path metadata into the supported contract.
 * @param value - The raw metadata value.
 * @returns The recommended path, or undefined for anything else.
 */
export function normalizeRecommendedPath(value: unknown): IntakeRecommendedPath | undefined {
  return value === 'instant-answer' || value === 'direct-execution' || value === 'structured-project'
    ? value
    : undefined;
}
