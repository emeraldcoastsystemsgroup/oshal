/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the Little Monsters class-material live-acceptance case's own logic over a doubled HTTP transport: a tagged class, a PDF carried in a Send-to handle and an import answered 201 approved and listed in the class = pass, then the material and the class are deleted through the package routes and proven gone, with the memory-only handle recorded as kept; a "requested" import = fail with the class still removed; a class that survives its delete = red cleanup; a box without Little Monsters writes nothing. The generated PDF is parsed by the same pdf-parse the package's text extraction uses (a real parser, not a double). The real companion is `node scripts/operations/live-acceptance.js lm-class-material` on the box.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The files-browser leg and the optional non-teacher leg. Doubled half: without Chromium the case is degraded, naming the host command and OSHAL_VERIFY_SECOND_PAT; a bound second caller's requested import is judged (listed in share requests, out of shared materials, deleted through that caller), an unenrolled second caller is a named gap, an approved second import fails. Real half, in headless Chromium through the runner's own browser port and HTTP ports against a loopback server: the SHIPPED files page (src/api/files.html) over the shipped files routes on a temporary store, the shipped artifact-exchange router and send-to.js, a stand-in for the cockpit shell that forwards artifact/artifactAction into an iframe as cockpit-view-controller does, a stand-in for the Little Monsters picker page, and a stand-in import route that redeems through the shipped redeemArtifactViaRelay with its request. Pass end to end with the token on every same-origin request and the storage file removed from disk; a page whose dispatch carries bytes (a data: blob tag) instead of the files browser's locator fails and still cleans up; a picker that posts a class other than the one chosen fails. `node scripts/operations/live-acceptance.js lm-class-material` on the box is the live companion. The PDF check covers all three generated PDFs and hands pdf-parse a plain Uint8Array: its bundled pdf.js refused the same bytes as a small Node Buffer, so the check passed or failed by run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fakeApi, type FakeHandler } from '../fixtures/live-acceptance-fake-api';
import type { AppContext } from '@/app/composition/app-context';
import { createArtifactExchangeRoutes } from '@/app/routes/artifact-exchange-routes';
import { createFilesRoutes } from '@/app/routes/files-routes';
import { redeemArtifactViaRelay, registerAppArtifactActions, unregisterAppArtifactActions } from '@/shared/artifact-exchange';

const requireCjs = createRequire(import.meta.url);
const lm = requireCjs('../../scripts/lib/live-acceptance-lm-class-material.js');
const runner = requireCjs('../../scripts/operations/live-acceptance.js');
// The library entry the package's extractMaterialText requires, loaded past its index debug hook.
const pdfParse = requireCjs('pdf-parse/lib/pdf-parse.js') as (data: Uint8Array) => Promise<{ text: string; numpages: number }>;

const TAG = 'testlab-live-lm-class-material-0a1b2c3d';
const CLASS_ID = '5c1a55e5-0000-4000-8000-000000000001';
const MATERIAL_ID = '3a7e71a1-0000-4000-8000-000000000002';
const SECOND_MATERIAL_ID = '3a7e71a1-0000-4000-8000-000000000003';
const HOST_GAP = "files leg: the files-browser dispatch needs the host runner's raw/browser port (a headless Chromium); run node scripts/operations/live-acceptance.js lm-class-material";

function world(options: { shareStatus?: string; classDeleteStatus?: number; over?: Record<string, FakeHandler>; second?: { enrolled: boolean; shareStatus?: string } } = {}) {
  const classes = new Set<string>();
  const materials = new Set<string>();
  const requested = new Set<string>();
  const uploads: Array<{ fields: Record<string, string>; file: { name: string; type: string; bytes: Buffer } }> = [];
  const api = fakeApi({
    'GET /api/little-monsters/home-summary': () => ({ status: 200, json: { role: 'admin' } }),
    'POST /api/education/classes': () => { classes.add(CLASS_ID); return { status: 201, json: { classId: CLASS_ID } }; },
    'POST /api/education/import-artifact': () => { materials.add(MATERIAL_ID); return { status: 201, json: { material: { material_id: MATERIAL_ID }, shareStatus: options.shareStatus ?? 'approved', grounded: true } }; },
    'GET /api/education/classes/:id/shared-materials': () => ({ status: 200, json: { materials: [...materials].map((material_id) => ({ material_id })) } }),
    'GET /api/education/classes/:id/share-requests': () => ({ status: 200, json: { requests: [...requested].map((material_id) => ({ material_id })) } }),
    'DELETE /api/education/materials/:id': ({ params }) => { materials.delete(params.id); return { status: 200, json: { success: true } }; },
    'DELETE /api/education/classes/:id': ({ params }) => {
      if ((options.classDeleteStatus ?? 200) !== 200) return { status: options.classDeleteStatus! };
      classes.delete(params.id); return { status: 200, json: { success: true } };
    },
    'GET /api/education/classes/:id/info': ({ params }) => ({ status: classes.has(params.id) ? 200 : 404 }),
    'GET /api/education/classes': () => ({ status: 200, json: { classes: [...classes].map((class_id) => ({ class_id })) } }),
    ...(options.over || {}),
  });
  const upload = async (route: string, fields: Record<string, string>, file: { name: string; type: string; bytes: Buffer }) => {
    uploads.push({ fields, file });
    return route === '/api/artifacts/handles/upload'
      ? { status: 201, json: { ref: 'art_0123456789abcdef', expiresAt: '2026-09-28T13:00:00Z' } } : { status: 404, json: {} };
  };
  const secondApi = options.second ? fakeApi({
    'GET /api/education/classes': () => ({ status: 200, json: { classes: options.second!.enrolled ? [{ class_id: CLASS_ID }] : [] } }),
    'POST /api/education/import-artifact': () => { requested.add(SECOND_MATERIAL_ID); return { status: 201, json: { material: { material_id: SECOND_MATERIAL_ID }, shareStatus: options.second!.shareStatus ?? 'requested' } }; },
    'DELETE /api/education/materials/:id': ({ params }) => { requested.delete(params.id); return { status: 200, json: { success: true } }; },
  }) : null;
  const second = secondApi ? { api: secondApi.api, upload } : undefined;
  return { api, upload, uploads, classes, materials, requested, second, secondApi };
}

const run = (w: ReturnType<typeof world>) => lm.run({ api: w.api.api, upload: w.upload, ...(w.second ? { second: w.second } : {}) }, { tag: TAG });

describe('Little Monsters class-material live acceptance - doubled transport', () => {
  it('is degraded without Chromium: the handle leg passes, the files leg and the second caller are named gaps, and cleanup runs', async () => {
    const w = world();
    const result = await run(w);
    expect(result.state).toBe('degraded');
    expect(result.detail).toContain(`Class ${TAG}: handle leg: import-artifact answered 201 approved (grounded true)`);
    expect(result.detail).toContain(HOST_GAP);
    expect(result.detail).toContain('non-teacher leg unavailable: this runner binds no second caller (OSHAL_VERIFY_SECOND_PAT');
    const created = w.api.calls.find((c) => c.method === 'POST' && c.path === '/api/education/classes')!.body as { name: string };
    expect(created.name).toBe(TAG);
    expect(w.api.calls.find((c) => c.path === '/api/education/import-artifact')!.body).toEqual({ ref: 'art_0123456789abcdef', classId: CLASS_ID });
    expect(w.uploads[0].file).toMatchObject({ name: `${TAG}.pdf`, type: 'application/pdf' });
    expect(w.classes.size + w.materials.size).toBe(0);
    expect([...result.cleanup.removed].sort()).toEqual([`lm-class ${CLASS_ID}`, `lm-material ${MATERIAL_ID}`]);
    expect(result.cleanup.kept).toEqual(['send-to-handle art_0123456789abcdef (memory-only; expires 2026-09-28T13:00:00Z)']);
    expect(result.evidence.secondCaller).toBe('unavailable');
  });

  it('judges a bound second caller: requested, in the share requests, out of the shared materials, deleted through that caller', async () => {
    const w = world({ second: { enrolled: true } });
    const result = await run(w);
    expect(result.state).toBe('degraded');
    expect(result.detail).toContain(`non-teacher leg: import-artifact answered 201 requested and material ${SECOND_MATERIAL_ID} waits in the teacher's share requests`);
    expect(w.secondApi!.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/education/classes', 'POST /api/education/import-artifact', `DELETE /api/education/materials/${SECOND_MATERIAL_ID}`]);
    expect(w.api.calls.some((c) => c.path === `/api/education/materials/${SECOND_MATERIAL_ID}`)).toBe(false);
    expect(w.requested.size).toBe(0);
    expect(result.cleanup.removed).toContain(`lm-material ${SECOND_MATERIAL_ID}`);
    const unenrolled = await run(world({ second: { enrolled: false } }));
    expect(unenrolled.detail).toContain(`non-teacher leg unavailable: the second caller (OSHAL_VERIFY_SECOND_PAT) is not enrolled in the tagged class ${CLASS_ID}`);
    const approved = await run(world({ second: { enrolled: true, shareStatus: 'approved' } }));
    expect(approved.state).toBe('fail');
    expect(approved.detail).toContain("the second caller's import came back approved, not requested");
  });

  it('fails an import that is only requested and still removes the class', async () => {
    const w = world({ shareStatus: 'requested' });
    const result = await run(w);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('came back requested, not approved');
    expect(w.classes.size + w.materials.size).toBe(0);
  });

  it('turns a class that survives its delete into a red cleanup', async () => {
    const result = await run(world({ classDeleteStatus: 503 }));
    expect(result.state).toBe('fail');
    expect(result.detail).toContain(`CLEANUP INCOMPLETE: DELETE /api/education/classes/${CLASS_ID} answered HTTP 503`);
    expect(result.cleanup.outstanding).toEqual([`lm-class ${CLASS_ID}`]);
  });

  it('writes nothing when Little Monsters is not installed', async () => {
    const w = world({ over: { 'GET /api/little-monsters/home-summary': () => ({ status: 404 }) } });
    const result = await run(w);
    expect(result.state).toBe('unavailable');
    expect(w.api.calls.map((c) => c.method)).toEqual(['GET']);
    expect(w.uploads).toEqual([]);
  });

  it('generates PDFs the package\'s own parser reads', async () => {
    const fixture = lm.createFixture(TAG);
    for (const [pdf, line] of [[fixture.pdf, `Synthetic class handout ${TAG}.`], [fixture.browserPdf, `Synthetic files-browser handout ${TAG}.`], [fixture.secondPdf, `Synthetic student handout ${TAG}.`]] as Array<[Buffer, string]>) {
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      // Handed as a plain Uint8Array: pdf-parse's bundled pdf.js reads these same bytes as a
      // Uint8Array and refuses them as a small Node Buffer ("bad XRef entry"), which made this
      // check fail or pass by run rather than by the bytes.
      const parsed = await pdfParse(new Uint8Array(pdf));
      expect(parsed.numpages).toBe(1);
      expect(parsed.text).toContain(line);
    }
  });
});

const PAT = `oshal_pat_${'c'.repeat(48)}`;
const OTHER_CLASS = '5c1a55e5-0000-4000-8000-00000000000f';
const REF_SHAPE = String.raw`/^art_[A-Za-z0-9_-]{8,64}$/`;

/** Stands in for the cockpit shell: forwards artifact/artifactAction, shape-checked, into the surface iframe. */
function shellHtml(): string {
  return `<!doctype html><html><body><section id="mainContent"></section><script>
var p = new URLSearchParams(location.search); var ref = p.get('artifact'); var action = p.get('artifactAction');
var url = '/api/education/dashboard?v=' + Date.now();
if (ref && ${REF_SHAPE}.test(ref)) { url += '&artifact=' + encodeURIComponent(ref); if (action && /^[a-z0-9][a-z0-9-]{0,40}$/.test(action)) url += '&artifactAction=' + encodeURIComponent(action); }
if (p.get('app') === 'little-monsters') { var f = document.createElement('iframe'); f.src = url; f.style.cssText = 'width:100%;height:600px'; document.getElementById('mainContent').appendChild(f); }
</script></body></html>`;
}

/** Stands in for the Little Monsters home page's class-material picker; `ignores-select` posts another class. */
function dashboardHtml(mode: 'honest' | 'ignores-select'): string {
  return `<!doctype html><html><body><main><script>
(function () {
  var params = new URLSearchParams(location.search); var ref = params.get('artifact'); var action = params.get('artifactAction');
  if (action !== 'class-material' || !${REF_SHAPE}.test(ref || '')) return;
  var host = document.createElement('section'); host.id = 'classMaterialImport';
  var select = document.createElement('select'); select.disabled = true; host.appendChild(select);
  var button = document.createElement('button'); button.disabled = true; button.textContent = 'Import into selected class'; host.appendChild(button);
  var status = document.createElement('div'); status.setAttribute('data-class-material-status', ''); host.appendChild(status);
  document.body.appendChild(host);
  Promise.all([
    fetch('/api/artifacts/handles/' + encodeURIComponent(ref)).then(function (r) { if (!r.ok) throw new Error('This share expired'); return r.json(); }),
    fetch('/api/education/classes').then(function (r) { return r.json(); })
  ]).then(function (v) {
    (v[1].classes || []).forEach(function (c) { var o = document.createElement('option'); o.value = c.class_id; o.textContent = c.name; select.appendChild(o); });
    select.disabled = false; button.disabled = false;
  }).catch(function (e) { status.textContent = e.message; });
  button.addEventListener('click', function () {
    var classId = ${mode === 'ignores-select' ? `'${OTHER_CLASS}'` : 'select.value'};
    fetch('/api/education/import-artifact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: ref, classId: classId }) })
      .then(function (r) { return r.json().then(function (b) { status.textContent = r.ok ? b.message : (b.error || 'Import failed.'); }); });
  });
})();
</script></main></body></html>`;
}

/** A files page whose row carries the bytes (a data: URL), so send-to.js mints with bytes rather than a locator. */
function blobFilesHtml(fileName: string, pdf: Buffer): string {
  return `<!doctype html><html><body><script src="/api/artifacts/send-to.js" defer></script>
<div class="row" data-artifact-blob="data:application/pdf;base64,${pdf.toString('base64')}" data-artifact-type="application/pdf" data-artifact-name="${fileName}"><span class="nm">${fileName}</span></div>
</body></html>`;
}

/** Every file under a directory, recursively. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? filesUnder(join(dir, name)) : [name]));
}

describe('Little Monsters class-material live acceptance - real Chromium through the runner ports', () => {
  let server: Server, origin = '', root = '', savedRoot: string | undefined;
  const classes = new Map<string, string>([[OTHER_CLASS, 'Another class']]);
  const materials = new Map<string, { classId: string; name: string }>();
  const seen: Array<{ path: string; authorization: string | undefined }> = [];
  let dashboardMode: 'honest' | 'ignores-select' = 'honest';
  let blobPage: { fileName: string; pdf: Buffer } | null = null;

  beforeAll(async () => {
    savedRoot = process.env.OSHAL_WORKSPACE_ROOT;
    root = mkdtempSync(join(tmpdir(), 'lm-files-dispatch-')); process.env.OSHAL_WORKSPACE_ROOT = root;
    registerAppArtifactActions('little-monsters', { accepts: [{ id: 'class-material', label: 'File into a class', icon: '📚', types: ['image/*', 'application/pdf'], mode: 'open' }] });
    const app = express();
    app.use((req, res, next) => {
      seen.push({ path: new URL(req.url, 'http://x').pathname, authorization: req.headers.authorization });
      if (req.headers.authorization !== `Bearer ${PAT}`) { res.status(401).json({ error: 'unauthorized' }); return; }
      Object.assign(req, { oidc: { user: { sub: 'alice' }, isAuthenticated: () => true } }); next();
    });
    app.use(express.json());
    app.use('/shared', express.static(resolve('src/shared')));
    app.use('/api/artifacts', createArtifactExchangeRoutes({} as AppContext, async () => new Map([['little-monsters', 'Little Monsters']])));
    app.get(['/api/files', '/api/files/'], (_req, res, next) => { if (!blobPage) { next(); return; } res.type('html').send(blobFilesHtml(blobPage.fileName, blobPage.pdf)); });
    app.use('/api/files', createFilesRoutes({ pool: { query: async () => ({ rows: [] }) } } as unknown as AppContext, resolve('src/api')));
    app.get('/cockpit/', (_req, res) => res.type('html').send(shellHtml()));
    app.get('/api/education/dashboard', (_req, res) => res.type('html').send(dashboardHtml(dashboardMode)));
    app.get('/api/little-monsters/home-summary', (_req, res) => res.json({ role: 'admin' }));
    app.post('/api/education/classes', (req, res) => { const id = randomUUID(); classes.set(id, String(req.body.name)); res.status(201).json({ classId: id }); });
    app.get('/api/education/classes', (_req, res) => res.json({ classes: [...classes].map(([class_id, name]) => ({ class_id, name })) }));
    app.get('/api/education/classes/:id/info', (req, res) => res.status(classes.has(req.params.id) ? 200 : 404).json({}));
    app.delete('/api/education/classes/:id', (req, res) => { classes.delete(req.params.id); res.json({ success: true }); });
    app.get('/api/education/classes/:id/shared-materials', (req, res) => res.json({ materials: [...materials].filter(([, m]) => m.classId === req.params.id).map(([material_id]) => ({ material_id })) }));
    app.delete('/api/education/materials/:id', (req, res) => { materials.delete(req.params.id); res.json({ success: true }); });
    app.post('/api/education/import-artifact', async (req, res) => {
      const classId = String(req.body.classId || '');
      if (!classes.has(classId)) { res.status(403).json({ error: 'Class access denied' }); return; }
      const redeemed = await redeemArtifactViaRelay({ port: req.socket.localPort, callerSub: 'alice', ref: String(req.body.ref || ''), maxBytes: 10_000_000, request: req });
      if (!redeemed.ok) { res.status(redeemed.status).json({ error: redeemed.error }); return; }
      if (!redeemed.buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) { res.status(415).json({ error: 'unsupported_artifact_type' }); return; }
      const id = randomUUID(); materials.set(id, { classId, name: redeemed.name });
      res.status(201).json({ success: true, material: { material_id: id }, grounded: false, shareStatus: 'approved', message: `Imported ${redeemed.name} into the class` });
    });
    server = app.listen(0, '127.0.0.1'); await new Promise<void>((done) => server.once('listening', done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 30_000);
  afterAll(async () => {
    unregisterAppArtifactActions('little-monsters');
    if (savedRoot === undefined) delete process.env.OSHAL_WORKSPACE_ROOT; else process.env.OSHAL_WORKSPACE_ROOT = savedRoot;
    server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  });
  const ports = () => ({ ...runner.httpPorts(origin, PAT), browser: runner.browserPort(origin, PAT) });

  it('passes: the shipped files page sends the PDF, the shell forwards it, the class is chosen in the picker, the destination imports it, and the file is removed', async () => {
    dashboardMode = 'honest'; blobPage = null; seen.length = 0;
    const tag = 'testlab-live-lm-class-material-0b2c3d4e';
    const result = await lm.run(ports(), { tag });
    expect(result.state, result.detail).toBe('pass');
    expect(result.detail).toContain('files leg: files browser -> Send to... "class-material" minted art_');
    expect(result.detail).toContain('the class chosen there was imported (201 approved');
    expect(result.evidence.files).toMatchObject({ mint: '/api/artifacts/handles', shell: expect.stringContaining('app=little-monsters') });
    expect(result.evidence.files.viewport).toBeGreaterThanOrEqual(1024);
    expect(seen.length).toBeGreaterThan(10);
    expect(seen.every((r) => r.authorization === `Bearer ${PAT}`)).toBe(true);
    expect(materials.size).toBe(0); expect([...classes.keys()]).toEqual([OTHER_CLASS]);
    expect(filesUnder(join(root, 'userfiles'))).toEqual([]);
    expect(result.cleanup.removed).toContain(`oshal-local-file ${tag}-files.pdf`);
    expect(result.cleanup.removed.filter((r: string) => r.startsWith('lm-material'))).toHaveLength(2);
  }, 120_000);

  it('fails a dispatch whose handle carried bytes instead of the files browser locator, and still cleans up', async () => {
    dashboardMode = 'honest';
    const tag = 'testlab-live-lm-class-material-0c3d4e5f';
    blobPage = { fileName: `${tag}-files.pdf`, pdf: lm.createFixture(tag).browserPdf };
    const result = await lm.run(ports(), { tag });
    blobPage = null;
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('files leg: the dispatch did not mint over the files browser download route (/api/artifacts/handles/upload)');
    expect(result.cleanup.outstanding).toEqual([]); expect(result.cleanup.errors).toEqual([]);
    expect(materials.size).toBe(0); expect(filesUnder(join(root, 'userfiles'))).toEqual([]);
  }, 120_000);

  it('fails an import that did not carry the class chosen in the dispatch', async () => {
    dashboardMode = 'ignores-select'; blobPage = null;
    const tag = 'testlab-live-lm-class-material-0d4e5f60';
    const result = await lm.run(ports(), { tag });
    dashboardMode = 'honest';
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('files leg: the import did not carry the class chosen in the dispatch (picker held ');
    expect(result.detail).toContain(`posted ${OTHER_CLASS}`);
    expect(result.cleanup.outstanding).toEqual([]); expect(materials.size).toBe(0);
  }, 120_000);
});
