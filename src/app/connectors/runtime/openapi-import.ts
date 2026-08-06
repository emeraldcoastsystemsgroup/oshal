/**
 * OpenAPI -> ConnectorSpec import (ADR-065 Phase 3).
 *
 * The breadth multiplier: most SaaS providers publish an OpenAPI document. Point this at one and get
 * a DRAFT connector.yaml (a ConnectorSpec) — auth shape, baseUrl, and one resource per operation with
 * path/query placeholders already wired. You then hand-tune auth scopes, rate limits, pagination, and
 * webhooks. This is how the catalog reaches "hundreds" without hand-writing each client.
 *
 * It is intentionally conservative: it maps what OpenAPI states unambiguously and emits `warnings`
 * for everything a human must confirm (opaque request bodies, multiple security schemes, no servers).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-065 Phase 3. Additive.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Preserve validated x-apisguru-categories as source-category evidence distinct from operation tags.
 * -----------------------------------------------------------------------------
 * @module connectors/runtime/openapi-import
 */

import { inferConnectorActionType, requiresConnectorConfirmation, supportsConnectorDryRun } from './action-safety';
import type { ConnectorSpec, SpecAuth, SpecResource } from './spec';

interface OpenApiParam { name?: string; in?: string; required?: boolean }
interface OpenApiOperation { operationId?: string; summary?: string; description?: string; tags?: string[]; parameters?: OpenApiParam[]; requestBody?: unknown }
interface OpenApiDoc {
  info?: {
    title?: string;
    description?: string;
    version?: string;
    contact?: { url?: string };
    termsOfService?: string;
    'x-apisguru-categories'?: unknown;
  };
  servers?: Array<{ url?: string }>;
  components?: { securitySchemes?: Record<string, { type?: string; scheme?: string; in?: string; name?: string }> };
  paths?: Record<string, Record<string, OpenApiOperation>>;
  tags?: Array<{ name?: string; description?: string }>;
  externalDocs?: { url?: string };
}

export interface ImportResult {
  spec: ConnectorSpec;
  warnings: string[];
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** Slugify a path into a resource name when there's no operationId, e.g. GET /movie/{id} -> get-movie-by-id. */
function nameFromPath(method: string, path: string): string {
  const parts = path.split('/').filter(Boolean).map((p) => (p.startsWith('{') ? `by-${p.slice(1, -1)}` : p));
  return [method, ...parts].join('-').replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').toLowerCase();
}

function slugify(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/** Preserve only bounded source-category tokens; malformed extensions remain visible as warnings. */
function sourceCategoriesFromInfo(info: OpenApiDoc['info'], warnings: string[]): string[] | undefined {
  const raw = info?.['x-apisguru-categories'];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    warnings.push('x-apisguru-categories is not an array — source categories omitted');
    return undefined;
  }
  const categories = raw
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().toLowerCase().replace(/[\s-]+/g, '_'))
    .filter((value) => /^[a-z0-9_]+$/.test(value));
  if (categories.length !== raw.length) {
    warnings.push('x-apisguru-categories contains invalid values — invalid source categories omitted');
  }
  const unique = Array.from(new Set(categories)).sort();
  return unique.length ? unique : undefined;
}

/** Map the first declared OpenAPI security scheme to our auth shape. */
function authFromSchemes(schemes: OpenApiDoc['components'], warnings: string[]): SpecAuth {
  const all = Object.values(schemes?.securitySchemes || {});
  if (all.length === 0) { warnings.push('no securitySchemes — defaulting auth to none; set it manually'); return { type: 'none' }; }
  if (all.length > 1) warnings.push(`${all.length} security schemes found — using the first; confirm the right one`);
  const s = all[0];
  if (s.type === 'http' && (s.scheme || '').toLowerCase() === 'bearer') return { type: 'oauth2' };
  if (s.type === 'http' && (s.scheme || '').toLowerCase() === 'basic') return { type: 'basic' };
  if (s.type === 'oauth2') return { type: 'oauth2' };
  if (s.type === 'apiKey' && s.in === 'query' && s.name) return { type: 'apiKeyQuery', param: s.name };
  if (s.type === 'apiKey' && s.in === 'header' && s.name) return { type: 'apiKeyHeader', header: s.name };
  warnings.push(`unrecognized security scheme '${s.type}' — defaulting to none`);
  return { type: 'none' };
}

/** Build a draft ConnectorSpec from an OpenAPI 3 document. */
export function specFromOpenApi(provider: string, doc: OpenApiDoc, opts?: { displayName?: string; icon?: string; sourceUrl?: string; sourceCatalog?: string }): ImportResult {
  const warnings: string[] = [];
  const baseUrl = doc.servers?.[0]?.url || '';
  if (!baseUrl) warnings.push('no servers[].url — baseUrl is empty, set it manually');

  const resources: SpecResource[] = [];
  const tags = new Set<string>();
  for (const tag of doc.tags || []) {
    if (tag.name) tags.add(slugify(tag.name));
  }
  const seenNames = new Set<string>();
  for (const [path, ops] of Object.entries(doc.paths || {})) {
    for (const method of METHODS) {
      const op = ops[method];
      if (!op) continue;
      for (const tag of op.tags || []) tags.add(slugify(tag));
      let name = (op.operationId || nameFromPath(method, path)).replace(/[^a-zA-Z0-9-]/g, '-');
      if (seenNames.has(name)) { name = `${name}-${method}`; warnings.push(`duplicate operation name; renamed to ${name}`); }
      seenNames.add(name);

      const query: Record<string, string> = {};
      for (const p of op.parameters || []) {
        if (p.in === 'query' && p.name) query[p.name] = `{${p.name}}`;
        // path params are already {name} in the OpenAPI path and bind directly.
      }
      const resource: SpecResource = { name, tool: `${provider}-${slugify(name)}`, method: method.toUpperCase() as SpecResource['method'], path };
      if (Object.keys(query).length) resource.query = query;
      if (op.requestBody) { resource.body = '{body}'; warnings.push(`${name}: request body is opaque — map fields by hand`); }
      if (method !== 'get') resource.retry = { maxRetries: 0 }; // non-GET defaults to no auto-retry (duplicate-write safe)
      const action = inferConnectorActionType(resource);
      resource.safety = {
        action,
        requiresConfirmation: requiresConnectorConfirmation(resource),
        supportsDryRun: supportsConnectorDryRun(resource),
        idempotent: action === 'read',
      };
      resources.push(resource);
    }
  }
  if (resources.length === 0) warnings.push('no operations found in paths');

  const spec: ConnectorSpec = {
    provider,
    displayName: opts?.displayName || doc.info?.title || provider,
    version: doc.info?.version,
    metadata: {
      description: doc.info?.description,
      tags: Array.from(tags).filter(Boolean).sort(),
      icon: opts?.icon,
      iconSource: opts?.icon ? 'importer-guess' : undefined,
      iconVerified: false,
      website: doc.externalDocs?.url || doc.info?.contact?.url,
      sourceCatalog: opts?.sourceCatalog,
      sourceUrl: opts?.sourceUrl,
      sourceCategories: sourceCategoriesFromInfo(doc.info, warnings),
    },
    baseUrl,
    auth: authFromSchemes(doc.components, warnings),
    rateLimit: { burst: 10, perSecond: 10 }, // conservative default — tune to the provider's real limits
    retry: { maxRetries: 3, honorRetryAfter: true },
    resources,
  };
  return { spec, warnings };
}
