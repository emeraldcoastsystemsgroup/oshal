/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Enforce the shared exact-subject contract for trusted provider execution without trimming or collapsing an invalid assertion into an ownerless request.
 */

import {
  parseVisualResponseProviderRecord,
  type VisualResponseProviderRecord,
} from '@/features/visual-response';
import { requireExactUserSubject } from '@/shared/security/exact-user-subject';

/** Server-authored read-only provider operations a bot node may execute without model mediation. */
export type TrustedProviderIntent =
  | {
    schemaVersion: 1;
    kind: 'weather';
    operation: 'current-forecast';
    location: string;
  }
  | {
    schemaVersion: 1;
    kind: 'priority-email';
    operation: 'priority-summary';
  }
  | {
    schemaVersion: 1;
    kind: 'walmart-catalog';
    operation: 'product-search';
    query: string;
    limit: number;
  };

export interface TrustedProviderExecutionContext {
  userSub?: string;
  creds: Record<string, string>;
}

export interface TrustedProviderExecutionResult {
  completion: string;
  providerRecords: VisualResponseProviderRecord[];
}

export interface TrustedProviderExecutionDeps {
  formatWeather(location: string): Promise<unknown>;
  gmailDigest(accessToken: string): Promise<unknown>;
  walmartSearch(credential: string, query: string, limit: number): Promise<unknown>;
  normalizeWeatherRecord(data: unknown): unknown;
  normalizeGmailRecord(data: unknown): unknown;
  normalizeWalmartCatalogRecord(data: unknown, query: string, retrievedAt?: string): unknown;
  now(): Date;
}

const SAFE_LOCATION = /^[\p{L}\p{N} _.,'-]{1,120}$/u;
const SAFE_PRODUCT_QUERY = /^[\p{L}\p{N}][\p{L}\p{N}\p{Zs}.,&'()/%+\-:]{0,199}$/u;

const TRUSTED_PROVIDER_AGENT_IDS: Readonly<Record<TrustedProviderIntent['kind'], string>> = {
  weather: 'a0000000-0000-0000-0000-000000000036',
  'priority-email': 'b0000000-0000-0000-0000-000000000001',
  'walmart-catalog': 'b0070000-0000-0000-0000-000000000001',
};

/** Dedicated least-privilege owner for a server-authored provider read. */
export function trustedProviderAgentId(intent: TrustedProviderIntent): string {
  return TRUSTED_PROVIDER_AGENT_IDS[intent.kind];
}

/**
 * Parse the complete intent object, rejecting unknown fields and shell-significant location text.
 * This is deliberately not a general tool-call schema: there is no command, URL, format, or args.
 */
export function parseTrustedProviderIntent(input: unknown): TrustedProviderIntent | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== 1 || typeof value.kind !== 'string' || typeof value.operation !== 'string') {
    return undefined;
  }
  if (value.kind === 'weather' && value.operation === 'current-forecast') {
    if (!hasExactKeys(value, ['schemaVersion', 'kind', 'operation', 'location'])) return undefined;
    const location = typeof value.location === 'string' ? value.location.trim() : '';
    if (!SAFE_LOCATION.test(location)) return undefined;
    return { schemaVersion: 1, kind: 'weather', operation: 'current-forecast', location };
  }
  if (value.kind === 'priority-email' && value.operation === 'priority-summary') {
    if (!hasExactKeys(value, ['schemaVersion', 'kind', 'operation'])) return undefined;
    return { schemaVersion: 1, kind: 'priority-email', operation: 'priority-summary' };
  }
  if (value.kind === 'walmart-catalog' && value.operation === 'product-search') {
    if (!hasExactKeys(value, ['schemaVersion', 'kind', 'operation', 'query', 'limit'])) return undefined;
    const query = typeof value.query === 'string' ? value.query.trim() : '';
    const limit = value.limit;
    if (typeof limit !== 'number' || !SAFE_PRODUCT_QUERY.test(query) || !Number.isInteger(limit) || limit < 1 || limit > 6) {
      return undefined;
    }
    return { schemaVersion: 1, kind: 'walmart-catalog', operation: 'product-search', query, limit };
  }
  return undefined;
}

/** Extract a bounded literal place from a weather request; never reinterpret the request as code. */
export function extractWeatherIntentLocation(message: string): string | undefined {
  const normalized = String(message || '').replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').trim();
  const candidates: string[] = [];
  const locationPattern = /\b(?:in|near|at)\s+([\p{L}\p{N}][\p{L}\p{N} _.,'-]{0,119}?)(?=\s+(?:today|tonight|tomorrow|now|right now|this (?:morning|afternoon|evening|week|weekend))\b|[?!]|$)/giu;
  let match: RegExpExecArray | null;
  while ((match = locationPattern.exec(normalized)) !== null) candidates.push(match[1]);

  const forecastFor = normalized.match(
    /\b(?:weather|forecast|temperature|conditions?)\s+(?:at|for|in|near)\s+([\p{L}\p{N}][\p{L}\p{N} _.,'-]{0,119}?)(?=\s+(?:today|tonight|tomorrow|now|right now|this (?:morning|afternoon|evening|week|weekend))\b|[?!]|$)/iu,
  );
  if (forecastFor) candidates.push(forecastFor[1]);

  const tripLocation = normalized.match(
    /\b(?:for|during)\s+(?:my|our|the)\s+([\p{L}\p{N}][\p{L}\p{N} _.,'-]{0,80}?)\s+(?:trip|visit|vacation|stay)\b/iu,
  );
  if (tripLocation && !/^(?:beach|business|family|holiday|next|road|summer|upcoming|weekend|winter)$/i.test(tripLocation[1].trim())) {
    candidates.push(tripLocation[1]);
  }

  for (const candidate of candidates.reverse()) {
    const location = candidate.replace(/[.,\s]+$/g, '').trim();
    if (SAFE_LOCATION.test(location)) return location;
  }
  return undefined;
}

/**
 * Execute one exact provider read without a shell or model-authored arguments. The caller must have
 * already authenticated the controller request; an owner is still mandatory as defense in depth.
 */
export async function executeTrustedProviderIntent(
  input: unknown,
  context: TrustedProviderExecutionContext,
  deps: TrustedProviderExecutionDeps = defaultExecutionDeps(),
): Promise<TrustedProviderExecutionResult> {
  const intent = parseTrustedProviderIntent(input);
  if (!intent) throw new Error('Invalid trusted provider intent');
  requireExactUserSubject(context.userSub, 'trusted provider owner');

  if (intent.kind === 'weather') {
    const result = await deps.formatWeather(intent.location) as { success?: unknown; data?: unknown; error?: unknown };
    if (result?.success !== true || !result.data) throw new Error('Weather provider lookup failed');
    const record = parseVisualResponseProviderRecord(deps.normalizeWeatherRecord(result.data));
    if (!record || record.kind !== 'nws-weather') throw new Error('Weather provider returned an invalid record');
    return {
      completion: `Live weather provider lookup completed for ${record.record.location}.`,
      providerRecords: [record],
    };
  }

  if (intent.kind === 'walmart-catalog') {
    const credential = context.creds.OSHAL_CRED_WALMART;
    if (typeof credential !== 'string' || !credential || credential.length > 32_768) {
      throw new Error('Walmart catalog provider intent requires a request-scoped Walmart credential');
    }
    const result = await deps.walmartSearch(credential, intent.query, intent.limit) as {
      source?: unknown;
      retrievedAt?: unknown;
      items?: unknown;
    };
    if (result?.source !== 'walmart' || !Array.isArray(result.items)) {
      throw new Error('Walmart catalog provider lookup failed');
    }
    const retrievedAt = typeof result.retrievedAt === 'string' ? result.retrievedAt : undefined;
    const record = parseVisualResponseProviderRecord(
      deps.normalizeWalmartCatalogRecord(result, intent.query, retrievedAt),
    );
    if (!record || record.kind !== 'walmart-catalog') {
      throw new Error('Walmart catalog provider returned an invalid record');
    }
    return {
      completion: `Live Walmart catalog lookup completed for ${record.items.length} ${record.items.length === 1 ? 'product' : 'products'}.`,
      providerRecords: [record],
    };
  }

  const accessToken = context.creds.OSHAL_CRED_GOOGLE;
  if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 32_768) {
    throw new Error('Priority email provider intent requires a request-scoped Google credential');
  }
  const emails = await deps.gmailDigest(accessToken);
  if (!Array.isArray(emails)) throw new Error('Gmail provider lookup failed');
  const retrievedAt = deps.now().toISOString();
  const record = parseVisualResponseProviderRecord(deps.normalizeGmailRecord({
    account: 'connected Gmail',
    retrievedAt,
    emails,
  }));
  if (!record || record.kind !== 'gmail-summary') throw new Error('Gmail provider returned an invalid record');
  return {
    completion: 'Priority inbox provider lookup completed.',
    providerRecords: [record],
  };
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const expected = new Set(allowed);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

function defaultExecutionDeps(): TrustedProviderExecutionDeps {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const weatherTools = require('../../any-bot/server/services/tools/weatherTools') as {
    'format-weather': (input: { location: string; format: 'json' }) => Promise<unknown>;
  };
  const gmail = require('../../scripts/oshal-gmail.js') as {
    gmailDigest: (accessToken: string) => Promise<unknown>;
  };
  const walmart = require('../../scripts/oshal-walmart.js') as {
    searchLiveCatalog: (credential: string, query: string, limit: number) => Promise<unknown>;
  };
  const normalizers = require('../../any-bot/server/services/codebase/provider-record-capture.js') as {
    normalizeWeatherRecord: (data: unknown) => unknown;
    normalizeGmailRecord: (data: unknown) => unknown;
    normalizeWalmartCatalogRecord: (data: unknown, query: string, retrievedAt?: string) => unknown;
  };
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    formatWeather: (location) => weatherTools['format-weather']({ location, format: 'json' }),
    gmailDigest: (accessToken) => gmail.gmailDigest(accessToken),
    walmartSearch: (credential, query, limit) => walmart.searchLiveCatalog(credential, query, limit),
    normalizeWeatherRecord: normalizers.normalizeWeatherRecord,
    normalizeGmailRecord: normalizers.normalizeGmailRecord,
    normalizeWalmartCatalogRecord: normalizers.normalizeWalmartCatalogRecord,
    now: () => new Date(),
  };
}
