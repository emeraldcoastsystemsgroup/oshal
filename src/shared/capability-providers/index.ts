/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1: barrel for the shared capability-provider rules — the types, the principal constructors, the swarm-row snapshot with its installed instance, and the one resolver and options list the four capabilities share. Shared (bottom) layer so the voice and media features resolve through the same code the operator route reports from.
 */

/**
 * @description Capability providers resolve per user (ADR-173): the shared rule.
 * @module shared/capability-providers
 */

export {
  CAPABILITIES,
  CAPABILITY_COST_CLASSES,
  CAPABILITY_FLEET_SCOPE,
  CAPABILITY_RUNGS,
  isCapability,
  isCapabilityCostClass,
  type Capability,
  type CapabilityAdapter,
  type CapabilityAvailability,
  type CapabilityCaller,
  type CapabilityCallerCredentials,
  type CapabilityChoice,
  type CapabilityCostClass,
  type CapabilityMissingPiece,
  type CapabilityOption,
  type CapabilityPrincipal,
  type CapabilityProviderDeclaration,
  type CapabilityRefused,
  type CapabilityResolution,
  type CapabilityResolved,
  type CapabilityResolveRequest,
  type CapabilityRowOptions,
  type CapabilityRung,
  type CapabilitySeedDefault,
  type CapabilitySkippedRung,
  type CapabilitySwarmRow,
  type CapabilitySwarmRowReader,
} from './capability-types';
export {
  describeCapabilityPrincipal,
  isCapabilityPrincipal,
  requestIdentityCapabilityPrincipal,
  routeCapabilityPrincipal,
  systemCapabilityPrincipal,
  unattributedCapabilityPrincipal,
  userCapabilityPrincipal,
  type CapabilityUserFacts,
} from './capability-principal';
export {
  CapabilityRowSnapshot,
  installCapabilityRowSnapshot,
  installedCapabilityRowReader,
  installedCapabilityRowSnapshot,
  resolveCapabilityRowsRefreshMs,
  type CapabilityRowSnapshotStatus,
  type CapabilitySwarmRowSource,
} from './capability-row-snapshot';
export {
  describeCapabilitySwarmDefault,
  listCapabilityOptions,
  resolveCapabilityProvider,
  type CapabilityResolveDeps,
  type CapabilitySwarmDefaultView,
} from './capability-resolution';
