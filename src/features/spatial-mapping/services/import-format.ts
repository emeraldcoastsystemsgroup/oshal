/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 direct-import lane — a real .ply -> .splat converter so a 3D capture a user exported from their OWN device (iPhone/iPad LiDAR via Polycam/Scaniverse, a depth scanner, a drone photogrammetry app) renders in the vendored WebGL viewer with NO GPU/recon box. Handles both .ply flavors: a colored POINT CLOUD (each point -> a small isotropic gaussian sized off the cloud's bounding box) and a trained 3D GAUSSIAN SPLAT .ply (f_dc SH colour, exp(scale), opacity sigmoid, rotation quaternion). ASCII + binary_little/big_endian. A raw .splat passes through validated. Output is capped at MAX_GAUSSIANS with a LOGGED stride-subsample (CLAUDE.md: no silent caps). Packs via the same splat-format packSplat so the on-disk format stays single-sourced.
 */

import { createChildLogger } from '@/shared/logger';
import { packSplat, type Gaussian } from './splat-format';

const logger = createChildLogger({ module: 'import-format' });

/** Bytes per gaussian in the .splat format (matches splat-format STRIDE). */
const STRIDE = 32;
/** Spherical-harmonics DC band-0 constant: rgb = 0.5 + SH_C0 * f_dc. */
const SH_C0 = 0.28209479177387814;
/** Viewer-performance ceiling; larger inputs are stride-subsampled (and logged). */
const MAX_GAUSSIANS = 2_000_000;

/** A parsed PLY property (name + scalar type). */
interface PlyProperty {
  name: string;
  type: string;
}

/** Parsed PLY header: encoding, vertex count, vertex properties, data offset. */
interface PlyHeader {
  format: 'ascii' | 'binary_le' | 'binary_be';
  vertexCount: number;
  props: PlyProperty[];
  dataStart: number;
}

/** The result of a conversion: packed bytes + the gaussian count. */
export interface ImportedSplat {
  buffer: Buffer;
  count: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const clamp01 = (v: number): number => clamp(v, 0, 1);
const sigmoid = (v: number): number => 1 / (1 + Math.exp(-v));

/** exp() of a log-scale, guarded against NaN/Inf and clamped to a sane world size. */
function expScale(v: number): number {
  if (!Number.isFinite(v)) return 0.01;
  return clamp(Math.exp(v), 0.0005, 3);
}

/** Byte size of a PLY scalar type. */
function typeSize(t: string): number {
  switch (t) {
    case 'char': case 'uchar': case 'int8': case 'uint8': return 1;
    case 'short': case 'ushort': case 'int16': case 'uint16': return 2;
    case 'int': case 'uint': case 'int32': case 'uint32': case 'float': case 'float32': return 4;
    case 'double': case 'float64': return 8;
    default: return 0;
  }
}

/** Read one PLY scalar from a DataView at an offset. */
function readScalar(view: DataView, off: number, type: string, le: boolean): number {
  switch (type) {
    case 'char': case 'int8': return view.getInt8(off);
    case 'uchar': case 'uint8': return view.getUint8(off);
    case 'short': case 'int16': return view.getInt16(off, le);
    case 'ushort': case 'uint16': return view.getUint16(off, le);
    case 'int': case 'int32': return view.getInt32(off, le);
    case 'uint': case 'uint32': return view.getUint32(off, le);
    case 'float': case 'float32': return view.getFloat32(off, le);
    case 'double': case 'float64': return view.getFloat64(off, le);
    default: return 0;
  }
}

/**
 * @description Parse a PLY header up to and including `end_header`.
 * @param buf - The full PLY file bytes
 * @returns The parsed header (format, vertex count, vertex properties, data offset)
 */
function parsePlyHeader(buf: Buffer): PlyHeader {
  const marker = buf.indexOf('end_header');
  if (buf.subarray(0, 3).toString('ascii') !== 'ply' || marker < 0) {
    throw new Error('not a PLY file (missing ply magic / end_header)');
  }
  const nl = buf.indexOf('\n', marker);
  const dataStart = nl + 1;
  const lines = buf.subarray(0, marker).toString('ascii').split('\n').map((l) => l.trim());
  let format: PlyHeader['format'] = 'ascii';
  let vertexCount = 0;
  let inVertex = false;
  const props: PlyProperty[] = [];
  for (const line of lines) {
    const p = line.split(/\s+/);
    if (p[0] === 'format') format = p[1] === 'binary_big_endian' ? 'binary_be' : p[1] === 'binary_little_endian' ? 'binary_le' : 'ascii';
    else if (p[0] === 'element') { inVertex = p[1] === 'vertex'; if (inVertex) vertexCount = parseInt(p[2], 10) || 0; }
    else if (p[0] === 'property' && inVertex && p[1] !== 'list') props.push({ type: p[1], name: p[2] });
  }
  if (vertexCount <= 0 || props.length === 0) throw new Error('PLY has no vertex element / properties');
  return { format, vertexCount, props, dataStart };
}

/** Sample every `step`-th vertex, returning each as a name->value record. */
function readVertices(buf: Buffer, header: PlyHeader, step: number): Array<Record<string, number>> {
  return header.format === 'ascii'
    ? readAsciiVertices(buf, header, step)
    : readBinaryVertices(buf, header, step);
}

/** Read sampled vertices from an ASCII PLY body. */
function readAsciiVertices(buf: Buffer, header: PlyHeader, step: number): Array<Record<string, number>> {
  const body = buf.subarray(header.dataStart).toString('ascii').split('\n');
  const out: Array<Record<string, number>> = [];
  for (let i = 0; i < header.vertexCount; i += step) {
    const cols = body[i]?.trim().split(/\s+/);
    if (!cols || cols.length < header.props.length) continue;
    const rec: Record<string, number> = {};
    header.props.forEach((pr, k) => { rec[pr.name] = parseFloat(cols[k]); });
    out.push(rec);
  }
  return out;
}

/** Read sampled vertices from a binary PLY body. */
function readBinaryVertices(buf: Buffer, header: PlyHeader, step: number): Array<Record<string, number>> {
  const le = header.format === 'binary_le';
  const offs: number[] = [];
  let stride = 0;
  for (const pr of header.props) { offs.push(stride); stride += typeSize(pr.type); }
  if (stride === 0) throw new Error('PLY vertex has zero-width properties');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: Array<Record<string, number>> = [];
  for (let i = 0; i < header.vertexCount; i += step) {
    const base = header.dataStart + i * stride;
    if (base + stride > buf.byteLength) break;
    const rec: Record<string, number> = {};
    header.props.forEach((pr, k) => { rec[pr.name] = readScalar(view, base + offs[k], pr.type, le); });
    out.push(rec);
  }
  return out;
}

/** Encode a (possibly unnormalized) quaternion to the .splat's 0-255 byte quad. */
function quatBytes(w: number, x: number, y: number, z: number): [number, number, number, number] {
  const n = Math.hypot(w, x, y, z) || 1;
  const b = (v: number): number => clamp(Math.round((v / n) * 128 + 128), 0, 255);
  return [b(w), b(x), b(y), b(z)];
}

/** Build a gaussian from a trained-3DGS vertex record. */
function gaussianFrom3dgs(v: Record<string, number>): Gaussian {
  const col = (f: number): number => clamp01(0.5 + SH_C0 * f) * 255;
  const alpha = v.opacity !== undefined ? sigmoid(v.opacity) * 255 : 255;
  return {
    pos: [v.x, v.y, v.z],
    scale: [expScale(v.scale_0), expScale(v.scale_1), expScale(v.scale_2)],
    color: [col(v.f_dc_0), col(v.f_dc_1), col(v.f_dc_2), alpha],
    quat: v.rot_0 !== undefined ? quatBytes(v.rot_0, v.rot_1, v.rot_2, v.rot_3) : undefined,
  };
}

/** How a point-cloud PLY carries per-vertex colour (name keys + 0-1 vs 0-255). */
interface ColorPlan { r: string; g: string; b: string; to255: boolean }

/** Resolve the colour source of a point cloud, or null if it is uncoloured. */
function resolveColorPlan(props: PlyProperty[]): ColorPlan | null {
  const byName = new Map(props.map((p) => [p.name, p.type]));
  const trip = (r: string, g: string, b: string): ColorPlan | null =>
    byName.has(r) && byName.has(g) && byName.has(b)
      ? { r, g, b, to255: (byName.get(r) || '').startsWith('float') || byName.get(r) === 'double' }
      : null;
  return trip('red', 'green', 'blue') ?? trip('r', 'g', 'b') ?? trip('diffuse_red', 'diffuse_green', 'diffuse_blue');
}

/** Build a gaussian from a plain point-cloud vertex at a fixed isotropic scale. */
function gaussianFromPoint(v: Record<string, number>, scale: number, plan: ColorPlan | null): Gaussian {
  const s: [number, number, number] = [scale, scale, scale];
  if (!plan) return { pos: [v.x, v.y, v.z], scale: s, color: [200, 200, 200, 255] };
  const f = plan.to255 ? 255 : 1;
  return { pos: [v.x, v.y, v.z], scale: s, color: [v[plan.r] * f, v[plan.g] * f, v[plan.b] * f, 255] };
}

/** Isotropic gaussian size for a point cloud: a fraction of its bounding-box diagonal. */
function pointScaleFromBbox(verts: Array<Record<string, number>>): number {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const v of verts) {
    minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
    minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
    minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  return clamp(diag * 0.004, 0.004, 0.1);
}

/** Stride so a vertex count fits under MAX_GAUSSIANS; logs when it subsamples. */
function subsampleStep(vertexCount: number, sourceLabel: string): number {
  const step = Math.max(1, Math.ceil(vertexCount / MAX_GAUSSIANS));
  if (step > 1) {
    logger.info({ vertexCount, step, cap: MAX_GAUSSIANS, sourceLabel }, 'import subsampled to fit the gaussian cap');
  }
  return step;
}

/** Convert a PLY buffer (point cloud OR trained 3DGS) to a packed .splat. */
function convertPly(buf: Buffer): ImportedSplat {
  const header = parsePlyHeader(buf);
  const is3dgs = header.props.some((p) => p.name === 'f_dc_0');
  const verts = readVertices(buf, header, subsampleStep(header.vertexCount, is3dgs ? '3dgs-ply' : 'point-cloud-ply'));
  if (verts.length === 0) throw new Error('PLY produced no readable vertices');
  let gaussians: Gaussian[];
  if (is3dgs) {
    gaussians = verts.map(gaussianFrom3dgs);
  } else {
    const scale = pointScaleFromBbox(verts);
    const plan = resolveColorPlan(header.props);
    gaussians = verts.map((v) => gaussianFromPoint(v, scale, plan));
  }
  return { buffer: packSplat(gaussians), count: gaussians.length };
}

/** Validate (and cap) a file that is already in .splat format. */
function validateSplat(buf: Buffer): ImportedSplat {
  if (buf.length === 0 || buf.length % STRIDE !== 0) {
    throw new Error(`malformed .splat (${buf.length} bytes; must be a non-zero multiple of ${STRIDE})`);
  }
  const count = buf.length / STRIDE;
  const step = subsampleStep(count, 'splat');
  if (step === 1) return { buffer: buf, count };
  const kept = Math.ceil(count / step);
  const out = Buffer.alloc(kept * STRIDE);
  for (let i = 0, w = 0; i < count; i += step, w++) buf.copy(out, w * STRIDE, i * STRIDE, i * STRIDE + STRIDE);
  return { buffer: out, count: out.length / STRIDE };
}

/**
 * @description Convert a user-supplied 3D capture file to the vendored viewer's
 * .splat format. Supports `.ply` (a colored point cloud OR a trained 3D gaussian
 * splat) and a raw `.splat` passthrough. Throws on an unsupported extension or
 * unparseable content — the caller wraps that into a ReconstructionError.
 * @param buf - The uploaded file bytes
 * @param ext - The lower-cased file extension including the dot (e.g. `.ply`)
 * @returns The packed .splat buffer and its gaussian count
 */
export function convertToSplat(buf: Buffer, ext: string): ImportedSplat {
  const e = ext.toLowerCase();
  if (e === '.splat') return validateSplat(buf);
  if (e === '.ply') return convertPly(buf);
  throw new Error(`unsupported import format "${ext}" — expected .ply or .splat`);
}

/** Extensions the import lane accepts (used by the route + the provider). */
export const IMPORT_EXTENSIONS = ['.ply', '.splat'] as const;
