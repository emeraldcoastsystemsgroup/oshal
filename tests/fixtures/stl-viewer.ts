/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Serve actual Scan/CAD documents, adapters and core STL viewer with synthetic read-only HTTP and observe original WebGL calls.
 */
import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

export type ViewerApi = { mount(canvas: HTMLCanvasElement): Viewer; parseStl(bytes: ArrayBuffer): Mesh; apiVersion?: number };
type Mesh = { triangles: number; positions: Float32Array; normals: Float32Array };
type Viewer = { load(bytes: ArrayBuffer): { triangles: number; size: number[] }; clear(): void; resize(): void; dispose(): void };
type Frame = { count: number; colors: number; opaque: number; width: number; height: number; matrix: number[] };
declare global {
  interface Window {
    OSHALStlViewer: ViewerApi; ScanToPrintViewer: ViewerApi; CadStudioViewer: ViewerApi;
    fixtureViewer: Viewer; stlListeners: number;
    stlProof: { shaders: boolean[]; links: boolean[]; frames: Frame[]; lines: number[]; uploads: number[][]; clears: number; buffers: number; deletedBuffers: number; deletedPrograms: number; matrix: number[] };
  }
}
export const CONSUMERS = [
  { slug: 'scan-to-print', alias: 'ScanToPrintViewer', label: 'Scan' },
  { slug: 'cad-studio', alias: 'CadStudioViewer', label: 'CAD' },
] as const;
export const storeRoot = resolve(process.env.OSHAL_STL_STORE_ROOT || '../oshal-applications');
export const hasStore = CONSUMERS.every(item => existsSync(resolve(storeRoot, item.slug, 'tools', `${item.slug}.html`)));
if (!hasStore && process.env.OSHAL_STL_STORE_ROOT) throw new Error('Explicit OSHAL_STL_STORE_ROOT lacks the actual Scan/CAD documents.');

/** @description Run real app boot with empty local records; all non-GET operations are refused. */
export async function startStlViewerFixture() {
  const app = express(), requests: string[] = [];
  app.use((req, res, next) => {
    requests.push(`${req.method} ${req.path}`);
    if (req.method !== 'GET') { res.status(405).end(); return; }
    next();
  });
  app.use('/shared/ui', express.static(resolve('src/shared/ui')));
  app.use('/cockpit', express.static(resolve('src/pages/cockpit')));
  for (const item of CONSUMERS) {
    const base = `/api/${item.slug}`, tools = resolve(storeRoot, item.slug, 'tools');
    app.get(base + '/app', (_req, res) => res.type('html').send(readFileSync(resolve(tools, `${item.slug}.html`))));
    if (item.slug === 'cad-studio' && process.env.OSHAL_STL_LEGACY_CAD) {
      const old = readFileSync(resolve(process.env.OSHAL_STL_LEGACY_CAD));
      app.get(base + '/assets/cad-studio-gl.js', (_req, res) => res.type('js').send(old));
    }
    app.use(base + '/assets', express.static(tools));
    app.get(base + '/capabilities', (_req, res) => res.json({ contract: { features: {} }, defaults: {}, engine: {} }));
    app.get(base + '/jobs', (_req, res) => res.json({ jobs: [] }));
    app.get(base + '/models', (_req, res) => res.json({ models: [] }));
    app.get(base + '/printers', (_req, res) => res.json({ printers: [] }));
  }
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests,
    close: () => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())) };
}

/** @description Count real viewer listeners so disposed state alone cannot hide retained closures. */
export function observeViewerListeners() {
  window.stlListeners = 0;
  const active: { target: EventTarget; type: string; listener: EventListenerOrEventListenerObject | null }[] = [];
  const proto = EventTarget.prototype, add = proto.addEventListener, remove = proto.removeEventListener;
  function selected(target: EventTarget, type: string) {
    return (target === window && type === 'resize') || (target instanceof HTMLCanvasElement && target.id === 'viewer');
  }
  proto.addEventListener = function (type, listener, options) {
    add.call(this, type, listener, options);
    if (selected(this, type) && !active.some(item => item.target === this && item.type === type && item.listener === listener)) {
      active.push({ target: this, type, listener }); window.stlListeners = active.length;
    }
  };
  proto.removeEventListener = function (type, listener, options) {
    remove.call(this, type, listener, options);
    const index = active.findIndex(item => item.target === this && item.type === type && item.listener === listener);
    if (index >= 0) active.splice(index, 1);
    window.stlListeners = active.length;
  };
}

/** @description Observe original GL calls and read actual rendered pixels, never replace drawing with a synthetic result. */
export function observeStlRendering() {
  window.stlProof = { shaders: [], links: [], frames: [], lines: [], uploads: [], clears: 0, buffers: 0, deletedBuffers: 0, deletedPrograms: 0, matrix: [] };
  const proto = WebGLRenderingContext.prototype, proof = window.stlProof;
  const upload = proto.bufferData;
  proto.bufferData = function (target, data, usage) {
    if (data instanceof Float32Array) proof.uploads.push(Array.from(data));
    Reflect.apply(upload, this, [target, data, usage]);
  };
  const compile = proto.compileShader, link = proto.linkProgram, draw = proto.drawArrays, clear = proto.clear;
  const createBuffer = proto.createBuffer, deleteBuffer = proto.deleteBuffer, deleteProgram = proto.deleteProgram, matrix = proto.uniformMatrix4fv;
  proto.compileShader = function (shader) { compile.call(this, shader); proof.shaders.push(this.getShaderParameter(shader, this.COMPILE_STATUS)); };
  proto.linkProgram = function (program) { link.call(this, program); proof.links.push(this.getProgramParameter(program, this.LINK_STATUS)); };
  proto.uniformMatrix4fv = function (location, transpose, value) {
    if (this.getUniformLocation(this.getParameter(this.CURRENT_PROGRAM), 'mv') && value.length === 16) proof.matrix = Array.from(value);
    matrix.call(this, location, transpose, value);
  };
  proto.drawArrays = function (mode, first, count) {
    draw.call(this, mode, first, count);
    if (mode === this.LINES) proof.lines.push(count);
    if (mode !== this.TRIANGLES) return;
    const pixels = new Uint8Array(this.drawingBufferWidth * this.drawingBufferHeight * 4), colors = new Set<string>();
    this.readPixels(0, 0, this.drawingBufferWidth, this.drawingBufferHeight, this.RGBA, this.UNSIGNED_BYTE, pixels);
    let opaque = 0;
    for (let i = 0; i < pixels.length; i += 16) if (pixels[i + 3]) { opaque += 1; colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`); }
    proof.frames.push({ count, opaque, colors: colors.size, width: this.drawingBufferWidth, height: this.drawingBufferHeight, matrix: [...proof.matrix] });
  };
  proto.clear = function (mask) { clear.call(this, mask); proof.clears += 1; };
  proto.createBuffer = function () { proof.buffers += 1; return createBuffer.call(this); };
  proto.deleteBuffer = function (buffer) { deleteBuffer.call(this, buffer); proof.deletedBuffers += 1; };
  proto.deleteProgram = function (program) { deleteProgram.call(this, program); proof.deletedPrograms += 1; };
}

/** @description A closed asymmetric box with consistent outward normals exposes shading and camera changes. */
export function boxStl(width = 60, binary = false): number[] {
  const p = [[0, 0, 0], [width, 0, 0], [width, 40, 0], [0, 40, 0], [0, 0, 30], [width, 0, 30], [width, 40, 30], [0, 40, 30]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const normal = (f: number[]) => {
    const [a, b, c] = f.map(i => p[i]), u = b.map((v, i) => v - a[i]), v = c.map((x, i) => x - a[i]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    return n.map(x => x / Math.hypot(...n));
  };
  if (!binary) return [...Buffer.from('solid box\n' + faces.map(f => `facet normal ${normal(f).join(' ')}\nouter loop\n${f.map(i => 'vertex ' + p[i].join(' ')).join('\n')}\nendloop\nendfacet`).join('\n') + '\nendsolid box')];
  const bytes = Buffer.alloc(84 + faces.length * 50); bytes.writeUInt32LE(faces.length, 80);
  faces.forEach((f, i) => [...normal(f), ...f.flatMap(n => p[n])].forEach((v, j) => bytes.writeFloatLE(v, 84 + i * 50 + j * 4)));
  return [...bytes];
}
