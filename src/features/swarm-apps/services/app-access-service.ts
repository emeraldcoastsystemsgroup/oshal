/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-118 Phase 2: durable per-user app assignments, explicit-deny-wins resolution, unsupported-stale-assignment fail-closed behavior, and operator assignment/list/clear operations.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import {
  isAppAccessTier,
  type AppAccessTier,
  type SwarmAppAccessDeclaration,
} from '../types';

const logger = createChildLogger({ module: 'app-access-service' });

/** Current assignment row returned to the operator management surface. */
export interface AppAccessAssignment {
  userSub: string;
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
  resolve(
    appName: string,
    userSub: string | null,
    declaration: SwarmAppAccessDeclaration,
  ): Promise<ResolvedAppAccess>;
}

interface AssignmentRow {
  user_sub: string;
  app_name: string;
  tier: string;
  assigned_by_sub: string;
  reason: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * @description PostgreSQL-backed ADR-118 access service. Every route lookup is constrained by
 * the exact `(user_sub, app_name)` tuple even when the caller's database context is privileged;
 * FORCE RLS remains a second boundary rather than the only object-level authorization check.
 */
export class AppAccessService implements AppAccessResolver {
  constructor(private readonly pool: Pool) {}

  /**
   * @description Resolve explicit assignment first, then the manifest default. An explicit deny
   * always wins. A stale explicit tier that the current manifest no longer supports fails closed
   * to deny instead of silently widening to the default.
   */
  async resolve(
    appName: string,
    userSub: string | null,
    declaration: SwarmAppAccessDeclaration,
  ): Promise<ResolvedAppAccess> {
    assertAppName(appName);
    if (userSub !== null) assertSubject(userSub, 'userSub');

    let assigned: AppAccessTier | null = null;
    if (userSub !== null) {
      const result = await this.pool.query<Pick<AssignmentRow, 'tier'>>(
        `SELECT tier
           FROM oshal_app_access
          WHERE user_sub = $1 AND app_name = $2
          LIMIT 1`,
        [userSub, appName],
      );
      const raw = result.rows[0]?.tier;
      // The database CHECK should make an unknown value impossible. Treat drift as deny anyway.
      assigned = isAppAccessTier(raw) ? raw : raw === undefined ? null : 'deny';
    }

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
    const result = await this.pool.query<AssignmentRow>(
      `SELECT user_sub, app_name, tier, assigned_by_sub, reason, created_at, updated_at
         FROM oshal_app_access
        ORDER BY user_sub, app_name`,
    );
    return result.rows.map(mapAssignment);
  }

  /** @description Insert or replace one explicit assignment, retaining its original creation time. */
  async assign(input: {
    userSub: string;
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

    const result = await this.pool.query<AssignmentRow>(
      `INSERT INTO oshal_app_access
         (user_sub, app_name, tier, assigned_by_sub, reason)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_sub, app_name) DO UPDATE
         SET tier = EXCLUDED.tier,
             assigned_by_sub = EXCLUDED.assigned_by_sub,
             reason = EXCLUDED.reason,
             updated_at = NOW()
       RETURNING user_sub, app_name, tier, assigned_by_sub, reason, created_at, updated_at`,
      [input.userSub, input.appName, input.tier, input.assignedBySub, reason],
    );
    return mapAssignment(result.rows[0]);
  }

  /**
   * @description Remove one explicit assignment so the manifest default applies again.
   * The framework audit middleware records the operator request; this method logs the reason too.
   */
  async clear(input: {
    userSub: string;
    appName: string;
    assignedBySub: string;
    reason: string;
  }): Promise<boolean> {
    assertSubject(input.userSub, 'userSub');
    assertSubject(input.assignedBySub, 'assignedBySub');
    assertAppName(input.appName);
    const reason = assertReason(input.reason);
    const result = await this.pool.query(
      `DELETE FROM oshal_app_access
        WHERE user_sub = $1 AND app_name = $2`,
      [input.userSub, input.appName],
    );
    const cleared = (result.rowCount ?? 0) > 0;
    logger.info(
      { appName: input.appName, userSub: input.userSub, assignedBySub: input.assignedBySub, reason, cleared },
      'Explicit app access assignment clear requested',
    );
    return cleared;
  }
}

function mapAssignment(row: AssignmentRow): AppAccessAssignment {
  if (!row || !isAppAccessTier(row.tier)) throw new Error('Invalid app access row returned by PostgreSQL');
  return {
    userSub: row.user_sub,
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
