/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 Phase 1 — public barrel for the spatial-mapping slice (video->3D reconstruction). Consumers import from '@/features/spatial-mapping' only — no deep imports.
 */

export * from './services';
export type {
  SpatialScan,
  ScanStatus,
  ScanSourceKind,
  ReconstructionProviderKind,
  RegisterScanInput,
  ReconstructionSpec,
  ReconstructionArtifact,
  ProviderAvailability,
} from './model/spatial-types';
export type { ScanPoses, KeyframePose, WorldFrame } from './model/pose-types';
export type { RfSample, TransmitterEstimate, RfCoverageStats, RfOverlayResult } from './model/rf-types';
