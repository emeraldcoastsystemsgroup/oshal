/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the Token Chase promotion store + routes (ADR-046 keep-winner → re-baseline): the store REFUSES non-llm-judged promotions structurally (nothing touches the DB), promote supersedes the prior active row and writes the 'promote'/'auto-promote' audit entry (in a real transaction when the pool hands out clients, with ROLLBACK on failure), revert only demotes the caller's own ACTIVE promotion and writes the 'revert' audit entry, the promote endpoint enforces auth/validation and answers 422 with per-candidate rejections when nothing clears the bar, applyToBotConfig refuses honestly when the ADR-034 config-sync path is absent, and the AUTO mode is DEFAULT OFF — maybeAutoPromote touches NOTHING (zero queries) unless TOKEN_CHASE_AUTO_PROMOTE=true, in which case winners persist with source 'auto'.
 */

import { describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import {
  promoteFrameWinner,
  revertPromotion,
} from '../../src/features/token-chase/services/token-chase-promotion-service';
import {
  createTokenChasePromotionRoutes,
  maybeAutoPromote,
} from '../../src/app/routes/token-chase-promotion-routes';
import type { AppContext } from '../../src/app/composition/app-context';

const realFetch = globalThis.fetch;

const OWNER = { sub: 'promotion-owner-sub', email: 'owner@example.test' };
const RUN_ID = 'run-promotion-guard';

/** One winning corpus row (llm-judged, at bar, strictly cheaper), snake_case as the SELECT returns it. */
function winnerCorpusRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: 3,
    created_at: '2026-07-24T00:00:00.000Z',
    baseline_provider: 'harness:claude-code-cli',
    baseline_model: 'claude-sonnet-4-6',
    baseline_cost_usd: '0.10',
    variant_provider: 'framework:openrouter',
    variant_model: 'llama-3.3-70b:free',
    cost_usd: '0.02',
    cost_delta_usd: '-0.08',
    latency_ms: 900,
    accuracy: '0.95',
    equivalent: true,
    tier: 'equivalent-cheaper',
    status: 'equivalent',
    query_type: 'summarize',
    harness: 'claude-code',
    judge_score: 92,
    judge_mode: 'llm',
    ...over,
  };
}

/** Echoes the promotion INSERT params back as the RETURNING row (matches the service's param order). */
function promotionRowFrom(params: unknown[]): Record<string, unknown> {
  return {
    id: 'promo-1',
    user_sub: params[0], run_id: params[1], seq: params[2], provider: params[3], model: params[4],
    label: params[5], baseline_provider: params[6], baseline_model: params[7],
    baseline_cost_usd: params[8], variant_cost_usd: params[9], saved_usd: params[10],
    judge_score: params[11], judge_mode: 'llm', source: params[12], status: 'active',
    created_at: '2026-07-24T01:00:00.000Z', reverted_at: null,
  };
}

interface FakePoolOpts {
  corpusRows?: Record<string, unknown>[];
  activePromotions?: Record<string, unknown>[];
  promotionsList?: Record<string, unknown>[];
  auditRows?: Record<string, unknown>[];
  revertRow?: Record<string, unknown> | null;
  insertThrows?: boolean;
}

/** Fake pool answering each statement family; the spy records every call for assertions. */
function fakePool(opts: FakePoolOpts = {}): { pool: AppContext['pool']; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (/FROM token_chase_optimizer_corpus/.test(sql)) return { rows: opts.corpusRows ?? [] };
    if (/UPDATE token_chase_promotions/.test(sql) && /'superseded'/.test(sql)) return { rows: [] };
    if (/INSERT INTO token_chase_promotions/.test(sql)) {
      if (opts.insertThrows) throw new Error('insert failed');
      return { rows: [promotionRowFrom(params ?? [])] };
    }
    if (/UPDATE token_chase_promotions/.test(sql) && /'reverted'/.test(sql)) {
      return { rows: opts.revertRow ? [opts.revertRow] : [] };
    }
    if (/FROM token_chase_promotions/.test(sql) && /status = 'active'/.test(sql)) return { rows: opts.activePromotions ?? [] };
    if (/FROM token_chase_promotions/.test(sql)) return { rows: opts.promotionsList ?? [] };
    if (/FROM token_chase_promotion_audit/.test(sql)) return { rows: opts.auditRows ?? [] };
    return { rows: [] };
  });
  return { pool: { query } as unknown as AppContext['pool'], query };
}

/** Calls made against a statement family (schema DDL and unrelated statements filtered out). */
function callsMatching(query: ReturnType<typeof vi.fn>, re: RegExp): Array<[string, unknown[]]> {
  return query.mock.calls.filter((c) => re.test(String(c[0]))) as Array<[string, unknown[]]>;
}

const WINNER_INPUT = {
  runId: RUN_ID, seq: 3, provider: 'framework:openrouter', model: 'llama-3.3-70b:free', label: null,
  baselineProvider: 'harness:claude-code-cli', baselineModel: 'claude-sonnet-4-6',
  baselineCostUsd: 0.1, variantCostUsd: 0.02, savedUsd: 0.08, judgeScore: 92,
  judgeMode: 'llm', source: 'manual' as const,
};

describe('token-chase promotion store', () => {
  it('REFUSES to promote a non-llm-judged lane without touching the DB (the honesty rule)', async () => {
    const { pool, query } = fakePool();
    await expect(
      promoteFrameWinner(pool, OWNER.sub, { ...WINNER_INPUT, judgeMode: 'lexical-fallback' }),
    ).rejects.toThrow(/non-llm-judged/);
    expect(query).not.toHaveBeenCalled();
  });

  it('promote supersedes the prior active row, inserts the new one, and writes the promote audit entry', async () => {
    const { pool, query } = fakePool();
    const record = await promoteFrameWinner(pool, OWNER.sub, WINNER_INPUT);

    const demotes = callsMatching(query, /UPDATE token_chase_promotions[\s\S]*'superseded'/);
    const inserts = callsMatching(query, /INSERT INTO token_chase_promotions/);
    const audits = callsMatching(query, /INSERT INTO token_chase_promotion_audit/);
    expect(demotes).toHaveLength(1);
    expect(demotes[0][1]).toEqual([OWNER.sub, RUN_ID, 3]);
    expect(inserts).toHaveLength(1);
    expect(inserts[0][1]).toContain('llama-3.3-70b:free');
    expect(inserts[0][1]).toContain('manual');
    expect(audits).toHaveLength(1);
    expect(audits[0][1]).toContain('promote');
    // Demote runs before the insert (the partial unique index allows only one active row).
    const demoteIdx = query.mock.calls.findIndex((c) => /'superseded'/.test(String(c[0])));
    const insertIdx = query.mock.calls.findIndex((c) => /INSERT INTO token_chase_promotions/.test(String(c[0])));
    expect(demoteIdx).toBeLessThan(insertIdx);

    expect(record.model).toBe('llama-3.3-70b:free');
    expect(record.status).toBe('active');
    expect(record.source).toBe('manual');
    expect(record.judgeMode).toBe('llm');
  });

  it('uses a real transaction when the pool hands out clients, and ROLLs BACK on failure', async () => {
    const base = fakePool({ insertThrows: true });
    const clientQuery = vi.fn(async (sql: string, params?: unknown[]) => base.query(sql, params));
    const release = vi.fn();
    const pool = {
      query: async (sql: string, params?: unknown[]) => base.query(sql, params),
      connect: async () => ({ query: clientQuery, release }),
    } as unknown as AppContext['pool'];

    await expect(promoteFrameWinner(pool, OWNER.sub, WINNER_INPUT)).rejects.toThrow('insert failed');
    const clientSql = clientQuery.mock.calls.map((c) => String(c[0]));
    expect(clientSql[0]).toBe('BEGIN');
    expect(clientSql).toContain('ROLLBACK');
    expect(clientSql).not.toContain('COMMIT');
    expect(release).toHaveBeenCalled();
  });

  it('revert demotes only an ACTIVE promotion the caller owns, and writes the revert audit entry', async () => {
    const missing = fakePool({ revertRow: null });
    expect(await revertPromotion(missing.pool, OWNER.sub, 'promo-x')).toBeNull();
    expect(callsMatching(missing.query, /INSERT INTO token_chase_promotion_audit/)).toHaveLength(0);

    const found = fakePool({
      revertRow: { ...promotionRowFrom([OWNER.sub, RUN_ID, 3, 'framework:openrouter', 'llama-3.3-70b:free', null, null, null, '0.10', '0.02', '0.08', 92, 'manual']), status: 'reverted', reverted_at: '2026-07-24T02:00:00.000Z' },
    });
    const reverted = await revertPromotion(found.pool, OWNER.sub, 'promo-1');
    expect(reverted?.status).toBe('reverted');
    const updates = callsMatching(found.query, /UPDATE token_chase_promotions[\s\S]*'reverted'/);
    expect(updates[0][1]).toEqual(['promo-1', OWNER.sub]);
    const audits = callsMatching(found.query, /INSERT INTO token_chase_promotion_audit/);
    expect(audits).toHaveLength(1);
    expect(audits[0][0]).toMatch(/'revert'/); // the action is inlined in the audit INSERT
  });
});

describe('maybeAutoPromote — the operator-gated auto mode', () => {
  it('is DEFAULT OFF: with TOKEN_CHASE_AUTO_PROMOTE unset it touches NOTHING (zero queries)', async () => {
    const { pool, query } = fakePool({ corpusRows: [winnerCorpusRow()] });
    const outcome = await maybeAutoPromote(pool, OWNER.sub, RUN_ID, {} as NodeJS.ProcessEnv);
    expect(outcome.enabled).toBe(false);
    expect(outcome.promoted).toHaveLength(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('stays OFF for every non-opt-in value', async () => {
    const { pool, query } = fakePool({ corpusRows: [winnerCorpusRow()] });
    for (const value of ['false', 'yes', 'on', '0', '']) {
      const outcome = await maybeAutoPromote(pool, OWNER.sub, RUN_ID, { TOKEN_CHASE_AUTO_PROMOTE: value } as NodeJS.ProcessEnv);
      expect(outcome.enabled).toBe(false);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('when explicitly enabled, promotes each frame winner with source auto + the auto-promote audit action', async () => {
    const { pool, query } = fakePool({ corpusRows: [winnerCorpusRow(), winnerCorpusRow({ judge_mode: 'lexical-fallback', cost_usd: '0.001' })] });
    const outcome = await maybeAutoPromote(pool, OWNER.sub, RUN_ID, { TOKEN_CHASE_AUTO_PROMOTE: 'true' } as NodeJS.ProcessEnv);
    expect(outcome.enabled).toBe(true);
    expect(outcome.promoted).toHaveLength(1);
    expect(outcome.promoted[0].source).toBe('auto');
    expect(outcome.promoted[0].model).toBe('llama-3.3-70b:free'); // the llm-judged winner, never the cheaper lexical row
    const inserts = callsMatching(query, /INSERT INTO token_chase_promotions/);
    expect(inserts).toHaveLength(1);
    expect(inserts[0][1]).toContain('auto');
    const audits = callsMatching(query, /INSERT INTO token_chase_promotion_audit/);
    expect(audits[0][1]).toContain('auto-promote');
  });

  it('skips a frame whose winner is already the active baseline (idempotent re-runs)', async () => {
    const activeRow = promotionRowFrom([OWNER.sub, RUN_ID, 3, 'framework:openrouter', 'llama-3.3-70b:free', null, null, null, '0.10', '0.02', '0.08', 92, 'auto']);
    const { pool, query } = fakePool({ corpusRows: [winnerCorpusRow()], activePromotions: [activeRow] });
    const outcome = await maybeAutoPromote(pool, OWNER.sub, RUN_ID, { TOKEN_CHASE_AUTO_PROMOTE: 'true' } as NodeJS.ProcessEnv);
    expect(outcome.promoted).toHaveLength(0);
    expect(outcome.alreadyBaseline).toBe(1);
    expect(callsMatching(query, /INSERT INTO token_chase_promotions/)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Route-level guards (mounted exactly as createTokenChaseRoutes mounts them:
// behind requiresAuth, owner-scoped).
// ---------------------------------------------------------------------------

function requiresAuthStub(req: Request, res: Response, next: NextFunction): void {
  const user = (req as unknown as { oidc?: { user?: unknown } }).oidc?.user;
  if (!user) { res.status(401).json({ error: 'unauthorized' }); return; }
  next();
}

function appFor(user: Record<string, string> | null, pool: AppContext['pool']): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => Boolean(user), user: user ?? undefined };
    next();
  });
  const ctx = { pool, swarm: {} } as unknown as AppContext;
  app.use('/api/token-chase', requiresAuthStub, createTokenChasePromotionRoutes(ctx));
  return app;
}

interface HitResult { status: number; body: Record<string, unknown> | null }

async function hit(app: express.Express, method: 'GET' | 'POST', route: string, body?: unknown): Promise<HitResult> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await realFetch(`http://127.0.0.1:${port}/api/token-chase${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    let parsed: Record<string, unknown> | null = null;
    try { parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null; } catch { parsed = null; }
    return { status: res.status, body: parsed };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('promotion routes', () => {
  it('POST promote: 401 unauthenticated (before touching the store), 400 bad seq, 400 bad thresholds', async () => {
    const { pool, query } = fakePool();
    expect((await hit(appFor(null, pool), 'POST', `/runs/${RUN_ID}/frames/3/promote`, {})).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
    expect((await hit(appFor(OWNER, pool), 'POST', `/runs/${RUN_ID}/frames/not-a-seq/promote`, {})).status).toBe(400);
    expect((await hit(appFor(OWNER, pool), 'POST', `/runs/${RUN_ID}/frames/3/promote`, { minQuality: 500 })).status).toBe(400);
  });

  it('POST promote: 404 when the frame has no recorded observations', async () => {
    const { pool } = fakePool({ corpusRows: [] });
    const res = await hit(appFor(OWNER, pool), 'POST', `/runs/${RUN_ID}/frames/3/promote`, {});
    expect(res.status).toBe(404);
  });

  it('POST promote: 422 with per-candidate rejections when nothing clears the bar', async () => {
    const { pool, query } = fakePool({
      corpusRows: [
        winnerCorpusRow({ judge_mode: 'lexical-fallback' }),
        winnerCorpusRow({ judge_score: 40 }),
      ],
    });
    const res = await hit(appFor(OWNER, pool), 'POST', `/runs/${RUN_ID}/frames/3/promote`, {});
    expect(res.status).toBe(422);
    const rejected = res.body?.rejected as Array<Record<string, unknown>>;
    expect(rejected.map((r) => r.reason).sort()).toEqual(['below-quality-bar', 'lexical-fallback-judged']);
    expect(callsMatching(query, /INSERT INTO token_chase_promotions/)).toHaveLength(0);
  });

  it('POST promote: promotes the winner (source manual), and applyToBotConfig refuses honestly without ADR-034 config sync', async () => {
    const { pool, query } = fakePool({ corpusRows: [winnerCorpusRow()] });
    const res = await hit(appFor(OWNER, pool), 'POST', `/runs/${RUN_ID}/frames/3/promote`, { applyToBotConfig: true });
    expect(res.status).toBe(200);
    const promotion = res.body?.promotion as Record<string, unknown>;
    expect(promotion.model).toBe('llama-3.3-70b:free');
    expect(promotion.source).toBe('manual');
    expect(promotion.status).toBe('active');
    const botConfig = res.body?.botConfig as Record<string, unknown>;
    expect(botConfig.applied).toBe(false);
    expect(String(botConfig.reason)).toMatch(/not available/i);
    // The corpus read is scoped to caller + run + frame.
    const corpusSelects = callsMatching(query, /FROM token_chase_optimizer_corpus/);
    expect(corpusSelects[0][1]).toEqual([OWNER.sub, RUN_ID, 3]);
  });

  it('POST revert: 401 unauthenticated, 404 when no active promotion is owned, 200 on success', async () => {
    const missing = fakePool({ revertRow: null });
    expect((await hit(appFor(null, missing.pool), 'POST', '/promotions/promo-1/revert')).status).toBe(401);
    expect((await hit(appFor(OWNER, missing.pool), 'POST', '/promotions/promo-1/revert')).status).toBe(404);

    const found = fakePool({
      revertRow: { ...promotionRowFrom([OWNER.sub, RUN_ID, 3, 'framework:openrouter', 'llama-3.3-70b:free', null, null, null, '0.10', '0.02', '0.08', 92, 'manual']), status: 'reverted' },
    });
    const res = await hit(appFor(OWNER, found.pool), 'POST', '/promotions/promo-1/revert');
    expect(res.status).toBe(200);
    expect((res.body?.promotion as Record<string, unknown>).status).toBe('reverted');
  });

  it('GET promotions: 401 unauthenticated; 200 returns the owner-scoped store + audit trail', async () => {
    const listRow = promotionRowFrom([OWNER.sub, RUN_ID, 3, 'framework:openrouter', 'llama-3.3-70b:free', null, 'harness:claude-code-cli', 'claude-sonnet-4-6', '0.10', '0.02', '0.08', 92, 'manual']);
    const auditRow = { id: 'audit-1', promotion_id: 'promo-1', run_id: RUN_ID, seq: 3, action: 'promote', detail: { model: 'llama-3.3-70b:free' }, created_at: '2026-07-24T01:00:00.000Z' };
    const { pool, query } = fakePool({ promotionsList: [listRow], auditRows: [auditRow] });
    expect((await hit(appFor(null, pool), 'GET', `/runs/${RUN_ID}/promotions`)).status).toBe(401);

    const res = await hit(appFor(OWNER, pool), 'GET', `/runs/${RUN_ID}/promotions`);
    expect(res.status).toBe(200);
    expect(res.body?.runId).toBe(RUN_ID);
    const promotions = res.body?.promotions as Array<Record<string, unknown>>;
    expect(promotions[0]).toMatchObject({ model: 'llama-3.3-70b:free', status: 'active', judgeScore: 92, savedUsd: 0.08 });
    const audit = res.body?.audit as Array<Record<string, unknown>>;
    expect(audit[0]).toMatchObject({ action: 'promote', seq: 3 });
    // Owner scoping on both reads.
    for (const call of callsMatching(query, /FROM token_chase_promotion/)) {
      expect(call[1][0]).toBe(OWNER.sub);
    }
  });
});
