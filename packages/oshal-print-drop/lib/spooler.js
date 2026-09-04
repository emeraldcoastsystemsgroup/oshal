/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — streams a print job's document data to the drop folder. Security posture: the job name is attacker-controlled network input, so it is sanitized to a safe character class and NEVER used as a path component uninspected; documents write to a dot-prefixed .part file and rename atomically so folder watchers only ever see complete files; a byte cap aborts oversized jobs (drain up to 2× the cap, then hard-destroy so a malicious endless stream cannot hold the socket). File extension comes from the declared MIME format, falling back to magic-byte sniffing (%PDF / %!PS / RaS2), never from the client-supplied name. A sidecar .json records job metadata for the later swarm-adoption phase.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Deterministic .part cleanup on abort. The discard/fail paths issued fs.rm while the write stream could still hold the handle — on Windows that delete silently fails (EBUSY) and a .part is left behind (caught by the byte-cap selftest going intermittently red). Cleanup now waits for the stream's close event and completes BEFORE the promise rejects, so the caller's error response is only sent once the folder is clean.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Versioned, transport-neutral sidecar schema, and no more doubled extensions. The sidecar is the hand-off record the swarm-adoption phase will ingest, so it now emits a fixed key set (empty string when a field is genuinely unknown, never omitted) plus the fields that identify a job's provenance: the originating computer, the document name, which transport delivered it (ipp | wsd) and which printer instance received it. sidecarVersion makes a later schema change detectable by a consumer instead of silently mis-parsed. Separately, a job named "Report.pdf" printed to PDF produced "Report.pdf.pdf" — a trailing extension identical to the chosen one is now dropped, and only that exact case, so "Report.docx" printed to PDF still records both.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Companion `.txt` for jobs that arrive with a text layer (XPS today). Measured on two real Windows jobs: the PDF the Microsoft IPP Class Driver produces is a raster wrapper with zero extractable characters, so a printed document routed to a corpus through PDF would need OCR; the same document sent as XPS carries its characters and extracts exactly. Writing the text here — after the atomic rename, so a watcher never sees a half-written pair — means the consumer needs no parser at all. `textFile`/`textCharacters`/`textPages` land in the sidecar on success and `textError` on a document with no text layer; neither is ever fatal to saving the document itself.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { extractXpsText } = require('./xps-text');

const EXTENSION_BY_FORMAT = {
  'application/pdf': 'pdf',
  'application/postscript': 'ps',
  'image/pwg-raster': 'pwg',
  'image/urf': 'urf',
  'application/vnd.ms-xpsdocument': 'xps',
  'application/oxps': 'xps',
};

/**
 * @description Reduce a client-supplied job name to a filesystem-safe fragment:
 * whitelist [A-Za-z0-9._ -], collapse runs, trim dots/spaces, cap at 80 chars.
 * @param {string} jobName The raw job-name attribute value.
 * @returns {string} A safe fragment, 'untitled' when nothing survives.
 */
function sanitizeJobName(jobName) {
  const cleaned = String(jobName || '')
    .replace(/[^A-Za-z0-9._ -]+/g, ' ')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 80);
  return cleaned || 'untitled';
}

/**
 * @description Pick a file extension: declared MIME format first, then magic-byte
 * sniffing of the first bytes, then a neutral .bin.
 * @param {string} format The declared document-format MIME type.
 * @param {Buffer} firstBytes The first bytes of the document.
 * @returns {string} The extension without a leading dot.
 */
function chooseExtension(format, firstBytes) {
  const declared = EXTENSION_BY_FORMAT[String(format || '').toLowerCase()];
  if (declared) return declared;
  const head = firstBytes.toString('latin1');
  if (head.startsWith('%PDF')) return 'pdf';
  if (head.startsWith('%!PS')) return 'ps';
  if (head.startsWith('RaS2')) return 'pwg';
  if (head.startsWith('PK')) return 'xps';
  return 'bin';
}

/**
 * @description Drop a trailing extension that duplicates the one being applied,
 * so a job named "Report.pdf" saved as PDF becomes "Report.pdf" rather than
 * "Report.pdf.pdf". A DIFFERENT trailing extension is kept — "Report.docx"
 * printed to PDF is genuinely a docx rendered to PDF and the name should say so.
 * @param {string} base The sanitized filename base.
 * @param {string} extension The extension about to be applied, no leading dot.
 * @returns {string} The base with a redundant extension removed.
 */
function stripRedundantExtension(base, extension) {
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return base;
  if (base.slice(dot + 1).toLowerCase() !== String(extension).toLowerCase()) return base;
  return base.slice(0, dot) || base;
}

/**
 * @description Local-time stamp for filenames: YYYYMMDD-HHMMSS.
 * @param {Date} when The moment to format.
 * @returns {string} The stamp.
 */
function buildStamp(when) {
  const pad = (n, w) => String(n).padStart(w || 2, '0');
  return (
    `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}` +
    `-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`
  );
}

/**
 * @description Find a non-colliding path by suffixing -2, -3, … before the extension.
 * @param {string} dir The target directory.
 * @param {string} base The filename without extension.
 * @param {string} ext The extension without a leading dot.
 * @returns {string} An absolute path that does not exist yet.
 */
function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, `${base}.${ext}`);
  for (let n = 2; fs.existsSync(candidate); n += 1) {
    candidate = path.join(dir, `${base}-${n}.${ext}`);
  }
  return candidate;
}

/**
 * @description Recover the document's text when the format carries one, and write it
 * as a companion `.txt` beside the document. XPS is the case that matters: it is what
 * Windows spools natively and it holds real characters, whereas the PDF the IPP class
 * driver produces is a page bitmap. Doing this here means a consumer gets plain text
 * with no parser, no model call and no OCR. Failure is reported, never thrown — a
 * document that has no text layer is a fact about the document, not an error.
 * @param {string} documentPath The saved document's absolute path.
 * @param {string} extension The chosen file extension.
 * @returns {{textFile:string,textCharacters:number,textPages:number}|{textError:string}|null} Sidecar fields, null when the format carries no text layer.
 */
function writeCompanionText(documentPath, extension) {
  if (extension !== 'xps') return null;
  let result;
  try {
    result = extractXpsText(fs.readFileSync(documentPath));
  } catch (err) {
    return { textError: err.message };
  }
  if (!result.ok) return { textError: result.reason };
  const textPath = `${documentPath}.txt`;
  fs.writeFileSync(textPath, result.text, 'utf8');
  return { textFile: path.basename(textPath), textCharacters: result.text.length, textPages: result.pages };
}

/**
 * @description Write the sidecar metadata JSON next to a saved document.
 * @param {string} documentPath The saved document's absolute path.
 * @param {object} meta Job metadata (id, name, user, client, format, bytes, timing).
 * @returns {string} The sidecar path.
 */
function writeSidecar(documentPath, meta) {
  const sidecarPath = `${documentPath}.json`;
  fs.writeFileSync(sidecarPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  return sidecarPath;
}

/**
 * @description Stream one document to the drop folder. Resolves with the final
 * path and byte count once the file is atomically in place; zero-byte documents
 * resolve with filePath null (nothing written). Rejects with err.code
 * 'TOO_LARGE' when the byte cap is exceeded.
 * @param {import('stream').Readable} source The document data stream.
 * @param {{jobId:number,jobName:string,userName:string,clientIp:string,format:string,documentName?:string,computerName?:string,source?:string,printerName?:string}} meta Job metadata; the optional fields are recorded in the sidecar when the transport supplies them.
 * @param {{dropDir:string,maxBytes:number}} options Spool configuration.
 * @returns {Promise<{filePath:string|null,bytes:number,extension:string|null}>} The outcome.
 */
function spoolDocument(source, meta, options) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tmpPath = path.join(options.dropDir, `.spool-${meta.jobId}-${crypto.randomBytes(4).toString('hex')}.part`);
    const out = fs.createWriteStream(tmpPath, { flags: 'wx' });
    const state = { bytes: 0, first: Buffer.alloc(0), discarding: false, settled: false };
    const removeTmp = (done) => {
      const doRemove = () => fs.rm(tmpPath, { force: true }, () => done());
      if (out.closed) doRemove();
      else {
        out.once('close', doRemove);
        out.destroy();
      }
    };
    const fail = (err) => {
      if (state.settled) return;
      state.settled = true;
      removeTmp(() => reject(err));
    };
    source.on('data', (chunk) => {
      state.bytes += chunk.length;
      if (state.first.length < 8) state.first = Buffer.concat([state.first, chunk]).slice(0, 8);
      if (!state.discarding && state.bytes > options.maxBytes) {
        state.discarding = true;
        source.unpipe(out);
        out.destroy();
      }
      if (state.bytes > options.maxBytes * 2) {
        source.destroy(Object.assign(new Error('print job exceeded twice the byte cap'), { code: 'TOO_LARGE' }));
      }
    });
    source.on('end', () => {
      if (state.discarding) fail(Object.assign(new Error('print job exceeded the byte cap'), { code: 'TOO_LARGE' }));
    });
    source.on('error', fail);
    out.on('error', (err) => {
      if (!state.discarding) fail(err);
    });
    out.on('finish', () => {
      if (state.discarding || state.settled) return;
      state.settled = true;
      try {
        resolve(finalizeSpool(tmpPath, meta, options, state, startedAt));
      } catch (err) {
        fs.rm(tmpPath, { force: true }, () => {});
        reject(err);
      }
    });
    source.pipe(out);
  });
}

/**
 * @description Move a completed .part file to its final name and write the sidecar.
 * @param {string} tmpPath The temporary spool path.
 * @param {{jobId:number,jobName:string,userName:string,clientIp:string,format:string}} meta Job metadata.
 * @param {{dropDir:string}} options Spool configuration.
 * @param {{bytes:number,first:Buffer}} state Byte count and sniffed head.
 * @param {number} startedAt Epoch ms when spooling began.
 * @returns {{filePath:string|null,bytes:number,extension:string|null}} The outcome.
 */
function finalizeSpool(tmpPath, meta, options, state, startedAt) {
  if (state.bytes === 0) {
    fs.rmSync(tmpPath, { force: true });
    return { filePath: null, bytes: 0, extension: null };
  }
  const extension = chooseExtension(meta.format, state.first);
  const named = stripRedundantExtension(sanitizeJobName(meta.jobName), extension);
  const filePath = uniquePath(options.dropDir, `${buildStamp(new Date(startedAt))}_${named}`, extension);
  fs.renameSync(tmpPath, filePath);
  const text = writeCompanionText(filePath, extension) || {};
  writeSidecar(filePath, {
    sidecarVersion: 1,
    jobId: meta.jobId,
    jobName: String(meta.jobName || ''),
    documentName: String(meta.documentName || ''),
    requestingUser: String(meta.userName || ''),
    originatingComputer: String(meta.computerName || ''),
    clientIp: meta.clientIp,
    source: String(meta.source || ''),
    printerName: String(meta.printerName || ''),
    documentFormat: String(meta.format || ''),
    fileName: path.basename(filePath),
    extension,
    bytes: state.bytes,
    receivedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    ...text,
  });
  return { filePath, bytes: state.bytes, extension, ...text };
}

module.exports = { spoolDocument, sanitizeJobName, chooseExtension };
