/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the create-region-edit live-acceptance case and the PNG module it compares pixels with. The PNG half runs against real sharp, the encoder and decoder the Create package normalizes every image with: the case's decoder must return exactly sharp's raw pixels for RGBA, RGB, grey and grey-with-alpha files, with every row filter type present, and must refuse a palette, 16-bit, interlaced, corrupt or truncated file by name; the case's encoder must produce a file sharp reads back exactly. The case half drives a doubled Create 1.9 (tests/fixtures/live-acceptance-fake-api.ts plus a multipart upload that accepts only the one `image` part Create's multer reads) whose uploads, candidates and served images are real sharp PNGs, composited only inside the box as Create does. A free provider, the region regenerated, every pixel outside it unchanged, revision 2 with the text layer and revision 1 kept, and the project deleted with both images kept = pass. Red: one changed pixel outside the box (at its right edge or its far corner), nothing changed inside, a failed or never-finished edit, an accept that touched the text layer, a stored upload that differs from the generated image, a refused delete. Unavailable, writing nothing: Create absent or older than 1.9.0, a missing project.generate, a provider that is not configured or did not resolve, and a PAID provider without --allow-paid (which the host runner's own flag parsing turns into the option). The real companion is `node scripts/operations/live-acceptance.js create-region-edit` on the box.
 */
import { describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';
import sharp from 'sharp';
import { fakeApi, fakeClock, type FakeReply } from '../fixtures/live-acceptance-fake-api';

const requireCjs = createRequire(import.meta.url);
const regionCase = requireCjs('../../scripts/lib/live-acceptance-create-region-edit.js');
const png = requireCjs('../../scripts/lib/live-acceptance-png.js');
const runner = requireCjs('../../scripts/operations/live-acceptance.js');

const PREFIX = '/api/create/project-assets/';
const ALL = { view: true, read: true, create: true, change: true, delete: true, export: true, generate: true };
const RED = [255, 0, 0, 255];

interface Options {
  installed?: boolean; generateAction?: boolean; permissions?: Record<string, boolean>; providerStatus?: number;
  provider?: { configured?: boolean; costClass?: string; provider?: string; reason?: string }; costUsd?: number | null;
  outsidePixel?: [number, number]; unchangedInside?: boolean; outcome?: 'ready' | 'failed' | 'never';
  acceptTouchesTitle?: boolean; deleteRefuses?: boolean; storedDiffers?: boolean; uploadStatus?: FakeReply; editStatus?: FakeReply;
}
interface Asset { bytes: Buffer; width: number; height: number; sha256: string }
interface Edit { id: string; projectId: string; sourceRevision: number; layerId: string; sourceAssetId: string; selection: unknown; instruction: string;
  status: string; resultAsset: { id: string; src: string; width: number; height: number } | null; acceptedRevision: number | null;
  provider: string | null; model: string | null; costUsd: number | null; error: string | null; polls: number; pending: Promise<Buffer> | null }
interface Project { title: string; revisions: Array<{ title: string; document: Record<string, unknown> }> }

/** The key order a jsonb read returns: reversed, all the way down, so a naive comparison would fail. */
function reorder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorder);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse().map(([k, v]) => [k, reorder(v)]));
}

/** What Create's validateProject adds to the two layer shapes the case sends. */
function normalizeDocument(document: Record<string, unknown>): Record<string, unknown> {
  const base = { rotation: 0, opacity: 1, visible: true, locked: false };
  const layers = (document.layers as Array<Record<string, unknown>>).map((layer) => (layer.type === 'image'
    ? { ...layer, ...base, crop: { x: 0, y: 0, w: 1, h: 1 }, brightness: 100, contrast: 100 }
    : { ...layer, ...base, fontFamily: 'sans-serif', fontSize: 32, fontWeight: 400, align: 'left', fill: '#111827' }));
  return { ...document, layers };
}

/** Create's normalizeProjectImage: decode, auto-rotate and re-encode as PNG with sharp. */
async function normalize(bytes: Buffer): Promise<Asset> {
  const out = await sharp(bytes).rotate().png().toBuffer({ resolveWithObject: true });
  return { bytes: out.data, width: out.info.width, height: out.info.height, sha256: createHash('sha256').update(out.data).digest('hex') };
}

/** The candidate Create composites: the source with the box replaced by the provider's answer, and nothing else unless a defect is asked for. */
async function composite(source: Buffer, o: Options): Promise<Buffer> {
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixels = Buffer.from(data);
  const { left, top, right, bottom } = regionCase.REGION;
  for (let y = top; y < bottom && !o.unchangedInside; y++) for (let x = left; x < right; x++) pixels.set(RED, (y * info.width + x) * 4);
  if (o.outsidePixel) pixels[(o.outsidePixel[1] * info.width + o.outsidePixel[0]) * 4] ^= 1;
  return sharp(pixels, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

/** A doubled Create 1.9: its permissions, provider report, uploads, projects, revisions and region edits. */
function world(o: Options = {}) {
  const assets = new Map<string, Asset>();
  const projects = new Map<string, Project>();
  const edits = new Map<string, Edit>();
  const uploads: Array<{ route: string; fields: Record<string, string>; file: { field?: string; name: string; type: string; bytes: Buffer } }> = [];
  const addAsset = (asset: Asset) => { const id = randomUUID(); assets.set(id, asset); return id; };
  const snapshot = (id: string, revision?: number) => {
    const p = projects.get(id)!;
    const n = revision ?? p.revisions.length;
    return { id, title: p.revisions[n - 1].title, revision: n, createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z', document: p.revisions[n - 1].document };
  };
  const readEdit = (e: Edit) => Object.fromEntries(Object.entries(e).filter(([key]) => key !== 'polls' && key !== 'pending'));
  const settle = async (e: Edit) => {
    e.polls += 1;
    if (e.status !== 'generating' || e.polls < 2 || o.outcome === 'never') return;
    if (o.outcome === 'failed') { Object.assign(e, { status: 'failed', error: 'region_edit_provider_failed' }); return; }
    const asset = await normalize(await e.pending!);
    const id = addAsset(asset);
    Object.assign(e, { status: 'ready', resultAsset: { id, src: PREFIX + id, width: asset.width, height: asset.height },
      provider: o.provider?.provider ?? 'fixture-image', model: 'fixture-image-default', costUsd: o.costUsd ?? null });
  };
  const routes = createRoutes(o, { assets, projects, edits, snapshot, readEdit, settle });
  const api = fakeApi(routes);
  const upload = async (route: string, fields: Record<string, string>, file: { field?: string; name: string; type: string; bytes: Buffer }) => {
    uploads.push({ route, fields, file });
    const reply = (status: number, json: unknown) => ({ status, json, text: JSON.stringify(json), contentType: 'application/json', location: null });
    if (o.uploadStatus) return reply(o.uploadStatus.status, o.uploadStatus.json);
    // multer .single('image') with fields: 0 refuses any other part as a 400.
    if (route !== '/api/create/project-assets' || file.field !== 'image' || Object.keys(fields).length) return reply(400, { error: 'invalid_project_upload' });
    const asset = await normalize(o.storedDiffers ? await composite(file.bytes, { unchangedInside: true, outsidePixel: [5, 5] }) : file.bytes);
    const id = addAsset(asset);
    return reply(201, { asset: { id, src: PREFIX + id, width: asset.width, height: asset.height, bytes: asset.bytes.length, sha256: asset.sha256 } });
  };
  return { ports: { api: api.api, upload }, calls: api.calls, assets, projects, edits, uploads };
}

type World = { assets: Map<string, Asset>; projects: Map<string, Project>; edits: Map<string, Edit>;
  snapshot: (id: string, revision?: number) => Record<string, unknown>; readEdit: (e: Edit) => Record<string, unknown>; settle: (e: Edit) => Promise<void> };

/** The route table of the doubled Create, over the world's state. */
function createRoutes(o: Options, w: World): Record<string, (call: { params: Record<string, string>; body: unknown }) => FakeReply | Promise<FakeReply>> {
  const project = (id: string): FakeReply | null => (w.projects.has(id) ? null : { status: 404, json: { error: 'project_not_found' } });
  const edit = (params: Record<string, string>) => {
    const e = w.edits.get(params.edit);
    return e && e.projectId === params.id && w.projects.has(params.id) ? e : null;
  };
  return {
    'GET /api/create/permissions': () => {
      if (o.installed === false) return { status: 404 };
      const held: Record<string, boolean> = { ...ALL, ...(o.permissions || {}) };
      if (o.generateAction === false) delete held.generate;
      return { status: 200, json: { permissions: held } };
    },
    'GET /api/create/region-edit-provider': () => {
      if (o.providerStatus) return { status: o.providerStatus, json: { error: 'project_service_unavailable' } };
      const p = { configured: true, costClass: 'free', provider: 'fixture-image', ...(o.provider || {}) };
      return { status: 200, json: { configured: p.configured, provider: p.provider, costClass: p.costClass, dailyCap: 25, ...(p.configured ? {} : { reason: p.reason ?? 'region_edit_provider_unavailable' }) } };
    },
    'GET /api/create/project-assets/:id': ({ params }) => {
      const a = w.assets.get(params.id);
      return a ? { status: 200, bytes: a.bytes, contentType: 'image/png' } : { status: 404, json: { error: 'project_asset_not_found' } };
    },
    'POST /api/create/projects': ({ body }) => {
      const { title, document } = body as { title: string; document: Record<string, unknown> };
      const id = randomUUID();
      w.projects.set(id, { title, revisions: [{ title, document: normalizeDocument(document) }] });
      return { status: 201, json: { project: w.snapshot(id) } };
    },
    'GET /api/create/projects/:id': ({ params }) => project(params.id) ?? { status: 200, json: { project: reorder(w.snapshot(params.id)) } },
    'GET /api/create/projects/:id/revisions/:revision': ({ params }) => project(params.id) ?? { status: 200, json: { project: reorder(w.snapshot(params.id, Number(params.revision))) } },
    'DELETE /api/create/projects/:id': ({ params, body }) => {
      if (o.deleteRefuses) return { status: 503, json: { error: 'project_service_unavailable' } };
      const missing = project(params.id);
      if (missing) return missing;
      if ((body as { baseRevision: number }).baseRevision !== w.projects.get(params.id)!.revisions.length) return { status: 409, json: { error: 'project_revision_conflict' } };
      w.projects.delete(params.id);
      for (const [id, e] of w.edits) if (e.projectId === params.id) w.edits.delete(id);
      return { status: 204 };
    },
    'POST /api/create/projects/:id/region-edits': ({ params, body }) => regionRequest(o, w, params.id, body as Record<string, unknown>),
    'GET /api/create/projects/:id/region-edits/:edit': async ({ params }) => {
      if (o.editStatus) return o.editStatus;
      const e = edit(params);
      if (!e) return { status: 404, json: { error: 'region_edit_not_found' } };
      await w.settle(e);
      return { status: 200, json: { edit: w.readEdit(e) } };
    },
    'POST /api/create/projects/:id/region-edits/:edit/accept': ({ params, body }) => acceptEdit(o, w, edit(params), body as { baseRevision: number }),
    'POST /api/create/projects/:id/region-edits/:edit/cancel': ({ params }) => {
      const e = edit(params);
      if (!e) return { status: 404, json: { error: 'region_edit_not_found' } };
      if (e.status !== 'generating') return { status: 409, json: { error: 'region_edit_not_cancellable' } };
      e.status = 'cancelled';
      return { status: 200, json: { edit: w.readEdit(e) } };
    },
  };
}

/** POST /projects/:id/region-edits: admit against the exact stored revision, then generate in the background. */
function regionRequest(o: Options, w: World, projectId: string, body: Record<string, unknown>): FakeReply {
  const p = w.projects.get(projectId);
  if (!p) return { status: 404, json: { error: 'project_not_found' } };
  if (Object.keys(body).sort().join() !== 'instruction,selection,sourceRevision') return { status: 400, json: { error: 'invalid_project_fields' } };
  if ([...w.edits.values()].some((e) => e.status === 'generating')) return { status: 409, json: { error: 'region_edit_in_progress' } };
  const document = p.revisions[(body.sourceRevision as number) - 1].document as { images: Record<string, { src: string }> };
  const sourceAssetId = document.images.photo.src.slice(PREFIX.length);
  const id = randomUUID();
  const e: Edit = { id, projectId, sourceRevision: body.sourceRevision as number, layerId: 'photo', sourceAssetId, selection: body.selection,
    instruction: body.instruction as string, status: 'generating', resultAsset: null, acceptedRevision: null, provider: null, model: null,
    costUsd: null, error: null, polls: 0, pending: composite(w.assets.get(sourceAssetId)!.bytes, o) };
  w.edits.set(id, e);
  return { status: 202, json: { edit: w.readEdit(e) } };
}

/** POST .../accept: Create's acceptedInput on the revision the caller holds. */
function acceptEdit(o: Options, w: World, e: Edit | null, body: { baseRevision: number }): FakeReply {
  if (!e) return { status: 404, json: { error: 'region_edit_not_found' } };
  if (e.status !== 'ready' || !e.resultAsset) return { status: 409, json: { error: 'region_edit_not_ready' } };
  const p = w.projects.get(e.projectId)!;
  if (body.baseRevision !== p.revisions.length) return { status: 409, json: { error: 'project_revision_conflict' } };
  const current = p.revisions[p.revisions.length - 1];
  const doc = current.document as { layers: Array<Record<string, unknown>>; images: Record<string, unknown> };
  const key = `region-${e.id.slice(0, 8)}`;
  const layers = doc.layers.map((layer) => (layer.id === e.layerId ? { ...layer, assetId: key }
    : o.acceptTouchesTitle && layer.id === 'title' ? { ...layer, x: 17 } : layer));
  const images: Record<string, unknown> = { ...doc.images, [key]: { src: e.resultAsset.src, width: e.resultAsset.width, height: e.resultAsset.height } };
  delete images.photo;
  p.revisions.push({ title: current.title, document: { ...doc, layers, images } });
  Object.assign(e, { status: 'accepted', acceptedRevision: p.revisions.length });
  return { status: 201, json: { project: w.snapshot(e.projectId) } };
}

/** The routes a run sent, with ids masked. */
function sent(calls: Array<{ method: string; path: string }>): string[] {
  return calls.map((c) => `${c.method} ${c.path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')}`);
}
const PRECONDITIONS = ['GET /api/create/permissions', 'GET /api/create/region-edit-provider'];
const FAST = { editBudgetMs: 20_000, pollMs: 1_000 };

/** The filtered rows of a PNG: every IDAT chunk's body, joined and inflated (written independently of the module under test). */
function filteredRows(file: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let at = 8; at < file.length;) {
    const length = file.readUInt32BE(at);
    if (file.toString('ascii', at + 4, at + 8) === 'IDAT') parts.push(file.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  return inflateSync(Buffer.concat(parts));
}

describe('the PNG module against real sharp', () => {
  // Seeded noise: with adaptive filtering sharp then picks every one of the five row filters
  // (its default, which Create uses, writes filter 0 on every row).
  const rgbaSample = (width: number, height: number) => {
    const pixels = Buffer.alloc(width * height * 4);
    let seed = 7;
    for (let i = 0; i < pixels.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; pixels[i] = (seed >> 16) & 255; }
    return pixels;
  };

  it('decodes what sharp writes, every colour type the reader accepts, every row filter, to sharp\'s own pixels', async () => {
    const width = 67, height = 41, rgba = rgbaSample(width, height);
    const seenFilters = new Set<number>();
    for (const channels of [4, 3, 2, 1] as const) {
      const input = sharp(rgba, { raw: { width, height, channels: 4 } });
      const shaped = channels === 4 ? input : channels === 3 ? input.removeAlpha() : channels === 2 ? input.toColourspace('b-w') : input.removeAlpha().toColourspace('b-w');
      for (const adaptiveFiltering of [false, true]) {
        const file = await shaped.clone().png({ adaptiveFiltering, compressionLevel: 9 }).toBuffer();
        expect(file[25], `colour type for ${channels} channels`).toBe({ 4: 6, 3: 2, 2: 4, 1: 0 }[channels]);
        const truth = await sharp(file).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        expect(truth.info.channels).toBe(4);
        const decoded = png.decodeRgba(file);
        expect([decoded.width, decoded.height]).toEqual([width, height]);
        expect(decoded.data.equals(truth.data), `${channels} channels, adaptive ${adaptiveFiltering}`).toBe(true);
        const rows = filteredRows(file);
        for (let y = 0; y < height; y++) seenFilters.add(rows[y * (width * channels + 1)]);
      }
    }
    expect([...seenFilters].sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it('writes a PNG that sharp reads back pixel for pixel, and the case image round-trips', async () => {
    const pixels = regionCase.sourcePixels();
    const file = png.encodeRgba(regionCase.IMAGE.width, regionCase.IMAGE.height, pixels);
    const read = await sharp(file).raw().toBuffer({ resolveWithObject: true });
    expect([read.info.width, read.info.height, read.info.channels]).toEqual([512, 384, 4]);
    expect(read.data.equals(pixels)).toBe(true);
    expect(png.decodeRgba(file).data.equals(pixels)).toBe(true);
    expect(() => png.encodeRgba(2, 2, Buffer.alloc(15))).toThrow('does not match the dimensions');
  });

  it('refuses by name what it does not decode exactly, never guessing', async () => {
    const rgba = rgbaSample(16, 16);
    const raw = () => sharp(rgba, { raw: { width: 16, height: 16, channels: 4 } });
    await expect(raw().png({ palette: true }).toBuffer().then(png.decodeRgba)).rejects.toThrow(/^unsupported PNG \(colour type 3, bit depth \d+, interlace 0\)$/);
    await expect(raw().toColourspace('rgb16').png().toBuffer().then(png.decodeRgba)).rejects.toThrow(/unsupported PNG \(colour type 6, bit depth 16/);
    await expect(raw().png({ progressive: true }).toBuffer().then(png.decodeRgba)).rejects.toThrow(/interlace 1\)/);
    const good = png.encodeRgba(16, 16, rgba);
    const corrupt = Buffer.from(good);
    corrupt[good.indexOf('IDAT') + 6] ^= 0xff;
    expect(() => png.decodeRgba(corrupt)).toThrow('PNG chunk IDAT fails its checksum');
    expect(() => png.decodeRgba(good.subarray(0, good.length - 20))).toThrow('PNG truncated inside a chunk');
    expect(() => png.decodeRgba(Buffer.from('GIF89a'))).toThrow('not a PNG (signature missing)');
    expect(png.crc32(Buffer.from('IEND'))).toBe(0xae426082);
  });
});

describe('create-region-edit live acceptance', () => {
  it('passes on a free provider: outside the box unchanged, accepted as revision 2, project removed, images kept', async () => {
    const w = world();
    const result = await regionCase.run({ ...w.ports, ...fakeClock() }, FAST);
    expect(result.state).toBe('pass');
    const outside = 512 * 384 - 192 * 192;
    expect(result.detail).toContain(`fixture-image regenerated the 192 x 192 region (36864 of 36864 pixels changed), all ${outside} pixels outside it are byte for byte the source`);
    expect(result.evidence).toMatchObject({ provider: 'fixture-image', costUsd: null, pixels: { outside, outsideChanged: 0, inside: 36864, insideChanged: 36864, firstOutside: null } });
    expect(result.evidence.tag).toMatch(/^testlab-live-create-region-edit-[0-9a-f]{8}$/);
    expect(sent(w.calls)).toEqual([...PRECONDITIONS, 'GET /api/create/project-assets/<id>', 'POST /api/create/projects',
      'POST /api/create/projects/<id>/region-edits', 'GET /api/create/projects/<id>/region-edits/<id>', 'GET /api/create/projects/<id>/region-edits/<id>',
      'GET /api/create/project-assets/<id>', 'POST /api/create/projects/<id>/region-edits/<id>/accept', 'GET /api/create/projects/<id>/region-edits/<id>',
      'GET /api/create/projects/<id>', 'GET /api/create/projects/<id>/revisions/1', 'GET /api/create/projects/<id>', 'DELETE /api/create/projects/<id>',
      'GET /api/create/projects/<id>', 'GET /api/create/projects/<id>/region-edits/<id>']);
    const request = w.calls.find((c) => c.path.endsWith('/region-edits') && c.method === 'POST')!.body as Record<string, unknown>;
    expect(request).toEqual({ sourceRevision: 1, instruction: 'Replace this area with a plain bright red square.', selection: { version: 1, kind: 'box', layerId: 'photo',
      assetId: 'photo', sourceWidth: 512, sourceHeight: 384, feather: 0, points: [{ x: 160, y: 96 }, { x: 352, y: 96 }, { x: 352, y: 288 }, { x: 160, y: 288 }] } });
    const created = w.calls.find((c) => c.path === '/api/create/projects')!.body as { title: string; document: { name: string } };
    expect([created.title, created.document.name]).toEqual([result.evidence.tag, result.evidence.tag]);
    expect(w.uploads.map((u) => [u.file.field, u.file.type, u.fields])).toEqual([['image', 'image/png', {}]]);
    expect((await sharp(w.uploads[0].file.bytes).raw().toBuffer()).equals(regionCase.sourcePixels())).toBe(true);
    expect([w.projects.size, w.edits.size]).toEqual([0, 0]);
    const { projectId, editId, sourceAssetId, resultAssetId } = result.evidence as Record<string, string>;
    expect(result.cleanup).toMatchObject({ outstanding: [], errors: [], removed: [`create-project ${projectId}`, `create-region-edit ${editId}`] });
    expect(result.cleanup.kept.map((k: string) => k.split(' (')[0])).toEqual([`create-asset ${sourceAssetId}`, `create-asset ${resultAssetId}`]);
    expect(result.cleanup.kept[0]).toContain('owner-wide POST /api/create/project-assets/cleanup, once it is 24 hours old');
  });

  it('fails when one pixel outside the box changed, at its right edge or its far corner, and never accepts', async () => {
    for (const [x, y] of [[352, 200], [0, 0], [159, 287]] as Array<[number, number]>) {
      const w = world({ outsidePixel: [x, y] });
      const result = await regionCase.run({ ...w.ports, ...fakeClock() }, FAST);
      expect(result.state, `${x},${y}`).toBe('fail');
      expect(result.detail).toContain(`1 of the ${512 * 384 - 192 * 192} pixels outside the region changed (the first at ${x},${y})`);
      expect(w.calls.some((c) => c.path.endsWith('/accept'))).toBe(false);
      expect(result.cleanup).toMatchObject({ outstanding: [], errors: [] });
      expect(w.projects.size).toBe(0);
    }
  });

  it('fails when nothing inside the box changed, or the stored upload is not the generated image', async () => {
    const same = await regionCase.run({ ...world({ unchangedInside: true }).ports, ...fakeClock() }, FAST);
    expect(same.state).toBe('fail');
    expect(same.detail).toContain('no pixel inside the region changed, so nothing was regenerated');
    const w = world({ storedDiffers: true });
    const differs = await regionCase.run({ ...w.ports, ...fakeClock() }, FAST);
    expect(differs.state).toBe('fail');
    expect(differs.detail).toContain('the stored image does not hold the generated pixels');
    expect(w.calls.some((c) => c.path === '/api/create/projects')).toBe(false);
  });

  it('never runs a paid provider without --allow-paid, and writes nothing', async () => {
    const w = world({ provider: { costClass: 'paid', provider: 'fixture-paid-image' } });
    const result = await regionCase.run({ ...w.ports, ...fakeClock() }, FAST);
    expect(result.state).toBe('unavailable');
    expect(result.detail).toContain('The image provider fixture-paid-image is paid: one region edit is a real charge, so the case does not run it without the operator\'s consent.');
    expect(result.detail).toContain('The operator consents by running node scripts/operations/live-acceptance.js create-region-edit --allow-paid on the host.');
    expect(result.detail).toContain('Nothing was written.');
    expect(result.evidence.provider).toEqual({ id: 'fixture-paid-image', costClass: 'paid', configured: true, dailyCap: 25 });
    expect(sent(w.calls)).toEqual(PRECONDITIONS);
    expect(w.uploads).toEqual([]);
    const plain = runner.caseOptions(runner.parseArgs(['create-region-edit']));
    expect(plain.allowPaid).toBe(false);
    expect((await regionCase.run({ ...world({ provider: { costClass: 'paid' } }).ports, ...fakeClock() }, { ...plain, ...FAST })).state).toBe('unavailable');
  });

  it('runs a paid provider once the host runner carries --allow-paid, and keeps the spend in the receipt', async () => {
    const w = world({ provider: { costClass: 'paid', provider: 'fixture-paid-image' }, costUsd: 0.04 });
    const options = { ...runner.caseOptions(runner.parseArgs(['create-region-edit', '--allow-paid'])), ...FAST };
    const result = await regionCase.run({ ...w.ports, ...fakeClock() }, options);
    expect(result.state).toBe('pass');
    expect(result.evidence).toMatchObject({ provider: 'fixture-paid-image', costUsd: 0.04 });
    expect(result.cleanup.kept).toContain(`cost-ledger create-region-edit-${result.evidence.editId} (oshal_cost_events and chat_tasks record the real spend of this edit)`);
    expect(result.cleanup).toMatchObject({ outstanding: [], errors: [] });
  });

  it('is unavailable without Create 1.9, project.generate or a configured provider, and writes nothing', async () => {
    const cases: Array<[Options, string]> = [
      [{ installed: false }, 'Create is not installed (GET /api/create/permissions answered 404).'],
      [{ generateAction: false }, 'Create 1.9.0 or later (region editing) is not installed: GET /api/create/permissions reports no generate action.'],
      [{ permissions: { generate: false } }, 'The caller lacks project.generate in Create;'],
      [{ provider: { configured: false } }, 'The image provider fixture-image is not available for region editing (region_edit_provider_unavailable).'],
      [{ providerStatus: 503 }, 'Create could not name an image provider for region editing (GET /api/create/region-edit-provider answered HTTP 503 project_service_unavailable).'],
    ];
    for (const [options, detail] of cases) {
      const w = world(options);
      const result = await regionCase.run({ ...w.ports, ...fakeClock() }, FAST);
      expect(result.state, detail).toBe('unavailable');
      expect(result.detail).toContain(detail);
      expect(result.detail).toContain('Nothing was written.');
      expect(w.uploads).toEqual([]);
      expect(w.calls.every((c) => c.method === 'GET')).toBe(true);
    }
    const noUpload = await regionCase.run({ api: world().ports.api }, FAST);
    expect(noUpload).toMatchObject({ state: 'unavailable', detail: 'This runner has no upload port. Nothing was written.' });
    const bad = await regionCase.run({ ...world({ provider: { costClass: 'metered' } }).ports, ...fakeClock() }, FAST);
    expect(bad.state).toBe('fail');
    expect(bad.detail).toContain('without a provider, a configured flag and a cost class of free or paid. Nothing was written.');
  });

  it('fails on an edit that failed or never finished, cancels the one still generating, and removes the project', async () => {
    const failed = world({ outcome: 'failed' });
    const f = await regionCase.run({ ...failed.ports, ...fakeClock() }, FAST);
    expect(f.state).toBe('fail');
    expect(f.detail).toContain('the region edit ended failed (region_edit_provider_failed), not ready');
    expect(failed.calls.some((c) => c.path.endsWith('/cancel'))).toBe(false);
    expect(failed.projects.size).toBe(0);
    const stuck = world({ outcome: 'never' });
    const s = await regionCase.run({ ...stuck.ports, ...fakeClock() }, FAST);
    expect(s.state).toBe('fail');
    expect(s.detail).toContain('the region edit was still generating after 20 s');
    expect(stuck.calls.filter((c) => c.path.endsWith('/cancel'))).toHaveLength(1);
    expect(s.cleanup.kept.some((k: string) => k.startsWith(`create-late-candidate ${s.evidence.editId} (cancelled while the provider was working`))).toBe(true);
    expect(s.cleanup).toMatchObject({ outstanding: [], errors: [] });
    expect([stuck.projects.size, stuck.edits.size]).toEqual([0, 0]);
  });

  it('fails when the accept moved the text layer, and turns a refused delete into a red cleanup', async () => {
    const moved = await regionCase.run({ ...world({ acceptTouchesTitle: true }).ports, ...fakeClock() }, FAST);
    expect(moved.state).toBe('fail');
    expect(moved.detail).toContain('the text layer did not survive the accept unchanged');
    const w = world({ deleteRefuses: true });
    const refused = await regionCase.run({ ...w.ports, ...fakeClock() }, FAST);
    expect(refused.state).toBe('fail');
    expect(refused.detail).toContain(`CLEANUP INCOMPLETE: DELETE /api/create/projects/${refused.evidence.projectId} answered HTTP 503 project_service_unavailable, not 204`);
    expect(refused.cleanup.outstanding).toEqual([`create-project ${refused.evidence.projectId}`, `create-region-edit ${refused.evidence.editId}`]);
  });

  it('reports a full image store, an edit in flight and the daily cap as named gaps, and removes what it wrote', async () => {
    const full = world({ uploadStatus: { status: 409, json: { error: 'project_asset_limit_reached' } } });
    const f = await regionCase.run({ ...full.ports, ...fakeClock() }, FAST);
    expect(f).toMatchObject({ state: 'unavailable', cleanup: { outstanding: [], errors: [] } });
    expect(f.detail).toContain('The caller\'s Create image storage is full (409 project_asset_limit_reached)');
    expect(full.calls.some((c) => c.method !== 'GET')).toBe(false);
    for (const [status, error, words] of [[409, 'region_edit_in_progress', 'already has a region edit in flight'], [429, 'region_edit_daily_limit', 'per 24 hours']] as const) {
      const w = world();
      const api = async (method: string, route: string, body?: unknown) => (method === 'POST' && route.endsWith('/region-edits')
        ? { status, json: { error }, text: '', contentType: 'application/json', location: null } : w.ports.api(method, route, body));
      const result = await regionCase.run({ ...w.ports, api, ...fakeClock() }, FAST);
      expect(result.state).toBe('unavailable');
      expect(result.detail).toContain(words);
      expect(result.cleanup).toMatchObject({ outstanding: [], errors: [], removed: [`create-project ${result.evidence.projectId}`] });
      expect(w.projects.size).toBe(0);
    }
  });
});
