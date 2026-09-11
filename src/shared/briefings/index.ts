/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Declare discoverable application/bot briefing sources and closed user delivery preferences.
 */
import { z } from 'zod';

/** @description Channels implemented by the current Jarvis browser surface. */
export const BriefingChannelSchema = z.enum(['voice', 'bubble', 'screen']);
/** @description Announcement cadence, independent of the owning application's collection schedule. */
export const BriefingFrequencySchema = z.enum(['as-available', 'hourly', 'daily', 'weekly']);
/** @description Closed caller preference payload; identity and source ownership are server-owned. */
export const BriefingPreferenceSchema = z.object({
  enabled: z.boolean(), frequency: BriefingFrequencySchema, channel: BriefingChannelSchema,
}).strict();
/** @description A validated per-principal source preference. */
export type BriefingPreference = z.infer<typeof BriefingPreferenceSchema>;
/** @description Preserve eligible legacy source delivery when the caller has never saved preferences. */
export const DEFAULT_BRIEFING_PREFERENCE: Readonly<BriefingPreference> = Object.freeze({ enabled: true, frequency: 'as-available', channel: 'voice' });
/** @description Minimum milliseconds between successful source announcement claims. */
export const BRIEFING_INTERVALS: Readonly<Record<BriefingPreference['frequency'], number>> = {
  'as-available': 0, hourly: 3_600_000, daily: 86_400_000, weekly: 604_800_000,
};
/** @description Strict package metadata for a real source and its reserved producer session. */
export const BriefingDeclarationSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  sessionId: z.string().regex(/^[a-z][a-z0-9-]{2,99}$/),
  botAgentId: z.string().uuid().optional(),
  defaults: BriefingPreferenceSchema.optional(),
}).strict();
/** @description Validated manifest source metadata. */
export type BriefingDeclaration = z.infer<typeof BriefingDeclarationSchema>;
/** @description Metadata qualified by the framework's owning application and active version. */
export interface RegisteredBriefingSource extends BriefingDeclaration {
  sourceId: string; app: string; version: string;
}
/** @description Activation port; unregister must retract local availability before its first await. */
export interface ManifestBriefingRegistrar {
  register(app: string, version: string, sources: readonly BriefingDeclaration[]): Promise<void>;
  unregister(app: string): Promise<void>;
}

/**
 * @description Require executable owned sources; catalog-backed data needs a concrete owned bot authorization binding.
 * @param value - Manifest briefing declarations to validate.
 * @param botIds - Bot IDs owned by the same package.
 * @param catalogBacked - Whether the package declares an authorization catalog.
 * @returns Validated closed declarations; invalid ownership or unsupported unbound catalog sources throw.
 */
export function validateBriefingDeclarations(value: unknown, botIds: readonly string[] = [], catalogBacked = false): BriefingDeclaration[] {
  const declarations = z.array(BriefingDeclarationSchema).max(32).parse(value ?? []);
  const ids = new Set<string>(), sessions = new Set<string>();
  for (const source of declarations) {
    if (ids.has(source.id) || sessions.has(source.sessionId)) throw new Error('Briefing source ids and sessions must be unique');
    if (source.botAgentId && !botIds.includes(source.botAgentId)) throw new Error('Briefing bot must belong to the declaring application');
    if (catalogBacked && !source.botAgentId) throw new Error('Catalog-backed briefing source requires an owned bot authorization binding');
    ids.add(source.id); sessions.add(source.sessionId);
  }
  return declarations;
}
