/**
 * Veo client — generates a single short clip from a text prompt via GCP Vertex AI
 * Veo (the async `predictLongRunning` API). Auth + billing ride the operator's
 * google-workspace OAuth profile (the swarm-default BYOK login) reused from the voice
 * stack's `getGoogleAccessToken()`; the OAuth token must carry the `cloud-platform`
 * scope and `VERTEX_PROJECT` must point at a Vertex-enabled project. API shapes follow
 * the SOP captured in ai-lab/bot-personas/video-bot.yaml.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial Veo predictLongRunning client for the Video Studio thin slice — generate + poll + return clip bytes; operator-GCP billing via the workspace OAuth token.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Auth via a GCP service-account key (GOOGLE_APPLICATION_CREDENTIALS) as primary — minted with a node-crypto JWT (no google-auth-library dep) — falling back to the workspace OAuth profile. Project from VERTEX_PROJECT/GCP_PROJECT_ID.
 *
 * @module video-generation/services/veo-client
 */

import { createChildLogger } from '@/shared/logger';
import { getGoogleCloudPlatformAccessToken } from '@/shared/services';
import type { AspectRatio, Scene } from '../types';

const logger = createChildLogger({ module: 'veo-client' });

/** Veo clamps clip length to a 2–8s window; we honor it so storyboards stay renderable. */
const MIN_CLIP_SEC = 2;
const MAX_CLIP_SEC = 8;
/** Operation poll cadence + ceiling (Veo clips take ~2–5 min). */
const POLL_INTERVAL_MS = 6_000;
const POLL_TIMEOUT_MS = 8 * 60_000;

/** A single generated clip plus the seconds it was billed for. */
export interface GeneratedClip {
  mp4: Buffer;
  durationSec: number;
}

/** Resolve the Vertex model/project/location from env (operator-configured). */
function veoConfig(): { project: string; location: string; model: string } {
  const project = process.env.VERTEX_PROJECT || process.env.GCP_PROJECT_ID || '';
  if (!project) {
    throw new Error('VERTEX_PROJECT (or GCP_PROJECT_ID) is not set — Veo generation needs a Vertex-enabled GCP project.');
  }
  return {
    project,
    location: process.env.VERTEX_LOCATION || process.env.GCP_LOCATION || 'us-central1',
    model: process.env.VERTEX_VEO_MODEL || 'veo-3.1-generate-001',
  };
}

/**
 * @description Resolve a cloud-platform access token for Vertex. Prefers a service-account key
 * at GOOGLE_APPLICATION_CREDENTIALS (durable, non-interactive); falls back to the operator's
 * google-workspace OAuth profile (must carry the cloud-platform scope).
 * @returns a Bearer access token
 */
export async function getVertexAccessToken(callerAccessToken?: string): Promise<string> {
  // Per-user billing (the rule): paid generation uses the CALLER's own connected GCP, never the
  // swarm's. A caller-supplied token wins. The swarm service-account key is operator/test-only and
  // is used ONLY when explicitly opted in — so a "simple vid" can never silently bill the swarm.
  if (callerAccessToken) return callerAccessToken;
  if (process.env.VEO_ALLOW_SWARM_BILLING === 'true') {
    return getGoogleCloudPlatformAccessToken();
  }
  throw new Error(
    'Veo needs the caller\'s own connected GCP account (per-user billing) — the swarm does not pay for generation. ' +
    'Connect your GCP, or set VEO_ALLOW_SWARM_BILLING=true for operator testing only.',
  );
}

/** Vertex project + location resolved from env (shared by the Imagen client). */
export function vertexProjectLocation(): { project: string; location: string } {
  const { project, location } = veoConfig();
  return { project, location };
}

/** Base URL for a publisher model in the configured project/location. */
function modelBaseUrl(): string {
  const { project, location, model } = veoConfig();
  return `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}`;
}

/** Clamp a requested clip length into Veo's supported window. */
export function clampClipSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return MIN_CLIP_SEC;
  return Math.max(MIN_CLIP_SEC, Math.min(MAX_CLIP_SEC, Math.round(seconds)));
}

/**
 * @description Per-second USD cost estimate for Veo, by resolution tier. 720p (draft) is far
 * cheaper than 1080p (final); both are operator-overridable via env. These are planning rates,
 * not a measured bill.
 * @param resolution - '720p' (cheap draft) or '1080p' (final)
 */
export function veoCostPerSecond(resolution: VeoResolution = '720p'): number {
  const env = Number(resolution === '720p' ? process.env.VERTEX_VEO_COST_PER_SEC_720 : process.env.VERTEX_VEO_COST_PER_SEC);
  if (Number.isFinite(env) && env > 0) return env;
  return resolution === '720p' ? 0.1 : 0.4;
}

/** Veo output resolution. '720p' is the cheaper/faster draft tier; '1080p' is the final tier. */
export type VeoResolution = '720p' | '1080p';

/** Kick off a long-running generation and return the operation name. */
async function startGeneration(accessToken: string, prompt: string, durationSec: number, aspectRatio: AspectRatio, resolution: VeoResolution): Promise<string> {
  const body = {
    instances: [{ prompt }],
    parameters: { durationSeconds: durationSec, aspectRatio, resolution, sampleCount: 1, generateAudio: false },
  };
  const res = await fetch(`${modelBaseUrl()}:predictLongRunning`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Veo predictLongRunning ${res.status}: ${(await res.text()).slice(0, 240)}`);
  }
  const json = (await res.json()) as { name?: string };
  if (!json.name) throw new Error('Veo predictLongRunning returned no operation name');
  return json.name;
}

/** Shape of a finished Veo operation we care about. */
interface VeoOperation {
  done?: boolean;
  error?: { message?: string };
  response?: { videos?: Array<{ bytesBase64Encoded?: string; gcsUri?: string }> };
}

/** Poll one fetchPredictOperation call. */
async function fetchOperation(accessToken: string, operationName: string): Promise<VeoOperation> {
  const res = await fetch(`${modelBaseUrl()}:fetchPredictOperation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ operationName }),
  });
  if (!res.ok) {
    throw new Error(`Veo fetchPredictOperation ${res.status}: ${(await res.text()).slice(0, 240)}`);
  }
  return (await res.json()) as VeoOperation;
}

/** Sleep helper (poll backoff). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until the operation is done (or times out), returning the clip bytes. */
async function awaitClip(accessToken: string, operationName: string): Promise<Buffer> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const op = await fetchOperation(accessToken, operationName);
    if (op.error) throw new Error(`Veo generation failed: ${op.error.message || 'unknown error'}`);
    if (op.done) {
      const b64 = op.response?.videos?.[0]?.bytesBase64Encoded;
      if (!b64) throw new Error('Veo operation completed but returned no inline video bytes (set no storageUri).');
      return Buffer.from(b64, 'base64');
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Veo generation timed out after ${Math.round(POLL_TIMEOUT_MS / 1000)}s`);
}

/**
 * @description Generate one clip for a storyboard scene. Clamps the duration to Veo's
 * window, starts the long-running job, polls to completion, and returns the mp4 bytes.
 * @param scene - the scene whose `prompt` + `durationSec` drive generation
 * @param aspectRatio - output framing from the user's shape
 * @param resolution - '720p' for the cheap draft tier, '1080p' for the final tier (default 1080p)
 * @returns the generated clip bytes + the (clamped) seconds it represents
 */
export async function generateClip(scene: Scene, aspectRatio: AspectRatio, resolution: VeoResolution = '1080p'): Promise<GeneratedClip> {
  const durationSec = clampClipSeconds(scene.durationSec);
  const accessToken = await getVertexAccessToken();
  logger.info({ durationSec, aspectRatio, resolution, promptChars: scene.prompt.length }, 'Veo clip generation start');
  const operationName = await startGeneration(accessToken, scene.prompt, durationSec, aspectRatio, resolution);
  const mp4 = await awaitClip(accessToken, operationName);
  logger.info({ durationSec, bytes: mp4.length }, 'Veo clip generation done');
  return { mp4, durationSec };
}
