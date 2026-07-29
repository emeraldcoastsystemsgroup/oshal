/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guest-mode capability matrix (Phase 1). Single source of truth for the server-side guest guard AND the cockpit ribbon graying, so enforcement and UI never drift. Tier is resolved by the /api/<app> path SEGMENT (not a prefix) to avoid collisions like `trading` vs `trading-charts`.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 D4: guest tiers for INSTALLED APPS, keyed by route segment — but only tiers an OPERATOR APPROVED. A manifest's guestTier is a REQUEST: guests are UNAUTHENTICATED, so a package that could set its own tier would silently widen what an anonymous visitor reaches (full includes WRITES). Core's hardcoded lists are still checked first and therefore win — a package can only contribute a tier for a segment core does not claim, never override one.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 1 carve #3: dropped 'lora' from the hardcoded Tier-C list — LoRA Studio carved to the store; the package requests guestTier: blocked and the D4 unapproved default keeps guests read-only regardless.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 1 carve #4: dropped 'payments' from the hardcoded Tier-C list — same shape as lora (package requests guestTier: blocked; unapproved default blocks guest writes).
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 2: dropped 'presentations' from the hardcoded Tier-A list — AI Office carved to the store (package requests guestTier: full; D4 unapproved default = guest read-only until operator approval; the core legacy Presentron proxy on the same segment falls to the Tier-B default).
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 3: dropped 'travel' from the hardcoded Tier-A list — the Travel surface carved to the store (package requests guestTier: full; the D4 unapproved default keeps guests read-only until operator approval).
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 3: dropped 'video' from the hardcoded Tier-C list — the Video Studio carved to the store; the D4 unapproved default keeps guests read-only on the packaged mount regardless (and its every handler self-gates on callerSub anyway).
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Pumpkin public demo: retain the safe Tier-B server posture while advertising its explicitly browser-local interactive controls. No guest mutation grant is added.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Guest voice I/O: added GUEST_ALLOWED_MUTATIONS (the symmetric mirror of GUEST_BLOCKED_GETS) and granted /api/voice/transcribe + /api/voice/synthesize. Jarvis is Tier-A, but its mic posts to /api/voice/transcribe — a DIFFERENT segment that fell to the Tier-B default, so every guest push-to-talk 403'd and the UI reported "Didn't catch that". Narrow literal-prefix grants, not Tier A on `voice`, so anything else mounted there stays read-only; both routes resolve the deployment's default STT/TTS via resolveForApp() (no per-user token) and stay under the guest-guard mutation rate limit.
 */

/**
 * Guest lockdown tiers, keyed by the first app segment of an `/api/<app>/...` path.
 *
 * - TIER A: full read+write allowed for guests (interactive demo apps).
 * - TIER C: blocked entirely — even GET returns 403 (tile is grayed on the ribbon).
 * - Everything not listed defaults to TIER B: GET allowed, all mutations blocked.
 *
 * These keys are the route mount segments in src/app/server.ts (e.g.
 * app.use('/api/career-hunter', ...) → 'career-hunter').
 */
export const GUEST_TIER_A_APPS = [
  // ('education' removed — Little Monsters carved out to the app store, ADR-085)
  // ('career-hunter' removed: carved to the app store, ADR-085 Wave 3 #1 — the package
  //  declares guestTier: readonly; the D4 unapproved default keeps guests read-only anyway.)
  'jarvis',
  // ('travel' removed: carved to the app store, ADR-085 Wave 3 — the package requests
  //  guestTier: full (the deep-link-handoff demo posture); the D4 unapproved default
  //  keeps guests read-only until the operator approves.)
  // ('presentations' removed: carved to the app store, ADR-085 Wave 2 — the package requests
  //  guestTier: full; the D4 unapproved default keeps guests read-only until the operator
  //  approves, and core's legacy /api/presentations Presentron proxy falls to Tier-B.)
  // ('purchasing' removed: carved to the app store, ADR-085 Wave 2 #5 — the package declares
  //  guestTier: blocked; the D4 unapproved default keeps guests read-only regardless.)
  // ('eats' removed: carved to the app store, ADR-085 Wave 2 #4 — the package declares
  //  guestTier: blocked; the D4 unapproved default keeps guests read-only regardless.)
] as const;

export const GUEST_TIER_C_APPS = [
  'workflow-studio',
  'forge', // bots
  // ('lora' removed: carved to the app store, ADR-085 — the package declares guestTier: blocked;
  //  unapproved packages default to guest-read-only/mutations-blocked anyway, D4.)
  // ('video' removed: the Video Studio carved to the app store, ADR-085 Wave 3 — the D4
  //  unapproved default keeps guests read-only on the packaged mount, and every handler
  //  self-gates on callerSub.)
  // ('spotify' removed: carved to the app store, ADR-085 Wave 2 #2 — the package declares
  //  guestTier: blocked; the D4 unapproved default keeps guests read-only regardless.)
  // ('movies' removed: carved to the app store, ADR-085 Wave 2 #1 — the package declares
  //  guestTier: blocked; the D4 unapproved default keeps guests read-only regardless.)
  // ('payments' removed: carved to the app store, ADR-085 — the package requests
  //  guestTier: blocked; the D4 unapproved default keeps guests read-only regardless.)
] as const;

/**
 * Apps/segments a guest may always reach with any method — the plumbing the
 * cockpit needs to even render, plus the guest session endpoints themselves.
 * Without this, `POST /api/guest/start` would fall into the Tier-B default and
 * be blocked as a mutation.
 */
export const GUEST_ALWAYS_ALLOW_APPS = ['guest', 'auth', 'branding', 'ui', 'health'] as const;

/**
 * Tier-B endpoints that read data but are dangerous/costly enough to block even
 * on GET (e.g. things that fan out to an LLM or an external API on read).
 * Matched as a literal path prefix. Extend as needed.
 */
export const GUEST_BLOCKED_GETS: readonly string[] = [];

/**
 * Tier-B endpoints a guest MAY mutate — the symmetric mirror of
 * `GUEST_BLOCKED_GETS`. Matched as a literal path prefix, and checked only after
 * the Tier-C and approved-`blocked` denials, so a hard block always wins.
 *
 * This exists because a Tier-A app can depend on a route in a DIFFERENT segment.
 * Jarvis is Tier A, but its microphone posts to `/api/voice/transcribe`, whose
 * segment (`voice`) fell to the Tier-B default — so every guest push-to-talk got
 * 403 `guest_readonly` and the UI reported "Didn't catch that". Granting the two
 * voice-I/O routes here (rather than making the whole `voice` segment Tier A)
 * keeps anything else mounted under `/api/voice` read-only to guests.
 *
 * Cost posture: both routes resolve the DEPLOYMENT's default STT/TTS provider
 * (`resolveForApp()` — no per-user connector token), and the guest guard's
 * per-sub mutation rate limit applies to them like any other Tier-A write.
 */
export const GUEST_ALLOWED_MUTATIONS: readonly string[] = [
  '/api/voice/transcribe', // speech-to-text: the Jarvis mic (push-to-talk + wake word)
  '/api/voice/synthesize', // text-to-speech: Jarvis's spoken reply
];

/** UX notation hints surfaced to the frontend (Phase 2 renders the banners). */
export const GUEST_NOTATIONS: Record<string, string> = {
  pumpkin: 'Interactive browser demo — controls and saved looks stay on this device. Sign in to connect another device.',
  // ('rides' removed: carved to the app store, ADR-085 Wave 2 #3 — the package declares
  //  guestTier: blocked; the D4 unapproved default keeps guests read-only regardless.)
};

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export type GuestDecision = 'allow' | 'guest_readonly' | 'guest_blocked';

/**
 * @description A guest tier, as an app declares it (ADR-085 D4).
 *
 * - `full`     — Tier A: guests may read AND write (an interactive demo app).
 * - `readonly` — Tier B: guests may read; every mutation is blocked. **The default.**
 * - `blocked`  — Tier C: guests get 403 even on GET, and the ribbon tile is grayed.
 */
export type GuestTier = 'full' | 'readonly' | 'blocked';

/** @description Every valid tier, for validation and error messages. */
export const GUEST_TIERS: readonly GuestTier[] = ['full', 'readonly', 'blocked'];

/**
 * @description Narrow an arbitrary manifest string to a real guest tier.
 * @param value - Candidate from a manifest's `guestTier`.
 * @returns True when it names a real tier.
 */
export function isGuestTier(value: unknown): value is GuestTier {
  return typeof value === 'string' && (GUEST_TIERS as readonly string[]).includes(value);
}

/**
 * ADR-085 D4: guest tiers for INSTALLED APP PACKAGES, keyed by route segment.
 *
 * **This map holds only tiers the OPERATOR has APPROVED** (operator decision, 2026-07-13). A
 * manifest's `guestTier` is a *request*: it is stored, surfaced for review, and does nothing until
 * an operator approves it. Nothing in the load path writes here from a manifest — the app service
 * registers a tier only after reading the approval off the app's DB row.
 *
 * That asymmetry is the whole point. Guests are UNAUTHENTICATED. If a package could set its own
 * tier, installing one would silently widen what an anonymous visitor can reach — including writes
 * (Tier A). An app cannot be trusted to decide how much of itself to expose to the public; the
 * person who owns the deployment decides.
 *
 * Keyed by route segment (not app name) because that is what `guestDecision` resolves from the
 * request path — e.g. little-monsters mounts `/api/education`, so its segment is `education`.
 */
const APPROVED_APP_GUEST_TIERS = new Map<string, GuestTier>();

/**
 * @description Register an OPERATOR-APPROVED guest tier for an installed app's route segment.
 *
 * Call ONLY with a tier read from the app's approval, never straight from its manifest.
 *
 * @param segment - Route segment (e.g. `education` for `/api/education`).
 * @param tier - The approved tier.
 */
export function registerAppGuestTier(segment: string, tier: GuestTier): void {
  if (segment) APPROVED_APP_GUEST_TIERS.set(segment, tier);
}

/**
 * @description Retract an app's approved guest tier (deactivate / uninstall / approval revoked).
 * Idempotent. The segment falls back to the `readonly` default.
 * @param segment - Route segment.
 */
export function unregisterAppGuestTier(segment: string): void {
  APPROVED_APP_GUEST_TIERS.delete(segment);
}

/** @description The approved packaged-app tiers, for the capability snapshot + tests. */
export function approvedAppGuestTiers(): ReadonlyMap<string, GuestTier> {
  return APPROVED_APP_GUEST_TIERS;
}

/**
 * @description Extracts the app segment from an Express request path.
 * `/api/world/contribute` → `world`; `/workflow-studio/` → `workflow-studio`;
 * `/api` → `''`. Segment match (not prefix) so `/api/trading` never collides
 * with `/api/trading-charts`.
 */
export function appSegmentForPath(path: string): string {
  const parts = path.split('/').filter(Boolean); // drop empty leading/trailing
  if (parts.length === 0) return '';
  // `/api/<app>/...` → second segment; bare top-level (e.g. `/workflow-studio`) → first.
  if (parts[0] === 'api') return parts[1] ?? '';
  return parts[0];
}

/**
 * @description Resolves what a guest is allowed to do with a request. Pure and
 * shared by the guard (enforcement) and /api/auth/user (so the UI matches).
 */
export function guestDecision(path: string, method: string): GuestDecision {
  const seg = appSegmentForPath(path);
  const isMutation = MUTATING_METHODS.has(method.toUpperCase());

  if (seg && (GUEST_ALWAYS_ALLOW_APPS as readonly string[]).includes(seg)) return 'allow';

  // Core's hardcoded lists are checked FIRST and therefore win. An installed package can never
  // override the tier of a core app segment — only contribute one for a segment core doesn't claim.
  if (seg && (GUEST_TIER_C_APPS as readonly string[]).includes(seg)) return 'guest_blocked';
  if (seg && (GUEST_TIER_A_APPS as readonly string[]).includes(seg)) return 'allow';

  // ADR-085 D4: an installed app's OPERATOR-APPROVED tier. Absent = the Tier-B default below, so a
  // package that has merely *requested* a tier (or never asked) is read-only to guests, not open.
  const approved = seg ? APPROVED_APP_GUEST_TIERS.get(seg) : undefined;
  if (approved === 'blocked') return 'guest_blocked';
  if (approved === 'full') return 'allow';

  // Tier B (default, includes the bare `/api` message route): reads ok, mutations
  // blocked; plus a hard list of GETs that are too costly/dangerous to allow.
  if (!isMutation) {
    if (GUEST_BLOCKED_GETS.some((p) => path.startsWith(p))) return 'guest_blocked';
    return 'allow';
  }
  // Narrow per-route mutation grants (e.g. the voice I/O a Tier-A app needs from
  // another segment). Reached only after every denial above, so a Tier-C app or an
  // approved `blocked` tier can never be widened by a prefix listed here.
  if (GUEST_ALLOWED_MUTATIONS.some((p) => path.startsWith(p))) return 'allow';
  return 'guest_readonly';
}

/**
 * @description The capability snapshot handed to the frontend so the ribbon can
 * gray the right tiles and surfaces can render read-only. Mirrors the tiers used
 * by the server guard — same constants, no drift.
 */
export function guestCapabilities() {
  // ADR-085 D4: fold in installed apps' OPERATOR-APPROVED tiers so the ribbon grays a packaged
  // Tier-C app and leaves a packaged Tier-A one interactive — same source of truth as the guard,
  // so enforcement and UI cannot drift (which is this module's whole reason to exist).
  const approvedA: string[] = [];
  const approvedC: string[] = [];
  for (const [seg, tier] of APPROVED_APP_GUEST_TIERS) {
    if (tier === 'full') approvedA.push(seg);
    else if (tier === 'blocked') approvedC.push(seg);
  }

  const tierA = [...new Set([...GUEST_TIER_A_APPS, ...approvedA])];
  const tierC = [...new Set([...GUEST_TIER_C_APPS, ...approvedC])];

  return {
    tierA,
    tierC, // grayed on the main screen
    blockedApps: tierC, // alias used by the ribbon
    notations: GUEST_NOTATIONS,
  };
}
