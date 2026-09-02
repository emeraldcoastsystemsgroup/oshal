/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the Get-Printer-Attributes response set: an IPP Everywhere-shaped subset sufficient for the Microsoft IPP Class Driver, macOS, and CUPS to install the queue driverlessly. Deliberate choice: document-format-supported advertises application/pdf (plus octet-stream) and nothing raster, which makes every mainstream client transcode to PDF before sending — the server never has to render PWG raster. Includes the requested-attributes filter (group keywords like 'all'/'printer-description' return the full set).
 */
'use strict';

const { DELIMITER, VALUE, OPERATION } = require('./ipp-codec');

/** Group keywords a client may pass in requested-attributes; any of them means "the full set". */
const GROUP_KEYWORDS = new Set([
  'all',
  'printer-description',
  'job-template',
  'media-col-database',
  'printer-defaults',
  'printer-status',
]);

/**
 * @description Build the printer-description side of the attribute set — identity,
 * state, protocol capabilities, and the PDF-only document-format contract.
 * @param {{name:string,info:string,location:string,uris:string[],uuidUri:string,upTimeSeconds:number,queuedJobCount:number}} ctx Live printer context.
 * @returns {Array<{tag:number,name:string,values:Array<*>}>} Description attributes.
 */
function buildDescriptionAttributes(ctx) {
  return [
    { tag: VALUE.URI, name: 'printer-uri-supported', values: ctx.uris },
    { tag: VALUE.KEYWORD, name: 'uri-security-supported', values: ctx.uris.map(() => 'none') },
    { tag: VALUE.KEYWORD, name: 'uri-authentication-supported', values: ctx.uris.map(() => 'none') },
    { tag: VALUE.NAME, name: 'printer-name', values: [ctx.name] },
    { tag: VALUE.TEXT, name: 'printer-info', values: [ctx.info] },
    { tag: VALUE.TEXT, name: 'printer-location', values: [ctx.location] },
    { tag: VALUE.TEXT, name: 'printer-make-and-model', values: ['oshal print-drop virtual printer'] },
    { tag: VALUE.ENUM, name: 'printer-state', values: [3] },
    { tag: VALUE.KEYWORD, name: 'printer-state-reasons', values: ['none'] },
    { tag: VALUE.TEXT, name: 'printer-state-message', values: ['Saving print jobs to disk'] },
    { tag: VALUE.KEYWORD, name: 'ipp-versions-supported', values: ['1.1', '2.0'] },
    { tag: VALUE.ENUM, name: 'operations-supported', values: Object.values(OPERATION) },
    { tag: VALUE.BOOLEAN, name: 'multiple-document-jobs-supported', values: [false] },
    { tag: VALUE.CHARSET, name: 'charset-configured', values: ['utf-8'] },
    { tag: VALUE.CHARSET, name: 'charset-supported', values: ['utf-8'] },
    { tag: VALUE.NATURAL_LANGUAGE, name: 'natural-language-configured', values: ['en'] },
    { tag: VALUE.NATURAL_LANGUAGE, name: 'generated-natural-language-supported', values: ['en'] },
    { tag: VALUE.MIME_MEDIA_TYPE, name: 'document-format-default', values: ['application/pdf'] },
    { tag: VALUE.MIME_MEDIA_TYPE, name: 'document-format-supported', values: ['application/pdf', 'application/octet-stream'] },
    { tag: VALUE.BOOLEAN, name: 'printer-is-accepting-jobs', values: [true] },
    { tag: VALUE.INTEGER, name: 'queued-job-count', values: [ctx.queuedJobCount] },
    { tag: VALUE.KEYWORD, name: 'pdl-override-supported', values: ['attempted'] },
    { tag: VALUE.INTEGER, name: 'printer-up-time', values: [ctx.upTimeSeconds] },
    { tag: VALUE.KEYWORD, name: 'compression-supported', values: ['none'] },
    { tag: VALUE.BOOLEAN, name: 'color-supported', values: [true] },
    { tag: VALUE.URI, name: 'printer-uuid', values: [ctx.uuidUri] },
  ];
}

/**
 * @description Build the job-template side of the attribute set — the defaults and
 * supported ranges clients use to render the print dialog. All cosmetic for a
 * print-to-file target, but the Microsoft IPP Class Driver expects them.
 * @returns {Array<{tag:number,name:string,values:Array<*>}>} Job-template attributes.
 */
function buildJobTemplateAttributes() {
  return [
    { tag: VALUE.KEYWORD, name: 'media-default', values: ['na_letter_8.5x11in'] },
    { tag: VALUE.KEYWORD, name: 'media-supported', values: ['na_letter_8.5x11in', 'iso_a4_210x297mm', 'na_legal_8.5x14in'] },
    { tag: VALUE.KEYWORD, name: 'media-ready', values: ['na_letter_8.5x11in', 'iso_a4_210x297mm'] },
    { tag: VALUE.KEYWORD, name: 'sides-default', values: ['one-sided'] },
    { tag: VALUE.KEYWORD, name: 'sides-supported', values: ['one-sided'] },
    { tag: VALUE.ENUM, name: 'orientation-requested-default', values: [3] },
    { tag: VALUE.ENUM, name: 'orientation-requested-supported', values: [3, 4] },
    { tag: VALUE.INTEGER, name: 'copies-default', values: [1] },
    { tag: VALUE.RANGE_OF_INTEGER, name: 'copies-supported', values: [{ min: 1, max: 1 }] },
    { tag: VALUE.ENUM, name: 'finishings-default', values: [3] },
    { tag: VALUE.ENUM, name: 'finishings-supported', values: [3] },
    { tag: VALUE.ENUM, name: 'print-quality-default', values: [4] },
    { tag: VALUE.ENUM, name: 'print-quality-supported', values: [4] },
    { tag: VALUE.RESOLUTION, name: 'printer-resolution-default', values: [{ x: 600, y: 600, units: 3 }] },
    { tag: VALUE.RESOLUTION, name: 'printer-resolution-supported', values: [{ x: 600, y: 600, units: 3 }] },
    { tag: VALUE.KEYWORD, name: 'print-color-mode-default', values: ['color'] },
    { tag: VALUE.KEYWORD, name: 'print-color-mode-supported', values: ['color', 'monochrome'] },
    {
      tag: VALUE.KEYWORD,
      name: 'job-creation-attributes-supported',
      values: ['job-name', 'media', 'copies', 'sides', 'orientation-requested', 'print-color-mode', 'print-quality'],
    },
  ];
}

/**
 * @description Build the complete printer attribute set for a Get-Printer-Attributes
 * response.
 * @param {{name:string,info:string,location:string,uris:string[],uuidUri:string,upTimeSeconds:number,queuedJobCount:number}} ctx Live printer context.
 * @returns {Array<{tag:number,name:string,values:Array<*>}>} All printer attributes.
 */
function buildPrinterAttributes(ctx) {
  return [...buildDescriptionAttributes(ctx), ...buildJobTemplateAttributes()];
}

/**
 * @description Apply a client's requested-attributes list. An empty list or any
 * group keyword ('all', 'printer-description', …) returns the full set; otherwise
 * only exact name matches are returned, per RFC 8011 §5.1.5 (unsupported names
 * are simply omitted).
 * @param {Array<{name:string}>} attributes The full attribute set.
 * @param {string[]} requested The requested-attributes values from the client.
 * @returns {Array} The filtered attribute set.
 */
function filterRequested(attributes, requested) {
  if (!requested.length || requested.some((name) => GROUP_KEYWORDS.has(name))) return attributes;
  const wanted = new Set(requested);
  return attributes.filter((attr) => wanted.has(attr.name));
}

module.exports = { buildPrinterAttributes, filterRequested, DELIMITER };
