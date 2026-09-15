/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | ADR-157: durable activation rows behind the same owner-or-operator row security the rest of the control plane uses — a person sees their own activation, a system activation belongs to no person and is control-plane only. Migration 144 and this bootstrap carry identical DDL.
 *
 * @module service-activation-store
 */
import type { Pool } from 'pg';
import { buildOwnerRlsPolicyStatements, runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import type {
  ApplicationServiceActivation,
  ApplicationServiceActivationKey,
  ApplicationServiceActivationStore,
} from './service-activation-types';

const TABLE = 'oshal_application_service_activations';

/** @description Migration 144 statements, shared with disposable integration fixtures. */
export const APPLICATION_SERVICE_ACTIVATION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${TABLE} (
    id TEXT PRIMARY KEY,
    app TEXT NOT NULL,
    schedule_id TEXT NOT NULL,
    runs_as TEXT NOT NULL CHECK (runs_as IN ('system','user')),
    target_sub TEXT,
    target_issuer TEXT,
    tenant_id TEXT,
    requires TEXT[] NOT NULL DEFAULT '{}',
    catalog_revision TEXT NOT NULL,
    activated_by_sub TEXT NOT NULL,
    activated_by_issuer TEXT NOT NULL,
    activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_by_sub TEXT,
    revoked_by_issuer TEXT,
    revoked_at TIMESTAMPTZ,
    suspended_reason TEXT,
    suspended_at TIMESTAMPTZ,
    CHECK ((runs_as = 'user') = (target_sub IS NOT NULL)),
    CHECK ((target_sub IS NULL) = (target_issuer IS NULL)))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS application_service_activation_live
    ON ${TABLE} (app, schedule_id, COALESCE(target_sub,''), COALESCE(target_issuer,''))
    WHERE revoked_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS application_service_activation_app ON ${TABLE} (app, schedule_id)`,
  ...buildOwnerRlsPolicyStatements(TABLE, 'target_sub'),
];

/** @description Create the activation table if absent and verify it before any activation read.
 * @param pool - Controller database pool.
 * @returns Resolves once the schema is present, or rejects with the bootstrap's own failure.
 */
export async function ensureApplicationServiceActivationSchema(pool: Pool): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool, moduleName: 'application service activations', lockKey: 7149144,
    statements: APPLICATION_SERVICE_ACTIVATION_SCHEMA,
    requirements: [{ table: TABLE, columns: ['id', 'app', 'schedule_id', 'runs_as', 'requires', 'revoked_at'] }],
  });
}

interface ActivationRow {
  id: string; app: string; schedule_id: string; runs_as: 'system' | 'user';
  target_sub: string | null; target_issuer: string | null; tenant_id: string | null;
  requires: string[]; catalog_revision: string;
  activated_by_sub: string; activated_by_issuer: string; activated_at: Date | string;
  revoked_by_sub: string | null; revoked_by_issuer: string | null; revoked_at: Date | string | null;
  suspended_reason: string | null; suspended_at: Date | string | null;
}

const COLUMNS = `id, app, schedule_id, runs_as, target_sub, target_issuer, tenant_id, requires,
  catalog_revision, activated_by_sub, activated_by_issuer, activated_at, revoked_by_sub,
  revoked_by_issuer, revoked_at, suspended_reason, suspended_at`;

/** @description Render a timestamp column as ISO-8601 without inventing a value for NULL. */
function iso(value: Date | string | null): string | undefined {
  if (value === null) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** @description Map one stored row onto the activation contract, dropping absent optionals. */
function toActivation(row: ActivationRow): ApplicationServiceActivation {
  return {
    id: row.id, app: row.app, scheduleId: row.schedule_id, runsAs: row.runs_as,
    ...(row.target_sub ? { targetSub: row.target_sub } : {}),
    ...(row.target_issuer ? { targetIssuer: row.target_issuer } : {}),
    ...(row.tenant_id ? { tenantId: row.tenant_id } : {}),
    requires: [...(row.requires ?? [])], catalogRevision: row.catalog_revision,
    activatedBySub: row.activated_by_sub, activatedByIssuer: row.activated_by_issuer,
    activatedAt: iso(row.activated_at) ?? new Date(0).toISOString(),
    ...(row.revoked_by_sub ? { revokedBySub: row.revoked_by_sub } : {}),
    ...(row.revoked_by_issuer ? { revokedByIssuer: row.revoked_by_issuer } : {}),
    ...(iso(row.revoked_at) ? { revokedAt: iso(row.revoked_at)! } : {}),
    ...(row.suspended_reason ? { suspendedReason: row.suspended_reason } : {}),
    ...(iso(row.suspended_at) ? { suspendedAt: iso(row.suspended_at)! } : {}),
  };
}

/**
 * Durable activation rows. Every statement runs under the trusted system identity because this
 * is control-plane state: the service has already decided who may see or change a row.
 */
export class PostgresApplicationServiceActivationStore implements ApplicationServiceActivationStore {
  /** @description Hold the controller pool and the schema readiness barrier.
   * @param pool - Controller database. @param ready - Activation schema readiness, re-requested per operation.
   */
  constructor(private readonly pool: Pool, private readonly ready: () => Promise<unknown> = () => Promise.resolve()) {}

  /** @description Read every live activation of one application.
   * @param app - Installed application name. @returns Its activations, newest first.
   */
  async listByApp(app: string): Promise<ApplicationServiceActivation[]> {
    return (await this.query(`WHERE app=$1 AND revoked_at IS NULL ORDER BY activated_at DESC`, [app])).map(toActivation);
  }

  /** @description Read every live activation across applications.
   * @returns All activations that have not been revoked.
   */
  async listLive(): Promise<ApplicationServiceActivation[]> {
    return (await this.query('WHERE revoked_at IS NULL ORDER BY app, schedule_id', [])).map(toActivation);
  }

  /** @description Read the one live activation matching a schedule and principal.
   * @param key - App, schedule and (for a user service) the person. @returns The row, or null.
   */
  async findLive(key: ApplicationServiceActivationKey): Promise<ApplicationServiceActivation | null> {
    const rows = await this.query(
      `WHERE app=$1 AND schedule_id=$2 AND revoked_at IS NULL
         AND COALESCE(target_sub,'')=$3 AND COALESCE(target_issuer,'')=$4`,
      [key.app, key.scheduleId, key.targetSub ?? '', key.targetIssuer ?? ''],
    );
    return rows[0] ? toActivation(rows[0]) : null;
  }

  /** @description Resolve the activation one due tick runs under.
   * @param app - Installed application name. @param scheduleId - Full schedule id.
   * @param ownerSub - The schedule instance's owner, or null for the framework instance.
   * @returns The live activation, or null when the tick is not activated.
   */
  async findLiveForDispatch(app: string, scheduleId: string, ownerSub: string | null): Promise<ApplicationServiceActivation | null> {
    const rows = ownerSub === null
      ? await this.query(`WHERE app=$1 AND schedule_id=$2 AND revoked_at IS NULL AND target_sub IS NULL`, [app, scheduleId])
      : await this.query(`WHERE app=$1 AND schedule_id=$2 AND revoked_at IS NULL AND target_sub=$3`, [app, scheduleId, ownerSub]);
    if (rows.length > 1) throw new Error('Ambiguous live service activation for one schedule instance');
    return rows[0] ? toActivation(rows[0]) : null;
  }

  /** @description Read one activation by id regardless of state.
   * @param id - Activation identifier. @returns The row, or null.
   */
  async read(id: string): Promise<ApplicationServiceActivation | null> {
    const rows = await this.query('WHERE id=$1', [id]);
    return rows[0] ? toActivation(rows[0]) : null;
  }

  /** @description Insert a new activation row.
   * @param activation - Fully resolved record. @returns Completion after the insert.
   */
  async insert(activation: ApplicationServiceActivation): Promise<void> {
    await this.ready();
    await runWithSystemIdentity(() => this.pool.query(
      `INSERT INTO ${TABLE} (id, app, schedule_id, runs_as, target_sub, target_issuer, tenant_id,
        requires, catalog_revision, activated_by_sub, activated_by_issuer, activated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10,$11,$12)`,
      [activation.id, activation.app, activation.scheduleId, activation.runsAs,
        activation.targetSub ?? null, activation.targetIssuer ?? null, activation.tenantId ?? null,
        activation.requires, activation.catalogRevision, activation.activatedBySub,
        activation.activatedByIssuer, activation.activatedAt],
    ));
  }

  /** @description Close a live activation, keeping the row for the audit trail.
   * @param id - Activation identifier. @param by - Who revoked it. @param at - ISO revocation time.
   * @returns True when a live row was closed.
   */
  async revoke(id: string, by: { sub: string; issuer: string }, at: string): Promise<boolean> {
    await this.ready();
    const result = await runWithSystemIdentity(() => this.pool.query(
      `UPDATE ${TABLE} SET revoked_by_sub=$2, revoked_by_issuer=$3, revoked_at=$4
       WHERE id=$1 AND revoked_at IS NULL`, [id, by.sub, by.issuer, at]));
    return (result.rowCount ?? 0) > 0;
  }

  /** @description Record that a tick was denied so the panel can show why it stopped.
   * @param id - Activation identifier. @param reason - The decision's reason code.
   * @param at - ISO suspension time. @returns Completion after the update.
   */
  async suspend(id: string, reason: string, at: string): Promise<void> {
    await this.ready();
    await runWithSystemIdentity(() => this.pool.query(
      `UPDATE ${TABLE} SET suspended_reason=$2, suspended_at=$3 WHERE id=$1 AND revoked_at IS NULL`,
      [id, reason, at]));
  }

  /** @description Run one parameterised read against the activation table. */
  private async query(where: string, values: unknown[]): Promise<ActivationRow[]> {
    await this.ready();
    const result = await runWithSystemIdentity(() => this.pool.query<ActivationRow>(
      `SELECT ${COLUMNS} FROM ${TABLE} ${where}`, values));
    return result.rows;
  }
}

/**
 * Isolated activation state for fixtures and route/runner specs. Production always injects the
 * PostgreSQL store — this one holds no row security and therefore proves nothing about RLS.
 */
export class MemoryApplicationServiceActivationStore implements ApplicationServiceActivationStore {
  private readonly rows: ApplicationServiceActivation[] = [];

  /** @description Read every live activation of one application.
   * @param app - Installed application name. @returns Independent copies of its live rows.
   */
  async listByApp(app: string): Promise<ApplicationServiceActivation[]> {
    return this.rows.filter(row => row.app === app && !row.revokedAt).map(row => structuredClone(row));
  }

  /** @description Read every live activation across applications. @returns Independent copies. */
  async listLive(): Promise<ApplicationServiceActivation[]> {
    return this.rows.filter(row => !row.revokedAt).map(row => structuredClone(row));
  }

  /** @description Read the one live activation matching the key.
   * @param key - App, schedule and (for a user service) the person. @returns A copy, or null.
   */
  async findLive(key: ApplicationServiceActivationKey): Promise<ApplicationServiceActivation | null> {
    const found = this.rows.find(row => !row.revokedAt && row.app === key.app && row.scheduleId === key.scheduleId
      && (row.targetSub ?? '') === (key.targetSub ?? '') && (row.targetIssuer ?? '') === (key.targetIssuer ?? ''));
    return found ? structuredClone(found) : null;
  }

  /** @description Resolve the activation one due tick runs under.
   * @param app - Installed application. @param scheduleId - Full schedule id.
   * @param ownerSub - The instance's owner, or null for the framework instance. @returns A copy, or null.
   */
  async findLiveForDispatch(app: string, scheduleId: string, ownerSub: string | null): Promise<ApplicationServiceActivation | null> {
    const matches = this.rows.filter(row => !row.revokedAt && row.app === app && row.scheduleId === scheduleId
      && (ownerSub === null ? row.targetSub === undefined : row.targetSub === ownerSub));
    if (matches.length > 1) throw new Error('Ambiguous live service activation for one schedule instance');
    return matches[0] ? structuredClone(matches[0]) : null;
  }

  /** @description Read one activation by id. @param id - Identifier. @returns A copy, or null. */
  async read(id: string): Promise<ApplicationServiceActivation | null> {
    const found = this.rows.find(row => row.id === id);
    return found ? structuredClone(found) : null;
  }

  /** @description Insert one activation, refusing a second live row for the same principal.
   * @param activation - Fully resolved record. @returns Completion after the insert.
   */
  async insert(activation: ApplicationServiceActivation): Promise<void> {
    if (await this.findLive(activation)) throw new Error('Duplicate live service activation');
    this.rows.push(structuredClone(activation));
  }

  /** @description Close a live activation.
   * @param id - Identifier. @param by - Who revoked it. @param at - ISO time. @returns True when closed.
   */
  async revoke(id: string, by: { sub: string; issuer: string }, at: string): Promise<boolean> {
    const row = this.rows.find(item => item.id === id && !item.revokedAt);
    if (!row) return false;
    row.revokedBySub = by.sub; row.revokedByIssuer = by.issuer; row.revokedAt = at;
    return true;
  }

  /** @description Record a denied tick.
   * @param id - Identifier. @param reason - Decision reason. @param at - ISO time. @returns Completion.
   */
  async suspend(id: string, reason: string, at: string): Promise<void> {
    const row = this.rows.find(item => item.id === id && !item.revokedAt);
    if (row) { row.suspendedReason = reason; row.suspendedAt = at; }
  }
}
