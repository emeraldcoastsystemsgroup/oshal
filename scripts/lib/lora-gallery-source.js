/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the gallery source of the LoRA import live proof (scripts/operations/lora-import-live-proof.js --gallery): the real Portrait Studio gallery instead of a generated PNG carried by the upload mint. As the operator automation identity it creates one synthetic portrait through POST /api/portrait-studio/portraits (a flat synthetic photo, the first professional style the catalog lists), titles it with the run's fixture tag, waits for the engine to mark it done, mints the locator handle exactly as the gallery's Send to… does ({source: /api/portrait-studio/portraits/<id>/image, type: image/png, name: portrait-<8>.png} to POST /api/artifacts/handles - never the upload mint), then opens /api/lora/ui?artifact=<ref> in a headless Chromium as the caller, clicks the fixture character, "Import selected image", and reads #datasetRows until the studio itself shows the file "ready on worker". The browser token rides only on same-origin requests and every other request is aborted in the browser. Cleanup re-reads the portrait by its title tag before DELETE /api/portrait-studio/portraits/:id and requires it gone. The PNG encoder the inline mode's generated image uses lives here too.
 */

'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

/** The Portrait Studio package the gallery belongs to, and its mount. */
const PORTRAIT_APP = 'portrait-studio';
const PORTRAIT_API = '/api/portrait-studio';
/** The LoRA studio surface the import happens in, and the route the page posts the import to. */
const LORA_UI_PATH = '/api/lora/ui';
const LORA_IMPORT_PATH = '/api/lora/dataset/import';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDLE_REF_RE = /^art_[A-Za-z0-9_-]{8,64}$/;
/** What the studio prints beside a receipt (lora.html datasetStatusText), by receipt status. */
const SURFACE_STATUS_TEXT = Object.freeze({ ready: 'ready on worker', failed: 'worker write failed', queued: 'queued for worker' });
/** Portrait row states the engine leaves a row in; anything else is still in flight. */
const PORTRAIT_SETTLED = Object.freeze(['done', 'failed']);
const PORTRAIT_IN_FLIGHT = Object.freeze(['queued', 'generating']);
const UI_TIMEOUT_MS = 30_000;
const DEFAULT_PHOTO_SIZE = 512;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32 table for PNG chunks. */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/**
 * @description CRC-32 of a buffer (PNG chunk checksum).
 * @param {Buffer} bytes - Chunk type + data.
 * @returns {number} The unsigned checksum.
 */
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @description One PNG chunk: length, type, data, CRC.
 * @param {string} type - Four-letter chunk type.
 * @param {Buffer} data - Chunk payload.
 * @returns {Buffer} The encoded chunk.
 */
function pngChunk(type, data) {
  const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

/**
 * @description Encode 8-bit RGB rows as a valid, non-interlaced PNG (filter 0 on every row).
 * @param {number} width - Pixels per row.
 * @param {number} height - Rows.
 * @param {(y: number) => Buffer} row - The RGB bytes (3 * width) of row y.
 * @returns {Buffer} The PNG file bytes.
 */
function encodePng(width, height, row) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0;
  const rows = [];
  for (let y = 0; y < height; y += 1) rows.push(Buffer.concat([Buffer.from([0]), row(y)]));
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), pngChunk('IEND', Buffer.alloc(0))]);
}

/**
 * @description One synthetic "photo" for the portrait engine: a flat light background, a centred
 * dark oval where a head would be, and a 16 x 16 random patch in the corner so every run's source
 * bytes differ. It is not a face; the case proves the gallery path, and what the engine paints from
 * it is not asserted.
 * @param {number} [size] - Width and height in pixels.
 * @param {(n: number) => Buffer} [bytes] - Random byte source.
 * @returns {Buffer} The PNG file bytes.
 */
function generatePortraitPhoto(size = DEFAULT_PHOTO_SIZE, bytes = crypto.randomBytes) {
  const patch = bytes(16 * 16 * 3);
  const cx = size / 2, cy = size * 0.45, rx = size * 0.22, ry = size * 0.3;
  return encodePng(size, size, (y) => {
    const row = Buffer.alloc(size * 3);
    for (let x = 0; x < size; x += 1) {
      const inHead = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
      const at = (y * 16 + x) * 3;
      const px = x < 16 && y < 16 ? [patch[at], patch[at + 1], patch[at + 2]] : inHead ? [96, 72, 56] : [214, 220, 228];
      row[x * 3] = px[0]; row[x * 3 + 1] = px[1]; row[x * 3 + 2] = px[2];
    }
    return row;
  });
}

/**
 * @description Whether the Portrait Studio package is active and its image engine answers as
 * configured, so a run that cannot generate a portrait writes nothing.
 * @param {(method: string, route: string, body?: object) => Promise<{status: number, json: object}>} api - Bearer JSON port.
 * @returns {Promise<{ok: true, version: string, provider: string|null}|{ok: false, detail: string}>} The preflight.
 */
async function portraitPreflight(api) {
  const apps = await api('GET', '/api/swarm/apps?status=active');
  const app = (Array.isArray(apps.json.apps) ? apps.json.apps : []).find((entry) => entry && entry.name === PORTRAIT_APP);
  if (!app) return { ok: false, detail: `The ${PORTRAIT_APP} package is not installed and active on this box` };
  const provider = await api('GET', `${PORTRAIT_API}/provider`);
  if (provider.status !== 200 || !provider.json.configured) {
    const why = provider.json.unavailable || provider.json.hint || provider.json.detail || `HTTP ${provider.status}`;
    return { ok: false, detail: `Portrait Studio's image provider is not configured (${why})` };
  }
  return { ok: true, version: String(app.version || ''), provider: provider.json.provider ? String(provider.json.provider) : null };
}

/**
 * @description The first professional style the studio's catalog lists.
 * @param {object} catalog - GET /api/portrait-studio/catalog's body.
 * @returns {string|null} The style id, or null when the catalog lists none.
 */
function pickStyle(catalog) {
  const list = catalog && catalog.presets && Array.isArray(catalog.presets.professional) ? catalog.presets.professional : [];
  const first = list.find((preset) => preset && typeof preset.id === 'string' && preset.id);
  return first ? first.id : null;
}

/**
 * @description Queue one synthetic portrait as the caller and title it with the run's fixture tag.
 * @param {object} ports - api, multipart.
 * @param {{subject: string, photo: Buffer}} fixture - The run's fixture (tag + synthetic photo).
 * @returns {Promise<{ok: boolean, id: string|null, style?: string, detail?: string}>} The portrait id (also on a titling failure, so cleanup deletes it).
 */
async function createPortrait(ports, fixture) {
  const catalog = await ports.api('GET', `${PORTRAIT_API}/catalog`);
  const style = pickStyle(catalog.json);
  if (catalog.status !== 200 || !style) return { ok: false, id: null, detail: `GET ${PORTRAIT_API}/catalog answered HTTP ${catalog.status} with no professional style.` };
  const created = await ports.multipart(`${PORTRAIT_API}/portraits`, { mode: 'professional', style, options: '{}' },
    { field: 'photo', name: `${fixture.subject}-photo.png`, type: 'image/png', bytes: fixture.photo });
  const id = typeof created.json.portraitId === 'string' && UUID_RE.test(created.json.portraitId) ? created.json.portraitId : null;
  if (created.status !== 202 || !id) return { ok: false, id, detail: `POST ${PORTRAIT_API}/portraits answered HTTP ${created.status} ${created.json.error || ''}`.trim() };
  const titled = await ports.api('PATCH', `${PORTRAIT_API}/portraits/${id}`, { title: fixture.subject });
  if (titled.status !== 200) return { ok: false, id, detail: `PATCH ${PORTRAIT_API}/portraits/${id} (title) answered HTTP ${titled.status}` };
  return { ok: true, id, style };
}

/**
 * @description Re-read one portrait through the caller's own gallery listing.
 * @param {object} ports - api.
 * @param {string} id - The portrait id.
 * @returns {Promise<{status: number, row: object|null}>} The listing status and the row, if listed.
 */
async function readPortrait(ports, id) {
  const listed = await ports.api('GET', `${PORTRAIT_API}/portraits`);
  const rows = listed.status === 200 && Array.isArray(listed.json.portraits) ? listed.json.portraits : [];
  return { status: listed.status, row: rows.find((row) => row && String(row.portrait_id) === id) || null };
}

/**
 * @description Wait (bounded) for the engine to settle the portrait: done, failed, or out of budget.
 * @param {object} io - api, sleep, now.
 * @param {string} id - The portrait id.
 * @param {{portraitBudgetMs: number, pollMs: number}} budgets - Bounds.
 * @returns {Promise<{status: string, error: string|null, model: string|null, costUsd: number|null, elapsedMs: number}>} The last row read.
 */
async function awaitPortraitDone(io, id, budgets) {
  const started = io.now();
  let last = { status: 'missing', error: null, model: null, costUsd: null };
  for (;;) {
    const read = await readPortrait(io, id);
    if (read.row) {
      last = { status: String(read.row.status), error: read.row.error ? String(read.row.error).slice(0, 300) : null,
        model: read.row.model ? String(read.row.model) : null, costUsd: read.row.cost_usd == null ? null : Number(read.row.cost_usd) };
    } else if (read.status !== 200) last = { ...last, status: `HTTP ${read.status}` };
    if (PORTRAIT_SETTLED.includes(last.status) || io.now() - started >= budgets.portraitBudgetMs) break;
    await io.sleep(budgets.pollMs);
  }
  return { ...last, elapsedMs: io.now() - started };
}

/**
 * @description The mint body the gallery's Send to… posts for a done portrait (portrait-studio.html
 * builds it; send-to.js mintHandle sends it to POST /api/artifacts/handles as a locator handle).
 * @param {string} id - The portrait id.
 * @returns {{source: string, type: string, name: string}} The body.
 */
function galleryHandleBody(id) {
  return { source: `${PORTRAIT_API}/portraits/${id}/image`, type: 'image/png', name: `portrait-${id.slice(0, 8)}.png` };
}

/**
 * @description Mint the Send-to handle over the portrait's own image route, as the gallery does.
 * @param {object} ports - api.
 * @param {string} id - The portrait id.
 * @returns {Promise<{ok: boolean, ref: string|null, expiresAt: string|null, detail?: string}>} The handle.
 */
async function mintGalleryHandle(ports, id) {
  const minted = await ports.api('POST', '/api/artifacts/handles', galleryHandleBody(id));
  const ref = typeof minted.json.ref === 'string' && HANDLE_REF_RE.test(minted.json.ref) ? minted.json.ref : null;
  if (minted.status !== 201 || !ref) return { ok: false, ref: null, expiresAt: null, detail: `POST /api/artifacts/handles answered HTTP ${minted.status} ${minted.json.error || ''}`.trim() };
  return { ok: true, ref, expiresAt: typeof minted.json.expiresAt === 'string' ? minted.json.expiresAt : null };
}

/**
 * @description Delete this run's portrait after it revalidates by its title tag, once the engine has
 * settled it, and require it gone from the caller's listing.
 * @param {object} io - api, sleep, now.
 * @param {string|null} id - The portrait id (null when none was created).
 * @param {string} tag - The run's fixture tag the title must equal.
 * @param {{portraitBudgetMs: number, pollMs: number}} budgets - Bounds for the settle wait.
 * @returns {Promise<string[]>} Errors; empty when the portrait is gone.
 */
async function removePortrait(io, id, tag, budgets) {
  if (!id) return [];
  const started = io.now();
  let read = await readPortrait(io, id);
  while (read.row && PORTRAIT_IN_FLIGHT.includes(String(read.row.status)) && io.now() - started < budgets.portraitBudgetMs) {
    await io.sleep(budgets.pollMs);
    read = await readPortrait(io, id);
  }
  if (!read.row) return read.status === 200 ? [] : [`portrait ${id} could not be re-read (HTTP ${read.status}); not deleted`];
  if (String(read.row.title) !== tag) return [`portrait ${id} did not revalidate as this run's fixture (title mismatch); not deleted`];
  const busy = PORTRAIT_IN_FLIGHT.includes(String(read.row.status));
  const deleted = await io.api('DELETE', `${PORTRAIT_API}/portraits/${id}`);
  if (deleted.status !== 200) return [`DELETE ${PORTRAIT_API}/portraits/${id} answered HTTP ${deleted.status}`];
  const errors = (await readPortrait(io, id)).row ? [`portrait ${id} still listed after deletion`] : [];
  if (busy) errors.push(`portrait ${id} was still ${read.row.status} when deleted; its engine output may be orphaned on the box`);
  return errors;
}

/**
 * @description Launch the default headless Chromium.
 * @returns {Promise<object>} The Playwright browser.
 */
function defaultLaunch() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('playwright').chromium.launch({ headless: true });
}

/**
 * @description A desktop headless Chromium session as the caller: same-origin requests carry the
 * token (added at the network layer, so no page script can read it); every other request is
 * aborted in the browser.
 * @param {string} origin - The box origin.
 * @param {string} token - The operator PAT.
 * @param {() => Promise<object>} [launch] - Browser launcher (a seam for tests).
 * @returns {(fn: (page: object) => Promise<unknown>) => Promise<unknown>} Runs fn with one page and closes the browser.
 */
function browserSession(origin, token, launch = defaultLaunch) {
  return async (fn) => {
    const browser = await launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.route('**/*', (route) => {
        if (new URL(route.request().url()).origin !== origin) return route.abort();
        return route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${token}` } });
      });
      return await fn(await context.newPage());
    } finally {
      await browser.close();
    }
  };
}

/**
 * @description Open the studio with the handle in its URL and choose the fixture character.
 * @param {object} page - The Playwright page.
 * @param {string} origin - The box origin.
 * @param {string} ref - The artifact handle.
 * @param {string} displayName - The fixture character's display name (its card text).
 * @returns {Promise<void>} Resolves once the import button is enabled for that character.
 */
async function openStudio(page, origin, ref, displayName) {
  const loaded = await page.goto(`${origin}${LORA_UI_PATH}?artifact=${encodeURIComponent(ref)}`, { waitUntil: 'domcontentloaded' });
  const status = loaded ? loaded.status() : 0;
  if (status !== 200) throw new Error(`${LORA_UI_PATH} answered HTTP ${status}`);
  await page.locator('#chars .card').filter({ hasText: displayName }).first().click({ timeout: UI_TIMEOUT_MS });
  await page.waitForFunction(() => { const button = document.getElementById('importArtifactBtn'); return Boolean(button) && !button.disabled; },
    null, { timeout: UI_TIMEOUT_MS });
}

/**
 * @description Caption the pair and click "Import selected image"; return the page's own import response.
 * @param {object} page - The Playwright page.
 * @param {string} caption - The training caption.
 * @returns {Promise<{status: number, json: object}>} The POST /api/lora/dataset/import response the page received.
 */
async function submitImport(page, caption) {
  await page.locator('#datasetCaption').fill(caption);
  const posted = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === LORA_IMPORT_PATH, { timeout: UI_TIMEOUT_MS });
  await page.getByRole('button', { name: 'Import selected image' }).click();
  const response = await posted;
  const json = await response.json().catch(() => ({}));
  return { status: response.status(), json: json && typeof json === 'object' ? json : {} };
}

/**
 * @description The receipt status a card's text shows, by the studio's own labels.
 * @param {string} text - The card text.
 * @returns {'ready'|'failed'|'queued'|'missing'} The status.
 */
function surfaceStatusOf(text) {
  for (const [status, label] of Object.entries(SURFACE_STATUS_TEXT)) if (text.includes(label)) return status;
  return 'missing';
}

/**
 * @description Read what #datasetRows shows for one filename right now.
 * @param {object} page - The Playwright page.
 * @param {string} filename - The dataset filename the import chose.
 * @returns {Promise<{status: string, text: string}>} The card's status and its collapsed text.
 */
async function readSurfaceReceipt(page, filename) {
  const card = page.locator('#datasetRows .card').filter({ hasText: filename });
  const text = (await card.count()) ? String(await card.first().innerText()) : '';
  const collapsed = text.replace(/\s+/g, ' ').trim().slice(0, 200);
  return { status: collapsed ? surfaceStatusOf(collapsed) : 'missing', text: collapsed };
}

/**
 * @description Poll the studio's receipt list (through its own Refresh button) until the file
 * leaves "queued for worker", or the budget runs out.
 * @param {object} page - The Playwright page.
 * @param {{sleep: Function, now: Function}} io - Clock.
 * @param {string} filename - The dataset filename.
 * @param {{readyBudgetMs: number, pollMs: number}} budgets - Bounds.
 * @returns {Promise<{status: string, text: string, elapsedMs: number}>} What the surface showed last.
 */
async function awaitSurfaceReceipt(page, io, filename, budgets) {
  const started = io.now();
  let shown = { status: 'missing', text: '' };
  for (;;) {
    shown = await readSurfaceReceipt(page, filename);
    if (!['missing', 'queued'].includes(shown.status) || io.now() - started >= budgets.readyBudgetMs) break;
    await io.sleep(budgets.pollMs);
    await page.locator('#refreshDatasetBtn').click({ timeout: UI_TIMEOUT_MS }).catch(() => undefined);
  }
  return { ...shown, elapsedMs: io.now() - started };
}

/**
 * @description The surface port: the import done in the LoRA studio page itself, as the caller.
 * @param {{origin: string, token: string, launch?: () => Promise<object>}} spec - Where and as whom.
 * @returns {{importImage: (input: {ref: string, displayName: string, caption: string}, budgets: object, io: object) => Promise<{response: {status: number, json: object}, shown: object|null, pageErrors: string[]}>}} The port.
 */
function createSurfacePort(spec) {
  const session = browserSession(spec.origin, spec.token, spec.launch);
  return {
    importImage: (input, budgets, io) => session(async (page) => {
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(String(error && error.message ? error.message : error).slice(0, 200)));
      await openStudio(page, spec.origin, input.ref, input.displayName);
      const response = await submitImport(page, input.caption);
      const filename = typeof response.json.filename === 'string' ? response.json.filename : null;
      const shown = response.status === 202 && filename ? await awaitSurfaceReceipt(page, io, filename, budgets) : null;
      return { response, shown, pageErrors };
    }),
  };
}

/**
 * @description One docker CLI call without a shell.
 * @param {string[]} args - docker arguments.
 * @returns {{status: number|null, stdout: string}} The outcome.
 */
function dockerExec(args) {
  const run = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000 });
  return { status: run.status, stdout: run.stdout || '' };
}

/**
 * @description Read one environment variable of the running api container (the package reads the
 * box root from the api process, so the host half asks that process's environment).
 * @param {string} container - The api container.
 * @param {string} name - The variable name.
 * @param {typeof dockerExec} [exec] - docker runner (a seam for tests).
 * @returns {string} The value, or '' when unset.
 */
function readContainerEnv(container, name, exec = dockerExec) {
  const run = exec(['exec', container, 'printenv', name]);
  return run.status === 0 ? String(run.stdout).trim() : '';
}

module.exports = {
  PORTRAIT_APP, PORTRAIT_API, LORA_UI_PATH, LORA_IMPORT_PATH, SURFACE_STATUS_TEXT, DEFAULT_PHOTO_SIZE,
  encodePng, generatePortraitPhoto, portraitPreflight, pickStyle, createPortrait, readPortrait, awaitPortraitDone,
  galleryHandleBody, mintGalleryHandle, removePortrait, browserSession, surfaceStatusOf, createSurfacePort, readContainerEnv,
};
