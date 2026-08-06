/**
 * Connector spec → client generator (ADR-065 Phase 2).
 *
 * Turns a declarative `connector.yaml` (validated against swarm-apps/connector.schema.json) into a
 * working ConnectorClient plus one callable per declared resource. This is what makes catalog depth
 * a throughput problem: a connector becomes a DOCUMENT (auth + baseUrl + rate-limit + resources)
 * plus, at most, a tiny response transform — not a fresh hand-written HTTP client.
 *
 * Credentials are NOT baked into the spec. The spec declares the auth *shape* (oauth2 bearer,
 * apiKeyHeader, apiKeyQuery, basic); the actual token/key is supplied at build time by the caller
 * (the ADR-056 broker on the controller path), keeping secrets out of the manifest and out of git.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-065 Phase 2. Additive.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add ${env:NAME:-default} interpolation in
 *            | loadConnectorSpec so per-tenant connectors (Dynatrace env-id, Salesforce instance host —
 *            | ADR-069) can resolve their baseUrl/headers from operator env without per-deploy yaml
 *            | edits. Distinct token from {placeholder} runtime binding; only ${env:...} is touched.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | SpecPagination gains `cursorOnly` →
 *            | cursor `exclusive`: Dynatrace v2 rejects nextPageKey combined with the original
 *            | query params, so follow-up pages must send only the cursor. Opt-in, additive.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ConnectorSpec gains the optional
 *            | write-capable `actions` block (connector-writes tier): declared mutations with a
 *            | paramsSchema + riskLevel, validated at load time. Additive — the 306 GET-only
 *            | connectors are untouched; execution lives in action-executor.ts, never here.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Preserve source-catalog category vocabulary separately from operation tags so category derivation can retain provenance without treating arbitrary tag text as a reviewed taxonomy.
 * -----------------------------------------------------------------------------
 * @module connectors/runtime/spec
 */

import { readFileSync } from 'fs';
import yaml from 'js-yaml';
import { ConnectorClient } from './connector-client';
import { validateSpecActions, type SpecAction } from './action-params';
import type { AuthSpec, PaginationStrategy, RequestOptions, RetryPolicy, TokenProvider } from './types';

export type SpecAuth =
  | { type: 'none' }
  | { type: 'oauth2'; tokenAuth?: 'basic' | 'body'; scopes?: string[] }
  | { type: 'basic' }
  | { type: 'apiKeyHeader'; header: string }
  | { type: 'apiKeyQuery'; param: string };

export interface SpecResource {
  name: string;
  tool?: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string>;
  /** Extra request headers (merged over the spec-level headers); values may template {placeholders}. */
  headers?: Record<string, string>;
  body?: unknown;
  output?: string;
  retry?: Partial<RetryPolicy>;
  emptyOk?: number[];
  /** When true, walk all pages using the spec-level pagination strategy and return flattened items. */
  paginate?: boolean;
  /** Action safety hints for bot execution and marketplace display. Inferred when omitted. */
  safety?: {
    action?: 'read' | 'write' | 'destructive';
    requiresConfirmation?: boolean;
    supportsDryRun?: boolean;
    idempotent?: boolean;
  };
}

export interface SpecPagination {
  strategy: 'cursor' | 'offset' | 'link' | 'link-header';
  param?: string;
  /** Dot-path to the field holding the next cursor (cursor) or the "more pages" marker (offset). */
  nextField?: string;
  pageSize?: number;
  /** Dot-path to the array of items in each page (default 'items', e.g. 'results' for TMDB). */
  itemsField?: string;
  /** Cursor only: follow-up pages send ONLY the cursor param. Dynatrace Environment v2 (and kin)
   *  reject nextPageKey combined with the original query params — the cursor encodes them. */
  cursorOnly?: boolean;
}

export interface ConnectorSpec {
  provider: string;
  /** Broker provider key for token resolution when it differs from the route name (e.g. gmail -> google). */
  credProvider?: string;
  displayName?: string;
  version?: string;
  /** Optional catalog metadata. Keeps the spec self-describing without mounting/enabling it. */
  metadata?: {
    description?: string;
    /**
     * Marketplace shelf label. 51 specs already declared this and the runtime IGNORED it (the
     * marketplace only read `description`), so a hand-curated category had no effect — see
     * runtime/curation.ts, which is now the one place a category is resolved.
     */
    category?: string;
    tags?: string[];
    icon?: string;
    iconTitle?: string;
    iconSource?: string;
    iconVerified?: boolean;
    iconUrl?: string;
    website?: string;
    sourceCatalog?: string;
    sourceUrl?: string;
    /** Category tokens declared by the source catalog, not inferred from operation names. */
    sourceCategories?: string[];
  };
  baseUrl: string;
  auth: SpecAuth;
  rateLimit?: { burst?: number; perSecond?: number };
  retry?: Partial<RetryPolicy>;
  timeoutMs?: number;
  /** Headers sent on every request (e.g. a provider API-version header); values may template. */
  headers?: Record<string, string>;
  pagination?: SpecPagination;
  resources: SpecResource[];
  /** Optional write-capable action tier (connector-writes): explicit, param-schema'd mutations
   *  executed via POST /api/connectors/:id/actions/:action with approval gating + audit.
   *  Absent on GET-only connectors — the catalog default. */
  actions?: SpecAction[];
  webhooks?: Array<{ event: string; verify: Record<string, unknown> }>;
}

/** Credentials + overrides supplied at build time — NEVER from the spec file. */
export interface BuildSpecOptions {
  /** oauth2 → the bearer TokenProvider (wrap getValidAccessToken). */
  token?: TokenProvider;
  /** basic auth. */
  username?: string;
  password?: string;
  /** apiKeyHeader / apiKeyQuery → the key value (from the broker / operator cred). */
  apiKeyValue?: string;
  fetchImpl?: typeof fetch;
  onCall?: ConstructorParameters<typeof ConnectorClient>[0]['onCall'];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SpecClient {
  spec: ConnectorSpec;
  client: ConnectorClient;
  /** Invoke a declared resource by name, binding {placeholders} from `inputs`. */
  call<T = any>(resource: string, inputs?: Record<string, unknown>): Promise<T>;
  /** Resource names exposed as bot tools (resource.tool set). */
  tools(): Array<{ tool: string; resource: string }>;
}

// --- validation (lightweight; the JSON Schema is the formal contract) --------

/** Throw a clear error if the parsed object isn't a usable spec. */
export function validateSpec(raw: unknown): ConnectorSpec {
  const s = raw as ConnectorSpec;
  const fail = (m: string): never => { throw new Error(`invalid connector spec: ${m}`); };
  if (!s || typeof s !== 'object') fail('not an object');
  if (!s.provider || !/^[a-z0-9][a-z0-9-]*$/.test(s.provider)) fail('provider must be a lowercase slug');
  if (!s.baseUrl || !/^https?:\/\//.test(s.baseUrl)) fail(`baseUrl must be http(s): got ${s.baseUrl}`);
  if (!s.auth || typeof s.auth.type !== 'string') fail('auth.type required');
  if (s.auth.type === 'apiKeyHeader' && !(s.auth as any).header) fail('apiKeyHeader auth needs header');
  if (s.auth.type === 'apiKeyQuery' && !(s.auth as any).param) fail('apiKeyQuery auth needs param');
  if (!Array.isArray(s.resources) || s.resources.length === 0) fail('resources must be a non-empty array');
  for (const r of s.resources) {
    if (!r.name) fail('resource missing name');
    if (!r.method) fail(`resource ${r.name} missing method`);
    if (!r.path) fail(`resource ${r.name} missing path`);
  }
  validateSpecActions(s.provider, s.actions);
  return s;
}

/**
 * Resolve `${env:NAME}` / `${env:NAME:-default}` tokens in a string from process.env.
 * Per-tenant connectors (Dynatrace env-id host, Salesforce instance host — ADR-069) declare their
 * baseUrl/headers this way so the operator sets one env var instead of editing baked-in yaml.
 * The single-brace `{placeholder}` runtime binding is a different token and is left untouched.
 */
function interpolateEnv(value: string): string {
  return value.replace(/\$\{env:([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_, name, fallback) =>
    process.env[name] ?? fallback ?? '');
}

/** Deep-interpolate `${env:...}` tokens across every string in a parsed spec object. */
function interpolateEnvDeep<T>(node: T): T {
  if (typeof node === 'string') return interpolateEnv(node) as unknown as T;
  if (Array.isArray(node)) return node.map((item) => interpolateEnvDeep(item)) as unknown as T;
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = interpolateEnvDeep(v);
    return out as T;
  }
  return node;
}

/** Load + validate a connector.yaml from disk. */
export function loadConnectorSpec(filePath: string): ConnectorSpec {
  const text = readFileSync(filePath, 'utf8');
  return validateSpec(interpolateEnvDeep(yaml.load(text)));
}

// --- templating --------------------------------------------------------------

/** Whole-value bind ("{tracks}") preserves type; otherwise interpolate into the string. */
function renderValue(v: unknown, inputs: Record<string, unknown>): unknown {
  if (typeof v === 'string') {
    const whole = v.match(/^\{(\w+)\}$/);
    if (whole) return inputs[whole[1]];
    return v.replace(/\{(\w+)\}/g, (_, k) => (inputs[k] === undefined || inputs[k] === null ? '' : String(inputs[k])));
  }
  if (Array.isArray(v)) return v.map((x) => renderValue(x, inputs));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = renderValue(val, inputs);
    return out;
  }
  return v;
}

function renderPath(tmpl: string, inputs: Record<string, unknown>): string {
  return tmpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(String(inputs[k] ?? '')));
}

function getField(obj: any, dotPath?: string): any {
  if (!dotPath) return undefined;
  return dotPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function toPagination(p: SpecPagination): PaginationStrategy {
  if (p.strategy === 'cursor') return { type: 'cursor', param: p.param || 'cursor', nextFrom: (page) => getField(page, p.nextField) ?? null, exclusive: p.cursorOnly === true };
  if (p.strategy === 'offset') return { type: 'offset', param: p.param || 'offset', pageSize: p.pageSize || 20, isLastPage: (page) => !getField(page, p.nextField) };
  if (p.strategy === 'link-header') return { type: 'link-header' };
  return { type: 'link', nextField: p.nextField };
}

function toAuth(spec: ConnectorSpec, opts: BuildSpecOptions): AuthSpec {
  switch (spec.auth.type) {
    case 'oauth2':
      if (!opts.token) throw new Error(`${spec.provider}: oauth2 spec requires a token provider at build time`);
      return { type: 'bearer', token: opts.token };
    case 'basic':
      return { type: 'basic', username: opts.username || '', password: opts.password || '' };
    case 'apiKeyHeader':
      return { type: 'apiKeyHeader', header: spec.auth.header, value: opts.apiKeyValue || '' };
    case 'apiKeyQuery':
      return { type: 'apiKeyQuery', param: spec.auth.param, value: opts.apiKeyValue || '' };
    case 'none':
    default:
      return { type: 'none' };
  }
}

// --- the generator -----------------------------------------------------------

/** Build a callable client from a validated spec + build-time credentials. */
export function buildClientFromSpec(spec: ConnectorSpec, opts: BuildSpecOptions = {}): SpecClient {
  validateSpec(spec);
  const client = new ConnectorClient({
    provider: spec.provider,
    baseUrl: spec.baseUrl,
    auth: toAuth(spec, opts),
    retry: spec.retry,
    rateLimit: spec.rateLimit,
    timeoutMs: spec.timeoutMs,
    fetchImpl: opts.fetchImpl,
    onCall: opts.onCall,
    now: opts.now,
    sleep: opts.sleep,
  });
  const byName = new Map(spec.resources.map((r) => [r.name, r]));

  const call = async <T = any>(resource: string, inputs: Record<string, unknown> = {}): Promise<T> => {
    const r = byName.get(resource);
    if (!r) throw new Error(`${spec.provider}: unknown resource '${resource}'`);
    const path = renderPath(r.path, inputs);
    const query = r.query ? (renderValue(r.query, inputs) as RequestOptions['query']) : undefined;
    const body = r.body !== undefined ? renderValue(r.body, inputs) : undefined;
    const mergedHeaders = (spec.headers || r.headers) ? { ...(spec.headers || {}), ...(r.headers || {}) } : undefined;
    const headers = mergedHeaders ? (renderValue(mergedHeaders, inputs) as Record<string, string>) : undefined;
    const reqOpts: RequestOptions = { method: r.method, query, headers, body, retry: r.retry, emptyOk: r.emptyOk };
    if (r.paginate && spec.pagination) {
      const itemsField = spec.pagination.itemsField;
      // Robust extract: a bare-array body (GitHub /user/repos) IS the list; otherwise read itemsField (default 'items').
      const extract = (page: any) => (Array.isArray(page) ? page : (getField(page, itemsField || 'items') || []));
      return client.paginate<any>(path, toPagination(spec.pagination), reqOpts, extract) as Promise<T>;
    }
    return client.request<T>(path, reqOpts);
  };

  const tools = () => spec.resources.filter((r) => r.tool).map((r) => ({ tool: r.tool!, resource: r.name }));
  return { spec, client, call, tools };
}
