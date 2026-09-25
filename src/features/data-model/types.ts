/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Data-model explorer types: catalog relations (tables/views with columns, keys, RLS policies), declaration sites that attribute a relation to its owner (core or an installed app), the assembled explorer snapshot (owned tables, shared objects, app integration edges) and the non-Postgres store inventories.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Two ports for schema-drift history (ADR-119/125 backlog item): a queryable for the digest table and the app_migrations count that tells a migrated change from an unexplained one. Both optional, so a deployment without the migration keeps rendering.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Carry optional catalog-read warnings so incomplete explorer snapshots cannot generate or acknowledge alarms.
 */

import type { DigestQueryable } from './services/drift-store';

/** Owner id for the platform itself. Package names are kebab-case, so `@core` can never collide. */
export const CORE_OWNER = '@core';

/** Error code a port throws when the platform database is not configured (the route answers 503). */
export const DATA_MODEL_NO_DATABASE = 'DATA_MODEL_NO_DATABASE';

/**
 * @description Build the error a port throws when this process has no platform database.
 * @returns an Error carrying `code: DATA_MODEL_NO_DATABASE`
 */
export function noDatabaseError(): Error & { code: string } {
  return Object.assign(new Error('The platform database is not configured in this process.'), { code: DATA_MODEL_NO_DATABASE });
}

/** One column as the catalog (or a parsed CREATE TABLE) reports it. */
export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  comment: string | null;
}

/** A foreign key from this relation's columns to another relation. */
export interface ForeignKeyInfo {
  name: string | null;
  columns: string[];
  refTable: string;
  refColumns: string[];
}

/** A row-level-security policy exactly as pg_policies reports it. */
export interface PolicyInfo {
  name: string;
  command: string;
  using: string | null;
  check: string | null;
}

/** A table or view read from a catalog (source = 'catalog') or parsed from DDL (source = 'parsed'). */
export interface RelationInfo {
  name: string;
  kind: 'table' | 'view';
  comment: string | null;
  rls: boolean;
  forced: boolean;
  policies: PolicyInfo[];
  columns: ColumnInfo[];
  primaryKey: string[];
  foreignKeys: ForeignKeyInfo[];
  uniques: string[][];
  hypertable: { timeColumn: string } | null;
  materialized: boolean;
  source: 'catalog' | 'parsed';
}

/** Everything one database's `public` schema holds. */
export interface CatalogSnapshot {
  database: string;
  tables: RelationInfo[];
  views: RelationInfo[];
}

/** Which engine a declaration targets, decided from the declaring file. */
export type DeclarationEngine = 'postgres' | 'sqlite';

/** One CREATE TABLE / CREATE VIEW found in source, attributed to the owner whose tree holds it. */
export interface DeclarationSite {
  name: string;
  kind: 'table' | 'view';
  owner: string;
  file: string;
  engine: DeclarationEngine;
  ddl: string;
}

/** A relation's RLS posture, derived from its real policy expressions. */
export interface RowAccessSummary {
  state: 'forced' | 'enabled' | 'off' | 'n/a';
  scopes: string[];
  ownerColumns: string[];
}

/** A relation placed in the explorer: where it lives, who declares it, and how rows are scoped. */
export interface ModelRelation extends RelationInfo {
  database: string;
  owners: string[];
  definers: Record<string, string[]>;
  access: RowAccessSummary;
}

/** An installed application as a node in the integration map. */
export interface AppNode {
  name: string;
  displayName: string;
  version: string;
  status: string;
  kind: 'app' | 'group' | 'core';
  suite: string | null;
  tables: string[];
  views: string[];
  sqliteTables: string[];
  uses: string[];
  ragCollections: string[];
  migrations: number;
  routes: string[];
}

/** Why two owners are connected. */
export type IntegrationKind =
  | 'context-offer' | 'artifact' | 'dependency' | 'group-member' | 'shared-table' | 'foreign-key';

/** A directed connection between two owners (apps or `@core`). */
export interface IntegrationEdge {
  from: string;
  to: string;
  kind: IntegrationKind;
  label: string;
}

/** A table declared in source that no reference database holds, parsed from its DDL. */
export interface DeclaredRelation extends RelationInfo {
  owner: string;
  files: string[];
  engine: DeclarationEngine;
}

/** The explorer's main payload: every Postgres relation, its owners, and how apps connect. */
export interface DataModelSnapshot {
  /** A partial optional catalog may render, but it must never produce or acknowledge drift. */
  catalogWarnings?: string[];
  generatedAt: string;
  database: string;
  tables: ModelRelation[];
  views: ModelRelation[];
  apps: AppNode[];
  integrations: IntegrationEdge[];
  /** Live relations no scanned source declares — reported, never guessed. */
  unowned: string[];
  /** Postgres tables a source declares that the reference database does not hold. */
  declaredAbsent: DeclaredRelation[];
  /** Tables declared against a SQLite driver; columns parsed from the statement as written. */
  sqlite: DeclaredRelation[];
}

/** A named collection in a document/vector/graph store. */
export interface StoreCollection {
  name: string;
  count: number | null;
  kind?: string;
}

/** One non-platform store's inventory, or why it could not be read. */
export interface StoreInventory {
  store: 'timeseries' | 'graph' | 'vector' | 'cache';
  engine: string;
  status: 'ok' | 'not-configured' | 'unreachable';
  detail: string;
  databases?: Array<{ name: string; collections: StoreCollection[] }>;
  collections?: StoreCollection[];
  families?: Array<{ prefix: string; keys: number; types: Record<string, number> }>;
  catalog?: { tables: ModelRelation[]; views: ModelRelation[] };
}

/** An installed application record, reduced to what the explorer reads. */
export interface AppRecordLite {
  name: string;
  displayName: string;
  version: string;
  status: string;
  manifestPath: string;
  manifest: Record<string, unknown>;
}

/**
 * Everything the explorer reads, injected by the app layer. The slice never imports another
 * feature: stores and app records arrive through these ports, so each can be doubled in tests.
 */
export interface DataModelPorts {
  /** Repository/image root holding core source (scripts/migrations, src, any-bot, docker). */
  repoRoot: string;
  readPlatformCatalog(): Promise<CatalogSnapshot>;
  listApps(): Promise<AppRecordLite[]>;
  readTimeseriesCatalog?(): Promise<CatalogSnapshot | null>;
  /**
   * The platform database again, for the schema-digest history table. Absent on a deployment
   * with no durable store, which is why the drift route degrades instead of failing.
   */
  digestQueryable?(): Promise<DigestQueryable | null>;
  /** Rows in app_migrations, or null when unreadable. A change here EXPLAINS a schema change. */
  migrationCount?(): Promise<number | null>;
  graphInventory?(): Promise<StoreInventory>;
  vectorInventory?(): Promise<StoreInventory>;
  cacheInventory?(): Promise<StoreInventory>;
}
