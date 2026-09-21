/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 Phase 1 — on-disk layout for scan media. Source video + produced .splat are large local binaries (galleries/media = LOCAL workspace files, not the 250MB oshal-local artifact quota and not a BYTEA column). Paths are keyed by sha256(userSub)[:32] so the raw sub never appears on disk; the route and the service share these helpers so they agree on where bytes land.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | CKR-17 step 2: the inline workspace-root chain here resolves through resolveSharedWorkspaceRoot() like every other site. It read ONE of the six. The tmpdir fallback is deliberate and KEPT - outside a container there is no shared mount and a scan must still land somewhere writable - so the presence test asks whether a root is CONFIGURED rather than what the resolver would invent.
 */

import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import { hasConfiguredWorkspaceRoot, resolveSharedWorkspaceRoot } from '@/shared/workspace-root';

/**
 * @description Resolve the root directory that holds every user's scan media.
 * In-container this is the shared workspace mount; for local ts-node dev
 * (no container) it falls back to a writable temp dir so MOCK_OIDC runs work.
 * @returns Absolute path to the scans root
 */
export function resolveScansRoot(): string {
  if (process.env.OSHAL_SPACES_ROOT) return process.env.OSHAL_SPACES_ROOT;
  if (hasConfiguredWorkspaceRoot()) return path.join(resolveSharedWorkspaceRoot(), 'spaces-scans');
  return path.join(os.tmpdir(), 'oshal-spaces-scans');
}

/**
 * @description Opaque per-user directory name (never the raw sub) for on-disk media.
 * @param userSub - Owning user's sub claim
 * @returns A 32-char hex hash safe as a path segment
 */
export function subHash(userSub: string): string {
  return createHash('sha256').update(userSub).digest('hex').slice(0, 32);
}

/**
 * @description Absolute directory holding one scan's source + artifact files.
 * @param userSub - Owning user's sub
 * @param scanId - The scan id
 * @returns Absolute directory path
 */
export function scanDir(userSub: string, scanId: string): string {
  return path.join(resolveScansRoot(), subHash(userSub), scanId);
}

/**
 * @description Absolute path where a scan's produced .splat artifact is written.
 * @param userSub - Owning user's sub
 * @param scanId - The scan id
 * @returns Absolute file path
 */
export function artifactPath(userSub: string, scanId: string): string {
  return path.join(scanDir(userSub, scanId), 'scene.splat');
}

/**
 * @description Absolute path where a scan's camera-pose sidecar (poses.json) is
 * written — the ADR-111 increment-A pose set, next to the .splat it aligns with.
 * @param userSub - Owning user's sub
 * @param scanId - The scan id
 * @returns Absolute file path
 */
export function posesPath(userSub: string, scanId: string): string {
  return path.join(scanDir(userSub, scanId), 'poses.json');
}

/** @description Path to a scan's RF coverage overlay artifact (dimmed room + heat + router marker). */
export function rfOverlayPath(userSub: string, scanId: string): string {
  return path.join(scanDir(userSub, scanId), 'rf-overlay.splat');
}

/** @description Path to a scan's stored RF samples (the {position->rssi} set). */
export function rfSamplesPath(userSub: string, scanId: string): string {
  return path.join(scanDir(userSub, scanId), 'rf-samples.json');
}

/** @description Path to a scan's RF overlay summary (transmitter estimates + coverage stats). */
export function rfSummaryPath(userSub: string, scanId: string): string {
  return path.join(scanDir(userSub, scanId), 'rf-summary.json');
}

/**
 * @description Owner-scoped JSONL sidecar for one live guided-capture session's
 * phone telemetry (heading/sweep/steps/GPS). Sessions predate any scan row, so
 * they live under a per-user `capture-sessions/` dir keyed by the session UUID —
 * callers MUST validate the id against CAPTURE_SESSION_ID_RE before calling.
 * @param userSub - Owning user's sub
 * @param sessionId - Strictly-validated session UUID
 * @returns Absolute file path
 */
export function captureTelemetryPath(userSub: string, sessionId: string): string {
  return path.join(resolveScansRoot(), subHash(userSub), 'capture-sessions', `${sessionId}.jsonl`);
}
