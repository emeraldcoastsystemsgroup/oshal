/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 Phase 1 — SpatialMappingService: orchestrates the video->3D scan. registerAndStart inserts the queued row (under the request identity) then kicks the reconstruction on a DETACHED task under runWithSystemIdentity — the long job must never block the Express response, and after the request ends there is no request identity, so the SYSTEM sentinel keeps its FORCE-RLS writes visible (deny-by-default would otherwise silent-no-op them). Picks the edge GPU provider when RECON_URL is reachable, else the always-available sim. Deterministic I/O only — no LLM (the spaces-operator concierge does the reasoning).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Completeness-sweep fix: the two best-effort cleanup paths (markFailed terminalize, source-video reclaim) log their failures at warn instead of swallowing them silently (CLAUDE.md: no silent catches). Guarded by spatial-mapping-conventions.spec.ts.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Audit fix: the finally-block deleted the source video even when reconstruction FAILED — one transient error across a 90-minute edge job and the user's 300MB upload was gone with no retry possible. The source is now reclaimed only on success; on failure it stays (bounded by the per-user quota; deleteScan removes the whole dir).
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 geometry export: (1) an IMPORT ('model') source is the user's OWN accurate metric capture (the LiDAR/photogrammetry .ply) — it IS the exportable model, so it is now KEPT on success (reclaim only fires for video/sim-mission intermediates); (2) getGeometryPath serves that model (source .ply for imports, produced .splat for reconstructions) and getDimensions returns its to-scale bbox/size (metres for LiDAR, labelled relative otherwise) — so a build can CONSUME the space, not just view it. splatBounds guarded by spatial-geometry-export.spec.ts.
 */

import type { Pool } from 'pg';
import { promises as fs, existsSync } from 'fs';
import path from 'path';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import type { SpatialScan, RegisterScanInput, ReconstructionSpec, ScanSourceKind } from '../model/spatial-types';
import type { ReconstructionProvider } from './reconstruction-provider';
import { SimReconstructionProvider } from './sim-reconstruction-provider';
import { EdgeReconstructionProvider } from './edge-reconstruction-provider';
import { ImportReconstructionProvider } from './import-reconstruction-provider';
import { SpatialScanStore } from './spatial-scan-store';
import { artifactPath, posesPath, scanDir } from './scan-paths';
import { splatBounds } from './splat-format';

const logger = createChildLogger({ module: 'spatial-mapping-service' });

/** Per-user cap on stored scans — bounds disk use (large source videos + splats). */
const MAX_SCANS_PER_USER = 100;

/** A non-terminal scan older than this was orphaned (process died mid-job); self-heal to failed.
 *  Well beyond the edge poll ceiling (90 min) so a legitimately-running job is never touched. */
const STALE_MS = 2 * 60 * 60 * 1000;

/** Injectable providers (tests pass fakes; prod uses the real sim/edge/import set). */
export interface SpatialMappingOptions {
  simProvider?: ReconstructionProvider;
  edgeProvider?: ReconstructionProvider;
  importProvider?: ReconstructionProvider;
}

/**
 * @description The spaces-operator bot's domain service: registers scans, runs
 * reconstruction off the request path, and answers reads. The cockpit surface is
 * a view over this store (ADR-036).
 */
export class SpatialMappingService {
  private readonly store: SpatialScanStore;
  private readonly sim: ReconstructionProvider;
  private readonly edge: ReconstructionProvider;
  private readonly importer: ReconstructionProvider;

  constructor(pool: Pool, opts: SpatialMappingOptions = {}) {
    this.store = new SpatialScanStore(pool);
    this.sim = opts.simProvider ?? new SimReconstructionProvider();
    this.edge = opts.edgeProvider ?? new EdgeReconstructionProvider();
    this.importer = opts.importProvider ?? new ImportReconstructionProvider();
  }

  /**
   * @description Insert a queued scan and start its reconstruction on a detached
   * task. Returns immediately with the queued row; the client polls getScan.
   * @param input - The uploaded scan's id, owner, title and source metadata
   * @returns The inserted (queued) scan
   */
  async registerAndStart(input: RegisterScanInput): Promise<SpatialScan> {
    const scan = await this.store.insert(input);
    void runWithSystemIdentity(() => this.runReconstruction(input.userSub, input.id)).catch((err) =>
      logger.error({ err, scanId: input.id }, 'detached reconstruction task rejected'),
    );
    logger.info({ scanId: scan.id, userSub: input.userSub }, 'scan registered, reconstruction started');
    return scan;
  }

  /** True if the user is under the per-user scan cap (quota gate, checked before upload). */
  async canAcceptScan(userSub: string): Promise<boolean> {
    return (await this.store.countByUser(userSub)) < MAX_SCANS_PER_USER;
  }

  /** The per-user scan cap (for surfacing in a 429 body). */
  get maxScansPerUser(): number {
    return MAX_SCANS_PER_USER;
  }

  /** List the caller's scans, newest first (self-healing any orphaned rows first). */
  async listScans(userSub: string): Promise<SpatialScan[]> {
    await this.reconcileStale(userSub);
    return this.store.listByUser(userSub);
  }

  /** Fetch one of the caller's scans (null if not theirs), self-healing it if orphaned. */
  async getScan(userSub: string, id: string): Promise<SpatialScan | null> {
    const scan = await this.store.getById(userSub, id);
    if (scan && this.isStale(scan)) {
      await this.store.markFailed(userSub, id, 'reconstruction did not complete (interrupted)');
      return this.store.getById(userSub, id);
    }
    return scan;
  }

  /**
   * @description Delete a scan the caller owns: the DB row and its on-disk media.
   * @param userSub - Owning user's sub
   * @param id - Scan id
   * @returns True if a scan was removed
   */
  async deleteScan(userSub: string, id: string): Promise<boolean> {
    const removed = await this.store.delete(userSub, id);
    if (removed) {
      await fs.rm(scanDir(userSub, id), { recursive: true, force: true }).catch((err) =>
        logger.warn({ err, id }, 'scan dir cleanup after delete failed'),
      );
    }
    return removed;
  }

  /**
   * @description Resolve the on-disk .splat path for a ready scan the caller owns.
   * @param userSub - Owning user's sub
   * @param id - Scan id
   * @returns The artifact path, or null if the scan isn't ready/owned
   */
  async getArtifactPath(userSub: string, id: string): Promise<string | null> {
    const scan = await this.store.getById(userSub, id);
    if (!scan || scan.status !== 'ready' || !scan.artifactRef) return null;
    return scan.artifactRef;
  }

  /**
   * @description Resolve the on-disk poses.json path for a ready scan the caller
   * owns, if it has one (ADR-111 increment A). Imported captures have no poses.
   * @param userSub - Owning user's sub
   * @param id - Scan id
   * @returns The poses.json path if the scan is ready/owned and has poses, else null
   */
  async getPosesPath(userSub: string, id: string): Promise<string | null> {
    const scan = await this.store.getById(userSub, id);
    if (!scan || scan.status !== 'ready') return null;
    const p = posesPath(userSub, id);
    return existsSync(p) ? p : null;
  }

  /**
   * @description Resolve the accurate, exportable GEOMETRY of a ready scan the caller owns —
   * the model your own build consumes, not the viewer-only stream. For an IMPORT ('model')
   * scan this is the user's ORIGINAL capture (the LiDAR/photogrammetry .ply, now KEPT on
   * success) — the full-resolution metric geometry; for a reconstruction it is the produced
   * .splat (the gaussian positions ARE the geometry). Null when not ready/owned or the file
   * is gone.
   * @param userSub - Owner sub (reads pinned to it).
   * @param id - Scan id.
   * @returns { path, filename, kind: 'source' | 'splat' } or null.
   */
  async getGeometryPath(
    userSub: string,
    id: string,
  ): Promise<{ path: string; filename: string; kind: 'source' | 'splat' } | null> {
    const scan = await this.store.getById(userSub, id);
    if (!scan || scan.status !== 'ready') return null;
    if (scan.sourceKind === 'model' && scan.sourceRef && existsSync(scan.sourceRef)) {
      const ext = path.extname(scan.sourceRef) || '.ply';
      return { path: scan.sourceRef, filename: `scan-${id}${ext}`, kind: 'source' };
    }
    if (scan.artifactRef && existsSync(scan.artifactRef)) {
      return { path: scan.artifactRef, filename: `scan-${id}.splat`, kind: 'splat' };
    }
    return null;
  }

  /**
   * @description Real-world dimensions of a ready scan: the axis-aligned bounding box + per-axis
   * size of the reconstructed geometry, read from the .splat. METRES for a LiDAR import (metric
   * by construction); relative units for an un-anchored video/sim reconstruction — labelled via
   * `unit`/`scaleSource` so a caller never mistakes relative for metric. The "is it accurate/
   * to-scale?" answer the export API surfaces.
   * @param userSub - Owner sub.
   * @param id - Scan id.
   * @returns dimensions metadata, or null when not ready/owned or the artifact is unreadable.
   */
  async getDimensions(
    userSub: string,
    id: string,
  ): Promise<{
    unit: 'meters' | 'relative';
    scaleSource: 'lidar' | 'reconstruction';
    min: [number, number, number];
    max: [number, number, number];
    size: [number, number, number];
    gaussianCount: number;
  } | null> {
    const scan = await this.store.getById(userSub, id);
    if (!scan || scan.status !== 'ready' || !scan.artifactRef || !existsSync(scan.artifactRef)) return null;
    const bounds = splatBounds(await fs.readFile(scan.artifactRef));
    if (!bounds) return null;
    const metric = scan.sourceKind === 'model';
    return {
      unit: metric ? 'meters' : 'relative',
      scaleSource: metric ? 'lidar' : 'reconstruction',
      min: bounds.min,
      max: bounds.max,
      size: bounds.size,
      gaussianCount: bounds.count,
    };
  }

  /** Run reconstruction to completion, updating the row. Detached; never throws.
   *  markReconstructing + pickProvider are INSIDE the try so a DB/provider error also
   *  terminalizes the row (never leaves it stuck non-terminal). */
  private async runReconstruction(userSub: string, scanId: string): Promise<void> {
    const scan = await this.store.getById(userSub, scanId);
    if (!scan || !scan.sourceRef) return;
    let succeeded = false;
    try {
      await this.store.markReconstructing(userSub, scanId);
      const provider = await this.pickProvider(scan.sourceKind);
      const spec: ReconstructionSpec = {
        scanId,
        userSub,
        sourceKind: scan.sourceKind,
        sourcePath: scan.sourceRef,
        sourceName: scan.sourceName ?? 'source',
      };
      const artifact = await provider.reconstruct(spec);
      const outPath = artifactPath(userSub, scanId);
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await fs.writeFile(outPath, artifact.splat);
      if (artifact.poses) {
        // ADR-111 increment A: persist the solved camera poses next to the splat
        // (on-disk sidecar, no DB column) so the RF overlay + relocalization can use them.
        await fs.writeFile(posesPath(userSub, scanId), JSON.stringify(artifact.poses));
      }
      await this.store.markReady(userSub, scanId, {
        provider: artifact.providerKind,
        artifactRef: outPath,
        gaussianCount: artifact.gaussianCount,
      });
      logger.info({ scanId, provider: artifact.providerKind, gaussianCount: artifact.gaussianCount }, 'scan ready');
      succeeded = true;
    } catch (err) {
      const message = (err as Error).message || 'reconstruction failed';
      logger.error({ err, scanId }, 'reconstruction failed');
      await this.store.markFailed(userSub, scanId, message)
        .catch((e) => logger.warn({ e, scanId }, 'markFailed terminalize failed — scan self-heals via the stale sweep'));
    } finally {
      // Reclaim the source ONLY on success, and ONLY when it is a large intermediate whose
      // product is the .splat (a walkthrough video, or a sim-mission manifest). An IMPORT
      // ('model') source is the user's OWN accurate metric capture (a LiDAR/photogrammetry
      // .ply): it IS the exportable 3D model, so it is KEPT on success and served by
      // GET /scans/:id/geometry. On failure the upload always stays (retry/diagnosis); disk
      // is bounded by the per-user quota and deleteScan's whole-dir rm.
      const keepAsGeometry = scan.sourceKind === 'model';
      if (succeeded && scan.sourceRef && !keepAsGeometry) {
        await fs.rm(scan.sourceRef, { force: true })
          .catch((e) => logger.warn({ e, scanId }, 'source reclaim failed'));
      } else if (scan.sourceRef && !succeeded) {
        logger.warn({ scanId }, 'keeping source media after failed reconstruction (retry/diagnosis)');
      }
    }
  }

  /** A non-terminal scan that has sat past STALE_MS was orphaned by a restart. */
  private isStale(scan: SpatialScan): boolean {
    if (scan.status !== 'queued' && scan.status !== 'reconstructing') return false;
    return Date.now() - new Date(scan.updatedAt).getTime() > STALE_MS;
  }

  /** Mark any of the user's orphaned non-terminal scans failed (self-heal on read). */
  private async reconcileStale(userSub: string): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_MS).toISOString();
    const stale = await this.store.listStaleNonTerminal(userSub, cutoff);
    for (const s of stale) {
      await this.store.markFailed(userSub, s.id, 'reconstruction did not complete (interrupted)')
        .catch((err) => logger.warn({ err, id: s.id }, 'stale scan reconcile failed'));
    }
  }

  /**
   * @description Pick the engine for a scan. An imported capture (`model`) always
   * converts locally via the import engine — it needs no GPU. Otherwise prefer the
   * edge GPU box when reachable, else the always-available sim.
   * @param sourceKind - What fed the scan (video/images reconstruct; model imports)
   * @returns The reconstruction provider to run
   */
  private async pickProvider(sourceKind: ScanSourceKind): Promise<ReconstructionProvider> {
    if (sourceKind === 'model') return this.importer;
    // A sim drone-scan mission has no real footage — never ship its manifest to the GPU box.
    if (sourceKind === 'sim-mission') return this.sim;
    const forced = (process.env.SPATIAL_RECONSTRUCTION_PROVIDER || '').toLowerCase();
    if (forced === 'sim') return this.sim;
    if (forced === 'edge') return this.edge;
    const edgeStatus = await this.edge.probe();
    if (edgeStatus.available) return this.edge;
    return this.sim;
  }
}
