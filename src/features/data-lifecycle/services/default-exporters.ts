/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The REAL per-user store exporters behind /api/me/export + delete: oshal_connections (metadata ONLY — access/refresh tokens are never selected; delete removes the whole row so tokens go too), tickets (owner_sub; children cascade), chat_messages+chat_tasks (messages deleted via join BEFORE tasks; FK also cascades), user_notification_prefs, career_digest_settings, oshal_budgets (scope user rows), oshal_budget_events (EXPORT-ONLY: append-only governance audit), visual_response_artifacts (content bytea exported as sha256+metadata, not inline bytes), the personal-data vault (decrypted rows via the owner-keyed store; delete = row-wipe inside the per-user SQLite file), and the career-hunter per-user dir (keyed STORE_ROOT/tenant/<sub>; delete removes the whole user dir, the shared corpus is untouched).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fix (coverage + honesty gaps): buildAllExporters is now async and appends the information_schema-discovered exporters (discovered-exporters.ts) so EVERY remaining user_sub/owner_sub/actor_sub-keyed public table — ambient transcripts, per-app profiles/conversations, trading rows, personal graph, user-model facts, channel links, and any table added later — participates in export AND delete instead of silently falling out. Added KNOWN_EXPORT_GAPS: the non-Postgres per-user stores this surface still does not cover, declared in the manifest and delete responses instead of only in builder notes.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Closed the two engine gaps (BACKLOG "/api/me export gaps"): buildAllExporters now appends the ChromaDB exporter (owner_sub-metadata-scoped docs across every collection; absent-engine no-op — chroma-exporter.ts) and the ArangoDB person-graph exporter (dump + drop the isolated per-sub database via GraphConnector; no-ARANGO_URL no-op — arango-person-graph-exporter.ts). KNOWN_EXPORT_GAPS shrinks accordingly: chromadb_collections + arangodb_person_graph removed as covered, and the honest residual (non-attributed Chroma content in agent/swarm collections) is now declared explicitly. rag_chunks (RAG_ENGINE=pgvector) needs no new exporter — its owner_sub column means the information_schema-discovered exporters already export/delete it.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | The 09:20 entry above described appends that were never in the return array (partial land): imports + gap-list trim shipped, the registry didn't. buildAllExporters now actually appends buildChromaExporter() + buildArangoPersonGraphExporter(); registry-membership guard added in data-lifecycle.spec.ts so a promised-but-unregistered exporter can never pass CI again.
 */

/**
 * Every exporter here is scoped by `userSub` in the query/path itself — belt-and-braces on
 * top of the GUC/RLS layer (the api pool stamps oshal.current_sub per request, so RLS would
 * scope these reads anyway; the explicit WHERE means the registry is safe even on a pool
 * without the wrapper). Postgres access is injected as the minimal PgLike (FSD: features
 * never import app-layer context); the two file-backed stores resolve their roots from the
 * same env vars their owning slices use.
 *
 * @module features/data-lifecycle/services/default-exporters
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { createChildLogger } from '@/shared/logger';
import { SqliteVaultStore, resolveVault, readPersonalIntelligenceConfig } from '@/features/personal-data';
import type { DataExporter, KnownDataGap } from './exporter-registry';
import { discoverSubKeyedExporters } from './discovered-exporters';
import { buildChromaExporter } from './chroma-exporter';
import { buildArangoPersonGraphExporter } from './arango-person-graph-exporter';

const logger = createChildLogger({ module: 'data-lifecycle:exporters' });

/**
 * @description Minimal Postgres surface (structurally satisfied by pg.Pool). Injected rather
 * than imported from app/ so the slice stays FSD-clean and unit-testable with a fake.
 */
export interface PgLike {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
}

/** Declarative shape one SQL-backed exporter is built from. */
interface PgExporterDef {
  store: string;
  describe: string;
  deleteNote?: string;
  /** SELECT with exactly one $1 = userSub. Columns are the sanitized export set. */
  exportSql: string;
  /** DELETE with exactly one $1 = userSub. Absent = export-only store. */
  deleteSql?: string;
}

/** Build one DataExporter over a Postgres table from its declarative def. */
function pgExporter(pool: PgLike, def: PgExporterDef): DataExporter {
  return {
    store: def.store,
    describe: def.describe,
    deletable: Boolean(def.deleteSql),
    ...(def.deleteNote ? { deleteNote: def.deleteNote } : {}),
    async exportRows(userSub: string): Promise<unknown[]> {
      const r = await pool.query(def.exportSql, [userSub]);
      return r.rows;
    },
    ...(def.deleteSql
      ? {
          async deleteRows(userSub: string): Promise<number> {
            const r = await pool.query(def.deleteSql as string, [userSub]);
            return r.rowCount ?? r.rows.length;
          },
        }
      : {}),
  };
}

/**
 * @description Guard for the file-backed exporters: an OIDC sub is used as a directory name,
 * so refuse anything that could traverse (defense-in-depth; real subs are opaque ids).
 * @param userSub - The sub about to become a path segment.
 * @returns The same sub, validated.
 */
function safePathSub(userSub: string): string {
  if (!userSub || /[/\\]|\.\./.test(userSub)) {
    throw new Error('user sub is not a safe path segment');
  }
  return userSub;
}

/** Declarative table defs — the single place the sanitized column sets live. */
function pgExporterDefs(): PgExporterDef[] {
  return [
    {
      store: 'oshal_connections',
      describe:
        'Connector connections (provider, granted scopes, linked account, status, created). METADATA ONLY — encrypted access/refresh tokens are never exported. Deleting removes the whole row, so the stored tokens are destroyed too.',
      exportSql: `SELECT connection_id, provider, account_email, account_id, scopes, status, created_at, updated_at
                    FROM oshal_connections WHERE user_sub=$1 ORDER BY provider`,
      deleteSql: 'DELETE FROM oshal_connections WHERE user_sub=$1',
    },
    {
      store: 'tickets',
      describe:
        'Tickets you created (owner_sub). Deleting a ticket cascades its comments, events, and link rows via the schema FKs.',
      exportSql: 'SELECT * FROM tickets WHERE owner_sub=$1 ORDER BY created_at',
      deleteSql: 'DELETE FROM tickets WHERE owner_sub=$1',
    },
    {
      store: 'chat_messages',
      describe: 'Chat history messages belonging to your chat tasks.',
      exportSql: `SELECT m.* FROM chat_messages m JOIN chat_tasks t ON t.task_id = m.task_id
                   WHERE t.owner_sub=$1 ORDER BY m.created_at`,
      // Deleted BEFORE chat_tasks (registry order); the FK cascade makes this idempotent.
      deleteSql: `DELETE FROM chat_messages m USING chat_tasks t
                   WHERE t.task_id = m.task_id AND t.owner_sub=$1`,
    },
    {
      store: 'chat_tasks',
      describe:
        'Chat tasks you own, including per-task token/cost usage rollups. Deleting cascades checkpoints, agent memories, and any remaining messages.',
      exportSql: 'SELECT * FROM chat_tasks WHERE owner_sub=$1 ORDER BY created_at',
      deleteSql: 'DELETE FROM chat_tasks WHERE owner_sub=$1',
    },
    {
      store: 'user_notification_prefs',
      describe: 'Your per-topic notification routing preferences (channel, quiet hours, destinations).',
      exportSql: 'SELECT * FROM user_notification_prefs WHERE user_sub=$1 ORDER BY topic',
      deleteSql: 'DELETE FROM user_notification_prefs WHERE user_sub=$1',
    },
    {
      store: 'career_digest_settings',
      describe: 'Your career daily-digest settings (opt-out flag, channel, phone, last-sent cursor).',
      exportSql: 'SELECT * FROM career_digest_settings WHERE user_sub=$1',
      deleteSql: 'DELETE FROM career_digest_settings WHERE user_sub=$1',
    },
    {
      store: 'oshal_budgets',
      describe: "Your personal spend budgets (scope_type='user' rows keyed by your sub).",
      exportSql: `SELECT id, scope_type, scope_key, daily_usd, hard, enabled, created_at, updated_at
                    FROM oshal_budgets WHERE scope_type='user' AND scope_key=$1`,
      deleteSql: `DELETE FROM oshal_budgets WHERE scope_type='user' AND scope_key=$1`,
    },
    {
      store: 'oshal_budget_events',
      describe: "Budget breach/halt audit events for your user scope (scope_type='user').",
      deleteNote:
        'Append-only governance audit trail — retained by design (the operator must be able to see WHY past dispatches were blocked). Export-only.',
      exportSql: `SELECT id, ts, scope_type, scope_key, spend_usd, cap_usd, action, detail
                    FROM oshal_budget_events WHERE scope_type='user' AND scope_key=$1 ORDER BY ts`,
    },
    {
      store: 'visual_response_artifacts',
      describe:
        'Generated image artifacts you own. The binary image content is represented by its sha256 + metadata (mime, dimensions, alt text, provenance) — raw bytes are omitted from the JSON export for size; deleting removes the full rows including the bytes.',
      exportSql: `SELECT artifact_id, source_surface, source_session_id, source_job_id, mime_type,
                         width, height, alt_text, content_sha256, octet_length(content) AS content_bytes,
                         provenance, created_at
                    FROM visual_response_artifacts WHERE user_sub=$1 ORDER BY created_at`,
      deleteSql: 'DELETE FROM visual_response_artifacts WHERE user_sub=$1',
    },
  ];
}

/**
 * @description The Postgres-backed exporters, in delete-safe order (children before parents:
 * chat_messages precedes chat_tasks).
 * @param pool - Postgres pool (PgLike; the app passes its GUC-wrapped pool).
 * @returns One DataExporter per table.
 */
export function buildPgExporters(pool: PgLike): DataExporter[] {
  return pgExporterDefs().map((def) => pgExporter(pool, def));
}

/**
 * @description Exporter for the per-user personal-data vault (ADR-057). Export reads through
 * the owner-keyed store, so label/attrs come back DECRYPTED — it is the owner exporting their
 * own data, and an export of ciphertext would be useless to them. Delete wipes the owner's
 * rows inside the per-user SQLite file via direct SQL (row-level, so it works even while the
 * api's own PIS instance holds an open handle — deleting the file would EBUSY on Windows) and
 * removes the portability manifest. When the PIS is disabled (ENABLE_PERSONAL_INTELLIGENCE
 * unset) or the vault was never created, both operations are clean, logged no-ops.
 * @returns The vault DataExporter.
 */
export function buildVaultExporter(): DataExporter {
  return {
    store: 'personal_data_vault',
    describe:
      'Personal-data vault (entities, edges, facts) — decrypted for the owner. Empty when the Personal-Intelligence Service is disabled or the vault was never created.',
    deletable: true,
    async exportRows(userSub: string): Promise<unknown[]> {
      const config = readPersonalIntelligenceConfig();
      if (!config || !config.storeRoot) {
        logger.info({ userSub }, 'vault export: personal intelligence disabled — empty section');
        return [];
      }
      const layout = resolveVault(config.storeRoot, config.tenant, safePathSub(userSub));
      if (!fs.existsSync(path.join(layout.vaultDir, 'vault.db'))) return [];
      const store = new SqliteVaultStore();
      try {
        return [
          ...store.getEntities(layout, userSub).map((e) => ({ kind: 'entity', ...e })),
          ...store.getEdges(layout, userSub).map((e) => ({ kind: 'edge', ...e })),
          ...store.getFacts(layout, userSub).map((f) => ({ kind: 'fact', ...f })),
        ];
      } finally {
        store.close();
      }
    },
    async deleteRows(userSub: string): Promise<number> {
      const config = readPersonalIntelligenceConfig();
      if (!config || !config.storeRoot) return 0;
      const layout = resolveVault(config.storeRoot, config.tenant, safePathSub(userSub));
      const dbPath = path.join(layout.vaultDir, 'vault.db');
      if (!fs.existsSync(dbPath)) return 0;
      const db = new Database(dbPath);
      try {
        let deleted = 0;
        for (const table of ['facts', 'edges', 'resolver_index', 'entities']) {
          deleted += db.prepare(`DELETE FROM ${table} WHERE owner_sub=?`).run(userSub).changes;
        }
        if (fs.existsSync(layout.manifestPath)) fs.rmSync(layout.manifestPath, { force: true });
        return deleted;
      } finally {
        db.close();
      }
    },
  };
}

/** Career-hunter per-user store root — same resolution as career-hunter-routes (env-keyed). */
function careerStoreUserDir(userSub: string): string {
  const storeRoot = process.env.JOBHUNTER_STORE_ROOT || path.resolve(process.cwd(), 'output', 'career-hunter-data');
  // Single-tenant today — career-hunter-routes hardcodes TENANT='default'; match it exactly.
  return path.join(storeRoot, 'default', safePathSub(userSub));
}

/** Recursively list files under a dir as export-relative entries. */
function walkFiles(root: string, dir: string, out: Array<{ file: string; bytes: number }>): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(root, full, out);
    else out.push({ file: path.relative(root, full).replace(/\\/g, '/'), bytes: fs.statSync(full).size });
  }
}

/** Dump every user table of the per-user career SQLite DB (BLOBs become base64). */
function dumpUserSqlite(dbPath: string): unknown[] {
  const rows: unknown[] = [];
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    for (const { name } of tables) {
      const all = db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all() as Array<Record<string, unknown>>;
      for (const row of all) {
        const clean: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) {
          clean[k] = Buffer.isBuffer(v) ? { blobBase64: v.toString('base64') } : v;
        }
        rows.push({ table: name, row: clean });
      }
    }
  } finally {
    db.close();
  }
  return rows;
}

/**
 * @description Exporter for the career-hunter per-user store: the directory keyed
 * `<JOBHUNTER_STORE_ROOT>/<tenant>/<sub>/` holding the user's signals SQLite DB
 * (`user-<sub>.db`) plus their uploaded files (resumes). Export = a full dump of every table
 * in the user DB + a file inventory. Delete removes the WHOLE user directory; the shared
 * corpus DB lives at the tenant level and is never touched. Clean no-op when the user has no
 * career-hunter data.
 * @returns The career-hunter DataExporter.
 */
export function buildCareerHunterExporter(): DataExporter {
  return {
    store: 'career_hunter',
    describe:
      'Career-hunter per-user store: every table of your signals database (scores, statuses, resume state) plus an inventory of your uploaded files. Empty when you never used career-hunter.',
    deletable: true,
    async exportRows(userSub: string): Promise<unknown[]> {
      const userDir = careerStoreUserDir(userSub);
      if (!fs.existsSync(userDir)) return [];
      const rows: unknown[] = [];
      const files: Array<{ file: string; bytes: number }> = [];
      walkFiles(userDir, userDir, files);
      for (const f of files) rows.push({ kind: 'file', ...f });
      const dbPath = path.join(userDir, `user-${userSub}.db`);
      if (fs.existsSync(dbPath)) {
        for (const r of dumpUserSqlite(dbPath)) rows.push({ kind: 'db-row', ...(r as Record<string, unknown>) });
      }
      return rows;
    },
    async deleteRows(userSub: string): Promise<number> {
      const userDir = careerStoreUserDir(userSub);
      if (!fs.existsSync(userDir)) return 0;
      const files: Array<{ file: string; bytes: number }> = [];
      walkFiles(userDir, userDir, files);
      fs.rmSync(userDir, { recursive: true, force: true });
      logger.info({ userSub, files: files.length }, 'career-hunter user dir deleted');
      return files.length;
    },
  };
}

/**
 * @description Per-user stores the platform holds that this surface does NOT yet export or
 * delete — declared in the export manifest and both delete responses so a "success" answer
 * never implies these were touched (the honesty contract). Shrink this list by building the
 * exporter, never by deleting the entry.
 */
export const KNOWN_EXPORT_GAPS: KnownDataGap[] = [
  {
    store: 'chromadb_unattributed_content',
    holds:
      'Chroma chunks that carry NO owner_sub metadata but whose TEXT may mention you: shared-corpus ingests, the per-AGENT agent-memory-*/agent-knowledge-* collections, and the swarm-memory/swarm-tickets/swarm-messages/swarm-knowledge narratives distilled from ticket work.',
    status:
      'Not mechanically user-attributable (those chunks have no ownership metadata), so they are not exported or deleted. Chunks stamped with your owner_sub ARE covered by the chromadb_collections exporter.',
  },
  {
    store: 'personal_graph_nodes_edges',
    holds: 'The Postgres personal knowledge graph (personal_graph_nodes / personal_graph_edges, ADR-066).',
    status: 'The schema carries NO ownership column (single-user deployment store), so rows cannot be mechanically scoped to one user — not exported/deleted here. Per-user attribution is a prerequisite follow-up.',
  },
  {
    store: 'knowledge_memory_documents',
    holds: 'Knowledge-memory document metadata (titles/sources), keyed by agent/task rather than by user.',
    status: 'Not user-attributable row-by-row; deleting your chat_tasks SET-NULLs its task links, leaving orphaned non-attributed metadata behind.',
  },
  {
    store: 'workspace_files',
    holds: 'Files inside shared workspaces you worked in (the workspaces DB rows you own ARE covered).',
    status: 'Workspace directories are shared, not per-user file-attributed — files are NOT deleted. Remove sensitive files from workspaces manually before account deletion.',
  },
];

/**
 * @description The full default registry, assembled per request in delete-safe order:
 * (1) the information_schema-DISCOVERED exporters (every remaining sub-keyed public table,
 * children-before-parents — run first so no discovered child can block an explicit parent),
 * (2) the explicit column-sanitized Postgres exporters, (3) the two file-backed per-user
 * stores. Async because discovery reads the live catalog — a table created after boot still
 * participates. This is what the /api/me routes consume.
 * @param pool - Postgres pool (PgLike; the app passes its GUC-wrapped pool).
 * @returns All registered exporters.
 */
export async function buildAllExporters(pool: PgLike): Promise<DataExporter[]> {
  // Explicit tables are excluded from discovery: their curated SQL deliberately omits columns
  // (e.g. oshal_connections tokens) that a discovered SELECT * would re-expose.
  const covered = new Set(pgExporterDefs().map((d) => d.store));
  const discovered = await discoverSubKeyedExporters(pool, covered);
  return [
    ...discovered,
    ...buildPgExporters(pool),
    buildVaultExporter(),
    buildCareerHunterExporter(),
    // The two engine exporters the 2026-07-19 change log promised: without these appends the
    // Chroma + person-graph stores silently fell out of /api/me export AND delete while the
    // KNOWN_EXPORT_GAPS disclosure had already been removed. Both are absent-engine no-ops.
    buildChromaExporter(),
    buildArangoPersonGraphExporter(),
  ];
}
