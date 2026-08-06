/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Postgres store for LinkedIn Profile Studio plans (linkedin_profile_plans). ONE live plan per user (UNIQUE user_sub) and EVERY read/write pinned to user_sub in the WHERE clause — a profile plan is personal content, so cross-user rows are impossible by construction (mirrors ContentDraftStore). State moves go through casState (compare-and-swap pinning the expected from-state, legality checked against canTransition) so approve/dispatch/callback can never double-fire or race a reset. Idempotent CREATE TABLE IF NOT EXISTS; canonical DDL in scripts/migrations/087-linkedin-profile-plans.sql.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add photo_path (profile photo/headshot). ensureSchema gains a trailing ADD COLUMN IF NOT EXISTS so tables created by today's earlier build upgrade in place; 087 stays the canonical DDL.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Bind each dispatch to a monotonic generation, exact task/client, short-lived capability hash, and operation; atomically consume callbacks once and revoke grants on failure or other terminal transitions.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { PLAN_STATES, canTransition, type LinkedInProfilePlan, type PlanDraftInput, type PlanState } from '../types/plan';

const logger = createChildLogger({ module: 'profile-plan-store' });

/** The raw DB row shape (snake_case) before mapping to {@link LinkedInProfilePlan}. */
interface PlanRow {
  id: number;
  user_sub: string;
  headline: string;
  about: string;
  skills: unknown;
  custom_url: string;
  background_image_path: string | null;
  photo_path: string | null;
  resume_path: string | null;
  state: string;
  dispatch_task_id: string | null;
  dispatch_client_id: string | null;
  dispatch_generation: string | number;
  result_note: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * @description Map a raw DB row to the domain plan. A legacy/malformed `skills` JSONB
 * degrades to an empty list rather than throwing; an unknown state degrades to `draft`.
 * @param row - The raw row.
 * @returns The domain plan.
 */
function mapRow(row: PlanRow): LinkedInProfilePlan {
  const skills = Array.isArray(row.skills) ? row.skills.map((s) => String(s)) : [];
  return {
    id: row.id,
    userSub: row.user_sub,
    headline: row.headline,
    about: row.about,
    skills,
    customUrl: row.custom_url,
    backgroundImagePath: row.background_image_path,
    photoPath: row.photo_path,
    resumePath: row.resume_path,
    state: (PLAN_STATES as readonly string[]).includes(row.state) ? (row.state as PlanState) : 'draft',
    dispatchTaskId: row.dispatch_task_id,
    dispatchClientId: row.dispatch_client_id,
    dispatchGeneration: Number(row.dispatch_generation ?? 0),
    resultNote: row.result_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLS =
  'id, user_sub, headline, about, skills, custom_url, background_image_path, photo_path, resume_path, state, dispatch_task_id, dispatch_client_id, dispatch_generation, result_note, created_at, updated_at';

/**
 * @description Per-user Postgres store for LinkedIn profile plans. Owns table creation and
 * all CRUD; one live plan per user; every query pinned to `user_sub`.
 */
export class ProfilePlanStore {
  private readonly pool: Pool;
  private schemaReady: Promise<void> | null = null;

  /**
   * @description Construct the store over a Postgres pool.
   * @param pool - The api Postgres pool.
   */
  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * @description Create the linkedin_profile_plans table + index if absent (idempotent,
   * once per process). Self-applying so a fresh DB works without a manual migration step;
   * the canonical DDL is scripts/migrations/087-linkedin-profile-plans.sql.
   * @returns Resolves when the schema is present.
   */
  async ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.pool
        .query(
          `CREATE TABLE IF NOT EXISTS linkedin_profile_plans (
             id                    SERIAL PRIMARY KEY,
             user_sub              TEXT NOT NULL UNIQUE,
             headline              TEXT NOT NULL DEFAULT '',
             about                 TEXT NOT NULL DEFAULT '',
             skills                JSONB NOT NULL DEFAULT '[]'::jsonb,
             custom_url            TEXT NOT NULL DEFAULT '',
             background_image_path TEXT,
             photo_path            TEXT,
             resume_path           TEXT,
             state                 TEXT NOT NULL DEFAULT 'draft',
             dispatch_task_id      TEXT,
             dispatch_client_id    TEXT,
             dispatch_generation   BIGINT NOT NULL DEFAULT 0,
             callback_capability_hash TEXT,
             callback_capability_expires_at TIMESTAMPTZ,
             callback_capability_operation TEXT,
             callback_capability_used_at TIMESTAMPTZ,
             result_note           TEXT,
             created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
             updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
           );
           CREATE INDEX IF NOT EXISTS idx_linkedin_profile_plans_state ON linkedin_profile_plans (state);
           ALTER TABLE linkedin_profile_plans ADD COLUMN IF NOT EXISTS photo_path TEXT;
           ALTER TABLE linkedin_profile_plans ADD COLUMN IF NOT EXISTS dispatch_generation BIGINT NOT NULL DEFAULT 0;
           ALTER TABLE linkedin_profile_plans ADD COLUMN IF NOT EXISTS callback_capability_hash TEXT;
           ALTER TABLE linkedin_profile_plans ADD COLUMN IF NOT EXISTS callback_capability_expires_at TIMESTAMPTZ;
           ALTER TABLE linkedin_profile_plans ADD COLUMN IF NOT EXISTS callback_capability_operation TEXT;
           ALTER TABLE linkedin_profile_plans ADD COLUMN IF NOT EXISTS callback_capability_used_at TIMESTAMPTZ;`,
        )
        .then(() => undefined)
        .catch((err) => {
          this.schemaReady = null;
          logger.error({ err }, 'profile plan schema creation failed');
          throw err;
        });
    }
    return this.schemaReady;
  }

  /**
   * @description Load the user's plan, or null if they have none yet.
   * @param userSub - The signed-in user's OIDC sub.
   * @returns The plan or null.
   */
  async getPlan(userSub: string): Promise<LinkedInProfilePlan | null> {
    await this.ensureSchema();
    const r = await this.pool.query(`SELECT ${SELECT_COLS} FROM linkedin_profile_plans WHERE user_sub = $1`, [userSub]);
    return r.rows.length ? mapRow(r.rows[0] as PlanRow) : null;
  }

  /**
   * @description Save draft edits (upsert). A fresh user gets a `draft` row; an existing
   * row only updates while still in `draft` — approved/dispatched plans are frozen, so the
   * ON CONFLICT update pins `state = 'draft'` and a frozen plan simply returns unchanged.
   * @param userSub - The signed-in user's OIDC sub.
   * @param input - The editable fields to set (only provided fields change).
   * @returns The plan after the save.
   */
  async saveDraft(userSub: string, input: PlanDraftInput): Promise<LinkedInProfilePlan> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO linkedin_profile_plans (user_sub, headline, about, skills, custom_url)
       VALUES ($1, COALESCE($2, ''), COALESCE($3, ''), COALESCE($4, '[]'::jsonb), COALESCE($5, ''))
       ON CONFLICT (user_sub) DO UPDATE SET
         headline   = COALESCE($2, linkedin_profile_plans.headline),
         about      = COALESCE($3, linkedin_profile_plans.about),
         skills     = COALESCE($4, linkedin_profile_plans.skills),
         custom_url = COALESCE($5, linkedin_profile_plans.custom_url),
         updated_at = now()
       WHERE linkedin_profile_plans.state = 'draft'`,
      [
        userSub,
        input.headline ?? null,
        input.about ?? null,
        input.skills ? JSON.stringify(input.skills) : null,
        input.customUrl ?? null,
      ],
    );
    const plan = await this.getPlan(userSub);
    if (!plan) throw new Error('plan upsert produced no row');
    return plan;
  }

  /**
   * @description Attach an uploaded asset (background image or featured resume) to the
   * user's draft. Only legal while the plan is editable; upserts a fresh draft row first
   * so an upload can be the user's first action.
   * @param userSub - The signed-in user's OIDC sub.
   * @param field - Which asset slot to set.
   * @param filePath - Server path of the stored file (inside the user's own store dir).
   * @returns True when the draft accepted the asset; false when the plan is frozen.
   */
  async setAsset(userSub: string, field: 'background_image_path' | 'photo_path' | 'resume_path', filePath: string): Promise<boolean> {
    await this.ensureSchema();
    await this.pool.query(
      'INSERT INTO linkedin_profile_plans (user_sub) VALUES ($1) ON CONFLICT (user_sub) DO NOTHING',
      [userSub],
    );
    const col = field === 'background_image_path' ? 'background_image_path' : field === 'photo_path' ? 'photo_path' : 'resume_path';
    const r = await this.pool.query(
      `UPDATE linkedin_profile_plans SET ${col} = $2, updated_at = now() WHERE user_sub = $1 AND state = 'draft'`,
      [userSub, filePath],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * @description Atomically freezes one approved plan into a new immutable dispatch generation and
   * binds its one-use result capability to the exact task, client, operation, owner, and expiry.
   * @param userSub - Exact owning OIDC subject.
   * @param planId - Immutable plan row id observed before staging.
   * @param taskId - Unique remote task id for this generation.
   * @param clientId - Exact selected remote client id.
   * @param capabilityHash - Domain-separated SHA-256 capability digest.
   * @param expiresAt - Short capability expiry.
   * @returns New monotonic generation, or null when the approved CAS lost.
   */
  async beginDispatch(
    userSub: string,
    planId: number,
    taskId: string,
    clientId: string,
    capabilityHash: string,
    expiresAt: Date,
  ): Promise<number | null> {
    assertDispatchBinding(taskId, clientId, capabilityHash, expiresAt);
    await this.ensureSchema();
    const result = await this.pool.query(
      `UPDATE linkedin_profile_plans SET state = 'dispatched',
         dispatch_task_id = $3, dispatch_client_id = $4,
         dispatch_generation = dispatch_generation + 1,
         callback_capability_hash = $5, callback_capability_expires_at = $6,
         callback_capability_operation = 'resolve-profile-plan',
         callback_capability_used_at = NULL, result_note = NULL, updated_at = now()
       WHERE user_sub = $1 AND id = $2 AND state = 'approved'
       RETURNING dispatch_generation`,
      [userSub, planId, taskId, clientId, capabilityHash, expiresAt],
    );
    return result.rows.length ? Number(result.rows[0].dispatch_generation) : null;
  }

  /**
   * @description Atomically consumes a live capability and resolves only its exact dispatch
   * generation. The same token, an older generation, or another task/client can never win twice.
   * @param userSub - Exact owning OIDC subject from trusted callback context.
   * @param generation - Immutable dispatch generation.
   * @param taskId - Exact remote task id.
   * @param clientId - Exact remote client id.
   * @param operation - Least-privilege operation bound at issuance.
   * @param capabilityHash - Digest of the presented one-use token.
   * @param resultState - Strict terminal result.
   * @param note - Bounded per-field outcome.
   * @returns True only for the first live, fully matching callback.
   */
  async consumeDispatchCallback(
    userSub: string,
    generation: number,
    taskId: string,
    clientId: string,
    operation: string,
    capabilityHash: string,
    resultState: 'applied' | 'failed',
    note: string,
  ): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `UPDATE linkedin_profile_plans SET state = $7, result_note = $8,
         callback_capability_hash = NULL, callback_capability_expires_at = NULL,
         callback_capability_operation = NULL, callback_capability_used_at = now(), updated_at = now()
       WHERE user_sub = $1 AND state = 'dispatched' AND dispatch_generation = $2
         AND dispatch_task_id = $3 AND dispatch_client_id = $4
         AND callback_capability_operation = $5 AND callback_capability_hash = $6
         AND callback_capability_used_at IS NULL AND callback_capability_expires_at > now()`,
      [userSub, generation, taskId, clientId, operation, capabilityHash, resultState, note],
    );
    return (result.rowCount ?? 0) === 1;
  }

  /**
   * @description Revokes one exact generation after enqueue failure without touching a successor.
   * @param userSub - Exact owning OIDC subject.
   * @param generation - Dispatch generation to fail.
   * @param taskId - Exact remote task id.
   * @param clientId - Exact selected client id.
   * @param note - Bounded failure reason.
   * @returns True when this generation moved to failed.
   */
  async failDispatch(
    userSub: string,
    generation: number,
    taskId: string,
    clientId: string,
    note: string,
  ): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `UPDATE linkedin_profile_plans SET state = 'failed', result_note = $5,
         callback_capability_hash = NULL, callback_capability_expires_at = NULL,
         callback_capability_operation = NULL, callback_capability_used_at = now(), updated_at = now()
       WHERE user_sub = $1 AND state = 'dispatched' AND dispatch_generation = $2
         AND dispatch_task_id = $3 AND dispatch_client_id = $4`,
      [userSub, generation, taskId, clientId, note],
    );
    return (result.rowCount ?? 0) === 1;
  }

  /**
   * @description Compare-and-swap state move: pins BOTH the user and the expected
   * from-state in the WHERE clause, so two concurrent movers can never both win (the
   * dispatch/callback race guard). Refuses illegal moves per {@link canTransition}.
   * @param userSub - The signed-in user's OIDC sub.
   * @param from - The expected current state.
   * @param to - The target state.
   * @param extras - Dispatch/outcome fields written atomically with the move.
   * @returns True when this call performed the move; false when the row was not in `from`.
   */
  async casState(
    userSub: string,
    from: PlanState,
    to: PlanState,
    extras: { dispatchTaskId?: string; dispatchClientId?: string; resultNote?: string } = {},
  ): Promise<boolean> {
    if (!canTransition(from, to)) {
      logger.warn({ userSub, from, to }, 'illegal plan state transition refused');
      return false;
    }
    await this.ensureSchema();
    const r = await this.pool.query(
      `UPDATE linkedin_profile_plans SET
         state = $3,
         dispatch_task_id = COALESCE($4, dispatch_task_id),
         dispatch_client_id = COALESCE($5, dispatch_client_id),
         result_note = COALESCE($6, result_note),
         callback_capability_hash = CASE WHEN $3 = 'dispatched' THEN callback_capability_hash ELSE NULL END,
         callback_capability_expires_at = CASE WHEN $3 = 'dispatched' THEN callback_capability_expires_at ELSE NULL END,
         callback_capability_operation = CASE WHEN $3 = 'dispatched' THEN callback_capability_operation ELSE NULL END,
         updated_at = now()
       WHERE user_sub = $1 AND state = $2`,
      [userSub, from, to, extras.dispatchTaskId ?? null, extras.dispatchClientId ?? null, extras.resultNote ?? null],
    );
    return (r.rowCount ?? 0) > 0;
  }
}

/** @description Rejects malformed dispatch identifiers before they reach dynamic lifecycle state. */
function assertDispatchBinding(taskId: string, clientId: string, hash: string, expiresAt: Date): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(taskId)) throw new Error('invalid dispatch task id');
  if (!clientId || clientId.length > 200) throw new Error('invalid dispatch client id');
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('invalid dispatch capability hash');
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new Error('invalid dispatch capability expiry');
  }
}
