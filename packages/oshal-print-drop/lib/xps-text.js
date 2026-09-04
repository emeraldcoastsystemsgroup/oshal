/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — recover plain text from an XPS/OXPS print job. Measured motivation: the PDF the Microsoft IPP Class Driver produces is a RASTER wrapper (zero /Font objects, JPEG page images, not one extractable character), so a printed document reaching a corpus through PDF would need OCR. XPS is Windows' native spool format and is the opposite — a ZIP of FixedPage XML whose <Glyphs> elements carry the characters in a UnicodeString attribute — so advertising XPS instead of PDF turns the same print into searchable text with no OCR, no model call and no per-page cost. Deliberately dependency-free: a compact central-directory ZIP reader over Node's own zlib keeps this package installable with nothing but bonjour-service, and it only ever INFLATES bytes it already accepted under the byte cap. Reading order is reconstructed from each run's OriginY/OriginX rather than document order, because a FixedPage lists runs in paint order and a naive concatenation runs headings into body text.
 */
'use strict';

const zlib = require('zlib');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const MAX_COMMENT = 0xffff;
/** Same-line tolerance in XPS units; glyph runs on one line share an OriginY within a hair. */
const LINE_EPSILON = 3;

/**
 * @description Locate the ZIP end-of-central-directory record, scanning back over
 * any trailing comment.
 * @param {Buffer} buf The archive bytes.
 * @returns {number} Offset of the record, -1 when absent.
 */
function findEocd(buf) {
  const earliest = Math.max(0, buf.length - MAX_COMMENT - 22);
  for (let i = buf.length - 22; i >= earliest; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/**
 * @description Read one central-directory entry.
 * @param {Buffer} buf The archive bytes.
 * @param {number} at Offset of the entry.
 * @returns {{name:string,method:number,compressedSize:number,localOffset:number,next:number}|null} The entry, null when malformed.
 */
function readCentralEntry(buf, at) {
  if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL_SIGNATURE) return null;
  const nameLength = buf.readUInt16LE(at + 28);
  const extraLength = buf.readUInt16LE(at + 30);
  const commentLength = buf.readUInt16LE(at + 32);
  const end = at + 46 + nameLength + extraLength + commentLength;
  if (end > buf.length) return null;
  return {
    name: buf.toString('utf8', at + 46, at + 46 + nameLength),
    method: buf.readUInt16LE(at + 10),
    compressedSize: buf.readUInt32LE(at + 20),
    localOffset: buf.readUInt32LE(at + 42),
    next: end,
  };
}

/**
 * @description Inflate one entry's bytes, resolving its local header (whose extra
 * field length routinely differs from the central directory's).
 * @param {Buffer} buf The archive bytes.
 * @param {{method:number,compressedSize:number,localOffset:number}} entry The entry.
 * @returns {Buffer|null} The uncompressed bytes, null when unreadable.
 */
function inflateEntry(buf, entry) {
  const at = entry.localOffset;
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== 0x04034b50) return null;
  const nameLength = buf.readUInt16LE(at + 26);
  const extraLength = buf.readUInt16LE(at + 28);
  const start = at + 30 + nameLength + extraLength;
  const data = buf.subarray(start, start + entry.compressedSize);
  try {
    if (entry.method === 0) return Buffer.from(data);
    if (entry.method === 8) return zlib.inflateRawSync(data);
  } catch (err) {
    return null;
  }
  return null;
}

/**
 * @description List the archive's entries whose name matches a predicate.
 * @param {Buffer} buf The archive bytes.
 * @param {(name:string)=>boolean} wanted Name predicate.
 * @returns {Array<{name:string,data:Buffer}>} Matching entries with inflated bytes.
 */
function readEntries(buf, wanted) {
  const eocd = findEocd(buf);
  if (eocd < 0) return [];
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const found = [];
  for (let i = 0; i < count; i += 1) {
    const entry = readCentralEntry(buf, at);
    if (!entry) break;
    at = entry.next;
    if (!wanted(entry.name)) continue;
    const data = inflateEntry(buf, entry);
    if (data) found.push({ name: entry.name, data });
  }
  return found;
}

/**
 * @description Decode the XML entities an XPS UnicodeString may carry.
 * @param {string} value The raw attribute value.
 * @returns {string} Decoded text.
 */
function decodeXmlText(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

/**
 * @description Turn one FixedPage's glyph runs into text, grouping runs into lines
 * by their vertical origin and ordering each line left to right.
 * @param {string} xml The FixedPage XML.
 * @returns {string} The page's text.
 */
function fixedPageText(xml) {
  const runs = [];
  for (const match of xml.matchAll(/<Glyphs\b([^>]*)\/?>/g)) {
    const attrs = match[1];
    const unicode = /UnicodeString="([^"]*)"/.exec(attrs);
    if (!unicode) continue;
    const text = decodeXmlText(unicode[1]);
    if (!text.trim()) continue;
    const x = Number((/OriginX="(-?[\d.]+)"/.exec(attrs) || [])[1] || 0);
    const y = Number((/OriginY="(-?[\d.]+)"/.exec(attrs) || [])[1] || 0);
    runs.push({ x, y, text });
  }
  if (!runs.length) return '';
  runs.sort((a, b) => (Math.abs(a.y - b.y) <= LINE_EPSILON ? a.x - b.x : a.y - b.y));
  const lines = [];
  let current = null;
  for (const run of runs) {
    if (!current || Math.abs(run.y - current.y) > LINE_EPSILON) {
      current = { y: run.y, parts: [] };
      lines.push(current);
    }
    current.parts.push(run.text);
  }
  return lines.map((line) => line.parts.join('').replace(/\s+/g, ' ').trim()).join('\n');
}

/**
 * @description Extract plain text from an XPS/OXPS document. Never throws: a file
 * that is not a readable XPS, or that carries only images, returns a structured
 * failure so the caller can say so instead of writing an empty companion file.
 * @param {Buffer} buffer The document bytes.
 * @returns {{ok:true,text:string,pages:number}|{ok:false,reason:string}} The outcome.
 */
function extractXpsText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) return { ok: false, reason: 'not a readable archive' };
  if (buffer.readUInt32LE(0) !== 0x04034b50) return { ok: false, reason: 'not an XPS container (no zip header)' };
  const pages = readEntries(buffer, (name) => /\.fpage$/i.test(name))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  if (!pages.length) return { ok: false, reason: 'no FixedPage parts found in the container' };
  const text = pages.map((page) => fixedPageText(page.data.toString('utf8'))).filter(Boolean).join('\n\n').trim();
  if (!text) return { ok: false, reason: 'no text runs on any page (the document may be images only)' };
  return { ok: true, text, pages: pages.length };
}

module.exports = { extractXpsText, fixedPageText };
