/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - live acceptance for "ADR-139 - the little-monsters class-materials destination": as the caller (a Little Monsters teacher or admin) create one tagged synthetic class, carry one generated PDF in a Send-to handle (POST /api/artifacts/handles/upload, the path a source with no serve URL uses), hand it to the installed package's POST /api/education/import-artifact with that class, and require 201 with shareStatus approved and the material listed in the class's shared materials. Cleanup deletes the material and the class through the package's own routes (the class delete also removes stored files, grounding collections and the class tool) and proves both gone; the handle is memory-only and expires on its own TTL.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Two legs and an optional third, one tagged class. The handle leg above stays. The files leg (live-acceptance-lm-class-material-files.js) proves the entry's Done-when as written: the PDF goes into the caller's oshal storage through the files browser's upload route, headless Chromium sends it from the files browser through Send to... "File into a class", the shell lands on the Little Monsters picker, the class is chosen THERE, and the destination's own import answers 201 approved and is listed; a carried-bytes handle or a class not chosen in the dispatch fails the leg. On a runner without Chromium (the Lab) that leg is a named gap and the case is degraded, never pass. The optional non-teacher leg runs only when the runner binds a second caller (`ports.second`, an api + upload pair as the owner of OSHAL_VERIFY_SECOND_PAT) who is enrolled in the tagged class: that caller's import must come back requested, stay out of the class's shared materials and appear in the teacher's share requests; a runner that binds no such port, or a second caller outside the class, reports the leg unavailable by name, and it does not decide the verdict. Cleanup deletes every material through its owner's port, the class, and the storage file with a folder read-back.
 */

'use strict';

const common = require('./live-acceptance-common.js');
const files = require('./live-acceptance-lm-class-material-files.js');

const CASE_ID = 'lm-class-material-live';
const KEY = 'lm-class-material';
const TITLE = 'Little Monsters: a PDF from the files browser (and a Send-to handle) lands in a class as approved material';
const NEEDS = Object.freeze(['api', 'upload']);
const EDU = '/api/education';
const SECOND_PAT_ENV = 'OSHAL_VERIFY_SECOND_PAT';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @description Escape text for a PDF literal string.
 * @param {string} text - Plain ASCII text.
 * @returns {string} The escaped literal body.
 */
function pdfLiteral(text) {
  return String(text).replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1');
}

/**
 * @description A minimal, valid one-page PDF (Helvetica, one line of text) with a correct xref table,
 * so the package's type classification and text extraction treat it as a real document.
 * @param {string} line - The page's text.
 * @returns {Buffer} The PDF bytes.
 */
function buildPdf(line) {
  const content = `BT /F1 18 Tf 72 720 Td (${pdfLiteral(line)}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/**
 * @description The run's fixture: class fields and the documents each leg hands over.
 * @param {string} tag - The run's fixture tag.
 * @returns {{className: string, subject: string, fileName: string, pdf: Buffer, browserFileName: string, browserPdf: Buffer, secondFileName: string, secondPdf: Buffer}} The fixture.
 */
function createFixture(tag) {
  return {
    className: tag,
    subject: 'Test Lab',
    fileName: `${tag}.pdf`,
    pdf: buildPdf(`Synthetic class handout ${tag}. Created and deleted by the live-acceptance sweep.`),
    browserFileName: `${tag}-files.pdf`,
    browserPdf: buildPdf(`Synthetic files-browser handout ${tag}. Sent from the files browser by the live-acceptance sweep.`),
    secondFileName: `${tag}-student.pdf`,
    secondPdf: buildPdf(`Synthetic student handout ${tag}. Shared for review by the live-acceptance sweep.`),
  };
}

/**
 * @description Carry a PDF in a Send-to handle and hand it to the import as one caller.
 * @param {object} caller - api, upload.
 * @param {{name: string, pdf: Buffer}} doc - The document.
 * @param {string} classId - The class.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<{status: number, json: object, materialId: string|null, ref: string|null}>} The import's answer.
 */
async function importHandle(caller, doc, classId, ledger) {
  const handle = await caller.upload('/api/artifacts/handles/upload', { type: 'application/pdf', name: doc.name }, { name: doc.name, type: 'application/pdf', bytes: doc.pdf });
  const ref = handle.json && handle.json.ref;
  if (handle.status !== 201 || typeof ref !== 'string') return { status: handle.status, json: { error: `POST /api/artifacts/handles/upload answered HTTP ${handle.status}` }, materialId: null, ref: null };
  ledger.kept('send-to-handle', ref, `memory-only; expires ${handle.json.expiresAt || 'on its TTL'}`);
  const imported = await caller.api('POST', `${EDU}/import-artifact`, { ref, classId });
  const material = imported.json && imported.json.material;
  const materialId = material && UUID_RE.test(String(material.material_id)) ? String(material.material_id) : null;
  if (materialId) ledger.created('lm-material', materialId);
  return { status: imported.status, json: imported.json || {}, materialId, ref };
}

/**
 * @description Whether a material is in a class listing route's answer.
 * @param {object} ports - api.
 * @param {string} route - The listing route.
 * @param {string} materialId - The material.
 * @returns {Promise<{listed: boolean, status: number}>} The read.
 */
async function listedIn(ports, route, materialId) {
  const res = await ports.api('GET', route);
  const rows = Array.isArray(res.json && res.json.materials) ? res.json.materials : (Array.isArray(res.json && res.json.requests) ? res.json.requests : []);
  return { listed: rows.some((m) => m && m.material_id === materialId), status: res.status };
}

/**
 * @description The handle leg: import the document into the class the way a source with no serve
 * URL does, and require it approved and listed.
 * @param {object} ports - api, upload.
 * @param {ReturnType<typeof createFixture>} fixture - The run's fixture.
 * @param {string} classId - The fixture class.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<{ok: boolean, detail: string, materialId: string|null}>} The import's judgement.
 */
async function importMaterial(ports, fixture, classId, ledger) {
  const imported = await importHandle(ports, { name: fixture.fileName, pdf: fixture.pdf }, classId, ledger);
  const { materialId } = imported;
  if (imported.status !== 201 || !materialId) return { ok: false, detail: `import-artifact answered HTTP ${imported.status}: ${(imported.json && imported.json.error) || 'no material'}`, materialId };
  if (imported.json.shareStatus !== 'approved') return { ok: false, detail: `the import came back ${imported.json.shareStatus}, not approved (is the caller a teacher of the class?)`, materialId };
  const shared = await listedIn(ports, `${EDU}/classes/${classId}/shared-materials`, materialId);
  if (!shared.listed) return { ok: false, detail: `material ${materialId} is not in the class's shared materials (HTTP ${shared.status})`, materialId };
  return { ok: true, detail: `import-artifact answered 201 approved (grounded ${Boolean(imported.json.grounded)}) and material ${materialId} is in the class's shared materials`, materialId };
}

/**
 * @description The optional non-teacher leg, as the runner's second caller: the import must come back
 * requested, stay out of the shared materials and show in the teacher's share requests.
 * @param {object} ports - api (the teacher) and, when bound, second (api + upload).
 * @param {ReturnType<typeof createFixture>} fixture - The run's fixture.
 * @param {string} classId - The fixture class.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<{state: 'pass'|'fail'|'unavailable', detail: string, materialId: string|null}>} The leg's outcome.
 */
async function secondCallerLeg(ports, fixture, classId, ledger) {
  const second = ports.second;
  if (!second || typeof second.api !== 'function' || typeof second.upload !== 'function') {
    return { state: 'unavailable', detail: `this runner binds no second caller (${SECOND_PAT_ENV}, a Little Monsters student's token)`, materialId: null };
  }
  const mine = await second.api('GET', `${EDU}/classes`);
  const classes = Array.isArray(mine.json && mine.json.classes) ? mine.json.classes : [];
  if (!classes.some((c) => c && (c.class_id === classId || c.classId === classId))) {
    return { state: 'unavailable', detail: `the second caller (${SECOND_PAT_ENV}) is not enrolled in the tagged class ${classId} (GET ${EDU}/classes HTTP ${mine.status}); enroll that student through Little Monsters first`, materialId: null };
  }
  const imported = await importHandle(second, { name: fixture.secondFileName, pdf: fixture.secondPdf }, classId, ledger);
  const { materialId } = imported;
  if (imported.status !== 201 || !materialId) return { state: 'fail', detail: `the second caller's import-artifact answered HTTP ${imported.status}: ${(imported.json && imported.json.error) || 'no material'}`, materialId };
  if (imported.json.shareStatus !== 'requested') return { state: 'fail', detail: `the second caller's import came back ${imported.json.shareStatus}, not requested (does ${SECOND_PAT_ENV} hold a student grant?)`, materialId };
  const shared = await listedIn(ports, `${EDU}/classes/${classId}/shared-materials`, materialId);
  if (shared.listed) return { state: 'fail', detail: `the second caller's requested material ${materialId} is already in the class's shared materials`, materialId };
  const requests = await listedIn(ports, `${EDU}/classes/${classId}/share-requests`, materialId);
  if (!requests.listed) return { state: 'fail', detail: `the second caller's requested material ${materialId} is not in the teacher's share requests (HTTP ${requests.status})`, materialId };
  return { state: 'pass', detail: `import-artifact answered 201 requested and material ${materialId} waits in the teacher's share requests, out of the shared materials`, materialId };
}

/**
 * @description Delete every material through its owner, then the class, then the storage file.
 * @param {object} ports - api (and second when bound).
 * @param {{classId: string, materials: Array<{id: string, owner: object}>, storageFile: string|null}} made - What the run created.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<void>} Resolves when recorded.
 */
async function cleanUp(ports, made, ledger) {
  for (const material of made.materials) {
    await ledger.attempt(`material ${material.id} delete`, async () => {
      const res = await material.owner.api('DELETE', `${EDU}/materials/${material.id}`);
      if (res.status !== 200) return `DELETE ${EDU}/materials/${material.id} answered HTTP ${res.status}`;
      ledger.removed('lm-material', material.id);
      return null;
    });
  }
  await ledger.attempt(`class ${made.classId} delete`, async () => {
    const res = await ports.api('DELETE', `${EDU}/classes/${made.classId}`);
    if (res.status !== 200) return `DELETE ${EDU}/classes/${made.classId} answered HTTP ${res.status}`;
    const info = await ports.api('GET', `${EDU}/classes/${made.classId}/info`);
    if (info.status === 200) return `class ${made.classId} still answers after the delete`;
    const listed = await ports.api('GET', `${EDU}/classes`);
    const classes = Array.isArray(listed.json && listed.json.classes) ? listed.json.classes : (Array.isArray(listed.json) ? listed.json : []);
    if (classes.some((c) => c && (c.class_id === made.classId || c.classId === made.classId))) return `class ${made.classId} is still listed after the delete`;
    ledger.removed('lm-class', made.classId);
    return null;
  });
  if (made.storageFile) await files.removeFromStorage(ports, made.storageFile, ledger);
}

/**
 * @description Roll the legs into one verdict: any failed leg fails; a files leg this runner cannot
 * drive degrades (the Done-when is unproven); the optional leg only counts when it ran.
 * @param {{handle: {ok: boolean, detail: string}, files: {state: string, detail: string}, second: {state: string, detail: string}}} legs - The legs.
 * @returns {{state: string, detail: string}} The verdict.
 */
function decide(legs) {
  const detail = `handle leg: ${legs.handle.detail}; files leg: ${legs.files.detail}; non-teacher leg${legs.second.state === 'unavailable' ? ' unavailable' : ''}: ${legs.second.detail}`;
  if (!legs.handle.ok || legs.files.state === 'fail' || legs.second.state === 'fail') return { state: 'fail', detail };
  if (legs.files.state !== 'pass') return { state: 'degraded', detail };
  return { state: 'pass', detail };
}

/**
 * @description Run the three legs against one tagged class, each fenced so a crash is a failed leg.
 * @param {object} ports - The runner's ports.
 * @param {ReturnType<typeof createFixture>} fixture - The run's fixture.
 * @param {string} classId - The fixture class.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<{legs: object, materials: Array<{id: string, owner: object}>, filesEvidence: object}>} The outcomes.
 */
async function runLegs(ports, fixture, classId, ledger) {
  const materials = [];
  const fence = async (leg, failed) => { try { return await leg(); } catch (error) { return failed(`the leg crashed: ${common.errorText(error)}`); } };
  const handle = await fence(() => importMaterial(ports, fixture, classId, ledger), (detail) => ({ ok: false, detail, materialId: null }));
  if (handle.materialId) materials.push({ id: handle.materialId, owner: ports });
  const filesLeg = await fence(() => files.dispatchThroughFilesBrowser(ports, fixture, classId, ledger), (detail) => ({ state: 'fail', detail, materialId: null, evidence: {} }));
  if (filesLeg.materialId) materials.push({ id: filesLeg.materialId, owner: ports });
  const second = await fence(() => secondCallerLeg(ports, fixture, classId, ledger), (detail) => ({ state: 'fail', detail, materialId: null }));
  if (second.materialId) materials.push({ id: second.materialId, owner: ports.second });
  return { legs: { handle, files: filesLeg, second }, materials, filesEvidence: filesLeg.evidence || {} };
}

/**
 * @description Run the case once.
 * @param {object} ports - api, upload (+ raw, browser for the files leg; second for the non-teacher leg).
 * @param {object} [options] - `tag` (tests only).
 * @returns {Promise<object>} The result with its cleanup receipt.
 */
async function run(ports, options = {}) {
  const missing = common.missingPorts(ports, NEEDS);
  if (missing.length) return common.unavailable(CASE_ID, `This runner has no ${missing.join('/')} port.`);
  const summary = await ports.api('GET', '/api/little-monsters/home-summary');
  if (summary.status === 404) return common.unavailable(CASE_ID, 'Little Monsters is not installed on this deployment.');
  const fixture = createFixture(options.tag || common.mintTag(KEY));
  const ledger = new common.CleanupLedger();
  const made = await ports.api('POST', `${EDU}/classes`, { name: fixture.className, subject: fixture.subject, description: 'Synthetic live-acceptance class' });
  const classId = made.json && UUID_RE.test(String(made.json.classId)) ? String(made.json.classId) : null;
  if (classId) ledger.created('lm-class', classId);
  if (made.status !== 201 || !classId) {
    return common.finish(CASE_ID, { state: 'fail', detail: `POST ${EDU}/classes answered HTTP ${made.status}: ${(made.json && made.json.error) || 'no class'}.` }, ledger, { classId });
  }
  const ran = await runLegs(ports, fixture, classId, ledger);
  const verdict = decide(ran.legs);
  const storageFile = ledger.entries.some((e) => e.kind === 'oshal-local-file' && e.id === fixture.browserFileName) ? fixture.browserFileName : null;
  await cleanUp(ports, { classId, materials: ran.materials, storageFile }, ledger);
  return common.finish(CASE_ID, { state: verdict.state, detail: `Class ${fixture.className}: ${verdict.detail}.` }, ledger,
    { classId, materials: ran.materials.map((m) => m.id), bytes: fixture.pdf.length, files: ran.filesEvidence, secondCaller: ran.legs.second.state });
}

module.exports = { CASE_ID, KEY, TITLE, NEEDS, SECOND_PAT_ENV, buildPdf, createFixture, importMaterial, secondCallerLeg, decide, run };
