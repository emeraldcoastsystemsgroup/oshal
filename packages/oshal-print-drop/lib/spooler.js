/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — streams a print job's document data to the drop folder. Security posture: the job name is attacker-controlled network input, so it is sanitized to a safe character class and NEVER used as a path component uninspected; documents write to a dot-prefixed .part file and rename atomically so folder watchers only ever see complete files; a byte cap aborts oversized jobs (drain up to 2× the cap, then hard-destroy so a malicious endless stream cannot hold the socket). File extension comes from the declared MIME format, falling back to magic-byte sniffing (%PDF / %!PS / RaS2), never from the client-supplied name. A sidecar .json records job metadata for the later swarm-adoption phase.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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
 * @param {{jobId:number,jobName:string,userName:string,clientIp:string,format:string}} meta Job metadata.
 * @param {{dropDir:string,maxBytes:number}} options Spool configuration.
 * @returns {Promise<{filePath:string|null,bytes:number,extension:string|null}>} The outcome.
 */
function spoolDocument(source, meta, options) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tmpPath = path.join(options.dropDir, `.spool-${meta.jobId}-${crypto.randomBytes(4).toString('hex')}.part`);
    const out = fs.createWriteStream(tmpPath, { flags: 'wx' });
    const state = { bytes: 0, first: Buffer.alloc(0), discarding: false, settled: false };
    const fail = (err) => {
      if (state.settled) return;
      state.settled = true;
      out.destroy();
      fs.rm(tmpPath, { force: true }, () => reject(err));
    };
    source.on('data', (chunk) => {
      state.bytes += chunk.length;
      if (state.first.length < 8) state.first = Buffer.concat([state.first, chunk]).slice(0, 8);
      if (!state.discarding && state.bytes > options.maxBytes) {
        state.discarding = true;
        source.unpipe(out);
        out.destroy();
        fs.rm(tmpPath, { force: true }, () => {});
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
  const base = `${buildStamp(new Date(startedAt))}_${sanitizeJobName(meta.jobName)}`;
  const filePath = uniquePath(options.dropDir, base, extension);
  fs.renameSync(tmpPath, filePath);
  writeSidecar(filePath, {
    jobId: meta.jobId,
    jobName: String(meta.jobName || ''),
    requestingUser: String(meta.userName || ''),
    clientIp: meta.clientIp,
    documentFormat: String(meta.format || ''),
    bytes: state.bytes,
    receivedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
  });
  return { filePath, bytes: state.bytes, extension };
}

module.exports = { spoolDocument, sanitizeJobName, chooseExtension };
