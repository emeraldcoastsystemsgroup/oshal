/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Postgres store for LinkedIn content drafts (social_content_drafts). EVERY read/write is scoped by user_sub in the WHERE clause — a draft is personal content, so one operator's drafts never surface to another (mirrors the per-user oshal_content_* tables, not an operator-visible governance surface). Idempotent CREATE TABLE IF NOT EXISTS on construction (same self-applying pattern as content-routes) with the canonical DDL living in scripts/migrations/085-social-content-drafts.sql.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add casState — a compare-and-swap state write (WHERE also pins the expected from-state) so publishNow can atomically claim a scheduled draft before the live LinkedIn POST; two concurrent publishes can no longer both fire a UGC post (review gap-list round2).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Wrapped the lazy-DDL ensureSchema chain in runWithSystemIdentity — it fires detached at boot with no request in scope; under OSHAL_DB_GUC_STRICT=deny the identity-less CREATE TABLE/INDEX would be RLS-scoped to nothing. This was the final identity-less site the SQL-logging audit named (its stack was fully detached).
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { DRAFT_STATES, type DraftState, type SocialContentDraft } from '../types';

const logger = createChildLogger({ module: 'content-draft-store' });

/** The raw DB row shape (snake_case) before mapping to {@link SocialContentDraft}. */
interface DraftRow {
  id: number;
  user_sub: string;
  topic: string;
  goal: string | null;
  tone: string | null;
  source_url: string | null;
  body: string;
  score: number | null;
  dimensions: unknown;
  judge_mode: string | null;
  rationale: string | null;
  refined: boolean;
  state: string;
  scheduled_for: string | null;
  publish_error: string | null;
  created_at: string;
  updated_at: string;
}

/** Fields settable when persisting a freshly generated + graded draft. */
export interface InsertDraftInput {
  topic: string;
  goal?: string | null;
  tone?: string | null;
  sourceUrl?: string | null;
  body: string;
}

/** The grade fields written after the judge scores (and any refine pass completes). */
export interface GradeUpdate {
  body: string;
  score: number;
  dimensions: Record<string, number>;
  judgeMode: string;
  rationale: string;
  refined: boolean;
}

/**
 * @description Map a raw DB row to the domain draft. `dimensions` is stored JSONB; a legacy or
 * malformed value degrades to an empty object rather than throwing.
 * @param row - The raw row.
 * @returns The domain draft.
 */
function mapRow(row: DraftRow): SocialContentDraft {
  const dims = row.dimensions && typeof row.dimensions === 'object' && !Array.isArray(row.dimensions)
    ? (row.dimensions as Record<string, number>)
    : {};
  return {
    id: row.id,
    userSub: row.user_sub,
    topic: row.topic,
    goal: row.goal,
    tone: row.tone,
    sourceUrl: row.source_url,
    body: row.body,
    score: row.score === null ? null : Number(row.score),
    dimensions: dims,
    judgeMode: row.judge_mode,
    rationale: row.rationale,
    refined: !!row.refined,
    state: (DRAFT_STATES as readonly string[]).includes(row.state) ? (row.state as DraftState) : 'draft',
    scheduledFor: row.scheduled_for,
    publishError: row.publish_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLS =
  'id, user_sub, topic, goal, tone, source_url, body, score, dimensions, judge_mode, rationale, refined, state, scheduled_for, publish_error, created_at, updated_at';

/**
 * @description Per-user Postgres store for LinkedIn content drafts. Owns table creation and all
 * CRUD, every query pinned to a `user_sub` so cross-user rows are impossible by construction.
 */
export class ContentDraftStore {
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
   * @description Create the social_content_drafts table + index if absent (idempotent, run once
   * per process, cached). Self-applying like content-routes so a fresh DB works without a manual
   * migration step; the canonical DDL is scripts/migrations/085-social-content-drafts.sql.
   * @returns Resolves when the schema is present.
   */
  async ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      // Lazy-DDL, often first hit at boot with no request in scope — run the CREATE TABLE/INDEX as
      // trusted SYSTEM so it stamps operator under OSHAL_DB_GUC_STRICT=deny (DDL is global; an
      // identity-less connection would otherwise be RLS-scoped to nothing). guc warn-audit site.
      this.schemaReady = runWithSystemIdentity(() => this.pool
        .query(
          `CREATE TABLE IF NOT EXISTS social_content_drafts (
             id SERIAL PRIMARY KEY,
             user_sub TEXT NOT NULL,
             topic TEXT NOT NULL,
             goal TEXT,
             tone TEXT,
             source_url TEXT,
             body TEXT NOT NULL DEFAULT '',
             score INT,
             dimensions JSONB NOT NULL DEFAULT '{}'::jsonb,
             judge_mode TEXT,
             rationale TEXT,
             refined BOOLEAN NOT NULL DEFAULT false,
             state TEXT NOT NULL DEFAULT 'draft'
               CHECK (state IN ('draft','pending-approval','scheduled','published','rejected')),
             scheduled_for TIMESTAMPTZ,
             publish_error TEXT,
             created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
             updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
           )`,
        )
        .then(() =>
          this.pool.query(
            'CREATE INDEX IF NOT EXISTS idx_social_content_drafts_user_state ON social_content_drafts (user_sub, state, updated_at DESC)',
          ),
        )
        .then(() => undefined))
        .catch((err) => {
          this.schemaReady = null; // let a later call retry rather than caching the failure
          logger.error({ err, stack: (err as Error)?.stack }, 'social_content_drafts schema bootstrap failed');
          throw err;
        });
    }
    return this.schemaReady;
  }

  /**
   * @description Insert a freshly generated draft in the initial `draft` state (grade is written
   * separately once the judge runs). Returns the created row.
   * @param userSub - Owner OIDC sub.
   * @param input - Topic/goal/tone/source + the generated body.
   * @returns The persisted draft.
   */
  async insertDraft(userSub: string, input: InsertDraftInput): Promise<SocialContentDraft> {
    await this.ensureSchema();
    const row = (
      await this.pool.query<DraftRow>(
        `INSERT INTO social_content_drafts (user_sub, topic, goal, tone, source_url, body, state)
         VALUES ($1,$2,$3,$4,$5,$6,'draft') RETURNING ${SELECT_COLS}`,
        [userSub, input.topic, input.goal ?? null, input.tone ?? null, input.sourceUrl ?? null, input.body],
      )
    ).rows[0];
    return mapRow(row);
  }

  /**
   * @description Write the grade (and possibly-refined body) and move the draft to
   * `pending-approval`. Scoped to the owner so a caller can never grade another user's draft.
   * @param userSub - Owner OIDC sub.
   * @param id - Draft id.
   * @param grade - The grade fields + final body.
   * @returns The updated draft, or null when the id isn't the caller's.
   */
  async applyGrade(userSub: string, id: number, grade: GradeUpdate): Promise<SocialContentDraft | null> {
    const row = (
      await this.pool.query<DraftRow>(
        `UPDATE social_content_drafts
           SET body=$3, score=$4, dimensions=$5, judge_mode=$6, rationale=$7, refined=$8,
               state='pending-approval', updated_at=now()
         WHERE user_sub=$1 AND id=$2 RETURNING ${SELECT_COLS}`,
        [userSub, id, grade.body, grade.score, JSON.stringify(grade.dimensions), grade.judgeMode, grade.rationale, grade.refined],
      )
    ).rows[0];
    return row ? mapRow(row) : null;
  }

  /**
   * @description List the caller's drafts, newest first. Optionally filter by state.
   * @param userSub - Owner OIDC sub.
   * @param state - Optional state filter.
   * @param limit - Max rows (clamped 1..200).
   * @returns The caller's drafts.
   */
  async listByUser(userSub: string, state?: DraftState, limit = 50): Promise<SocialContentDraft[]> {
    await this.ensureSchema();
    const cap = Math.min(200, Math.max(1, limit));
    const rows = state
      ? (await this.pool.query<DraftRow>(
          `SELECT ${SELECT_COLS} FROM social_content_drafts WHERE user_sub=$1 AND state=$2 ORDER BY updated_at DESC LIMIT $3`,
          [userSub, state, cap],
        )).rows
      : (await this.pool.query<DraftRow>(
          `SELECT ${SELECT_COLS} FROM social_content_drafts WHERE user_sub=$1 ORDER BY updated_at DESC LIMIT $2`,
          [userSub, cap],
        )).rows;
    return rows.map(mapRow);
  }

  /**
   * @description Fetch one draft by id, scoped to the owner (returns null for another user's id
   * so ids are not oracle-able).
   * @param userSub - Owner OIDC sub.
   * @param id - Draft id.
   * @returns The draft or null.
   */
  async getById(userSub: string, id: number): Promise<SocialContentDraft | null> {
    await this.ensureSchema();
    const row = (
      await this.pool.query<DraftRow>(
        `SELECT ${SELECT_COLS} FROM social_content_drafts WHERE user_sub=$1 AND id=$2`,
        [userSub, id],
      )
    ).rows[0];
    return row ? mapRow(row) : null;
  }

  /**
   * @description Move a draft to a new state (optionally setting the publish slot and/or a
   * publish error), scoped to the owner. The legality of the transition is the service's job —
   * this only writes what it is told, guarded by user_sub.
   * @param userSub - Owner OIDC sub.
   * @param id - Draft id.
   * @param state - The new state.
   * @param opts - Optional scheduledFor (ISO) and/or publishError to set.
   * @returns The updated draft, or null when the id isn't the caller's.
   */
  async setState(
    userSub: string,
    id: number,
    state: DraftState,
    opts: { scheduledFor?: string | null; publishError?: string | null } = {},
  ): Promise<SocialContentDraft | null> {
    const row = (
      await this.pool.query<DraftRow>(
        `UPDATE social_content_drafts
           SET state=$3,
               scheduled_for = COALESCE($4, scheduled_for),
               publish_error = $5,
               updated_at=now()
         WHERE user_sub=$1 AND id=$2 RETURNING ${SELECT_COLS}`,
        [userSub, id, state, opts.scheduledFor ?? null, opts.publishError ?? null],
      )
    ).rows[0];
    return row ? mapRow(row) : null;
  }

  /**
   * @description Compare-and-swap the state: identical to {@link setState} but the UPDATE only
   * matches when the row is still in `fromState`. This is the atomic claim publishNow needs — the
   * first concurrent publish flips `scheduled`→`published` and wins; a second concurrent publish
   * re-evaluates the WHERE, sees the row is no longer `scheduled`, matches zero rows, and gets null
   * back (so it never fires a duplicate live LinkedIn post). Still user_sub-scoped.
   * @param userSub - Owner OIDC sub.
   * @param id - Draft id.
   * @param fromState - The state the row must currently be in for the swap to apply.
   * @param toState - The state to move it to.
   * @param opts - Optional scheduledFor (ISO) and/or publishError to set.
   * @returns The updated draft when the swap applied, or null when the row was not in `fromState`
   *          (or isn't the caller's).
   */
  async casState(
    userSub: string,
    id: number,
    fromState: DraftState,
    toState: DraftState,
    opts: { scheduledFor?: string | null; publishError?: string | null } = {},
  ): Promise<SocialContentDraft | null> {
    const row = (
      await this.pool.query<DraftRow>(
        `UPDATE social_content_drafts
           SET state=$4,
               scheduled_for = COALESCE($5, scheduled_for),
               publish_error = $6,
               updated_at=now()
         WHERE user_sub=$1 AND id=$2 AND state=$3 RETURNING ${SELECT_COLS}`,
        [userSub, id, fromState, toState, opts.scheduledFor ?? null, opts.publishError ?? null],
      )
    ).rows[0];
    return row ? mapRow(row) : null;
  }
}
