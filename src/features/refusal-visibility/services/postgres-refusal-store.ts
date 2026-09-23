/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com   | Add the durable P1 refusal ledger, owner-or-operator RLS bootstrap, owner-stamped writer, and bounded caller-scoped recent-refusal reader.
 */

import type { Pool } from 'pg';
import type { RefusalEventInput, RefusalRecorder, RefusalTargetKind } from '@/shared/refusal-events';
import { buildOwnerRlsPolicyStatements, runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';

const TABLE = 'oshal_refusals';

/** Migration 155 statements, also used to validate fresh and hosted runtimes. */
export const REFUSAL_LEDGER_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${TABLE} (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL CHECK (length(btrim(code)) > 0),
    owner_sub TEXT NOT NULL CHECK (length(btrim(owner_sub)) > 0),
    actor_sub TEXT NOT NULL CHECK (length(btrim(actor_sub)) > 0),
    actor_issuer TEXT,
    owning_package TEXT NOT NULL CHECK (length(btrim(owning_package)) > 0),
    target_kind TEXT NOT NULL CHECK (target_kind IN ('agent','job','route','ticket','tool','other')),
    target TEXT NOT NULL CHECK (length(btrim(target)) > 0),
    prepared_execution_id TEXT,
    remedy TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE INDEX IF NOT EXISTS oshal_refusals_occurred_at ON ${TABLE} (occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS oshal_refusals_code_occurred_at ON ${TABLE} (code, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS oshal_refusals_package_target ON ${TABLE} (owning_package, target_kind, target)`,
  ...buildOwnerRlsPolicyStatements(TABLE, 'owner_sub'),
];

/** One refusal as returned by the caller-scoped operations API. */
export interface RefusalRecord {
  id: string;
  code: string;
  actorSub: string;
  actorIssuer: string | null;
  owningPackage: string;
  targetKind: RefusalTargetKind;
  target: string;
  preparedExecutionId: string | null;
  remedy: string | null;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

interface RefusalRow {
  id: string;
  code: string;
  actor_sub: string;
  actor_issuer: string | null;
  owning_package: string;
  target_kind: RefusalTargetKind;
  target: string;
  prepared_execution_id: string | null;
  remedy: string | null;
  metadata: Record<string, unknown>;
  occurred_at: Date | string;
}

/** @description Create or validate the refusal schema before a ledger operation. */
export async function ensureRefusalLedgerSchema(pool: Pool): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'refusal ledger',
    lockKey: 7149155,
    statements: REFUSAL_LEDGER_SCHEMA,
    requirements: [{
      table: TABLE,
      columns: [
        'id', 'code', 'owner_sub', 'actor_sub', 'owning_package', 'target_kind', 'target',
        'prepared_execution_id', 'remedy', 'occurred_at',
      ],
    }],
  });
}

/** PostgreSQL refusal recorder and caller-scoped reader. */
export class PostgresRefusalStore implements RefusalRecorder {
  private pending: Promise<void> | null = null;

  /** @param pool The GUC-stamped controller pool. @param beforeReady Migration readiness barrier. */
  constructor(
    private readonly pool: Pool,
    private readonly beforeReady: () => Promise<unknown> = () => Promise.resolve(),
  ) {}

  /** @description Wait for migrations, then create/validate the table; retry after a failure. */
  async ready(): Promise<void> {
    if (!this.pending) {
      this.pending = this.beforeReady()
        .then(() => ensureRefusalLedgerSchema(this.pool))
        .catch((error) => { this.pending = null; throw error; });
    }
    return this.pending;
  }

  /** @description Insert under the refusing actor's identity so RLS checks the durable owner. */
  async record(input: RefusalEventInput): Promise<void> {
    await this.ready();
    await runWithRequestIdentity({
      sub: input.actorSub,
      principalIssuer: input.actorIssuer ?? null,
      isOperator: false,
    }, () => this.pool.query(
      `INSERT INTO ${TABLE} (
         code, owner_sub, actor_sub, actor_issuer, owning_package, target_kind, target,
         prepared_execution_id, remedy, metadata, occurred_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,COALESCE($11::timestamptz,NOW()))`,
      [
        input.code, input.actorSub, input.actorSub, input.actorIssuer ?? null,
        input.owningPackage, input.targetKind, input.target,
        input.preparedExecutionId ?? null, input.remedy ?? null,
        JSON.stringify(input.metadata ?? {}), input.occurredAt ?? null,
      ],
    ));
  }

  /**
   * @description Read a bounded trailing window. PostgreSQL RLS scopes an ordinary caller and
   * widens an operator; no application owner filter is allowed to become a second authority.
   */
  async listRecent(hours: number, limit: number): Promise<RefusalRecord[]> {
    await this.ready();
    const result = await this.pool.query<RefusalRow>(
      `SELECT id::text, code, actor_sub, actor_issuer, owning_package, target_kind, target,
              prepared_execution_id, remedy, metadata, occurred_at
         FROM ${TABLE}
        WHERE occurred_at >= NOW() - ($1::int * INTERVAL '1 hour')
        ORDER BY occurred_at DESC, id DESC
        LIMIT $2`,
      [hours, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      code: row.code,
      actorSub: row.actor_sub,
      actorIssuer: row.actor_issuer,
      owningPackage: row.owning_package,
      targetKind: row.target_kind,
      target: row.target,
      preparedExecutionId: row.prepared_execution_id,
      remedy: row.remedy,
      metadata: row.metadata ?? {},
      occurredAt: row.occurred_at instanceof Date
        ? row.occurred_at.toISOString()
        : new Date(row.occurred_at).toISOString(),
    }));
  }
}
