/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the PNG reader and writer the live-acceptance cases compare pixels with (first user: live-acceptance-create-region-edit.js, which must prove that a region edit left every pixel outside the region byte for byte). Node built-ins only (zlib), like every case module, so the api image and the host runner carry it without an image library. It writes 8-bit RGBA and reads 8-bit grey, grey+alpha, RGB and RGBA, non-interlaced, which is what the Create package stores after its own normalization. Anything else is refused by name instead of being compared wrongly: a palette, 16-bit or interlaced file, a chunk whose checksum does not match, a body that inflates to the wrong length, an image above the pixel ceiling.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Refuse tRNS transparency explicitly rather than silently widening RGB/grey samples to opaque RGBA. Check the header first so unsupported palette/depth errors retain their own explanation.
 */

'use strict';

const zlib = require('node:zlib');

/** The eight bytes every PNG starts with. */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Samples per pixel for each colour type this reader accepts (palette, type 3, is refused). */
const CHANNELS = Object.freeze({ 0: 1, 2: 3, 4: 2, 6: 4 });
/** The largest image the reader decodes: 4 megapixels is 16 MiB of RGBA. */
const MAX_PIXELS = 4_194_304;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * @description The CRC-32 a PNG chunk carries (over its type and data). Computed here because
 * zlib.crc32 is absent from the Node 20 line the api image runs.
 * @param {Buffer} bytes - The bytes to sum.
 * @returns {number} The unsigned 32-bit checksum.
 */
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @description One PNG chunk: length, type, data, checksum.
 * @param {string} type - The four-letter chunk type.
 * @param {Buffer} data - The chunk body.
 * @returns {Buffer} The encoded chunk.
 */
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, sum]);
}

/**
 * @description Encode RGBA pixels as an 8-bit truecolour-with-alpha PNG (filter 0 on every row).
 * @param {number} width - Pixels across.
 * @param {number} height - Pixels down.
 * @param {Buffer} rgba - width x height x 4 bytes, row by row.
 * @returns {Buffer} The PNG file.
 * @throws {Error} When the dimensions and the pixel buffer disagree.
 */
function encodeRgba(width, height, rgba) {
  const sized = Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width * height <= MAX_PIXELS;
  if (!sized || !Buffer.isBuffer(rgba) || rgba.length !== width * height * 4) throw new Error('PNG encode: the pixel buffer does not match the dimensions');
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const stride = width * 4;
  const rows = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) rgba.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * @description Walk a PNG's chunks, checking each checksum, and return its header and image data.
 * @param {Buffer} png - The file.
 * @returns {{header: Buffer, data: Buffer, transparency: boolean}} The IHDR/IDAT bodies and whether tRNS is present.
 * @throws {Error} For a missing signature, a truncated or corrupt chunk, or a file with no header, data or end.
 */
function readChunks(png) {
  if (!Buffer.isBuffer(png) || png.length < 8 || !png.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG (signature missing)');
  let header = null;
  let ended = false;
  let transparency = false;
  const data = [];
  for (let at = 8; at < png.length && !ended;) {
    if (at + 12 > png.length) throw new Error('PNG truncated inside a chunk');
    const length = png.readUInt32BE(at);
    const end = at + 12 + length;
    if (end > png.length) throw new Error('PNG truncated inside a chunk');
    const type = png.toString('ascii', at + 4, at + 8);
    if (crc32(png.subarray(at + 4, end - 4)) !== png.readUInt32BE(end - 4)) throw new Error(`PNG chunk ${type} fails its checksum`);
    if (type === 'IHDR') header = png.subarray(at + 8, end - 4);
    else if (type === 'IDAT') data.push(png.subarray(at + 8, end - 4));
    else if (type === 'IEND') ended = true;
    else if (type === 'tRNS') transparency = true;
    at = end;
  }
  if (!header || header.length !== 13 || !data.length || !ended) throw new Error('PNG has no header, image data or end chunk');
  return { header, data: Buffer.concat(data), transparency };
}

/**
 * @description The shape a PNG header declares, refused unless this reader decodes it exactly.
 * @param {Buffer} header - The 13-byte IHDR body.
 * @returns {{width: number, height: number, channels: number}} Dimensions and samples per pixel.
 * @throws {Error} Naming the colour type, bit depth and interlace of a file it does not decode.
 */
function readHeader(header) {
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const [depth, colour, compression, filter, interlace] = header.subarray(8, 13);
  const channels = CHANNELS[colour];
  if (!channels || depth !== 8 || compression !== 0 || filter !== 0 || interlace !== 0) {
    throw new Error(`unsupported PNG (colour type ${colour}, bit depth ${depth}, interlace ${interlace})`);
  }
  if (!width || !height || width * height > MAX_PIXELS) throw new Error(`PNG of ${width} x ${height} is outside the ${MAX_PIXELS}-pixel ceiling`);
  return { width, height, channels };
}

/**
 * @description The Paeth predictor of the PNG specification.
 * @param {number} a - The sample to the left.
 * @param {number} b - The sample above.
 * @param {number} c - The sample above and to the left.
 * @returns {number} Whichever of the three is closest to a + b - c.
 */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * @description Undo one row's filter in place.
 * @param {number} type - The row's filter type (0 to 4).
 * @param {Buffer} row - The filtered row; holds the samples afterwards.
 * @param {Buffer|null} above - The reconstructed row above, or null for the first row.
 * @param {number} bpp - Bytes per pixel.
 * @returns {void}
 * @throws {Error} For a filter type outside the specification.
 */
function unfilterRow(type, row, above, bpp) {
  if (type < 0 || type > 4) throw new Error(`PNG row uses unknown filter ${type}`);
  if (type === 0) return;
  for (let i = 0; i < row.length; i++) {
    const left = i >= bpp ? row[i - bpp] : 0;
    const up = above ? above[i] : 0;
    const corner = above && i >= bpp ? above[i - bpp] : 0;
    const predicted = type === 1 ? left : type === 2 ? up : type === 3 ? (left + up) >> 1 : paeth(left, up, corner);
    row[i] = (row[i] + predicted) & 0xff;
  }
}

/**
 * @description Widen one reconstructed row to RGBA.
 * @param {Buffer} row - The row's samples.
 * @param {number} channels - Samples per pixel in the file (1, 2, 3 or 4).
 * @param {Buffer} out - The RGBA image being filled.
 * @param {number} at - Where this row starts in `out`.
 * @returns {void}
 */
function widenRow(row, channels, out, at) {
  if (channels === 4) { row.copy(out, at); return; }
  const grey = channels < 3;
  for (let x = 0, o = at; x < row.length; x += channels, o += 4) {
    out[o] = row[x];
    out[o + 1] = grey ? row[x] : row[x + 1];
    out[o + 2] = grey ? row[x] : row[x + 2];
    out[o + 3] = channels === 2 ? row[x + 1] : 255;
  }
}

/**
 * @description Decode a PNG to RGBA pixels.
 * @param {Buffer} png - The file.
 * @returns {{width: number, height: number, data: Buffer}} The pixels, width x height x 4 bytes, row by row.
 * @throws {Error} Naming why the file cannot be decoded exactly; nothing is ever guessed.
 */
function decodeRgba(png) {
  const chunks = readChunks(png);
  const { width, height, channels } = readHeader(chunks.header);
  if (chunks.transparency) throw new Error('unsupported PNG (tRNS transparency)');
  const stride = width * channels;
  const expected = height * (stride + 1);
  const rows = zlib.inflateSync(chunks.data, { maxOutputLength: expected });
  if (rows.length !== expected) throw new Error(`PNG image data inflates to ${rows.length} bytes, not the ${expected} its header declares`);
  const data = Buffer.alloc(width * height * 4);
  let above = null;
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const row = rows.subarray(start + 1, start + 1 + stride);
    unfilterRow(rows[start], row, above, channels);
    widenRow(row, channels, data, y * width * 4);
    above = row;
  }
  return { width, height, data };
}

module.exports = { SIGNATURE, MAX_PIXELS, crc32, encodeRgba, decodeRgba };
