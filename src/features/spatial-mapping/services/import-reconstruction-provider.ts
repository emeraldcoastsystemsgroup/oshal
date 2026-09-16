/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 direct-import lane — ImportReconstructionProvider: the no-GPU engine for a scan whose source is a pre-built 3D capture the user exported from their own device. Satisfies the SAME ReconstructionProvider contract as Sim/Edge (probe + reconstruct), so it reuses the whole detached-run/markReady/quota/self-heal machinery in SpatialMappingService — the service just picks THIS provider when sourceKind is 'model'. reconstruct() reads the uploaded .ply/.splat and converts it via import-format; a throw becomes a ReconstructionError so the scan is marked failed with the message (never a swallowed error).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | A .ply now converts OFF the event loop: reconstruct() hands it to convertPlyOffLoop (a worker thread under the OSHAL_SPACES_PLY_WORKER_HEAP_MB heap cap) after refusing a source over the OSHAL_SPACES_PLY_MAX_BYTES gate with a ReconstructionError that names the limit, so a scan that reaches the engine by any path other than the gated route (a row resumed after a restart, an older upload) never runs the parse either. A worker death (out of memory, a parse throw, a silent exit) becomes a ReconstructionError carrying the reason, which the service writes onto the failed row. The .splat passthrough keeps its on-thread read + validate. Why: a 117 MB .ply parsed on the main thread collapsed the Docker VM and a 44 MB one held the loop for 14 s (2026-09-14). Guarded by tests/unit/spatial-import-event-loop.spec.ts and tests/unit/spatial-import-worker.spec.ts.
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
import { convertPlyOffLoop } from './ply-convert-host';
import { formatByteLimit, PLY_IMPORT_ENV, resolvePlyImportLimits } from './import-limits';

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
   * @description Convert the uploaded capture file into a packed `.splat`. A `.ply`
   * is gated by size and converted in a worker thread; a `.splat` passes through
   * validated on this thread (cheap: a copy only when subsampling).
   * @param spec - The scan's reconstruction spec (locates the stored source)
   * @returns The packed `.splat` artifact + gaussian count
   */
  async reconstruct(spec: ReconstructionSpec): Promise<ReconstructionArtifact> {
    const ext = (path.extname(spec.sourceName || '') || path.extname(spec.sourcePath || '')).toLowerCase();
    if (ext === '.ply') return this.reconstructPly(spec, ext);
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

  /**
   * @description The `.ply` path: refuse a source over the configured byte gate before any
   * parse, then convert in a worker thread bounded by the configured heap cap. Every failure
   * shape (unreadable source, over the gate, worker out of memory, parse error, silent exit)
   * surfaces as a ReconstructionError whose message the service records on the failed row.
   * @param spec - The scan's reconstruction spec
   * @param ext - The lower-cased extension (`.ply`)
   * @returns The packed `.splat` artifact + gaussian count
   */
  private async reconstructPly(spec: ReconstructionSpec, ext: string): Promise<ReconstructionArtifact> {
    const limits = resolvePlyImportLimits();
    let sourceBytes: number;
    try {
      sourceBytes = (await fs.stat(spec.sourcePath)).size;
    } catch (err) {
      logger.error({ err, scanId: spec.scanId, sourcePath: spec.sourcePath }, 'import: cannot stat the .ply source');
      throw new ReconstructionError(`import: cannot read source (${(err as Error).message})`);
    }
    if (sourceBytes > limits.plyMaxBytes) {
      throw new ReconstructionError(
        `import: .ply source is ${sourceBytes} bytes, over the ${formatByteLimit(limits.plyMaxBytes)} gate (${PLY_IMPORT_ENV.maxBytes})`,
      );
    }
    try {
      const { splat, count } = await convertPlyOffLoop(spec.sourcePath, ext, { workerHeapMb: limits.workerHeapMb });
      logger.info({ scanId: spec.scanId, ext, count, sourceBytes }, 'imported capture converted to splat');
      return { splat, gaussianCount: count, providerKind: 'import', meta: { ext, sourceBytes, offLoop: true } };
    } catch (err) {
      logger.error({ err, scanId: spec.scanId, sourceBytes }, 'import: .ply conversion failed');
      throw new ReconstructionError(`import: ${(err as Error).message}`);
    }
  }
}
