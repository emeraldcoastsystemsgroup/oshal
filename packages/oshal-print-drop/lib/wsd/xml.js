/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — minimal XML/SOAP helpers for the WSD stack. Deliberately not a full XML parser: WSD messages from Windows clients are machine-generated with predictable structure, so local-name-based tag extraction (prefix-agnostic regex) is sufficient and keeps the package dependency-free. Values extracted here are matched against known constants, never executed or used as paths.
 */
'use strict';

const crypto = require('crypto');

/**
 * @description Extract the text content of the first element with the given
 * LOCAL name, ignoring any namespace prefix (<wsa:Action>, <a:Action>, <Action>).
 * @param {string} xml The XML text.
 * @param {string} localName The element local name.
 * @returns {string} Trimmed text content, '' when absent.
 */
function extractTag(xml, localName) {
  const re = new RegExp(`<(?:[A-Za-z0-9_]+:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?${localName}>`);
  const match = re.exec(xml);
  return match ? match[1].trim() : '';
}

/**
 * @description Extract an attribute value from the first element with the given
 * local name (e.g. boundary parsing helpers use header strings instead).
 * @param {string} xml The XML text.
 * @param {string} localName The element local name.
 * @param {string} attribute The attribute name.
 * @returns {string} The attribute value, '' when absent.
 */
function extractAttribute(xml, localName, attribute) {
  const re = new RegExp(`<(?:[A-Za-z0-9_]+:)?${localName}\\b[^>]*\\b${attribute}="([^"]*)"`);
  const match = re.exec(xml);
  return match ? match[1] : '';
}

/**
 * @description Escape text for safe embedding in XML content.
 * @param {string} text The raw text.
 * @returns {string} XML-escaped text.
 */
function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @description A fresh urn:uuid message id.
 * @returns {string} The message id.
 */
function messageId() {
  return `urn:uuid:${crypto.randomUUID()}`;
}

module.exports = { extractTag, extractAttribute, escapeXml, messageId };
