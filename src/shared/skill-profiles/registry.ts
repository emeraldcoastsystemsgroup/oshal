/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-090 addendum (skill profiles): the shared in-memory registry an app writes on activate / clears on deactivate (modeled on guest-capability-matrix), plus the pure prompt-composer the dispatch path uses. Lives in shared/ so the WRITER (features/swarm-apps) and the READER (features/swarm-orchestration dispatch) both reach it top-down without an @/app port. Resolution is CONTROLLER-side: the bot node is a separate container with no registry, so the resolved pattern travels to it as prompt TEXT — no kernel LLM call, cost stays on the bot (ADR-036).
 */

import { createChildLogger } from '@/shared/logger';
import type { SkillCapabilityId } from './capabilities';

const logger = createChildLogger({ module: 'skill-profiles' });

/**
 * @description One app's domain pattern for a profileable capability (ADR-090 skill profiles).
 *
 * This is the app-owned content that rides a kernel-owned capability. `pattern` is the domain
 * LABEL (e.g. `class-notes`, `meeting-notes`); `instructions` is the substance — the guidance the
 * accountable bot follows so the same capability yields domain-appropriate output. A profile with
 * a label but no guidance is a no-op stub and is rejected at manifest load.
 */
export interface SkillProfile {
  /** Domain label for the profile — e.g. `class-notes`, `meeting-notes`. Required, non-empty. */
  pattern: string;
  /** The domain guidance the bot follows (what to extract, tone, audience). Required, non-empty. */
  instructions: string;
  /** Optional ordered output sections the result should contain. */
  sections?: string[];
  /** Optional free-form output-shape note (format, destination). */
  outputContract?: string;
}

/** @description A map from capability id to the app's profile for that capability. */
export type SkillProfileMap = Partial<Record<SkillCapabilityId, SkillProfile>>;

/**
 * @description A registered app's profiles plus the routing keys used to resolve them at dispatch.
 */
interface RegisteredSkillProfiles {
  appName: string;
  /** The manifest's ticketType, when it declares one — the dispatch path resolves by this. */
  ticketType?: string;
  profiles: SkillProfileMap;
}

/**
 * Keyed by appName so re-activate REPLACES (idempotent) and deactivate/uninstall drops the app's
 * whole entry in one delete — full teardown, no per-key bookkeeping, no ticketType side-map to
 * fall out of sync (dispatch resolution scans this small map by ticketType instead).
 */
const BY_APP = new Map<string, RegisteredSkillProfiles>();

/**
 * @description Register (or replace) an app's skill profiles. Called from swarm-app activate().
 * Idempotent: a re-activate replaces the prior entry for the same appName.
 * @param entry - the app name, its optional ticketType, and its capability→profile map.
 */
export function registerAppSkillProfiles(entry: RegisteredSkillProfiles): void {
  if (!entry.appName || !entry.profiles || Object.keys(entry.profiles).length === 0) return;
  BY_APP.set(entry.appName, {
    appName: entry.appName,
    ticketType: entry.ticketType,
    profiles: entry.profiles,
  });
  logger.info(
    { app: entry.appName, ticketType: entry.ticketType ?? null, capabilities: Object.keys(entry.profiles) },
    'Registered app skill profiles',
  );
}

/**
 * @description Retract an app's skill profiles (deactivate / uninstall). Idempotent — a toggled-off
 * app must hold zero live profiles, so this drops the whole entry.
 * @param appName - the app whose profiles to clear.
 */
export function unregisterAppSkillProfiles(appName: string): void {
  if (BY_APP.delete(appName)) {
    logger.info({ app: appName }, 'Retracted app skill profiles');
  }
}

/**
 * @description Resolve an app's profile for a capability by app name (the interactive path knows
 * the app directly).
 * @param appName - the calling app.
 * @param capabilityId - the capability being performed.
 * @returns the profile, or null when the app declares none for that capability.
 */
export function resolveSkillProfileByApp(
  appName: string,
  capabilityId: SkillCapabilityId,
): SkillProfile | null {
  return BY_APP.get(appName)?.profiles[capabilityId] ?? null;
}

/**
 * @description Resolve a profile for a capability by ticketType (the dispatch path has the
 * workflow's ticketType, not the app name, in hand). Scans the small app map — there is no
 * ticketType side-index to keep consistent through teardown.
 * @param ticketType - the dispatched ticket's type (== a manifest's declared ticketType).
 * @param capabilityId - the capability being performed.
 * @returns the profile, or null when no active app owns that ticketType / declares that profile.
 */
export function resolveSkillProfileByTicketType(
  ticketType: string,
  capabilityId: SkillCapabilityId,
): SkillProfile | null {
  if (!ticketType) return null;
  for (const entry of BY_APP.values()) {
    if (entry.ticketType === ticketType) return entry.profiles[capabilityId] ?? null;
  }
  return null;
}

/**
 * @description The registered apps' profiles, for the capability snapshot + tests. Returns the
 * internal map typed read-only (same convention as `approvedAppGuestTiers` in
 * guest-capability-matrix) — callers must not mutate it.
 * @returns a read-only view of the appName → { ticketType, profiles } registry.
 */
export function registeredSkillProfileApps(): ReadonlyMap<string, { ticketType?: string; profiles: SkillProfileMap }> {
  return BY_APP;
}

/**
 * @description Compose an app's domain pattern into a base prompt, as a clearly-delimited block the
 * accountable bot reads. PURE — no I/O, no LLM call; the caller sends the returned text to the bot,
 * which does the reasoning (ADR-036). Returns `baseText` unchanged when `profile` is null so callers
 * can inject unconditionally.
 * @param baseText - the prompt the bot would otherwise run (ticket header + content).
 * @param capabilityId - the capability the profile shapes (labels the injected block).
 * @param profile - the resolved app profile, or null for a no-op.
 * @returns baseText with the profile appended as a delimited instruction block.
 */
export function composeSkillProfilePrompt(
  baseText: string,
  capabilityId: SkillCapabilityId,
  profile: SkillProfile | null,
): string {
  if (!profile) return baseText;
  const lines: string[] = [
    ``,
    `---`,
    ``,
    `### Apply the "${profile.pattern}" ${capabilityId} profile`,
    ``,
    `This app has declared a domain pattern for ${capabilityId}. Follow it so the result fits the`,
    `app's domain rather than a generic ${capabilityId}:`,
    ``,
    profile.instructions.trim(),
  ];
  if (profile.sections && profile.sections.length > 0) {
    lines.push('', `Organize the output into these sections, in order: ${profile.sections.join(', ')}.`);
  }
  if (profile.outputContract && profile.outputContract.trim()) {
    lines.push('', `Output shape: ${profile.outputContract.trim()}`);
  }
  return `${baseText}\n${lines.join('\n')}`;
}
