/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 Phase 1 — the engine-agnostic ReconstructionProvider contract: one interface a local synthetic-room sim AND a real GPU gaussian-splat edge box both satisfy, mirroring DroneProvider/SimDroneProvider. Swapping engines is a sibling implementation, never a rewrite. A thrown ReconstructionError is how a provider reports "this attempt failed" to the orchestrating service.
 */

import type {
  ReconstructionSpec,
  ReconstructionArtifact,
  ReconstructionProviderKind,
  ProviderAvailability,
} from '../model/spatial-types';

/**
 * @description Raised by a provider when a reconstruction attempt fails
 * (unreachable box, timeout, empty output). The service catches it and marks the
 * scan failed with the message — never a swallowed exception.
 */
export class ReconstructionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconstructionError';
  }
}

/**
 * @description The single control surface for a reconstruction engine. `kind`
 * names the engine; `probe` is a cheap config/liveness check the service uses to
 * pick a usable provider; `reconstruct` runs the (potentially long) job and
 * returns the packed .splat artifact or throws ReconstructionError.
 */
export interface ReconstructionProvider {
  readonly kind: ReconstructionProviderKind;
  probe(): Promise<ProviderAvailability>;
  reconstruct(spec: ReconstructionSpec): Promise<ReconstructionArtifact>;
}
