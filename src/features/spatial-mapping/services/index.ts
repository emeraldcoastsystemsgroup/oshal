/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 Phase 1 — services sub-barrel for the spatial-mapping slice.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export the .ply import limits (resolvePlyImportLimits, formatByteLimit, PLY_IMPORT_ENV, PLY_IMPORT_DEFAULTS) so the store's spaces route reads its 413 gate from configuration instead of a literal, and the off-loop converter (convertPlyOffLoop) so the worker-thread boundary is testable through the public barrel.
 */

export { SpatialMappingService, type SpatialMappingOptions } from './spatial-mapping-service';
export { SpatialScanStore, type ReadyPatch } from './spatial-scan-store';
export { SimReconstructionProvider, type SimReconstructionOptions } from './sim-reconstruction-provider';
export { EdgeReconstructionProvider } from './edge-reconstruction-provider';
export { ImportReconstructionProvider } from './import-reconstruction-provider';
export { ReconstructionError, type ReconstructionProvider } from './reconstruction-provider';
export { packSplat, generateRoomSplat, roomDims, type Gaussian } from './splat-format';
export { convertToSplat, IMPORT_EXTENSIONS, type ImportedSplat } from './import-format';
export {
  resolvePlyImportLimits, formatByteLimit, PLY_IMPORT_ENV, PLY_IMPORT_DEFAULTS, type PlyImportLimits,
} from './import-limits';
export { convertPlyOffLoop, type OffLoopConvertOptions, type OffLoopConvertResult } from './ply-convert-host';
export {
  generateCapturePlan, droneScanPattern,
  type CapturePlan, type CapturePlanStep, type CaptureTarget,
  type DroneScanOptions, type DroneScanPattern,
} from './capture-plan';
export {
  expectedRssi,
  estimateTransmitter,
  idwRssi,
  syntheticRssi,
  DEFAULT_PATH_LOSS_EXP,
  DEAD_ZONE_DBM,
  type TransmitterFit,
} from './rf-model';
export {
  RfOverlayService, RfInputError, sanitizeRfSamples, MIN_TX_SAMPLES,
  coverageColor, dimSplat, buildOverlaySplat,
} from './rf-overlay-service';
export {
  resolveScansRoot, subHash, scanDir, artifactPath, posesPath,
  rfOverlayPath, rfSamplesPath, rfSummaryPath, captureTelemetryPath,
} from './scan-paths';
export {
  sanitizeCaptureTelemetry, CAPTURE_SESSION_ID_RE, CAPTURE_TELEMETRY_MAX_BYTES,
  type CaptureTelemetryRecord,
} from './capture-telemetry';
