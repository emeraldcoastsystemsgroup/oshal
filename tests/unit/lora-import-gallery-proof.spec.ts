/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the gallery mode of the LoRA import live proof (`--gallery`). Pure: the synthetic photo is a valid, unique 512 x 512 RGB PNG; the mint body is exactly the gallery's Send-to body over the portrait's image route; the surface labels are the studio's own; the catalog pick, the Portrait Studio preflight and the container env read. In-memory run: the pass path creates the portrait (multipart `photo`, the first professional style), titles it with the fixture tag, mints through POST /api/artifacts/handles with the image route as source and NEVER the upload mint, imports through the surface port with that handle, and removes the portrait (after it revalidates by title), the character, the ticket and the box files; red when the surface shows queued while the receipt route says ready, when the page raised an error, when the portrait fails or never settles, when the studio's import answers 503, when the catalog has no style, when the title does not revalidate, and when the portrait survives cleanup. Real Chromium: the real surface port against a loopback stand-in of the LoRA studio (lora.html's ids, buttons and receipt labels): a surface that renders the receipt ready passes with the token on every same-origin request and an off-origin beacon that never leaves the browser; a surface that keeps rendering "queued for worker" after the receipt route flipped to ready fails by name.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The off-origin beacon check could not go red: it targeted http://localhost:<port>, which never reached the 127.0.0.1 listener, so the check passed with the browser session continuing off-origin requests WITH the token. The beacon now targets a second loopback listener on 127.0.0.1 (another port, another origin); the stand-in page loads its characters only after the beacon settles and reports the outcome same-origin; the pass case asserts that listener received zero requests, that the page saw the beacon refused, and that no request on either listener carried the token off-origin. A control case opens a session whose origin IS that listener and requires the token to arrive there, so the zero is a measurement of a reachable listener, not of an unreachable one.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import sharp from 'sharp';

const requireCjs = createRequire(import.meta.url);
const proof = requireCjs('../../scripts/operations/lora-import-live-proof.js');
const source = requireCjs('../../scripts/lib/lora-gallery-source.js');

const OWNER = 'fixture|lora-owner';
const CHARACTER_ID = '11111111-2222-3333-4444-555555555555';
const STORAGE_KEY = `lora-${CHARACTER_ID.replace(/-/g, '')}`;
const PORTRAIT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const FILENAME = 'portrait-aaaaaaaa.png';
const REF = 'art_fixture_gallery_0001';
const CLIENT = 'node-fixture-worker';
const TOKEN = 'oshal_pat_fixture_gallery_0000';
const PORTRAIT_BYTES = 4321;
const LABEL: Record<string, string> = { ready: 'ready on worker', failed: 'worker write failed', queued: 'queued for worker' };

interface Options {
  portrait?: 'done' | 'failed' | 'stuck'; shown?: 'ready' | 'queued' | 'failed' | 'missing'; pageErrors?: string[]; importStatus?: number;
  keepPortrait?: boolean; receipt?: string; noStyle?: boolean; retitle?: string;
}

/** The server, the engine, the worker and the box, in memory. */
interface State {
  options: Options;
  characters: Set<string>;
  portraits: Map<string, { status: string; title: string; polls: number; fields: Record<string, string>; file: { field: string; type: string; bytes: Buffer } }>;
  box: Map<string, { bytes: number; caption: string }>;
  tickets: Set<string>;
  results: Map<string, Record<string, unknown>>;
  commands: string[];
  mints: Array<{ route: string; body: unknown }>;
  imports: Array<{ ref: string; subject: string; caption: string }>;
  surfaceInputs: unknown[];
  fixture: { subject: string; displayName: string } | null;
}

function newState(options: Options): State {
  return { options, characters: new Set(), portraits: new Map(), box: new Map(), tickets: new Set(), results: new Map(),
    commands: [], mints: [], imports: [], surfaceInputs: [], fixture: null };
}

/** What the engine reports for the portrait on each gallery read: generating twice, then settled. */
function portraitRow(state: State, id: string, p: State['portraits'] extends Map<string, infer V> ? V : never) {
  p.polls += 1;
  const settled = state.options.portrait ?? 'done';
  const status = p.polls < 3 || settled === 'stuck' ? 'generating' : settled;
  return { portrait_id: id, title: p.title, status, error: status === 'failed' ? 'vendor refused the source image' : null,
    model: status === 'done' ? 'openai:gpt-image-1' : null, cost_usd: status === 'done' ? '0.0400' : null };
}

/** POST /api/lora/dataset/import as the page posts it, including the worker write it queues. */
function importRoute(state: State, body: { ref: string; subject: string; caption: string }) {
  state.imports.push(body);
  state.tickets.add('ticket-import');
  if (state.options.importStatus) return { status: state.options.importStatus, json: { ok: false, status: 'box_required', ticketId: 'ticket-import', message: 'no worker' } };
  if ((state.options.receipt ?? 'ready') === 'ready') state.box.set(`expanded/${STORAGE_KEY}/curated/${FILENAME}`, { bytes: PORTRAIT_BYTES, caption: body.caption });
  state.results.set('lora-task-1', { status: 'failed', output: { stdout: '', stderr: 'write failed', exitCode: 1 } });
  return { status: 202, json: { ok: true, subject: body.subject, filename: FILENAME, byteSize: PORTRAIT_BYTES, ticketId: 'ticket-import',
    clientId: CLIENT, taskId: 'lora-task-1', message: `Dataset image ${FILENAME} queued for ${body.subject}.` } };
}

/** The receipt list the studio and the proof read. */
function datasetRoute(state: State, subject: string) {
  if (!state.characters.has(subject)) return { status: 404, json: { error: 'character not found' } };
  const images = state.imports.map((entry) => ({ filename: FILENAME, status: state.options.receipt ?? 'ready', byte_size: PORTRAIT_BYTES, caption: entry.caption }));
  return { status: 200, json: { subject, storageKey: STORAGE_KEY, images } };
}

/** What the worker's PowerShell prints for the probe and removal commands. */
function runBox(state: State, command: string): string {
  if (command.includes('Remove-Item')) {
    for (const k of [...state.box.keys()]) if (k.includes(STORAGE_KEY)) state.box.delete(k);
    return JSON.stringify({ expanded: false, literal: false });
  }
  const entry = (loc: string) => { const v = state.box.get(`${loc}/${STORAGE_KEY}/curated/${FILENAME}`) ?? null;
    return { png: Boolean(v), bytes: v ? v.bytes : 0, txt: Boolean(v), caption: v ? v.caption : '' }; };
  return JSON.stringify({ expanded: entry('expanded'), literal: entry('literal') });
}

/** Every route the proof calls over its bearer port, in the real response shapes. */
function fakeRoutes(state: State) {
  return vi.fn(async (method: string, route: string, body?: Record<string, unknown>) => {
    const [path, query = ''] = route.split('?');
    if (method === 'GET' && path === '/api/lora/dataset') return datasetRoute(state, decodeURIComponent(query.split('subject=')[1]));
    if (method === 'POST' && path === '/api/lora/characters') {
      state.characters.add(String(body!.subject));
      state.fixture = { subject: String(body!.subject), displayName: String(body!.displayName) };
      return { status: 201, json: {} };
    }
    if (method === 'GET' && path === '/api/portrait-studio/catalog') {
      return { status: 200, json: { presets: { professional: state.options.noStyle ? [] : [{ id: 'corporate-classic', label: 'Corporate classic' }] } } };
    }
    if (method === 'PATCH' && path === `/api/portrait-studio/portraits/${PORTRAIT_ID}`) {
      const p = state.portraits.get(PORTRAIT_ID);
      if (!p) return { status: 404, json: {} };
      p.title = state.options.retitle ?? String(body!.title);
      return { status: 200, json: { portrait_id: PORTRAIT_ID, title: p.title } };
    }
    if (method === 'GET' && path === '/api/portrait-studio/portraits') {
      return { status: 200, json: { portraits: [...state.portraits.entries()].map(([id, p]) => portraitRow(state, id, p)) } };
    }
    if (method === 'DELETE' && path === `/api/portrait-studio/portraits/${PORTRAIT_ID}`) {
      if (!state.portraits.has(PORTRAIT_ID)) return { status: 404, json: {} };
      if (!state.options.keepPortrait) state.portraits.delete(PORTRAIT_ID);
      return { status: 200, json: { ok: true } };
    }
    if (method === 'POST' && (path === '/api/artifacts/handles' || path === '/api/artifacts/handles/upload')) {
      state.mints.push({ route: path, body });
      return { status: 201, json: { ref: REF, type: 'image/png', name: FILENAME, expiresAt: '2026-09-29T03:00:00.000Z' } };
    }
    if (method === 'POST' && path === '/api/lora/dataset/import') return importRoute(state, body as { ref: string; subject: string; caption: string });
    if (method === 'POST' && path === `/api/remote-clients/${CLIENT}/tasks`) {
      const command = String((body!.input as { arguments: { command: string } }).arguments.command);
      state.commands.push(command);
      state.results.set(String(body!.taskId), { status: 'completed', output: { stdout: runBox(state, command), stderr: '', exitCode: 0 } });
      return { status: 201, json: {} };
    }
    if (method === 'GET' && path.startsWith(`/api/remote-clients/${CLIENT}/tasks/`)) {
      const result = state.results.get(decodeURIComponent(path.split('/')[5]));
      return result ? { status: 200, json: result } : { status: 404, json: {} };
    }
    throw new Error(`unexpected ${method} ${route}`);
  });
}

/** The ports a gallery run binds, with the surface either faked in memory or the real Chromium port. */
function fake(options: Options = {}, surface?: { importImage: unknown }) {
  const state = newState(options);
  const ticketRow = () => ({ ownerSub: OWNER, ticketType: 'lora-train', metadata: { character: state.fixture?.subject, action: 'dataset-import' } });
  const fakeSurface = {
    importImage: vi.fn(async (input: { ref: string; caption: string }) => {
      state.surfaceInputs.push(input);
      const response = importRoute(state, { ref: input.ref, subject: state.fixture!.subject, caption: input.caption });
      const shown = options.shown ?? 'ready';
      return { response, pageErrors: options.pageErrors ?? [],
        shown: response.status === 202 ? { status: shown, text: shown === 'missing' ? '' : `${FILENAME} ${LABEL[shown]} ${input.caption}`, elapsedMs: 3_000 } : null };
    }),
  };
  const ports = {
    ownerSub: OWNER, source: 'gallery', api: fakeRoutes(state), loraVersion: '1.7.1', portraitVersion: '1.15.2', boxRoot: proof.DEFAULT_BOX_ROOT,
    workerAgentIds: { [CLIENT]: CLIENT }, surface: surface ?? fakeSurface,
    tickets: { getTicket: vi.fn(async (id: string) => (state.tickets.has(id) ? ticketRow() : null)), deleteTicket: vi.fn(async (id: string) => { state.tickets.delete(id); }) },
    upload: vi.fn(async () => ({ status: 201, json: { ref: 'art_upload_must_not_be_used' } })),
    multipart: vi.fn(async (route: string, fields: Record<string, string>, file: { field: string; type: string; bytes: Buffer }) => {
      if (route !== '/api/portrait-studio/portraits') throw new Error(`unexpected multipart ${route}`);
      state.portraits.set(PORTRAIT_ID, { status: 'queued', title: '', polls: 0, fields, file });
      return { status: 202, json: { portraitId: PORTRAIT_ID, status: 'queued' } };
    }),
    sql: vi.fn(async (name: string, params: string[]) => {
      if (name === 'lora.character-id') return { rows: state.characters.has(params[1]) ? [{ id: CHARACTER_ID }] : [] };
      if (name === 'lora.character-delete') { state.characters.delete(params[1]); return { rows: [] }; }
      if (name === 'lora.residue') return { rows: [{ characters: state.characters.has(params[1]) ? 1 : 0, receipts: 0 }] };
      throw new Error(`unexpected statement ${name}`);
    }),
    withOwner: <T>(fn: () => Promise<T>) => fn(),
    sleep: async () => undefined,
    now: (() => { let t = 0; return () => (t += 1_000); })(),
  };
  return { ports, state };
}

describe('the gallery source, pure', () => {
  it('generates a valid, unique 512 x 512 RGB photo that stays small', async () => {
    const a = source.generatePortraitPhoto();
    const b = source.generatePortraitPhoto();
    const decoded = await sharp(a).raw().toBuffer({ resolveWithObject: true });
    expect([decoded.info.width, decoded.info.height, decoded.info.channels]).toEqual([512, 512, 3]);
    expect(a.equals(b)).toBe(false);
    expect(a.length).toBeLessThan(64 * 1024);
    const fixture = proof.createImportFixture(undefined, 'gallery');
    expect(fixture.png).toBeNull();
    // The random patch deflates to a slightly different length each run, so the photo is pinned by shape, not by size.
    const photo = await sharp(fixture.photo).metadata();
    expect([photo.width, photo.height, photo.format]).toEqual([512, 512, 'png']);
    expect(proof.createImportFixture().photo).toBeNull();
  });

  it('mints exactly what the gallery Send to… posts: the portrait image route as source, image/png, portrait-<8>.png', () => {
    expect(source.galleryHandleBody(PORTRAIT_ID)).toEqual({ source: `/api/portrait-studio/portraits/${PORTRAIT_ID}/image`, type: 'image/png', name: FILENAME });
  });

  it('reads the studio own receipt labels and picks the first professional style', () => {
    expect(source.SURFACE_STATUS_TEXT).toEqual(LABEL);
    expect(source.surfaceStatusOf(`${FILENAME} ready on worker caption`)).toBe('ready');
    expect(source.surfaceStatusOf('x worker write failed')).toBe('failed');
    expect(source.surfaceStatusOf('x queued for worker')).toBe('queued');
    expect(source.surfaceStatusOf('No curated images recorded yet.')).toBe('missing');
    expect(source.pickStyle({ presets: { professional: [{ id: 'corporate-classic' }, { id: 'other' }] } })).toBe('corporate-classic');
    expect(source.pickStyle({ presets: { professional: [] } })).toBeNull();
    expect(source.pickStyle({})).toBeNull();
  });

  it('refuses to run without the portrait package or a configured image engine, and reads the box root from the api container', async () => {
    const api = (apps: object[], provider: { status: number; json: object }) => vi.fn(async (_m: string, route: string) =>
      (route.startsWith('/api/swarm/apps') ? { status: 200, json: { apps } } : provider));
    expect(await source.portraitPreflight(api([], { status: 200, json: { configured: true } }))).toEqual({ ok: false, detail: 'The portrait-studio package is not installed and active on this box' });
    const off = await source.portraitPreflight(api([{ name: 'portrait-studio', version: '1.15.2' }], { status: 200, json: { configured: false, hint: 'no image provider key' } }));
    expect(off).toEqual({ ok: false, detail: "Portrait Studio's image provider is not configured (no image provider key)" });
    const on = await source.portraitPreflight(api([{ name: 'portrait-studio', version: '1.15.2' }], { status: 200, json: { configured: true, provider: 'openai' } }));
    expect(on).toEqual({ ok: true, version: '1.15.2', provider: 'openai' });
    const calls: string[][] = [];
    const exec = (args: string[]) => { calls.push(args); return { status: args.includes('LORA_BOX_ROOT') ? 0 : 1, stdout: 'D:/lora\n' }; };
    expect(source.readContainerEnv('oshal-local-api', 'LORA_BOX_ROOT', exec)).toBe('D:/lora');
    expect(source.readContainerEnv('oshal-local-api', 'OTHER', exec)).toBe('');
    expect(calls[0]).toEqual(['exec', 'oshal-local-api', 'printenv', 'LORA_BOX_ROOT']);
  });
});

describe('runLoraImportAcceptance in gallery mode', () => {
  it('creates and titles the portrait, mints the locator handle as the gallery does, imports in the surface, passes, and removes everything', async () => {
    const f = fake();
    const result = await proof.runLoraImportAcceptance(f.ports);
    expect(result.state, result.detail).toBe('pass');
    expect(result.detail).toContain('the studio page showed it "ready on worker" and the .png/.txt pair is in the character\'s curated folder');
    expect(result.detail).toContain('The box directory, the import ticket, the portrait and the character (receipt, staging, grants) were removed.');
    expect(result.evidence).toMatchObject({ source: 'gallery', loraVersion: '1.7.1', portraitStudioVersion: '1.15.2', filename: FILENAME, bytes: PORTRAIT_BYTES,
      receipt: 'ready', cleanupErrors: [], portrait: { id: PORTRAIT_ID, style: 'corporate-classic', status: 'done', model: 'openai:gpt-image-1', costUsd: 0.04 },
      surface: { shown: 'ready', pageErrors: [] } });
    // The handle is the gallery's own locator mint over the portrait image route - never the upload mint.
    expect(f.state.mints).toEqual([{ route: '/api/artifacts/handles', body: { source: `/api/portrait-studio/portraits/${PORTRAIT_ID}/image`, type: 'image/png', name: FILENAME } }]);
    expect(f.ports.upload).not.toHaveBeenCalled();
    // The import happened in the surface with that handle, for the fixture character, with the caption.
    expect(f.state.surfaceInputs).toEqual([{ ref: REF, displayName: f.state.fixture!.displayName, caption: `${f.state.fixture!.subject}, synthetic Test Lab import fixture` }]);
    expect(f.state.imports).toEqual([{ ref: REF, subject: f.state.fixture!.subject, caption: `${f.state.fixture!.subject}, synthetic Test Lab import fixture` }]);
    expect(f.ports.api).not.toHaveBeenCalledWith('POST', '/api/lora/dataset/import', expect.anything());
    // The portrait was a real create (multipart photo, the first professional style) titled with the fixture tag.
    expect(f.ports.multipart).toHaveBeenCalledTimes(1);
    const [, fields, file] = f.ports.multipart.mock.calls[0];
    expect(fields).toEqual({ mode: 'professional', style: 'corporate-classic', options: '{}' });
    expect(file).toMatchObject({ field: 'photo', type: 'image/png', name: `${f.state.fixture!.subject}-photo.png` });
    expect(f.ports.api).toHaveBeenCalledWith('PATCH', `/api/portrait-studio/portraits/${PORTRAIT_ID}`, { title: f.state.fixture!.subject });
    expect(f.state.portraits.size).toBe(0);
    expect(f.state.characters.size).toBe(0);
    expect(f.state.tickets.size).toBe(0);
    expect(f.state.box.size).toBe(0);
  });

  it('is red when the surface never shows "ready on worker" although the receipt route says ready', async () => {
    const f = fake({ shown: 'queued' });
    const result = await proof.runLoraImportAcceptance(f.ports);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain(`The LoRA surface did not show "ready on worker" for ${FILENAME}: #datasetRows showed "${FILENAME} queued for worker`);
    expect(result.detail).toContain('(the receipt route says ready after');
    expect(result.detail).not.toContain('CLEANUP INCOMPLETE');
    const missing = await proof.runLoraImportAcceptance(fake({ shown: 'missing' }).ports);
    expect(missing.detail).toContain('#datasetRows showed no row for it after');
    const errored = await proof.runLoraImportAcceptance(fake({ pageErrors: ['TypeError: x is undefined'] }).ports);
    expect(errored.state).toBe('fail');
    expect(errored.detail).toContain('raised 1 page error(s): TypeError: x is undefined');
  });

  it('is red when the engine fails or never settles the portrait, mints nothing, and still removes the portrait and character', async () => {
    const failed = fake({ portrait: 'failed' });
    const result = await proof.runLoraImportAcceptance(failed.ports);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('The portrait did not reach "done" (status failed after');
    expect(result.detail).toContain('vendor refused the source image');
    expect(failed.state.mints).toEqual([]);
    expect(failed.ports.surface.importImage).not.toHaveBeenCalled();
    expect(failed.state.portraits.size).toBe(0);
    expect(failed.state.characters.size).toBe(0);
    const stuck = fake({ portrait: 'stuck' });
    const late = await proof.runLoraImportAcceptance(stuck.ports, { portraitBudgetMs: 10_000 });
    expect(late.state).toBe('fail');
    expect(late.detail).toContain('The portrait did not reach "done" (status generating after');
    expect(late.detail).toContain(`CLEANUP INCOMPLETE: portrait ${PORTRAIT_ID} was still generating when deleted`);
    expect(stuck.state.portraits.size).toBe(0);
  });

  it('is red when the studio import answers 503, when the catalog lists no style, and when the portrait survives or does not revalidate', async () => {
    const refused = fake({ importStatus: 503 });
    const result = await proof.runLoraImportAcceptance(refused.ports);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain("The studio's import answered HTTP 503 box_required");
    expect(refused.state.tickets.size).toBe(0);
    expect(refused.state.portraits.size).toBe(0);
    const noStyle = fake({ noStyle: true });
    const styleless = await proof.runLoraImportAcceptance(noStyle.ports);
    expect(styleless.detail).toContain('GET /api/portrait-studio/catalog answered HTTP 200 with no professional style.');
    expect(noStyle.ports.multipart).not.toHaveBeenCalled();
    expect(noStyle.state.characters.size).toBe(0);
    const kept = await proof.runLoraImportAcceptance(fake({ keepPortrait: true }).ports);
    expect(kept.state).toBe('fail');
    expect(kept.detail).toContain(`CLEANUP INCOMPLETE: portrait ${PORTRAIT_ID} still listed after deletion`);
    const retitled = fake({ retitle: 'someone-elses-portrait' });
    const mismatch = await proof.runLoraImportAcceptance(retitled.ports);
    expect(mismatch.detail).toContain(`portrait ${PORTRAIT_ID} did not revalidate as this run's fixture (title mismatch); not deleted`);
    expect(retitled.state.portraits.size).toBe(1);
  });
});

/**
 * A loopback stand-in for the LoRA studio: lora.html's ids, buttons and receipt labels. `stale` renders every receipt as queued.
 * Before anything else the page fetches `<offOrigin>/beacon`, reports the outcome same-origin, and only then loads the characters,
 * so every run's import happens after the off-origin request has settled.
 */
function studioHtml(stale: boolean, offOrigin: string): string {
  const label = stale
    ? "function label(){ return 'queued for worker'; }"
    : "function label(s){ return s==='ready'?'ready on worker':s==='failed'?'worker write failed':'queued for worker'; }";
  return `<!doctype html><html><body>
<div id="chars"></div>
<div id="actions" style="display:none">
  <textarea id="datasetCaption"></textarea>
  <button class="btn sm" id="importArtifactBtn" type="button" disabled>Import selected image</button>
  <button class="btn ghost sm" id="refreshDatasetBtn" type="button">Refresh dataset</button>
  <div id="datasetRows">Loading dataset receipts…</div>
</div>
<script>
const $=(id)=>document.getElementById(id); let SEL=null;
const ARTIFACT_REF=new URLSearchParams(location.search).get('artifact')||'';
${label}
async function api(p,o){ const r=await fetch('/api/lora'+p,o); return {ok:r.ok,j:await r.json().catch(()=>({}))}; }
async function loadDataset(){ const {j}=await api('/dataset?subject='+encodeURIComponent(SEL));
  $('datasetRows').innerHTML=(j.images||[]).map((row)=>'<div class="card"><div><b>'+row.filename+'</b> <span class="badge">'+label(row.status)+'</span></div><div class="hint">'+(row.caption||'')+'</div></div>').join('')||'<div class="hint">No curated images recorded yet.</div>'; }
async function loadChars(){ const {j}=await api('/characters'); const chars=j.characters||[];
  $('chars').innerHTML=chars.map((c,i)=>'<div class="card" data-i="'+i+'"><div class="nm">'+c.display_name+'</div></div>').join('');
  $('chars').querySelectorAll('.card').forEach((n)=>n.addEventListener('click',()=>{ SEL=chars[Number(n.dataset.i)].subject; $('actions').style.display='block'; $('importArtifactBtn').disabled=!ARTIFACT_REF; loadDataset(); })); }
$('importArtifactBtn').addEventListener('click',async()=>{ $('importArtifactBtn').disabled=true;
  const {ok}=await api('/dataset/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ref:ARTIFACT_REF,subject:SEL,caption:$('datasetCaption').value.trim()})});
  if(ok) await loadDataset(); else $('importArtifactBtn').disabled=false; });
$('refreshDatasetBtn').addEventListener('click',()=>loadDataset());
fetch('${offOrigin}/beacon').then(()=>'answered',()=>'refused')
  .then((o)=>fetch('/api/lora/beacon-outcome?o='+o)).catch(()=>undefined).then(()=>loadChars());
</script></body></html>`;
}

describe('the surface port in real Chromium against a loopback stand-in of the studio', () => {
  type Seen = { origin: string; method: string; path: string; query: string; authorization: string | undefined };
  /** Requests the studio stand-in received, and requests the second (off-origin) loopback listener received. */
  const seen: Seen[] = [];
  const offSeen: Seen[] = [];
  let server: http.Server;
  let offServer: http.Server;
  let origin = '';
  let offOrigin = '';
  let stale = false;
  let current: State = newState({});

  const record = (into: Seen[], req: http.IncomingMessage) => {
    const url = new URL(req.url || '/', 'http://x');
    into.push({ origin: `http://${req.headers.host}`, method: req.method || '', path: url.pathname, query: url.search, authorization: req.headers.authorization });
    return url;
  };
  const listen = async (s: http.Server) => { await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve())); return `http://127.0.0.1:${(s.address() as AddressInfo).port}`; };
  const readBody = (req: http.IncomingMessage) => new Promise<string>((resolve) => { let text = ''; req.on('data', (c) => { text += c; }); req.on('end', () => resolve(text)); });
  const reply = (res: http.ServerResponse, out: { status: number; json: unknown }) => { res.writeHead(out.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(out.json)); };
  /** No request on either listener carried the token anywhere but the studio origin. */
  const tokenOffOrigin = () => [...seen, ...offSeen].filter((r) => r.authorization === `Bearer ${TOKEN}` && r.origin !== origin);

  beforeAll(async () => {
    // A second listener on the same loopback address with its own port: a different origin the browser can reach.
    // It answers with CORS open, so a request that got through would also read as "answered" in the page.
    offServer = http.createServer((req, res) => {
      record(offSeen, req);
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end('{}');
    });
    offOrigin = await listen(offServer);
    server = http.createServer(async (req, res) => {
      const url = record(seen, req);
      if (url.pathname === '/api/lora/ui') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(studioHtml(stale, offOrigin)); return; }
      if (url.pathname === '/api/lora/beacon-outcome') { reply(res, { status: 200, json: {} }); return; }
      if (url.pathname === '/api/lora/characters') { reply(res, { status: 200, json: { characters: current.fixture ? [{ subject: current.fixture.subject, display_name: current.fixture.displayName }] : [] } }); return; }
      if (url.pathname === '/api/lora/dataset') { reply(res, datasetRoute(current, url.searchParams.get('subject') || '')); return; }
      if (url.pathname === '/api/lora/dataset/import' && req.method === 'POST') { reply(res, importRoute(current, JSON.parse(await readBody(req)))); return; }
      reply(res, { status: 404, json: {} });
    });
    origin = await listen(server);
    expect(offOrigin).not.toBe(origin);
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => offServer.close(resolve));
  });

  it('control: the off-origin listener is reachable from this Chromium, and a session whose origin it is delivers the token there', async () => {
    seen.length = 0;
    offSeen.length = 0;
    const status = await source.browserSession(offOrigin, TOKEN)(async (page: { goto: (u: string) => Promise<{ status: () => number } | null> }) => {
      const loaded = await page.goto(`${offOrigin}/control`);
      return loaded ? loaded.status() : 0;
    });
    expect(status).toBe(200);
    expect(offSeen.filter((r) => r.path === '/control')).toEqual([{ origin: offOrigin, method: 'GET', path: '/control', query: '', authorization: `Bearer ${TOKEN}` }]);
    expect(seen).toEqual([]);
  }, 60_000);

  it('passes when the studio page itself shows the file "ready on worker", with the token on every same-origin request and none off-origin', async () => {
    stale = false;
    seen.length = 0;
    offSeen.length = 0;
    const f = fake({}, source.createSurfacePort({ origin, token: TOKEN }));
    current = f.state;
    const result = await proof.runLoraImportAcceptance(f.ports, { readyBudgetMs: 30_000 });
    expect(result.state, result.detail).toBe('pass');
    expect(result.evidence.surface).toMatchObject({ shown: 'ready', pageErrors: [] });
    expect(result.evidence.surface.text).toContain(`${FILENAME} ready on worker`);
    expect(f.state.imports).toEqual([{ ref: REF, subject: f.state.fixture!.subject, caption: `${f.state.fixture!.subject}, synthetic Test Lab import fixture` }]);
    expect(seen.map((r) => r.path)).toContain('/api/lora/dataset/import');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.origin === origin && r.authorization === `Bearer ${TOKEN}`)).toBe(true);
    // The page fired the off-origin beacon before it loaded the characters, and the browser refused it:
    // the second listener received nothing, and no request on either listener carried the token off-origin.
    // Soft, so a session that lets the beacon out reports all three at once.
    expect.soft(offSeen).toEqual([]);
    expect.soft(tokenOffOrigin()).toEqual([]);
    expect.soft(seen.filter((r) => r.path === '/api/lora/beacon-outcome').map((r) => r.query)).toEqual(['?o=refused']);
    expect(f.state.portraits.size + f.state.characters.size + f.state.tickets.size + f.state.box.size).toBe(0);
  }, 90_000);

  it('fails by name when the page keeps rendering "queued for worker" after the receipt route flipped to ready', async () => {
    stale = true;
    seen.length = 0;
    offSeen.length = 0;
    const f = fake({}, source.createSurfacePort({ origin, token: TOKEN }));
    current = f.state;
    const result = await proof.runLoraImportAcceptance(f.ports, { readyBudgetMs: 30_000 });
    expect(result.state).toBe('fail');
    expect(result.detail).toContain(`The LoRA surface did not show "ready on worker" for ${FILENAME}: #datasetRows showed "${FILENAME} queued for worker`);
    expect(result.detail).toContain('(the receipt route says ready after');
    expect(result.detail).not.toContain('CLEANUP INCOMPLETE');
    expect(seen.filter((r) => r.path === '/api/lora/dataset').length).toBeGreaterThan(1);
  }, 90_000);
});
