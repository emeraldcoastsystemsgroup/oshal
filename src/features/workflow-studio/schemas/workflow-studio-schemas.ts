/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added workflow-studio schema contracts, node catalog, and seeded design-time blueprint helpers
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * @description Canonical, ordered list of every node type the workflow studio can author, used as the single source of truth that drives the node enum, catalog, and validation.
 */
export const WORKFLOW_NODE_TYPES = [
  'start',
  'intake-source',
  'planner',
  'route-agent',
  'ai-decision',
  'logic-gate',
  'execute-agent',
  'parallel-split',
  'approval-gate',
  'verify-output',
  'review',
  'deliver',
  'escalate',
  'parallel-join',
] as const;

/**
 * @description Zod enum that constrains a value to one of the supported workflow node types so persisted definitions cannot reference unknown nodes.
 */
export const WorkflowNodeTypeSchema = z.enum(WORKFLOW_NODE_TYPES);
/**
 * @description Union type of the allowed workflow node identifiers, inferred from the node-type schema.
 */
export type WorkflowNodeType = z.infer<typeof WorkflowNodeTypeSchema>;

/**
 * @description Zod enum describing how a catalog field is rendered/edited in the studio UI (e.g. free text, dropdown, tag list).
 */
export const WorkflowFieldInputTypeSchema = z.enum(['text', 'textarea', 'select', 'tags', 'number', 'boolean']);
/**
 * @description Union type of the supported field input widgets, inferred from the field-input schema.
 */
export type WorkflowFieldInputType = z.infer<typeof WorkflowFieldInputTypeSchema>;

/**
 * @description Zod enum naming the live runtime data sources a select/tags field can pull its options from (agents, capabilities, or routing keywords).
 */
export const WorkflowFieldOptionsSourceSchema = z.enum(['agents', 'capabilities', 'routing-keywords']);
/**
 * @description Union type of the dynamic option-source identifiers, inferred from the options-source schema.
 */
export type WorkflowFieldOptionsSource = z.infer<typeof WorkflowFieldOptionsSourceSchema>;

/**
 * @description Zod schema for a single configurable field on a node, describing its key, label, input widget, option sources, and whether it is required.
 */
export const WorkflowNodeCatalogFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  input: WorkflowFieldInputTypeSchema,
  helpText: z.string().optional(),
  options: z.array(z.string()).optional(),
  optionsSource: WorkflowFieldOptionsSourceSchema.optional(),
  placeholder: z.string().optional(),
  required: z.boolean().optional().default(false),
});
/**
 * @description Type of a single catalog field definition, inferred from the catalog-field schema.
 */
export type WorkflowNodeCatalogField = z.infer<typeof WorkflowNodeCatalogFieldSchema>;

/**
 * @description Zod schema for a catalog entry describing one node type: its display metadata, runtime binding, default title/description/config, and editable fields.
 */
export const WorkflowNodeCatalogEntrySchema = z.object({
  type: WorkflowNodeTypeSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  theme: z.string().min(1),
  runtimeBinding: z.string().min(1),
  defaultTitle: z.string().min(1),
  defaultDescription: z.string().min(1),
  defaultConfig: z.record(z.string(), z.unknown()),
  fields: z.array(WorkflowNodeCatalogFieldSchema),
});
/**
 * @description Type of a fully described node catalog entry, inferred from the catalog-entry schema.
 */
export type WorkflowNodeCatalogEntry = z.infer<typeof WorkflowNodeCatalogEntrySchema>;

/**
 * @description Parsed, validated catalog of all node types available in the studio palette, defining each node's defaults, runtime binding, and configurable fields.
 */
export const WORKFLOW_NODE_CATALOG = WorkflowNodeCatalogEntrySchema.array().parse([
  {
    type: 'start',
    title: 'Start',
    description: 'Visual entry marker for a workflow definition. This does not execute anything by itself.',
    theme: 'sunrise',
    runtimeBinding: 'workflow-bootstrap',
    defaultTitle: 'Start',
    defaultDescription: 'Entry marker for the design-time workflow.',
    defaultConfig: {
      triggerMode: 'manual',
    },
    fields: [
      {
        key: 'triggerMode',
        label: 'Trigger Mode',
        input: 'select',
        options: ['manual', 'ticket-submission', 'provider-poll'],
        helpText: 'Documents which runtime entrypoint should attach to this workflow design.',
        required: true,
      },
    ],
  },
  {
    type: 'intake-source',
    title: 'Intake Source',
    description: 'Declares where work enters the swarm without changing the current runtime adapters.',
    theme: 'sea-glass',
    runtimeBinding: 'intake-service',
    defaultTitle: 'Normalize Intake',
    defaultDescription: 'Document the ticket or provider entrypoint that should supply work.',
    defaultConfig: {
      provider: 'direct',
      interactionMode: 'ticket',
      requiredCapabilities: [],
    },
    fields: [
      {
        key: 'provider',
        label: 'Provider',
        input: 'select',
        options: ['direct', 'plane', 'github', 'internal-ticket'],
        required: true,
      },
      {
        key: 'interactionMode',
        label: 'Interaction Mode',
        input: 'select',
        options: ['ticket'],
        required: true,
      },
      {
        key: 'requiredCapabilities',
        label: 'Required Capabilities',
        input: 'tags',
        placeholder: 'planning, documentation, code',
        helpText: 'Optional capability hints passed into the existing runtime, not new routing logic.',
      },
    ],
  },
  {
    type: 'planner',
    title: 'Planner',
    description: 'Maps to the current PM planning and decomposition path already present in swarm orchestration.',
    theme: 'copper',
    runtimeBinding: 'planning-round-orchestrator',
    defaultTitle: 'Plan Ticket',
    defaultDescription: 'Use the current planning round orchestrator and PM guidance.',
    defaultConfig: {
      planningMode: 'pm-planning',
      stopAfterPlanning: true,
    },
    fields: [
      {
        key: 'planningMode',
        label: 'Planning Mode',
        input: 'select',
        options: ['pm-planning', 'single-work-unit', 'child-direct'],
        required: true,
      },
      {
        key: 'stopAfterPlanning',
        label: 'Stop After Planning',
        input: 'boolean',
        helpText: 'Documents whether the workflow expects a build approval gate before execution continues.',
      },
    ],
  },
  {
    type: 'route-agent',
    title: 'Route Agent',
    description: 'Delegates agent selection to the existing phase-aware routing chain.',
    theme: 'violet-slate',
    runtimeBinding: 'phase-routing-service',
    defaultTitle: 'Route Specialist',
    defaultDescription: 'Apply the current route cascade and PM assignment overrides.',
    defaultConfig: {
      phase: 'execution',
      selectionMode: 'phase-router',
      preferredAgentId: '',
      preferredRole: '',
      requiredCapabilities: [],
      excludeAgents: [],
    },
    fields: [
      {
        key: 'phase',
        label: 'Swarm Phase',
        input: 'select',
        options: ['planning', 'specialist_input', 'execution', 'testing', 'review', 'delivery'],
        required: true,
      },
      {
        key: 'selectionMode',
        label: 'Selection Mode',
        input: 'select',
        options: ['phase-router', 'prefer-explicit-agent', 'capability-first'],
        required: true,
      },
      {
        key: 'preferredAgentId',
        label: 'Preferred Agent',
        input: 'select',
        optionsSource: 'agents',
        helpText: 'Compatible with the live /api/agents roster. Leave blank to let the existing phase router choose.',
      },
      {
        key: 'preferredRole',
        label: 'Preferred Role',
        input: 'text',
        placeholder: 'code-developer',
      },
      {
        key: 'requiredCapabilities',
        label: 'Required Capabilities',
        input: 'tags',
        placeholder: 'planning, implementation',
        helpText: 'Capability hints stay compatible with the current agent profile capability model.',
      },
      {
        key: 'excludeAgents',
        label: 'Exclude Agents',
        input: 'tags',
        placeholder: 'project-manager, code-reviewer',
      },
    ],
  },
  {
    type: 'ai-decision',
    title: 'AI Decision',
    description: 'Design-time AI gate that lets a chosen agent or capability class decide which branch should continue.',
    theme: 'amethyst',
    runtimeBinding: 'agent-decision-gate',
    defaultTitle: 'AI Decision',
    defaultDescription: 'Use an existing swarm agent to evaluate the context and choose the next branch.',
    defaultConfig: {
      decisionMode: 'agent-eval',
      decisionAgentId: '',
      requiredCapabilities: [],
      rubric: 'Choose the most appropriate branch based on ticket context, acceptance criteria, and current evidence.',
      outcomes: ['approved', 'needs-revision'],
      fallbackOutcome: 'needs-revision',
    },
    fields: [
      {
        key: 'decisionMode',
        label: 'Decision Mode',
        input: 'select',
        options: ['agent-eval', 'capability-router', 'hybrid'],
        required: true,
      },
      {
        key: 'decisionAgentId',
        label: 'Decision Agent',
        input: 'select',
        optionsSource: 'agents',
        helpText: 'Pick a real swarm agent when you want this gate tied to an existing bot persona.',
      },
      {
        key: 'requiredCapabilities',
        label: 'Decision Capabilities',
        input: 'tags',
        placeholder: 'review, testing, architecture',
        helpText: 'Alternative to a fixed agent. Uses the same capability language your agents already expose.',
      },
      {
        key: 'rubric',
        label: 'Decision Rubric',
        input: 'textarea',
        placeholder: 'Explain how the deciding agent should evaluate the next branch.',
      },
      {
        key: 'outcomes',
        label: 'Outcomes',
        input: 'tags',
        placeholder: 'approved, needs-revision',
        helpText: 'The first created edges from this node will inherit these labels in order.',
      },
      {
        key: 'fallbackOutcome',
        label: 'Fallback Outcome',
        input: 'text',
        placeholder: 'needs-revision',
      },
    ],
  },
  {
    type: 'logic-gate',
    title: 'Logic Gate',
    description: 'Branches the workflow with explicit logical operators, rule expressions, or threshold checks.',
    theme: 'signal',
    runtimeBinding: 'logical-decision-gate',
    defaultTitle: 'Logic Gate',
    defaultDescription: 'Apply deterministic rules before selecting the next branch.',
    defaultConfig: {
      operator: 'all',
      operands: ['verification_passed', 'review_complete'],
      expression: '',
      trueLabel: 'true',
      falseLabel: 'false',
    },
    fields: [
      {
        key: 'operator',
        label: 'Operator',
        input: 'select',
        options: ['all', 'any', 'none', 'expression'],
        required: true,
      },
      {
        key: 'operands',
        label: 'Operands',
        input: 'tags',
        placeholder: 'verification_passed, review_complete',
      },
      {
        key: 'expression',
        label: 'Expression',
        input: 'textarea',
        placeholder: 'verification_passed && review_complete',
        helpText: 'Used when operator is expression.',
      },
      {
        key: 'trueLabel',
        label: 'True Branch Label',
        input: 'text',
        placeholder: 'true',
      },
      {
        key: 'falseLabel',
        label: 'False Branch Label',
        input: 'text',
        placeholder: 'false',
      },
    ],
  },
  {
    type: 'execute-agent',
    title: 'Execute Agent',
    description: 'Documents a runtime dispatch step while still using the existing swarm worker pipeline.',
    theme: 'ember',
    runtimeBinding: 'swarm-agent-worker',
    defaultTitle: 'Execute Work',
    defaultDescription: 'Dispatch work through the current worker and lifecycle services.',
    defaultConfig: {
      agentBinding: 'routed-agent',
      agentId: '',
      requiredCapabilities: [],
      workType: 'implementation',
      expectedArtifact: 'code-and-tests',
    },
    fields: [
      {
        key: 'agentBinding',
        label: 'Agent Binding',
        input: 'select',
        options: ['routed-agent', 'fixed-agent', 'capability-target'],
        required: true,
      },
      {
        key: 'agentId',
        label: 'Fixed Agent',
        input: 'select',
        optionsSource: 'agents',
        helpText: 'Compatible with the live agent roster. Optional unless binding is fixed-agent.',
      },
      {
        key: 'requiredCapabilities',
        label: 'Execution Capabilities',
        input: 'tags',
        placeholder: 'implementation, backend',
      },
      {
        key: 'workType',
        label: 'Work Type',
        input: 'select',
        options: ['implementation', 'testing', 'documentation', 'review', 'analysis', 'integration'],
        required: true,
      },
      {
        key: 'expectedArtifact',
        label: 'Expected Artifact',
        input: 'text',
        placeholder: 'code-and-tests',
      },
    ],
  },
  {
    type: 'parallel-split',
    title: 'Parallel Split',
    description: 'Fan work out to multiple parallel branches while preserving the current swarm runtime as the executor.',
    theme: 'mint',
    runtimeBinding: 'parallel-dispatch-annotation',
    defaultTitle: 'Parallel Split',
    defaultDescription: 'Fan the workflow out into multiple parallel paths.',
    defaultConfig: {
      splitMode: 'fan-out',
      expectedBranches: 2,
      branchLabels: ['branch-1', 'branch-2'],
    },
    fields: [
      {
        key: 'splitMode',
        label: 'Split Mode',
        input: 'select',
        options: ['fan-out', 'parallel-specialists', 'parallel-verification'],
        required: true,
      },
      {
        key: 'expectedBranches',
        label: 'Expected Branches',
        input: 'number',
        helpText: 'Validation will warn if the outgoing branch count does not match this target.',
      },
      {
        key: 'branchLabels',
        label: 'Branch Labels',
        input: 'tags',
        placeholder: 'frontend, backend',
        helpText: 'New edges from this node inherit these labels in order.',
      },
    ],
  },
  {
    type: 'approval-gate',
    title: 'Approval Gate',
    description: 'Visual marker for the human build gate already enforced by the existing ticket lifecycle.',
    theme: 'honey',
    runtimeBinding: 'ticket-cycle-state-machine',
    defaultTitle: 'Await Build Approval',
    defaultDescription: 'Pause at the existing approval_required state before execution continues.',
    defaultConfig: {
      gateState: 'approval_required',
      approverRole: 'operator',
    },
    fields: [
      {
        key: 'gateState',
        label: 'Gate State',
        input: 'select',
        options: ['approval_required', 'customer_action'],
        required: true,
      },
      {
        key: 'approverRole',
        label: 'Approver Role',
        input: 'text',
        placeholder: 'operator',
      },
    ],
  },
  {
    type: 'verify-output',
    title: 'Verify Output',
    description: 'Runs the current verification policy and retry-aware evidence checks.',
    theme: 'forest',
    runtimeBinding: 'swarm-verification-service',
    defaultTitle: 'Verify Deliverable',
    defaultDescription: 'Apply the current verification policy without inventing a second verifier.',
    defaultConfig: {
      evidenceClass: 'implementation',
      maxAttempts: 2,
    },
    fields: [
      {
        key: 'evidenceClass',
        label: 'Evidence Class',
        input: 'select',
        options: ['implementation', 'testing', 'documentation', 'review', 'integration', 'analysis'],
        required: true,
      },
      {
        key: 'maxAttempts',
        label: 'Max Attempts',
        input: 'number',
        helpText: 'Design-time hint only. Runtime retry policy remains controlled by the existing swarm policy.',
      },
    ],
  },
  {
    type: 'review',
    title: 'Review',
    description: 'Maps to the current review and consensus path for medium and high-complexity work.',
    theme: 'glacier',
    runtimeBinding: 'consensus-review-service',
    defaultTitle: 'Review Outcome',
    defaultDescription: 'Use the current reviewer path and evidence-gap normalization.',
    defaultConfig: {
      reviewerRole: 'code-reviewer',
      consensusMode: 'single-reviewer',
    },
    fields: [
      {
        key: 'reviewerRole',
        label: 'Reviewer Role',
        input: 'text',
        placeholder: 'code-reviewer',
      },
      {
        key: 'consensusMode',
        label: 'Consensus Mode',
        input: 'select',
        options: ['single-reviewer', 'consensus-review'],
      },
    ],
  },
  {
    type: 'deliver',
    title: 'Deliver',
    description: 'Represents the final handoff and writeback stage in the current swarm lifecycle.',
    theme: 'aurora',
    runtimeBinding: 'swarm-writeback-handler',
    defaultTitle: 'Deliver Result',
    defaultDescription: 'Finalize lifecycle state and publish the outcome through the existing writeback path.',
    defaultConfig: {
      deliveryMode: 'ticket-writeback',
    },
    fields: [
      {
        key: 'deliveryMode',
        label: 'Delivery Mode',
        input: 'select',
        options: ['ticket-writeback', 'workspace-handoff', 'customer-action'],
        required: true,
      },
    ],
  },
  {
    type: 'escalate',
    title: 'Escalate',
    description: 'Documents an escalation branch while still relying on the existing escalation store and policy.',
    theme: 'rose',
    runtimeBinding: 'swarm-escalation-store',
    defaultTitle: 'Escalate',
    defaultDescription: 'Route the workflow to the current escalation surface.',
    defaultConfig: {
      target: 'human_review',
      severity: 'high',
    },
    fields: [
      {
        key: 'target',
        label: 'Escalation Target',
        input: 'select',
        options: ['human_review', 'team_lead', 'ops_channel'],
        required: true,
      },
      {
        key: 'severity',
        label: 'Severity',
        input: 'select',
        options: ['low', 'medium', 'high', 'critical'],
        required: true,
      },
    ],
  },
  {
    type: 'parallel-join',
    title: 'Parallel Join',
    description: 'Design-time join marker for multiple branches before returning to a shared swarm phase.',
    theme: 'graphite',
    runtimeBinding: 'workflow-join-barrier',
    defaultTitle: 'Join Branches',
    defaultDescription: 'Wait for upstream branches to converge before continuing.',
    defaultConfig: {
      joinMode: 'all-upstream',
    },
    fields: [
      {
        key: 'joinMode',
        label: 'Join Mode',
        input: 'select',
        options: ['all-upstream', 'first-success'],
        required: true,
      },
    ],
  },
]);

const WorkflowPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});
/**
 * @description Type of a canvas coordinate pair for a node, inferred from the internal position schema.
 */
export type WorkflowPosition = z.infer<typeof WorkflowPositionSchema>;

/**
 * @description Zod schema for a node instance placed on the studio canvas, capturing its id, type, title, description, position, and free-form config.
 */
export const WorkflowStudioNodeSchema = z.object({
  id: z.string().min(1),
  type: WorkflowNodeTypeSchema,
  title: z.string().min(1),
  description: z.string().default(''),
  position: WorkflowPositionSchema,
  config: z.record(z.string(), z.unknown()).default({}),
});
/**
 * @description Type of a placed canvas node instance, inferred from the studio-node schema.
 */
export type WorkflowStudioNode = z.infer<typeof WorkflowStudioNodeSchema>;

/**
 * @description Zod schema for a directed connection between two nodes, with an optional branch label and condition expression.
 */
export const WorkflowStudioEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  label: z.string().optional(),
  condition: z.string().optional(),
});
/**
 * @description Type of a directed edge between nodes, inferred from the studio-edge schema.
 */
export type WorkflowStudioEdge = z.infer<typeof WorkflowStudioEdgeSchema>;

/**
 * @description Zod schema for a complete, persistable workflow definition including identity, versioning, timestamps, nodes, edges, and metadata.
 */
export const WorkflowDefinitionSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(160),
  slug: z.string().min(1).max(180),
  description: z.string().max(4000).default(''),
  runtimeTarget: z.literal('swarm-design-layer').default('swarm-design-layer'),
  version: z.number().int().positive().default(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  nodes: z.array(WorkflowStudioNodeSchema).min(1),
  edges: z.array(WorkflowStudioEdgeSchema).default([]),
  metadata: z.object({
    notes: z.string().max(4000).optional(),
    seed: z.boolean().optional(),
    tags: z.array(z.string()).default([]),
  }).default({ tags: [] }),
});
/**
 * @description Type of a full workflow definition, inferred from the definition schema.
 */
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

/**
 * @description Lightweight projection of a workflow definition for list views, exposing identity, version, last update, and node/edge counts without the full graph.
 */
export interface WorkflowDefinitionSummary {
  id: string;
  name: string;
  description: string;
  version: number;
  updatedAt: string;
  nodeCount: number;
  edgeCount: number;
}

/**
 * @description Summary of one historical version of a definition, keyed by definition id and version for version-history listings.
 */
export interface WorkflowDefinitionVersionSummary {
  definitionId: string;
  name: string;
  version: number;
  updatedAt: string;
  nodeCount: number;
  edgeCount: number;
}

/**
 * @description Catalog payload served to the studio client, bundling the node catalog with the design-time integration mode, non-interference rules, and runtime bindings.
 */
export interface WorkflowStudioCatalog {
  integrationMode: 'design_time_only';
  nodeCatalog: WorkflowNodeCatalogEntry[];
  nonInterferenceRules: string[];
  runtimeBindings: string[];
}

/**
 * @description A single validation finding for a definition, carrying its severity level, machine code, human message, and optionally the offending entity id.
 */
export interface WorkflowValidationIssue {
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  entityId?: string;
}

/**
 * @description Aggregate validation result for a definition, reporting overall validity, node/edge counts, and the collected list of issues.
 */
export interface WorkflowValidationReport {
  valid: boolean;
  definitionId: string;
  edgeCount: number;
  nodeCount: number;
  issues: WorkflowValidationIssue[];
}

/**
 * @description Compile-preview description of how one node maps to the runtime, including its binding, downstream targets, config summary, and compiler notes.
 */
export interface WorkflowCompileStepBinding {
  nodeId: string;
  title: string;
  nodeType: WorkflowNodeType;
  runtimeBinding: string;
  downstreamNodes: string[];
  configSummary: string[];
  compilerNotes: string[];
}

/**
 * @description Full compile-preview result for a definition, summarizing entrypoint, integration mode, per-node step bindings, readiness status, and validation report.
 */
export interface WorkflowCompilePreview {
  definitionId: string;
  definitionName: string;
  entrypointNodeId?: string;
  integrationMode: 'design_time_only';
  nonInterferenceRules: string[];
  runtimeBindings: string[];
  status: 'ready' | 'attention';
  stepBindings: WorkflowCompileStepBinding[];
  validation: WorkflowValidationReport;
}

/**
 * @description Optional inputs accepted when creating a new workflow definition, allowing a caller-supplied name and description.
 */
export interface CreateWorkflowDefinitionInput {
  description?: string;
  name?: string;
}

/**
 * @description Payload for updating an existing workflow definition, carrying the target id plus the new name, nodes, edges, and optional description/metadata.
 */
export interface UpdateWorkflowDefinitionInput {
  description?: string;
  edges: WorkflowStudioEdge[];
  id: string;
  metadata?: WorkflowDefinition['metadata'];
  name: string;
  nodes: WorkflowStudioNode[];
}

/**
 * @description Human-readable guardrail statements declaring that the studio only authors/validates designs and never overrides the live swarm routing, execution, approval, or writeback runtime.
 */
export const NON_INTERFERENCE_RULES = [
  'Design-time definitions do not replace swarm routing, execution, handover, verification, or writeback services.',
  'Approval gates remain bound to the current ticket lifecycle and approval_required/customer_action states.',
  'Agent selection remains delegated to the existing PhaseRoutingService and PM assignment rules.',
  'The workflow studio is responsible for authoring, validation, and compile previews, not runtime orchestration ownership.',
  'AI decision gates and logical gates describe branch intent while staying compatible with the current agent roster and swarm decision surfaces.',
];

/**
 * @description Looks up the catalog entry for a node type so callers can access its defaults and field schema, failing fast if the type is unknown.
 * @param type - The workflow node type to resolve.
 * @returns The matching catalog entry for the requested node type.
 */
export function getWorkflowNodeCatalogEntry(type: WorkflowNodeType): WorkflowNodeCatalogEntry {
  const entry = WORKFLOW_NODE_CATALOG.find((candidate) => candidate.type === type);
  if (!entry) {
    throw new Error(`Workflow node catalog entry not found: ${type}`);
  }
  return entry;
}

/**
 * @description Assembles the catalog payload for the studio client, attaching the design-time integration mode, non-interference rules, and the deduplicated set of runtime bindings.
 * @returns The fully populated workflow studio catalog.
 */
export function buildWorkflowStudioCatalog(): WorkflowStudioCatalog {
  return {
    integrationMode: 'design_time_only',
    nodeCatalog: WORKFLOW_NODE_CATALOG,
    nonInterferenceRules: NON_INTERFERENCE_RULES,
    runtimeBindings: Array.from(new Set(WORKFLOW_NODE_CATALOG.map((entry) => entry.runtimeBinding))),
  };
}

/**
 * @description Creates a fresh canvas node of the given type at a position, seeding it with the catalog's default title/description and a deep-cloned copy of its default config so instances do not share state.
 * @param type - The node type to instantiate from the catalog.
 * @param position - The canvas coordinates to place the new node at.
 * @returns A new studio node instance with a generated id and cloned defaults.
 */
export function createWorkflowNode(type: WorkflowNodeType, position: WorkflowPosition): WorkflowStudioNode {
  const entry = getWorkflowNodeCatalogEntry(type);
  return {
    id: randomUUID(),
    type,
    title: entry.defaultTitle,
    description: entry.defaultDescription,
    position,
    config: JSON.parse(JSON.stringify(entry.defaultConfig)) as Record<string, unknown>,
  };
}

/**
 * @description Converts a workflow name into a URL-safe slug by lowercasing, collapsing non-alphanumeric runs into hyphens, and trimming edge hyphens, falling back to a default slug when the result would be empty.
 * @param value - The raw workflow name to slugify.
 * @returns A non-empty, lowercase, hyphen-delimited slug.
 */
export function slugifyWorkflowName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized : 'workflow-studio-draft';
}

/**
 * @description Projects a full workflow definition down to its list-view summary, deriving node and edge counts from the definition's arrays.
 * @param definition - The full workflow definition to summarize.
 * @returns A summary view containing identity, version, timestamp, and node/edge counts.
 */
export function buildWorkflowDefinitionSummary(definition: WorkflowDefinition): WorkflowDefinitionSummary {
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    version: definition.version,
    updatedAt: definition.updatedAt,
    nodeCount: definition.nodes.length,
    edgeCount: definition.edges.length,
  };
}

/**
 * @description Builds a seeded, schema-validated default workflow definition that visualizes the existing OSHAL swarm path (intake, planning, approval, routing, parallel execute/verify/review, join, deliver, escalate), wiring up the standard nodes, edges, and per-node config overrides.
 * @param input - Optional name and description overrides for the seeded definition.
 * @returns A parsed, valid workflow definition representing the default swarm blueprint.
 */
export function buildSeedWorkflowDefinition(input: CreateWorkflowDefinitionInput = {}): WorkflowDefinition {
  const id = randomUUID();
  const now = new Date().toISOString();
  const name = input.name?.trim() || 'Swarm Default Workflow';
  const definition: WorkflowDefinition = {
    id,
    name,
    slug: slugifyWorkflowName(name),
    description: input.description?.trim()
      || 'Design-time blueprint for the existing OSHAL swarm path. This definition documents the current routing and approval lifecycle without replacing runtime execution.',
    runtimeTarget: 'swarm-design-layer',
    version: 1,
    createdAt: now,
    updatedAt: now,
    metadata: {
      notes: 'Seeded from workflow-studio to visualize the current swarm orchestration contract.',
      seed: true,
      tags: ['workflow-studio', 'swarm'],
    },
    nodes: [
      createWorkflowNode('start', { x: 70, y: 110 }),
      createWorkflowNode('intake-source', { x: 280, y: 110 }),
      createWorkflowNode('planner', { x: 520, y: 110 }),
      createWorkflowNode('approval-gate', { x: 760, y: 110 }),
      createWorkflowNode('route-agent', { x: 1000, y: 110 }),
      createWorkflowNode('parallel-split', { x: 1230, y: 110 }),
      createWorkflowNode('execute-agent', { x: 1480, y: 40 }),
      createWorkflowNode('verify-output', { x: 1480, y: 230 }),
      createWorkflowNode('review', { x: 1480, y: 420 }),
      createWorkflowNode('parallel-join', { x: 1730, y: 210 }),
      createWorkflowNode('deliver', { x: 1960, y: 110 }),
      createWorkflowNode('escalate', { x: 1730, y: 520 }),
    ],
    edges: [],
  };

  const nodeByType = new Map<WorkflowNodeType, WorkflowStudioNode>(
    definition.nodes.map((node) => [node.type, node]),
  );

  definition.edges = [
    createEdge(nodeByType, 'start', 'intake-source'),
    createEdge(nodeByType, 'intake-source', 'planner'),
    createEdge(nodeByType, 'planner', 'approval-gate', 'build gate'),
    createEdge(nodeByType, 'approval-gate', 'route-agent', 'approved'),
    createEdge(nodeByType, 'route-agent', 'parallel-split'),
    createEdge(nodeByType, 'parallel-split', 'execute-agent', 'implementation'),
    createEdge(nodeByType, 'parallel-split', 'verify-output', 'verification'),
    createEdge(nodeByType, 'parallel-split', 'review', 'review'),
    createEdge(nodeByType, 'verify-output', 'parallel-join'),
    createEdge(nodeByType, 'review', 'parallel-join'),
    createEdge(nodeByType, 'execute-agent', 'parallel-join'),
    createEdge(nodeByType, 'parallel-join', 'deliver', 'ready'),
    createEdge(nodeByType, 'verify-output', 'escalate', 'evidence gap'),
  ];

  const plannerNode = nodeByType.get('planner');
  const approvalNode = nodeByType.get('approval-gate');
  const routeNode = nodeByType.get('route-agent');
  const splitNode = nodeByType.get('parallel-split');
  const executeNode = nodeByType.get('execute-agent');
  const verifyNode = nodeByType.get('verify-output');
  const reviewNode = nodeByType.get('review');
  const deliverNode = nodeByType.get('deliver');
  const escalateNode = nodeByType.get('escalate');

  if (plannerNode) {
    plannerNode.config.stopAfterPlanning = true;
  }
  if (approvalNode) {
    approvalNode.config.gateState = 'approval_required';
  }
  if (routeNode) {
    routeNode.config.phase = 'execution';
  }
  if (executeNode) {
    executeNode.config.workType = 'implementation';
  }
  if (splitNode) {
    splitNode.config.expectedBranches = 3;
    splitNode.config.branchLabels = ['implementation', 'verification', 'review'];
  }
  if (verifyNode) {
    verifyNode.config.evidenceClass = 'implementation';
  }
  if (reviewNode) {
    reviewNode.config.consensusMode = 'single-reviewer';
  }
  if (deliverNode) {
    deliverNode.config.deliveryMode = 'ticket-writeback';
  }
  if (escalateNode) {
    escalateNode.config.target = 'human_review';
    escalateNode.config.severity = 'high';
  }

  return WorkflowDefinitionSchema.parse(definition);
}

function createEdge(
  nodeByType: Map<WorkflowNodeType, WorkflowStudioNode>,
  sourceType: WorkflowNodeType,
  targetType: WorkflowNodeType,
  label?: string,
): WorkflowStudioEdge {
  const source = nodeByType.get(sourceType);
  const target = nodeByType.get(targetType);
  if (!source || !target) {
    throw new Error(`Cannot create seed edge from ${sourceType} to ${targetType}`);
  }

  return {
    id: randomUUID(),
    source: source.id,
    target: target.id,
    label,
  };
}

/** A starter workflow the gallery offers — a curated node/edge graph over the standard node types. */
export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  nodes: Array<{ type: WorkflowNodeType; position: WorkflowPosition }>;
  edges: Array<{ source: WorkflowNodeType; target: WorkflowNodeType; label?: string }>;
}

/** Built-in workflow templates. Each builds a schema-valid design-time definition. */
export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'approval-gated-task',
    name: 'Approval-gated task',
    description: 'Intake, plan, HUMAN approval, route, execute, verify, deliver — with an escalation path on missing evidence. The safe default for any risky action.',
    nodes: [
      { type: 'start', position: { x: 70, y: 110 } },
      { type: 'intake-source', position: { x: 300, y: 110 } },
      { type: 'planner', position: { x: 530, y: 110 } },
      { type: 'approval-gate', position: { x: 760, y: 110 } },
      { type: 'route-agent', position: { x: 990, y: 110 } },
      { type: 'execute-agent', position: { x: 1220, y: 110 } },
      { type: 'verify-output', position: { x: 1450, y: 110 } },
      { type: 'deliver', position: { x: 1680, y: 110 } },
      { type: 'escalate', position: { x: 1450, y: 300 } },
    ],
    edges: [
      { source: 'start', target: 'intake-source' },
      { source: 'intake-source', target: 'planner' },
      { source: 'planner', target: 'approval-gate', label: 'build gate' },
      { source: 'approval-gate', target: 'route-agent', label: 'approved' },
      { source: 'route-agent', target: 'execute-agent' },
      { source: 'execute-agent', target: 'verify-output' },
      { source: 'verify-output', target: 'deliver', label: 'verified' },
      { source: 'verify-output', target: 'escalate', label: 'evidence gap' },
    ],
  },
  {
    id: 'research-draft-review',
    name: 'Research, draft & review',
    description: 'Intake a request, plan, route to a specialist, draft, then a review step before delivery. Good for content, reports, and analysis.',
    nodes: [
      { type: 'start', position: { x: 70, y: 110 } },
      { type: 'intake-source', position: { x: 300, y: 110 } },
      { type: 'planner', position: { x: 530, y: 110 } },
      { type: 'route-agent', position: { x: 760, y: 110 } },
      { type: 'execute-agent', position: { x: 990, y: 110 } },
      { type: 'review', position: { x: 1220, y: 110 } },
      { type: 'deliver', position: { x: 1450, y: 110 } },
    ],
    edges: [
      { source: 'start', target: 'intake-source' },
      { source: 'intake-source', target: 'planner' },
      { source: 'planner', target: 'route-agent' },
      { source: 'route-agent', target: 'execute-agent' },
      { source: 'execute-agent', target: 'review' },
      { source: 'review', target: 'deliver', label: 'signed off' },
    ],
  },
  {
    id: 'simple-intake-act',
    name: 'Simple intake to action',
    description: 'The smallest useful loop: take a request, route it, execute, deliver. Start here and add gates as you need them.',
    nodes: [
      { type: 'start', position: { x: 70, y: 110 } },
      { type: 'intake-source', position: { x: 320, y: 110 } },
      { type: 'route-agent', position: { x: 570, y: 110 } },
      { type: 'execute-agent', position: { x: 820, y: 110 } },
      { type: 'deliver', position: { x: 1070, y: 110 } },
    ],
    edges: [
      { source: 'start', target: 'intake-source' },
      { source: 'intake-source', target: 'route-agent' },
      { source: 'route-agent', target: 'execute-agent' },
      { source: 'execute-agent', target: 'deliver' },
    ],
  },
];

/** Gallery metadata (id/name/description) for the template picker. */
export function listWorkflowTemplates(): Array<Pick<WorkflowTemplate, 'id' | 'name' | 'description'>> {
  return WORKFLOW_TEMPLATES.map((template) => ({ id: template.id, name: template.name, description: template.description }));
}

/**
 * @description Build a fresh, schema-valid workflow definition from a template. Returns null when
 * the template id is unknown. Reuses the same node/edge builders as the seed so templates stay in
 * lockstep with the node catalog.
 */
export function buildTemplateWorkflowDefinition(
  templateId: string,
  input: CreateWorkflowDefinitionInput = {},
): WorkflowDefinition | null {
  const template = WORKFLOW_TEMPLATES.find((candidate) => candidate.id === templateId);
  if (!template) {
    return null;
  }
  const now = new Date().toISOString();
  const name = input.name?.trim() || template.name;
  const nodes = template.nodes.map((node) => createWorkflowNode(node.type, node.position));
  const nodeByType = new Map<WorkflowNodeType, WorkflowStudioNode>(nodes.map((node) => [node.type, node]));
  const edges = template.edges.map((edge) => createEdge(nodeByType, edge.source, edge.target, edge.label));
  const definition: WorkflowDefinition = {
    id: randomUUID(),
    name,
    slug: slugifyWorkflowName(name),
    description: input.description?.trim() || template.description,
    runtimeTarget: 'swarm-design-layer',
    version: 1,
    createdAt: now,
    updatedAt: now,
    metadata: {
      notes: `Created from the "${template.name}" template.`,
      seed: false,
      tags: ['workflow-studio', 'template', template.id],
    },
    nodes,
    edges,
  };
  return WorkflowDefinitionSchema.parse(definition);
}
