/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the Token Chase step-2b debugger endpoints (ADR-046 §10): GET /runs/:runId/observations and GET /runs/:runId/frames/:seq/inspect must 401 an unauthenticated caller BEFORE touching the corpus, scope corpus reads to the caller's own user_sub, 404 a missing or other-owner frame, 400 a bad sequence, return the documented camelCase shapes, and DEGRADE to frame-only (observationsUnavailable) when the corpus read fails — the debugger is READ-ONLY and must never fire a replay.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTokenChaseRoutes } from '@/app/routes/token-chase-routes';
import type { AppContext } from '@/app/composition/app-context';

const realFetch = globalThis.fetch;

const OWNER = { sub: 'debugger-owner-sub', email: 'owner@example.test' };
const RUN_ID = 'run-debugger-guard';

/** One raw token_chase_optimizer_corpus row, as the debugger SELECT returns it. */
const CORPUS_ROW = {
  seq: 3,
  created_at: '2026-07-24T00:00:00.000Z',
  baseline_provider: 'harness:claude-code-cli',
  baseline_model: 'claude-sonnet-4-6',
  baseline_cost_usd: '0.012345',
  variant_provider: 'framework:openrouter',
  variant_model: 'meta-llama/llama-3.3-70b-instruct:free',
  cost_usd: '0',
  cost_delta_usd: '-0.012345',
  latency_ms: 1500,
  accuracy: '0.91',
  equivalent: true,
  tier: 'equivalent-cheaper',
  status: 'equivalent',
  query_type: 'summarize',
  harness: 'claude-code',
  judge_score: 88,
  judge_mode: 'llm',
};

const CORPUS_SELECT = /SELECT[\s\S]*FROM token_chase_optimizer_corpus/;

/** Fake pool: corpus SELECTs answer rows (or throw), schema DDL succeeds; spy proves scoping. */
function fakePool(opts?: { selectThrows?: boolean }): { pool: AppContext['pool']; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (sql: string) => {
    if (CORPUS_SELECT.test(sql)) {
      if (opts?.selectThrows) throw new Error('corpus unavailable');
      return { rows: [CORPUS_ROW] };
    }
    return { rows: [] };
  });
  return { pool: { query } as unknown as AppContext['pool'], query };
}

/** requiresAuth stub mirroring the server mount: 401 with no session, else pass through. */
function requiresAuthStub(req: Request, res: Response, next: NextFunction): void {
  const user = (req as unknown as { oidc?: { user?: unknown } }).oidc?.user;
  if (!user) { res.status(401).json({ error: 'unauthorized' }); return; }
  next();
}

let workspaceRoot: string;

/** Writes one captured frame file the read service can resolve (frame-000N.json). */
function writeFrame(seq: number, userSub: string | null): void {
  const dir = path.join(workspaceRoot, RUN_ID, '.tokenchase');
  fs.mkdirSync(dir, { recursive: true });
  const frame = {
    seq,
    userSub: userSub ?? undefined,
    agentId: 'bot-debug-1',
    source: 'swarm',
    phase: 'closed',
    replayable: true,
    decision: { providerRequested: 'anthropic', harnessFired: 'claude-code', model: 'claude-sonnet-4-6' },
    context: { inputMessages: 4, tools: ['bash'], systemPrompt: 'You are the debug bot.' },
    outcome: { tokensIn: 100, tokensOut: 20, latencyMs: 900 },
    response: { content: 'baseline answer', blocks: [] },
  };
  fs.writeFileSync(path.join(dir, `frame-${String(seq).padStart(4, '0')}.json`), JSON.stringify(frame));
}

/** Builds the app exactly as server.ts mounts it: requiresAuth in front of the router. */
function appFor(user: Record<string, string> | null, pool: AppContext['pool']): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => Boolean(user), user: user ?? undefined };
    next();
  });
  const ctx = { pool } as unknown as AppContext;
  app.use('/api/token-chase', requiresAuthStub, createTokenChaseRoutes(workspaceRoot, ctx));
  return app;
}

interface HitResult { status: number; body: Record<string, unknown> | null }

async function get(app: express.Express, route: string): Promise<HitResult> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await realFetch(`http://127.0.0.1:${port}/api/token-chase${route}`);
    const raw = await res.text();
    let parsed: Record<string, unknown> | null = null;
    try { parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null; } catch { parsed = null; }
    return { status: res.status, body: parsed };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** The corpus SELECT calls made against the spy (schema DDL filtered out). */
function corpusSelects(query: ReturnType<typeof vi.fn>): Array<[string, unknown[]]> {
  return query.mock.calls.filter((c) => CORPUS_SELECT.test(String(c[0]))) as Array<[string, unknown[]]>;
}

describe('Token Chase step-2b debugger endpoints (read-only trace inspector)', () => {
  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-debugger-'));
    process.env.SHARED_WORKSPACE_ROOT = workspaceRoot;
    delete process.env.TOKEN_CHASE_ADMIN_SUBS;
  });
  afterEach(() => {
    delete process.env.SHARED_WORKSPACE_ROOT;
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  describe('GET /runs/:runId/observations', () => {
    it('rejects an unauthenticated caller with 401 before touching the corpus', async () => {
      const { pool, query } = fakePool();
      const res = await get(appFor(null, pool), `/runs/${RUN_ID}/observations`);
      expect(res.status).toBe(401);
      expect(query).not.toHaveBeenCalled();
    });

    it('returns the caller-scoped observation history in the documented camelCase shape', async () => {
      const { pool, query } = fakePool();
      const res = await get(appFor(OWNER, pool), `/runs/${RUN_ID}/observations`);
      expect(res.status).toBe(200);
      expect(res.body?.runId).toBe(RUN_ID);
      const observations = res.body?.observations as Array<Record<string, unknown>>;
      expect(observations).toHaveLength(1);
      expect(observations[0]).toMatchObject({
        seq: 3,
        createdAt: '2026-07-24T00:00:00.000Z',
        baselineProvider: 'harness:claude-code-cli',
        baselineModel: 'claude-sonnet-4-6',
        baselineCostUsd: 0.012345,
        variantProvider: 'framework:openrouter',
        variantModel: 'meta-llama/llama-3.3-70b-instruct:free',
        variantCostUsd: 0,
        costDeltaUsd: -0.012345,
        latencyMs: 1500,
        accuracy: 0.91,
        equivalent: true,
        tier: 'equivalent-cheaper',
        status: 'equivalent',
        queryType: 'summarize',
        harness: 'claude-code',
        judgeScore: 88,
        judgeMode: 'llm',
      });
      // Owner scoping: the SELECT is parameterized on the CALLER's sub + the run id.
      const selects = corpusSelects(query);
      expect(selects).toHaveLength(1);
      expect(selects[0][1]).toEqual([OWNER.sub, RUN_ID]);
    });

    it('answers 500 (not a silent empty list) when the corpus read fails', async () => {
      const { pool } = fakePool({ selectThrows: true });
      const res = await get(appFor(OWNER, pool), `/runs/${RUN_ID}/observations`);
      expect(res.status).toBe(500);
      expect(res.body?.error).toBe('Failed to read observations');
    });
  });

  describe('GET /runs/:runId/frames/:seq/inspect', () => {
    it('rejects an unauthenticated caller with 401 before touching frame or corpus', async () => {
      writeFrame(3, OWNER.sub);
      const { pool, query } = fakePool();
      const res = await get(appFor(null, pool), `/runs/${RUN_ID}/frames/3/inspect`);
      expect(res.status).toBe(401);
      expect(query).not.toHaveBeenCalled();
    });

    it('rejects a non-numeric frame sequence with 400', async () => {
      const { pool, query } = fakePool();
      const res = await get(appFor(OWNER, pool), `/runs/${RUN_ID}/frames/not-a-seq/inspect`);
      expect(res.status).toBe(400);
      expect(res.body?.error).toBe('Invalid frame sequence');
      expect(query).not.toHaveBeenCalled();
    });

    it('404s a frame that does not exist', async () => {
      const { pool } = fakePool();
      const res = await get(appFor(OWNER, pool), `/runs/${RUN_ID}/frames/99/inspect`);
      expect(res.status).toBe(404);
      expect(res.body?.error).toBe('Frame not found');
    });

    it("404s another user's frame — owner scoping matches the sibling frame read", async () => {
      writeFrame(3, 'someone-else-entirely');
      const { pool, query } = fakePool();
      const res = await get(appFor(OWNER, pool), `/runs/${RUN_ID}/frames/3/inspect`);
      expect(res.status).toBe(404);
      // Denied before the corpus read: no observation rows leak for a frame the caller cannot see.
      expect(corpusSelects(query)).toHaveLength(0);
    });

    it('bundles the full frame with its recorded observations, scoped to caller + run + seq', async () => {
      writeFrame(3, OWNER.sub);
      const { pool, query } = fakePool();
      const res = await get(appFor(OWNER, pool), `/runs/${RUN_ID}/frames/3/inspect`);
      expect(res.status).toBe(200);
      const inspect = res.body?.inspect as Record<string, unknown>;
      expect(inspect.runId).toBe(RUN_ID);
      expect(inspect.seq).toBe(3);
      expect(inspect.observationsUnavailable).toBe(false);
      const frame = inspect.frame as Record<string, unknown>;
      expect(frame.seq).toBe(3);
      expect(frame.systemPrompt).toBe('You are the debug bot.');
      expect(frame.responseContent).toBe('baseline answer');
      expect(frame.model).toBe('claude-sonnet-4-6');
      expect(frame.tokensIn).toBe(100);
      const observations = inspect.observations as Array<Record<string, unknown>>;
      expect(observations).toHaveLength(1);
      expect(observations[0].tier).toBe('equivalent-cheaper');
      expect(observations[0].judgeScore).toBe(88);
      const selects = corpusSelects(query);
      expect(selects).toHaveLength(1);
      expect(selects[0][1]).toEqual([OWNER.sub, RUN_ID, 3]);
    });

    it('degrades to frame-only (observationsUnavailable) when the corpus read fails — never blanks the forensics view', async () => {
      writeFrame(3, OWNER.sub);
      const { pool } = fakePool({ selectThrows: true });
      const res = await get(appFor(OWNER, pool), `/runs/${RUN_ID}/frames/3/inspect`);
      expect(res.status).toBe(200);
      const inspect = res.body?.inspect as Record<string, unknown>;
      expect(inspect.observationsUnavailable).toBe(true);
      expect(inspect.observations).toEqual([]);
      expect((inspect.frame as Record<string, unknown>).responseContent).toBe('baseline answer');
    });
  });
});
