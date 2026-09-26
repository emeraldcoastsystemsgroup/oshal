/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085/ADR-090 D8: declare the kernel-skill contract as DATA. This is the single source of truth for the Tier-0b skills the operator signed off 2026-07-13 — consumed by the build anchor (src/app/composition/kernel-skills.ts), the manifest `uses:` validator, and the CI guard (scripts/check-kernel-skills.js). Lives in shared/ so features/, app/, and scripts/ can all read it without violating FSD's top-down import direction.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 1 carve #5 (finance): pin 'payments' as the 11th kernel skill. skill-registry.md called @/features/payments a KERNEL SKILL all along, but the code never contracted it — it stayed in dist only because finance-routes.ts imported it, and the finance carve removes that last core anchor. Without this pin the installed payments AND finance packages both fail at mount on a pruned dist (the exact google-calendar/notifications bug class D8 exists to close).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 spaces carve: pin 'spatial-mapping' as the 12th kernel skill. Identical situation to payments — the video->3D / import / RF / capture reconstruction engine + owner-scoped scan store stays kernel per ADR-093, but its ONLY core import anchor is spaces-routes.ts, which the spaces surface carve removes. Unlike drone/camera (anchored by their *-node-server.ts), spaces-operator is an INLINE concierge with no dedicated node, so there is no node-server to hold the engine in dist. Without this pin the installed spaces package fails at mount on a pruned dist.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Declare exact-principal artifact relay and in-process package tool compatibility floors.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Declare the app-dependencies compatibility floor: a manifest using dependencies.required/optional names it so an older core refuses the package instead of installing it without its required dependencies.
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Contract 'google-calendar' as a kernel skill: OAuth-injected Calendar v3 client pinned into dist so calendar packages resolve @/features/google-calendar without deep service imports.
 * 7 | maintainer@emeraldcoastsystemsgroup.com | Declare the bound-workflow-results compatibility floor so older runtimes refuse workflows requiring durable evidence/result bindings.
 * 8 | maintainer@emeraldcoastsystemsgroup.com | Declare the immutable Futures forward receipt compatibility floor for matching console packages.
 * 9 | maintainer@emeraldcoastsystemsgroup.com | Declare confirmed archive imports so older cores refuse console packages without the shared-write approval boundary.
 * 10 | maintainer@emeraldcoastsystemsgroup.com | ADR-045: declare the world-data engine and every module imported by the World package as a kernel skill, so package compatibility and build-artifact checks cover deep imports.
 */

/**
 * @description The ten kernel skills signed off for Tier-0b (swarm-store-migration-plan §2).
 *
 * A **skill** is a capability with a provider abstraction and no domain of its own — it exists
 * to make a vendor swappable. An **app** is a domain plus a surface. Apps declare `uses:` and
 * CALL a skill; they never bundle or own one.
 */
export type KernelSkillId =
  | 'voice'
  | 'notifications'
  | 'rag'
  | 'storage'
  | 'deck-generation'
  | 'graph'
  | 'scheduling'
  | 'memory'
  | 'tool-registry'
  | 'media-generation'
  | 'payments'
  | 'application-authorization'
  | 'authenticated-artifacts'
  | 'package-tools'
  | 'test-catalog'
  | 'jarvis-briefings'
  | 'app-dependencies'
  | 'specialist-context'
  | 'spatial-mapping'
  | 'google-calendar'
  | 'bound-workflow-results'
  | 'futures-forward-receipts'
  | 'futures-archive-import'
  | 'world-data';

/**
 * @description One importable module behind a skill.
 *
 * `specifier` is what a package literally writes in its route source; the mounter's `@/` alias
 * resolves it against the RUNNING framework's dist at mount time. `distFile` is the compiled
 * artifact the CI guard asserts is present in the built image — the two must stay in lockstep,
 * because a package resolves the specifier against exactly that file.
 */
export interface KernelSkillModule {
  /** The `@/…` import specifier a package writes (resolved by the mounter's runtime alias). */
  specifier: string;
  /** Path of the compiled artifact, relative to the build root (`/app` in the image). */
  distFile: string;
}

/**
 * @description A kernel skill: the stable, package-facing API the framework guarantees.
 *
 * Removing a module from a declaration is a BREAKING CHANGE for every installed package that
 * imports it — packages resolve these specifiers against the running framework's dist, so a
 * pruned module surfaces as a mount-time failure in the app, not a compile error here.
 */
export interface KernelSkillDeclaration {
  id: KernelSkillId;
  /** Operator-facing name (migration plan §2 Tier-0b table). */
  title: string;
  /** Why this is kernel and not app-owned — the rationale that survives the next carve. */
  why: string;
  /** Every module a package may import for this skill. */
  modules: KernelSkillModule[];
}

/**
 * @description The declared kernel-skill contract (ADR-085 Tier-0b, ADR-090).
 *
 * This array is load-bearing in three places at once:
 *  1. `src/app/composition/kernel-skills.ts` value-re-exports each module, which is what actually
 *     PINS it into `dist/` — `tsconfig.server.json` excludes `src/features/**`, so a feature reaches
 *     the build only via the import graph. "Core stopped calling it" must not mean "packages lose it".
 *  2. The manifest validator rejects a `uses:` naming an id absent from here (fail closed).
 *  3. `scripts/check-kernel-skills.js` asserts every `distFile` exists in the built image.
 *
 * Adding a skill: append here, add the re-export in the build anchor, document it in
 * docs/apps/kernel-skills.md. The CI guard then enforces it forever.
 */
export const KERNEL_SKILLS: readonly KernelSkillDeclaration[] = [
  { id: 'world-data', title: 'World intelligence engine',
    why: 'The shared world index feeds Jarvis and Trading as well as the World package; its engine stays in core while its surface is installed separately (ADR-045, ADR-093).',
    modules: [
      { specifier: '@/features/world-data', distFile: 'dist/features/world-data/index.js' },
      { specifier: '@/features/world-data/world-intelligence-service', distFile: 'dist/features/world-data/world-intelligence-service.js' },
      { specifier: '@/features/world-data/world-types', distFile: 'dist/features/world-data/world-types.js' },
      { specifier: '@/features/world-data/outlet-ratings', distFile: 'dist/features/world-data/outlet-ratings.js' },
      { specifier: '@/features/world-data/news-fetcher', distFile: 'dist/features/world-data/news-fetcher.js' },
    ] },
  { id: 'futures-archive-import', title: 'Confirmed Futures archive imports',
    why: 'Owner-bound content previews and explicit operator confirmation precede atomic shared reference writes.',
    modules: [{ specifier: '@/app/trading-futures-archive-import', distFile: 'dist/app/trading-futures-archive-import.js' }] },
  { id: 'futures-forward-receipts', title: 'Futures forward research receipts',
    why: 'The locked replay engine owns immutable issuance and same-contract outcome grading; the package supplies only caller-scoped controls and views.',
    modules: [{ specifier: '@/app/trading-futures-prediction-ledger', distFile: 'dist/app/trading-futures-prediction-ledger.js' }] },
  { id: 'bound-workflow-results', title: 'Bound workflow evidence and results',
    why: 'The queue validates persisted application evidence before accounted reasoning and fences validated results before ticket completion.',
    modules: [{ specifier: '@/features/swarm-orchestration', distFile: 'dist/features/swarm-orchestration/index.js' }] },
  { id: 'authenticated-artifacts', title: 'Authenticated artifact relay',
    why: 'Local artifact sources receive the original authenticated caller with current permission and registration checks.',
    modules: [{ specifier: '@/app/routes/artifact-authenticated-relay', distFile: 'dist/app/routes/artifact-authenticated-relay.js' }] },
  { id: 'package-tools', title: 'Authorized package tools',
    why: 'Fixed package handlers execute under the exact caller through an activation-scoped registration port.',
    modules: [{ specifier: '@/shared/package-tools', distFile: 'dist/shared/package-tools/index.js' }] },
  { id: 'jarvis-briefings', title: 'Jarvis briefing delivery',
    why: 'Registered application/bot sources honor exact-principal preferences and return truthful enqueue outcomes.',
    modules: [{ specifier: '@/shared/briefings', distFile: 'dist/shared/briefings/index.js' },
      { specifier: '@/app/routes/jarvis-task-store', distFile: 'dist/app/routes/jarvis-task-store.js' }],
  },
  { id: 'specialist-context', title: 'Authorized specialist facts',
    why: 'Package-owned deterministic numeric reads feed accountable specialist dispatch under the actual caller.',
    modules: [{ specifier: '@/shared/specialist-context', distFile: 'dist/shared/specialist-context/index.js' }] },
  { id: 'app-dependencies', title: 'Required and optional app dependencies',
    why: 'The installer and loader read dependencies.required/optional; naming this floor makes an older core refuse such a package instead of dropping its required dependencies.',
    modules: [{ specifier: '@/shared/app-dependencies', distFile: 'dist/shared/app-dependencies/index.js' }] },
  {
    id: 'test-catalog', title: 'Package test catalogs',
    why: 'Versioned test metadata installs with applications and remains separate from runner execution authority.',
    modules: [{ specifier: '@/shared/package-testing', distFile: 'dist/shared/package-testing/index.js' }],
  },
  {
    id: 'application-authorization', title: 'Application authorization',
    why: 'Versioned permission catalogs and actor-bound resource adapters shared by installed applications.',
    modules: [{ specifier: '@/shared/application-authorization', distFile: 'dist/shared/application-authorization/index.js' }],
  },
  {
    id: 'voice',
    title: 'TTS / STT (voice)',
    why: 'Pluggable-vendor registry — CLAUDE.md forbids hardcoding a TTS vendor. Little Monsters, Jarvis and ambient-listening all call it.',
    modules: [
      { specifier: '@/features/voice-providers', distFile: 'dist/features/voice-providers/index.js' },
      { specifier: '@/features/voice', distFile: 'dist/features/voice/index.js' },
    ],
  },
  {
    id: 'notifications',
    title: 'Notifications',
    why: 'notifyOperator / notifyAll fan-out across transports (email/Telegram/WhatsApp/Discord). Any app may notify.',
    modules: [
      { specifier: '@/features/notifications', distFile: 'dist/features/notifications/index.js' },
    ],
  },
  {
    id: 'rag',
    title: 'RAG / knowledge',
    why: 'ChromaDB abstraction with a BM25 fallback; multiple apps ground on corpora.',
    modules: [{ specifier: '@/features/rag', distFile: 'dist/features/rag/index.js' }],
  },
  {
    id: 'storage',
    title: 'Storage targets',
    why: 'Dropbox/GitHub/local abstraction (ADR-041). Carving the storage APP takes its surface only — this engine stays kernel.',
    modules: [
      { specifier: '@/app/routes/storage-target', distFile: 'dist/app/routes/storage-target.js' },
    ],
  },
  {
    id: 'deck-generation',
    title: 'Deck generation',
    why: 'The engine behind the presentations app. Little Monsters already calls it — carving presentations takes its surface only.',
    modules: [
      {
        specifier: '@/features/presentation-generation',
        distFile: 'dist/features/presentation-generation/index.js',
      },
    ],
  },
  {
    id: 'graph',
    title: 'Graph',
    why: 'Engine-agnostic graph connector (ADR-045) — swapping engines must stay a one-adapter change.',
    modules: [
      { specifier: '@/features/graph', distFile: 'dist/features/graph/index.js' },
      { specifier: '@/features/personal-graph', distFile: 'dist/features/personal-graph/index.js' },
    ],
  },
  {
    id: 'scheduling',
    title: 'Scheduling',
    why: 'Manifest `schedules:` register and tear down through it — the mechanism that killed the cron env flags.',
    modules: [{ specifier: '@/features/scheduling', distFile: 'dist/features/scheduling/index.js' }],
  },
  {
    id: 'memory',
    title: 'Memory / user model',
    why: 'Cross-app user state — the per-user store an app reads instead of re-deriving what another app already learned.',
    modules: [
      { specifier: '@/features/memory', distFile: 'dist/features/memory/index.js' },
      { specifier: '@/features/user-model', distFile: 'dist/features/user-model/index.js' },
      { specifier: '@/features/personal-data', distFile: 'dist/features/personal-data/index.js' },
    ],
  },
  {
    id: 'tool-registry',
    title: 'Tool registry + harness/LLM layer',
    why: 'The aggregation thesis itself (ADR-049) — vendor-neutral tool and model access is the platform, never an app.',
    modules: [
      { specifier: '@/features/tool-registry', distFile: 'dist/features/tool-registry/index.js' },
      { specifier: '@/features/llm-provider', distFile: 'dist/features/llm-provider/index.js' },
    ],
  },
  {
    id: 'media-generation',
    title: 'Media generation',
    why: 'Vendor-abstracted image/video generation; several apps use it.',
    modules: [
      { specifier: '@/features/video-generation', distFile: 'dist/features/video-generation/index.js' },
      { specifier: '@/features/visual-response', distFile: 'dist/features/visual-response/index.js' },
    ],
  },
  {
    id: 'payments',
    title: 'Payments (provider-agnostic money rails)',
    why: 'Vendor-swappable money movement with no domain of its own: the Stripe PaymentAdapter half (finance package) and the Square/PayPal MerchantPaymentAdapter half (payments package) both resolve it from the running dist. Pinned at the finance carve — it was anchored only by finance-routes.ts until then.',
    modules: [
      { specifier: '@/features/payments', distFile: 'dist/features/payments/index.js' },
    ],
  },
  {
    id: 'spatial-mapping',
    title: 'Spatial mapping (3D reconstruction engine)',
    why: 'The video->3D / import / sim-drone / RF-overlay reconstruction engine + owner-scoped scan store (ADR-111, ADR-093). Stays kernel while the Spaces SURFACE carves to the store; spaces-routes.ts was its last core import anchor, and — unlike drone/camera, which their *-node-server.ts pins — spaces-operator is an inline concierge with no node-server, so this pin is the only thing keeping it in dist. Same prune class as payments.',
    modules: [
      { specifier: '@/features/spatial-mapping', distFile: 'dist/features/spatial-mapping/index.js' },
    ],
  },
  {
    id: 'google-calendar',
    title: 'Google Calendar client',
    why: 'OAuth-injected Calendar v3 client; calendar store package uses it for syncing events.',
    modules: [
      { specifier: '@/features/google-calendar', distFile: 'dist/features/google-calendar/index.js' },
    ],
  },
];

/** @description Every declared skill id, for fast membership tests. */
export const KERNEL_SKILL_IDS: ReadonlySet<string> = new Set(KERNEL_SKILLS.map((s) => s.id));

/**
 * @description Narrow an arbitrary manifest string to a declared kernel-skill id.
 *
 * Used by the manifest validator to fail closed: an app may only `uses:` a skill the kernel
 * actually promises. A typo becomes a load-time error instead of a mount-time crash.
 *
 * @param value - The candidate id from a manifest's `uses:` list.
 * @returns True when the kernel declares a skill under this id.
 */
export function isKernelSkillId(value: string): value is KernelSkillId {
  return KERNEL_SKILL_IDS.has(value);
}
