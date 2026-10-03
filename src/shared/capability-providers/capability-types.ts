/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1: the vocabulary every capability resolution shares. Four capabilities (tts, stt, image, video), three cost classes (D4), the five rungs of the resolution order (D1), the principal every call carries (D8), a swarm row (D2, migration 183), a provider declaration, the availability answer that names the missing piece (D3), and the adapter each capability supplies so one resolver serves all four. Bottom layer on purpose: the voice and media features both resolve through the same rule, and the app layer installs the rows they read.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 D10 (round 2): CapabilityResolveRequest.requested, a provider the request names (the body of POST /api/voice/synthesize). Unlike `explicit` (server code: required), it is a preference that falls through to the next rung under D5 when it is not registered or not available. A change from main for that route, where only an unregistered requested provider fell back to the swarm default, and a registered one that was not usable was called and returned its own unconfigured or failed result.
 */

/**
 * @description Shared types for "capability providers resolve per user" (ADR-173).
 * @module shared/capability-providers/capability-types
 */

/** The four capabilities ADR-173 resolves through one order. */
export const CAPABILITIES = Object.freeze(['tts', 'stt', 'image', 'video'] as const);

/** One capability: text to speech, speech to text, image or video. */
export type Capability = (typeof CAPABILITIES)[number];

/**
 * The three payers a provider can declare (ADR-173 D4): nobody (on-host, in the browser, or a
 * subscription already paid), the swarm's own vendor credential, or the caller's own credential.
 */
export const CAPABILITY_COST_CLASSES = Object.freeze(['free', 'swarm-paid', 'user-paid'] as const);

/** Who pays for one provider's call. */
export type CapabilityCostClass = (typeof CAPABILITY_COST_CLASSES)[number];

/** The rungs of the resolution order (ADR-173 D1), top to bottom; rung 5 is the refusal. */
export const CAPABILITY_RUNGS = Object.freeze(['app', 'user-bot', 'bot-row', 'user-default', 'swarm-default'] as const);

/** The rung that answered a resolution. */
export type CapabilityRung = (typeof CAPABILITY_RUNGS)[number];

/** The reserved swarm scope whose row is the swarm default ("Portal default" to users). */
export const CAPABILITY_FLEET_SCOPE = 'fleet-default';

/**
 * The identity a capability call is made for (ADR-173 D8). A signed-in person (a guest included),
 * the system itself (scheduled or swarm-owned work, which resolves operator-written rungs only), or
 * a legacy caller that named no one, which resolves exactly like the system and is logged so S4 can
 * move it.
 */
export type CapabilityPrincipal =
  | { kind: 'user'; sub: string; isOperator: boolean; isGuest: boolean }
  | { kind: 'system'; reason: string }
  | { kind: 'unattributed'; reason: string };

/** A provider and, for text to speech, the voice that belongs to it (D9 keeps them together). */
export interface CapabilityChoice {
  providerId: string;
  /** The voice id inside that provider; meaningful only beside its own provider. */
  voice?: string | null;
  /** An optional model inside that provider. */
  model?: string | null;
}

/** The options a swarm row may carry beside its provider. Never a secret. */
export interface CapabilityRowOptions {
  voice?: string;
  model?: string;
}

/** One row of oshal_capability_swarm_rows (migration 183). */
export interface CapabilitySwarmRow {
  /** {@link CAPABILITY_FLEET_SCOPE}, or an agent id (the bot rung, read from S3). */
  scopeId: string;
  capability: Capability;
  providerId: string;
  options: CapabilityRowOptions;
  updatedBy: string | null;
  updatedAt: string | null;
}

/** One registered provider of one capability, as its feature declares it. */
export interface CapabilityProviderDeclaration {
  capability: Capability;
  providerId: string;
  displayName: string;
  /** Who pays; null when the provider declares none, which makes it unavailable (fail closed). */
  costClass: CapabilityCostClass | null;
  /** Text to speech: the voice a rung that names no voice of its own lands on (D9). */
  defaultVoice?: string | null;
}

/**
 * The piece that is missing when a provider cannot serve this caller now (ADR-173 D3), or why a
 * resolution refused. Each is a separate fact, checked cheapest first.
 */
export type CapabilityMissingPiece =
  | 'not-registered'
  | 'no-cost-class'
  | 'no-credential'
  | 'not-permitted'
  | 'health-check-failed'
  | 'no-swarm-default'
  | 'payer-changes'
  | 'rows-not-loaded'
  | 'no-principal';

/** "May this caller use this provider now?" — and when not, what is missing. */
export interface CapabilityAvailability {
  providerId: string;
  available: boolean;
  missing: CapabilityMissingPiece | null;
  /** A sentence naming the cause, for a surface to show; empty when available. */
  detail: string;
}

/** Credentials a caller hands in for a user-paid provider (Vertex today). Never logged. */
export interface CapabilityCallerCredentials {
  vertexToken?: string;
}

/** What the swarm default is when no row exists: the provider the file or selector names today. */
export type CapabilitySeedDefault =
  | { choice: CapabilityChoice; source: string }
  | { choice: null; source: string; reason: string };

/**
 * What one capability supplies so the shared resolver can serve it: its declarations, its ONE
 * availability function (used by the options list and the resolver alike, D3), its seed default,
 * and for text to speech the voices a provider lists (D9).
 */
export interface CapabilityAdapter {
  readonly capability: Capability;
  /** Every registered provider of this capability, in registration order. */
  declarations(): CapabilityProviderDeclaration[];
  /**
   * May this caller use this provider now? Registered, a credential this caller may use, policy,
   * then a cheap health probe where one exists — and the missing piece when not.
   */
  availability(
    providerId: string,
    principal: CapabilityPrincipal,
    credentials?: CapabilityCallerCredentials,
  ): Promise<CapabilityAvailability>;
  /** The swarm default with no row: what the file or the selector names today. */
  seedSwarmDefault(): Promise<CapabilitySeedDefault>;
  /**
   * The voice ids a provider lists, or null when it cannot enumerate them server-side (the browser
   * engine). Present only for text to speech.
   */
  listVoiceIds?(providerId: string): Promise<string[] | null>;
}

/** One provider as the options list shows it: its declaration and its availability for the caller. */
export interface CapabilityOption extends CapabilityProviderDeclaration, CapabilityAvailability {}

/** A rung that was tried and skipped on the way down, and why. */
export interface CapabilitySkippedRung {
  rung: CapabilityRung;
  providerId: string;
  missing: CapabilityMissingPiece | null;
  detail: string;
}

/** A resolution that found a provider. */
export interface CapabilityResolved {
  ok: true;
  capability: Capability;
  providerId: string;
  rung: CapabilityRung;
  /** Where the answering rung's setting came from: 'explicit', 'request', 'user', 'row' or the seed's source. */
  source: string;
  costClass: CapabilityCostClass;
  /** Text to speech: the voice to send, always one the landing provider lists (D9), or null. */
  voice: string | null;
  model: string | null;
  skipped: CapabilitySkippedRung[];
}

/** A resolution that refused (rung 5), naming what is missing. */
export interface CapabilityRefused {
  ok: false;
  capability: Capability;
  rung: 'refused';
  missing: CapabilityMissingPiece;
  detail: string;
  skipped: CapabilitySkippedRung[];
}

/** The answer of one resolution. */
export type CapabilityResolution = CapabilityResolved | CapabilityRefused;

/** The swarm rows a resolution reads, from the installed snapshot or a test double. */
export interface CapabilitySwarmRowReader {
  /** Whether a snapshot is installed, and whether it has completed one read. */
  state(): { installed: boolean; loaded: boolean };
  /** The row for one scope and capability, or null. */
  rowFor(scopeId: string, capability: Capability): CapabilitySwarmRow | null;
}

/**
 * Who a call is for, the application making it and the bot accountable for it (ADR-173 D8). Every
 * key is required: an application or a bot may be null, the principal may not.
 */
export interface CapabilityCaller {
  principal: CapabilityPrincipal;
  appId: string | null;
  agentId: string | null;
}

/** One resolution request. */
export interface CapabilityResolveRequest extends CapabilityCaller {
  capability: Capability;
  /**
   * A provider the calling code names itself: a required preference (D10). It is used when
   * available and refused otherwise; it never falls through to another provider.
   */
  explicit?: CapabilityChoice | null;
  /**
   * A provider the request names (a client's choice, such as the `providerId` in the body of
   * `POST /api/voice/synthesize`): a preference (D10's default). It is used when available; when it
   * is not registered or not available the walk falls through to the next rung under D5 (so a free
   * one is refused with `payer-changes` rather than land on a paid one), and a warning names the
   * provider and the reason. Ignored when `explicit` is set.
   */
  requested?: CapabilityChoice | null;
  /** Rung 3: the caller's own default, read by the route that knows the user. */
  userDefault?: CapabilityChoice | null;
  /**
   * Text to speech: a voice the caller asked for without naming a provider. It is sent only to a
   * landing provider that lists it (D9); otherwise it is dropped.
   */
  voiceHint?: string | null;
  /** Credentials the caller hands in for a user-paid provider. */
  credentials?: CapabilityCallerCredentials;
}

/**
 * @description Narrow an unknown value to a capability id.
 * @param value - A value from a URL, a body or a row.
 * @returns True when it is one of the four capabilities.
 */
export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value);
}

/**
 * @description Narrow an unknown value to a cost class.
 * @param value - A declared class.
 * @returns True when it is one of the three classes.
 */
export function isCapabilityCostClass(value: unknown): value is CapabilityCostClass {
  return typeof value === 'string' && (CAPABILITY_COST_CLASSES as readonly string[]).includes(value);
}
