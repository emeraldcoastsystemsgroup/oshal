/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Barrel — swarm-apps feature
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export the ManifestRouteMounter port (ADR-085 P1).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Export ADR-118 app access declarations, assignments, resolution, and the fixed tier vocabulary.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Export CORE-05 manifest smoke declarations and verifier contracts.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Export the APP-02 fail-closed package-audit mode resolver.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Export the manifest Takeout slice declaration and lifecycle registrar port.
 */

export type {
  SwarmAppManifest,
  AppAccessTier,
  SwarmAppAccessDeclaration,
  SwarmAppScope,
  SwarmAppSuite,
  SwarmAppBotDeclaration,
  SwarmAppStaticUi,
  SwarmAppDynamicUi,
  SwarmAppRouteDeclaration,
  SwarmAppTakeoutSliceDeclaration,
  SwarmAppSmokeAuthMode,
  SwarmAppSmokeDeclaration,
  SwarmAppSmokeExpectation,
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
  ManifestTakeoutRegistrar,
  RagCollectionTeardown,
} from './types';

// ADR-097 — the closed suite set + guard (apps declare ONE primary catalog shelf).
export { SWARM_APP_SUITES, isSwarmAppSuite } from './types';
export { APP_ACCESS_TIERS, isAppAccessTier } from './types';
// NOTE: the ADR-090 skill-profile primitives are NOT re-exported here — `@/shared/skill-profiles`
// is their canonical barrel and every consumer (loader validation, dispatch resolution, the email
// interactive path) imports from it directly. Re-exporting shared symbols through a feature barrel
// would invite cross-feature imports via the wrong layer (FSD).

export {
  SwarmAppService,
  SwarmAppRepository,
  AppAccessService,
  readManifest,
  listManifestFiles,
  serializeManifest,
  compileWorkflowSpec,
  verifyAppSmokes,
  resolvePackageAuditMode,
  // ADR-085 D11 — tool ownership, derived from the active manifests at query time.
  providedToolNames,
  dependedToolNames,
  computeToolDependents,
  otherProvidersOf,
  assertToolNamesUnique,
  assertToolDependenciesResolvable,
} from './services';
export type { AppAccessAssignment, AppAccessResolver, ResolvedAppAccess } from './services';
export type {
  AppSmokeApplicationResult,
  AppSmokeFetch,
  AppSmokeResult,
  AppSmokeVerificationOptions,
  AppSmokeVerificationResult,
} from './services';
export type { PackageAuditMode } from './services';
export type { WorkflowPublishSpec, WorkflowPublishStageInput, WorkflowPublishBotInput } from './services';
export type { ToolDependent } from './services';
