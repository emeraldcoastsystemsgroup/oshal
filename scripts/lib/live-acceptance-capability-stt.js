/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Live acceptance for ADR-173 S1 (the "Done when (live)" of slice S1, and the D12 move it gates). As the operator: (1) the capability listing must answer and offer local-stt; (2) a clip of a known sentence is spoken by the swarm's own text-to-speech default (one short synthesis, refused unless that provider is free or the runner was given --allow-paid); (3) the clip must transcribe through local-stt itself, named explicitly, with every word of the sentence — nothing moves if it does not; (4) ONE operator write makes local-stt the swarm STT default, with no restart; (5) the next dictation through /api/voice/transcribe, the route Jarvis dictation uses, must answer from local-stt with rung swarm-default; (6) the api's own resolution log line must name capability stt, local-stt and the rung swarm-default (host runner only: it reads the api container's log). The row the case writes is the decided end state (D12) and is KEPT on a pass; on any failure after the write the previous swarm STT default (a row, or none) is put back and read back.
 */

'use strict';

const common = require('./live-acceptance-common.js');

const CASE_ID = 'capability-stt-local-live';
const KEY = 'capability-stt';
const TITLE = 'Speech to text: a clip transcribes through local-stt, one operator write makes it the swarm default, and the next dictation names local-stt at the swarm-default rung';
const NEEDS = Object.freeze(['api', 'upload']);
/** The sentence the clip speaks: plain words, no digits, so any recognizer writes it the same way. */
const PHRASE = 'the quick brown fox jumps over the lazy dog';
const BASE = '/api/capability-providers';
/** The suites that guard the seams this case crosses live. */
const REGRESSION_TESTS = Object.freeze(['capability-swarm-rows-postgres', 'capability-resolution', 'capability-options-agree', 'capability-provider-routes',
  'capability-principal-guard', 'voice-stt-failover', 'local-stt-provider']
  .map((name) => Object.freeze({ level: name.endsWith('-postgres') ? 'integration' : 'unit', path: `tests/unit/${name}.spec.ts` })));

/**
 * @description The words of a transcript, lowercased, punctuation gone.
 * @param {unknown} text - A transcript.
 * @returns {string[]} The words.
 */
function wordsOf(text) {
  return String(text || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
}

/**
 * @description Whether a transcript carries every word of the sentence.
 * @param {unknown} text - The transcript.
 * @returns {string[]} The words it is missing (none = heard).
 */
function missingWords(text) {
  const heard = new Set(wordsOf(text));
  return [...new Set(wordsOf(PHRASE))].filter((word) => !heard.has(word));
}

/**
 * @description One capability's section of the operator listing.
 * @param {object} listing - GET /api/capability-providers JSON.
 * @param {string} capability - tts or stt.
 * @returns {object|null} The section.
 */
function section(listing, capability) {
  const sections = Array.isArray(listing && listing.capabilities) ? listing.capabilities : [];
  return sections.find((s) => s && s.capability === capability) || null;
}

/**
 * @description Read the listing and decide whether this box can run the case at all.
 * @param {object} ports - api.
 * @returns {Promise<{refusal: string}|{stt: object, tts: object}>} The two sections, or why not.
 */
async function preconditions(ports) {
  const res = await ports.api('GET', BASE);
  if (res.status === 404) return { refusal: 'The capability provider routes are not on this build (ADR-173 S1 is not deployed).' };
  if (res.status === 403 || res.status === 401) return { refusal: `GET ${BASE} answered HTTP ${res.status}: the runner's token does not belong to an operator.` };
  if (res.status !== 200) return { refusal: `GET ${BASE} answered HTTP ${res.status}.` };
  const stt = section(res.json, 'stt');
  const tts = section(res.json, 'tts');
  if (!stt || !tts) return { refusal: 'The capability listing carries no stt or tts section.' };
  return { stt, tts };
}

/**
 * @description Speak the sentence through the swarm's own text-to-speech default, as the operator.
 * A provider that is not free needs the runner's --allow-paid (one short synthesis).
 * @param {object} ports - api.
 * @param {object} tts - The tts section.
 * @param {{allowPaid?: boolean}} options - Runner options.
 * @returns {Promise<{gap: string}|{clip: {bytes: Buffer, type: string}, provider: string}>} The clip, or why not.
 */
async function speakClip(ports, tts, options) {
  const providerId = tts.swarmDefault && tts.swarmDefault.providerId;
  const offer = (Array.isArray(tts.providers) ? tts.providers : []).find((p) => p.providerId === providerId);
  if (!offer || !offer.available) return { gap: `the swarm text-to-speech default (${providerId || 'none'}) cannot speak the clip: ${offer ? offer.detail : 'not listed'}` };
  if (offer.costClass !== 'free' && options.allowPaid !== true) {
    return { gap: `the clip is spoken by the swarm text-to-speech default ${providerId} (${offer.costClass}): run node scripts/operations/live-acceptance.js ${KEY} --allow-paid to spend one ${PHRASE.length}-character synthesis` };
  }
  const res = await ports.api('POST', '/api/voice/synthesize', { text: PHRASE });
  const data = (res.json && res.json.data) || {};
  if (res.status !== 200 || !data.audioData) return { gap: `the swarm text-to-speech default answered no audio (HTTP ${res.status}${data.fallback ? `, ${data.fallback}: ${data.message || ''}` : ''})` };
  const format = String(data.format || 'audio/mpeg');
  return { clip: { bytes: Buffer.from(String(data.audioData), 'base64'), type: format.includes('/') ? format : `audio/${format}` }, provider: data.providerId || providerId };
}

/**
 * @description Upload the clip to one route as multipart field `audio`.
 * @param {object} ports - upload.
 * @param {string} route - The route.
 * @param {{bytes: Buffer, type: string}} clip - The clip.
 * @returns {Promise<{status: number, json: object}>} The reply.
 */
function sendClip(ports, route, clip) {
  const extension = clip.type.includes('wav') ? 'wav' : clip.type.includes('ogg') ? 'ogg' : 'mp3';
  return ports.upload(route, {}, { field: 'audio', name: `capability-stt-clip.${extension}`, type: clip.type, bytes: clip.bytes });
}

/**
 * @description Judge one transcription answer.
 * @param {string} label - Which leg.
 * @param {{status: number, json: object}} res - The reply.
 * @param {(body: object) => object} pick - Where the result sits in the body.
 * @param {string|null} rung - The rung the answer must name, if any.
 * @returns {{ok: boolean, detail: string}} The judgement.
 */
function judgeTranscript(label, res, pick, rung) {
  const body = pick(res.json || {}) || {};
  if (res.status !== 200) return { ok: false, detail: `${label} answered HTTP ${res.status}` };
  if (body.providerId !== 'local-stt') return { ok: false, detail: `${label} was answered by ${body.providerId || 'nothing'} (${body.fallback || 'no fallback'}: ${body.message || ''}), not local-stt` };
  if (rung && body.rung !== rung) return { ok: false, detail: `${label} named the rung ${body.rung || 'none'}, not ${rung}` };
  const missing = missingWords(body.text);
  if (missing.length) return { ok: false, detail: `${label} heard "${String(body.text || '').slice(0, 120)}", missing ${missing.join(', ')}` };
  return { ok: true, detail: `${label}: local-stt heard "${String(body.text).slice(0, 120)}"${rung ? ` at rung ${body.rung}` : ''}` };
}

/**
 * @description The log leg: the api's resolution line for the dictation names stt, local-stt and swarm-default.
 * @param {object} ports - apiLogs (host runner only).
 * @param {string} since - ISO time before the dictation.
 * @returns {Promise<{state: 'pass'|'fail'|'gap', detail: string}>} The leg.
 */
async function logLeg(ports, since) {
  if (typeof ports.apiLogs !== 'function') return { state: 'gap', detail: 'the resolution log line is read from the api container by the host runner only' };
  const lines = await ports.apiLogs(since);
  const hit = lines.map((line) => { try { return JSON.parse(line.slice(line.indexOf('{'))); } catch { return null; } })
    .find((entry) => entry && entry.msg === 'capability provider resolved' && entry.capability === 'stt' && entry.providerId === 'local-stt');
  if (!hit) return { state: 'fail', detail: 'no "capability provider resolved" line for stt/local-stt since the dictation' };
  return hit.rung === 'swarm-default' ? { state: 'pass', detail: `log line: capability stt, local-stt, rung ${hit.rung}` }
    : { state: 'fail', detail: `the log line names the rung ${hit.rung}, not swarm-default` };
}

/**
 * @description Put the previous swarm STT default back (a row, or none) and read it back.
 * @param {object} ports - api.
 * @param {object|null} previous - The row before the write, or null.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<void>} Resolves when recorded.
 */
async function restoreSwarmStt(ports, previous, ledger) {
  await ledger.attempt('swarm STT default restore', async () => {
    const res = previous
      ? await ports.api('PUT', `${BASE}/swarm/stt`, { providerId: previous.providerId })
      : await ports.api('DELETE', `${BASE}/swarm/stt`);
    if (res.status !== 200) return `restoring the swarm STT default answered HTTP ${res.status}`;
    const after = await preconditions(ports);
    const now = after.stt && after.stt.swarmDefault;
    if (!now || (previous ? now.source !== 'row' || now.providerId !== previous.providerId : now.source === 'row')) return 'the swarm STT default did not read back as it was';
    ledger.removed('swarm-stt-row', 'local-stt');
    return null;
  });
}

/**
 * @description Steps 3 to 6 once the clip exists: prove local-stt, write the row, dictate, read the log.
 * @param {object} ports - api, upload, apiLogs.
 * @param {object} stt - The stt section before the write.
 * @param {{bytes: Buffer, type: string}} clip - The clip.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<{state: string, detail: string, evidence: object}>} The verdict.
 */
async function proveAndMove(ports, stt, clip, ledger) {
  const tried = judgeTranscript('local-stt on the clip', await sendClip(ports, `${BASE}/stt/local-stt/try`, clip), (b) => b, null);
  if (!tried.ok) return { state: 'fail', detail: `${tried.detail}; the swarm STT default was NOT moved`, evidence: { tried: tried.detail } };
  const previous = stt.swarmDefault && stt.swarmDefault.source === 'row' ? stt.swarmDefault.row : null;
  const alreadyLocal = previous && previous.providerId === 'local-stt';
  if (!alreadyLocal) {
    const put = await ports.api('PUT', `${BASE}/swarm/stt`, { providerId: 'local-stt' });
    if (put.status !== 200) return { state: 'fail', detail: `the operator write answered HTTP ${put.status}`, evidence: { tried: tried.detail } };
    ledger.created('swarm-stt-row', 'local-stt', `was ${previous ? previous.providerId : 'the seed'}`);
  }
  const since = new Date(Date.now() - 2_000).toISOString();
  const dictated = judgeTranscript('the next dictation', await sendClip(ports, '/api/voice/transcribe', clip), (b) => b.data, 'swarm-default');
  const logged = dictated.ok ? await logLeg(ports, since) : { state: 'fail', detail: 'not read: the dictation failed' };
  const passed = dictated.ok && logged.state !== 'fail';
  if (!passed && !alreadyLocal) await restoreSwarmStt(ports, previous, ledger);
  if (passed) ledger.kept('swarm-stt-row', 'local-stt', 'ADR-173 D12: the decided swarm STT default; DELETE /api/capability-providers/swarm/stt returns to the seed');
  const state = !passed ? 'fail' : logged.state === 'gap' ? 'degraded' : 'pass';
  return { state, detail: `${tried.detail}; ${alreadyLocal ? 'the swarm STT default was already local-stt' : 'one operator write made local-stt the swarm STT default'}; ${dictated.detail}; ${logged.detail}`,
    evidence: { tried: tried.detail, dictated: dictated.detail, log: logged.detail, previous: previous ? previous.providerId : null } };
}

/**
 * @description Run the case once.
 * @param {object} ports - api, upload, and (host runner) apiLogs.
 * @param {{allowPaid?: boolean}} [options] - Runner options.
 * @returns {Promise<object>} The result with its cleanup receipt.
 */
async function run(ports, options = {}) {
  const missing = common.missingPorts(ports, NEEDS);
  if (missing.length) return common.unavailable(CASE_ID, `This runner has no ${missing.join('/')} port.`);
  const ready = await preconditions(ports);
  if (ready.refusal) return common.unavailable(CASE_ID, ready.refusal);
  const local = (Array.isArray(ready.stt.providers) ? ready.stt.providers : []).find((p) => p.providerId === 'local-stt');
  if (!local || !local.available) return common.finish(CASE_ID, { state: 'fail', detail: `local-stt is not available on this box: ${local ? local.detail : 'not registered'}. The swarm STT default was not moved.` }, new common.CleanupLedger());
  const spoken = await speakClip(ports, ready.tts, options);
  if (spoken.gap) return common.unavailable(CASE_ID, `No clip: ${spoken.gap}.`);
  const ledger = new common.CleanupLedger();
  let verdict;
  try {
    verdict = await proveAndMove(ports, ready.stt, spoken.clip, ledger);
  } catch (error) {
    verdict = { state: 'fail', detail: `The case crashed: ${common.errorText(error)}`, evidence: {} };
    // A crash after the write must not leave the default moved: put the previous one back.
    if (ledger.outstanding().some((item) => item.kind === 'swarm-stt-row')) {
      const before = ready.stt.swarmDefault && ready.stt.swarmDefault.source === 'row' ? ready.stt.swarmDefault.row : null;
      await restoreSwarmStt(ports, before, ledger);
    }
  }
  return common.finish(CASE_ID, { state: verdict.state, detail: `${verdict.detail}.` }, ledger, { ...verdict.evidence, clipSpokenBy: spoken.provider, clipBytes: spoken.clip.bytes.length });
}

module.exports = { CASE_ID, KEY, TITLE, NEEDS, PHRASE, REGRESSION_TESTS, missingWords, judgeTranscript, logLeg, run };
