/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from google-workspace-cli.js (1000-line cap decomposition): argument parsing, option readers, base64url/URL/JSON/fs helpers, and HTTP response payload utilities
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * @description Resolves the CLI home directory used for token/config storage,
 * honoring --home, OSHAL_GOOGLE_WORKSPACE_HOME, GOOGLE_WORKSPACE_HOME, then a
 * ~/.oshal-google-workspace default.
 * @param {object} [options] Parsed CLI options (may carry a `home` override).
 * @param {object} [env] Environment variable map (defaults to process.env).
 * @returns {string} Absolute path to the resolved home directory.
 */
function resolveHomeDir(options = {}, env = process.env) {
  const configured = options.home
    || env.OSHAL_GOOGLE_WORKSPACE_HOME
    || env.GOOGLE_WORKSPACE_HOME
    || path.join(os.homedir(), '.oshal-google-workspace');
  return path.resolve(configured);
}

/**
 * @description Normalizes a profile name into a filesystem-safe token so it can
 * be used as a JSON store filename; falls back to "default".
 * @param {string} value Raw profile name.
 * @returns {string} Sanitized profile name.
 */
function sanitizeProfileName(value) {
  return String(value || 'default').trim().replace(/[^a-zA-Z0-9._-]/g, '_') || 'default';
}

/**
 * @description Parses raw argv tokens into positional arguments and a camelCased
 * options map. `--name value`, `--name=value`, and boolean `--flag` forms are all
 * supported; repeated options accumulate into arrays.
 * @param {string[]} argv Argument vector (without node/script entries).
 * @returns {{positional: string[], options: object}} Parsed arguments.
 */
function parseArguments(argv) {
  const options = {};
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const raw = token.slice(2);
    const [namePart, inlineValue] = raw.split('=', 2);
    const name = toCamelCase(namePart);

    if (inlineValue !== undefined) {
      assignOption(options, name, inlineValue);
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      assignOption(options, name, true);
      continue;
    }

    assignOption(options, name, next);
    index += 1;
  }

  return { positional, options };
}

function assignOption(options, name, value) {
  if (Object.prototype.hasOwnProperty.call(options, name)) {
    if (Array.isArray(options[name])) {
      options[name].push(value);
      return;
    }
    options[name] = [options[name], value];
    return;
  }
  options[name] = value;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
}

/**
 * @description Reads a trimmed non-empty string option, returning undefined for
 * anything else so callers can fall back cleanly.
 * @param {*} value Raw option value.
 * @returns {string|undefined} Trimmed string or undefined.
 */
function readStringOption(value) {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

/**
 * @description Interprets an option as a boolean, accepting bare flags plus
 * true/false, 1/0, and yes/no string forms; undefined when unparseable.
 * @param {*} value Raw option value.
 * @returns {boolean|undefined} Parsed boolean or undefined.
 */
function readBooleanOption(value) {
  if (value === true) {
    return true;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no') {
      return false;
    }
  }
  return undefined;
}

/**
 * @description Interprets an option as an integer, falling back to the supplied
 * default when the value is missing or not integral.
 * @param {*} value Raw option value.
 * @param {number} [fallback] Value returned when parsing fails.
 * @returns {number|undefined} Parsed integer or the fallback.
 */
function readIntegerOption(value, fallback) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

/**
 * @description Normalizes a repeatable option into a flat string array, splitting
 * each entry on commas/whitespace (used for OAuth scope lists).
 * @param {*} value Raw option value (string or array of strings).
 * @returns {string[]} Flattened list of non-empty tokens.
 */
function readArrayOption(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => splitDelimitedValue(item));
  }
  return splitDelimitedValue(value);
}

function splitDelimitedValue(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return [];
  }
  return value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * @description Parses a JSON string option, raising a descriptive error that names
 * the offending field when the input is missing or malformed.
 * @param {*} value Raw option value expected to be a JSON string.
 * @param {string} fieldName Option name used in error messages.
 * @returns {*} Parsed JSON value.
 */
function parseJsonInput(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Option "${fieldName}" must be a JSON string.`);
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Failed to parse JSON for "${fieldName}": ${error.message}`);
  }
}

/**
 * @description Creates the parent directory of a target file path (recursively)
 * so writes to profile stores and download targets never fail on missing dirs.
 * @param {string} filePath Absolute or relative file path.
 * @returns {void}
 */
function ensureParentDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/**
 * @description Encodes a string or Buffer as URL-safe base64 without padding
 * (RFC 4648 base64url), as required by Gmail raw messages and JWT assertions.
 * @param {string|Buffer} value Input to encode.
 * @returns {string} base64url-encoded string.
 */
function base64UrlEncode(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/**
 * @description Decodes a URL-safe base64 string (padding-tolerant) into UTF-8
 * text, used for Gmail message body parts.
 * @param {string} value base64url input.
 * @returns {string} Decoded UTF-8 string.
 */
function base64UrlDecode(value) {
  const raw = String(value || '');
  const padded = raw
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(raw.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

/**
 * @description Parses a service-account JSON blob from an env var or option,
 * un-escaping literal "\n" sequences in the private key first; undefined when
 * the input is empty.
 * @param {string} rawValue Raw JSON string.
 * @returns {object|undefined} Parsed service-account object or undefined.
 */
function coerceServiceAccountJson(rawValue) {
  if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
    return undefined;
  }
  const normalized = rawValue.replace(/\\n/g, '\n');
  return JSON.parse(normalized);
}

/**
 * @description Joins a base URL and a relative path with exactly one slash
 * between them regardless of trailing/leading slashes on the inputs.
 * @param {string} baseUrl Base URL.
 * @param {string} relativePath Path to append.
 * @returns {string} Joined URL string.
 */
function joinUrl(baseUrl, relativePath) {
  return `${String(baseUrl).replace(/\/+$/g, '')}/${String(relativePath).replace(/^\/+/g, '')}`;
}

/**
 * @description Appends query parameters to a URL, skipping null/undefined/empty
 * values and expanding array values into repeated params.
 * @param {string} urlValue Base URL string.
 * @param {object} [query] Map of query parameter names to values.
 * @returns {string} URL string with the query applied.
 */
function addQueryParams(urlValue, query = {}) {
  const url = new URL(urlValue);
  for (const [key, rawValue] of Object.entries(query)) {
    if (rawValue === undefined || rawValue === null || rawValue === '') {
      continue;
    }
    if (Array.isArray(rawValue)) {
      for (const item of rawValue) {
        if (item !== undefined && item !== null && item !== '') {
          url.searchParams.append(key, String(item));
        }
      }
      continue;
    }
    url.searchParams.set(key, String(rawValue));
  }
  return url.toString();
}

/**
 * @description Reads a required string option, throwing a descriptive error that
 * names the field when it is missing or blank.
 * @param {*} value Raw option value.
 * @param {string} fieldName Option name used in the error message.
 * @returns {string} The validated, trimmed string.
 */
function requireOption(value, fieldName) {
  const parsed = readStringOption(value);
  if (!parsed) {
    throw new Error(`Option "${fieldName}" is required.`);
  }
  return parsed;
}

/**
 * @description Reads a fetch Response body as JSON when the content type says
 * so, otherwise as text — mirrors how Google APIs mix JSON and raw payloads.
 * @param {Response} response Fetch API response.
 * @returns {Promise<*>} Parsed JSON value or raw text.
 */
async function readResponsePayload(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

/**
 * @description Renders an error payload (string or object) as a string for
 * inclusion in thrown error messages, tolerating non-serializable values.
 * @param {*} payload Error payload from a failed API call.
 * @returns {string} Stringified payload.
 */
function stringifyErrorPayload(payload) {
  if (typeof payload === 'string') {
    return payload;
  }
  try {
    return JSON.stringify(payload);
  } catch (_error) {
    return String(payload);
  }
}

/**
 * @description Formats a command result for non-JSON output mode: strings pass
 * through untouched, everything else pretty-prints as indented JSON.
 * @param {*} value Command result.
 * @returns {string} Rendered output string.
 */
function formatPrettyOutput(value) {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

module.exports = {
  resolveHomeDir,
  sanitizeProfileName,
  parseArguments,
  readStringOption,
  readBooleanOption,
  readIntegerOption,
  readArrayOption,
  parseJsonInput,
  ensureParentDirectory,
  base64UrlEncode,
  base64UrlDecode,
  coerceServiceAccountJson,
  joinUrl,
  addQueryParams,
  requireOption,
  readResponsePayload,
  stringifyErrorPayload,
  formatPrettyOutput,
};
