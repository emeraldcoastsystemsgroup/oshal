/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The LinkedIn AI Content Assistant orchestration: generate a draft on the accountable social-writer bot -> grade it on the shared quality-judge against the LinkedIn rubric -> if it misses the bar (SOCIAL_JUDGE_BAR) run exactly ONE refine pass and keep the better version -> persist as a pending-approval draft. Plus the approve->schedule / reject / publish-now transitions, all funneled through the pure state machine so publish is impossible unless approved and a rejected draft is terminal. LLM transport (bot draft, judge) and the LinkedIn publish are injected so the whole flow is unit-testable under noop with zero cost.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review gap-list round2: (1) publishNow now atomically CLAIMS the scheduled draft (casState scheduled->published) BEFORE the live LinkedIn POST so two concurrent publishes can't both fire a UGC post; on skip/error/throw it releases the claim back to scheduled. (2) createDraft wraps the best-effort refine pass in try/catch — a refine bot/judge failure now keeps the already-graded first version and still persists pending-approval instead of orphaning an ungraded 'draft' row.
 */

import { createChildLogger } from '@/shared/logger';
import {
  LINKEDIN_RUBRIC,
  type DraftGenerationInput,
  type GradeResult,
  type PublishOutcome,
  type SocialContentDraft,
} from '../types';
import { assertTransition, computeNextSlot, needsRefine, resolveJudgeBar } from './draft-state-machine';
import type { ContentDraftStore } from './content-draft-store';

const logger = createChildLogger({ module: 'linkedin-content-service' });

/**
 * @description Produces post text on the accountable social-writer bot. Injected so the LLM
 * transport (executeBotOrInline → social-writer, cost captured in chat_tasks) lives in the app
 * layer and tests can supply a deterministic fake. `refine` gets the current body + the grade so
 * it can target the weak dimensions.
 */
export interface DraftGenerator {
  /** Draft a LinkedIn post from the operator's request. */
  generate(input: DraftGenerationInput): Promise<string>;
  /** Revise the current draft once, aimed at the judge's critique. */
  refine(input: DraftGenerationInput, currentBody: string, grade: GradeResult): Promise<string>;
}

/**
 * @description Grades one post body against a rubric, returning the normalized {@link GradeResult}.
 * Injected so the app layer wires the shared quality-judge (JudgeService) and tests pass a fake.
 */
export type Grader = (args: { task: string; output: string; rubric: readonly string[] }) => Promise<GradeResult>;

/**
 * @description Publishes approved text to the caller's LinkedIn via their broker token. Injected
 * so the app layer owns the connector call and returns a clean skip when LinkedIn isn't connected.
 */
export type DraftPublisher = (userSub: string, text: string) => Promise<PublishOutcome>;

/** Construction dependencies for {@link LinkedInContentService}. */
export interface LinkedInContentServiceDeps {
  store: ContentDraftStore;
  generator: DraftGenerator;
  grader: Grader;
  publisher: DraftPublisher;
  /** Raw SOCIAL_JUDGE_BAR value (default resolves to 75). */
  judgeBar?: string;
  /** Raw SOCIAL_POST_SLOT_HOUR value (default resolves to 9). */
  slotHour?: string;
}

/** Build the judge task string from the operator's request (what the post is supposed to do). */
function gradeTask(input: DraftGenerationInput): string {
  return [
    `Write a LinkedIn post about: ${input.topic}`,
    input.goal ? `Goal: ${input.goal}` : '',
    input.tone ? `Tone: ${input.tone}` : '',
    input.sourceUrl ? `Shares and links this article: ${input.sourceUrl}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * @description The LinkedIn content assistant. Owns the generate→grade→refine→pending-approval
 * flow and the human-gated approve/reject/publish lifecycle. Never publishes without an approval,
 * never fakes a publish, and never returns a cross-user draft (the store is user_sub-scoped).
 */
export class LinkedInContentService {
  private readonly store: ContentDraftStore;
  private readonly generator: DraftGenerator;
  private readonly grader: Grader;
  private readonly publisher: DraftPublisher;
  private readonly bar: number;
  private readonly slotHour: number;

  /**
   * @description Wire the service to its store + injected transports + config.
   * @param deps - See {@link LinkedInContentServiceDeps}.
   */
  constructor(deps: LinkedInContentServiceDeps) {
    this.store = deps.store;
    this.generator = deps.generator;
    this.grader = deps.grader;
    this.publisher = deps.publisher;
    this.bar = resolveJudgeBar(deps.judgeBar ?? process.env.SOCIAL_JUDGE_BAR);
    this.slotHour = Number(deps.slotHour ?? process.env.SOCIAL_POST_SLOT_HOUR);
  }

  /** @description The effective pass bar (for surfacing in responses). */
  get judgeBar(): number {
    return this.bar;
  }

  /**
   * @description Run the orchestrated flow: draft on the bot, grade on the judge, and if the
   * first grade is below the bar, refine once and keep whichever version scored higher. Persist
   * the result as a `pending-approval` draft (nothing is scheduled or published here — that is a
   * human click). Returns the persisted draft with its score + per-dimension breakdown.
   * @param userSub - Owner OIDC sub.
   * @param input - The operator's topic/goal/tone/source request.
   * @returns The persisted, graded draft awaiting approval.
   */
  async createDraft(userSub: string, input: DraftGenerationInput): Promise<SocialContentDraft> {
    const firstBody = await this.generator.generate(input);
    const draft = await this.store.insertDraft(userSub, {
      topic: input.topic, goal: input.goal ?? null, tone: input.tone ?? null,
      sourceUrl: input.sourceUrl ?? null, body: firstBody,
    });
    const task = gradeTask(input);
    let best = { body: firstBody, grade: await this.grader({ task, output: firstBody, rubric: LINKEDIN_RUBRIC }) };
    let refined = false;

    if (needsRefine(best.grade.score, this.bar)) {
      logger.info({ userSub, draftId: draft.id, score: best.grade.score, bar: this.bar }, 'Draft below bar — one refine pass');
      try {
        const refinedBody = await this.generator.refine(input, best.body, best.grade);
        const refinedGrade = await this.grader({ task, output: refinedBody, rubric: LINKEDIN_RUBRIC });
        if (refinedGrade.score >= best.grade.score) best = { body: refinedBody, grade: refinedGrade };
        refined = true;
      } catch (err) {
        // Refine is a best-effort bonus pass. If the social-writer bot or the judge fails here
        // (budget block, bot unavailable) we keep the already-graded FIRST version and still
        // persist it as pending-approval — never leave an ungraded 'draft' row orphaned.
        logger.error(
          { err, stack: (err as Error)?.stack, userSub, draftId: draft.id },
          'Refine pass failed — keeping the first-graded version',
        );
      }
    }

    const graded = await this.store.applyGrade(userSub, draft.id, {
      body: best.body, score: best.grade.score, dimensions: best.grade.dimensions,
      judgeMode: best.grade.mode, rationale: best.grade.rationale, refined,
    });
    logger.info({ userSub, draftId: draft.id, score: best.grade.score, mode: best.grade.mode, refined }, 'Draft created (pending-approval)');
    return graded ?? draft;
  }

  /**
   * @description Approve a pending draft into a publish slot: legal only from `pending-approval`,
   * moves it to `scheduled` and stamps a real next-slot time. Clears any prior publish error.
   * @param userSub - Owner OIDC sub.
   * @param id - Draft id.
   * @returns The scheduled draft, or null when the id isn't the caller's.
   */
  async approve(userSub: string, id: number): Promise<SocialContentDraft | null> {
    const draft = await this.requireDraft(userSub, id);
    if (!draft) return null;
    assertTransition(draft.state, 'scheduled');
    const slot = computeNextSlot(new Date(), this.slotHour);
    return this.store.setState(userSub, id, 'scheduled', { scheduledFor: slot.toISOString(), publishError: null });
  }

  /**
   * @description Reject a draft (terminal). Legal from `draft`, `pending-approval`, or
   * `scheduled`; a no-op-worthy error if already published/rejected.
   * @param userSub - Owner OIDC sub.
   * @param id - Draft id.
   * @returns The rejected draft, or null when the id isn't the caller's.
   */
  async reject(userSub: string, id: number): Promise<SocialContentDraft | null> {
    const draft = await this.requireDraft(userSub, id);
    if (!draft) return null;
    assertTransition(draft.state, 'rejected');
    return this.store.setState(userSub, id, 'rejected');
  }

  /**
   * @description Publish an approved draft now. Publish is legal ONLY from `scheduled`
   * (assertTransition enforces "not approved → can't publish"). On a clean skip (LinkedIn not
   * connected) the draft STAYS scheduled and the skip message is recorded — nothing is faked. On
   * success it moves to `published`. On a hard error it stays scheduled with the error recorded.
   * @param userSub - Owner OIDC sub.
   * @param id - Draft id.
   * @returns The publish outcome + the resulting draft (or null when the id isn't the caller's).
   */
  async publishNow(userSub: string, id: number): Promise<{ outcome: PublishOutcome; draft: SocialContentDraft } | null> {
    const draft = await this.requireDraft(userSub, id);
    if (!draft) return null;
    assertTransition(draft.state, 'published'); // blocks publish from any non-scheduled state (clean 409)
    // Atomically CLAIM the scheduled draft before the network POST: only the request that wins the
    // compare-and-swap (scheduled→published) proceeds to publish, so two concurrent publishes can't
    // both fire a live LinkedIn UGC post. The claim is released back to scheduled on skip/error.
    const claimed = await this.store.casState(userSub, id, 'scheduled', 'published', { publishError: null });
    if (!claimed) {
      // Lost the race — a concurrent publish already claimed this draft. Do NOT post a duplicate.
      const current = await this.requireDraft(userSub, id);
      logger.warn({ userSub, draftId: id }, 'Publish skipped — draft already claimed by a concurrent request');
      return {
        outcome: { ok: false, skipped: true, message: 'This draft is already being published.' },
        draft: current ?? draft,
      };
    }
    let outcome: PublishOutcome;
    try {
      outcome = await this.publisher(userSub, draft.body);
    } catch (err) {
      // Publisher threw — release the claim back to scheduled with the error, then rethrow so the
      // route surfaces a 502 and the draft is not left stranded in 'published' with no live post.
      await this.store.casState(userSub, id, 'published', 'scheduled', { publishError: (err as Error)?.message ?? 'publish failed' });
      logger.error({ err, stack: (err as Error)?.stack, userSub, draftId: id }, 'Publisher threw — draft released back to scheduled');
      throw err;
    }
    if (outcome.ok) {
      logger.info({ userSub, draftId: id, postId: outcome.postId }, 'Draft published to LinkedIn');
      return { outcome, draft: claimed };
    }
    // Skip or clean failure: release the claim back to scheduled, record the reason so the operator can act.
    const kept = await this.store.casState(userSub, id, 'published', 'scheduled', { publishError: outcome.message ?? 'publish failed' });
    logger.warn({ userSub, draftId: id, skipped: outcome.skipped, message: outcome.message }, 'Publish not completed — draft released back to scheduled');
    return { outcome, draft: kept ?? draft };
  }

  /**
   * @description Load a draft scoped to the owner; helper so every mutation shares the same
   * "not found or not yours → null" behavior (ids are not oracle-able across users).
   * @param userSub - Owner OIDC sub.
   * @param id - Draft id.
   * @returns The draft or null.
   */
  private async requireDraft(userSub: string, id: number): Promise<SocialContentDraft | null> {
    return this.store.getById(userSub, id);
  }
}
