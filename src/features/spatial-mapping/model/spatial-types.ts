/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 Phase 1 — shared domain types for the spatial-mapping slice: a scan (video->3D reconstruction job) and the provider contract's spec/artifact shapes. Kept engine-agnostic so a sim provider (local synthetic room) and an edge provider (real GPU gaussian-splat train) satisfy the same interface, exactly like DroneProvider/SimDroneProvider.
 */

import type { ScanPoses } from './pose-types';

/**
 * @description Lifecycle of a reconstruction scan. queued -> reconstructing ->
 * (ready | failed). Mirrors the async submit->poll pattern: the upload route
 * returns immediately with a queued row; the detached job advances it.
 */
export type ScanStatus = 'queued' | 'reconstructing' | 'ready' | 'failed';

/**
 * @description What kind of capture fed the scan. `video`/`images` feed the
 * reconstruction engines (Sim/Edge); `model` is a pre-built 3D capture the user
 * exported from their own device (iPhone/iPad LiDAR, a depth scanner, a drone
 * photogrammetry app) and imported directly — no reconstruction needed;
 * `sim-mission` is a simulated drone scan mission's capture manifest (ADR-111
 * Phase 3 sim-first) — ALWAYS reconstructed by the Sim engine, never sent to the
 * GPU box (there is no real footage behind it).
 */
export type ScanSourceKind = 'video' | 'images' | 'model' | 'sim-mission';

/**
 * @description Which reconstruction engine produced (or will produce) the artifact.
 * `sim` = local synthetic room, `edge` = real GPU gaussian-splat train, `import`
 * = a user-supplied `.ply`/`.splat` converted directly (no GPU).
 */
export type ReconstructionProviderKind = 'sim' | 'edge' | 'import';

/**
 * @description One reconstruction scan owned by a single user. Holds metadata +
 * on-disk storage references ONLY — the source video and the produced .splat
 * live on disk (large binaries), never in a DB column.
 */
export interface SpatialScan {
  id: string;
  userSub: string;
  title: string;
  status: ScanStatus;
  sourceKind: ScanSourceKind;
  sourceName: string | null;
  sourceRef: string | null;
  sourceBytes: number | null;
  provider: ReconstructionProviderKind | null;
  artifactRef: string | null;
  gaussianCount: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * @description The input a store INSERT needs to register a freshly-uploaded scan.
 * The route generates the id (so the upload can land under a scan-scoped dir
 * before the row exists) and passes the stored source path in.
 */
export interface RegisterScanInput {
  id: string;
  userSub: string;
  title: string;
  sourceKind: ScanSourceKind;
  sourceName: string;
  sourceRef: string;
  sourceBytes: number;
}

/**
 * @description What a ReconstructionProvider receives: enough to locate the
 * stored source and to key deterministic output. No DB handle — providers are
 * pure engines; the service persists the result.
 */
export interface ReconstructionSpec {
  scanId: string;
  userSub: string;
  sourceKind: ScanSourceKind;
  sourcePath: string;
  sourceName: string;
}

/**
 * @description What a ReconstructionProvider returns: the packed .splat bytes,
 * the gaussian count, and which engine ran. The service writes the bytes to the
 * scan's artifact path and records the count/provider on the row.
 */
export interface ReconstructionArtifact {
  splat: Buffer;
  gaussianCount: number;
  providerKind: ReconstructionProviderKind;
  /**
   * Optional per-keyframe camera poses (ADR-111 increment A). Present when the
   * engine solved them (edge/sim); absent for imported captures with no camera
   * trajectory. The service persists these as a poses.json sidecar.
   */
  poses?: ScanPoses;
  meta?: Record<string, unknown>;
}

/** @description Cheap liveness/config check a provider answers before it runs. */
export interface ProviderAvailability {
  available: boolean;
  reason?: string;
}
