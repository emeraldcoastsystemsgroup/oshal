/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit tests for the LinkedIn AI Content Assistant: the pure lifecycle state machine (draft->pending->scheduled->published; publish blocked unless approved; reject terminal), the judge-bar refine trigger (one refine pass only when the first grade misses the bar, keep the better version), and the no-LinkedIn-connection clean skip (draft stays scheduled, nothing faked). Fakes stand in for pg/judge/connector so the whole flow runs with zero cost.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  assertTransition,
  canTransition,
  computeNextSlot,
  isTerminal,
  needsRefine,
  resolveJudgeBar,
  LinkedInContentService,
  type ContentDraftStore,
  type DraftGenerator,
  type DraftPublisher,
  type GradeResult,
  type Grader,
  type SocialContentDraft,
} from '@/features/linkedin-assistant';

// ── An in-memory stand-in for the Postgres-backed ContentDraftStore (mocks "pg"). ──
class FakeStore {
  rows = new Map<number, SocialContentDraft>();
  private seq = 0;
  async ensureSchema(): Promise<void> {}
  async insertDraft(userSub: string, input: { topic: string; goal?: string | null; tone?: string | null; sourceUrl?: string | null; body: string }): Promise<SocialContentDraft> {
    const id = ++this.seq;
    const d: SocialContentDraft = {
      id, userSub, topic: input.topic, goal: input.goal ?? null, tone: input.tone ?? null,
      sourceUrl: input.sourceUrl ?? null, body: input.body, score: null, dimensions: {},
      judgeMode: null, rationale: null, refined: false, state: 'draft', scheduledFor: null,
      publishError: null, createdAt: 'now', updatedAt: 'now',
    };
    this.rows.set(id, d);
    return { ...d };
  }
  async applyGrade(userSub: string, id: number, g: { body: string; score: number; dimensions: Record<string, number>; judgeMode: string; rationale: string; refined: boolean }): Promise<SocialContentDraft | null> {
    const d = this.rows.get(id);
    if (!d || d.userSub !== userSub) return null;
    Object.assign(d, { body: g.body, score: g.score, dimensions: g.dimensions, judgeMode: g.judgeMode, rationale: g.rationale, refined: g.refined, state: 'pending-approval' as const });
    return { ...d };
  }
  async getById(userSub: string, id: number): Promise<SocialContentDraft | null> {
    const d = this.rows.get(id);
    return d && d.userSub === userSub ? { ...d } : null;
  }
  async setState(userSub: string, id: number, state: SocialContentDraft['state'], opts: { scheduledFor?: string | null; publishError?: string | null } = {}): Promise<SocialContentDraft | null> {
    const d = this.rows.get(id);
    if (!d || d.userSub !== userSub) return null;
    d.state = state;
    if (opts.scheduledFor !== undefined && opts.scheduledFor !== null) d.scheduledFor = opts.scheduledFor;
    d.publishError = opts.publishError ?? null;
    return { ...d };
  }
  async casState(userSub: string, id: number, fromState: SocialContentDraft['state'], toState: SocialContentDraft['state'], opts: { scheduledFor?: string | null; publishError?: string | null } = {}): Promise<SocialContentDraft | null> {
    const d = this.rows.get(id);
    if (!d || d.userSub !== userSub || d.state !== fromState) return null; // swap only when still in fromState
    return this.setState(userSub, id, toState, opts);
  }
  async listByUser(userSub: string): Promise<SocialContentDraft[]> {
    return [...this.rows.values()].filter((r) => r.userSub === userSub);
  }
}

const SUB = 'user-abc';
const grade = (score: number, mode = 'llm'): GradeResult => ({
  score, mode, rationale: 'because', dimensions: { 'hook strength — x': score, 'clarity — y': score },
});

function build(opts: { grades: GradeResult[]; publisher?: DraftPublisher; bar?: string }) {
  const store = new FakeStore();
  const generate = vi.fn(async () => 'FIRST DRAFT BODY');
  const refine = vi.fn(async () => 'REFINED DRAFT BODY');
  const generator: DraftGenerator = { generate, refine };
  let call = 0;
  const grader: Grader = vi.fn(async () => opts.grades[Math.min(call++, opts.grades.length - 1)]);
  const publisher: DraftPublisher = opts.publisher ?? vi.fn(async () => ({ ok: true, postId: 'urn:li:share:1' }));
  const svc = new LinkedInContentService({ store: store as unknown as ContentDraftStore, generator, grader, publisher, judgeBar: opts.bar ?? '75' });
  return { store, svc, generate, refine, grader, publisher };
}

describe('draft state machine — the lifecycle contract', () => {
  it('walks draft -> pending-approval -> scheduled -> published', () => {
    expect(canTransition('draft', 'pending-approval')).toBe(true);
    expect(canTransition('pending-approval', 'scheduled')).toBe(true);
    expect(canTransition('scheduled', 'published')).toBe(true);
  });

  it('blocks publish unless approved (only scheduled -> published is legal)', () => {
    expect(canTransition('pending-approval', 'published')).toBe(false);
    expect(canTransition('draft', 'published')).toBe(false);
    expect(() => assertTransition('pending-approval', 'published')).toThrow(/Cannot move a pending-approval draft to published/);
  });

  it('reject is terminal — nothing transitions out of rejected or published', () => {
    expect(isTerminal('rejected')).toBe(true);
    expect(isTerminal('published')).toBe(true);
    expect(ALLOWED_TRANSITIONS.rejected).toHaveLength(0);
    expect(() => assertTransition('rejected', 'scheduled')).toThrow(/terminal/);
    expect(() => assertTransition('published', 'rejected')).toThrow(/terminal/);
  });

  it('needsRefine + resolveJudgeBar behave', () => {
    expect(needsRefine(70, 75)).toBe(true);
    expect(needsRefine(75, 75)).toBe(false);
    expect(resolveJudgeBar(undefined)).toBe(75);
    expect(resolveJudgeBar('abc')).toBe(75);
    expect(resolveJudgeBar('200')).toBe(100);
    expect(resolveJudgeBar('60')).toBe(60);
  });

  it('computeNextSlot lands on a future slot at the posting hour', () => {
    const from = new Date('2026-07-15T20:00:00');
    const slot = computeNextSlot(from, 9);
    expect(slot.getTime()).toBeGreaterThan(from.getTime());
    expect(slot.getHours()).toBe(9);
  });
});

describe('createDraft — judge-bar refine trigger', () => {
  it('does NOT refine when the first grade meets the bar', async () => {
    const { svc, generate, refine } = build({ grades: [grade(88)] });
    const d = await svc.createDraft(SUB, { topic: 'multi-agent swarms' });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(refine).not.toHaveBeenCalled();
    expect(d.state).toBe('pending-approval');
    expect(d.score).toBe(88);
    expect(d.refined).toBe(false);
    expect(d.body).toBe('FIRST DRAFT BODY');
  });

  it('refines EXACTLY once when below the bar and keeps the higher-scoring version', async () => {
    const { svc, refine } = build({ grades: [grade(60), grade(82)] });
    const d = await svc.createDraft(SUB, { topic: 'why swarms win' });
    expect(refine).toHaveBeenCalledTimes(1);
    expect(d.refined).toBe(true);
    expect(d.score).toBe(82);
    expect(d.body).toBe('REFINED DRAFT BODY');
    expect(d.state).toBe('pending-approval');
  });

  it('keeps the first version if the refine did not improve it (but still marks refined)', async () => {
    const { svc } = build({ grades: [grade(60), grade(55)] });
    const d = await svc.createDraft(SUB, { topic: 'x' });
    expect(d.refined).toBe(true);
    expect(d.score).toBe(60);
    expect(d.body).toBe('FIRST DRAFT BODY');
  });

  it('keeps the first-graded version (pending-approval, not orphaned) when the refine pass THROWS', async () => {
    // Below-bar first grade → refine fires, but the social-writer bot fails (budget block / down).
    const { svc, store } = build({ grades: [grade(60)] });
    (svc as unknown as { generator: DraftGenerator }).generator.refine = vi.fn(async () => {
      throw new Error('social-writer unavailable');
    });
    const d = await svc.createDraft(SUB, { topic: 'refine will fail' });
    // No orphaned ungraded 'draft' row — the first version is graded + persisted for approval.
    expect(d.state).toBe('pending-approval');
    expect(d.score).toBe(60);
    expect(d.body).toBe('FIRST DRAFT BODY');
    expect(d.refined).toBe(false);
    expect((await store.listByUser(SUB)).every((r) => r.state !== 'draft')).toBe(true);
  });
});

describe('approve / reject / publish lifecycle', () => {
  it('approve moves pending-approval -> scheduled with a slot', async () => {
    const { svc } = build({ grades: [grade(90)] });
    const created = await svc.createDraft(SUB, { topic: 't' });
    const scheduled = await svc.approve(SUB, created.id);
    expect(scheduled?.state).toBe('scheduled');
    expect(scheduled?.scheduledFor).toBeTruthy();
  });

  it('publish is blocked on a not-yet-approved draft (illegal_transition)', async () => {
    const { svc } = build({ grades: [grade(90)] });
    const created = await svc.createDraft(SUB, { topic: 't' });
    await expect(svc.publishNow(SUB, created.id)).rejects.toMatchObject({ code: 'illegal_transition' });
  });

  it('publish succeeds only after approval and moves scheduled -> published', async () => {
    const { svc, publisher } = build({ grades: [grade(90)] });
    const created = await svc.createDraft(SUB, { topic: 't' });
    await svc.approve(SUB, created.id);
    const result = await svc.publishNow(SUB, created.id);
    expect(publisher).toHaveBeenCalledOnce();
    expect(result?.outcome.ok).toBe(true);
    expect(result?.draft.state).toBe('published');
  });

  it('two concurrent publishes fire exactly ONE live post (compare-and-swap claim)', async () => {
    const publisher: DraftPublisher = vi.fn(async () => ({ ok: true, postId: 'urn:li:share:1' }));
    const { svc } = build({ grades: [grade(90)], publisher });
    const created = await svc.createDraft(SUB, { topic: 't' });
    await svc.approve(SUB, created.id);
    const [a, b] = await Promise.all([svc.publishNow(SUB, created.id), svc.publishNow(SUB, created.id)]);
    // Only one request actually posted; the loser got a clean "already being published" skip.
    expect(publisher).toHaveBeenCalledTimes(1);
    const wins = [a, b].filter((r) => r?.outcome.ok);
    const skips = [a, b].filter((r) => r?.outcome.skipped);
    expect(wins).toHaveLength(1);
    expect(skips).toHaveLength(1);
    expect(wins[0]?.draft.state).toBe('published');
  });

  it('reject is terminal — a second reject throws', async () => {
    const { svc } = build({ grades: [grade(90)] });
    const created = await svc.createDraft(SUB, { topic: 't' });
    const rejected = await svc.reject(SUB, created.id);
    expect(rejected?.state).toBe('rejected');
    await expect(svc.reject(SUB, created.id)).rejects.toThrow(/terminal/);
  });

  it('never touches another user\'s draft (scoped by sub)', async () => {
    const { svc } = build({ grades: [grade(90)] });
    const created = await svc.createDraft(SUB, { topic: 't' });
    expect(await svc.approve('someone-else', created.id)).toBeNull();
    expect(await svc.publishNow('someone-else', created.id)).toBeNull();
  });
});

describe('publish — no-LinkedIn-connection clean skip (never fakes a publish)', () => {
  it('keeps the draft scheduled and records the skip when LinkedIn is not connected', async () => {
    const skipPublisher: DraftPublisher = vi.fn(async () => ({ ok: false, skipped: true, code: 409, message: 'Connect LinkedIn at /utilities to publish.' }));
    const { svc } = build({ grades: [grade(90)], publisher: skipPublisher });
    const created = await svc.createDraft(SUB, { topic: 't' });
    await svc.approve(SUB, created.id);
    const result = await svc.publishNow(SUB, created.id);
    expect(skipPublisher).toHaveBeenCalledOnce();
    expect(result?.outcome.ok).toBe(false);
    expect(result?.outcome.skipped).toBe(true);
    // The draft is NOT published or lost — it stays scheduled with the reason recorded.
    expect(result?.draft.state).toBe('scheduled');
    expect(result?.draft.publishError).toMatch(/Connect LinkedIn/);
  });

  it('a hard LinkedIn error also leaves the draft scheduled (not published, not faked)', async () => {
    const errPublisher: DraftPublisher = vi.fn(async () => ({ ok: false, code: 502, message: 'LinkedIn rejected the post (500)' }));
    const { svc } = build({ grades: [grade(90)], publisher: errPublisher });
    const created = await svc.createDraft(SUB, { topic: 't' });
    await svc.approve(SUB, created.id);
    const result = await svc.publishNow(SUB, created.id);
    expect(result?.outcome.ok).toBe(false);
    expect(result?.draft.state).toBe('scheduled');
    expect(result?.draft.publishError).toMatch(/rejected the post/);
  });
});
