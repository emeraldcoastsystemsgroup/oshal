/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | LinkedIn AI Content Assistant domain types: the SocialContentDraft record + its five-state lifecycle, the LinkedIn-content judge rubric, and the injected generator/grader/publisher contracts. Kept in the feature layer with NO import of the sibling quality-judge slice (FSD forbids same-layer cross-slice imports) — the app layer adapts JudgeVerdict onto GradeResult when it wires the service.
 */

/**
 * @description The lifecycle state of a LinkedIn content draft. A draft is generated
 * (`draft`), graded + surfaced for review (`pending-approval`), human-approved into a
 * publish slot (`scheduled`), then either sent (`published`) or discarded (`rejected`).
 * `published` and `rejected` are terminal. This is the single source of truth for the
 * `state` column and the state machine — never inline a state string elsewhere.
 */
export type DraftState = 'draft' | 'pending-approval' | 'scheduled' | 'published' | 'rejected';

/**
 * @description Every valid draft state, in lifecycle order. Exported so the store's CHECK
 * constraint, the state machine, and tests all read the SAME list instead of drifting copies.
 */
export const DRAFT_STATES: readonly DraftState[] = [
  'draft',
  'pending-approval',
  'scheduled',
  'published',
  'rejected',
] as const;

/**
 * @description The LinkedIn-content grading rubric handed to the shared quality-judge. Each
 * string becomes a named dimension in the verdict (the judge keys dimensions off these
 * verbatim), so they are the on-brand quality bar a draft must clear before it is worth the
 * operator's review time: a scroll-stopping hook, plain clarity, a real call-to-action, a
 * length that fits the LinkedIn feed, and the operator's credible builder voice.
 */
export const LINKEDIN_RUBRIC: readonly string[] = [
  'hook strength — does the opening line stop the scroll and earn the read',
  'clarity — is the point immediately understandable, scannable, no jargon wall',
  'call to action — does it close with a genuine question or soft CTA that invites comments',
  'length fit — is it sized for the LinkedIn feed (a hook, 2-4 short paragraphs, not a wall)',
  'on-brand voice — confident first-person builder voice, accurate, no hype or invented facts',
] as const;

/**
 * @description What the operator asked for when kicking off a draft. `topic` is required;
 * `goal`/`tone`/`sourceUrl` sharpen it. `sourceUrl`, when present, means the post should share
 * and link that article (the generator is told to include the URL once).
 */
export interface DraftGenerationInput {
  /** The subject of the post (required). */
  topic: string;
  /** What the operator wants the post to achieve (e.g. "position me as an AI-swarm builder"). */
  goal?: string;
  /** Desired voice/tone (default: a credible builder voice). */
  tone?: string;
  /** Optional article the post shares + links. */
  sourceUrl?: string;
}

/**
 * @description The normalized grade result the assistant consumes. This is a deliberate,
 * minimal projection of the quality-judge verdict so this feature never imports the
 * quality-judge slice: the app layer maps JudgeVerdict → GradeResult when constructing the
 * service. `mode` distinguishes a real LLM judgement from the deterministic lexical fallback
 * (noop provider / judge unavailable) so a fallback score is never mistaken for a judgement.
 */
export interface GradeResult {
  /** Overall 0..100 quality score. */
  score: number;
  /** Per-rubric-criterion scores, keyed by the rubric strings verbatim. */
  dimensions: Record<string, number>;
  /** Why the judge scored it this way (or how the fallback computed it). */
  rationale: string;
  /** 'llm' = graded by the judge bot; 'lexical-fallback' = deterministic proxy. */
  mode: string;
}

/**
 * @description A persisted LinkedIn content draft — the row shape returned to the surface.
 * `dimensions` is the judge's per-criterion breakdown; `scheduledFor` is set only once the
 * draft is approved into a slot; `publishError` carries the last user-visible publish skip
 * (e.g. "connect LinkedIn") without failing the whole request.
 */
export interface SocialContentDraft {
  /** Surrogate id (serial). */
  id: number;
  /** Owner OIDC sub — every read/write is scoped to this. */
  userSub: string;
  /** The requested topic. */
  topic: string;
  /** The requested goal, if any. */
  goal: string | null;
  /** The requested tone, if any. */
  tone: string | null;
  /** The shared article URL, if any. */
  sourceUrl: string | null;
  /** The drafted post body (the exact text that would be published). */
  body: string;
  /** The judge's overall score (0..100), or null before grading. */
  score: number | null;
  /** The judge's per-criterion scores. */
  dimensions: Record<string, number>;
  /** Which judge lane scored it ('llm' | 'lexical-fallback'), or null before grading. */
  judgeMode: string | null;
  /** The judge's rationale, or null before grading. */
  rationale: string | null;
  /** Whether a refine pass ran (the draft scored below the bar on first grade). */
  refined: boolean;
  /** Lifecycle state. */
  state: DraftState;
  /** The publish slot assigned at approval, or null. */
  scheduledFor: string | null;
  /** The last publish skip/error surfaced to the operator, or null. */
  publishError: string | null;
  /** Row creation timestamp. */
  createdAt: string;
  /** Row last-update timestamp. */
  updatedAt: string;
}

/**
 * @description The outcome of a publish-now attempt. `ok` = the post went live (`postId` set).
 * `skipped` = a clean, expected non-failure the operator can act on (no LinkedIn connection):
 * the draft stays scheduled, nothing is faked, and `message` tells them what to do. A hard
 * error (LinkedIn 5xx) sets neither and carries `message` for the surface.
 */
export interface PublishOutcome {
  /** True only when the post was actually published. */
  ok: boolean;
  /** True when publish was cleanly skipped (e.g. LinkedIn not connected) — not a failure. */
  skipped?: boolean;
  /** Suggested HTTP status for the route to return. */
  code?: number;
  /** User-visible message (skip guidance or error detail). */
  message?: string;
  /** The LinkedIn post id when ok. */
  postId?: string | null;
}
