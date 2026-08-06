/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | LinkedIn Profile Studio domain types: the per-user plan (desired headline/about/skills/custom URL + background-image and featured-resume asset paths) and its approval/dispatch state machine. LinkedIn has no profile-edit API, so the plan is human-approved, then dispatched to the desktop browser-control worker; canTransition is the single legal-move table both the store and the routes enforce.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add photoPath — the profile photo (headshot) asset, sourced by direct upload or picked from the user's Portrait Studio gallery (client-side integration; no cross-package coupling).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Expose the monotonic dispatch generation used to reject stale callback ABA races without exposing capability material.
 */

/** The plan lifecycle. `draft` is editable; `approved` is frozen and dispatchable;
 *  `dispatched` is on the desktop worker; `applied`/`failed` are terminal until reset. */
export const PLAN_STATES = ['draft', 'approved', 'dispatched', 'applied', 'failed'] as const;

/** One of {@link PLAN_STATES}. */
export type PlanState = (typeof PLAN_STATES)[number];

/** The per-user desired LinkedIn profile + lifecycle (one live plan per user). */
export interface LinkedInProfilePlan {
  id: number;
  userSub: string;
  /** Desired LinkedIn headline (LinkedIn caps it at 220 chars). */
  headline: string;
  /** Desired About section (LinkedIn caps it at 2600 chars). */
  about: string;
  /** Desired skills to ensure exist on the profile (LinkedIn caps the list at 100; we plan ≤15). */
  skills: string[];
  /** Desired public-profile custom URL slug (linkedin.com/in/<slug>), optional. */
  customUrl: string;
  /** Server path of the uploaded background/banner image (1584×396 recommended), or null. */
  backgroundImagePath: string | null;
  /** Server path of the profile photo/headshot (400×400+ recommended; uploaded directly or
   *  picked from the user's Portrait Studio gallery), or null. */
  photoPath: string | null;
  /** Server path of the resume PDF to add to the Featured section, or null. */
  resumePath: string | null;
  state: PlanState;
  /** Remote-client task id of the last dispatch, for the watchdog/debug trail. */
  dispatchTaskId: string | null;
  /** Remote client (desktop worker) the last dispatch went to. */
  dispatchClientId: string | null;
  /** Monotonic generation; never reset, so an older callback cannot match a later dispatch. */
  dispatchGeneration: number;
  /** The operator bot's outcome report — what was applied, what blocked. */
  resultNote: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The editable fields a draft save may set (everything else moves via the state machine). */
export interface PlanDraftInput {
  headline?: string;
  about?: string;
  skills?: string[];
  customUrl?: string;
}

/**
 * @description The single legal-move table of the plan state machine. Edits are only
 * legal in `draft`; dispatch only from `approved`; the worker resolves `dispatched` to
 * `applied`/`failed`; any non-dispatched state may reset to `draft` (a dispatched plan
 * must resolve first so a stale reset can't race the worker's callback).
 * @param from - The current state.
 * @param to - The requested state.
 * @returns Whether the transition is legal.
 */
export function canTransition(from: PlanState, to: PlanState): boolean {
  switch (to) {
    case 'draft':
      return from !== 'draft' && from !== 'dispatched';
    case 'approved':
      return from === 'draft';
    case 'dispatched':
      return from === 'approved';
    case 'applied':
    case 'failed':
      return from === 'dispatched';
    default:
      return false;
  }
}
