/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Barrel for the dev-console feature (ADR-077 Phase 2 Dev Session Engine).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export the dev-node app factory + jsonOnlyBody (the JSON-only wall shared by the host dev-node and the api's /api/dev-console proxy) so scripts/dev-node.ts stays a thin entrypoint and the contract is unit-testable.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Export the dev-mode change classifier, the live-apply fast lanes, and the deploy promoter — the three pieces that let a self-edit take the lane its own content requires instead of routing every change through an image rebuild.
 */

export { DevSessionEngine } from './services/dev-session-engine';
export type {
  DevSessionEngineConfig,
  DevSession,
  ChangeSetEdit,
  DiffFile,
  DevSessionDiff,
  VerifyResult,
  CommitResult,
} from './services/dev-session-engine';
export { SandboxedAgentRunner } from './services/sandboxed-agent-runner';
export type {
  SandboxRunnerConfig,
  SandboxRunResult,
  SandboxRunExtra,
  IsolationReport,
} from './services/sandboxed-agent-runner';
export { DevSessionOrchestrator } from './services/dev-session-orchestrator';
export type { AgentEditResult, AgentEditOptions } from './services/dev-session-orchestrator';
export { DevSessionManager } from './services/dev-session-manager';
export type { DevSessionFrame, DevSessionStatus, StartSpec } from './services/dev-session-manager';
export { createDevNodeApp, jsonOnlyBody } from './services/dev-node-app';
export type { DevNodeAppOptions } from './services/dev-node-app';
export {
  classifyChangePath,
  classifyChangeSet,
  isChangeClass,
  isLiveAppliable,
  normalizeRepoRelative,
  restartActionFor,
} from './services/change-class';
export type { ChangeClass, RestartAction } from './services/change-class';
export { LiveApplier } from './services/live-apply';
export type {
  LiveChange,
  LiveApplyResult,
  LiveApplyRefusal,
  LiveApplySuccess,
  LiveApplierConfig,
  RestartOutcome,
} from './services/live-apply';
export { DeployPromoter, promoteVerdictForExit, resolveDeployShell } from './services/deploy-promoter';
export type {
  PromoteOutcome,
  PromoteOptions,
  PromoteStatus,
  PromoteVerdict,
  PromoteSpawner,
  DeployPromoterConfig,
} from './services/deploy-promoter';
