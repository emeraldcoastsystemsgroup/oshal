/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-118 Phase 2: durable per-user app assignments, explicit-deny-wins resolution, unsupported-stale-assignment fail-closed behavior, and operator assignment/list/clear operations.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Resolve and record an assignment against the FULL verified principal. A subject identifier is unique only inside its issuer, so keying on the subject alone left the control plane unable to tell a federated identity from a local account and it refused every non-local issuer a tier outright. An assignment stored before migration 145 carries no issuer and keeps its only safe meaning: a canonical local account, never a federated subject that happens to match.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Isolate same-subject principals in every lookup, upsert and clear; legacy NULL and explicit local issuer share one key.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { LOCAL_AUTH_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
import {
  isAppAccessTier,
  type AppAccessTier,
  type SwarmAppAccessDeclaration,
} from '../types';

const logger = createChildLogger({ module: 'app-access-service' });

/**
 * @description PostgreSQL `undefined_column`. Raised on a deployment whose database has not
 * applied scripts/migrations/145-app-access-principal-issuer.sql yet — which is every box
 * between this code shipping and that migration running. Every stored row is issuer-less
 * there, so the pre-145 rule is the complete answer and the fallback reproduces it exactly.
 */
const UNDEFINED_COLUMN = '42703';

/** Current assignment row returned to the operator management surface. */
export interface AppAccessAssignment {
  userSub: string;
  /** Issuer this assignment was written for; null means pre-145 and local-auth only. */
  userIssuer: string | null;
  appName: string;
  tier: AppAccessTier;
  assignedBySub: string;
  reason: string;
  createdAt: Date;
  updatedAt: Date;
}

/** One route request's resolved coarse access decision. */
export interface ResolvedAppAccess {
  appName: string;
  userSub: string | null;
  tier: AppAccessTier;
  bundle: string | null;
  source: 'explicit' | 'default' | 'unsupported_explicit';
}

/** Narrow port consumed by the app-layer dynamic route boundary. */
export interface AppAccessResolver {
  resolveForPrincipal(
    appName: string,
    userSub: string,
    userIssuer: string,
    declaration: SwarmAppAccessDeclaration,
  ): Promise<ResolvedAppAccess>;
}

interface AssignmentRow {
  user_sub: string;
  user_issuer: string | null;
  app_name: string;
  tier: string;
  assigned_by_sub: string;
  reason: string;
  created_at: Date;
  updated_at: Date;
}

const ASSIGNMENT_COLUMNS = 'user_sub, app_name, tier, assigned_by_sub, reason, created_at, updated_at';

/** Operations already reported as degraded, so a pre-145 database warns once rather than per call. */
const degraded = new Set<string>();

/**
 * @description Run an issuer-aware statement, falling back to its pre-145 form when this
 * database has no `user_issuer` column yet. Any other failure propagates untouched — the
 * fallback exists for one known missing column, not to soften an error.
 * @param issuerAware - The statement that reads or writes `user_issuer`.
 * @param legacy - The identical statement as it stood before migration 145.
 * @param context - Log context naming the operation that degraded.
 * @returns Whichever statement ran.
 */
async function withIssuerColumn<T>(
  issuerAware: () => Promise<T>,
  legacy: () => Promise<T>,
  context: Record<string, unknown>,
): Promise<T> {
  try {
    return await issuerAware();
  } catch (error) {
    if ((error as { code?: unknown }).code !== UNDEFINED_COLUMN) throw error;
    const operation = String(context.operation);
    if (!degraded.has(operation)) {
      // Once per operation, not per request: on a pre-145 database EVERY authorization decision
      // takes this path, and a per-call warning would bury the line that says to run the migration.
      degraded.add(operation);
      logger.warn(
        { ...context, migration: '145-app-access-principal-issuer.sql' },
        'Issuer-aware app access schema is incomplete; checking whether local-only compatibility is available',
      );
    }
    return legacy();
  }
}

/** @description Map a stored tier, failing a value the current vocabulary rejects closed to deny. */
function storedTier(raw: string | undefined): AppAccessTier | null {
  // The database CHECK should make an unknown value impossible. Treat drift as deny anyway.
  return isAppAccessTier(raw) ? raw : raw === undefined ? null : 'deny';
}

/**
 * @description PostgreSQL-backed ADR-118 access service. Every route lookup is constrained by
 * the exact `(user_sub, issuer, app_name)` tuple even when the caller's database context is privileged;
 * FORCE RLS remains a second boundary rather than the only object-level authorization check.
 */
export class AppAccessService implements AppAccessResolver {
  constructor(private readonly pool: Pool) {}

  /**
   * @description Compatibility API for canonical local accounts only. Production request callers
   * must use resolveForPrincipal with their verified issuer; no subject-only query is permitted.
   */
  async resolve(
    appName: string,
    userSub: string | null,
    declaration: SwarmAppAccessDeclaration,
  ): Promise<ResolvedAppAccess> {
    assertAppName(appName);
    if (userSub !== null) assertSubject(userSub, 'userSub');

    return userSub === null ? this.decide(appName, null, null, declaration)
      : this.resolveForPrincipal(appName, userSub, LOCAL_AUTH_PRINCIPAL_ISSUER, declaration);
  }

  /**
   * @description Resolve the assignment written for ONE verified principal: the (subject,
   * issuer) pair rather than the subject alone. A subject identifier is unique only inside
   * its issuer, so a federated subject and a local account that happen to share a string are
   * different people and must not read each other's assignment.
   *
   * An assignment stored before scripts/migrations/145-app-access-principal-issuer.sql has no
   * issuer, and the only identity that could have written it is a canonical local account, so
   * it answers for `urn:oshal:local-auth` and for nothing else. That legacy rule is the reason
   * the control plane used to refuse a tier to every other issuer outright; carrying the rule
   * in the predicate keeps it exact while letting an assignment that names its issuer resolve.
   *
   * @param appName - Application slug the assignment is scoped to.
   * @param userSub - Verified subject identifier.
   * @param userIssuer - Verified issuer namespace that authenticated that subject.
   * @param declaration - Manifest access declaration bounding the tier vocabulary.
   * @returns The same decision `resolve` returns, keyed on the full principal.
   */
  async resolveForPrincipal(
    appName: string,
    userSub: string,
    userIssuer: string,
    declaration: SwarmAppAccessDeclaration,
  ): Promise<ResolvedAppAccess> {
    assertAppName(appName);
    assertSubject(userSub, 'userSub');
    assertIssuer(userIssuer);

    const assigned = await withIssuerColumn(
      async () => {
        const result = await this.pool.query<Pick<AssignmentRow, 'tier'>>(
          `SELECT tier
             FROM oshal_app_access
            WHERE user_sub = $1 AND app_name = $2
              AND COALESCE(user_issuer, 'urn:oshal:local-auth') = $3
            LIMIT 1`,
          [userSub, appName, userIssuer],
        );
        return storedTier(result.rows[0]?.tier);
      },
      async () => {
        // Pre-145 every row is issuer-less, so only a local account can match one.
        if (userIssuer !== LOCAL_AUTH_PRINCIPAL_ISSUER) return null;
        const result = await this.pool.query<Pick<AssignmentRow, 'tier'>>(
          `SELECT tier
             FROM oshal_app_access
            WHERE user_sub = $1 AND app_name = $2
            LIMIT 1`,
          [userSub, appName],
        );
        return storedTier(result.rows[0]?.tier);
      },
      { appName, operation: 'resolveForPrincipal' },
    );

    return this.decide(appName, userSub, assigned, declaration);
  }

  /**
   * @description Apply the ADR-118 precedence to one already-looked-up assignment: an explicit
   * deny always wins, a tier the current manifest no longer supports fails closed to deny
   * rather than widening to the default, and absence falls back to the declared default.
   * @param appName - Application slug being resolved.
   * @param userSub - Subject the decision belongs to, or null for an anonymous caller.
   * @param assigned - The stored tier, or null when no assignment matched.
   * @param declaration - Manifest access declaration bounding the tier vocabulary.
   * @returns The resolved coarse access decision.
   */
  private decide(
    appName: string,
    userSub: string | null,
    assigned: AppAccessTier | null,
    declaration: SwarmAppAccessDeclaration,
  ): ResolvedAppAccess {
    let tier: AppAccessTier;
    let source: ResolvedAppAccess['source'];
    if (assigned === 'deny') {
      tier = 'deny';
      source = 'explicit';
    } else if (assigned !== null && declaration.supported.includes(assigned)) {
      tier = assigned;
      source = 'explicit';
    } else if (assigned !== null) {
      tier = 'deny';
      source = 'unsupported_explicit';
      logger.warn({ appName, userSub, assigned }, 'Unsupported app access assignment failed closed');
    } else {
      tier = declaration.defaultTier;
      source = 'default';
    }

    return {
      appName,
      userSub,
      tier,
      bundle: declaration.mappings?.[tier] ?? null,
      source,
    };
  }

  /** @description List assignments for the operator user-by-app matrix. RLS requires operator. */
  async listAssignments(): Promise<AppAccessAssignment[]> {
    const rows = await withIssuerColumn(
      async () => (await this.pool.query<AssignmentRow>(
        `SELECT ${ASSIGNMENT_COLUMNS}, user_issuer
           FROM oshal_app_access
          ORDER BY user_sub, app_name`,
      )).rows,
      async () => (await this.pool.query<Omit<AssignmentRow, 'user_issuer'>>(
        `SELECT ${ASSIGNMENT_COLUMNS}
           FROM oshal_app_access
          ORDER BY user_sub, app_name`,
      )).rows.map(row => ({ ...row, user_issuer: null })),
      { operation: 'listAssignments' },
    );
    return rows.map(mapAssignment);
  }

  /**
   * @description Insert or replace one explicit assignment, retaining its original creation time.
   * `userIssuer` names the verified identity provider the assignment is for; omitting it keeps
   * the pre-145 meaning (no issuer recorded, resolvable only by a canonical local account)
   * rather than guessing whichever provider this deployment happens to be configured with.
   * The key includes the issuer; granting another identity cannot overwrite an existing deny.
   */
  async assign(input: {
    userSub: string;
    userIssuer?: string | null;
    appName: string;
    tier: AppAccessTier;
    assignedBySub: string;
    reason: string;
  }): Promise<AppAccessAssignment> {
    assertSubject(input.userSub, 'userSub');
    assertSubject(input.assignedBySub, 'assignedBySub');
    assertAppName(input.appName);
    if (!isAppAccessTier(input.tier)) throw new TypeError('tier is not a known app access tier');
    const reason = assertReason(input.reason);
    const userIssuer = input.userIssuer ?? null;
    if (userIssuer !== null) assertIssuer(userIssuer);
    const values = [input.userSub, input.appName, input.tier, input.assignedBySub, reason];

    const row = await withIssuerColumn(
      () => upsertWithIssuer(this.pool, values, userIssuer),
      () => upsertWithoutIssuer(this.pool, values, userIssuer),
      { appName: input.appName, operation: 'assign' },
    );
    return mapAssignment(row);
  }

  /**
   * @description Remove one explicit assignment so the manifest default applies again.
   * The framework audit middleware records the operator request; this method logs the reason too.
   */
  async clear(input: {
    userSub: string;
    userIssuer?: string | null;
    appName: string;
    assignedBySub: string;
    reason: string;
  }): Promise<boolean> {
    assertSubject(input.userSub, 'userSub');
    assertSubject(input.assignedBySub, 'assignedBySub');
    assertAppName(input.appName);
    const reason = assertReason(input.reason);
    const userIssuer = input.userIssuer ?? LOCAL_AUTH_PRINCIPAL_ISSUER;
    assertIssuer(userIssuer);
    const result = await withIssuerColumn(
      () => this.pool.query(`DELETE FROM oshal_app_access
        WHERE user_sub = $1 AND app_name = $2 AND COALESCE(user_issuer, 'urn:oshal:local-auth') = $3`,
      [input.userSub, input.appName, userIssuer]),
      () => {
        if (userIssuer !== LOCAL_AUTH_PRINCIPAL_ISSUER) {
          throw new Error('Apply migration 145 before clearing an issuer-bound tier');
        }
        return this.pool.query(`DELETE FROM oshal_app_access WHERE user_sub = $1 AND app_name = $2`,
          [input.userSub, input.appName]);
      },
      { appName: input.appName, operation: 'clear' },
    );
    const cleared = (result.rowCount ?? 0) > 0;
    logger.info(
      { appName: input.appName, userSub: input.userSub, userIssuer, assignedBySub: input.assignedBySub, reason, cleared },
      'Explicit app access assignment clear requested',
    );
    return cleared;
  }
}

/**
 * @description Upsert one assignment, recording the issuer it was written for.
 * @param pool - Control-plane pool. @param values - user_sub, app_name, tier, assigned_by_sub, reason.
 * @param userIssuer - Verified issuer namespace, or null for no issuer binding.
 * @returns The stored row.
 */
async function upsertWithIssuer(pool: Pool, values: unknown[], userIssuer: string | null): Promise<AssignmentRow> {
  const result = await pool.query<AssignmentRow>(
    `INSERT INTO oshal_app_access
       (user_sub, app_name, tier, assigned_by_sub, reason, user_issuer)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_sub, app_name, principal_issuer) DO UPDATE
       SET tier = EXCLUDED.tier,
           assigned_by_sub = EXCLUDED.assigned_by_sub,
           reason = EXCLUDED.reason,
           user_issuer = EXCLUDED.user_issuer,
           updated_at = NOW()
     RETURNING ${ASSIGNMENT_COLUMNS}, user_issuer`,
    [...values, userIssuer],
  );
  return result.rows[0];
}

/**
 * @description The pre-145 upsert, for a database that has no `user_issuer` column yet. A
 * requested issuer binding is REFUSED rather than dropped: an assignment the operator believes is
 * bound to one identity must never be stored in a shape a different identity can resolve.
 * @param pool - Control-plane pool. @param values - user_sub, app_name, tier, assigned_by_sub, reason.
 * @param userIssuer - The binding that was asked for; anything but null fails loudly.
 * @returns The stored row, reported as carrying no issuer.
 */
async function upsertWithoutIssuer(pool: Pool, values: unknown[], userIssuer: string | null): Promise<AssignmentRow> {
  if (userIssuer !== null) {
    throw new Error('oshal_app_access.user_issuer is missing; apply migration 145 before assigning an issuer-bound tier');
  }
  // An earlier additive-only 145 schema has user_issuer but no principal key. Never
  // fall back to its subject-only arbiter, which could overwrite another issuer's row.
  const columns = await pool.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'oshal_app_access'::regclass
      AND attname = 'user_issuer' AND NOT attisdropped) AS present`,
  );
  if (columns.rows[0]?.present) throw new Error('Apply migration 145 principal key before assigning a tier');
  const result = await pool.query<Omit<AssignmentRow, 'user_issuer'>>(
    `INSERT INTO oshal_app_access
       (user_sub, app_name, tier, assigned_by_sub, reason)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_sub, app_name) DO UPDATE
       SET tier = EXCLUDED.tier,
           assigned_by_sub = EXCLUDED.assigned_by_sub,
           reason = EXCLUDED.reason,
           updated_at = NOW()
     RETURNING ${ASSIGNMENT_COLUMNS}`,
    values,
  );
  return { ...result.rows[0], user_issuer: null };
}

function mapAssignment(row: AssignmentRow): AppAccessAssignment {
  if (!row || !isAppAccessTier(row.tier)) throw new Error('Invalid app access row returned by PostgreSQL');
  return {
    userSub: row.user_sub,
    userIssuer: row.user_issuer ?? null,
    appName: row.app_name,
    tier: row.tier,
    assignedBySub: row.assigned_by_sub,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertSubject(value: string, field: string): void {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 512) {
    throw new TypeError(`${field} must be an exact non-empty UTF-8 subject up to 512 bytes`);
  }
}

/**
 * @description Bound a verified issuer namespace to the same 2048-byte shape
 * `normalizePrincipalIssuer` already accepts, so a stored assignment can never carry an
 * issuer the authenticated-principal rail would refuse to produce.
 * @param value - Candidate issuer namespace.
 */
function assertIssuer(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 2_048) {
    throw new TypeError('userIssuer must be an exact non-empty UTF-8 issuer up to 2048 bytes');
  }
}

function assertAppName(value: string): void {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(value)) {
    throw new TypeError('appName must be a 2-64 character lowercase app slug');
  }
}

function assertReason(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2_000) {
    throw new TypeError('reason must be a non-empty string up to 2000 characters');
  }
  return value.trim();
}
