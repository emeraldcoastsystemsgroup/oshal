/**
 * Imagen client — generates a still key-frame image from a text prompt via GCP Vertex AI
 * Imagen (the synchronous `predict` API). Used by the staged video pipeline's first stage to
 * produce cheap storyboard stills a human approves before any (pricier) video is generated.
 * Auth + project resolution are shared with the Veo client (operator service-account key).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial Imagen predict client for the staged Video Studio (storyboard key-frames).
 *
 * @module video-generation/services/image-client
 */

import { createChildLogger } from '@/shared/logger';
import type { AspectRatio } from '../types';
import { getVertexAccessToken, vertexProjectLocation } from './veo-client';

const logger = createChildLogger({ module: 'imagen-client' });

/** A generated still image. */
export interface GeneratedImage {
  png: Buffer;
  mimeType: string;
}

/** Resolve the Imagen model (operator-configurable). */
function imagenModel(): string {
  return process.env.VERTEX_IMAGEN_MODEL || 'imagen-4.0-generate-001';
}

/** Per-image USD cost estimate (operator-configurable; default a planning rate). */
export function imagenCostPerImage(): number {
  const raw = Number(process.env.VERTEX_IMAGEN_COST_PER_IMAGE);
  return Number.isFinite(raw) && raw > 0 ? raw : 0.04;
}

/**
 * @description Generate one still image from a prompt via Imagen `predict` (synchronous —
 * returns inline base64, unlike Veo's long-running poll). Mirrors the request/response shape
 * used by any-bot's vertexAITools generate-image.
 * @param prompt - the image prompt (a storyboard scene's visual description)
 * @param aspectRatio - output framing (matches the video's framing)
 * @returns the PNG bytes + mime type
 */
export async function generateImage(prompt: string, aspectRatio: AspectRatio): Promise<GeneratedImage> {
  const { project, location } = vertexProjectLocation();
  const token = await getVertexAccessToken();
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${imagenModel()}:predict`;
  const body = { instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio } };
  logger.info({ aspectRatio, promptChars: prompt.length }, 'Imagen generation start');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Imagen predict ${res.status}: ${(await res.text()).slice(0, 240)}`);
  const json = (await res.json()) as { predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }> };
  const pred = json.predictions?.[0];
  if (!pred?.bytesBase64Encoded) throw new Error('Imagen returned no image bytes');
  logger.info({ bytes: pred.bytesBase64Encoded.length }, 'Imagen generation done');
  return { png: Buffer.from(pred.bytesBase64Encoded, 'base64'), mimeType: pred.mimeType || 'image/png' };
}
