/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 Phase 1 — the .splat binary packer + a deterministic synthetic-room generator. The .splat format is the de-facto web 3DGS transfer format (antimatter15/splat): N x 32 bytes, no header — position float32[3] @0, scale float32[3] @12 (world-space std-dev, written directly), color RGBA uint8[4] @24, rotation quat uint8[4] @28 (identity = [255,128,128,128]). generateRoomSplat is the SimReconstructionProvider's engine: a real, renderable colored room the vendored viewer displays, seeded off the scan id so output is deterministic (unit-testable) and varies per scan.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Audit fix: export roomDims(seed) — the room's seeded W/D/H — so syntheticPoses can orbit INSIDE the room instead of a corner-origin circle that put most keyframes (and the RF demo's heat blobs) outside the walls. Single authority: generateRoomSplat consumes the same draw sequence.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 geometry export: splatBounds(buffer) — the axis-aligned bbox + per-axis size read straight from the gaussian positions (single-sources the @0 float32[3] layout with packSplat). Powers GET /scans/:id/dimensions — the to-scale footprint of the captured space (metres for a LiDAR import; relative otherwise). Guarded by tests/unit/spatial-geometry-export.spec.ts.
 */

/** Bytes per gaussian record in the .splat format. */
const STRIDE = 32;

/**
 * @description One gaussian in world space. scale is the real std-dev per local
 * axis (NOT log-scale). color is 0-255 sRGB-ish direct. quat defaults to identity.
 */
export interface Gaussian {
  pos: [number, number, number];
  scale: [number, number, number];
  color: [number, number, number, number];
  quat?: [number, number, number, number];
}

/**
 * @description Clamp a number to a 0-255 integer byte.
 * @param n - Value to clamp
 * @returns Integer in [0, 255]
 */
function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

/**
 * @description Pack an array of gaussians into the raw 32-byte-per-record .splat
 * buffer (little-endian, no header) that the vendored WebGL viewer reads.
 * @param gaussians - The gaussians to serialize
 * @returns A Buffer of exactly gaussians.length * 32 bytes
 */
export function packSplat(gaussians: Gaussian[]): Buffer {
  const buf = Buffer.alloc(gaussians.length * STRIDE);
  for (let i = 0; i < gaussians.length; i++) {
    const o = i * STRIDE;
    const g = gaussians[i];
    buf.writeFloatLE(g.pos[0], o); buf.writeFloatLE(g.pos[1], o + 4); buf.writeFloatLE(g.pos[2], o + 8);
    buf.writeFloatLE(g.scale[0], o + 12); buf.writeFloatLE(g.scale[1], o + 16); buf.writeFloatLE(g.scale[2], o + 20);
    buf[o + 24] = clampByte(g.color[0]); buf[o + 25] = clampByte(g.color[1]);
    buf[o + 26] = clampByte(g.color[2]); buf[o + 27] = clampByte(g.color[3]);
    const q = g.quat ?? [255, 128, 128, 128];
    buf[o + 28] = clampByte(q[0]); buf[o + 29] = clampByte(q[1]);
    buf[o + 30] = clampByte(q[2]); buf[o + 31] = clampByte(q[3]);
  }
  return buf;
}

/**
 * @description Axis-aligned bounding box + per-axis size of a packed .splat, read straight
 * from the gaussian POSITIONS (float32[3] @ offset 0 of each 32-byte record). For a metric
 * capture (iPhone/LiDAR import, or an ARKit/fiducial-anchored reconstruction) the numbers are
 * in METRES; for an un-anchored video/sim reconstruction they are relative units. Powers the
 * geometry-export API's real, to-scale footprint of the captured space.
 * @param buffer - The on-disk .splat bytes (length is a multiple of 32).
 * @returns min/max corners, per-axis size, and the gaussian count; null for an empty buffer.
 */
export function splatBounds(
  buffer: Buffer,
): { min: [number, number, number]; max: [number, number, number]; size: [number, number, number]; count: number } | null {
  const count = Math.floor(buffer.length / STRIDE);
  if (count <= 0) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    const o = i * STRIDE;
    for (let a = 0; a < 3; a++) {
      const v = buffer.readFloatLE(o + a * 4);
      if (!Number.isFinite(v)) continue;
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  if (!Number.isFinite(min[0]) || !Number.isFinite(max[0])) return null;
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]], count };
}

/** FNV-1a hash of a string → uint32 seed (deterministic, no crypto needed). */
function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 seeded PRNG → deterministic float in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @description Scatter `count` flat gaussians across an axis-aligned quad
 * (corner + u*a + v*b, a,b in [0,1]) with a small normal jitter and per-splat
 * shade variation, forming a recognizable surface.
 * @param rng - Seeded PRNG
 * @param count - Gaussians to place
 * @param corner - Quad origin
 * @param u - First edge vector (spans the quad)
 * @param v - Second edge vector
 * @param scale - Per-axis std-dev (thin along the surface normal)
 * @param base - Base RGB colour
 * @returns The generated gaussians
 */
function scatterQuad(
  rng: () => number,
  count: number,
  corner: [number, number, number],
  u: [number, number, number],
  v: [number, number, number],
  scale: [number, number, number],
  base: [number, number, number],
): Gaussian[] {
  const out: Gaussian[] = [];
  for (let i = 0; i < count; i++) {
    const a = rng();
    const b = rng();
    const pos: [number, number, number] = [
      corner[0] + u[0] * a + v[0] * b + (rng() - 0.5) * 0.012,
      corner[1] + u[1] * a + v[1] * b + (rng() - 0.5) * 0.012,
      corner[2] + u[2] * a + v[2] * b + (rng() - 0.5) * 0.012,
    ];
    const shade = 0.82 + rng() * 0.32;
    out.push({ pos, scale, color: [base[0] * shade, base[1] * shade, base[2] * shade, 255] });
  }
  return out;
}

/** Per-orientation scale triples (thin axis along the surface normal). */
const FLOOR_SCALE: [number, number, number] = [0.05, 0.01, 0.05];
const WALL_X_SCALE: [number, number, number] = [0.01, 0.05, 0.05];
const WALL_Z_SCALE: [number, number, number] = [0.05, 0.05, 0.01];
const ACCENTS: Array<[number, number, number]> = [
  [70, 120, 200], [200, 90, 80], [90, 170, 120], [180, 140, 70],
];

/** The room's seeded dimensions — MUST be the rng stream's first three draws
 *  so roomDims(seed) and generateRoomSplat(seed) agree on the same room. */
function dimsFromRng(rng: () => number): { w: number; d: number; h: number } {
  const w = 3.6 + rng() * 1.4;
  const d = 3.0 + rng() * 1.5;
  const h = 2.4 + rng() * 0.4;
  return { w, d, h };
}

/**
 * @description The synthetic room's dimensions for a seed — the room spans
 * [0..w]x[0..h]x[0..d] with its corner at the origin. Exported so pose/overlay
 * code can place content INSIDE the same room generateRoomSplat builds.
 * @param seed - Deterministic seed (typically the scan id)
 * @returns Width (x), height (y) and depth (z) of the seeded room
 */
export function roomDims(seed: string): { w: number; d: number; h: number } {
  return dimsFromRng(mulberry32(hashSeed(seed)));
}

/**
 * @description Generate a real, renderable synthetic room as a .splat buffer.
 * Deterministic in `seed` (the scan id) so a given scan always renders the same
 * room and unit tests are stable. This is the SimReconstructionProvider's output
 * — the honest local-dev sibling of a real GPU reconstruction (like SimDroneProvider).
 * @param seed - Deterministic seed (typically the scan id)
 * @returns The packed .splat buffer and its gaussian count
 */
export function generateRoomSplat(seed: string): { buffer: Buffer; count: number } {
  const rng = mulberry32(hashSeed(seed));
  const { w: W, d: D, h: H } = dimsFromRng(rng);
  const density = 85;
  const accent = ACCENTS[Math.floor(rng() * ACCENTS.length)];
  const gs: Gaussian[] = [];
  gs.push(...scatterQuad(rng, Math.round(W * D * density), [0, 0, 0], [W, 0, 0], [0, 0, D], FLOOR_SCALE, [140, 128, 112]));
  gs.push(...scatterQuad(rng, Math.round(W * D * density * 0.8), [0, H, 0], [W, 0, 0], [0, 0, D], FLOOR_SCALE, [210, 210, 214]));
  gs.push(...scatterQuad(rng, Math.round(H * D * density), [0, 0, 0], [0, H, 0], [0, 0, D], WALL_X_SCALE, [188, 188, 196]));
  gs.push(...scatterQuad(rng, Math.round(H * D * density), [W, 0, 0], [0, H, 0], [0, 0, D], WALL_X_SCALE, [188, 188, 196]));
  gs.push(...scatterQuad(rng, Math.round(W * H * density), [0, 0, 0], [W, 0, 0], [0, H, 0], WALL_Z_SCALE, accent));
  gs.push(...scatterQuad(rng, Math.round(W * H * density), [0, 0, D], [W, 0, 0], [0, H, 0], WALL_Z_SCALE, [196, 192, 186]));
  const tw = Math.min(1.2, W * 0.3);
  const td = Math.min(0.7, D * 0.25);
  gs.push(...scatterQuad(rng, 260, [W * 0.32, 0.75, D * 0.34], [tw, 0, 0], [0, 0, td], FLOOR_SCALE, [120, 86, 60]));
  return { buffer: packSplat(gs), count: gs.length };
}
