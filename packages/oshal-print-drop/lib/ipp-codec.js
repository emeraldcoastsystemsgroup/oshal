/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — binary IPP 1.1/2.0 message codec (RFC 8010). The decoder is streaming-tolerant: it returns null until the attribute section is complete, then yields the byte offset where document data begins, so the server can parse operation attributes from the first chunks of a POST and stream the (potentially huge) document body straight to disk. Collections (begCollection/memberAttrName/endCollection) parse structurally through the generic tag/name/value loop, so client-sent media-col attributes are carried without special cases. The encoder covers the value tags a virtual printer needs (integer/boolean/enum/rangeOfInteger/resolution and the string family).
 */
'use strict';

/** Attribute-group delimiter tags (RFC 8010 §3.5.1). */
const DELIMITER = {
  OPERATION_ATTRIBUTES: 0x01,
  JOB_ATTRIBUTES: 0x02,
  END_OF_ATTRIBUTES: 0x03,
  PRINTER_ATTRIBUTES: 0x04,
  UNSUPPORTED_ATTRIBUTES: 0x05,
};

/** Value tags (RFC 8010 §3.5.2). String-family tags (0x41–0x4a) decode as UTF-8. */
const VALUE = {
  NO_VALUE: 0x13,
  INTEGER: 0x21,
  BOOLEAN: 0x22,
  ENUM: 0x23,
  OCTET_STRING: 0x30,
  DATE_TIME: 0x31,
  RESOLUTION: 0x32,
  RANGE_OF_INTEGER: 0x33,
  BEG_COLLECTION: 0x34,
  TEXT_WITH_LANGUAGE: 0x35,
  NAME_WITH_LANGUAGE: 0x36,
  END_COLLECTION: 0x37,
  TEXT: 0x41,
  NAME: 0x42,
  KEYWORD: 0x44,
  URI: 0x45,
  URI_SCHEME: 0x46,
  CHARSET: 0x47,
  NATURAL_LANGUAGE: 0x48,
  MIME_MEDIA_TYPE: 0x49,
  MEMBER_ATTR_NAME: 0x4a,
};

/** Operation ids this printer understands (RFC 8011 §5.4.15). */
const OPERATION = {
  PRINT_JOB: 0x0002,
  VALIDATE_JOB: 0x0004,
  CREATE_JOB: 0x0005,
  SEND_DOCUMENT: 0x0006,
  CANCEL_JOB: 0x0008,
  GET_JOB_ATTRIBUTES: 0x0009,
  GET_JOBS: 0x000a,
  GET_PRINTER_ATTRIBUTES: 0x000b,
};

/** IPP status codes (RFC 8011 §B). */
const STATUS = {
  OK: 0x0000,
  BAD_REQUEST: 0x0400,
  NOT_POSSIBLE: 0x0404,
  NOT_FOUND: 0x0406,
  REQUEST_ENTITY_TOO_LARGE: 0x0408,
  DOCUMENT_FORMAT_NOT_SUPPORTED: 0x040a,
  INTERNAL_ERROR: 0x0500,
  OPERATION_NOT_SUPPORTED: 0x0501,
};

/**
 * @description Decode one IPP message from a buffer. Streaming-tolerant: returns
 * null when the buffer does not yet contain the complete header + attribute
 * section, so callers can accumulate chunks and retry. Document data (for
 * Print-Job / Send-Document) begins at the returned dataOffset.
 * @param {Buffer} buf Accumulated request or response bytes.
 * @returns {{versionMajor:number,versionMinor:number,operationId:number,requestId:number,groups:Array<{tag:number,attributes:Array<{tag:number,name:string,values:Array<*>}>}>,dataOffset:number}|null}
 *   The parsed message, or null when more bytes are needed. For responses,
 *   operationId carries the status code (same wire position).
 */
function decodeMessage(buf) {
  if (buf.length < 9) return null;
  const head = {
    versionMajor: buf[0],
    versionMinor: buf[1],
    operationId: buf.readUInt16BE(2),
    requestId: buf.readUInt32BE(4),
  };
  const state = { pos: 8, groups: [], group: null, last: null };
  while (state.pos < buf.length) {
    const tag = buf[state.pos];
    if (tag === DELIMITER.END_OF_ATTRIBUTES) {
      return { ...head, groups: state.groups, dataOffset: state.pos + 1 };
    }
    if (tag < 0x10) {
      state.group = { tag, attributes: [] };
      state.groups.push(state.group);
      state.last = null;
      state.pos += 1;
      continue;
    }
    if (!readAttribute(buf, state)) return null;
  }
  return null;
}

/**
 * @description Read one tag/name/value attribute record at state.pos, appending
 * either a new attribute or (zero-length name) an additional value onto the
 * previous one. Mutates state.pos past the record on success.
 * @param {Buffer} buf The message buffer.
 * @param {{pos:number,group:object|null,last:object|null}} state Parser cursor state.
 * @returns {boolean} False when the record is not yet fully buffered.
 */
function readAttribute(buf, state) {
  const { pos } = state;
  if (pos + 3 > buf.length) return false;
  const tag = buf[pos];
  const nameLen = buf.readUInt16BE(pos + 1);
  const nameEnd = pos + 3 + nameLen;
  if (nameEnd + 2 > buf.length) return false;
  const name = buf.toString('utf8', pos + 3, nameEnd);
  const valueLen = buf.readUInt16BE(nameEnd);
  const valueEnd = nameEnd + 2 + valueLen;
  if (valueEnd > buf.length) return false;
  const value = decodeValue(tag, buf.slice(nameEnd + 2, valueEnd));
  if (nameLen === 0 && state.last) {
    state.last.values.push(value);
  } else if (state.group) {
    state.last = { tag, name, values: [value] };
    state.group.attributes.push(state.last);
  }
  state.pos = valueEnd;
  return true;
}

/**
 * @description Decode a single attribute value according to its tag. Types the
 * printer never interprets (dateTime, resolution, collections, octetString)
 * come back as raw Buffers rather than being lossily converted.
 * @param {number} tag The IPP value tag.
 * @param {Buffer} buf The value bytes.
 * @returns {*} number | boolean | string | {min,max} | Buffer.
 */
function decodeValue(tag, buf) {
  if (tag === VALUE.INTEGER || tag === VALUE.ENUM) {
    return buf.length >= 4 ? buf.readInt32BE(0) : 0;
  }
  if (tag === VALUE.BOOLEAN) return buf.length >= 1 && buf[0] !== 0;
  if (tag === VALUE.RANGE_OF_INTEGER) {
    return buf.length >= 8 ? { min: buf.readInt32BE(0), max: buf.readInt32BE(4) } : { min: 0, max: 0 };
  }
  if (tag >= 0x41 && tag <= 0x4a) return buf.toString('utf8');
  return buf;
}

/**
 * @description Encode an IPP message (request or response) to wire bytes.
 * @param {{versionMajor?:number,versionMinor?:number,statusCode?:number,operationId?:number,requestId:number,groups?:Array,data?:Buffer}} msg
 *   statusCode (responses) and operationId (requests) share the same wire
 *   position; pass whichever applies. Optional data is appended after the
 *   end-of-attributes tag.
 * @returns {Buffer} The encoded message.
 */
function encodeMessage(msg) {
  const head = Buffer.alloc(8);
  head[0] = msg.versionMajor === undefined ? 2 : msg.versionMajor;
  head[1] = msg.versionMinor === undefined ? 0 : msg.versionMinor;
  head.writeUInt16BE((msg.statusCode !== undefined ? msg.statusCode : msg.operationId) || 0, 2);
  head.writeUInt32BE(msg.requestId >>> 0, 4);
  const parts = [head];
  for (const group of msg.groups || []) {
    parts.push(Buffer.from([group.tag]));
    for (const attr of group.attributes) parts.push(encodeAttribute(attr));
  }
  parts.push(Buffer.from([DELIMITER.END_OF_ATTRIBUTES]));
  if (msg.data) parts.push(msg.data);
  return Buffer.concat(parts);
}

/**
 * @description Encode one attribute; additional values in a 1setOf carry a
 * zero-length name per RFC 8010 §3.5.
 * @param {{tag:number,name:string,values:Array<*>}} attr The attribute to encode.
 * @returns {Buffer} The encoded records.
 */
function encodeAttribute(attr) {
  const parts = [];
  attr.values.forEach((value, index) => {
    const nameBuf = Buffer.from(index === 0 ? attr.name : '', 'utf8');
    const valueBuf = encodeValue(attr.tag, value);
    const meta = Buffer.alloc(3);
    meta[0] = attr.tag;
    meta.writeUInt16BE(nameBuf.length, 1);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(valueBuf.length, 0);
    parts.push(meta, nameBuf, len, valueBuf);
  });
  return Buffer.concat(parts);
}

/**
 * @description Encode a single value for its tag. Buffers pass through verbatim
 * (escape hatch for types without a JS shape here).
 * @param {number} tag The IPP value tag.
 * @param {*} value The JS value.
 * @returns {Buffer} The value bytes.
 */
function encodeValue(tag, value) {
  if (Buffer.isBuffer(value)) return value;
  if (tag === VALUE.INTEGER || tag === VALUE.ENUM) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(value | 0, 0);
    return b;
  }
  if (tag === VALUE.BOOLEAN) return Buffer.from([value ? 1 : 0]);
  if (tag === VALUE.RANGE_OF_INTEGER) {
    const b = Buffer.alloc(8);
    b.writeInt32BE(value.min | 0, 0);
    b.writeInt32BE(value.max | 0, 4);
    return b;
  }
  if (tag === VALUE.RESOLUTION) {
    const b = Buffer.alloc(9);
    b.writeInt32BE(value.x | 0, 0);
    b.writeInt32BE(value.y | 0, 4);
    b[8] = value.units === undefined ? 3 : value.units;
    return b;
  }
  return Buffer.from(String(value), 'utf8');
}

/**
 * @description Find the first attribute with the given name inside the first
 * group carrying the given delimiter tag.
 * @param {{groups:Array}} message A decoded message.
 * @param {number} groupTag The delimiter tag to search (e.g. operation attributes).
 * @param {string} name The attribute name.
 * @returns {{tag:number,name:string,values:Array<*>}|null} The attribute or null.
 */
function findAttribute(message, groupTag, name) {
  for (const group of message.groups) {
    if (group.tag !== groupTag) continue;
    const attr = group.attributes.find((a) => a.name === name);
    if (attr) return attr;
  }
  return null;
}

/**
 * @description Convenience: first value of a named attribute, or a fallback.
 * @param {{groups:Array}} message A decoded message.
 * @param {number} groupTag The delimiter tag to search.
 * @param {string} name The attribute name.
 * @param {*} [fallback] Returned when the attribute is absent.
 * @returns {*} The first value or the fallback.
 */
function attributeValue(message, groupTag, name, fallback) {
  const attr = findAttribute(message, groupTag, name);
  return attr ? attr.values[0] : fallback;
}

/**
 * @description Convenience: all values of a named attribute (empty array when absent).
 * @param {{groups:Array}} message A decoded message.
 * @param {number} groupTag The delimiter tag to search.
 * @param {string} name The attribute name.
 * @returns {Array<*>} The values, possibly empty.
 */
function attributeValues(message, groupTag, name) {
  const attr = findAttribute(message, groupTag, name);
  return attr ? attr.values : [];
}

module.exports = {
  DELIMITER,
  VALUE,
  OPERATION,
  STATUS,
  decodeMessage,
  encodeMessage,
  findAttribute,
  attributeValue,
  attributeValues,
};
