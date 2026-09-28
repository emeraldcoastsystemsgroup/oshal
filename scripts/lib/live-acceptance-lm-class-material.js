/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - live acceptance for "ADR-139 - the little-monsters class-materials destination": as the caller (a Little Monsters teacher or admin) create one tagged synthetic class, carry one generated PDF in a Send-to handle (POST /api/artifacts/handles/upload, the path a source with no serve URL uses), hand it to the installed package's POST /api/education/import-artifact with that class, and require 201 with shareStatus approved and the material listed in the class's shared materials. Cleanup deletes the material and the class through the package's own routes (the class delete also removes stored files, grounding collections and the class tool) and proves both gone; the handle is memory-only and expires on its own TTL.
 */

'use strict';

const common = require('./live-acceptance-common.js');

const CASE_ID = 'lm-class-material-live';
const KEY = 'lm-class-material';
const TITLE = 'Little Monsters: Send-to hands a PDF to a class as approved material';
const NEEDS = Object.freeze(['api', 'upload']);
const EDU = '/api/education';
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
 * @description The run's fixture: class fields and the document it hands over.
 * @param {string} tag - The run's fixture tag.
 * @returns {{className: string, subject: string, fileName: string, pdf: Buffer}} The fixture.
 */
function createFixture(tag) {
  return {
    className: tag,
    subject: 'Test Lab',
    fileName: `${tag}.pdf`,
    pdf: buildPdf(`Synthetic class handout ${tag}. Created and deleted by the live-acceptance sweep.`),
  };
}

/**
 * @description Import the document into the class the way the Send to... dispatch does.
 * @param {object} ports - api, upload.
 * @param {ReturnType<typeof createFixture>} fixture - The run's fixture.
 * @param {string} classId - The fixture class.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<{ok: boolean, detail: string, materialId: string|null}>} The import's judgement.
 */
async function importMaterial(ports, fixture, classId, ledger) {
  const handle = await ports.upload('/api/artifacts/handles/upload', { type: 'application/pdf', name: fixture.fileName },
    { name: fixture.fileName, type: 'application/pdf', bytes: fixture.pdf });
  const ref = handle.json && handle.json.ref;
  if (handle.status !== 201 || typeof ref !== 'string') return { ok: false, detail: `POST /api/artifacts/handles/upload answered HTTP ${handle.status}`, materialId: null };
  ledger.kept('send-to-handle', ref, `memory-only; expires ${handle.json.expiresAt || 'on its TTL'}`);
  const imported = await ports.api('POST', `${EDU}/import-artifact`, { ref, classId });
  const material = imported.json && imported.json.material;
  const materialId = material && UUID_RE.test(String(material.material_id)) ? String(material.material_id) : null;
  if (materialId) ledger.created('lm-material', materialId);
  if (imported.status !== 201 || !materialId) return { ok: false, detail: `import-artifact answered HTTP ${imported.status}: ${(imported.json && imported.json.error) || 'no material'}`, materialId };
  if (imported.json.shareStatus !== 'approved') return { ok: false, detail: `the import came back ${imported.json.shareStatus}, not approved (is the caller a teacher of the class?)`, materialId };
  const shared = await ports.api('GET', `${EDU}/classes/${classId}/shared-materials`);
  const listed = (Array.isArray(shared.json && shared.json.materials) ? shared.json.materials : []).some((m) => m && m.material_id === materialId);
  if (!listed) return { ok: false, detail: `material ${materialId} is not in the class's shared materials (HTTP ${shared.status})`, materialId };
  return { ok: true, detail: `import-artifact answered 201 approved (grounded ${Boolean(imported.json.grounded)}) and material ${materialId} is in the class's shared materials`, materialId };
}

/**
 * @description Delete the material and the class through the package's routes and prove both gone.
 * @param {object} ports - api.
 * @param {string} classId - The fixture class.
 * @param {string|null} materialId - The imported material.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<void>} Resolves when recorded.
 */
async function cleanUp(ports, classId, materialId, ledger) {
  if (materialId) {
    await ledger.attempt(`material ${materialId} delete`, async () => {
      const res = await ports.api('DELETE', `${EDU}/materials/${materialId}`);
      if (res.status !== 200) return `DELETE ${EDU}/materials/${materialId} answered HTTP ${res.status}`;
      ledger.removed('lm-material', materialId);
      return null;
    });
  }
  await ledger.attempt(`class ${classId} delete`, async () => {
    const res = await ports.api('DELETE', `${EDU}/classes/${classId}`);
    if (res.status !== 200) return `DELETE ${EDU}/classes/${classId} answered HTTP ${res.status}`;
    const info = await ports.api('GET', `${EDU}/classes/${classId}/info`);
    if (info.status === 200) return `class ${classId} still answers after the delete`;
    const listed = await ports.api('GET', `${EDU}/classes`);
    const classes = Array.isArray(listed.json && listed.json.classes) ? listed.json.classes : (Array.isArray(listed.json) ? listed.json : []);
    if (classes.some((c) => c && (c.class_id === classId || c.classId === classId))) return `class ${classId} is still listed after the delete`;
    ledger.removed('lm-class', classId);
    return null;
  });
}

/**
 * @description Run the case once.
 * @param {object} ports - api, upload.
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
  let verdict;
  let classId = null;
  let materialId = null;
  try {
    const made = await ports.api('POST', `${EDU}/classes`, { name: fixture.className, subject: fixture.subject, description: 'Synthetic live-acceptance class' });
    classId = made.json && UUID_RE.test(String(made.json.classId)) ? String(made.json.classId) : null;
    if (classId) ledger.created('lm-class', classId);
    if (made.status !== 201 || !classId) verdict = { state: 'fail', detail: `POST ${EDU}/classes answered HTTP ${made.status}: ${(made.json && made.json.error) || 'no class'}.` };
    else {
      const imported = await importMaterial(ports, fixture, classId, ledger);
      materialId = imported.materialId;
      verdict = { state: imported.ok ? 'pass' : 'fail', detail: `Class ${fixture.className}: ${imported.detail}.` };
    }
  } catch (error) {
    verdict = { state: 'fail', detail: `The case crashed: ${common.errorText(error)}` };
  }
  if (classId) await cleanUp(ports, classId, materialId, ledger);
  return common.finish(CASE_ID, verdict, ledger, { classId, materialId, bytes: fixture.pdf.length });
}

module.exports = { CASE_ID, KEY, TITLE, NEEDS, buildPdf, createFixture, importMaterial, run };
