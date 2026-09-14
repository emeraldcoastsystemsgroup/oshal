/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | App-layer adapters for the data-model explorer's ports: the platform pool, a lazily-created one-connection TimescaleDB pool (TSDB_URL), installed app records (unredacted, server-internal - the route that serves them is operator-only), and read-only inventories of ArangoDB (databases, collections, counts), ChromaDB (collections, counts) and Redis (key families + value types, never values). Every external call is bounded by a timeout and every client is closed after use.
 */

import { Pool } from 'pg';
import Redis from 'ioredis';
import { Database } from 'arangojs';
import { createChildLogger } from '@/shared/logger';
import {
  readCatalog, tallyFamilies, noDatabaseError,
  type AppRecordLite, type CatalogQueryable, type CatalogSnapshot, type DataModelPorts, type StoreCollection, type StoreInventory,
} from '@/features/data-model';

const logger = createChildLogger({ module: 'data-model-ports' });
const TIMEOUT_MS = 8_000;
const MAX_GRAPH_DBS = 60;
const MAX_VECTOR_COLLECTIONS = 150;
const MAX_REDIS_KEYS = 20_000;
const TYPE_SAMPLE = 25;

/** The two app-service reads the explorer needs (SwarmAppService satisfies it). */
export interface ExplorerAppSource {
  listApps(): Promise<Array<{ name: string }>>;
  getApp(name: string): Promise<{ name: string; displayName: string; version: string; status: string; manifestPath: string; manifest: unknown } | null>;
}

/**
 * @description Reject a promise that outlives its budget, so one hung store cannot hold the page.
 * @param label - what is being awaited (for the error)
 * @param work - the promise
 * @param ms - budget in milliseconds
 * @returns the promise's value
 */
function withTimeout<T>(label: string, work: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @description Read a catalog for whichever database the queryable is connected to.
 * @param db - pool or client
 * @returns the folded catalog
 */
async function catalogOf(db: CatalogQueryable): Promise<CatalogSnapshot> {
  const res = await db.query('SELECT current_database() AS db');
  return readCatalog(db, String(res.rows[0]?.db ?? 'unknown'));
}

let timeseriesPool: Pool | null = null;

/**
 * @description The TimescaleDB catalog, when TSDB_URL is configured (one pooled connection, reused).
 * @returns the catalog, or null when no time-series store is configured
 */
async function timeseriesCatalog(): Promise<CatalogSnapshot | null> {
  const url = process.env.TSDB_URL;
  if (!url) return null;
  timeseriesPool ||= new Pool({ connectionString: url, max: 1, idleTimeoutMillis: 30_000, connectionTimeoutMillis: TIMEOUT_MS });
  return withTimeout('time-series catalog', catalogOf(timeseriesPool));
}

/**
 * @description ArangoDB inventory: every graph database (per-person `g_p_*`, per-tenant `g_t_*`),
 * its collections and document counts.
 * @returns the inventory card
 */
async function graphInventory(): Promise<StoreInventory> {
  const url = process.env.ARANGO_URL;
  if (!url) return { store: 'graph', engine: 'ArangoDB', status: 'not-configured', detail: 'ARANGO_URL is unset; the graph tier is optional (ADR-045).' };
  const sys = new Database({ url, auth: { username: process.env.ARANGO_ROOT_USER || 'root', password: process.env.ARANGO_ROOT_PASSWORD || '' } });
  try {
    const names = (await withTimeout('arango databases', sys.listDatabases())).filter((n) => n !== '_system').sort();
    const databases: Array<{ name: string; collections: StoreCollection[] }> = [];
    for (const name of names.slice(0, MAX_GRAPH_DBS)) {
      const cols = await withTimeout(`arango ${name} collections`, sys.database(name).collections(true));
      const collections: StoreCollection[] = [];
      for (const c of cols) collections.push({ name: c.name, count: (await withTimeout(`arango ${name}.${c.name} count`, c.count())).count });
      databases.push({ name, collections });
    }
    const more = names.length > MAX_GRAPH_DBS ? `; the first ${MAX_GRAPH_DBS} are listed` : '';
    return { store: 'graph', engine: 'ArangoDB', status: 'ok', detail: `${names.length} graph databases${more}.`, databases };
  } finally {
    sys.close();
  }
}

/**
 * @description ChromaDB inventory: every collection and its record count.
 * @returns the inventory card
 */
async function vectorInventory(): Promise<StoreInventory> {
  const url = process.env.CHROMADB_URL;
  if (!url) return { store: 'vector', engine: 'ChromaDB', status: 'not-configured', detail: 'CHROMADB_URL is unset.' };
  const res = await fetch(`${url}/api/v1/collections`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`collections list returned HTTP ${res.status}`);
  const all = ((await res.json()) as Array<{ id: string; name: string }>).sort((a, b) => a.name.localeCompare(b.name));
  const collections: StoreCollection[] = [];
  for (const c of all.slice(0, MAX_VECTOR_COLLECTIONS)) {
    const r = await fetch(`${url}/api/v1/collections/${encodeURIComponent(c.id)}/count`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    collections.push({ name: c.name, count: r.ok ? Number(await r.json()) : null });
  }
  const more = all.length > MAX_VECTOR_COLLECTIONS ? `; the first ${MAX_VECTOR_COLLECTIONS} are listed` : '';
  return { store: 'vector', engine: 'ChromaDB', status: 'ok', detail: `${all.length} collections${more}.`, collections };
}

/**
 * @description Redis inventory: SCAN (never KEYS) up to a cap, grouped into key families with the
 * value TYPE of a small sample per family. No value is ever read.
 * @returns the inventory card
 */
async function cacheInventory(): Promise<StoreInventory> {
  const url = process.env.REDIS_URL;
  if (!url) return { store: 'cache', engine: 'Redis', status: 'not-configured', detail: 'REDIS_URL is unset.' };
  const redis = new Redis(url, { lazyConnect: true, connectTimeout: TIMEOUT_MS, commandTimeout: TIMEOUT_MS, maxRetriesPerRequest: 1, enableOfflineQueue: false });
  try {
    await redis.connect();
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(cursor, 'COUNT', 1000);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0' && keys.length < MAX_REDIS_KEYS);
    const tallies = tallyFamilies(keys.slice(0, MAX_REDIS_KEYS), TYPE_SAMPLE);
    const pipeline = redis.pipeline();
    for (const t of tallies) for (const k of t.sample) pipeline.type(k);
    const results = (await pipeline.exec()) ?? [];
    let i = 0;
    const families = tallies.map((t) => {
      const types: Record<string, number> = {};
      for (let n = 0; n < t.sample.length; n += 1, i += 1) { const type = String(results[i]?.[1] ?? 'unknown'); types[type] = (types[type] ?? 0) + 1; }
      return { prefix: t.prefix, keys: t.keys, types };
    });
    const capped = cursor !== '0' ? ` (stopped at the ${MAX_REDIS_KEYS}-key scan cap)` : '';
    return { store: 'cache', engine: 'Redis', status: 'ok', detail: `${keys.length} keys in ${families.length} families${capped}.`, families };
  } finally {
    redis.disconnect();
  }
}

/**
 * @description Installed app records, unredacted: the manifest path locates the package's code and
 * the manifest carries its declared integrations. Served only through the operator-gated route.
 * @param source - the app service
 * @returns records for every installed app
 */
async function appRecords(source: ExplorerAppSource): Promise<AppRecordLite[]> {
  const out: AppRecordLite[] = [];
  for (const summary of await source.listApps()) {
    const rec = await source.getApp(summary.name);
    if (!rec) { logger.warn({ app: summary.name }, 'data-model: listed app has no record'); continue; }
    out.push({ name: rec.name, displayName: rec.displayName, version: rec.version, status: rec.status, manifestPath: rec.manifestPath, manifest: (rec.manifest ?? {}) as Record<string, unknown> });
  }
  return out;
}

/**
 * @description Wire the explorer's ports to this deployment.
 * @param deps - the platform pool (null in pool-less runs), the app source, and the image/repo root
 * @returns the ports
 */
export function createDataModelPorts(deps: { pool: CatalogQueryable | null; apps: () => ExplorerAppSource; repoRoot?: string }): DataModelPorts {
  return {
    repoRoot: deps.repoRoot ?? process.cwd(),
    readPlatformCatalog: async () => {
      if (!deps.pool) throw noDatabaseError();
      return catalogOf(deps.pool);
    },
    listApps: () => appRecords(deps.apps()),
    readTimeseriesCatalog: timeseriesCatalog,
    graphInventory,
    vectorInventory,
    cacheInventory,
  };
}
