/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 Phase 1 — EdgeReconstructionProvider: the real GPU-box engine. Drives a self-hosted reconstruction service over Tailscale (RECON_URL) with the same submit->poll->fetch protocol the ComfyUI video provider uses: POST the source video, poll the job, fetch the produced .splat. The box runs an ffmpeg->COLMAP->splatfacto->export pipeline behind its own HTTP API; OSHAL never shells into it. Unset/unreachable RECON_URL -> probe() false -> the service falls back to the sim, so local dev needs no box.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Completeness-sweep honesty fix: the original entry cited scripts/spatial-recon-edge as if it were in-repo — it is not. This file fixes the wire protocol (POST /reconstruct -> poll GET /jobs/:id -> GET /jobs/:id/splat); the box-side reference implementation is a deferred deliverable tracked in docs/BACKLOG.md (Spaces section).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | (superseded by the same-day box-side landing) scripts/spatial-recon-edge IS now in-repo — this provider drives it.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Audit-fix pass: (1) the poll loop treated only HTTP non-OK as transient — a network-level fetch rejection (ECONNREFUSED during a box restart) killed a 90-minute job; now every poll fetch is try/caught + timed out and retries until the deadline. (2) fetchSplat gets the same transient tolerance (bounded retries). (3) All box calls send X-Recon-Token when RECON_TOKEN is set, matching the box's new optional shared-secret gate.
 */

import { createChildLogger } from '@/shared/logger';
import { promises as fs } from 'fs';
import type {
  ReconstructionSpec,
  ReconstructionArtifact,
  ReconstructionProviderKind,
  ProviderAvailability,
} from '../model/spatial-types';
import type { ScanPoses } from '../model/pose-types';
import { ReconstructionProvider, ReconstructionError } from './reconstruction-provider';

const logger = createChildLogger({ module: 'edge-reconstruction-provider' });

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 90 * 60_000; // a room-scale gaussian-splat train runs tens of minutes to ~1.5h
const POLL_FETCH_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 4_000;
const SPLAT_FETCH_ATTEMPTS = 3;
const STRIDE = 32;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Shape the box reports when polled for a job. */
interface EdgeJobStatus {
  status: 'queued' | 'running' | 'done' | 'error';
  error?: string;
  gaussianCount?: number;
}

/**
 * @description Real reconstruction engine backed by a remote GPU box. Long jobs
 * MUST NOT run on an Express request thread — the orchestrating service runs
 * reconstruct() on a detached task and the client polls OSHAL, exactly as this
 * provider polls the box.
 */
export class EdgeReconstructionProvider implements ReconstructionProvider {
  public readonly kind: ReconstructionProviderKind = 'edge';

  /** Normalized RECON_URL (trailing slashes stripped), or null when unset. */
  private base(): string | null {
    const u = process.env.RECON_URL;
    return u ? u.replace(/\/+$/, '') : null;
  }

  /** Shared-secret header when RECON_TOKEN is set — the box rejects without it once configured. */
  private authHeaders(): Record<string, string> {
    const t = process.env.RECON_TOKEN;
    return t ? { 'X-Recon-Token': t } : {};
  }

  /**
   * @description Is the GPU box configured and reachable right now?
   * @returns Availability with a reason when unusable
   */
  async probe(): Promise<ProviderAvailability> {
    const base = this.base();
    if (!base) return { available: false, reason: 'RECON_URL not set' };
    try {
      const r = await fetch(`${base}/health`, { headers: this.authHeaders(), signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      return r.ok ? { available: true } : { available: false, reason: `health ${r.status}` };
    } catch (err) {
      return { available: false, reason: `unreachable: ${(err as Error).message}` };
    }
  }

  /**
   * @description Submit the source, poll to completion, fetch the .splat.
   * @param spec - The scan's reconstruction spec (locates the source video)
   * @returns The produced .splat artifact
   */
  async reconstruct(spec: ReconstructionSpec): Promise<ReconstructionArtifact> {
    const base = this.base();
    if (!base) throw new ReconstructionError('RECON_URL not set');
    const jobId = await this.submit(base, spec);
    const finished = await this.awaitJob(base, jobId);
    const splat = await this.fetchSplat(base, jobId);
    const poses = await this.fetchPoses(base, jobId);
    return {
      splat,
      gaussianCount: finished.gaussianCount ?? Math.floor(splat.length / STRIDE),
      providerKind: 'edge',
      poses,
      meta: { host: base, jobId },
    };
  }

  /**
   * @description Best-effort fetch of the box's solved camera poses (ADR-111
   * increment A). Poses are OPTIONAL — a box that predates them, or a transient
   * miss, must not fail the scan, so this returns undefined (logged) rather than
   * throwing.
   * @param base - Normalized box base URL
   * @param jobId - The finished job id
   * @returns The scan's poses, or undefined when unavailable
   */
  private async fetchPoses(base: string, jobId: string): Promise<ScanPoses | undefined> {
    try {
      const r = await fetch(`${base}/jobs/${jobId}/poses`, { headers: this.authHeaders() });
      if (!r.ok) {
        logger.debug({ jobId, status: r.status }, 'edge job has no poses (optional)');
        return undefined;
      }
      const poses = (await r.json()) as ScanPoses;
      logger.info({ jobId, keyframes: poses.keyframes?.length ?? 0 }, 'edge reconstruction fetched poses');
      return poses;
    } catch (err) {
      logger.warn({ jobId, err }, 'edge poses fetch failed (optional) — proceeding without poses');
      return undefined;
    }
  }

  /** POST the source video to the box, returning its job id. */
  private async submit(base: string, spec: ReconstructionSpec): Promise<string> {
    const body = await fs.readFile(spec.sourcePath);
    const res = await fetch(`${base}/reconstruct`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Scan-Id': spec.scanId,
        'X-Source-Name': encodeURIComponent(spec.sourceName),
        'X-Source-Kind': spec.sourceKind,
        ...this.authHeaders(),
      },
      body,
    });
    if (!res.ok) {
      throw new ReconstructionError(`recon /reconstruct ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const jobId = ((await res.json()) as { jobId?: string }).jobId;
    if (!jobId) throw new ReconstructionError('recon /reconstruct returned no jobId');
    logger.info({ scanId: spec.scanId, jobId, base }, 'edge reconstruction job submitted');
    return jobId;
  }

  /**
   * Poll /jobs/{id} until done (or time out). BOTH failure shapes are transient
   * until the deadline: an HTTP non-OK AND a network-level fetch rejection
   * (ECONNREFUSED while the box restarts mid-train) — a 90-minute job must not
   * die to one dropped packet.
   */
  private async awaitJob(base: string, jobId: string): Promise<EdgeJobStatus> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await delay(POLL_INTERVAL_MS);
      let r: Response;
      try {
        r = await fetch(`${base}/jobs/${jobId}`, {
          headers: this.authHeaders(),
          signal: AbortSignal.timeout(POLL_FETCH_TIMEOUT_MS),
        });
      } catch (err) {
        logger.warn({ jobId, err: (err as Error).message }, 'edge poll failed transiently — retrying until deadline');
        continue;
      }
      if (!r.ok) continue;
      const job = (await r.json()) as EdgeJobStatus;
      if (job.status === 'error') throw new ReconstructionError(`edge job failed: ${job.error ?? 'unknown'}`);
      if (job.status === 'done') return job;
    }
    throw new ReconstructionError(`edge job timed out after ${Math.round(POLL_TIMEOUT_MS / 1000)}s`);
  }

  /** GET the produced .splat bytes for a finished job; transient failures retried. */
  private async fetchSplat(base: string, jobId: string): Promise<Buffer> {
    let lastErr = 'unknown';
    for (let attempt = 1; attempt <= SPLAT_FETCH_ATTEMPTS; attempt++) {
      if (attempt > 1) await delay(POLL_INTERVAL_MS);
      let r: Response;
      try {
        r = await fetch(`${base}/jobs/${jobId}/splat`, { headers: this.authHeaders() });
      } catch (err) {
        lastErr = (err as Error).message;
        continue;
      }
      if (!r.ok) {
        lastErr = `status ${r.status}`;
        continue;
      }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length === 0 || buf.length % STRIDE !== 0) {
        throw new ReconstructionError(`edge returned a malformed .splat (${buf.length} bytes)`);
      }
      logger.info({ jobId, bytes: buf.length }, 'edge reconstruction fetched splat');
      return buf;
    }
    throw new ReconstructionError(`recon /jobs/${jobId}/splat failed after ${SPLAT_FETCH_ATTEMPTS} attempts: ${lastErr}`);
  }
}
