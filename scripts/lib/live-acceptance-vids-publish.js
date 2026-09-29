/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - live acceptance for "Vids public-publish rail" against the vids package as the real package loader mounts it (/api/vids under auth service-or-oidc, /api/vids-public under auth public). The store spec proves the routers behind a stand-in auth shim; this case proves the installed mounts. As the caller it inserts one tagged finished job (the closed statement set: no route can make a job 'done' without a Vids worker), attaches a real one-frame H.264 MP4 carrying the run's tag, and requires: an unauthenticated GET /api/vids/jobs and an unauthenticated confirmed publish of that job (the right digest in hand) each answer 401 and publish nothing; the owner's confirmed publish with the reviewed digest yields a public link; an anonymous read of that link returns exactly the uploaded bytes; a malformed token answers 404; after the owner revokes, the same anonymous read answers 404. Cleanup revokes if needed, removes the export through the package's own DELETE route, proves its MP4 gone from disk (a named file probe that must first have seen it present), deletes exactly the tagged job and reads the residue back as zero.
 */

'use strict';

const crypto = require('node:crypto');
const common = require('./live-acceptance-common.js');

const CASE_ID = 'vids-publish-live';
const KEY = 'vids-publish';
const TITLE = 'Vids publication: anonymous callers refused on jobs and controls, only the published bytes are public, revoke closes the link';
const NEEDS = Object.freeze(['api', 'anonymous', 'upload', 'sql', 'files', 'ownerSub']);
const BASE = '/api/vids';
const PUBLIC_BASE = '/api/vids-public';
/** The named file probe (live-acceptance-common.js FILE_PROBES) for a vids export's MP4. */
const FILE_PROBE = 'vids.export';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PUBLIC_URL_RE = /^\/api\/vids-public\/([a-f0-9]{64})\/video\.mp4$/;
/**
 * A real MP4: one 16 x 16 frame of H.264 High profile (826 bytes, ftyp/moov/free/mdat), encoded with
 * FFmpeg 7.1 (libx264, SEI units removed, bitexact, no metadata). Each run appends a `free` box holding
 * its fixture tag, so the bytes the anonymous read must return belong to this run alone.
 */
const FIXTURE_MP4 = Buffer.from([
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAALybW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAA',
  'AAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAA',
  'AkF0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAA',
  'AAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAG5bWRpYQAAACBtZGhk',
  'AAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABZG1p',
  'bmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAASRzdGJsAAAAwHN0c2QA',
  'AAAAAAAAAQAAALBhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABDExhdmMgbGlieDI2NAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAGP//AAAANmF2Y0MBZAAK/+EAGWdkAAqscgRewEQAAAMABAAAAwAIPEiWEYABAAZo6EOPLIv9+PgAAAAA',
  'EHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAAAAMAAAADAAAAAGHN0dHMAAAAAAAAAAQAAAAEAAEAAAAAAHHN0c2MAAAAAAAAAAQAA',
  'AAEAAAABAAAAAQAAABRzdHN6AAAAAAAAABgAAAABAAAAFHN0Y28AAAAAAAAAAQAAAyIAAAA9dWR0YQAAADVtZXRhAAAAAAAAACFo',
  'ZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAAhpbHN0AAAACGZyZWUAAAAgbWRhdAAAABRliIEAAr/+7M9+BTYCey6rb1Vt',
  '/w==',
].join(''), 'base64');

/**
 * @description This run's MP4: the fixture plus a trailing `free` box holding the run's tag.
 * @param {string} tag - The run's fixture tag.
 * @returns {{bytes: Buffer, sha256: string, byteLength: number}} The upload and its digest.
 */
function fixtureVideo(tag) {
  const label = Buffer.from(String(tag), 'ascii');
  const header = Buffer.alloc(8);
  header.writeUInt32BE(header.length + label.length, 0);
  header.write('free', 4, 'ascii');
  const bytes = Buffer.concat([FIXTURE_MP4, header, label]);
  return { bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length };
}

/** @param {string} jobId - A job. @returns {string} The job's export route. */
const exportPath = (jobId) => `${BASE}/jobs/${jobId}/artifact`;
/** @param {string} token - A publication token (or a malformed one). @returns {string} Its anonymous read route. */
const publicPath = (token) => `${PUBLIC_BASE}/${token}/video.mp4`;

/**
 * @description Whether the installed vids carries owner-controlled publication (1.5.0 or later).
 * @param {object} ports - api.
 * @returns {Promise<{state: 'ok'|'unavailable'|'fail', detail?: string}>} The precondition.
 */
async function probeInstalled(ports) {
  const list = await ports.api('GET', `${BASE}/jobs?limit=1`);
  if (list.status === 404) return { state: 'unavailable', detail: 'vids is not installed (GET /api/vids/jobs answered 404).' };
  if (list.status !== 200) return { state: 'fail', detail: `GET ${BASE}/jobs as the caller answered HTTP ${list.status}, not 200.` };
  const probe = await ports.api('GET', exportPath(crypto.randomUUID()));
  if (probe.status === 404 && probe.json.error === 'job_not_found') return { state: 'ok' };
  if (probe.status === 404) {
    return { state: 'unavailable', detail: 'vids with owner-controlled publication (1.5.0 or later) is not installed: an unknown job\'s export route did not answer job_not_found.' };
  }
  return { state: 'fail', detail: `GET ${BASE}/jobs/<unknown job>/artifact as the caller answered HTTP ${probe.status}, not 404 job_not_found.` };
}

/**
 * @description Read what the run's job holds (owner-scoped named statement). Counts must be present.
 * @param {object} ports - sql, ownerSub.
 * @param {string} jobId - The run's job.
 * @returns {Promise<{jobs: number, exports: number, published: number, artifactId: string|null}>} The residue.
 * @throws {Error} When the read returns no counts (a missing answer is never read as zero).
 */
async function readResidue(ports, jobId) {
  const row = ((await ports.sql('vids.residue', [ports.ownerSub, jobId])).rows || [])[0] || {};
  const counts = ['jobs', 'exports', 'published'].map((key) => (row[key] === null || row[key] === undefined ? NaN : Number(row[key])));
  if (!counts.every(Number.isInteger)) throw new Error(`the vids residue read for ${jobId} returned no counts`);
  const artifactId = UUID_RE.test(String(row.artifact_id)) ? String(row.artifact_id) : null;
  return { jobs: counts[0], exports: counts[1], published: counts[2], artifactId };
}

/**
 * @description Upload this run's MP4 to the job as the owner, then read the export's identity back.
 * @param {object} ports - upload, sql, files, ownerSub.
 * @param {object} fixture - The run's fixture (jobId, video); gains artifactId and exportKey (its ledger id).
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<string[]>} Problems (empty when attached as uploaded and visible on disk).
 */
async function attachExport(ports, fixture, ledger) {
  const res = await ports.upload(exportPath(fixture.jobId), {}, { name: 'video.mp4', type: 'video/mp4', bytes: fixture.video.bytes });
  const artifact = res.json.artifact || null;
  if (res.status !== 201 || !artifact) return [`the owner's attach answered HTTP ${res.status} (${res.json.error || 'no artifact'})`];
  fixture.artifactId = (await readResidue(ports, fixture.jobId)).artifactId;
  fixture.exportKey = fixture.artifactId || fixture.jobId;
  ledger.created('vids-export', fixture.exportKey);
  const problems = [];
  if (!fixture.artifactId) problems.push('the attach answered 201 but no export row holds an artifact id');
  if (artifact.sha256 !== fixture.video.sha256 || Number(artifact.byteLength) !== fixture.video.byteLength) {
    problems.push(`the attached export reports ${artifact.byteLength} bytes with sha256 ${artifact.sha256}, not the ${fixture.video.byteLength} uploaded bytes`);
  }
  if (artifact.publicUrl !== null) problems.push('the export had a public link before any publish');
  if (fixture.artifactId && (await ports.files.state(FILE_PROBE, fixture.artifactId)) !== 'present') {
    problems.push(`the ${FILE_PROBE} probe does not see export ${fixture.artifactId} on disk, so its removal could not be proven`);
  }
  return problems;
}

/**
 * @description Whether a reply is the mount's own sign-in refusal: the requiresAuth gate the loader puts
 * in front of an `auth: service-or-oidc` mount (OIDC and LOCAL_AUTH answer the same body). The vids
 * routers also refuse a caller without identity (401 user_identity_required), so a bare 401 would still
 * pass if the mount lost its gate; the body tells the two apart.
 * @param {{status: number, json: object}} res - A reply to an unauthenticated request.
 * @returns {boolean} True for the mount gate's 401.
 */
function mountRefused(res) {
  return res.status === 401 && res.json.authenticated === false && res.json.error === 'unauthorized';
}

/**
 * @description One unauthenticated refusal, judged: 401 from the mount gate, else what answered.
 * @param {{status: number, json: object}} res - The reply.
 * @param {string} what - The request, in words.
 * @returns {string|null} The problem, or null for the mount gate's 401.
 */
function refusalProblem(res, what) {
  if (mountRefused(res)) return null;
  if (res.status === 401) return `${what} answered 401 ${res.json.error || ''} from the package's own guard, not the mount's sign-in gate (the ${BASE} mount is not authenticated)`;
  return `${what} answered HTTP ${res.status}, not 401`;
}

/**
 * @description Unauthenticated callers: the job list and a confirmed publish of the run's job (with the
 * right digest) must each be refused 401 by the package mount's sign-in gate, and nothing may become public.
 * @param {object} ports - api, anonymous.
 * @param {object} fixture - jobId, video.
 * @returns {Promise<{problems: string[], evidence: object}>} Problems and the refusals seen.
 */
async function anonymousRefusals(ports, fixture) {
  const jobs = await ports.anonymous('GET', `${BASE}/jobs`);
  const control = await ports.anonymous('POST', `${exportPath(fixture.jobId)}/publish`, { confirm: true, sha256: fixture.video.sha256 });
  const after = await ports.api('GET', exportPath(fixture.jobId));
  const publicUrl = after.json.artifact ? after.json.artifact.publicUrl : undefined;
  const problems = [refusalProblem(jobs, `an unauthenticated GET ${BASE}/jobs`),
    refusalProblem(control, 'an unauthenticated confirmed publish of the job')].filter(Boolean);
  if (after.status !== 200 || publicUrl !== null) {
    problems.push(`after the unauthenticated publish the owner's export read answered HTTP ${after.status} with publicUrl ${publicUrl === undefined ? 'missing' : 'set'}`);
  }
  const seen = (res) => ({ status: res.status, error: typeof res.json.error === 'string' ? res.json.error : null });
  return { problems, evidence: { jobs: seen(jobs), control: seen(control) } };
}

/**
 * @description The owner's confirmed publish with the reviewed digest.
 * @param {object} ports - api.
 * @param {object} fixture - jobId, video.
 * @returns {Promise<{token: string|null, problem: string|null}>} The public token, or why not.
 */
async function publishExport(ports, fixture) {
  const res = await ports.api('POST', `${exportPath(fixture.jobId)}/publish`, { confirm: true, sha256: fixture.video.sha256 });
  const url = res.json.artifact ? res.json.artifact.publicUrl : null;
  const match = typeof url === 'string' ? PUBLIC_URL_RE.exec(url) : null;
  if (res.status === 200 && match) return { token: match[1], problem: null };
  return { token: null, problem: `the owner's confirmed publish answered HTTP ${res.status} (${res.json.error || 'no public link'})` };
}

/**
 * @description While published: the anonymous read returns exactly the uploaded bytes as video/mp4, and
 * a malformed token (the live token less one character) answers 404.
 * @param {object} ports - anonymous.
 * @param {string} token - The live token.
 * @param {object} video - The uploaded bytes' digest and length.
 * @returns {Promise<{problems: string[], evidence: object}>} Problems and what was read.
 */
async function publicReads(ports, token, video) {
  const read = await ports.anonymous('GET', publicPath(token));
  const malformed = await ports.anonymous('GET', publicPath(token.slice(0, 63)));
  const exact = read.status === 200 && read.sha256 === video.sha256 && read.byteLength === video.byteLength;
  const problems = [];
  if (read.status !== 200) problems.push(`the anonymous read of the published link answered HTTP ${read.status}, not 200`);
  else if (!exact) problems.push(`the anonymous read returned ${read.byteLength} bytes with sha256 ${read.sha256}, not the ${video.byteLength} uploaded bytes`);
  else if (!/^video\/mp4\b/.test(read.contentType)) problems.push(`the anonymous read was served as ${read.contentType || 'no content type'}, not video/mp4`);
  if (malformed.status !== 404) problems.push(`an anonymous read with a malformed token answered HTTP ${malformed.status}, not 404`);
  return { problems, evidence: { publicStatus: read.status, exactBytes: exact, byteLength: read.byteLength, malformedStatus: malformed.status } };
}

/**
 * @description The owner revokes; the same anonymous read must then answer 404.
 * @param {object} ports - api, anonymous.
 * @param {object} fixture - jobId.
 * @param {string} token - The token that was live.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<{problems: string[], evidence: object}>} Problems and the status after revoke.
 */
async function revokeExport(ports, fixture, token, ledger) {
  const res = await ports.api('POST', `${exportPath(fixture.jobId)}/unpublish`, { confirm: true });
  const revoked = res.status === 200 && Boolean(res.json.artifact) && res.json.artifact.publicUrl === null;
  if (revoked) ledger.removed('vids-publication', fixture.jobId);
  const after = await ports.anonymous('GET', publicPath(token));
  const problems = [];
  if (!revoked) problems.push(`the owner's confirmed revoke answered HTTP ${res.status} (${res.json.error || 'the link is still set'})`);
  if (after.status !== 404) problems.push(`after the revoke the anonymous read answered HTTP ${after.status}, not 404`);
  return { problems, evidence: { afterRevokeStatus: after.status } };
}

/**
 * @description The published half: publish, read anonymously, probe a malformed token, revoke, read again.
 * @param {object} ports - api, anonymous.
 * @param {object} fixture - jobId, video.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<{problems: string[], evidence: object}>} Problems and evidence.
 */
async function publicationCycle(ports, fixture, ledger) {
  const published = await publishExport(ports, fixture);
  if (!published.token) return { problems: [published.problem], evidence: {} };
  ledger.created('vids-publication', fixture.jobId);
  const reads = await publicReads(ports, published.token, fixture.video);
  const revoke = await revokeExport(ports, fixture, published.token, ledger);
  return { problems: [...reads.problems, ...revoke.problems], evidence: { ...reads.evidence, ...revoke.evidence } };
}

/**
 * @description The case body once the package is present: job, attach, anonymous refusals, publication.
 * @param {object} ports - api, anonymous, upload, sql, files, ownerSub.
 * @param {object} fixture - tag, video; gains jobId and artifactId.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<{verdict: {state: string, detail: string}, evidence: object}>} The verdict.
 */
async function exercise(ports, fixture, ledger) {
  const rows = (await ports.sql('vids.done-job-insert', [ports.ownerSub, fixture.tag])).rows || [];
  fixture.jobId = rows[0] && UUID_RE.test(String(rows[0].job_id)) ? String(rows[0].job_id) : null;
  if (!fixture.jobId) return { verdict: { state: 'fail', detail: 'The tagged finished-job insert returned no job id.' }, evidence: {} };
  ledger.created('vids-job', fixture.jobId);
  const evidence = { jobId: fixture.jobId, uploaded: { byteLength: fixture.video.byteLength, sha256: fixture.video.sha256 } };
  const attached = await attachExport(ports, fixture, ledger);
  evidence.artifactId = fixture.artifactId || null;
  if (attached.length && !fixture.artifactId) return { verdict: { state: 'fail', detail: `${attached.join('; ')}.` }, evidence };
  const refusals = await anonymousRefusals(ports, fixture);
  const cycle = await publicationCycle(ports, fixture, ledger);
  Object.assign(evidence, { anonymous: refusals.evidence }, cycle.evidence);
  const problems = [...attached, ...refusals.problems, ...cycle.problems];
  if (problems.length) return { verdict: { state: 'fail', detail: `${problems.join('; ')}.` }, evidence };
  return { verdict: { state: 'pass', detail: `Job ${fixture.jobId}: the ${BASE} mount's sign-in gate refused an unauthenticated GET ${BASE}/jobs `
    + 'and an unauthenticated confirmed publish (401 unauthorized) and nothing was published; the owner\'s reviewed publish served exactly '
    + `the ${fixture.video.byteLength} uploaded bytes anonymously as video/mp4; a malformed token and the revoked link answered 404.` }, evidence };
}

/**
 * @description Remove the export (revoke first if still public) through the package's own routes.
 * @param {object} ports - api, sql, ownerSub.
 * @param {object} fixture - jobId, artifactId, exportKey.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<void>} Resolves when recorded.
 */
async function removeExport(ports, fixture, ledger) {
  await ledger.attempt(`vids export of job ${fixture.jobId} removal`, async () => {
    const before = await readResidue(ports, fixture.jobId);
    fixture.artifactId = fixture.artifactId || before.artifactId;
    if (before.published) {
      const res = await ports.api('POST', `${exportPath(fixture.jobId)}/unpublish`, { confirm: true });
      if (res.status !== 200) return `the cleanup revoke of job ${fixture.jobId} answered HTTP ${res.status}`;
      ledger.removed('vids-publication', fixture.jobId);
    }
    if (!before.exports) return null;
    const res = await ports.api('DELETE', exportPath(fixture.jobId), { confirm: true });
    if (res.status !== 200 || res.json.removed !== true) return `DELETE ${BASE}/jobs/${fixture.jobId}/artifact answered HTTP ${res.status} (${res.json.error || 'not removed'})`;
    ledger.removed('vids-export', fixture.exportKey || fixture.artifactId || fixture.jobId);
    return null;
  });
}

/**
 * @description Delete exactly the run's tagged job and prove it, its export row and publication gone.
 * @param {object} ports - api, sql, ownerSub.
 * @param {object} fixture - jobId, tag.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<void>} Resolves when recorded.
 */
async function removeJob(ports, fixture, ledger) {
  await ledger.attempt(`vids job ${fixture.jobId} delete`, async () => {
    await ports.sql('vids.job-delete', [ports.ownerSub, fixture.jobId, fixture.tag]);
    const residue = await readResidue(ports, fixture.jobId);
    if (residue.jobs || residue.exports || residue.published) {
      return `residue for job ${fixture.jobId}: jobs=${residue.jobs}, exports=${residue.exports}, published=${residue.published}`;
    }
    const gone = await ports.api('GET', exportPath(fixture.jobId));
    if (gone.status !== 404) return `GET ${BASE}/jobs/${fixture.jobId}/artifact answered HTTP ${gone.status} after the delete, not 404`;
    ledger.removed('vids-job', fixture.jobId);
    return null;
  });
}

/**
 * @description The media residue read: the export's MP4 must be gone from disk after cleanup, whatever
 * removed (or failed to remove) its row. A row cascade alone leaves the file behind.
 * @param {object} ports - files.
 * @param {object} fixture - artifactId.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<void>} Resolves when recorded.
 */
async function checkExportFile(ports, fixture, ledger) {
  if (!fixture.artifactId) return;
  await ledger.attempt(`vids export file ${fixture.artifactId} check`, async () => {
    const state = await ports.files.state(FILE_PROBE, fixture.artifactId);
    return state === 'absent' ? null : `export file ${fixture.artifactId}.mp4 is still on disk after cleanup`;
  });
}

/**
 * @description Run the case once.
 * @param {object} ports - api, anonymous, upload, sql, files, ownerSub.
 * @returns {Promise<object>} The result with its cleanup receipt.
 */
async function run(ports) {
  const missing = common.missingPorts(ports, NEEDS);
  if (missing.length) return common.unavailable(CASE_ID, `This runner has no ${missing.join('/')} port.`);
  const installed = await probeInstalled(ports);
  if (installed.state === 'unavailable') return common.unavailable(CASE_ID, installed.detail);
  if (installed.state === 'fail') return common.finish(CASE_ID, { state: 'fail', detail: `${installed.detail} Nothing was written.` }, new common.CleanupLedger());
  const ledger = new common.CleanupLedger();
  const tag = common.mintTag(KEY);
  const fixture = { tag, video: fixtureVideo(tag), jobId: null, artifactId: null, exportKey: null };
  let outcome;
  try {
    outcome = await exercise(ports, fixture, ledger);
  } catch (error) {
    outcome = { verdict: { state: 'fail', detail: `The case crashed: ${common.errorText(error)}` }, evidence: { jobId: fixture.jobId } };
  }
  if (fixture.jobId) {
    await removeExport(ports, fixture, ledger);
    await removeJob(ports, fixture, ledger);
    await checkExportFile(ports, fixture, ledger);
  }
  return common.finish(CASE_ID, outcome.verdict, ledger, { tag, ...outcome.evidence });
}

module.exports = { CASE_ID, KEY, TITLE, NEEDS, FILE_PROBE, FIXTURE_MP4, fixtureVideo, probeInstalled, run };
