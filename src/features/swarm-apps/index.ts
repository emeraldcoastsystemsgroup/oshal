/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Barrel — swarm-apps feature
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export the ManifestRouteMounter port (ADR-085 P1).
 */

export type {
  SwarmAppManifest,
  SwarmAppScope,
  SwarmAppSuite,
  SwarmAppBotDeclaration,
  SwarmAppStaticUi,
  SwarmAppDynamicUi,
  SwarmAppRouteDeclaration,
  SwarmAppWorkflow,
  SwarmAppWorkflowStage,
  SwarmAppRibbonPolicy,
  SwarmAppAssistant,
  SwarmApplicationRecord,
  SwarmApplicationSummary,
  SwarmAppScheduleDeclaration,
  ManifestScheduleRegistrar,
  ManifestScheduleDeregistrar,
  ManifestRouteMounter,
  ManifestBotRegistrar,
  RagCollectionTeardown,
} from './types';

// ADR-097 — the closed suite set + guard (apps declare ONE primary catalog shelf).
export { SWARM_APP_SUITES, isSwarmAppSuite } from './types';
// NOTE: the ADR-090 skill-profile primitives are NOT re-exported here — `@/shared/skill-profiles`
// is their canonical barrel and every consumer (loader validation, dispatch resolution, the email
// interactive path) imports from it directly. Re-exporting shared symbols through a feature barrel
// would invite cross-feature imports via the wrong layer (FSD).

export {
  SwarmAppService,
  SwarmAppRepository,
  readManifest,
  listManifestFiles,
  serializeManifest,
  compileWorkflowSpec,
  // ADR-085 D11 — tool ownership, derived from the active manifests at query time.
  providedToolNames,
  dependedToolNames,
  computeToolDependents,
  otherProvidersOf,
  assertToolNamesUnique,
  assertToolDependenciesResolvable,
} from './services';
export type { WorkflowPublishSpec, WorkflowPublishStageInput, WorkflowPublishBotInput } from './services';
export type { ToolDependent } from './services';
