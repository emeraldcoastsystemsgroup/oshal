/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Data-model explorer service: assembles the snapshot (Postgres catalogs, declaration scan of core + every installed package, ownership, integration map) and the non-relational store inventories, each cached for a TTL with concurrent callers sharing one in-flight build. Every input arrives through DataModelPorts, so the slice imports no other feature and every store can be doubled in tests.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { createChildLogger } from '@/shared/logger';
import { CORE_SOURCE_DIRS, scanDeclarations, type ScanRoot } from './declaration-scanner';
import { attributeOwnership, databaseLinks } from './ownership';
import { buildIntegrationMap } from './integration-map';
import {
  CORE_OWNER,
  type AppRecordLite, type CatalogSnapshot, type DataModelPorts, type DataModelSnapshot, type StoreInventory,
} from '../types';

const logger = createChildLogger({ module: 'data-model-service' });
const DEFAULT_TTL_MS = 5 * 60_000;
const PACKAGE_MANIFEST = 'oshal-app.yaml';

/** What the explorer route calls. */
export interface DataModelService {
  snapshot(refresh?: boolean): Promise<DataModelSnapshot>;
  stores(refresh?: boolean): Promise<StoreInventory[]>;
}

/** A cached value with its build time and any in-flight rebuild. */
interface Cached<T> { value: T | null; builtAt: number; inflight: Promise<T> | null }

/**
 * @description Whether a path exists as a directory.
 * @param dir - absolute path
 * @returns true for an existing directory
 */
async function isDir(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch (err) {
    // An absent optional root (docker/ is not in the image) is expected; anything else is not.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') logger.debug({ dir }, 'data-model: optional scan root absent');
    else logger.error({ err, dir }, 'data-model: scan root unreadable');
    return false;
  }
}

/**
 * @description The directories to scan: core source under the repo root, plus each installed
 * store package's directory (a kernel manifest in swarm-apps/ has no code of its own - its
 * tables are core's).
 * @param repoRoot - repository/image root
 * @param apps - installed app records
 * @returns existing scan roots
 */
export async function scanRoots(repoRoot: string, apps: AppRecordLite[]): Promise<ScanRoot[]> {
  const roots: ScanRoot[] = [];
  for (const rel of CORE_SOURCE_DIRS) {
    const dir = path.join(repoRoot, rel);
    if (await isDir(dir)) roots.push({ owner: CORE_OWNER, dir, relativeTo: repoRoot });
  }
  for (const app of apps) {
    if (path.basename(app.manifestPath) !== PACKAGE_MANIFEST) continue;
    const dir = path.dirname(app.manifestPath);
    if (await isDir(dir)) roots.push({ owner: app.name, dir, relativeTo: dir });
  }
  return roots;
}

/**
 * @description Read the Postgres catalogs: the platform database always, TimescaleDB when the
 * port exists and answers (a failure there is logged and the snapshot carries on without it).
 * @param ports - injected ports
 * @returns catalogs, platform first
 */
async function readCatalogs(ports: DataModelPorts): Promise<CatalogSnapshot[]> {
  const catalogs = [await ports.readPlatformCatalog()];
  if (!ports.readTimeseriesCatalog) return catalogs;
  try {
    const ts = await ports.readTimeseriesCatalog();
    if (ts) catalogs.push(ts);
  } catch (err) {
    logger.error({ err }, 'data-model: time-series catalog read failed; snapshot continues without it');
  }
  return catalogs;
}

/**
 * @description Build a fresh snapshot.
 * @param ports - injected ports
 * @returns the snapshot
 */
export async function buildSnapshot(ports: DataModelPorts): Promise<DataModelSnapshot> {
  const started = Date.now();
  const [catalogs, apps] = await Promise.all([readCatalogs(ports), ports.listApps()]);
  const { sites, filesRead } = await scanDeclarations(await scanRoots(ports.repoRoot, apps));
  const own = attributeOwnership(catalogs, sites);
  const { apps: appNodes, integrations } = buildIntegrationMap(apps, own, databaseLinks(own.tables));
  logger.info({ tables: own.tables.length, views: own.views.length, apps: appNodes.length, filesRead, ms: Date.now() - started }, 'data-model snapshot built');
  return {
    generatedAt: new Date().toISOString(), database: catalogs[0].database, tables: own.tables, views: own.views,
    apps: appNodes, integrations, unowned: own.unowned, declaredAbsent: own.declaredAbsent, sqlite: own.sqlite,
  };
}

/**
 * @description Read one optional store port, turning a throw into an `unreachable` card.
 * @param store - which store
 * @param engine - engine label for the card
 * @param port - the port, when configured
 * @returns the inventory card
 */
async function readStore(store: StoreInventory['store'], engine: string, port?: () => Promise<StoreInventory>): Promise<StoreInventory> {
  if (!port) return { store, engine, status: 'not-configured', detail: `${engine} is not wired into this deployment.` };
  try {
    return await port();
  } catch (err) {
    logger.error({ err, store }, 'data-model: store inventory failed');
    return { store, engine, status: 'unreachable', detail: `${engine} did not answer: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * @description Serve a cached value, rebuilding past the TTL or on demand; concurrent callers
 * share the in-flight build so a burst of page loads runs one scan.
 * @param cache - the cache cell
 * @param ttlMs - time to live
 * @param now - clock
 * @param refresh - force a rebuild
 * @param build - the builder
 * @returns the value
 */
async function cached<T>(cache: Cached<T>, ttlMs: number, now: () => number, refresh: boolean, build: () => Promise<T>): Promise<T> {
  if (!refresh && cache.value && now() - cache.builtAt < ttlMs) return cache.value;
  if (cache.inflight) return cache.inflight;
  cache.inflight = build().then((value) => {
    cache.value = value;
    cache.builtAt = now();
    return value;
  }).finally(() => { cache.inflight = null; });
  return cache.inflight;
}

/**
 * @description Create the explorer service over injected ports.
 * @param ports - catalogs, app records and store inventories
 * @param opts - cache TTL and clock (tests)
 * @returns the service
 */
export function createDataModelService(ports: DataModelPorts, opts: { ttlMs?: number; now?: () => number } = {}): DataModelService {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;
  const snap: Cached<DataModelSnapshot> = { value: null, builtAt: 0, inflight: null };
  const stores: Cached<StoreInventory[]> = { value: null, builtAt: 0, inflight: null };
  return {
    snapshot: (refresh = false) => cached(snap, ttlMs, now, refresh, () => buildSnapshot(ports)),
    stores: (refresh = false) => cached(stores, ttlMs, now, refresh, () => Promise.all([
      readStore('graph', 'ArangoDB', ports.graphInventory),
      readStore('vector', 'ChromaDB', ports.vectorInventory),
      readStore('cache', 'Redis', ports.cacheInventory),
    ])),
  };
}
