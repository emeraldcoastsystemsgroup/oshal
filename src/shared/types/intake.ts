/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added intake-provider and normalized external work-item contracts
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added subticket inclusion control to intake pull requests for root-only default ticket views
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Extended IntakeProviderSchema to support 'github' as second provider (M5)
 */

import { z } from 'zod';

/**
 * @description Supported intake providers for external work streams.
 */
export const IntakeProviderSchema = z.enum(['plane', 'github', 'direct']);

/**
 * @description Provider key used by intake adapters.
 */
export type IntakeProvider = z.infer<typeof IntakeProviderSchema>;

/**
 * @description Canonical outcome type requested through the intake front door.
 */
export const IntakeOutcomeTypeSchema = z.enum([
  'question-answer',
  'small-change',
  'proof-of-concept',
  'product-delivery',
  'integration',
  'investigation',
]);

/**
 * @description Requested delivery effort level for the work.
 */
export const IntakeEffortTierSchema = z.enum([
  'quick',
  'low-fidelity',
  'standard',
  'professional',
]);

/**
 * @description Recommended execution path selected by the L1 processor.
 */
export const IntakeRecommendedPathSchema = z.enum([
  'instant-answer',
  'direct-execution',
  'structured-project',
]);

/**
 * @description Planning structure the request should travel through.
 */
export const IntakePlanningModeSchema = z.enum([
  'none',
  'lightweight',
  'structured',
]);

/**
 * @description How planning work enters the PM phase.
 * - `discovery` means PM creates the plan from scratch or from architecture inputs.
 * - `validate-existing` means a user-supplied plan/package already exists and PM should tighten it.
 */
export const IntakePlanningEntryModeSchema = z.enum([
  'discovery',
  'validate-existing',
]);

/**
 * @description Status of the supplied or in-flight planning package.
 */
export const IntakePlanStatusSchema = z.enum([
  'missing',
  'supplied',
  'approved',
  'gap-fill-required',
]);

/**
 * @description Default team shape for the request.
 */
export const IntakeTeamShapeSchema = z.enum([
  'single-agent',
  'specialist-pair',
  'project-swarm',
]);

/**
 * @description Setup level expected before execution begins.
 */
export const IntakeSetupLevelSchema = z.enum([
  'none',
  'basic',
  'professional',
]);

/**
 * @description Canonical outcome type requested through the intake front door.
 */
export type IntakeOutcomeType = z.infer<typeof IntakeOutcomeTypeSchema>;
/**
 * @description Requested delivery effort level for the work.
 */
export type IntakeEffortTier = z.infer<typeof IntakeEffortTierSchema>;
/**
 * @description Recommended execution path selected by the L1 processor.
 */
export type IntakeRecommendedPath = z.infer<typeof IntakeRecommendedPathSchema>;
/**
 * @description Planning structure the request should travel through.
 */
export type IntakePlanningMode = z.infer<typeof IntakePlanningModeSchema>;
/**
 * @description How planning work enters the PM phase (discovery vs. validate-existing).
 */
export type IntakePlanningEntryMode = z.infer<typeof IntakePlanningEntryModeSchema>;
/**
 * @description Status of the supplied or in-flight planning package.
 */
export type IntakePlanStatus = z.infer<typeof IntakePlanStatusSchema>;
/**
 * @description Default team shape for the request.
 */
export type IntakeTeamShape = z.infer<typeof IntakeTeamShapeSchema>;
/**
 * @description Setup level expected before execution begins.
 */
export type IntakeSetupLevel = z.infer<typeof IntakeSetupLevelSchema>;

/**
 * @description Blueprint for a planning/setup artifact the shaping layer expects.
 * Gives downstream bots explicit guidance instead of a bare filename list.
 */
export const IntakeArtifactBlueprintSchema = z.object({
  artifactId: z.string().min(1),
  displayName: z.string().min(1),
  purpose: z.string().min(1),
  ownerRole: z.string().min(1),
  governingStandards: z.array(z.string().min(1)).min(1),
  minimumContents: z.array(z.string().min(1)).min(1),
  exampleOutline: z.array(z.string().min(1)).min(1),
});

/**
 * @description Artifact blueprint type.
 */
export type IntakeArtifactBlueprint = z.infer<typeof IntakeArtifactBlueprintSchema>;

/**
 * @description Normalized actor shape for external work items.
 */
export const ExternalWorkActorSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  email: z.string().optional(),
});

/**
 * @description Normalized timestamp metadata for external work items.
 */
export const ExternalWorkTimestampsSchema = z.object({
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

/**
 * @description Provider-agnostic work-item contract consumed by routing/orchestration.
 */
export const ExternalWorkItemSchema = z.object({
  provider: IntakeProviderSchema,
  externalId: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional().default(''),
  labels: z.array(z.string()).optional().default([]),
  priority: z.string().optional(),
  status: z.string().optional(),
  actor: ExternalWorkActorSchema.optional(),
  timestamps: ExternalWorkTimestampsSchema.optional(),
  rawPayload: z.unknown(),
});

/**
 * @description Normalized external work item.
 */
export type ExternalWorkItem = z.infer<typeof ExternalWorkItemSchema>;

/**
 * @description Request payload used to pull work items from an intake provider.
 */
export const IntakePullRequestSchema = z.object({
  limit: z.number().int().positive().max(200).optional().default(50),
  cursor: z.string().optional(),
  since: z.string().optional(),
  includeSubtickets: z.boolean().optional().default(false),
});

/**
 * @description Pull request payload.
 */
export type IntakePullRequest = z.infer<typeof IntakePullRequestSchema>;

/**
 * @description Persisted intake checkpoint per provider.
 */
export const IntakeCheckpointSchema = z.object({
  provider: IntakeProviderSchema,
  cursor: z.string(),
  lastSeenAt: z.string(),
});

/**
 * @description Intake checkpoint record.
 */
export type IntakeCheckpoint = z.infer<typeof IntakeCheckpointSchema>;
