/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-057/058: real per-user SQLite VaultStore — entity resolution + non-destructive dedup
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | At-rest encryption (ADR-057 "encrypt the file"): PII content fields (entity/edge label + attrs) are AES-256-GCM encrypted and the natural-key resolver index is stored as a keyed HMAC (lookup-preserving, irreversible), via vault-crypto.ts (per-user HKDF key from SESSION_SECRET, never stored in the file). Existing plaintext rows are migrated on first open (user_version guard). A leaked vault DB/volume/backup is now opaque without SESSION_SECRET — required for the internet-facing deployment.
 */

/**
 * SqliteVaultStore — the per-user Personal Data Vault as a single SQLite file (ADR-057 §6).
 *
 * Why SQLite, not shared Postgres: the sovereignty/portability promise IS "one file you can encrypt
 * and carry." This file lives in the user's vault dir; export = copy it. The VaultStore interface
 * keeps it swappable to ArangoDB/Chroma later without touching the service.
 *
 * The make-or-break is ENTITY RESOLUTION: every distinct real-world thing is ONE node, matched by
 * natural keys (symbol/domain/email). Merges are NON-DESTRUCTIVE — we add, never overwrite.
 *
 * AT REST: label + attrs are encrypted (AES-256-GCM) and the resolver index is a keyed HMAC of the
 * natural key — so emails/domains/names are unreadable from a leaked file while equality resolution
 * still works. Structural columns (ids, types, owner_sub, edge endpoints, fact metrics/values) stay
 * cleartext because joins/lookups need them; they carry no standalone PII.
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import type { Provenance } from './ontology';
import { makeEntityId, isInUserScope } from './ontology';
import type { VaultLayout } from './vault';
import type { EntityContribution, EdgeContribution, FactContribution } from './schema-contribution';
import type { VaultStore } from './personal-intelligence-service';
import { encryptField, decryptField, indexKey, isEncrypted, isIndexKey } from './vault-crypto';

interface DbHandle { db: InstanceType<typeof Database>; }

export class SqliteVaultStore implements VaultStore {
  private readonly handles = new Map<string, DbHandle>();

  /** Open (and lazily create + migrate) the vault DB for a user. One file per user = portable vault. */
  private open(layout: VaultLayout): InstanceType<typeof Database> {
    const cached = this.handles.get(layout.vaultDir);
    if (cached) return cached.db;
    fs.mkdirSync(layout.vaultDir, { recursive: true });
    const db = new Database(path.join(layout.vaultDir, 'vault.db'));
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY, owner_sub TEXT NOT NULL, type TEXT NOT NULL, label TEXT,
        attrs TEXT NOT NULL DEFAULT '{}', world_ref TEXT,
        source TEXT, ingested_at TEXT, confidence REAL, derived_by TEXT
      );
      CREATE TABLE IF NOT EXISTS resolver_index (
        owner_sub TEXT NOT NULL, match_key TEXT NOT NULL, entity_id TEXT NOT NULL,
        PRIMARY KEY (owner_sub, match_key)
      );
      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY, owner_sub TEXT NOT NULL, type TEXT NOT NULL,
        from_id TEXT NOT NULL, to_id TEXT NOT NULL, attrs TEXT NOT NULL DEFAULT '{}',
        source TEXT, ingested_at TEXT, confidence REAL,
        UNIQUE (owner_sub, type, from_id, to_id)
      );
      CREATE TABLE IF NOT EXISTS facts (
        owner_sub TEXT NOT NULL, entity_id TEXT NOT NULL, metric TEXT NOT NULL,
        value REAL NOT NULL, at TEXT NOT NULL, source TEXT, confidence REAL,
        PRIMARY KEY (owner_sub, entity_id, metric, at)
      );
    `);
    this.migrateEncryption(db);
    this.handles.set(layout.vaultDir, { db });
    return db;
  }

  /**
   * One-time migration of a pre-encryption vault: encrypt any plaintext label/attrs and re-hash any
   * plaintext resolver keys, so existing data is protected too. Idempotent + guarded by user_version,
   * so it runs at most once per vault and is a no-op on an already-encrypted file.
   */
  private migrateEncryption(db: InstanceType<typeof Database>): void {
    const version = db.pragma('user_version', { simple: true }) as number;
    if (version >= 1) return;
    const run = db.transaction(() => {
      const ents = db.prepare('SELECT id, owner_sub, label, attrs FROM entities').all() as Array<{ id: string; owner_sub: string; label: string | null; attrs: string }>;
      const updEnt = db.prepare('UPDATE entities SET label=?, attrs=? WHERE id=?');
      for (const e of ents) {
        if (isEncrypted(e.label) && isEncrypted(e.attrs)) continue;
        updEnt.run(encryptField(e.owner_sub, e.label), encryptField(e.owner_sub, e.attrs), e.id);
      }
      const edges = db.prepare('SELECT id, owner_sub, attrs FROM edges').all() as Array<{ id: string; owner_sub: string; attrs: string }>;
      const updEdge = db.prepare('UPDATE edges SET attrs=? WHERE id=?');
      for (const ed of edges) {
        if (isEncrypted(ed.attrs)) continue;
        updEdge.run(encryptField(ed.owner_sub, ed.attrs), ed.id);
      }
      const idx = db.prepare('SELECT owner_sub, match_key, entity_id FROM resolver_index').all() as Array<{ owner_sub: string; match_key: string; entity_id: string }>;
      const del = db.prepare('DELETE FROM resolver_index WHERE owner_sub=? AND match_key=?');
      const ins = db.prepare('INSERT OR IGNORE INTO resolver_index (owner_sub, match_key, entity_id) VALUES (?,?,?)');
      for (const r of idx) {
        if (isIndexKey(r.match_key)) continue;
        del.run(r.owner_sub, r.match_key);
        ins.run(r.owner_sub, indexKey(r.owner_sub, r.match_key), r.entity_id);
      }
    });
    run();
    db.pragma('user_version = 1');
  }

  /** Canonical match keys for resolution — one per natural-key entry, lowercased + typed. */
  private keysFor(type: string, match: Record<string, string>): string[] {
    return Object.entries(match)
      .filter(([, v]) => v != null && String(v).trim() !== '')
      .map(([k, v]) => `${type}|${k}=${String(v).trim().toLowerCase()}`);
  }

  async resolveEntity(layout: VaultLayout, ownerSub: string, type: string, match: Record<string, string>): Promise<string | null> {
    const db = this.open(layout);
    for (const key of this.keysFor(type, match)) {
      const row = db.prepare('SELECT entity_id FROM resolver_index WHERE owner_sub=? AND match_key=?').get(ownerSub, indexKey(ownerSub, key)) as { entity_id?: string } | undefined;
      if (row?.entity_id) return row.entity_id;
    }
    return null;
  }

  async upsertEntity(layout: VaultLayout, ownerSub: string, c: EntityContribution, prov: Provenance): Promise<{ id: string; merged: boolean }> {
    const db = this.open(layout);
    const keys = this.keysFor(c.type, c.match);
    const existingId = await this.resolveEntity(layout, ownerSub, c.type, c.match);

    if (existingId) {
      // NON-DESTRUCTIVE merge: add new attr keys, fill an empty label, never overwrite existing values.
      const cur = db.prepare('SELECT label, attrs, world_ref FROM entities WHERE id=?').get(existingId) as { label?: string; attrs?: string; world_ref?: string };
      const curLabel = decryptField(ownerSub, cur?.label) || undefined;
      const curAttrs = JSON.parse(decryptField(ownerSub, cur?.attrs) || '{}');
      const mergedAttrs = { ...c.attrs, ...curAttrs }; // existing wins
      db.prepare('UPDATE entities SET label=?, attrs=?, world_ref=COALESCE(world_ref,?) WHERE id=?')
        .run(encryptField(ownerSub, curLabel || c.label), encryptField(ownerSub, JSON.stringify(mergedAttrs)), c.worldRef, existingId);
      this.indexKeys(db, ownerSub, keys, existingId);
      return { id: existingId, merged: true };
    }

    const id = makeEntityId(ownerSub, c.type, randomUUID().slice(0, 8));
    db.prepare('INSERT INTO entities (id, owner_sub, type, label, attrs, world_ref, source, ingested_at, confidence, derived_by) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, ownerSub, c.type, encryptField(ownerSub, c.label), encryptField(ownerSub, JSON.stringify(c.attrs)), c.worldRef, prov.source, prov.ingestedAt, c.confidence, prov.derivedBy ?? null);
    this.indexKeys(db, ownerSub, keys, id);
    return { id, merged: false };
  }

  private indexKeys(db: InstanceType<typeof Database>, ownerSub: string, keys: string[], entityId: string): void {
    const stmt = db.prepare('INSERT OR IGNORE INTO resolver_index (owner_sub, match_key, entity_id) VALUES (?,?,?)');
    for (const k of keys) stmt.run(ownerSub, indexKey(ownerSub, k), entityId);
  }

  async upsertEdge(layout: VaultLayout, ownerSub: string, fromId: string, toId: string, c: EdgeContribution, prov: Provenance): Promise<{ id: string }> {
    // Tenancy guard (ADR-056): both ends must be in this user's scope or be a shared world ref.
    if (!isInUserScope(fromId, ownerSub) || !isInUserScope(toId, ownerSub)) {
      throw new Error(`PIS vault: edge crosses scope (from=${fromId} to=${toId} owner=${ownerSub})`);
    }
    const db = this.open(layout);
    const id = `user:${ownerSub}:edge:${randomUUID().slice(0, 8)}`;
    db.prepare('INSERT OR IGNORE INTO edges (id, owner_sub, type, from_id, to_id, attrs, source, ingested_at, confidence) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, ownerSub, c.type, fromId, toId, encryptField(ownerSub, JSON.stringify(c.attrs)), prov.source, prov.ingestedAt, c.confidence);
    const row = db.prepare('SELECT id FROM edges WHERE owner_sub=? AND type=? AND from_id=? AND to_id=?').get(ownerSub, c.type, fromId, toId) as { id: string };
    return { id: row.id };
  }

  async writeFact(layout: VaultLayout, ownerSub: string, entityId: string, c: FactContribution, prov: Provenance): Promise<void> {
    const db = this.open(layout);
    db.prepare('INSERT OR REPLACE INTO facts (owner_sub, entity_id, metric, value, at, source, confidence) VALUES (?,?,?,?,?,?,?)')
      .run(ownerSub, entityId, c.metric, c.value, c.at, prov.source, c.confidence);
  }

  // ── Read side (the deterministic broker reads — ADR-056 — and verification) ────────────────────

  getEntities(layout: VaultLayout, ownerSub: string, type?: string): Array<{ id: string; type: string; label: string; attrs: Record<string, unknown>; worldRef: string | null }> {
    const db = this.open(layout);
    const rows = (type
      ? db.prepare('SELECT id,type,label,attrs,world_ref FROM entities WHERE owner_sub=? AND type=?').all(ownerSub, type)
      : db.prepare('SELECT id,type,label,attrs,world_ref FROM entities WHERE owner_sub=?').all(ownerSub)) as Array<{ id: string; type: string; label: string; attrs: string; world_ref: string | null }>;
    return rows.map((r) => ({ id: r.id, type: r.type, label: (decryptField(ownerSub, r.label) ?? '') as string, attrs: JSON.parse(decryptField(ownerSub, r.attrs) || '{}'), worldRef: r.world_ref }));
  }

  getEdges(layout: VaultLayout, ownerSub: string): Array<{ id: string; type: string; from: string; to: string }> {
    const db = this.open(layout);
    const rows = db.prepare('SELECT id,type,from_id,to_id FROM edges WHERE owner_sub=?').all(ownerSub) as Array<{ id: string; type: string; from_id: string; to_id: string }>;
    return rows.map((r) => ({ id: r.id, type: r.type, from: r.from_id, to: r.to_id }));
  }

  getFacts(layout: VaultLayout, ownerSub: string, entityId?: string): Array<{ entityId: string; metric: string; value: number; at: string }> {
    const db = this.open(layout);
    const rows = (entityId
      ? db.prepare('SELECT entity_id,metric,value,at FROM facts WHERE owner_sub=? AND entity_id=?').all(ownerSub, entityId)
      : db.prepare('SELECT entity_id,metric,value,at FROM facts WHERE owner_sub=?').all(ownerSub)) as Array<{ entity_id: string; metric: string; value: number; at: string }>;
    return rows.map((r) => ({ entityId: r.entity_id, metric: r.metric, value: r.value, at: r.at }));
  }

  /** "Relate two datasets" demo (the whole point): join holdings → securities → sector edges. */
  relateHoldingsToSectors(layout: VaultLayout, ownerSub: string): Array<{ holding: string; security: string; worldRef: string | null; sector: string | null }> {
    const db = this.open(layout);
    const rows = db.prepare(`
      SELECT h.id AS holding, s.label AS security, s.world_ref AS worldRef, sec.to_id AS sector
      FROM entities h
      JOIN edges e_of   ON e_of.owner_sub=h.owner_sub AND e_of.type='of'        AND e_of.from_id=h.id
      JOIN entities s   ON s.id=e_of.to_id AND s.type='security'
      LEFT JOIN edges sec ON sec.owner_sub=s.owner_sub AND sec.type='in_sector' AND sec.from_id=s.id
      WHERE h.owner_sub=? AND h.type='holding'
    `).all(ownerSub) as Array<{ holding: string; security: string; worldRef: string | null; sector: string | null }>;
    return rows.map((r) => ({ ...r, security: (decryptField(ownerSub, r.security) ?? '') as string }));
  }

  close(): void { for (const { db } of this.handles.values()) { try { db.close(); } catch { /* */ } } this.handles.clear(); }
}
