/**
 * Capture presentation-safe provider records from successful, allowlisted CLI command events.
 * This runs after the model has finished, so the hidden record channel cannot be authored or
 * modified by the model. Only exact read-only weather, Gmail, and Walmart search commands are
 * recognized. Walmart demo/fallback rows never cross this boundary as live provider records.
 */

'use strict';

const crypto = require('crypto');

const PROVIDER_FENCE = /```oshal:provider-record\s*[\s\S]*?```/gi;
const UNTERMINATED_PROVIDER_FENCE = /```oshal:provider-record\b[\s\S]*$/i;

function captureProviderRecord(command, output) {
  const trustedCommand = parseTrustedCommand(command);
  const values = extractJsonObjects(String(output || ''));
  if (trustedCommand?.kind === 'weather') {
    const result = [...values].reverse().find((value) => value?.success === true && value?.data);
    return result ? normalizeWeatherRecord(result.data) : null;
  }
  if (trustedCommand?.kind === 'gmail') {
    const result = [...values].reverse().find((value) => Array.isArray(value?.emails));
    return result ? normalizeGmailRecord(result) : null;
  }
  if (trustedCommand?.kind === 'walmart-search') {
    const result = [...values].reverse().find((value) => isCleanLiveWalmartResult(value));
    return result ? normalizeWalmartCatalogRecord(result, trustedCommand.query, result.retrievedAt) : null;
  }
  return null;
}

function parseTrustedCommand(command) {
  let value = String(command || '').trim();
  const shellPrefix = ['/bin/sh -lc ', '/bin/bash -lc ']
    .find((prefix) => value.startsWith(prefix));
  if (shellPrefix) value = value.slice(shellPrefix.length).trim();
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    value = value.slice(1, -1).trim();
  }
  if (value === 'node /app/scripts/oshal-gmail.js') return { kind: 'gmail' };
  const weather = /^node \/app\/any-bot\/server\/services\/tools\/weatherTools\.js --location (?:"([^"\r\n]{1,120})"|'([^'\r\n]{1,120})'|([\w .,-]{1,120})) --format (?:json|"json"|'json')$/;
  const weatherMatch = value.match(weather);
  if (weatherMatch) {
    // Quoting alone is not a safety boundary: inside double quotes, `$()`,
    // backticks, and backslashes still trigger shell expansion. Attest only a
    // literal place/coordinate token with ordinary name punctuation.
    const location = weatherMatch[1] || weatherMatch[2] || weatherMatch[3] || '';
    return /^[\p{L}\p{N} _.,'-]{1,120}$/u.test(location) ? { kind: 'weather' } : null;
  }

  // Search is the only Walmart operation allowed into the read-only provider-record channel.
  // Require one quoted, ordinary-text query and an explicit 1-6 result bound. Any shell operator,
  // interpolation marker, extra command, cart/deal operation, or unbounded invocation fails closed.
  const walmart = /^node \/app\/scripts\/oshal-walmart\.js search (?:"([^"\r\n]{1,200})"|'([^'\r\n]{1,200})') (?:([1-6])|"([1-6])"|'([1-6])')$/u;
  const walmartMatch = value.match(walmart);
  if (!walmartMatch) return null;
  const query = (walmartMatch[1] || walmartMatch[2] || '').trim();
  return /^[\p{L}\p{N}][\p{L}\p{N}\p{Zs}.,&'()/%+\-:]{0,199}$/u.test(query)
    ? { kind: 'walmart-search', query }
    : null;
}

function stripModelProviderRecordFences(modelText) {
  return String(modelText || '')
    .replace(PROVIDER_FENCE, '')
    .replace(UNTERMINATED_PROVIDER_FENCE, '')
    .trim();
}

function normalizeWeatherRecord(data) {
  const current = data?.current || {};
  const location = boundedText(data?.location, 120);
  const timestamp = boundedText(data?.timestamp, 80);
  const tempF = finite(current.temp_f);
  const tempC = finite(current.temp_c);
  const condition = boundedText(current.conditions, 100);
  if (!location || !timestamp || tempF === null || tempC === null || !condition) return null;
  const record = {
    location,
    timestamp,
    current: compact({
      tempF,
      tempC,
      condition,
      humidityPercent: boundedPercent(current.humidity),
      precipitationPercent: boundedPercent(current.precipitation_percent),
      windSpeedMph: boundedNumber(current.wind_speed, 0, 500),
      windDirection: boundedText(current.wind_direction, 24) || undefined,
      validFrom: boundedText(current.valid_from, 80) || undefined,
    }),
    periods: (Array.isArray(data?.forecast) ? data.forecast : []).slice(0, 6).map((period) => compact({
      label: boundedText(period?.name, 40),
      tempF: finite(period?.temp_f),
      tempC: finite(period?.temp_c),
      condition: boundedText(period?.conditions, 100),
      precipitationPercent: boundedPercent(period?.precipitation_percent),
    })).filter((period) => period.label && period.tempF !== null && period.tempC !== null && period.condition),
  };
  const envelope = {
    schemaVersion: 1,
    kind: 'nws-weather',
    provider: 'nws',
    retrievedAt: timestamp,
    record,
  };
  return { ...envelope, sourceRef: `nws:forecast:${digest(envelope).slice(0, 24)}` };
}

function normalizeGmailRecord(data) {
  const mailbox = boundedText(data?.account, 120) || 'connected Gmail';
  const retrievedAt = boundedText(data?.retrievedAt, 80);
  if (!retrievedAt) return null;
  const normalizedMessages = (Array.isArray(data?.emails) ? data.emails : []).slice(0, 50).map((message) => {
    const id = boundedText(message?.id, 180);
    if (!id) return null;
    return compact({
      sourceRef: `gmail:message:${safeReference(id)}`,
      id,
      sender: boundedText(message?.from, 160) || '(unknown sender)',
      subject: boundedText(message?.subject, 240) || '(no subject)',
      receivedAt: boundedText(message?.receivedAt, 80) || undefined,
      unread: message?.providerFlags?.unread === true || message?.unread === true,
      important: message?.providerFlags?.important === true || message?.important === true,
      starred: message?.providerFlags?.starred === true || message?.starred === true,
    });
  }).filter(Boolean);
  // Persist every provider-priority row needed for an exact count, plus only a small bounded sample
  // of unflagged rows that Jarvis may explicitly label as its own suggestion. Snippets/bodies never
  // enter this record.
  const providerPriority = normalizedMessages.filter((message) => message.important || message.starred);
  const suggestionCandidates = normalizedMessages
    .filter((message) => !message.important && !message.starred)
    .slice(0, 6);
  const messages = [...providerPriority, ...suggestionCandidates];
  const envelope = {
    schemaVersion: 1,
    kind: 'gmail-summary',
    provider: 'gmail',
    retrievedAt,
    mailbox,
    messages,
  };
  return { ...envelope, sourceRef: `gmail:summary:${digest(envelope).slice(0, 24)}` };
}

function isCleanLiveWalmartResult(value) {
  return value
    && typeof value === 'object'
    && value.source === 'walmart'
    && Array.isArray(value.items)
    && !Object.prototype.hasOwnProperty.call(value, 'fallbackReason')
    && !Object.prototype.hasOwnProperty.call(value, 'providerError')
    && !Object.prototype.hasOwnProperty.call(value, 'error')
    && !Object.prototype.hasOwnProperty.call(value, 'errorCode');
}

/** Normalize only bounded live catalog fields needed for deterministic product presentation. */
function normalizeWalmartCatalogRecord(data, query, retrievedAtValue = data?.retrievedAt) {
  if (!isCleanLiveWalmartResult(data)) return null;
  const safeQuery = boundedText(query, 200);
  const retrievedAt = boundedText(retrievedAtValue, 80);
  if (!safeQuery || !retrievedAt) return null;
  const normalizedItems = data.items.slice(0, 6).map(normalizeWalmartItem).filter(Boolean);
  const items = [...new Map(normalizedItems.map((item) => [item.sourceRef, item])).values()];
  if (!items.length) return null;
  const envelope = {
    schemaVersion: 1,
    kind: 'walmart-catalog',
    provider: 'walmart',
    retrievedAt,
    query: safeQuery,
    items,
  };
  return { ...envelope, sourceRef: `walmart:catalog:${digest(envelope).slice(0, 24)}` };
}

function normalizeWalmartItem(value) {
  const productId = boundedText(value?.productId, 120);
  const title = boundedText(value?.title, 180);
  const imageUrl = safeHttpsUrl(value?.imageUrl, 1500, (host) => host === 'i5.walmartimages.com');
  const productUrl = safeHttpsUrl(value?.productUrl, 1500, isWalmartOwnedHost);
  if (!productId || !title || !imageUrl || !productUrl) return null;
  const amount = finite(value?.price);
  const item = compact({
    productId,
    title,
    brand: boundedText(value?.brand, 100) || undefined,
    price: amount !== null && amount >= 0 && amount <= 1_000_000 ? amount : undefined,
    currency: 'USD',
    imageUrl,
    productUrl,
  });
  return { ...item, sourceRef: `walmart:item:${digest(item).slice(0, 24)}` };
}

function safeHttpsUrl(value, maximum, allowsHost) {
  const text = boundedText(value, maximum);
  if (!text) return null;
  try {
    const parsed = new URL(text);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password || !allowsHost(host)) return null;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function isWalmartOwnedHost(host) {
  return host === 'walmart.com' || host.endsWith('.walmart.com');
}

function extractJsonObjects(text) {
  const values = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') continue;
    const end = findBalancedObjectEnd(text, start);
    if (end < 0) continue;
    try {
      values.push(JSON.parse(text.slice(start, end + 1)));
      start = end;
    } catch { /* keep looking for the next object */ }
  }
  return values;
}

function findBalancedObjectEnd(text, start) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return index;
  }
  return -1;
}

function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function boundedNumber(value, minimum, maximum) {
  const number = finite(value);
  return number !== null && number >= minimum && number <= maximum ? number : undefined;
}

function boundedPercent(value) {
  return boundedNumber(value, 0, 100);
}

function boundedText(value, maximum) {
  return String(value == null ? '' : value).trim().slice(0, maximum);
}

function safeReference(value) {
  const safe = String(value).replace(/[^\w.-]/g, '-').slice(0, 120);
  return safe || digest(value).slice(0, 24);
}

module.exports = {
  captureProviderRecord,
  extractJsonObjects,
  normalizeGmailRecord,
  normalizeWalmartCatalogRecord,
  normalizeWeatherRecord,
  stripModelProviderRecordFences,
};
