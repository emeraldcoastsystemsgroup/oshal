/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - live acceptance for "Create visual workspace and integrated editing": one selected-region edit of the installed Create package (1.9.0 or later) through its own routes, as the caller. Before any write it reads GET /api/create/permissions and GET /api/create/region-edit-provider. Each of these is a named gap, never a pass, and nothing is written: a package that is absent or older than 1.9.0, a caller without one of the six project actions the case performs, a provider that did not resolve or is not available, and a PAID provider without the host runner's --allow-paid (a paid edit is a real charge, so it needs the operator's consent). Then it uploads one generated 512 x 384 image, reads it back and requires the stored pixels to be the generated ones, saves a project titled with the run's tag holding that image layer and one text layer, asks for one box region to be regenerated, waits for the candidate, decodes it and requires EVERY pixel outside the box to equal the source byte for byte and at least one inside it to differ, accepts it on revision 1 and requires revision 2 to show the candidate on the image layer with the text layer and revision 1 unchanged. Cleanup cancels an edit still generating, deletes exactly the tagged project and reads the project and the edit back as gone. The two images stay: Create removes an upload only through its owner-wide cleanup route once it is 24 hours old, and that route would also remove uploads the case did not make, so the receipt lists them as kept with that reason, as it lists the cost rows of a paid edit.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Compare the independently read revision-2 document with the accepted response, and treat every admitted edit ID as possibly in flight before validating its metadata so cleanup cancels malformed admissions too. Label reported spend as unverified accounting evidence.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Preserve layer order and every original document property outside images/layers at acceptance. If cancellation loses to completion, read and account for the candidate and reported spend before deletion; retain the project and a red cleanup receipt when that read cannot establish the outcome.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Require costConsentVersion 1 before any fixture write and always send maxCostClass. Only explicit paid opt-in plus a paid preflight permits a paid cap; the server enforces the captured cap against the provider resolved after queueing. This caps a cost class, not a dollar amount.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Mark possible admission before sending, and retain the project when the reply loses its ID or outcome. Require matching terminal status, candidate provenance and well-shaped reported spend before clearing the deletion guard, on ordinary polls as well as cancellation. Unknown or malformed outcomes stay red and recoverable.
 */

'use strict';

const common = require('./live-acceptance-common.js');
const png = require('./live-acceptance-png.js');

const CASE_ID = 'create-region-edit-live';
const KEY = 'create-region-edit';
const TITLE = 'Create region edit: one region regenerated, every pixel outside it unchanged, accepted as the next revision';
const NEEDS = Object.freeze(['api', 'upload']);
const BASE = '/api/create';
/** The host command that carries the operator's consent to one paid edit. */
const ALLOW_PAID_COMMAND = `node scripts/operations/live-acceptance.js ${KEY} --allow-paid`;
/** Every project action the case performs; Create reports each as true or false (the upload needs create or change). */
const PERMISSIONS = Object.freeze(['view', 'read', 'create', 'change', 'delete', 'generate']);
const COST_CLASSES = Object.freeze(['free', 'paid']);
/** The generated source image, and the box of it the case asks to have regenerated (source pixels, right and bottom exclusive). */
const IMAGE = Object.freeze({ width: 512, height: 384 });
const REGION = Object.freeze({ left: 160, top: 96, right: 352, bottom: 288 });
const INSTRUCTION = 'Replace this area with a plain bright red square.';
/** Create's provider deadline defaults to 120 s (CREATE_REGION_EDIT_TIMEOUT_MS); the wait covers it. */
const DEFAULT_BUDGETS = Object.freeze({ editBudgetMs: 200_000, pollMs: 2_000 });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Why an uploaded image stays after the run (create-project-store.ts cleanupAssets: unreferenced and older than 24 hours, for the whole account). */
const ASSET_KEPT = 'an unattached upload; Create removes one only through its owner-wide POST /api/create/project-assets/cleanup, once it is 24 hours old';
const LATE_KEPT = 'cancelled while the provider was working; Create stores an answer that arrives after a cancel as an unattached upload';
const COST_KEPT = 'reported spend; accounting records are not removed or independently verified';

/** @param {string} id - A project. @returns {string} Its route. */
const projectPath = (id) => `${BASE}/projects/${id}`;
/** @param {object} fixture - projectId, editId. @returns {string} The edit's route. */
const editPath = (fixture) => `${projectPath(fixture.projectId)}/region-edits/${fixture.editId}`;
/** @param {{status: number, json: object}} res - A reply. @returns {string} `HTTP 403 project_permission_denied`. */
const answered = (res) => `HTTP ${res.status}${typeof res.json.error === 'string' ? ` ${res.json.error}` : ''}`;
/** @param {string[]} problems - What went wrong. @returns {{state: string, detail?: string}} ok, or fail naming them. */
const outcomeOf = (problems) => (problems.length ? { state: 'fail', detail: `${problems.join('; ')}.` } : { state: 'ok' });

/**
 * @description The generated source image: two gradients and a diagonal, opaque, so no two
 * neighbouring pixels are equal and a moved or mirrored picture cannot compare as unchanged.
 * @returns {Buffer} IMAGE.width x IMAGE.height x 4 bytes of RGBA.
 */
function sourcePixels() {
  const { width, height } = IMAGE;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels.set([Math.floor(255 * x / (width - 1)), Math.floor(255 * y / (height - 1)), (x * 3 + y * 5) % 256, 255], (y * width + x) * 4);
    }
  }
  return pixels;
}

/**
 * @description The project the case saves: the uploaded image as one layer, and one text layer
 * holding the run's tag, which stands for a person's manual edit and must survive the accept.
 * @param {string} tag - The run's fixture tag (also the project title and document name).
 * @param {{src: string}} asset - The uploaded image.
 * @returns {object} A Create v1 document in reference mode.
 */
function seedDocument(tag, asset) {
  const { width, height } = IMAGE;
  return { version: 1, name: tag, width, height, background: '#ffffff',
    images: { photo: { src: asset.src, width, height } },
    layers: [{ id: 'photo', type: 'image', name: 'photo', x: 0, y: 0, w: width, h: height, assetId: 'photo' },
      { id: 'title', type: 'text', name: 'title', x: 16, y: 16, w: 480, h: 48, text: tag }] };
}

/**
 * @description The box selection in source pixels, as the editor's region module produces one.
 * @returns {object} A version 1 selection with no feather, so coverage is all or nothing.
 */
function selection() {
  const { left, top, right, bottom } = REGION;
  return { version: 1, kind: 'box', layerId: 'photo', assetId: 'photo', sourceWidth: IMAGE.width, sourceHeight: IMAGE.height, feather: 0,
    points: [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }] };
}

/**
 * @description Whether two JSON values are equal whatever order their keys arrive in (a stored
 * document comes back from jsonb with its keys reordered).
 * @param {unknown} a - One value.
 * @param {unknown} b - The other.
 * @returns {boolean} True when they hold the same data.
 */
function sameJson(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && sameJson(a[key], b[key]));
}

/**
 * @description Whether the installed Create serves this caller every action the case performs.
 * @param {object} ports - api.
 * @returns {Promise<{state: 'ok'|'unavailable'|'fail', detail?: string}>} The precondition.
 */
async function probePermissions(ports) {
  const res = await ports.api('GET', `${BASE}/permissions`);
  const route = `GET ${BASE}/permissions`;
  if (res.status === 404) return { state: 'unavailable', detail: `Create is not installed (${route} answered 404).` };
  if (res.status === 401 || res.status === 403) return { state: 'unavailable', detail: `Create does not serve this caller (${route} answered ${answered(res)}).` };
  if (res.status === 503) return { state: 'unavailable', detail: `Create is installed and not serving (${route} answered ${answered(res)}).` };
  if (res.status !== 200) return { state: 'fail', detail: `${route} answered ${answered(res)}, not 200.` };
  const held = res.json.permissions && typeof res.json.permissions === 'object' ? res.json.permissions : {};
  if (typeof held.generate !== 'boolean') {
    return { state: 'unavailable', detail: `Create 1.9.0 or later (region editing) is not installed: ${route} reports no generate action.` };
  }
  const missing = PERMISSIONS.filter((action) => held[action] !== true);
  if (!missing.length) return { state: 'ok' };
  return { state: 'unavailable', detail: `The caller lacks ${missing.map((action) => `project.${action}`).join(', ')} in Create; `
    + `the case needs ${PERMISSIONS.map((action) => `project.${action}`).join(', ')} (Create's generator role carries project.generate).` };
}

/**
 * @description The gap a provider report names, or null when the case may generate.
 * @param {{provider: string, costClass: string, configured: boolean, costConsentVersion?: number, reason?: string}} report - The 200 body.
 * @param {boolean} allowPaid - Whether the runner carried the operator's consent to a paid edit.
 * @returns {string|null} The gap.
 */
function providerGap(report, allowPaid) {
  if (report.costConsentVersion !== 1) {
    return 'Create does not advertise costConsentVersion 1; server-enforced region-edit cost consent is required before this case writes fixtures.';
  }
  if (report.configured !== true) {
    return `The image provider ${report.provider} is not available for region editing (${report.reason || 'configured false'}).`;
  }
  if (report.costClass === 'paid' && !allowPaid) {
    return `The image provider ${report.provider} is paid: one region edit is a real charge, so the case does not run it without the operator's consent. `
      + `The operator consents by running ${ALLOW_PAID_COMMAND} on the host.`;
  }
  return null;
}

/**
 * @description Read which image provider would answer and what it costs. Never generates.
 * @param {object} ports - api.
 * @param {boolean} allowPaid - Whether the runner carried the operator's consent to a paid edit.
 * @returns {Promise<{state: 'ok'|'unavailable'|'fail', detail?: string, provider?: object}>} The precondition and the report.
 */
async function probeProvider(ports, allowPaid) {
  const res = await ports.api('GET', `${BASE}/region-edit-provider`);
  const route = `GET ${BASE}/region-edit-provider`;
  if (res.status === 404) return { state: 'unavailable', detail: `Create 1.9.0 or later (region editing) is not installed (${route} answered 404).` };
  if (res.status === 403) return { state: 'unavailable', detail: `The caller may not generate in Create (${route} answered ${answered(res)}).` };
  if (res.status === 503) return { state: 'unavailable', detail: `Create could not name an image provider for region editing (${route} answered ${answered(res)}).` };
  if (res.status !== 200) return { state: 'fail', detail: `${route} answered ${answered(res)}, not 200.` };
  const report = res.json;
  const provider = { id: report.provider, costClass: report.costClass, configured: report.configured, dailyCap: report.dailyCap, costConsentVersion: report.costConsentVersion };
  if (typeof report.provider !== 'string' || !report.provider || typeof report.configured !== 'boolean' || !COST_CLASSES.includes(report.costClass)) {
    return { state: 'fail', detail: `${route} answered 200 without a provider, a configured flag and a cost class of free or paid.`, provider };
  }
  const gap = providerGap(report, allowPaid);
  return gap ? { state: 'unavailable', detail: gap, provider } : { state: 'ok', provider };
}

/**
 * @description Read one stored image through Create's own route and decode it.
 * @param {object} ports - api.
 * @param {string} assetId - The image.
 * @param {string} what - The image, in words, for a problem sentence.
 * @returns {Promise<{pixels?: object, reply?: object, problem?: string}>} The decoded pixels, or why not.
 */
async function readImage(ports, assetId, what) {
  const res = await ports.api('GET', `${BASE}/project-assets/${assetId}`);
  if (res.status !== 200) return { problem: `reading ${what} answered ${answered(res)}, not 200` };
  if (!/^image\/png\b/.test(res.contentType)) return { problem: `${what} was served as ${res.contentType || 'no content type'}, not image/png` };
  if (!Buffer.isBuffer(res.bytes)) return { problem: `this runner returned no raw body for ${what}, so its pixels cannot be compared` };
  try {
    return { pixels: png.decodeRgba(res.bytes), reply: res };
  } catch (error) {
    return { problem: `${what} could not be decoded: ${common.errorText(error)}` };
  }
}

/**
 * @description Upload the generated image, then require the stored image to hold the generated pixels
 * and its bytes to match the digest Create recorded. That read also proves the decoder on a known
 * answer before the candidate is judged with it.
 * @param {object} ports - api, upload.
 * @param {object} fixture - tag, pixels; gains sourceAsset.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<{state: 'ok'|'unavailable'|'fail', detail?: string}>} ok when the stored image is the generated one.
 */
async function uploadSource(ports, fixture, ledger) {
  const file = { field: 'image', name: `${fixture.tag}.png`, type: 'image/png', bytes: png.encodeRgba(IMAGE.width, IMAGE.height, fixture.pixels) };
  const res = await ports.upload(`${BASE}/project-assets`, {}, file);
  const asset = res.json.asset || null;
  if (res.status === 409 && res.json.error === 'project_asset_limit_reached') {
    return { state: 'unavailable', detail: 'The caller\'s Create image storage is full (409 project_asset_limit_reached); the editor\'s project dialog removes unattached uploads older than 24 hours.' };
  }
  if (res.status !== 201 || !asset || !UUID_RE.test(String(asset.id))) return outcomeOf([`the image upload answered ${answered(res)}, not 201 with an asset`]);
  fixture.sourceAsset = asset;
  ledger.created('create-asset', asset.id);
  const problems = [];
  if (asset.width !== IMAGE.width || asset.height !== IMAGE.height) problems.push(`the upload is recorded as ${asset.width} x ${asset.height}, not ${IMAGE.width} x ${IMAGE.height}`);
  const stored = await readImage(ports, asset.id, 'the uploaded image');
  if (stored.problem) return outcomeOf([...problems, stored.problem]);
  if (stored.reply.sha256 !== asset.sha256 || stored.reply.byteLength !== asset.bytes) problems.push('the stored image does not match the digest and length its upload recorded');
  const same = stored.pixels.width === IMAGE.width && stored.pixels.height === IMAGE.height && stored.pixels.data.equals(fixture.pixels);
  if (!same) problems.push('the stored image does not hold the generated pixels');
  return outcomeOf(problems);
}

/**
 * @description Save the tagged project holding the image layer and the text layer.
 * @param {object} ports - api.
 * @param {object} fixture - tag, sourceAsset; gains projectId, document, titleLayer and photoLayer.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<string[]>} Problems (empty when saved as revision 1).
 */
async function saveProject(ports, fixture, ledger) {
  const res = await ports.api('POST', `${BASE}/projects`, { title: fixture.tag, document: seedDocument(fixture.tag, fixture.sourceAsset) });
  const project = res.json.project || null;
  if (res.status !== 201 || !project || !UUID_RE.test(String(project.id))) return [`saving the project answered ${answered(res)}, not 201 with a project`];
  fixture.projectId = project.id;
  fixture.document = project.document;
  ledger.created('create-project', project.id);
  const layers = project.document && Array.isArray(project.document.layers) ? project.document.layers : [];
  fixture.titleLayer = layers.find((layer) => layer.id === 'title') || null;
  fixture.photoLayer = layers.find((layer) => layer.id === 'photo') || null;
  const problems = [];
  if (project.revision !== 1) problems.push(`the new project is at revision ${project.revision}, not 1`);
  if (project.title !== fixture.tag) problems.push('the new project does not carry the run\'s tag as its title');
  if (!fixture.titleLayer || !fixture.photoLayer) problems.push('the saved document does not hold the image layer and the text layer');
  return problems;
}

/**
 * @description Ask for the region to be regenerated from revision 1.
 * @param {object} ports - api.
 * @param {object} fixture - projectId, sourceAsset, maxCostClass; marks possible admission before sending and captures any valid edit ID.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<{state: 'ok'|'unavailable'|'fail', detail?: string}>} Whether the request was admitted.
 */
async function requestEdit(ports, fixture, ledger) {
  fixture.possiblyAdmitted = true;
  const res = await ports.api('POST', `${projectPath(fixture.projectId)}/region-edits`, { sourceRevision: 1, selection: selection(), instruction: INSTRUCTION, maxCostClass: fixture.maxCostClass });
  const edit = res.json.edit || null;
  if (res.status === 409 && res.json.error === 'region_edit_in_progress') {
    fixture.possiblyAdmitted = false;
    return { state: 'unavailable', detail: 'The caller already has a region edit in flight, and Create admits one per person (409 region_edit_in_progress).' };
  }
  if (res.status === 429 && res.json.error === 'region_edit_daily_limit') {
    fixture.possiblyAdmitted = false;
    return { state: 'unavailable', detail: 'The caller has used the region edits Create allows per 24 hours (429 region_edit_daily_limit).' };
  }
  if (res.status !== 202 || !edit || !UUID_RE.test(String(edit.id))) return { state: 'fail', detail: `The region edit request answered ${answered(res)}, not 202 with an edit.` };
  fixture.editId = edit.id;
  fixture.generating = true;
  ledger.created('create-region-edit', edit.id);
  const asked = edit.status === 'generating' && edit.sourceRevision === 1 && edit.layerId === 'photo' && edit.sourceAssetId === fixture.sourceAsset.id;
  return asked ? { state: 'ok' } : { state: 'fail', detail: 'The admitted region edit does not name revision 1, the image layer and the uploaded image, or is not generating.' };
}

/**
 * @description Wait for the edit to leave `generating`, within the budget.
 * @param {object} io - api, sleep, now.
 * @param {object} fixture - projectId, editId; remains unaccounted until its terminal reply has been validated.
 * @param {{editBudgetMs: number, pollMs: number}} budgets - The wait.
 * @returns {Promise<{edit?: object, elapsedMs: number, problem?: string}>} The settled edit, or why not.
 */
async function awaitEdit(io, fixture, budgets) {
  fixture.generating = true;
  const polled = await common.pollUntil(io, { budgetMs: budgets.editBudgetMs, pollMs: budgets.pollMs }, async () => {
    const res = await io.api('GET', editPath(fixture));
    const edit = res.status === 200 ? res.json.edit : null;
    return { done: res.status !== 200 || !edit || edit.status !== 'generating', value: { res, edit } };
  });
  const { res, edit } = polled.value;
  if (!polled.done) return { elapsedMs: polled.elapsedMs, problem: `the region edit was still generating after ${Math.round(polled.elapsedMs / 1000)} s` };
  if (!edit) return { elapsedMs: polled.elapsedMs, problem: `reading the region edit answered ${answered(res)}, not 200 with an edit` };
  if (edit.status !== 'ready') return { edit, elapsedMs: polled.elapsedMs, problem: `the region edit ended ${edit.status}${edit.error ? ` (${edit.error})` : ''}, not ready` };
  return { edit, elapsedMs: polled.elapsedMs };
}

/**
 * @description Compare the candidate with the source, pixel by pixel, split by the region's box.
 * @param {{width: number, height: number, data: Buffer}} source - The generated pixels.
 * @param {{width: number, height: number, data: Buffer}} result - The candidate's pixels, same size.
 * @param {{left: number, top: number, right: number, bottom: number}} region - The box (right and bottom exclusive).
 * @returns {{outside: number, outsideChanged: number, inside: number, insideChanged: number, firstOutside: string|null}} The counts.
 */
function comparePixels(source, result, region) {
  const counts = { outside: 0, outsideChanged: 0, inside: 0, insideChanged: 0, firstOutside: null };
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const at = (y * source.width + x) * 4;
      const changed = source.data.readUInt32LE(at) !== result.data.readUInt32LE(at);
      if (x >= region.left && x < region.right && y >= region.top && y < region.bottom) {
        counts.inside += 1;
        if (changed) counts.insideChanged += 1;
      } else {
        counts.outside += 1;
        if (changed) counts.outsideChanged += 1;
        if (changed && !counts.firstOutside) counts.firstOutside = `${x},${y}`;
      }
    }
  }
  return counts;
}

/**
 * @description Decode the candidate and judge it against the source.
 * @param {object} ports - api.
 * @param {object} fixture - pixels, sourceAsset; gains resultAsset.
 * @param {object} edit - The ready edit.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<{problems: string[], pixels?: object}>} Problems and the counts.
 */
async function judgeCandidate(ports, fixture, edit, ledger) {
  const asset = edit.resultAsset || null;
  if (!asset || !UUID_RE.test(String(asset.id))) return { problems: ['the ready region edit names no candidate image'] };
  if (!fixture.resultAsset || fixture.resultAsset.id !== asset.id) ledger.created('create-asset', asset.id);
  fixture.resultAsset = asset;
  if (asset.id === fixture.sourceAsset.id) return { problems: ['the candidate is the uploaded image itself'] };
  const candidate = await readImage(ports, asset.id, 'the candidate image');
  if (candidate.problem) return { problems: [candidate.problem] };
  if (candidate.pixels.width !== IMAGE.width || candidate.pixels.height !== IMAGE.height) {
    return { problems: [`the candidate is ${candidate.pixels.width} x ${candidate.pixels.height}, not the source's ${IMAGE.width} x ${IMAGE.height}`] };
  }
  const pixels = comparePixels({ ...IMAGE, data: fixture.pixels }, candidate.pixels, REGION);
  const problems = [];
  if (pixels.outsideChanged) {
    problems.push(`${pixels.outsideChanged} of the ${pixels.outside} pixels outside the region changed (the first at ${pixels.firstOutside})`);
  }
  if (!pixels.insideChanged) problems.push('no pixel inside the region changed, so nothing was regenerated');
  return { problems, pixels };
}

/**
 * @description What revision 2 must show: the candidate on the image layer and nothing else moved.
 * @param {object} fixture - resultAsset, titleLayer, photoLayer and the original document.
 * @param {object} document - The accepted revision's document.
 * @returns {string[]} Problems.
 */
function acceptedDocumentProblems(fixture, document) {
  const layers = document && Array.isArray(document.layers) ? document.layers : [];
  const photo = layers.find((layer) => layer.id === 'photo');
  const title = layers.find((layer) => layer.id === 'title');
  const image = photo && document.images ? document.images[photo.assetId] : null;
  const problems = [];
  if (!image || image.src !== fixture.resultAsset.src) problems.push('the image layer of revision 2 does not show the candidate');
  if (!photo || !sameJson({ ...photo, assetId: null }, { ...fixture.photoLayer, assetId: null })) problems.push('the image layer of revision 2 changed in more than its image');
  if (!title || !sameJson(title, fixture.titleLayer)) problems.push('the text layer did not survive the accept unchanged');
  if (layers.length !== 2) problems.push(`revision 2 holds ${layers.length} layers, not 2`);
  if (!sameJson(layers.map((layer) => layer.id), fixture.document.layers.map((layer) => layer.id))) problems.push('revision 2 changed the layer order');
  if (!sameJson({ ...document, layers: null, images: null }, { ...fixture.document, layers: null, images: null })) problems.push('revision 2 changed the original canvas or document properties');
  return problems;
}

/**
 * @description Accept the candidate on revision 1, then read the edit, the persisted document and revision 1 back.
 * @param {object} ports - api.
 * @param {object} fixture - projectId, editId, document, resultAsset, titleLayer, photoLayer.
 * @returns {Promise<string[]>} Problems (empty when the project is at revision 2 with revision 1 kept).
 */
async function acceptEdit(ports, fixture) {
  const res = await ports.api('POST', `${editPath(fixture)}/accept`, { baseRevision: 1 });
  const project = res.json.project || null;
  if (res.status !== 201 || !project) return [`accepting the candidate answered ${answered(res)}, not 201 with a project`];
  const problems = [];
  if (project.revision !== 2) problems.push(`the accept produced revision ${project.revision}, not 2`);
  problems.push(...acceptedDocumentProblems(fixture, project.document));
  const [edit, current, first] = await Promise.all([ports.api('GET', editPath(fixture)), ports.api('GET', projectPath(fixture.projectId)),
    ports.api('GET', `${projectPath(fixture.projectId)}/revisions/1`)]);
  const accepted = edit.status === 200 && edit.json.edit && edit.json.edit.status === 'accepted' && edit.json.edit.acceptedRevision === 2;
  if (!accepted) problems.push('the region edit does not read back as accepted into revision 2');
  if (current.status !== 200 || !current.json.project || current.json.project.revision !== 2) problems.push('the project does not read back at revision 2');
  else if (!sameJson(current.json.project.document, project.document)) problems.push('the persisted revision-2 document differs from the accept response');
  const kept = first.status === 200 && first.json.project && sameJson(first.json.project.document, fixture.document);
  if (!kept) problems.push('revision 1 does not read back as it was saved');
  return problems;
}

/**
 * @description Note what the settled edit cost and which provider and model answered.
 * @param {object} edit - The settled edit.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {{provider: unknown, model: unknown, costUsd: unknown}} The evidence.
 */
function spendOf(edit, ledger) {
  if (typeof edit.costUsd === 'number' && edit.costUsd > 0) ledger.kept('cost-ledger', `create-region-edit-${edit.id}`, COST_KEPT);
  return { provider: edit.provider, model: edit.model, costUsd: edit.costUsd };
}

/**
 * @description The case body once the preconditions hold: upload, save, request, wait, judge, accept.
 * @param {object} io - api, upload, sleep, now.
 * @param {object} fixture - tag, pixels; gains every id the run creates.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @param {{editBudgetMs: number, pollMs: number}} budgets - The wait for the candidate.
 * @returns {Promise<{verdict: {state: string, detail: string}, evidence: object}>} The verdict.
 */
async function exercise(io, fixture, ledger, budgets) {
  const fail = (problems, evidence = {}) => ({ verdict: { state: 'fail', detail: `${problems.join('; ')}.` }, evidence });
  const uploaded = await uploadSource(io, fixture, ledger);
  if (uploaded.state !== 'ok') return { verdict: { state: uploaded.state, detail: uploaded.detail }, evidence: {} };
  const saved = await saveProject(io, fixture, ledger);
  if (saved.length) return fail(saved);
  const admitted = await requestEdit(io, fixture, ledger);
  if (admitted.state !== 'ok') return { verdict: { state: admitted.state, detail: admitted.detail }, evidence: {} };
  const settled = await awaitEdit(io, fixture, budgets);
  if (settled.edit) {
    const problem = accountEditRecord(fixture, ledger, settled.edit);
    if (problem) return fail([problem], { elapsedMs: settled.elapsedMs });
    fixture.accounted = true;
    fixture.generating = false;
  }
  const evidence = { elapsedMs: settled.elapsedMs, ...(settled.edit ? spendOf(settled.edit, ledger) : {}) };
  if (settled.problem) return fail([settled.problem], evidence);
  const judged = await judgeCandidate(io, fixture, settled.edit, ledger);
  if (judged.pixels) evidence.pixels = judged.pixels;
  if (judged.problems.length) return fail(judged.problems, evidence);
  const accepted = await acceptEdit(io, fixture);
  if (accepted.length) return fail(accepted, evidence);
  return { verdict: { state: 'pass', detail: `Project ${fixture.projectId}: ${settled.edit.provider} regenerated the ${REGION.right - REGION.left} x ${REGION.bottom - REGION.top} region `
    + `(${judged.pixels.insideChanged} of ${judged.pixels.inside} pixels changed), all ${judged.pixels.outside} pixels outside it are byte for byte the source, `
    + 'and the accept made revision 2 with the text layer and revision 1 unchanged. The two images stay as unattached uploads until Create reclaims them.' }, evidence };
}

/**
 * @description Validate a matching terminal record and retain every known candidate/cost before permitting deletion.
 * @param {object} fixture - projectId, editId, sourceAsset; may gain resultAsset.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @param {object} edit - An ordinary poll or cancellation reply; not trusted until validated.
 * @returns {string|null} A provenance/accounting error, or null when the terminal record was accounted for.
 */
function accountEditRecord(fixture, ledger, edit) {
  if (!edit || edit.id !== fixture.editId || edit.projectId !== fixture.projectId) return 'the terminal reply does not identify the matching edit; project retained';
  if (!['ready', 'accepted', 'rejected', 'cancelled', 'failed'].includes(edit.status)) return 'the edit has no affirmative terminal status; project retained';
  const problems = [];
  const asset = edit.resultAsset;
  const candidateExpected = ['ready', 'accepted', 'rejected'].includes(edit.status);
  const validAsset = asset && UUID_RE.test(String(asset.id)) && asset.id !== fixture.sourceAsset.id;
  if ((candidateExpected && !validAsset) || (asset !== null && !validAsset)) problems.push('the settled edit has no valid candidate asset to account for');
  if (validAsset) {
    if (!fixture.resultAsset || fixture.resultAsset.id !== asset.id) ledger.created('create-asset', asset.id);
    fixture.resultAsset = asset;
  }
  const validCost = edit.costUsd === null || (typeof edit.costUsd === 'number' && Number.isFinite(edit.costUsd) && edit.costUsd >= 0);
  const named = typeof edit.provider === 'string' && edit.provider.trim() && typeof edit.model === 'string' && edit.model.trim();
  if (!validCost || ((candidateExpected || edit.costUsd > 0) && !named)) problems.push('the settled edit has malformed reported spend metadata');
  else spendOf(edit, ledger);
  return problems.length ? `${problems.join('; ')}; project retained` : null;
}

/**
 * @description Read and account for the terminal edit after cancellation lost the race.
 * @param {object} ports - api.
 * @param {object} fixture - The run's project/edit IDs and assets.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<string|null>} A cleanup error or affirmative accounting evidence.
 */
async function accountSettledEdit(ports, fixture, ledger) {
  const res = await ports.api('GET', editPath(fixture));
  if (res.status !== 200) return `reading the edit after cancellation lost the race answered ${answered(res)}; project retained`;
  return accountEditRecord(fixture, ledger, res.json.edit);
}

/**
 * @description Stop an edit that may still be generating, or account for the candidate that won the race.
 * @param {object} ports - api.
 * @param {object} fixture - projectId, editId, possiblyAdmitted, accounted and known assets.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<boolean>} Whether it is safe to delete the project's candidate provenance.
 */
async function cancelEdit(ports, fixture, ledger) {
  if (!fixture.possiblyAdmitted || fixture.accounted) return true;
  if (!fixture.editId) {
    ledger.error('the region-edit admission outcome is unknown (no usable edit ID); project retained');
    return false;
  }
  let accounted = false;
  await ledger.attempt(`region edit ${fixture.editId} cancel`, async () => {
    const res = await ports.api('POST', `${editPath(fixture)}/cancel`, {});
    if (res.status === 200) {
      if (!res.json.edit || res.json.edit.status !== 'cancelled') return 'cancellation did not affirm that the edit is cancelled; project retained';
      const problem = accountEditRecord(fixture, ledger, res.json.edit);
      if (problem) return problem;
      ledger.kept('create-late-candidate', fixture.editId, LATE_KEPT);
    } else if (res.status === 409 && res.json.error === 'region_edit_not_cancellable') {
      const problem = await accountSettledEdit(ports, fixture, ledger);
      if (problem) return problem;
    } else return `cancelling region edit ${fixture.editId} answered ${answered(res)}; project retained`;
    fixture.generating = false;
    fixture.accounted = true;
    accounted = true;
    return null;
  });
  return accounted;
}

/**
 * @description Delete exactly the run's project (its title must be the run's tag) and read the
 * project and its region edit back as gone. Revisions, image references and the edit cascade.
 * @param {object} ports - api.
 * @param {object} fixture - projectId, editId, tag.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<void>} Resolves when recorded.
 */
async function removeProject(ports, fixture, ledger) {
  await ledger.attempt(`Create project ${fixture.projectId} delete`, async () => {
    const current = await ports.api('GET', projectPath(fixture.projectId));
    const project = current.status === 200 ? current.json.project : null;
    if (!project || !Number.isInteger(project.revision)) return `reading project ${fixture.projectId} before its delete answered ${answered(current)}`;
    if (project.title !== fixture.tag) return `project ${fixture.projectId} does not carry the run's tag; not deleted`;
    const res = await ports.api('DELETE', projectPath(fixture.projectId), { baseRevision: project.revision });
    if (res.status !== 204) return `DELETE ${projectPath(fixture.projectId)} answered ${answered(res)}, not 204`;
    const gone = await ports.api('GET', projectPath(fixture.projectId));
    if (gone.status !== 404) return `project ${fixture.projectId} answered HTTP ${gone.status} after its delete, not 404`;
    ledger.removed('create-project', fixture.projectId);
    if (!fixture.editId) return null;
    const edit = await ports.api('GET', editPath(fixture));
    if (edit.status !== 404) return `region edit ${fixture.editId} answered HTTP ${edit.status} after its project was deleted, not 404`;
    ledger.removed('create-region-edit', fixture.editId);
    return null;
  });
}

/**
 * @description Remove what the run created, and record what Create keeps and why.
 * @param {object} ports - api.
 * @param {object} fixture - Every id the run created.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<void>} Resolves when recorded.
 */
async function cleanUp(ports, fixture, ledger) {
  const accounted = await cancelEdit(ports, fixture, ledger);
  if (fixture.projectId && accounted) await removeProject(ports, fixture, ledger);
  const projectRetained = ledger.outstanding().some((entry) => entry.kind === 'create-project' && entry.id === fixture.projectId);
  const why = projectRetained ? 'an upload retained with an undeleted fixture project; resolve the red cleanup receipt before any asset cleanup' : ASSET_KEPT;
  for (const asset of [fixture.sourceAsset, fixture.resultAsset]) if (asset) ledger.kept('create-asset', asset.id, why);
}

/**
 * @description The two read-only preconditions, in order.
 * @param {object} ports - api.
 * @param {boolean} allowPaid - Whether the runner carried the operator's consent to a paid edit.
 * @returns {Promise<{state: 'ok'|'unavailable'|'fail', detail?: string, provider?: object}>} The first that does not hold, or ok with the provider.
 */
async function preconditions(ports, allowPaid) {
  const permitted = await probePermissions(ports);
  return permitted.state === 'ok' ? probeProvider(ports, allowPaid) : permitted;
}

/**
 * @description Run the case once.
 * @param {object} ports - api, upload; optional sleep and now.
 * @param {{allowPaid?: boolean, editBudgetMs?: number, pollMs?: number}} [options] - The consent flag and the wait.
 * @returns {Promise<object>} The result with its cleanup receipt.
 */
async function run(ports, options = {}) {
  const missing = common.missingPorts(ports, NEEDS);
  if (missing.length) return common.unavailable(CASE_ID, `This runner has no ${missing.join('/')} port.`);
  const ready = await preconditions(ports, options.allowPaid === true);
  const provider = ready.provider ? { provider: ready.provider } : {};
  if (ready.state === 'unavailable') return common.unavailable(CASE_ID, ready.detail, provider);
  if (ready.state === 'fail') return common.finish(CASE_ID, { state: 'fail', detail: `${ready.detail} Nothing was written.` }, new common.CleanupLedger(), provider);
  const io = common.withClock(ports);
  const ledger = new common.CleanupLedger();
  const fixture = { tag: common.mintTag(KEY), pixels: sourcePixels(), sourceAsset: null, resultAsset: null, projectId: null, editId: null, generating: false,
    possiblyAdmitted: false, accounted: false,
    maxCostClass: options.allowPaid === true && ready.provider.costClass === 'paid' ? 'paid' : 'free' };
  let outcome;
  try {
    outcome = await exercise(io, fixture, ledger, common.budgetsFrom(DEFAULT_BUDGETS, options));
  } catch (error) {
    outcome = { verdict: { state: 'fail', detail: `The case crashed: ${common.errorText(error)}` }, evidence: {} };
  }
  await cleanUp(io, fixture, ledger);
  const ids = { projectId: fixture.projectId, editId: fixture.editId, sourceAssetId: fixture.sourceAsset && fixture.sourceAsset.id,
    resultAssetId: fixture.resultAsset && fixture.resultAsset.id };
  return common.finish(CASE_ID, outcome.verdict, ledger, { tag: fixture.tag, ...provider, ...ids, ...outcome.evidence });
}

module.exports = { CASE_ID, KEY, TITLE, NEEDS, IMAGE, REGION, ALLOW_PAID_COMMAND, sourcePixels, selection, comparePixels, run };
