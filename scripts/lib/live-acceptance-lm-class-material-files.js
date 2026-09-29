/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the files-browser leg of the Little Monsters class-material live-acceptance case (entry #19's Done-when: "a document sent from the files browser lands as a material in a class the caller may write to, chosen in the dispatch"). The tagged PDF goes into the caller's own oshal storage through the route the files browser uploads with; headless Chromium (desktop width, the cockpit shell) opens the files browser, presses the file's Send to... chip, picks "File into a class", and the case requires the mint to be the browser's own locator over the files download route (never a carried-bytes handle), the shell to land on /cockpit/?app=little-monsters&artifact=<that ref>&artifactAction=class-material, the destination page to offer the tagged class in its picker, and the import the DESTINATION posts to carry exactly the class chosen in that picker. Every request the browser sends carries the token on the same origin only (the runner's browser port). Cleanup removes the storage file through the files DELETE route and reads the folder back.
 */

'use strict';

const common = require('./live-acceptance-common.js');

const EDU = '/api/education';
const FILES = '/api/files';
const APP = 'little-monsters';
const ACTION = 'class-material';
const NEEDS = Object.freeze(['api', 'raw', 'browser']);
const UI_TIMEOUT_MS = 45_000;
/** The cockpit shell is a desktop layout; the runner's default phone viewport is for the surfaces. */
const SHELL_VIEWPORT = Object.freeze({ width: 1280, height: 900 });
const REF_RE = /^art_[A-Za-z0-9_-]{8,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST_COMMAND = 'node scripts/operations/live-acceptance.js lm-class-material';

/**
 * @description Whether a recorded mint is the files browser's own: a locator over its download route
 * for exactly this file. A carried-bytes handle (POST /handles/upload) is what a source with no serve
 * URL mints, so accepting one would not prove the files-browser source.
 * @param {{path: string, body: object|null}|null} mint - The mint request the browser sent.
 * @param {string} fileName - The uploaded file's name.
 * @returns {boolean} True for the files browser's locator mint.
 */
function mintedFromFilesBrowser(mint, fileName) {
  if (!mint || mint.path !== '/api/artifacts/handles' || !mint.body) return false;
  const source = String(mint.body.source || '');
  const prefix = `${FILES}/download?provider=oshal-local&path=`;
  if (!source.startsWith(prefix)) return false;
  try { return decodeURIComponent(source.slice(prefix.length)) === fileName; } catch { return false; }
}

/**
 * @description Whether the import was posted by the destination page with the class it had picked:
 * the request came from the destination frame (not from this case), carried the minted ref, and named
 * the class the picker's select held when the button was pressed.
 * @param {{fromDestination: boolean, body: object|null}|null} post - The import request the browser sent.
 * @param {string} ref - The minted ref.
 * @param {string} chosenClassId - The select's value at click time.
 * @returns {boolean} True when the class was chosen in the dispatch.
 */
function importedFromDispatch(post, ref, chosenClassId) {
  return Boolean(post && post.fromDestination && post.body && post.body.ref === ref && post.body.classId === chosenClassId
    && UUID_RE.test(String(chosenClassId)));
}

/**
 * @description Put the PDF into the caller's own oshal storage through the files browser's upload route,
 * and read the folder back so the residue read after cleanup has seen the file present.
 * @param {object} ports - raw, api.
 * @param {{browserFileName: string, browserPdf: Buffer}} fixture - The run's fixture.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<{ok: boolean, detail: string}>} Whether the file is in the store and listed.
 */
async function uploadToStorage(ports, fixture, ledger) {
  const route = `${FILES}/upload?provider=oshal-local&name=${encodeURIComponent(fixture.browserFileName)}`;
  const up = await ports.raw('POST', route, fixture.browserPdf, 'application/pdf');
  const stored = up.json && up.json.path;
  if (stored) ledger.created('oshal-local-file', stored);
  if (up.status !== 200 || stored !== fixture.browserFileName) return { ok: false, detail: `POST ${FILES}/upload answered HTTP ${up.status}${stored ? ` (path ${stored})` : ''}` };
  const listed = (await listStorage(ports)).includes(fixture.browserFileName);
  return listed ? { ok: true, detail: `uploaded ${fixture.browserFileName} into oshal storage and it is listed` }
    : { ok: false, detail: `${fixture.browserFileName} is not listed by ${FILES}/browse after the upload` };
}

/**
 * @description The names at the root of the caller's oshal storage.
 * @param {object} ports - api.
 * @returns {Promise<string[]>} The entry names.
 */
async function listStorage(ports) {
  const res = await ports.api('GET', `${FILES}/browse?provider=oshal-local&path=`);
  return (Array.isArray(res.json && res.json.entries) ? res.json.entries : []).map((e) => String(e && e.name));
}

/**
 * @description The Send to... entry Little Monsters offers a PDF, as the menu route answers it.
 * @param {object} ports - api.
 * @returns {Promise<object|null>} The action, or null when the destination is not offered.
 */
async function classMaterialAction(ports) {
  const res = await ports.api('GET', '/api/artifacts/actions?type=application/pdf');
  const actions = Array.isArray(res.json && res.json.actions) ? res.json.actions : [];
  return actions.find((a) => a && a.app === APP && a.id === ACTION && a.mode === 'open') || null;
}

/**
 * @description Record the two browser requests the leg judges: the mint and the import.
 * @param {object} page - The Playwright page.
 * @returns {{mint: object|null, post: object|null}} Filled as the requests happen.
 */
function recordDispatch(page) {
  const seen = { mint: null, post: null };
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    const pathname = new URL(request.url()).pathname;
    let body = null;
    try { body = request.postDataJSON(); } catch { body = null; }
    if (pathname === '/api/artifacts/handles' || pathname === '/api/artifacts/handles/upload') seen.mint = { path: pathname, body };
    if (pathname === `${EDU}/import-artifact`) {
      const frame = request.frame();
      seen.post = { body, fromDestination: frame !== page.mainFrame() && frame.url().includes(`${EDU}/`) };
    }
  });
  return seen;
}

/**
 * @description Open the files browser and send the file through its Send to... menu; the shell must land
 * on the cockpit with the minted ref and the class-material action.
 * @param {object} page - The Playwright page.
 * @param {string} origin - The box origin.
 * @param {string} fileName - The uploaded file.
 * @param {string} label - The menu label of the class-material action.
 * @returns {Promise<string>} The minted ref the shell carries.
 */
async function sendFromFilesBrowser(page, origin, fileName, label) {
  const opened = await page.goto(`${origin}${FILES}/`, { waitUntil: 'domcontentloaded' });
  if (!opened || opened.status() !== 200) throw new Error(`${FILES}/ answered HTTP ${opened ? opened.status() : 'none'}`);
  const chip = page.locator(`[data-artifact-name="${fileName}"] [data-artifact-chip]`);
  await chip.first().waitFor({ timeout: UI_TIMEOUT_MS });
  await chip.first().click();
  const minted = page.waitForResponse((r) => r.request().method() === 'POST' && /^\/api\/artifacts\/handles(\/upload)?$/.test(new URL(r.url()).pathname), { timeout: UI_TIMEOUT_MS });
  await page.getByRole('button', { name: label, exact: false }).first().click();
  const mintResponse = await minted;
  if (mintResponse.status() !== 201) throw new Error(`the Send to... mint answered HTTP ${mintResponse.status()}`);
  await page.waitForURL((url) => url.pathname === '/cockpit/' && url.searchParams.has('artifact'), { timeout: UI_TIMEOUT_MS });
  const landed = new URL(page.url());
  const ref = String(landed.searchParams.get('artifact') || '');
  if (landed.searchParams.get('app') !== APP || landed.searchParams.get('artifactAction') !== ACTION || !REF_RE.test(ref)) {
    throw new Error(`the shell landed on ${landed.pathname}${landed.search} rather than ?app=${APP}&artifact=<ref>&artifactAction=${ACTION}`);
  }
  return ref;
}

/**
 * @description The destination frame the shell forwarded the handle into.
 * @param {object} page - The Playwright page.
 * @param {string} ref - The minted ref.
 * @returns {Promise<object>} The frame.
 */
async function destinationFrame(page, ref) {
  const started = Date.now();
  for (;;) {
    const frame = page.frames().find((f) => f.url().includes(`${EDU}/`) && f.url().includes(`artifact=${encodeURIComponent(ref)}`) && f.url().includes(`artifactAction=${ACTION}`));
    if (frame) return frame;
    if (Date.now() - started > UI_TIMEOUT_MS) throw new Error(`the shell never forwarded artifact=${ref}&artifactAction=${ACTION} into a Little Monsters surface frame`);
    await page.waitForTimeout(250);
  }
}

/**
 * @description Choose the tagged class in the destination's picker and press Import; the destination
 * page posts the import itself.
 * @param {object} page - The Playwright page.
 * @param {object} frame - The destination frame.
 * @param {string} classId - The tagged class.
 * @returns {Promise<{chosen: string, status: number, json: object, statusText: string}>} What the picker held and what the import answered.
 */
async function importThroughPicker(page, frame, classId) {
  const select = frame.locator('#classMaterialImport select');
  await select.waitFor({ timeout: UI_TIMEOUT_MS });
  await frame.waitForFunction(() => { const s = document.querySelector('#classMaterialImport select'); return Boolean(s && !s.disabled && s.options.length > 0); }, null, { timeout: UI_TIMEOUT_MS });
  const offered = await select.evaluate((s) => Array.from(s.options).map((o) => o.value));
  if (!offered.includes(classId)) throw new Error(`the picker offered ${offered.length} class(es) and not the tagged class ${classId}`);
  await select.selectOption(classId);
  const chosen = await select.evaluate((s) => s.value);
  const imported = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `${EDU}/import-artifact`, { timeout: UI_TIMEOUT_MS });
  await frame.locator('#classMaterialImport button').first().click();
  const response = await imported;
  let json = {};
  try { json = await response.json(); } catch { json = {}; }
  const statusText = await frame.locator('[data-class-material-status]').first().innerText().catch(() => '');
  return { chosen, status: response.status(), json: json && typeof json === 'object' ? json : {}, statusText: statusText.replace(/\s+/g, ' ').trim().slice(0, 160) };
}

/**
 * @description Judge one dispatch: the mint, the landing, the picker, the import and its listing.
 * @param {object} ports - api.
 * @param {{mint: object|null, post: object|null}} seen - The recorded browser requests.
 * @param {string} ref - The minted ref.
 * @param {ReturnType<typeof importThroughPicker>} outcome - The picker's outcome.
 * @param {string} fileName - The uploaded file.
 * @param {string} classId - The tagged class.
 * @returns {Promise<{ok: boolean, detail: string, materialId: string|null}>} The judgement.
 */
async function judge(ports, seen, ref, outcome, fileName, classId) {
  const material = outcome.json.material;
  const materialId = material && UUID_RE.test(String(material.material_id)) ? String(material.material_id) : null;
  if (!mintedFromFilesBrowser(seen.mint, fileName)) return { ok: false, detail: `the dispatch did not mint over the files browser download route (${seen.mint ? `${seen.mint.path}` : 'no mint seen'})`, materialId };
  if (!importedFromDispatch(seen.post, ref, outcome.chosen) || outcome.chosen !== classId) return { ok: false, detail: `the import did not carry the class chosen in the dispatch (picker held ${outcome.chosen}; posted ${seen.post && seen.post.body ? seen.post.body.classId : 'nothing'}${seen.post && !seen.post.fromDestination ? ', not from the destination frame' : ''})`, materialId };
  if (outcome.status !== 201 || !materialId) return { ok: false, detail: `import-artifact answered HTTP ${outcome.status}: ${outcome.json.error || 'no material'} (page said "${outcome.statusText}")`, materialId };
  if (outcome.json.shareStatus !== 'approved') return { ok: false, detail: `the import came back ${outcome.json.shareStatus}, not approved (is the caller a teacher of the class?)`, materialId };
  const shared = await ports.api('GET', `${EDU}/classes/${classId}/shared-materials`);
  const listed = (Array.isArray(shared.json && shared.json.materials) ? shared.json.materials : []).some((m) => m && m.material_id === materialId);
  if (!listed) return { ok: false, detail: `material ${materialId} is not in the class's shared materials (HTTP ${shared.status})`, materialId };
  return { ok: true, detail: `files browser -> Send to... "${ACTION}" minted ${ref} over ${FILES}/download, the shell forwarded it to the Little Monsters picker, the class chosen there was imported (201 approved, grounded ${Boolean(outcome.json.grounded)}, page said "${outcome.statusText}") and material ${materialId} is in the class's shared materials`, materialId };
}

/**
 * @description The files-browser leg: upload, dispatch in the browser, judge.
 * @param {object} ports - api, raw, browser.
 * @param {object} fixture - The run's fixture.
 * @param {string} classId - The tagged class.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<{state: 'pass'|'fail'|'unavailable', detail: string, materialId: string|null, evidence: object}>} The leg's outcome.
 */
async function dispatchThroughFilesBrowser(ports, fixture, classId, ledger) {
  const missing = common.missingPorts(ports, NEEDS);
  if (missing.length) return { state: 'unavailable', detail: `the files-browser dispatch needs the host runner's ${missing.join('/')} port (a headless Chromium); run ${HOST_COMMAND}`, materialId: null, evidence: {} };
  const action = await classMaterialAction(ports);
  if (!action) return { state: 'unavailable', detail: `Little Monsters offers no "${ACTION}" Send to... destination for application/pdf (the installed package predates the class-material receiver)`, materialId: null, evidence: {} };
  const uploaded = await uploadToStorage(ports, fixture, ledger);
  if (!uploaded.ok) return { state: 'fail', detail: uploaded.detail, materialId: null, evidence: {} };
  let verdict = { state: 'fail', detail: 'the browser session never reported', materialId: null, evidence: {} };
  await ports.browser.session(async (session) => {
    const page = await session.newPage();
    const timingsMs = {};
    const lap = (name, since) => { timingsMs[name] = Date.now() - since; return Date.now(); };
    try {
      const seen = recordDispatch(page);
      let at = Date.now();
      const ref = await sendFromFilesBrowser(page, session.origin, fixture.browserFileName, action.label);
      at = lap('send', at);
      ledger.kept('send-to-handle', ref, 'memory-only; expires on its TTL');
      const frame = await destinationFrame(page, ref);
      at = lap('shell', at);
      const outcome = await importThroughPicker(page, frame, classId);
      at = lap('picker', at);
      const judged = await judge(ports, seen, ref, outcome, fixture.browserFileName, classId);
      lap('judge', at);
      if (judged.materialId) ledger.created('lm-material', judged.materialId);
      verdict = { state: judged.ok ? 'pass' : 'fail', detail: judged.detail, materialId: judged.materialId,
        evidence: { ref, shell: new URL(page.url()).search, viewport: await page.evaluate(() => window.innerWidth).catch(() => null), mint: seen.mint && seen.mint.path, chosen: outcome.chosen, timingsMs } };
    } catch (error) {
      verdict = { state: 'fail', detail: common.errorText(error).split(/\r?\n/)[0], materialId: null, evidence: { url: page.url(), timingsMs } };
    } finally {
      await page.close().catch(() => undefined);
    }
  }, { viewport: SHELL_VIEWPORT });
  return verdict;
}

/**
 * @description Remove the storage file through the files DELETE route and read the folder back.
 * @param {object} ports - api.
 * @param {string} fileName - The uploaded file.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<void>} Resolves when recorded.
 */
async function removeFromStorage(ports, fileName, ledger) {
  await ledger.attempt(`oshal-local file ${fileName} delete`, async () => {
    const res = await ports.api('DELETE', `${FILES}?provider=oshal-local&path=${encodeURIComponent(fileName)}`);
    if (res.status !== 200) return `DELETE ${FILES}?provider=oshal-local answered HTTP ${res.status} for ${fileName}`;
    if ((await listStorage(ports)).includes(fileName)) return `${fileName} is still listed by ${FILES}/browse after the delete`;
    ledger.removed('oshal-local-file', fileName);
    return null;
  });
}

module.exports = { NEEDS, SHELL_VIEWPORT, HOST_COMMAND, mintedFromFilesBrowser, importedFromDispatch, classMaterialAction, uploadToStorage, dispatchThroughFilesBrowser, removeFromStorage };
