/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Storyboard frames: turn a screenwriter's per-scene camera line into the still image the renderer animates. Cast consistency via an anchor frame; white-page margins cropped; near-duplicate scenes rejected before any video credit is spent.
 */
/**
 * @description Storyboard frames — the missing stage between WRITE and RENDER.
 *
 * The screenplay-writer emits, per scene, a `camera` line naming the shot, the distance, and who is
 * in frame. Nothing renders from text alone: every scene is animated FROM A STILL IMAGE. This module
 * makes those stills.
 *
 * Three things here are not incidental — each one is a failure we paid for:
 *
 *   ANCHOR. Scene 1's frame becomes the reference image for every later scene, so the cast does not
 *   drift between shots. Without it, a series' characters are redesigned every eight seconds.
 *
 *   CROP. The image model draws a white page margin around anything it reads as a "wide" or
 *   "cinematic" shot, and no prompt wording reliably stops it (three attempts). A letterboxed still
 *   renders with bars. We crop the artwork's bounding box deterministically instead of paying for
 *   another generation.
 *
 *   DISTINCTNESS. Frame prompts that differ only in a vague phrase produce the same wide group shot
 *   every scene — the operator's verdict on one such series was "it's just one scene over and over",
 *   and it was deleted. Frames are perceptually hashed and near-duplicates are REJECTED here, before
 *   a single video credit is spent.
 *
 * Auth is the caller's own Google access token (per-user billing). The swarm's service-account key is
 * never used implicitly; see getVertexAccessToken.
 *
 * @module features/video-generation/services/storyboard-frames
 */

import * as zlib from 'zlib';
import { createChildLogger } from '@/shared/logger';
import { resolveStoryboardImageProvider, type StoryboardImageProvider } from './storyboard-image-providers';

const logger = createChildLogger({ module: 'storyboard-frames' });

/** Below this many differing bits (of 256) two frames read as the same shot. */
const MIN_DIFF_BITS = 28;
/** A channel value at or above this counts as "page white". */
const WHITE = 244;
/** Retry ceiling for a rate-limited or empty generation. */
const MAX_ATTEMPTS = 5;

/** @description One scene's storyboard request. */
export interface SceneFramePlan {
  /** 1-based scene number. */
  n: number;
  /** The screenwriter's camera line: shot type, distance, who is in frame. */
  camera: string;
}

/** @description A generated still, plus what we learned about it. */
export interface StoryboardFrame {
  n: number;
  png: Buffer;
  width: number;
  height: number;
  cropped: boolean;
}

/** @description Everything the storyboard stage needs from the series bible. */
export interface StoryboardContext {
  /** The style lock: medium and look, restated on every frame so the series holds together. */
  styleLock: string;
  /** Cast, as `Name = description` — the descriptions the renderer later points speakers at. */
  cast: Array<{ name: string; description: string }>;
  /**
   * The image provider. Omit and one is resolved from STORYBOARD_IMAGE_PROVIDER (default: codex).
   * The vendor is never welded in here — see storyboard-image-providers.ts.
   */
  provider?: StoryboardImageProvider;
  /** A Google token, only used when the selected provider is `vertex`. */
  vertexToken?: string;
}

/* ────────────────────────────── PNG: decode, crop, re-encode ────────────────────────────── */

interface RawImage { w: number; h: number; ch: number; px: Buffer }

/** @description Decode an 8-bit truecolour (optionally alpha), non-interlaced PNG. @param {Buffer} buf png bytes @returns {RawImage} raw pixels */
function decodePng(buf: Buffer): RawImage {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let pos = 8;
  let w = 0; let h = 0; let color = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      if (data[8] !== 8 || (data[9] !== 2 && data[9] !== 6)) throw new Error(`unsupported png (depth ${data[8]}, color ${data[9]})`);
      if (data[12] !== 0) throw new Error('interlaced png unsupported');
      color = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = color === 6 ? 4 : 3;
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride); rp += stride;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, ch, px: out };
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

/** @description CRC-32 over a buffer (PNG chunk checksum). @param {Buffer} buf bytes @returns {number} crc */
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @description Build one PNG chunk. @param {string} type 4-char type @param {Buffer} data payload @returns {Buffer} chunk */
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** @description Re-encode raw pixels as a PNG (filter none). @param {RawImage} img raw pixels @returns {Buffer} png bytes */
function encodePng(img: RawImage): Buffer {
  const stride = img.w * img.ch;
  const raw = Buffer.alloc(img.h * (stride + 1));
  for (let y = 0; y < img.h; y++) {
    raw[y * (stride + 1)] = 0;
    img.px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.w, 0); ihdr.writeUInt32BE(img.h, 4);
  ihdr[8] = 8; ihdr[9] = img.ch === 4 ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const isWhite = (img: RawImage, x: number, y: number): boolean => {
  const i = y * img.w * img.ch + x * img.ch;
  return img.px[i] >= WHITE && img.px[i + 1] >= WHITE && img.px[i + 2] >= WHITE;
};

/**
 * @description Crop the white page margin the image model draws around wide panels. Idempotent: a
 * clean full-bleed frame comes back untouched. Refuses a crop that would remove most of the image
 * (that would mean the art itself is pale, not that there is a border).
 * @param {Buffer} png the generated frame
 * @returns {{png: Buffer, cropped: boolean, width: number, height: number}} possibly-cropped frame
 */
export function cropWhiteMargins(png: Buffer): { png: Buffer; cropped: boolean; width: number; height: number } {
  const img = decodePng(png);
  const rowWhite = (y: number): boolean => { for (let x = 0; x < img.w; x++) if (!isWhite(img, x, y)) return false; return true; };
  const colWhite = (x: number): boolean => { for (let y = 0; y < img.h; y++) if (!isWhite(img, x, y)) return false; return true; };
  let top = 0; let bot = img.h - 1; let left = 0; let right = img.w - 1;
  while (top < bot && rowWhite(top)) top++;
  while (bot > top && rowWhite(bot)) bot--;
  while (left < right && colWhite(left)) left++;
  while (right > left && colWhite(right)) right--;

  const margin = 2;
  const t = Math.max(0, top - margin); const b = Math.min(img.h - 1, bot + margin);
  const l = Math.max(0, left - margin); const r = Math.min(img.w - 1, right + margin);
  const nw = r - l + 1; const nh = b - t + 1;
  if (nw === img.w && nh === img.h) return { png, cropped: false, width: img.w, height: img.h };
  if (nw < img.w * 0.4 || nh < img.h * 0.4) {
    logger.warn({ from: `${img.w}x${img.h}`, to: `${nw}x${nh}` }, 'refusing a crop that would remove most of the frame');
    return { png, cropped: false, width: img.w, height: img.h };
  }
  const out = Buffer.alloc(nh * nw * img.ch);
  for (let y = 0; y < nh; y++) {
    img.px.copy(out, y * nw * img.ch, (t + y) * img.w * img.ch + l * img.ch, (t + y) * img.w * img.ch + (r + 1) * img.ch);
  }
  return { png: encodePng({ w: nw, h: nh, ch: img.ch, px: out }), cropped: true, width: nw, height: nh };
}

/* ────────────────────────────── distinctness: perceptual hash ────────────────────────────── */

/** @description 16x16 average-hash of a frame — one bit per cell, set when brighter than the mean. @param {Buffer} png frame @returns {number[]} 256 bits */
export function averageHash(png: Buffer): number[] {
  const img = decodePng(png);
  const GRID = 16;
  const gray = (x: number, y: number): number => {
    const i = y * img.w * img.ch + x * img.ch;
    return (img.px[i] * 299 + img.px[i + 1] * 587 + img.px[i + 2] * 114) / 1000;
  };
  const cells: number[] = [];
  const cw = img.w / GRID; const chh = img.h / GRID;
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const x0 = Math.floor(gx * cw); const x1 = Math.max(x0 + 1, Math.floor((gx + 1) * cw));
      const y0 = Math.floor(gy * chh); const y1 = Math.max(y0 + 1, Math.floor((gy + 1) * chh));
      let sum = 0; let n = 0;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { sum += gray(x, y); n++; }
      cells.push(sum / n);
    }
  }
  const mean = cells.reduce((s, v) => s + v, 0) / cells.length;
  return cells.map((v) => (v > mean ? 1 : 0));
}

/** @description Bits that differ between two hashes. @param {number[]} a hash @param {number[]} b hash @returns {number} distance */
export const hammingDistance = (a: number[], b: number[]): number => a.reduce((s, v, i) => s + (v === b[i] ? 0 : 1), 0);

/**
 * @description Reject a storyboard whose scenes are the same shot repeated. This runs BEFORE any
 * video generation, because that is the only point where the mistake is still free.
 * @param {StoryboardFrame[]} frames the generated stills
 * @returns {{ok: boolean, duplicates: string[]}} verdict plus the offending pairs
 */
export function assertDistinctShots(frames: StoryboardFrame[]): { ok: boolean; duplicates: string[] } {
  const hashes = frames.map((f) => ({ n: f.n, h: averageHash(f.png) }));
  const duplicates: string[] = [];
  for (let i = 0; i < hashes.length; i++) {
    for (let j = i + 1; j < hashes.length; j++) {
      const d = hammingDistance(hashes[i].h, hashes[j].h);
      if (d < MIN_DIFF_BITS) duplicates.push(`scene ${hashes[i].n} vs ${hashes[j].n} (${d}/256 bits differ, need >=${MIN_DIFF_BITS})`);
    }
  }
  return { ok: duplicates.length === 0, duplicates };
}

/* ────────────────────────────── generation ────────────────────────────── */

/** @description The tail every frame prompt carries. Stated last, because recency beats the writer's vivid nouns. */
function promptTail(): string {
  return 'CRITICAL: this is a SQUARE full-bleed illustration — the artwork must reach every edge. '
    + 'NO white borders, NO letterbox bars, NO page margins, NO picture frame. '
    + 'Show any sound or noise as physical action and facial expression ONLY. '
    + 'Absolutely NO text anywhere in the image — no letters, no words, no numbers, no speech bubbles, '
    + 'no sound-effect words, no labels, no signs with writing.';
}

/**
 * @description Generate one storyboard still. When an anchor frame is supplied it is sent as a
 * reference image so the cast and world stay identical across scenes.
 * @param {SceneFramePlan} scene the scene's camera line
 * @param {StoryboardContext} ctx style lock, cast, caller token
 * @param {Buffer | null} anchor scene 1's frame, or null when generating the anchor itself
 * @returns {Promise<StoryboardFrame>} the still, cropped if it came back on a white page
 */
export async function generateStoryboardFrame(
  scene: SceneFramePlan,
  ctx: StoryboardContext,
  anchor: Buffer | null,
): Promise<StoryboardFrame> {
  const provider = ctx.provider ?? await resolveStoryboardImageProvider({ vertexToken: ctx.vertexToken });

  const castLock = ctx.cast.map((c) => `${c.name} = ${c.description}`).join(' | ');
  const prompt = anchor
    ? `Use the reference image for the EXACT character designs, art style, and world. Cast: ${castLock}. `
      + `New storyboard panel: ${scene.camera} ${promptTail()}`
    : `Full-bleed square storyboard panel. ${scene.camera} `
      + `The cast, each with EXACTLY this design: ${castLock}. Style: ${ctx.styleLock}. ${promptTail()}`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const raw = await provider.generate(prompt, anchor);
      const { png, cropped, width, height } = cropWhiteMargins(raw);
      logger.info({ scene: scene.n, provider: provider.id, bytes: png.length, cropped, size: `${width}x${height}` }, 'storyboard frame generated');
      return { n: scene.n, png, width, height, cropped };
    } catch (err) {
      const msg = (err as Error).message;
      // Only transient conditions are retried. A misconfiguration must surface immediately rather
      // than burn five attempts against a provider that will never answer.
      const transient = /RATE_LIMITED|EMPTY_RESPONSE|\b(429|500|502|503|504)\b/.test(msg);
      if (!transient || attempt === MAX_ATTEMPTS) throw new Error(`storyboard frame ${scene.n} (${provider.id}): ${msg}`);
      const backoff = /RATE_LIMITED|429/.test(msg) ? 25_000 : 8_000;
      logger.warn({ scene: scene.n, provider: provider.id, attempt, msg }, 'storyboard frame transient failure — backing off');
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw new Error(`storyboard frame ${scene.n}: no image after ${MAX_ATTEMPTS} attempts`);
}

/**
 * @description Generate a whole episode's storyboard: scene 1 becomes the anchor, the rest reference
 * it, and the set is rejected if two scenes are the same shot.
 * @param {SceneFramePlan[]} scenes the episode's camera lines, in order
 * @param {StoryboardContext} ctx style lock, cast, caller token
 * @param {Buffer} [seriesAnchor] a series-level anchor (e.g. the intro frame) to hold the cast across episodes
 * @returns {Promise<{frames: StoryboardFrame[], distinct: {ok: boolean, duplicates: string[]}}>} the stills + the distinctness verdict
 */
export async function generateEpisodeStoryboard(
  scenes: SceneFramePlan[],
  ctx: StoryboardContext,
  seriesAnchor?: Buffer,
): Promise<{ frames: StoryboardFrame[]; distinct: { ok: boolean; duplicates: string[] } }> {
  if (!scenes.length) throw new Error('no scenes to storyboard');
  // Resolve once: a misconfigured provider should fail before the first image, not on scene three.
  const provider = ctx.provider ?? await resolveStoryboardImageProvider({ vertexToken: ctx.vertexToken });
  const withProvider: StoryboardContext = { ...ctx, provider };

  const frames: StoryboardFrame[] = [];
  let anchor: Buffer | null = seriesAnchor ?? null;

  for (const scene of scenes) {
    // eslint-disable-next-line no-await-in-loop
    const frame = await generateStoryboardFrame(scene, withProvider, anchor);
    frames.push(frame);
    if (!anchor) anchor = frame.png; // scene 1 anchors the rest
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 4_000)); // pace the image endpoint
  }

  const distinct = assertDistinctShots(frames);
  if (!distinct.ok) logger.warn({ duplicates: distinct.duplicates }, 'storyboard has near-duplicate shots — refuse to render');
  return { frames, distinct };
}
