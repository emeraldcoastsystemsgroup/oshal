/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 Phase 1 — SimReconstructionProvider: the always-available local engine. It generates a real, renderable synthetic room .splat (deterministic in the scan id) so the full pipeline + viewer are exercisable with MOCK_OIDC and no GPU box — the honest sim sibling of the real EdgeReconstructionProvider, exactly as SimDroneProvider is to MavlinkDroneProvider. It does NOT claim to reconstruct the uploaded video; it demonstrates the pipeline. An injectable clock keeps it deterministic under test.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Audit fix: the synthetic orbit circled the ORIGIN, but the room's corner sits at the origin — ~3/4 of the keyframes (and the RF demo's heat gaussians riding them) floated outside the walls. The orbit now derives the seeded room dims (roomDims, same PRNG stream) and circles the room's centre at a radius that stays inside the walls.
 */

import { createChildLogger } from '@/shared/logger';
import type {
  ReconstructionSpec,
  ReconstructionArtifact,
  ReconstructionProviderKind,
  ProviderAvailability,
} from '../model/spatial-types';
import type { ScanPoses } from '../model/pose-types';
import type { ReconstructionProvider } from './reconstruction-provider';
import { generateRoomSplat, roomDims } from './splat-format';

const logger = createChildLogger({ module: 'sim-reconstruction-provider' });

/**
 * @description A deterministic synthetic camera orbit for the sim room, so the
 * pose-consuming features (RF overlay, relocalization) are exercisable with no
 * GPU — the pose sibling of generateRoomSplat. Honestly non-metric (opengl).
 * @param scanId - Seeds the scan id echoed into the pose set
 * @returns A ScanPoses orbit of 8 keyframes
 */
function syntheticPoses(scanId: string): ScanPoses {
  // Orbit the seeded room's CENTRE (its corner is the origin), at a radius that
  // keeps every keyframe inside the walls — the RF demo paints heat at these
  // centers, so an out-of-room orbit would render coverage floating in space.
  const { w, d } = roomDims(scanId);
  const radius = Math.max(0.6, Math.min(w, d) / 2 - 0.5);
  const keyframes = Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * 2 * Math.PI;
    return {
      index: i,
      imageRef: `frame_${String(i).padStart(3, '0')}.jpg`,
      center: [w / 2 + radius * Math.cos(a), 1.5, d / 2 + radius * Math.sin(a)] as [number, number, number],
      quat: [Math.cos(a / 2), 0, Math.sin(a / 2), 0] as [number, number, number, number],
      fx: 1000, fy: 1000, cx: 960, cy: 540, width: 1920, height: 1080,
    };
  });
  return {
    scanId,
    frame: { convention: 'opengl', metric: false, scaleSource: 'none', scale: 1, gravityAligned: false, upAxis: 'y' },
    keyframes,
  };
}

/** Options for the sim provider (a fake clock makes tests deterministic). */
export interface SimReconstructionOptions {
  clock?: () => number;
}

/**
 * @description Local synthetic-room reconstruction engine. Always available;
 * resolves quickly (real GPU trains take tens of minutes — the sim stands in so
 * the pipeline is demonstrable end-to-end without hardware).
 */
export class SimReconstructionProvider implements ReconstructionProvider {
  public readonly kind: ReconstructionProviderKind = 'sim';
  private readonly clock: () => number;

  constructor(opts: SimReconstructionOptions = {}) {
    this.clock = opts.clock ?? (() => Date.now());
  }

  /**
   * @description The sim needs no external service, so it is always usable.
   * @returns Availability with no reason (always true)
   */
  async probe(): Promise<ProviderAvailability> {
    return { available: true };
  }

  /**
   * @description Produce a deterministic synthetic-room .splat for the scan.
   * @param spec - The scan's reconstruction spec (only the id seeds output)
   * @returns The packed .splat artifact and its gaussian count
   */
  async reconstruct(spec: ReconstructionSpec): Promise<ReconstructionArtifact> {
    const startedMs = this.clock();
    const { buffer, count } = generateRoomSplat(spec.scanId);
    logger.info(
      { scanId: spec.scanId, gaussianCount: count, bytes: buffer.length },
      'sim reconstruction produced synthetic room splat',
    );
    return {
      splat: buffer,
      gaussianCount: count,
      providerKind: 'sim',
      poses: syntheticPoses(spec.scanId),
      meta: { synthetic: true, generatedMs: this.clock() - startedMs },
    };
  }
}
