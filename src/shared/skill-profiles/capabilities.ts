/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-090 addendum (skill profiles): the closed set of PROFILEABLE CAPABILITIES — named things an accountable bot DOES (starting with `summarize`) that an app can teach a domain pattern. Deliberately a SEPARATE registry from KERNEL_SKILLS: a kernel skill is an importable code module guarded by a distFile-exists CI check, whereas a capability is bot reasoning (ADR-036) with no module — putting `summarize` in KERNEL_SKILLS would fail that guard. Keys of manifest `skillProfiles:` validate against THIS list.
 */

/**
 * @description A profileable capability id — a named thing an accountable bot DOES that an app
 * can parameterize with a domain pattern (ADR-090 skill profiles). This is NOT a `KernelSkillId`:
 * kernel skills are importable code modules the framework pins into `dist/` and guards with a
 * distFile check; a capability is LLM reasoning that always runs on the bot (ADR-036) and has no
 * module to import. The two vocabularies are intentionally disjoint.
 *
 * Starts with `summarize`; grows as other bot capabilities earn a declarable domain pattern.
 */
export type SkillCapabilityId = 'summarize';

/**
 * @description One profileable capability: the stable name an app's `skillProfiles:` key must
 * match, plus operator-facing metadata. No `distFile` — a capability is not a module (that is the
 * whole reason it lives here and not in `KERNEL_SKILLS`).
 */
export interface SkillCapabilityDeclaration {
  /** The id an app writes as a `skillProfiles:` key. */
  id: SkillCapabilityId;
  /** Operator-facing name. */
  title: string;
  /** Why this is a profileable capability rather than a kernel module. */
  why: string;
}

/**
 * @description The closed set of profileable capabilities (ADR-090 skill profiles).
 *
 * Adding one is a deliberate edit here + an ADR-090 note — never a manifest-side invention, same
 * discipline as `SWARM_APP_SUITES` and `KERNEL_SKILL_IDS`. The manifest loader validates every
 * `skillProfiles:` key against this list, fail-closed.
 */
export const SKILL_CAPABILITIES: readonly SkillCapabilityDeclaration[] = [
  {
    id: 'summarize',
    title: 'Summarization',
    why: 'Turning source content (a transcript, a thread, a document) into a domain-shaped summary is bot reasoning — cost lands in chat_tasks on the accountable node (ADR-036). The engine is generic; what a "good summary" IS differs per app (class notes vs meeting notes vs exec-quarterly), so the app supplies the pattern.',
  },
];

/** @description The capability ids, for iteration + fail-closed validation messages. */
export const SKILL_CAPABILITY_IDS: readonly SkillCapabilityId[] = SKILL_CAPABILITIES.map(
  (c) => c.id,
);

/**
 * @description Type guard: is `value` a known profileable capability id? Used by the manifest
 * loader to reject a typo'd `skillProfiles:` key at load rather than at dispatch.
 * @param value - candidate capability id from a parsed manifest.
 * @returns true when `value` is a member of the closed capability set.
 */
export function isSkillCapabilityId(value: unknown): value is SkillCapabilityId {
  return typeof value === 'string' && (SKILL_CAPABILITY_IDS as readonly string[]).includes(value);
}
