/**
 * Graph connector — the only way bots/surfaces reach a graph (ADR-045).
 *
 * Resolves a caller to their ISOLATED graph: `getPersonGraph(sub)` → that person's database,
 * `getTenantGraph(tenant)` → that tenant's shared database. It owns provisioning (create the
 * database + node/edge collections on first use) and isolation (a caller can only ever name their
 * own person graph + a tenant graph — never an arbitrary database). Engine-agnostic: it hands back
 * a GraphHandle; the ArangoDB specifics live in the adapter. Swapping engines = a new adapter here.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-045 — GraphConnector: per-person/per-tenant ArangoDB resolution + lazy provisioning of database + nodes/edges collections; createGraphConnector() env factory.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Data-lifecycle support: personGraphExists() (existence probe WITHOUT provisioning — an export/delete pass must never create an empty graph DB as a side effect) and dropPersonGraph() (drop the person's whole isolated database — the GDPR delete path). Both derive the DB name ONLY from the sub via personDbName, same isolation boundary as getPersonGraph.
 *
 * @module graph-connector
 */
import { Database } from 'arangojs';
import { createChildLogger } from '@/shared/logger';
import type { GraphConnectorConfig, GraphHandle } from './graph-types';
import { personDbName, tenantDbName } from './graph-keys';
import { ArangoGraphAdapter, NODES, EDGES } from './arango-graph-adapter';

const logger = createChildLogger({ module: 'graph-connector' });

/** Resolves callers to isolated graphs and provisions them on first use. */
export class GraphConnector {
  private readonly sys: Database;
  /** Databases already provisioned this process (skip the existence round-trip). */
  private readonly ready = new Set<string>();

  /** @param cfg - engine URL + root credential used to provision per-graph databases. */
  constructor(cfg: GraphConnectorConfig) {
    this.sys = new Database({ url: cfg.url, auth: { username: cfg.rootUser, password: cfg.rootPassword } });
  }

  /**
   * @description Get the caller's OWN person graph (isolated to their sub). Provisioned on first use.
   * @param sub - the caller's OIDC sub
   * @returns a handle scoped to that person's graph
   */
  async getPersonGraph(sub: string): Promise<GraphHandle> {
    if (!sub) throw new Error('getPersonGraph requires a caller sub');
    return this.handle(personDbName(sub));
  }

  /**
   * @description Get a tenant's shared graph. The caller's membership in `tenant` must be checked
   * UPSTREAM (the connector enforces graph isolation, not tenant authorization).
   * @param tenant - the tenant id
   * @returns a handle scoped to that tenant's shared graph
   */
  async getTenantGraph(tenant: string): Promise<GraphHandle> {
    if (!tenant) throw new Error('getTenantGraph requires a tenant id');
    return this.handle(tenantDbName(tenant));
  }

  /**
   * @description Whether the caller's person graph database has ever been provisioned. Pure
   * probe — unlike getPersonGraph it NEVER creates the database, so the data-lifecycle
   * export/delete pass can check for data without leaving an empty graph DB behind.
   * @param sub - the caller's OIDC sub
   * @returns true when the person's isolated database exists
   */
  async personGraphExists(sub: string): Promise<boolean> {
    if (!sub) throw new Error('personGraphExists requires a caller sub');
    return (await this.sys.listDatabases()).includes(personDbName(sub));
  }

  /**
   * @description Drop the caller's ENTIRE person graph database (the data-lifecycle delete
   * path). The name is derived only from the sub — the same isolation boundary as
   * getPersonGraph, so a caller can never name (and therefore never drop) another database.
   * Idempotent: dropping a never-provisioned graph is a clean no-op.
   * @param sub - the caller's OIDC sub
   * @returns true when a database existed and was dropped, false when there was nothing to drop
   */
  async dropPersonGraph(sub: string): Promise<boolean> {
    if (!sub) throw new Error('dropPersonGraph requires a caller sub');
    const dbName = personDbName(sub);
    if (!(await this.sys.listDatabases()).includes(dbName)) return false;
    await this.sys.dropDatabase(dbName);
    this.ready.delete(dbName);
    logger.info({ dbName }, 'dropped person graph database (data-lifecycle delete)');
    return true;
  }

  /** Provision (once) then return an adapter scoped to the named database. */
  private async handle(dbName: string): Promise<GraphHandle> {
    if (!this.ready.has(dbName)) {
      await this.ensureDatabase(dbName);
      await this.ensureCollections(dbName);
      this.ready.add(dbName);
    }
    return new ArangoGraphAdapter(this.sys.database(dbName));
  }

  /** Create the database if it doesn't exist (idempotent; tolerates the create race). */
  private async ensureDatabase(dbName: string): Promise<void> {
    const existing = await this.sys.listDatabases();
    if (existing.includes(dbName)) return;
    try {
      await this.sys.createDatabase(dbName);
      logger.info({ dbName }, 'provisioned graph database');
    } catch (err) {
      // 409 (already exists) is fine if another worker created it concurrently.
      if (!String((err as Error).message).includes('duplicate')) throw err;
    }
  }

  /** Ensure the node (document) + edge collections exist in the database. */
  private async ensureCollections(dbName: string): Promise<void> {
    const db = this.sys.database(dbName);
    if (!(await db.collection(NODES).exists())) await db.createCollection(NODES);
    if (!(await db.collection(EDGES).exists())) await db.createEdgeCollection(EDGES);
  }
}

/**
 * @description Build a GraphConnector from the environment (ARANGO_URL / ARANGO_ROOT_USER /
 * ARANGO_ROOT_PASSWORD). Returns null when ARANGO_URL is unset so callers can degrade gracefully
 * rather than crash where the graph engine isn't deployed.
 * @returns a connector, or null if the engine isn't configured
 */
export function createGraphConnector(): GraphConnector | null {
  const url = process.env.ARANGO_URL;
  if (!url) {
    logger.warn('ARANGO_URL unset — graph connector disabled (no graph engine configured)');
    return null;
  }
  return new GraphConnector({
    url,
    rootUser: process.env.ARANGO_ROOT_USER || 'root',
    rootPassword: process.env.ARANGO_ROOT_PASSWORD || '',
  });
}
