/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085/ADR-090 D8: the kernel-skills build anchor. Replaces the package-feature-anchors.ts stopgap (deleted) with the full contract: one re-export per module declared in @/shared/kernel-skills, guarded by scripts/check-kernel-skills.js. Each re-export is what physically pins the feature into dist/ — tsconfig.server.json excludes src/features/**, so the import graph is the ONLY thing that carries a feature into the built image.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 1 carve #5: pin @/features/payments (11th skill) — the finance carve removes its last core import, and both the finance + payments store packages resolve it from dist.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 spaces carve: pin @/features/spatial-mapping (12th skill) — the spaces surface carve removes its last core import (spaces-routes.ts), and spaces-operator (inline, no node-server) has no other anchor; the installed spaces package resolves it from dist.
 */

/**
 * @description Build anchor for the Tier-0b kernel skills (ADR-085 §2, ADR-090).
 *
 * ## Why this file has to exist
 *
 * `tsconfig.server.json` compiles `src/app/**`, `src/shared/**`, `src/entities/**` and
 * **excludes `src/features/**`**. A feature therefore reaches `dist/` only when something in an
 * include-root imports it. TypeScript's `exclude` filters `include` but never overrides the import
 * graph — so an import is the only reliable pin, and an *explicit tsconfig include of a feature is
 * silently a no-op* while the broad exclude stands. That is the whole bug class D8 closes.
 *
 * The consequence, learned twice: when core stopped importing `google-calendar`, it vanished from
 * the image and the first package route that required it failed at mount; `notifications` was
 * pruned the same way. Packages resolve `@/features/…` against the RUNNING framework's dist
 * (manifest-route-mounter.ts), so "core no longer calls it" must never mean "installed apps lose it".
 *
 * Every module below is re-exported for exactly one reason: to make the compiler carry it into the
 * build. `scripts/check-kernel-skills.js` then asserts each one is present in the built image, so a
 * future prune fails CI instead of a customer's app.
 *
 * ## Rules
 *
 * - The list here MUST match `KERNEL_SKILLS` in `@/shared/kernel-skills` — the CI guard fails if a
 *   declared module is missing from the image, which is what a forgotten re-export causes.
 * - **Removing a line is a breaking change** for every installed package that imports it. Skills are
 *   the kernel's public API; treat them like one.
 * - This module is never imported at runtime — it is purely a compilation root, so none of the
 *   re-exported barrels' module-level code runs on account of this file.
 * - Namespace re-exports (`export * as`) are deliberate: a flat `export *` would collide the moment
 *   two skills exported the same symbol name.
 *
 * @module app/composition/kernel-skills
 */

// ── voice: TTS / STT ─────────────────────────────────────────────────────────
export * as voiceProviders from '@/features/voice-providers';
export * as voice from '@/features/voice';

// ── notifications: notifyOperator / notifyAll across transports ──────────────
export * as notifications from '@/features/notifications';

// ── rag: Chroma abstraction + BM25 fallback ──────────────────────────────────
export * as rag from '@/features/rag';

// ── storage: Dropbox / GitHub / local storage targets (ADR-041) ──────────────
// Already inside an include root (src/app/**); re-exported so the contract is uniform and the
// guard checks it like any other skill.
export * as storageTarget from '@/app/routes/storage-target';

// ── deck-generation: the engine behind the presentations app ─────────────────
export * as presentationGeneration from '@/features/presentation-generation';

// ── graph: engine-agnostic graph connector (ADR-045) ─────────────────────────
export * as graph from '@/features/graph';
export * as personalGraph from '@/features/personal-graph';

// ── scheduling: manifest `schedules:` register + teardown ────────────────────
export * as scheduling from '@/features/scheduling';

// ── memory / user model: cross-app user state ────────────────────────────────
export * as memory from '@/features/memory';
export * as userModel from '@/features/user-model';
export * as personalData from '@/features/personal-data';

// ── tool-registry + harness/LLM layer: the aggregation thesis (ADR-049) ──────
export * as toolRegistry from '@/features/tool-registry';
export * as llmProvider from '@/features/llm-provider';

// ── media-generation: vendor-abstracted image/video ──────────────────────────
export * as videoGeneration from '@/features/video-generation';
export * as visualResponse from '@/features/visual-response';

// ── payments: provider-agnostic money rails (Stripe + merchant halves) ───────
// Pinned at the finance carve (ADR-085 Wave 1 #5): finance-routes.ts was the last core
// import; both the finance and payments store packages resolve this from dist.
export * as payments from '@/features/payments';

// ── spatial-mapping: the video->3D reconstruction engine + owner-scoped scan store ──
// Pinned at the spaces carve (ADR-111, ADR-093): spaces-routes.ts was the last core import,
// and spaces-operator is an inline concierge with no *-node-server.ts to anchor the engine
// (unlike drone/camera). The installed spaces package resolves this from dist.
export * as spatialMapping from '@/features/spatial-mapping';
