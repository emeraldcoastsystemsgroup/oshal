/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial ProcessDefinition schema — executable workflow config artifact compiled from design-time definitions
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared enums (aligned with swarm-orchestration types)
// ---------------------------------------------------------------------------

export const SwarmPhaseSchema = z.enum([
  'intake',
  'planning',
  'specialist_input',
  'execution',
  'testing',
  'review',
  'delivery',
]);
export type ProcessSwarmPhase = z.infer<typeof SwarmPhaseSchema>;

export const TicketComplexitySchema = z.enum(['low', 'medium', 'high']);
export type ProcessTicketComplexity = z.infer<typeof TicketComplexitySchema>;

export const EscalationTargetSchema = z.enum(['human_review', 'team_lead', 'ops_channel']);
export type ProcessEscalationTarget = z.infer<typeof EscalationTargetSchema>;

export const EscalationSeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export type ProcessEscalationSeverity = z.infer<typeof EscalationSeveritySchema>;

// ---------------------------------------------------------------------------
// Config Point 1: Phase Sequence & Gating
// ---------------------------------------------------------------------------

export const ProcessPhaseConfigSchema = z.object({
  phase: SwarmPhaseSchema,
  enabled: z.boolean().default(true),
  complexityThreshold: TicketComplexitySchema.optional(),
  sourceNodeId: z.string().min(1),
});
export type ProcessPhaseConfig = z.infer<typeof ProcessPhaseConfigSchema>;

// ---------------------------------------------------------------------------
// Config Point 2: Round Structure per Phase
// ---------------------------------------------------------------------------

export const ProcessRoundEntrySchema = z.object({
  round: z.number().int().positive(),
  role: z.string().min(1),
  agentBinding: z.enum(['routed-agent', 'fixed-agent', 'capability-target']).default('routed-agent'),
  fixedAgentId: z.string().optional(),
  requiredCapabilities: z.array(z.string()).default([]),
});
export type ProcessRoundEntry = z.infer<typeof ProcessRoundEntrySchema>;

export const ProcessRoundConfigSchema = z.object({
  phase: SwarmPhaseSchema,
  rounds: z.array(ProcessRoundEntrySchema).min(1),
});
export type ProcessRoundConfig = z.infer<typeof ProcessRoundConfigSchema>;

// ---------------------------------------------------------------------------
// Config Point 3: Routing Preferences per Phase
// ---------------------------------------------------------------------------

export const ProcessRoutingPreferenceSchema = z.object({
  phase: SwarmPhaseSchema,
  selectionMode: z.enum(['phase-router', 'prefer-explicit-agent', 'capability-first']).default('phase-router'),
  preferredAgentId: z.string().optional(),
  preferredRole: z.string().optional(),
  requiredCapabilities: z.array(z.string()).default([]),
  excludeAgents: z.array(z.string()).default([]),
});
export type ProcessRoutingPreference = z.infer<typeof ProcessRoutingPreferenceSchema>;

// ---------------------------------------------------------------------------
// Config Point 4: Retry / Regression Policy
// ---------------------------------------------------------------------------

export const ProcessRetryPolicySchema = z.object({
  maxVerificationAttempts: z.number().int().min(1).max(5).default(3),
  maxBuildRegressions: z.number().int().min(0).max(3).default(1),
  maxDesignRegressions: z.number().int().min(0).max(3).default(1),
  maxWritebackAttempts: z.number().int().min(1).max(5).default(2),
  maxTotalCycles: z.number().int().min(5).max(50).default(15),
  maxRunDurationMs: z.number().int().min(10_000).max(1_800_000).default(1_800_000),
  maxPhaseRegressions: z.number().int().min(0).max(10).default(3),
  escalationTarget: EscalationTargetSchema.default('human_review'),
  escalationSeverity: EscalationSeveritySchema.default('high'),
});
export type ProcessRetryPolicy = z.infer<typeof ProcessRetryPolicySchema>;

// ---------------------------------------------------------------------------
// Config Point 5: Handover Requirements per Phase
// ---------------------------------------------------------------------------

export const ProcessHandoverConfigSchema = z.object({
  phase: SwarmPhaseSchema,
  required: z.boolean().default(true),
  strict: z.boolean().default(true),
});
export type ProcessHandoverConfig = z.infer<typeof ProcessHandoverConfigSchema>;

// ---------------------------------------------------------------------------
// Config Point 6: Planning Configuration
// ---------------------------------------------------------------------------

export const ProcessPlanningConfigSchema = z.object({
  planningMode: z.enum(['pm-planning', 'single-work-unit', 'child-direct']).default('pm-planning'),
  stopAfterPlanning: z.boolean().default(true),
  architecturePreRound: z.boolean().default(false),
  architectureAgentId: z.string().optional(),
  pmAgentId: z.string().optional(),
  artifactGates: z.object({
    technicalSpecification: z.boolean().default(true),
    implementationPlan: z.boolean().default(true),
  }).default({}),
});
export type ProcessPlanningConfig = z.infer<typeof ProcessPlanningConfigSchema>;

// ---------------------------------------------------------------------------
// Config Point 7: Edge Conditions (branching logic)
// ---------------------------------------------------------------------------

export const ProcessEdgeConditionSchema = z.object({
  sourceNodeId: z.string().min(1),
  targetNodeId: z.string().min(1),
  edgeId: z.string().min(1),
  condition: z.object({
    type: z.enum(['logic-gate', 'ai-decision', 'always']),
    operator: z.enum(['all', 'any', 'none', 'expression']).optional(),
    operands: z.array(z.string()).optional(),
    expression: z.string().optional(),
    outcomes: z.array(z.string()).optional(),
    fallbackOutcome: z.string().optional(),
  }),
});
export type ProcessEdgeCondition = z.infer<typeof ProcessEdgeConditionSchema>;

// ---------------------------------------------------------------------------
// n8n-inspired: Per-Node Retry Configuration
// ---------------------------------------------------------------------------

export const NodeRetryConfigSchema = z.object({
  retryOnFail: z.boolean().default(false),
  maxTries: z.number().int().min(1).max(5).default(3),
  waitBetweenTriesMs: z.number().int().min(0).max(30_000).default(0),
  backoffMode: z.enum(['linear', 'exponential']).default('linear'),
});
export type NodeRetryConfig = z.infer<typeof NodeRetryConfigSchema>;

// ---------------------------------------------------------------------------
// n8n-inspired: Error Output Branch Routing
// ---------------------------------------------------------------------------

export const ProcessErrorBranchSchema = z.object({
  sourceNodeId: z.string().min(1),
  errorTargetNodeId: z.string().min(1),
  condition: z.enum(['any-error', 'timeout', 'agent-failure', 'verification-failure']).default('any-error'),
});
export type ProcessErrorBranch = z.infer<typeof ProcessErrorBranchSchema>;

// ---------------------------------------------------------------------------
// Pipedream-inspired: Structured Step Output Bindings
// ---------------------------------------------------------------------------

export const ProcessStepOutputSchema = z.object({
  nodeId: z.string().min(1),
  outputKey: z.string().min(1),
  schema: z.enum(['text', 'json', 'artifact-path', 'boolean']).default('text'),
  description: z.string().default(''),
});
export type ProcessStepOutput = z.infer<typeof ProcessStepOutputSchema>;

// ---------------------------------------------------------------------------
// Executable Node Graph (embedded in ProcessDefinition for engine traversal)
// ---------------------------------------------------------------------------

export const ExecutableNodeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  title: z.string(),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type ExecutableNode = z.infer<typeof ExecutableNodeSchema>;

export const ExecutableEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  label: z.string().optional(),
  condition: z.string().optional(),
});
export type ExecutableEdge = z.infer<typeof ExecutableEdgeSchema>;

export const ExecutableNodeGraphSchema = z.object({
  nodes: z.array(ExecutableNodeSchema),
  edges: z.array(ExecutableEdgeSchema),
  topologicalOrder: z.array(z.string()),
});
export type ExecutableNodeGraph = z.infer<typeof ExecutableNodeGraphSchema>;

// ---------------------------------------------------------------------------
// Top-Level ProcessDefinition
// ---------------------------------------------------------------------------

export const ProcessDefinitionStatusSchema = z.enum(['draft', 'active', 'inactive']);
export type ProcessDefinitionStatus = z.infer<typeof ProcessDefinitionStatusSchema>;

export const ProcessDefinitionSchema = z.object({
  id: z.string().uuid(),
  definitionId: z.string().uuid(),
  definitionVersion: z.number().int().positive(),
  schemaVersion: z.literal(1).default(1),
  name: z.string().min(1).max(160),
  compiledAt: z.string().datetime(),
  status: ProcessDefinitionStatusSchema.default('draft'),

  // Core process config
  phaseSequence: z.array(ProcessPhaseConfigSchema).min(1),
  roundStructure: z.record(SwarmPhaseSchema, ProcessRoundConfigSchema).default({}),
  routingPreferences: z.record(SwarmPhaseSchema, ProcessRoutingPreferenceSchema).default({}),
  retryPolicy: ProcessRetryPolicySchema.default({}),
  handoverRequirements: z.record(SwarmPhaseSchema, ProcessHandoverConfigSchema).default({}),
  planningConfig: ProcessPlanningConfigSchema.default({}),
  edgeConditions: z.array(ProcessEdgeConditionSchema).default([]),

  // n8n-inspired
  nodeRetryConfig: z.record(z.string(), NodeRetryConfigSchema).default({}),
  errorBranches: z.array(ProcessErrorBranchSchema).default([]),

  // Pipedream-inspired
  stepOutputBindings: z.array(ProcessStepOutputSchema).default([]),

  // Executable node graph for engine traversal
  nodeGraph: ExecutableNodeGraphSchema.optional(),
});
export type ProcessDefinition = z.infer<typeof ProcessDefinitionSchema>;

// ---------------------------------------------------------------------------
// Compile Result wrapper
// ---------------------------------------------------------------------------

export interface ProcessDefinitionCompileResult {
  processDefinition: ProcessDefinition;
  preview: import('./workflow-studio-schemas').WorkflowCompilePreview;
  executable: boolean;
  executionWarnings: string[];
}

// ---------------------------------------------------------------------------
// Activation record for audit trail
// ---------------------------------------------------------------------------

export const ActivationRecordSchema = z.object({
  definitionId: z.string().uuid(),
  processDefinitionId: z.string().uuid(),
  action: z.enum(['activate', 'deactivate']),
  timestamp: z.string().datetime(),
  definitionVersion: z.number().int().positive(),
  definitionName: z.string(),
});
export type ActivationRecord = z.infer<typeof ActivationRecordSchema>;
