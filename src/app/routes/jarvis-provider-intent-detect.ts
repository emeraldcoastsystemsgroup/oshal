/**
 * Jarvis provider-bound intent detection — the deterministic guard that recognizes only bounded,
 * live-provider requests (weather, priority inbox, read-only Walmart catalog) and the weather
 * location follow-up, so a plausible-looking answer can never be produced from model memory.
 *
 * Extracted from jarvis-routes.ts (2026-07-18, ADR-050 route decomposition). Behaviour unchanged;
 * `classifyWeatherLocationFollowUp` is now exported (the /ask route calls it directly).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from jarvis-routes.ts: provider-bound handoff detection (weather/priority-email/walmart-catalog) + the weather-location follow-up classifier (route decomposition, no behaviour change).
 *
 * @module jarvis-provider-intent-detect
 */

import { extractWeatherIntentLocation } from '../bot-node-provider-intent';
import type { ProviderBoundHandoffIntent } from './jarvis-directives';

const DEVELOPMENT_ACTION = /\b(?:add|architect|build|change|code|debug|deploy|design|develop|fix|implement|integrate|modify|program|prototype|refactor|ship|test|update|wire)\b/i;
const DEVELOPMENT_OBJECT = /\b(?:app|application|api|bot|cockpit|code|component|dashboard|endpoint|feature|integration|jarvis|module|oshal|platform|script|service|swarm|ui|ux|web ?page|website|widget|workflow)\b/i;
const EXPLICIT_CODE_REQUEST = /\b(?:generate|give|show|write)\b[\s\S]{0,24}\b(?:code|css|html|javascript|python|sql|typescript)\b/i;
const DOMAIN_TECHNICAL_OBJECT = /(?:\b(?:email|forecast|inbox|mailbox|weather)\b[\s-]{0,3}\b(?:api|app|application|bot|component|dashboard|endpoint|integration|service|widget|workflow)\b|\b(?:api|app|application|bot|component|dashboard|endpoint|integration|service|widget|workflow)\b[\s-]{0,3}\b(?:email|forecast|inbox|mailbox|weather)\b)/i;
const WALMART_READ_ACTION = /\b(?:check|compare|fetch|find|get|list|look up|search|show(?: me)?)\b/i;
const WALMART_MIXED_PROVIDER = /\b(?:amazon|costco|doordash|ebay|instacart|target|uber\s*eats)\b/i;
const COMMERCE_WRITE_ACTION = /\b(?:add(?:ing)?\b[\s\S]{0,24}\bcart|buy(?:ing)?|check\s*out|checkout|order(?:ing)?|pay(?:ment)?|purchas(?:e|ing)|subscribe)\b/i;
const EXPLICIT_READ_ONLY_COMMERCE = /\bread[ -]?only\b|\b(?:do not|don't|never)\b[\s\S]{0,100}\b(?:write action|add\b[\s\S]{0,20}\bcart|buy|check\s*out|checkout|order|purchase)\b/i;
const SAFE_WALMART_QUERY = /^[\p{L}\p{N}][\p{L}\p{N}\p{Zs}.,&'()/%+\-:]{0,199}$/u;

function extractWalmartCatalogRequest(message: string): { query: string; limit: number } | undefined {
  if (!/\bwalmart\b/i.test(message) || !WALMART_READ_ACTION.test(message)) return undefined;
  if (WALMART_MIXED_PROVIDER.test(message)) return undefined;
  if (COMMERCE_WRITE_ACTION.test(message) && !EXPLICIT_READ_ONLY_COMMERCE.test(message)) return undefined;

  const queryPatterns = [
    /\bwalmart(?:\s+catalog)?\s+search\s+(?:for\s+)?([\s\S]{1,200}?)(?=\s*(?:[?!;]|\.\s|$|\b(?:do not|don't|exactly\s+\d+|include|including|return|with\s+(?:current\s+)?prices?)\b))/i,
    /\bsearch\s+(?:the\s+)?walmart(?:\s+catalog)?\s+(?:for\s+)?([\s\S]{1,200}?)(?=\s*(?:[?!;]|\.\s|$|\b(?:do not|don't|exactly\s+\d+|include|including|return|with\s+(?:current\s+)?prices?)\b))/i,
    /\b(?:check|compare|fetch|find|get|list|look up|search|show(?: me)?)\s+(?:for\s+)?([\s\S]{1,200}?)\s+(?:at|from|on)\s+walmart\b/i,
  ];
  const rawQuery = queryPatterns
    .map((pattern) => message.match(pattern)?.[1])
    .find((candidate): candidate is string => typeof candidate === 'string');
  if (!rawQuery) return undefined;

  const limitMatch = message.match(/\bexactly\s+(\d{1,2})\b/i)
    || message.match(/\b(?:find|get|list|return|show(?: me)?)\s+(?:top\s+)?(\d{1,2})\b/i)
    || message.match(/\b(\d{1,2})\s+(?:real\s+)?(?:items?|options?|products?|results?)\b/i)
    || message.match(/\btop\s+(\d{1,2})\b/i);
  const requestedLimit = limitMatch ? Number(limitMatch[1]) : 4;
  const limit = Number.isFinite(requestedLimit) ? Math.min(6, Math.max(1, requestedLimit)) : 4;

  const query = rawQuery
    .replace(/^(?:please\s+)?(?:exactly\s+|top\s+)?\d{1,2}\s+/i, '')
    .replace(/\s+(?:items?|options?|products?|results?)$/i, '')
    .replace(/^[\s'\"]+|[\s'\".,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!SAFE_WALMART_QUERY.test(query)) return undefined;
  return { query, limit };
}

/**
 * @description Recognizes only bounded, provider-dependent weather, priority-inbox, and explicit
 * read-only Walmart catalog requests.
 * Obvious product/platform/code work stays model-owned so this guard cannot become a second general
 * router. The returned directive goes through the same ticket + delayed-completion path as a
 * model-authored handoff; it never makes a direct answer visually eligible.
 */
export function detectProviderBoundHandoff(message: string): ProviderBoundHandoffIntent | undefined {
  const normalized = String(message || '').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().slice(0, 4_000);
  if (!normalized) return undefined;

  // "Build a weather app", "add inbox summaries to Jarvis", and similar asks are implementation
  // work. They still need Jarvis's normal model decision instead of being mistaken for data reads.
  if ((DEVELOPMENT_ACTION.test(normalized) && DEVELOPMENT_OBJECT.test(normalized))
    || EXPLICIT_CODE_REQUEST.test(normalized)
    || DOMAIN_TECHNICAL_OBJECT.test(normalized)) return undefined;

  const walmartRequest = extractWalmartCatalogRequest(normalized);
  if (walmartRequest) {
    const { query, limit } = walmartRequest;
    return {
      kind: 'walmart-catalog',
      acknowledgement: "I'll check the live Walmart catalog and report back here.",
      handoff: {
        action: 'create',
        title: `Live Walmart: ${query}`.slice(0, 120),
        description: [
          'Use the authorized live Walmart catalog provider for this current, source-backed product search.',
          `User request: ${normalized}`,
          `Search query: ${query}`,
          `Return at most ${limit} real products with current prices, Walmart product links, and product-image references.`,
          'This is strictly read-only: do not add to a cart, check out, place an order, or take any write action. Return the provider facts through the normal worker completion channel. Do not answer from model memory or web search.',
        ].join('\n'),
        complexity: 'simple',
        platform: false,
        providerIntent: {
          schemaVersion: 1,
          kind: 'walmart-catalog',
          operation: 'product-search',
          query,
          limit,
        },
      },
    };
  }

  const weatherRequest = [
    /\b(?:what(?:'s| is)|how(?:'s| is))\s+the\s+(?:current\s+)?(?:weather|forecast|temperature|conditions?)\b/i,
    /\bwhat\s+will\s+the\s+weather\b/i,
    /\b(?:check|fetch|get|give me|look up|pull|show me|tell me)\b[\s\S]{0,60}\b(?:weather|forecast|temperature|current conditions?)\b/i,
    /\b(?:current|live|local)\s+(?:weather|forecast|temperature|conditions?)\b/i,
    /\b(?:weather|forecast|temperature|conditions?)\b[\s\S]{0,45}\b(?:at|for|in|near)\s+[a-z0-9]/i,
    /\b(?:weather|forecast|temperature|conditions?)\b[\s\S]{0,35}\b(?:currently|now|right now|today|tonight|tomorrow|this (?:afternoon|evening|morning|week|weekend))\b/i,
    /\b(?:is it|will it)\s+(?:rain(?:ing)?|snow(?:ing)?|storm(?:ing)?)\b/i,
    /\b(?:how hot|how cold|what(?:'s| is) the temperature)\b[\s\S]{0,35}\b(?:outside|now|today|tonight|tomorrow|at|in|near)\b/i,
  ].some((pattern) => pattern.test(normalized));

  if (weatherRequest) {
    const request = normalized.slice(0, 4_000);
    const location = extractWeatherIntentLocation(request);
    return {
      kind: 'weather',
      acknowledgement: "I'll check the live weather data and report back here.",
      handoff: {
        action: 'create',
        title: `Live weather: ${request}`.slice(0, 120),
        description: [
          'Use the authorized live weather provider to answer this request with current, source-backed data.',
          `User request: ${request}`,
          'Return provider facts and source references through the normal worker completion channel so Jarvis can create the delayed weather visual. Do not answer from model memory.',
        ].join('\n'),
        complexity: 'simple',
        platform: false,
        ...(location ? {
          providerIntent: {
            schemaVersion: 1,
            kind: 'weather',
            operation: 'current-forecast',
            location,
          },
        } : {}),
      },
    };
  }

  const mailboxSummaryRequest = [
    /\b(?:recap|summarize|triage)\b[\s\S]{0,40}\b(?:(?:my|the)\s+(?:email|emails|inbox|mail|mailbox)|emails|inbox|mailbox)\b/i,
    /^(?:(?:give|show) me (?:an? |my )?)?(?:my\s+)?(?:email|inbox|mailbox)\s+(?:summary|digest|recap|triage)[?.!]*$/i,
    /\bcatch\s+me\s+up\s+on\s+(?:my\s+|the\s+)?(?:email|emails|inbox|mail)\b/i,
    /\b(?:any|are there|check|do i have|find|list|review|scan|show|show me|what are|what is|what's|which)\b[\s\S]{0,55}\b(?:important|priority|urgent|starred|flagged|unread)\b[\s\S]{0,30}\b(?:email|emails|inbox|mail|messages)\b/i,
    /\b(?:which|what)\s+(?:of\s+)?(?:my\s+)?(?:email|emails|messages)\b[\s\S]{0,35}\b(?:important|priority|urgent|starred|flagged|unread)\b/i,
    /\b(?:important|priority|urgent|starred|flagged|unread)\b[\s\S]{0,30}\b(?:email|emails|mail|messages)\b[\s\S]{0,45}\b(?:in my inbox|since|this morning|today|tonight|yesterday)\b/i,
    /^(?:my\s+)?(?:important|priority|urgent|starred|flagged|unread)\s+(?:email|emails|mail|messages)[?.!]*$/i,
    /\bwhat(?:'s| is)\s+in\s+(?:my\s+|the\s+)?inbox\b/i,
  ].some((pattern) => pattern.test(normalized));

  if (!mailboxSummaryRequest) return undefined;
  const request = normalized.slice(0, 4_000);
  return {
    kind: 'priority-email',
    acknowledgement: "I'll check your priority inbox and report back here.",
    handoff: {
      action: 'create',
      title: `Priority inbox: ${request}`.slice(0, 120),
      description: [
        'Use the authorized mailbox provider to answer this priority-inbox request with current, source-backed data.',
        `User request: ${request}`,
        'Return only the bounded priority summary and provider source references through the normal worker completion channel so Jarvis can create the delayed priority-email visual. Do not answer from model memory.',
      ].join('\n'),
      complexity: 'simple',
      platform: false,
      providerIntent: {
        schemaVersion: 1,
        kind: 'priority-email',
        operation: 'priority-summary',
      },
    },
  };
}

const WEATHER_LOCATION_ACKNOWLEDGEMENT = /^(?:alright|all ?right|ok(?:ay)?|sure|thanks?|yes|yep)[.!]*$/i;
const WEATHER_LOCATION_CANCEL = /^(?:cancel|forget it|i do not know|i don't know|never ?mind|no|nope|not sure|stop)[.!]*$/i;
const NON_LOCATION_TOPIC_WORD = /\b(?:calendar|email|emails|inbox|mail|message|messages|reminder)\b/i;
const WEATHER_LOCATION_ASSERTION = /^(?:i(?:'m| am) in|i live in|my (?:city|location|zip(?: code)?) is)\s+/i;
const WEATHER_LOCATION_SELECTION = /^(?:please\s+)?(?:use|try)\s+/i;

// The downstream weather provider is NWS-only. A city/state answer is therefore accepted only when
// the suffix is a real US state/territory; a comma alone is not enough to turn a command into a
// place. Bare answers are closed over locations already supported without geocoding by the weather
// tool, plus the two command-shaped cities covered by regression tests. Arbitrary cities remain
// available through the explicit "I live in ..." grammar or the unambiguous "city, state" form.
const US_WEATHER_REGIONS = new Set([
  'al', 'alabama', 'ak', 'alaska', 'az', 'arizona', 'ar', 'arkansas', 'ca', 'california',
  'co', 'colorado', 'ct', 'connecticut', 'de', 'delaware', 'dc', 'district of columbia',
  'fl', 'florida', 'ga', 'georgia', 'hi', 'hawaii', 'id', 'idaho', 'il', 'illinois',
  'in', 'indiana', 'ia', 'iowa', 'ks', 'kansas', 'ky', 'kentucky', 'la', 'louisiana',
  'me', 'maine', 'md', 'maryland', 'ma', 'massachusetts', 'mi', 'michigan', 'mn', 'minnesota',
  'ms', 'mississippi', 'mo', 'missouri', 'mt', 'montana', 'ne', 'nebraska', 'nv', 'nevada',
  'nh', 'new hampshire', 'nj', 'new jersey', 'nm', 'new mexico', 'ny', 'new york',
  'nc', 'north carolina', 'nd', 'north dakota', 'oh', 'ohio', 'ok', 'oklahoma',
  'or', 'oregon', 'pa', 'pennsylvania', 'ri', 'rhode island', 'sc', 'south carolina',
  'sd', 'south dakota', 'tn', 'tennessee', 'tx', 'texas', 'ut', 'utah', 'vt', 'vermont',
  'va', 'virginia', 'wa', 'washington', 'wv', 'west virginia', 'wi', 'wisconsin',
  'wy', 'wyoming', 'as', 'american samoa', 'gu', 'guam', 'mp', 'northern mariana islands',
  'pr', 'puerto rico', 'vi', 'u.s. virgin islands', 'us virgin islands',
]);
const KNOWN_BARE_WEATHER_LOCATIONS = new Set([
  'atlanta', 'austin', 'boston', 'chicago', 'dallas', 'denver', 'destin', 'houston',
  'los angeles', 'miami', 'new york', 'phoenix', 'san antonio', 'san francisco', 'seattle',
  'show low', 'tell city', 'washington dc',
]);

function normalizeWeatherLocationKey(value: string): string {
  return value.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

function hasRecognizedWeatherRegion(candidate: string): boolean {
  const structured = candidate.match(
    /^[\p{L}][\p{L} .'-]{0,70},\s*([\p{L}][\p{L} .'-]{0,30})[.!]?$/u,
  );
  return Boolean(structured?.[1] && US_WEATHER_REGIONS.has(normalizeWeatherLocationKey(structured[1])));
}

export type WeatherLocationFollowUp =
  | { action: 'resolved'; intent: ProviderBoundHandoffIntent }
  | { action: 'keep' }
  | { action: 'clear' };

/**
 * @description Resolves a city/ZIP supplied after Jarvis asked for a missing weather location. The
 * original weather request remains authoritative; the follow-up contributes only a bounded literal
 * place and can never introduce a command, URL, or general tool invocation.
 */
export function resolveWeatherLocationFollowUp(
  pendingRequest: string,
  reply: string,
): ProviderBoundHandoffIntent | undefined {
  const classified = classifyWeatherLocationFollowUp(pendingRequest, reply);
  return classified.action === 'resolved' ? classified.intent : undefined;
}

/**
 * @description Classifies a weather-location follow-up reply into resolve/keep/clear. Exported so the
 * /ask route can advance the pending-clarification state machine directly.
 */
export function classifyWeatherLocationFollowUp(
  pendingRequest: string,
  reply: string,
): WeatherLocationFollowUp {
  const normalizedReply = String(reply || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  if (!normalizedReply || WEATHER_LOCATION_CANCEL.test(normalizedReply)) return { action: 'clear' };
  if (WEATHER_LOCATION_ACKNOWLEDGEMENT.test(normalizedReply)) return { action: 'keep' };

  const politeReply = normalizedReply.replace(/^please(?:\s*[:,])?\s+/i, '');
  const assertedLocation = WEATHER_LOCATION_ASSERTION.test(politeReply);

  const candidate = politeReply
    .replace(WEATHER_LOCATION_ASSERTION, '')
    .replace(WEATHER_LOCATION_SELECTION, '')
    .split(/\.\s+(?=(?:also|and|if|please|remember|save|then)\b)/i)[0]
    .replace(/\s*,?\s+(?:and\s+)?(?:if you could\s+)?(?:commit|remember|save)\b[\s\S]*$/i, '')
    .trim();
  const words = candidate.replace(/[.,!?]+$/g, '').trim().split(/\s+/).filter(Boolean);
  const zipLike = /^\d{5}(?:-\d{4})?$/.test(candidate.replace(/[.,!?]+$/g, '').trim());
  const structuredPlace = hasRecognizedWeatherRegion(candidate);
  // Capitalization is not a trust signal: speech transcripts commonly produce "new york". Limit
  // an unstructured place to four letter-only tokens, then separately reject command/topic shapes.
  const plainPlace = words.length > 0 && words.length <= 4 && words.every((word) => (
    /^[\p{L}][\p{L}'-]*$/u.test(word.replace(/[.,!?]+$/g, ''))
  ));
  const normalizedCandidate = normalizeWeatherLocationKey(candidate.replace(/[.,!?]+$/g, ''));
  const knownBarePlace = KNOWN_BARE_WEATHER_LOCATIONS.has(normalizedCandidate);
  if (
    NON_LOCATION_TOPIC_WORD.test(candidate)
    || (!zipLike && !structuredPlace && !knownBarePlace && !(assertedLocation && plainPlace))
  ) return { action: 'clear' };

  const location = extractWeatherIntentLocation(`weather in ${candidate}`);
  if (!location) return { action: 'clear' };

  const combined = `${String(pendingRequest || '').replace(/[.?!\s]+$/g, '').trim()} in ${location}`;
  const intent = detectProviderBoundHandoff(combined);
  return intent?.kind === 'weather' && intent.handoff.providerIntent
    ? { action: 'resolved', intent }
    : { action: 'clear' };
}
