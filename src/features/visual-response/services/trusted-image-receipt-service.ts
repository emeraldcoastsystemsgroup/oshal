/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial receipt pipeline for provider-owned Walmart gallery image bytes (backfilled header).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | receiveLocalGalleryImages: accept server-selected ticket-deliverable images — realpath-confined to the shared workspace root and byte-bounded — through the same transcode step as provider URLs (extracted transcode() from receiveOne so both paths emit identical bounded, metadata-free PNGs); sourceUrlSha256 hashes a workspace-relative identity for local sources.
 */

/**
 * Server-side receipt pipeline for provider-owned image bytes.
 *
 * A provider URL is never a client artifact. This service accepts only URLs attached to a
 * schema-validated, post-model Walmart command record, fetches them under a narrow network policy,
 * verifies the claimed and actual raster format, and transcodes the result to a bounded,
 * metadata-free PNG before the deterministic SVG renderer can use it.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { assertPublicHttpUrl } from '@/shared/security/ssrf-guard';
import { resolveSharedWorkspaceRoot } from '@/shared/workspace-root';
import type { GalleryVisualResponseSpec, WalmartCatalogProviderRecord } from '../types';

const MAX_IMAGES = 4;
const MAX_PARALLEL_FETCHES_PER_GALLERY = 2;
const MAX_CONCURRENT_DECODES = 2;
const MAX_SOURCE_BYTES = 3 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 900_000;
const MAX_INPUT_PIXELS = 8_000_000;
const FETCH_TIMEOUT_MS = 6_000;
const OUTPUT_WIDTH = 480;
const OUTPUT_HEIGHT = 320;
const WALMART_IMAGE_HOSTS = new Set(['i5.walmartimages.com']);
let activeDecodes = 0;
const decodeWaiters: Array<() => void> = [];

type SupportedSourceMime = 'image/jpeg' | 'image/png' | 'image/webp';

export interface TrustedImageReceipt {
  sourceRef: string;
  mimeType: 'image/png';
  content: Buffer;
  width: number;
  height: number;
  sourceUrlSha256: string;
  sourceContentSha256: string;
  contentSha256: string;
  sourceBytes: number;
  outputBytes: number;
}

export interface TrustedImageReceiptServiceOptions {
  fetchImpl?: typeof fetch;
  urlGuard?: (url: string) => Promise<void>;
}

/**
 * Receives only the gallery items selected by deterministic Walmart provider grounding. Individual
 * image failures are isolated; callers can fall back to a table when no image survives receipt.
 */
export class TrustedImageReceiptService {
  private readonly fetchImpl: typeof fetch;
  private readonly urlGuard: (url: string) => Promise<void>;

  constructor(options: TrustedImageReceiptServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.urlGuard = options.urlGuard || assertPublicHttpUrl;
  }

  async receiveGalleryImages(
    record: WalmartCatalogProviderRecord,
    spec: GalleryVisualResponseSpec,
  ): Promise<Map<string, TrustedImageReceipt>> {
    const selected = new Set(spec.items.slice(0, MAX_IMAGES).map((item) => item.sourceRef));
    const candidates = record.items
      .filter((item) => selected.has(item.sourceRef))
      .slice(0, MAX_IMAGES);
    const received = new Map<string, TrustedImageReceipt>();
    for (let offset = 0; offset < candidates.length; offset += MAX_PARALLEL_FETCHES_PER_GALLERY) {
      const batch = candidates.slice(offset, offset + MAX_PARALLEL_FETCHES_PER_GALLERY);
      const settled = await Promise.allSettled(batch.map(async (item) => [
        item.sourceRef,
        await this.receiveOne(item.sourceRef, item.imageUrl),
      ] as const));
      settled.forEach((result) => {
        if (result.status === 'fulfilled') received.set(result.value[0], result.value[1]);
      });
    }
    return received;
  }

  /**
   * Receives server-selected ticket deliverables after resolving symlinks beneath the workspace root.
   * `spec` is structural on purpose: both the product `gallery` and the generic `image` kind select
   * their bytes by the same opaque sourceRefs, so both reuse this one guarded path.
   */
  async receiveLocalGalleryImages(
    items: Array<{ sourceRef: string; path: string }>,
    spec: { items: ReadonlyArray<{ sourceRef: string }> },
  ): Promise<Map<string, TrustedImageReceipt>> {
    const root = await fs.realpath(resolveSharedWorkspaceRoot());
    const selected = new Set(spec.items.slice(0, MAX_IMAGES).map((item) => item.sourceRef));
    const received = new Map<string, TrustedImageReceipt>();
    for (const item of items.filter((candidate) => selected.has(candidate.sourceRef)).slice(0, MAX_IMAGES)) {
      try {
        const real = await fs.realpath(item.path);
        if (real !== root && !real.startsWith(`${root}${path.sep}`)) throw new Error('Workspace image escaped the shared root');
        const stat = await fs.stat(real);
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SOURCE_BYTES) throw new Error('Workspace image is outside byte bounds');
        const source = await fs.readFile(real);
        const receipt = await this.transcode(item.sourceRef, source, `workspace:${path.relative(root, real)}`);
        received.set(item.sourceRef, receipt);
      } catch { /* One bad deliverable must not suppress the remaining gallery. */ }
    }
    return received;
  }

  private async receiveOne(sourceRef: string, rawUrl: string): Promise<TrustedImageReceipt> {
    const url = validateWalmartImageUrl(rawUrl);
    await this.urlGuard(url.href);
    const response = await this.fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      headers: {
        Accept: 'image/jpeg, image/png, image/webp',
        'User-Agent': 'OSHAL-Jarvis-Image-Receipt/1.0',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Trusted image provider returned a non-success response');
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_SOURCE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Trusted image exceeds the source byte limit');
    }
    const declaredMime = normalizeSourceMime(response.headers.get('content-type'));
    if (!declaredMime) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Trusted image has an unsupported content type');
    }
    const source = await readBoundedBody(response, MAX_SOURCE_BYTES);
    const detectedMime = detectRasterMime(source);
    if (!detectedMime || detectedMime !== declaredMime) {
      throw new Error('Trusted image content does not match its declared type');
    }
    return this.transcode(sourceRef, source, url.href);
  }

  private async transcode(sourceRef: string, source: Buffer, sourceIdentity: string): Promise<TrustedImageReceipt> {
    const detectedMime = detectRasterMime(source);
    if (!detectedMime) throw new Error('Trusted image has an unsupported format');
    const rendered = await withDecodeSlot(async () => {
      const image = sharp(source, {
        failOn: 'error',
        limitInputPixels: MAX_INPUT_PIXELS,
        sequentialRead: true,
        animated: false,
      });
      const metadata = await image.metadata();
      if (!metadata.format || !['jpeg', 'png', 'webp'].includes(metadata.format)) {
        throw new Error('Trusted image decoder rejected the source format');
      }
      if ((metadata.pages || 1) !== 1) throw new Error('Animated trusted images are not supported');
      return image
        .rotate()
        .resize(OUTPUT_WIDTH, OUTPUT_HEIGHT, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
          withoutEnlargement: true,
        })
        .png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
        .toBuffer({ resolveWithObject: true });
    });
    if (!rendered.info.width || !rendered.info.height || rendered.data.byteLength > MAX_OUTPUT_BYTES) {
      throw new Error('Trusted image output exceeds its bounds');
    }
    return {
      sourceRef,
      mimeType: 'image/png',
      content: rendered.data,
      width: rendered.info.width,
      height: rendered.info.height,
      sourceUrlSha256: sha256(sourceIdentity),
      sourceContentSha256: sha256(source),
      contentSha256: sha256(rendered.data),
      sourceBytes: source.byteLength,
      outputBytes: rendered.data.byteLength,
    };
  }
}

function validateWalmartImageUrl(rawUrl: string): URL {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error('Trusted image URL is invalid'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) {
    throw new Error('Trusted image URL must use credential-free HTTPS');
  }
  if (!WALMART_IMAGE_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('Trusted image host is not approved');
  }
  return url;
}

function normalizeSourceMime(value: string | null): SupportedSourceMime | null {
  const normalized = String(value || '').split(';', 1)[0].trim().toLowerCase();
  if (normalized === 'image/jpg') return 'image/jpeg';
  return normalized === 'image/jpeg' || normalized === 'image/png' || normalized === 'image/webp'
    ? normalized
    : null;
}

function detectRasterMime(bytes: Buffer): SupportedSourceMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

async function readBoundedBody(response: Response, maximum: number): Promise<Buffer> {
  if (!response.body) throw new Error('Trusted image response has no body');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > maximum) throw new Error('Trusted image exceeds the source byte limit');
      chunks.push(chunk);
    }
  } finally {
    if (total > maximum) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (!total) throw new Error('Trusted image response is empty');
  return Buffer.concat(chunks, total);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function withDecodeSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeDecodes >= MAX_CONCURRENT_DECODES) {
    await new Promise<void>((resolve) => decodeWaiters.push(resolve));
  } else {
    activeDecodes += 1;
  }
  try {
    return await work();
  } finally {
    const next = decodeWaiters.shift();
    if (next) next();
    else activeDecodes -= 1;
  }
}
