/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase promotion store (ADR-046 "keep the winning splice, promote it into the workflow definition, re-baseline"; BACKLOG "auto keep-winner then re-baseline"): persists a frame-scope's preferred lane in token_chase_promotions (migration 095 + the same lazy-bootstrap pattern as the corpus so a fresh boot works pre-migration). One ACTIVE promotion per (user_sub, run_id, seq) enforced by a partial unique index; promote atomically supersedes the prior active row in the same transaction and writes a token_chase_promotion_audit row (promote/auto-promote/revert) so every baseline change is traceable and reversible. The service REFUSES non-llm-judged promotions structurally — a lexical-fallback grade can never re-baseline a frame (the honesty rule). Reads are owner-scoped by user_sub, mirroring the corpus.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Keep the pre-migration lazy bootstrap security-identical to migration 095: enable and FORCE owner-scoped RLS on both promotion tables, and create the owner-or-operator policies idempotently. Export the immutable statement list so regression tests can prove the runtime and migration paths cannot silently diverge again.
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'token-chase-promotion-service' });

/** Minimal pg pool surface — pool.query always; connect() when a real Pool provides it. */
interface QueryablePool {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
  connect?: () => Promise<{
    query: (sql: string, params?: unknown[]) => Promise<unknown>;
    release: () => void;
  }>;
}

// Idempotent schema guard so promotions work even before migration 095 has run
// (mirrors the corpus-service bootstrap pattern). Resolved once per process.
let schemaReady: Promise<void> | null = null;

export const TOKEN_CHASE_PROMOTION_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS token_chase_promotions (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_sub           TEXT NOT NULL,
    run_id             TEXT NOT NULL,
    seq                INTEGER NOT NULL,
    provider           TEXT,
    model              TEXT NOT NULL,
    label              TEXT,
    baseline_provider  TEXT,
    baseline_model     TEXT,
    baseline_cost_usd  NUMERIC(12,6),
    variant_cost_usd   NUMERIC(12,6),
    saved_usd          NUMERIC(12,6),
    judge_score        INTEGER NOT NULL,
    judge_mode         TEXT NOT NULL,
    source             TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'active',
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reverted_at        TIMESTAMPTZ
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_tc_promotions_active
     ON token_chase_promotions (user_sub, run_id, seq) WHERE status = 'active'`,
  `CREATE INDEX IF NOT EXISTS idx_tc_promotions_user_run
     ON token_chase_promotions (user_sub, run_id)`,
  `CREATE TABLE IF NOT EXISTS token_chase_promotion_audit (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_sub      TEXT NOT NULL,
    promotion_id  UUID,
    run_id        TEXT NOT NULL,
    seq           INTEGER NOT NULL,
    action        TEXT NOT NULL,
    detail        JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tc_promotion_audit_user_run
     ON token_chase_promotion_audit (user_sub, run_id, created_at)`,
  `ALTER TABLE token_chase_promotions ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE token_chase_promotions FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE token_chase_promotion_audit ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE token_chase_promotion_audit FORCE ROW LEVEL SECURITY`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_policy
       WHERE polname = 'token_chase_promotions_owner_or_operator'
         AND polrelid = 'token_chase_promotions'::regclass
     ) THEN
       CREATE POLICY token_chase_promotions_owner_or_operator ON token_chase_promotions
         AS PERMISSIVE FOR ALL
         USING (
           user_sub = current_setting('oshal.current_sub', true)
           OR current_setting('oshal.is_operator', true) = 'on'
         )
         WITH CHECK (
           user_sub = current_setting('oshal.current_sub', true)
           OR current_setting('oshal.is_operator', true) = 'on'
         );
     END IF;
   END $$`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_policy
       WHERE polname = 'token_chase_promotion_audit_owner_or_operator'
         AND polrelid = 'token_chase_promotion_audit'::regclass
     ) THEN
       CREATE POLICY token_chase_promotion_audit_owner_or_operator ON token_chase_promotion_audit
         AS PERMISSIVE FOR ALL
         USING (
           user_sub = current_setting('oshal.current_sub', true)
           OR current_setting('oshal.is_operator', true) = 'on'
         )
         WITH CHECK (
           user_sub = current_setting('oshal.current_sub', true)
           OR current_setting('oshal.is_operator', true) = 'on'
         );
     END IF;
   END $$`,
];

/** @description Ensures both promotion tables exist (idempotent, once per process; resets on failure for retry). */
function ensureSchema(pool: QueryablePool): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const sql of TOKEN_CHASE_PROMOTION_SCHEMA_SQL) await pool.query(sql);
    })().catch((err) => {
      schemaReady = null; // allow a later retry
      logger.error({ err, stack: (err as Error)?.stack }, 'Failed to bootstrap Token Chase promotion tables');
      throw err;
    });
  }
  return schemaReady;
}

/** @description Lifecycle of a promotion row. */
export type PromotionStatus = 'active' | 'superseded' | 'reverted';

/** @description Where a promotion came from: an explicit operator/user action, or the gated auto mode. */
export type PromotionSource = 'manual' | 'auto';

/** @description One persisted promotion — a frame-scope's preferred (re-baselined) lane. */
export interface PromotionRecord {
  id: string;
  userSub: string;
  runId: string;
  seq: number;
  provider: string | null;
  model: string;
  label: string | null;
  baselineProvider: string | null;
  baselineModel: string | null;
  baselineCostUsd: number | null;
  variantCostUsd: number | null;
  savedUsd: number | null;
  judgeScore: number;
  judgeMode: 'llm';
  source: PromotionSource;
  status: PromotionStatus;
  createdAt: string | null;
  revertedAt: string | null;
}

/** @description The fields a caller supplies to promote a frame's winning lane. */
export interface PromotionInput {
  runId: string;
  seq: number;
  provider: string | null;
  model: string;
  label?: string | null;
  baselineProvider: string | null;
  baselineModel: string | null;
  baselineCostUsd: number | null;
  variantCostUsd: number | null;
  savedUsd: number | null;
  judgeScore: number;
  /** Must be 'llm' — the service refuses anything else (the honesty rule, enforced structurally). */
  judgeMode: string;
  source: PromotionSource;
}

/** @description One promotion audit-trail entry. */
export interface PromotionAuditEntry {
  id: string;
  promotionId: string | null;
  runId: string;
  seq: number;
  action: 'promote' | 'auto-promote' | 'revert';
  detail: Record<string, unknown> | null;
  createdAt: string | null;
}

/** Raw DB row shape for a promotion. */
interface PromotionRow {
  id: string;
  user_sub: string;
  run_id: string;
  seq: number | string;
  provider: string | null;
  model: string;
  label: string | null;
  baseline_provider: string | null;
  baseline_model: string | null;
  baseline_cost_usd: string | number | null;
  variant_cost_usd: string | number | null;
  saved_usd: string | number | null;
  judge_score: number | string;
  judge_mode: string;
  source: string;
  status: string;
  created_at: string | Date | null;
  reverted_at: string | Date | null;
}

/** Coerce a NUMERIC/text DB value into a finite number or null. */
function toNum(v: string | number | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Coerce a TIMESTAMPTZ DB value (Date or text) into an ISO string, or null. */
function toIso(v: string | Date | null): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Map one raw row to the exported record shape. */
function mapPromotion(r: PromotionRow): PromotionRecord {
  return {
    id: r.id,
    userSub: r.user_sub,
    runId: r.run_id,
    seq: Number(r.seq),
    provider: r.provider,
    model: r.model,
    label: r.label,
    baselineProvider: r.baseline_provider,
    baselineModel: r.baseline_model,
    baselineCostUsd: toNum(r.baseline_cost_usd),
    variantCostUsd: toNum(r.variant_cost_usd),
    savedUsd: toNum(r.saved_usd),
    judgeScore: Number(r.judge_score),
    judgeMode: 'llm',
    source: r.source === 'auto' ? 'auto' : 'manual',
    status: r.status === 'superseded' ? 'superseded' : r.status === 'reverted' ? 'reverted' : 'active',
    createdAt: toIso(r.created_at),
    revertedAt: toIso(r.reverted_at),
  };
}

/**
 * @description Runs `fn` inside a transaction when the pool can hand out a client; otherwise
 * (minimal test pools) runs the statements sequentially on the pool. Production `pg.Pool` always
 * has connect(), so the demote+insert+audit triple is atomic in real deployments.
 * @param pool - The app DB pool.
 * @param fn - The transactional work, given a query surface.
 * @returns Whatever `fn` returns.
 */
async function withTransaction<T>(
  pool: QueryablePool,
  fn: (q: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<T>,
): Promise<T> {
  if (typeof pool.connect !== 'function') return fn(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, 'Promotion transaction ROLLBACK failed');
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * @description Promotes a frame's winning lane to its preferred baseline (the ADR-046
 * keep-winner → re-baseline apply). Atomically: supersedes any prior ACTIVE promotion for the
 * same (user_sub, run_id, seq), inserts the new active row, and writes the audit entry
 * ('promote' or 'auto-promote' by source) — all in one transaction, so the audit trail can never
 * disagree with the store. REFUSES a non-'llm' judgeMode with an Error: a lexical-fallback or
 * ungraded score must never re-baseline a frame, no matter what a caller passes.
 * @param pool - The app DB pool.
 * @param userSub - The promotion owner (scopes the frame and all reads).
 * @param input - The winning lane + its evidence (scores, cost pair, savings).
 * @returns The new active promotion record.
 */
export async function promoteFrameWinner(
  pool: QueryablePool,
  userSub: string,
  input: PromotionInput,
): Promise<PromotionRecord> {
  if (input.judgeMode !== 'llm') {
    throw new Error(`Refusing to promote a non-llm-judged lane (judgeMode=${String(input.judgeMode)}) — only real judge grades may re-baseline a frame`);
  }
  await ensureSchema(pool);
  const record = await withTransaction(pool, async (q) => {
    const demoted = (await q.query(
      `UPDATE token_chase_promotions
          SET status = 'superseded', reverted_at = NOW()
        WHERE user_sub = $1 AND run_id = $2 AND seq = $3 AND status = 'active'
        RETURNING id`,
      [userSub, input.runId, input.seq],
    )) as { rows: Array<{ id: string }> };
    const inserted = (await q.query(
      `INSERT INTO token_chase_promotions
         (user_sub, run_id, seq, provider, model, label, baseline_provider, baseline_model,
          baseline_cost_usd, variant_cost_usd, saved_usd, judge_score, judge_mode, source, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'llm',$13,'active')
       RETURNING *`,
      [
        userSub, input.runId, input.seq, input.provider, input.model, input.label ?? null,
        input.baselineProvider, input.baselineModel, input.baselineCostUsd, input.variantCostUsd,
        input.savedUsd, Math.round(input.judgeScore), input.source,
      ],
    )) as { rows: PromotionRow[] };
    const row = inserted.rows[0];
    await q.query(
      `INSERT INTO token_chase_promotion_audit (user_sub, promotion_id, run_id, seq, action, detail)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        userSub, row.id, input.runId, input.seq,
        input.source === 'auto' ? 'auto-promote' : 'promote',
        JSON.stringify({
          provider: input.provider, model: input.model, judgeScore: input.judgeScore,
          savedUsd: input.savedUsd, supersededIds: demoted.rows.map((d) => d.id),
        }),
      ],
    );
    return mapPromotion(row);
  });
  logger.info(
    { userSub, runId: input.runId, seq: input.seq, model: input.model, source: input.source, savedUsd: input.savedUsd },
    'Token Chase frame lane promoted to baseline',
  );
  return record;
}

/**
 * @description Reverts (demotes) an ACTIVE promotion the caller owns — the reversal that makes
 * promotion a safe, visible action. Writes the 'revert' audit entry in the same transaction.
 * @param pool - The app DB pool.
 * @param userSub - The caller (must own the promotion).
 * @param promotionId - The promotion row id.
 * @returns The reverted record, or null when no active promotion with that id belongs to the caller.
 */
export async function revertPromotion(
  pool: QueryablePool,
  userSub: string,
  promotionId: string,
): Promise<PromotionRecord | null> {
  await ensureSchema(pool);
  const record = await withTransaction(pool, async (q) => {
    const updated = (await q.query(
      `UPDATE token_chase_promotions
          SET status = 'reverted', reverted_at = NOW()
        WHERE id = $1 AND user_sub = $2 AND status = 'active'
        RETURNING *`,
      [promotionId, userSub],
    )) as { rows: PromotionRow[] };
    const row = updated.rows[0];
    if (!row) return null;
    await q.query(
      `INSERT INTO token_chase_promotion_audit (user_sub, promotion_id, run_id, seq, action, detail)
       VALUES ($1,$2,$3,$4,'revert',$5::jsonb)`,
      [userSub, row.id, row.run_id, Number(row.seq), JSON.stringify({ provider: row.provider, model: row.model })],
    );
    return mapPromotion(row);
  });
  if (record) {
    logger.info({ userSub, promotionId, runId: record.runId, seq: record.seq }, 'Token Chase promotion reverted');
  }
  return record;
}

/**
 * @description Lists the caller's promotions (all statuses — the visible history), newest first.
 * @param pool - The app DB pool.
 * @param userSub - Owner scope.
 * @param runId - Optional run to narrow to.
 * @returns Promotion records, newest first.
 */
export async function listPromotions(
  pool: QueryablePool,
  userSub: string,
  runId?: string,
): Promise<PromotionRecord[]> {
  await ensureSchema(pool);
  const params: unknown[] = [userSub];
  let where = 'user_sub = $1';
  if (runId) {
    params.push(runId);
    where += ' AND run_id = $2';
  }
  const result = (await pool.query(
    `SELECT * FROM token_chase_promotions WHERE ${where} ORDER BY created_at DESC`,
    params,
  )) as { rows: PromotionRow[] };
  return (result.rows ?? []).map(mapPromotion);
}

/**
 * @description The ACTIVE promotions for one run keyed by frame seq — what the optimizer and the
 * savings loop consult to treat the promoted lane as each frame's new baseline.
 * @param pool - The app DB pool.
 * @param userSub - Owner scope.
 * @param runId - The captured run id.
 * @returns Map of frame seq → active promotion (empty when none).
 */
export async function listActivePromotions(
  pool: QueryablePool,
  userSub: string,
  runId: string,
): Promise<Map<number, PromotionRecord>> {
  await ensureSchema(pool);
  const result = (await pool.query(
    `SELECT * FROM token_chase_promotions
      WHERE user_sub = $1 AND run_id = $2 AND status = 'active'`,
    [userSub, runId],
  )) as { rows: PromotionRow[] };
  const map = new Map<number, PromotionRecord>();
  for (const row of result.rows ?? []) map.set(Number(row.seq), mapPromotion(row));
  return map;
}

/** Raw audit row shape. */
interface AuditRow {
  id: string;
  promotion_id: string | null;
  run_id: string;
  seq: number | string;
  action: string;
  detail: Record<string, unknown> | string | null;
  created_at: string | Date | null;
}

/**
 * @description Reads the caller's promotion audit trail (promote / auto-promote / revert),
 * newest first — the traceability half of "promotion is a visible, reversible action".
 * @param pool - The app DB pool.
 * @param userSub - Owner scope.
 * @param runId - Optional run to narrow to.
 * @returns Audit entries, newest first.
 */
export async function listPromotionAudit(
  pool: QueryablePool,
  userSub: string,
  runId?: string,
): Promise<PromotionAuditEntry[]> {
  await ensureSchema(pool);
  const params: unknown[] = [userSub];
  let where = 'user_sub = $1';
  if (runId) {
    params.push(runId);
    where += ' AND run_id = $2';
  }
  const result = (await pool.query(
    `SELECT id, promotion_id, run_id, seq, action, detail, created_at
       FROM token_chase_promotion_audit
      WHERE ${where} ORDER BY created_at DESC`,
    params,
  )) as { rows: AuditRow[] };
  return (result.rows ?? []).map((r) => ({
    id: r.id,
    promotionId: r.promotion_id,
    runId: r.run_id,
    seq: Number(r.seq),
    action: r.action === 'auto-promote' ? 'auto-promote' : r.action === 'revert' ? 'revert' : 'promote',
    detail: typeof r.detail === 'string' ? safeJson(r.detail) : r.detail,
    createdAt: toIso(r.created_at),
  }));
}

/** Parse a JSON text column defensively (null on malformed content, never a throw). */
function safeJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    logger.error({ err, textPreview: text.slice(0, 120) }, 'Malformed JSON in promotion audit detail column');
    return null;
  }
}
