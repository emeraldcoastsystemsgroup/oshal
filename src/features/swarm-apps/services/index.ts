/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Barrel — swarm-apps services
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export the ADR-118 app access service and route-boundary resolver contract.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Export the CORE-05 package smoke verifier contract.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Export the APP-02 package-audit rollout-mode resolver for installer boundaries.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Export the ADR-141 application-group validators + resolvers (swarm-app-group.ts).
 */

export { SwarmAppService } from './swarm-app-service';
export { SwarmAppRepository } from './swarm-app-repository';
export { AppAccessService } from './app-access-service';
export type { AppAccessAssignment, AppAccessResolver, ResolvedAppAccess } from './app-access-service';
export { readManifest, listManifestFiles, serializeManifest } from './swarm-app-loader';
export { verifyAppSmokes } from './app-smoke-verifier';
// ADR-141 application groups — validation + resolution of `kind: group` and `readiness:`.
export {
  SWARM_APP_KINDS,
  GroupResolutionError,
  isGroupManifest,
  orderGroupsLast,
  groupDashboardTile,
  staticRibbonItems,
  validateGroupManifest,
  validateReadinessDeclarations,
  validateSummaryDeclaration,
  validateGuestSeedDeclaration,
  resolveGroupToolbar,
  resolveGroupSetup,
  assertGroupResolvable,
} from './swarm-app-group';
export type { ResolvedGroupSetupStep, ResolvedGroupToolbar } from './swarm-app-group';
export {
  buildHomePlan,
  coerceSummaryPayload,
  coerceTone,
  atPointer,
  MAX_SUMMARY_TILES,
  MAX_SUMMARY_ITEMS,
} from './app-home-plan';
export type { HomePlanEntry, HomePlanSummaryProbe, HomePlanTodo } from './app-home-plan';
export type {
  AppSmokeApplicationResult,
  AppSmokeFetch,
  AppSmokeResult,
  AppSmokeVerificationOptions,
  AppSmokeVerificationResult,
} from './app-smoke-verifier';
export { resolvePackageAuditMode } from './package-audit-mode';
export type { PackageAuditMode } from './package-audit-mode';
export {
  providedToolNames,
  dependedToolNames,
  computeToolDependents,
  otherProvidersOf,
  assertToolNamesUnique,
  assertToolDependenciesResolvable,
  type ToolDependent,
} from './tool-ownership';
export { compileWorkflowSpec } from './workflow-publish-compiler';
export type { WorkflowPublishSpec, WorkflowPublishStageInput, WorkflowPublishBotInput } from './workflow-publish-compiler';
