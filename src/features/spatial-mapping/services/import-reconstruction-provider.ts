/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 direct-import lane — ImportReconstructionProvider: the no-GPU engine for a scan whose source is a pre-built 3D capture the user exported from their own device. Satisfies the SAME ReconstructionProvider contract as Sim/Edge (probe + reconstruct), so it reuses the whole detached-run/markReady/quota/self-heal machinery in SpatialMappingService — the service just picks THIS provider when sourceKind is 'model'. reconstruct() reads the uploaded .ply/.splat and converts it via import-format; a throw becomes a ReconstructionError so the scan is marked failed with the message (never a swallowed error).
 */

import { promises as fs } from 'fs';
import path from 'path';
import { createChildLogger } from '@/shared/logger';
import type {
  ReconstructionSpec,
  ReconstructionArtifact,
  ReconstructionProviderKind,
  ProviderAvailability,
} from '../model/spatial-types';
import { ReconstructionProvider, ReconstructionError } from './reconstruction-provider';
import { convertToSplat } from './import-format';

const logger = createChildLogger({ module: 'import-reconstruction-provider' });

/**
 * @description Reconstruction engine for user-imported 3D captures. It does no
 * training — it converts an uploaded `.ply` (point cloud or trained 3DGS) or a
 * raw `.splat` into the vendored viewer's `.splat` format. Always available (no
 * external box), so a user can map their space with their own device today.
 */
export class ImportReconstructionProvider implements ReconstructionProvider {
  public readonly kind: ReconstructionProviderKind = 'import';

  /**
   * @description The import engine is always usable — it needs no GPU box.
   * @returns Availability (always available)
   */
  async probe(): Promise<ProviderAvailability> {
    return { available: true };
  }

  /**
   * @description Convert the uploaded capture file into a packed `.splat`.
   * @param spec - The scan's reconstruction spec (locates the stored source)
   * @returns The packed `.splat` artifact + gaussian count
   */
  async reconstruct(spec: ReconstructionSpec): Promise<ReconstructionArtifact> {
    const ext = (path.extname(spec.sourceName || '') || path.extname(spec.sourcePath || '')).toLowerCase();
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(spec.sourcePath);
    } catch (err) {
      throw new ReconstructionError(`import: cannot read source (${(err as Error).message})`);
    }
    try {
      const { buffer, count } = convertToSplat(bytes, ext);
      logger.info({ scanId: spec.scanId, ext, count }, 'imported capture converted to splat');
      return { splat: buffer, gaussianCount: count, providerKind: 'import', meta: { ext, sourceBytes: bytes.length } };
    } catch (err) {
      throw new ReconstructionError(`import: ${(err as Error).message}`);
    }
  }
}
