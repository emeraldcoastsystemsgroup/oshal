/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add ADR-149 application permission contracts, policy persistence and isolated enforcement verification.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add bounded, redacted applied authorization history under current application and tenant authority.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Provide durable preview reads without retaining a policy writer lock.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | AUTH-07: two more control-plane tables under the same forced operator-only RLS (content-addressed catalog snapshots and reviewable catalog migrations). The locked policy state now carries the migrations, and a transaction records the activating catalog in the same commit as any assignment re-stamp and its audit event.
 */
/** Durable control-plane state; this store never opens application business data. */
import type { Pool, PoolClient } from 'pg';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';
import type { AuthorizationAudit, AuthorizationAuditQuery, AuthorizationCatalogSnapshot, AuthorizationState, AuthorizationStore,
  AuthorizationTransaction, StoredAuthorizationPreview, StoredCatalogMigration } from './types';
import { readPostgresAudit } from './audit-store';

/** Every control-plane table; each is forced under the operator-only policy. */
const AUTHORIZATION_TABLES = ['state', 'assignments', 'previews', 'audit', 'applications', 'catalogs', 'catalog_migrations'];
export const AUTHORIZATION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS oshal_authorization_state (singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton), revision BIGINT NOT NULL DEFAULT 0 CHECK(revision>=0))`,
  `INSERT INTO oshal_authorization_state(singleton,revision) VALUES(TRUE,0) ON CONFLICT DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS oshal_authorization_assignments (id TEXT PRIMARY KEY, payload JSONB NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS oshal_authorization_previews (id TEXT PRIMARY KEY, payload JSONB NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS oshal_authorization_audit (id TEXT PRIMARY KEY, revision BIGINT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE INDEX IF NOT EXISTS authorization_audit_revision ON oshal_authorization_audit(revision DESC,id DESC)`,
  `CREATE INDEX IF NOT EXISTS authorization_audit_app_revision ON oshal_authorization_audit((payload #>> '{change,app}'),revision DESC,id DESC)`,
  `CREATE INDEX IF NOT EXISTS authorization_audit_tenant_revision ON oshal_authorization_audit((payload #>> '{change,app}'),(payload #>> '{change,tenantId}'),revision DESC,id DESC)`,
  `CREATE TABLE IF NOT EXISTS oshal_authorization_applications (app_name TEXT PRIMARY KEY, protected BOOLEAN NOT NULL, agent_ids TEXT[] NOT NULL DEFAULT '{}', tool_names TEXT[] NOT NULL DEFAULT '{}')`,
  `ALTER TABLE oshal_authorization_applications ADD COLUMN IF NOT EXISTS tool_names TEXT[] NOT NULL DEFAULT '{}'`,
  `CREATE TABLE IF NOT EXISTS oshal_authorization_catalogs (catalog_revision TEXT PRIMARY KEY, app_name TEXT NOT NULL, payload JSONB NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE TABLE IF NOT EXISTS oshal_authorization_catalog_migrations (id TEXT PRIMARY KEY, app_name TEXT NOT NULL, payload JSONB NOT NULL)`,
  ...AUTHORIZATION_TABLES.flatMap(name => [
    `ALTER TABLE oshal_authorization_${name} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE oshal_authorization_${name} FORCE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS authorization_control_plane ON oshal_authorization_${name}`,
    `CREATE POLICY authorization_control_plane ON oshal_authorization_${name} USING (current_setting('oshal.is_operator',true)='on') WITH CHECK (current_setting('oshal.is_operator',true)='on')`,
  ]),
];

export async function ensureApplicationAuthorizationSchema(pool: Pool): Promise<void> {
  await runRuntimeSchemaBootstrap({ pool, moduleName: 'application authorization', lockKey: 7149127,
    statements: AUTHORIZATION_SCHEMA,
    requirements: AUTHORIZATION_TABLES.map(name => ({ table: `oshal_authorization_${name}` })),
  });
}

/** Policy changes serialize on one revision row; each audit and change commits atomically. */
export class PostgresAuthorizationStore implements AuthorizationStore {
  constructor(private readonly pool: Pool) {}
  /** @description Load an actor-bound preview for pre-lock approval and identity revalidation.
   * @param id Opaque preview identifier. @returns Its persisted state, or null; the service still checks ownership and freshness.
   */
  readPreview(id: string): Promise<StoredAuthorizationPreview | null> {
    return runWithSystemIdentity(async () => {
      const result = await this.pool.query<{ payload: StoredAuthorizationPreview }>(
        'SELECT payload FROM oshal_authorization_previews WHERE id=$1', [id]);
      return result.rows[0]?.payload ?? null;
    });
  }
  /** @description Query a consistent audit page without taking the policy writer lock.
   * @param input Service-authorized scope and bounded cursor. @returns Matching stored audit events.
   */
  readAudit(input: AuthorizationAuditQuery) { return readPostgresAudit(this.pool, input); }
  /** @description Read immutable catalog snapshots; content addressing makes an unlocked read safe.
   * @param revisions Catalog revisions to load. @returns The recorded snapshots; the service re-verifies each hash.
   */
  readCatalogSnapshots(revisions: readonly string[]): Promise<AuthorizationCatalogSnapshot[]> {
    if (!revisions.length) return Promise.resolve([]);
    return runWithSystemIdentity(async () => (await this.pool.query<{ payload: AuthorizationCatalogSnapshot }>(
      'SELECT payload FROM oshal_authorization_catalogs WHERE catalog_revision = ANY($1::text[])', [[...revisions]])).rows.map(row => row.payload));
  }
  /** @description List migration reviews without the writer lock; apply re-reads them under it.
   * @param filter Application and/or review id. @returns Matching stored reviews.
   */
  readCatalogMigrations(filter: { app?: string; id?: string }): Promise<StoredCatalogMigration[]> {
    return runWithSystemIdentity(async () => (await this.pool.query<{ payload: StoredCatalogMigration }>(
      'SELECT payload FROM oshal_authorization_catalog_migrations WHERE ($1::text IS NULL OR app_name=$1) AND ($2::text IS NULL OR id=$2) ORDER BY id',
      [filter.app ?? null, filter.id ?? null])).rows.map(row => row.payload));
  }
  async publishAppPosture(app: string, protectedApp: boolean, agentIds: readonly string[], toolNames: readonly string[] = []): Promise<void> {
    await runWithSystemIdentity(() => this.pool.query(`INSERT INTO oshal_authorization_applications(app_name,protected,agent_ids,tool_names)
      VALUES($1,$2,$3::text[],$4::text[]) ON CONFLICT(app_name) DO UPDATE SET
      protected=oshal_authorization_applications.protected OR EXCLUDED.protected,
      agent_ids=ARRAY(SELECT DISTINCT unnest(oshal_authorization_applications.agent_ids || EXCLUDED.agent_ids)),
      tool_names=ARRAY(SELECT DISTINCT unnest(oshal_authorization_applications.tool_names || EXCLUDED.tool_names))`, [app, protectedApp, agentIds, toolNames]));
  }
  read(): Promise<AuthorizationState> {
    return runWithSystemIdentity(async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const state = await loadState(client, false);
        await client.query('COMMIT'); return state;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    });
  }
  transaction<T>(operation: (transaction: AuthorizationTransaction) => Promise<T>): Promise<T> {
    return runWithSystemIdentity(async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const state = await loadState(client, true); const revision = state.revision;
        const before = structuredClone(state); const audit: AuthorizationAudit[] = []; const catalogs: AuthorizationCatalogSnapshot[] = [];
        const value = await operation({ state, audit: event => { audit.push(event); }, catalog: snapshot => { catalogs.push(structuredClone(snapshot)); } });
        await persistRows(client, 'assignments', before.assignments, state.assignments);
        await persistRows(client, 'previews', before.previews.map(p => ({ ...p, id: p.previewId })), state.previews.map(p => ({ ...p, id: p.previewId })));
        await persistMigrations(client, before.migrations ?? [], state.migrations ?? []);
        if (state.revision !== revision) await client.query('UPDATE oshal_authorization_state SET revision=$1 WHERE singleton=TRUE', [state.revision]);
        for (const event of audit) await client.query('INSERT INTO oshal_authorization_audit(id,revision,payload) VALUES($1,$2,$3::jsonb)', [event.id, event.revision, JSON.stringify(event)]);
        for (const snapshot of catalogs) await client.query(`INSERT INTO oshal_authorization_catalogs(catalog_revision,app_name,payload) VALUES($1,$2,$3::jsonb)
          ON CONFLICT(catalog_revision) DO UPDATE SET payload=EXCLUDED.payload, recorded_at=NOW()`, [snapshot.catalogRevision, snapshot.app, JSON.stringify(snapshot)]);
        await client.query('COMMIT'); return value;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    });
  }
}
async function loadState(client: PoolClient, lock: boolean): Promise<AuthorizationState> {
  const result = await client.query(`SELECT revision FROM oshal_authorization_state WHERE singleton=TRUE${lock ? ' FOR UPDATE' : ''}`);
  if (result.rows.length !== 1) throw new Error('Application authorization schema unavailable');
  const revision = Number(result.rows[0].revision);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid authorization revision');
  const assignments = await client.query('SELECT payload FROM oshal_authorization_assignments ORDER BY id');
  const previews = lock ? await client.query('SELECT payload FROM oshal_authorization_previews ORDER BY id') : { rows: [] };
  const state: AuthorizationState = { revision, assignments: assignments.rows.map(row => row.payload), previews: previews.rows.map(row => row.payload) };
  if (lock) state.migrations = (await client.query('SELECT payload FROM oshal_authorization_catalog_migrations ORDER BY id')).rows.map(row => row.payload);
  return state;
}
/** Write only the migration reviews a transaction changed; each row carries its application for filtered reads. */
async function persistMigrations(client: PoolClient, before: StoredCatalogMigration[], after: StoredCatalogMigration[]): Promise<void> {
  const original = new Map(before.map(row => [row.id, JSON.stringify(row)]));
  const current = new Set(after.map(row => row.id));
  for (const row of before) if (!current.has(row.id)) await client.query('DELETE FROM oshal_authorization_catalog_migrations WHERE id=$1', [row.id]);
  for (const row of after) {
    const serialized = JSON.stringify(row);
    if (original.get(row.id) !== serialized) await client.query(`INSERT INTO oshal_authorization_catalog_migrations(id,app_name,payload) VALUES($1,$2,$3::jsonb)
      ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload`, [row.id, row.app, serialized]);
  }
}
async function persistRows(client: PoolClient, table: 'assignments' | 'previews', before: Array<{ id: string }>, after: Array<{ id: string }>): Promise<void> {
  const original = new Map(before.map(row => [row.id, JSON.stringify(row)]));
  const current = new Set(after.map(row => row.id));
  for (const row of before) if (!current.has(row.id)) await client.query(`DELETE FROM oshal_authorization_${table} WHERE id=$1`, [row.id]);
  for (const row of after) {
    const serialized = JSON.stringify(row);
    if (original.get(row.id) !== serialized) await client.query(`INSERT INTO oshal_authorization_${table}(id,payload) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload`, [row.id, serialized]);
  }
}

/** Isolated repository adapter for fixture apps/tests; production must inject PostgreSQL. */
export class MemoryAuthorizationStore implements AuthorizationStore {
  /** @description Match the durable preview read without holding the fixture writer lock.
   * @param id Opaque preview identifier. @returns An independent preview copy, or null.
   */
  async readPreview(id: string): Promise<StoredAuthorizationPreview | null> {
    await this.tail;
    return structuredClone(this.state.previews.find(preview => preview.previewId === id) ?? null);
  }
  /** @description Match durable audit ordering for isolated policy fixtures.
   * @param input Service-authorized scope and bounded cursor. @returns Matching fixture events.
   */
  async readAudit(input: AuthorizationAuditQuery): Promise<{ events: AuthorizationAudit[]; snapshotRevision: number }> {
    await this.tail;
    const snapshotRevision = input.snapshotRevision === undefined ? this.state.revision : Math.min(input.snapshotRevision, this.state.revision);
    const events = this.auditEvents.filter(event => event.revision <= snapshotRevision
      && (input.app === undefined || event.change.app === input.app) && (input.tenantId === undefined || event.change.tenantId === input.tenantId)
      && (!input.before || event.revision < input.before.revision || (event.revision === input.before.revision && event.id < input.before.id)))
      .sort((a, b) => b.revision - a.revision || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).slice(0, input.limit);
    return { events: structuredClone(events), snapshotRevision };
  }
  /** @description Match the durable snapshot read for isolated fixtures.
   * @param revisions Catalog revisions to load. @returns Independent copies of the recorded snapshots.
   */
  async readCatalogSnapshots(revisions: readonly string[]): Promise<AuthorizationCatalogSnapshot[]> {
    await this.tail;
    return revisions.flatMap(revision => this.catalogs.has(revision) ? [structuredClone(this.catalogs.get(revision)!)] : []);
  }
  /** @description Match the durable migration review read for isolated fixtures.
   * @param filter Application and/or review id. @returns Independent copies of the matching reviews.
   */
  async readCatalogMigrations(filter: { app?: string; id?: string }): Promise<StoredCatalogMigration[]> {
    await this.tail;
    return structuredClone((this.state.migrations ?? []).filter(row => (filter.app === undefined || row.app === filter.app)
      && (filter.id === undefined || row.id === filter.id)));
  }
  readonly catalogs = new Map<string, AuthorizationCatalogSnapshot>();
  readonly applicationPostures = new Map<string, { protected: boolean; agentIds: string[]; toolNames: string[] }>();
  async publishAppPosture(app: string, protectedApp: boolean, agentIds: readonly string[], toolNames: readonly string[] = []): Promise<void> {
    const previous = this.applicationPostures.get(app);
    this.applicationPostures.set(app, { protected: Boolean(previous?.protected || protectedApp),
      agentIds: [...new Set([...(previous?.agentIds ?? []), ...agentIds])], toolNames: [...new Set([...(previous?.toolNames ?? []), ...toolNames])] });
  }
  private state: AuthorizationState = { revision: 0, assignments: [], previews: [], migrations: [] };
  private tail: Promise<void> = Promise.resolve();
  readonly auditEvents: AuthorizationAudit[] = [];
  async read(): Promise<AuthorizationState> {
    await this.tail;
    // Match the durable unlocked read: migration reviews load only under the writer lock.
    const { migrations: _locked, ...state } = this.state;
    return structuredClone(state);
  }
  async transaction<T>(operation: (transaction: AuthorizationTransaction) => Promise<T>): Promise<T> {
    const previous = this.tail; let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; }); await previous;
    try {
      const state = structuredClone(this.state); const audit: AuthorizationAudit[] = []; const catalogs: AuthorizationCatalogSnapshot[] = [];
      const value = await operation({ state, audit: event => { audit.push(structuredClone(event)); },
        catalog: snapshot => { catalogs.push(structuredClone(snapshot)); } });
      this.state = state; this.auditEvents.push(...audit);
      for (const snapshot of catalogs) this.catalogs.set(snapshot.catalogRevision, snapshot);
      return value;
    } finally { release(); }
  }
}
