/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 Phase 1 — SpatialScanStore: the spaces-operator bot's owner-scoped scan store (ADR-036). Every query is pinned to WHERE user_sub=$1 so cross-user rows are impossible by construction; the GUC-wrapped pool + spatial_scans RLS are the defense-in-depth beneath that. ensureSchema bootstraps the table + the SAME owner-or-operator policy the 093 migration installs, so a fresh boot is never policy-less.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { buildOwnerRlsPolicyStatements } from '@/shared/services/database/owner-rls-policy';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database/schema-bootstrap-policy';
import { SCHEMA_LOCK_KEYS } from '@/shared/services/database/schema-lock';
import type {
  SpatialScan,
  ScanStatus,
  ScanSourceKind,
  ReconstructionProviderKind,
  RegisterScanInput,
} from '../model/spatial-types';

const logger = createChildLogger({ module: 'spatial-scan-store' });

const SELECT_COLS =
  'id, user_sub, title, status, source_kind, source_name, source_ref, source_bytes, provider, artifact_ref, gaussian_count, error, created_at, updated_at';

/** Raw DB row shape (snake_case) for spatial_scans. */
interface ScanRow {
  id: string;
  user_sub: string;
  title: string;
  status: ScanStatus;
  source_kind: ScanSourceKind;
  source_name: string | null;
  source_ref: string | null;
  source_bytes: string | number | null;
  provider: ReconstructionProviderKind | null;
  artifact_ref: string | null;
  gaussian_count: number | null;
  error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

/** Result of a completed reconstruction, written onto the row. */
export interface ReadyPatch {
  provider: ReconstructionProviderKind;
  artifactRef: string;
  gaussianCount: number;
}

const toIso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));

/** Map a DB row to the domain type. */
function mapRow(r: ScanRow): SpatialScan {
  return {
    id: r.id,
    userSub: r.user_sub,
    title: r.title,
    status: r.status,
    sourceKind: r.source_kind,
    sourceName: r.source_name,
    sourceRef: r.source_ref,
    sourceBytes: r.source_bytes === null ? null : Number(r.source_bytes),
    provider: r.provider,
    artifactRef: r.artifact_ref,
    gaussianCount: r.gaussian_count,
    error: r.error,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

/**
 * @description Owner-scoped CRUD for reconstruction scans. Every method takes the
 * caller's `userSub` as its first argument and pins it into the query — the store
 * never trusts an ambient identity for the row's owner column.
 */
export class SpatialScanStore {
  private readonly pool: Pool;
  private schemaReady: Promise<void> | null = null;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** Idempotent table + index + RLS bootstrap (cached; retried on failure). */
  async ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.createSchema().catch((err) => {
        this.schemaReady = null;
        throw err;
      });
    }
    return this.schemaReady;
  }

  private async createSchema(): Promise<void> {
    // Bootstrap via the sanctioned path (like every other lazy-schema store): applies the
    // idempotent DDL under an advisory lock in auto/apply mode, and VALIDATES the migration-093
    // table+columns (no DDL) under OSHAL_SCHEMA_BOOTSTRAP=validate-only — where a raw CREATE
    // would be rejected by the runtime DDL guard and kill the whole feature.
    await runRuntimeSchemaBootstrap({
      pool: this.pool,
      moduleName: 'spatial-scans',
      lockKey: SCHEMA_LOCK_KEYS.spatialScans,
      statements: [
        `CREATE TABLE IF NOT EXISTS spatial_scans (
          id TEXT PRIMARY KEY,
          user_sub TEXT NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          source_kind TEXT NOT NULL DEFAULT 'video',
          source_name TEXT,
          source_ref TEXT,
          source_bytes BIGINT,
          provider TEXT,
          artifact_ref TEXT,
          gaussian_count INTEGER,
          error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        'CREATE INDEX IF NOT EXISTS spatial_scans_user_created_idx ON spatial_scans (user_sub, created_at DESC)',
        ...buildOwnerRlsPolicyStatements('spatial_scans', 'user_sub'),
      ],
      requirements: [
        { table: 'spatial_scans', columns: ['id', 'user_sub', 'title', 'status', 'source_kind', 'artifact_ref', 'created_at'] },
      ],
    });
  }

  /**
   * @description Insert a freshly-uploaded scan in the `queued` state.
   * @param input - The scan's id, owner, title and stored-source metadata
   * @returns The inserted scan
   */
  async insert(input: RegisterScanInput): Promise<SpatialScan> {
    await this.ensureSchema();
    const row = (
      await this.pool.query<ScanRow>(
        `INSERT INTO spatial_scans (id, user_sub, title, status, source_kind, source_name, source_ref, source_bytes)
         VALUES ($1,$2,$3,'queued',$4,$5,$6,$7) RETURNING ${SELECT_COLS}`,
        [input.id, input.userSub, input.title, input.sourceKind, input.sourceName, input.sourceRef, input.sourceBytes],
      )
    ).rows[0];
    return mapRow(row);
  }

  /**
   * @description List a user's scans, newest first.
   * @param userSub - Owning user's sub
   * @returns The user's scans
   */
  async listByUser(userSub: string): Promise<SpatialScan[]> {
    await this.ensureSchema();
    const res = await this.pool.query<ScanRow>(
      `SELECT ${SELECT_COLS} FROM spatial_scans WHERE user_sub=$1 ORDER BY created_at DESC LIMIT 200`,
      [userSub],
    );
    return res.rows.map(mapRow);
  }

  /**
   * @description Fetch one scan the user owns.
   * @param userSub - Owning user's sub
   * @param id - Scan id
   * @returns The scan, or null if it isn't the user's
   */
  async getById(userSub: string, id: string): Promise<SpatialScan | null> {
    await this.ensureSchema();
    const res = await this.pool.query<ScanRow>(
      `SELECT ${SELECT_COLS} FROM spatial_scans WHERE user_sub=$1 AND id=$2`,
      [userSub, id],
    );
    return res.rows[0] ? mapRow(res.rows[0]) : null;
  }

  /** Advance a scan into the reconstructing state. */
  async markReconstructing(userSub: string, id: string): Promise<void> {
    await this.setStatus(userSub, id, 'reconstructing');
  }

  /**
   * @description Mark a scan ready and record its produced artifact.
   * @param userSub - Owning user's sub
   * @param id - Scan id
   * @param patch - Provider, artifact path, and gaussian count
   */
  async markReady(userSub: string, id: string, patch: ReadyPatch): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `UPDATE spatial_scans
         SET status='ready', provider=$3, artifact_ref=$4, gaussian_count=$5, error=NULL, updated_at=now()
       WHERE user_sub=$1 AND id=$2`,
      [userSub, id, patch.provider, patch.artifactRef, patch.gaussianCount],
    );
  }

  /**
   * @description Mark a scan failed with a message.
   * @param userSub - Owning user's sub
   * @param id - Scan id
   * @param error - Failure detail
   */
  async markFailed(userSub: string, id: string, error: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `UPDATE spatial_scans SET status='failed', error=$3, updated_at=now() WHERE user_sub=$1 AND id=$2`,
      [userSub, id, error.slice(0, 500)],
    );
  }

  /**
   * @description Count a user's scans (for the per-user quota gate).
   * @param userSub - Owning user's sub
   * @returns The number of scans the user owns
   */
  async countByUser(userSub: string): Promise<number> {
    await this.ensureSchema();
    const res = await this.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM spatial_scans WHERE user_sub=$1',
      [userSub],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  /**
   * @description List non-terminal scans older than a cutoff (orphan detection).
   * @param userSub - Owning user's sub
   * @param cutoffIso - ISO timestamp; rows updated before this are stale
   * @returns The stale non-terminal scans
   */
  async listStaleNonTerminal(userSub: string, cutoffIso: string): Promise<SpatialScan[]> {
    await this.ensureSchema();
    const res = await this.pool.query<ScanRow>(
      `SELECT ${SELECT_COLS} FROM spatial_scans
       WHERE user_sub=$1 AND status IN ('queued','reconstructing') AND updated_at < $2`,
      [userSub, cutoffIso],
    );
    return res.rows.map(mapRow);
  }

  /**
   * @description Delete a scan the user owns (row only; callers remove files).
   * @param userSub - Owning user's sub
   * @param id - Scan id
   * @returns True if a row was deleted
   */
  async delete(userSub: string, id: string): Promise<boolean> {
    await this.ensureSchema();
    const res = await this.pool.query(
      'DELETE FROM spatial_scans WHERE user_sub=$1 AND id=$2',
      [userSub, id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  private async setStatus(userSub: string, id: string, status: ScanStatus): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      'UPDATE spatial_scans SET status=$3, updated_at=now() WHERE user_sub=$1 AND id=$2',
      [userSub, id, status],
    );
    logger.debug({ userSub, id, status }, 'scan status updated');
  }
}
