/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1: the one resolver the four capabilities share. It requires a principal (D8) and refuses without one; walks the rungs that exist today — a provider the calling code names itself (a required preference, D10), the caller's own default (rung 3, the existing text-to-speech saved choice until S2), the swarm default (rung 4: the operator's row, else the provider the file or selector names today, D6) — and refuses at rung 5 naming the missing piece. A rung is used only when its provider is available to this caller, asked through the capability's ONE availability function, the same one the options list asks (D3). A skip never lands on a different payer (D5): the landing provider must be free or bill the same payer as every provider skipped on the way down. A text-to-speech voice travels only with its own provider and only when that provider lists it; otherwise the landing provider's default voice is used (D9). The bot rungs (S3) and the application block (S4) slot in above the user default without changing this walk. Every resolution writes one log line naming the rung that answered.
 */

/**
 * @description The shared capability resolver and options list (ADR-173 D1, D3, D5, D8, D9).
 * @module shared/capability-providers/capability-resolution
 */

import { createChildLogger } from '@/shared/logger';
import { describeCapabilityPrincipal, isCapabilityPrincipal } from './capability-principal';
import { installedCapabilityRowReader } from './capability-row-snapshot';
import {
  CAPABILITY_FLEET_SCOPE,
  type CapabilityAdapter,
  type CapabilityAvailability,
  type CapabilityCallerCredentials,
  type CapabilityChoice,
  type CapabilityCostClass,
  type CapabilityMissingPiece,
  type CapabilityOption,
  type CapabilityPrincipal,
  type CapabilityProviderDeclaration,
  type CapabilityRefused,
  type CapabilityResolution,
  type CapabilityResolveRequest,
  type CapabilityRung,
  type CapabilitySkippedRung,
  type CapabilitySwarmRow,
  type CapabilitySwarmRowReader,
} from './capability-types';

const logger = createChildLogger({ module: 'capability-resolution' });

/** One rung with a setting, ready to be tried. */
interface Candidate {
  rung: CapabilityRung;
  choice: CapabilityChoice;
  source: string;
  /** A required preference is used or refused; it never falls through (D10). */
  required: boolean;
}

/** What the walk carries from rung to rung. */
interface WalkState {
  skipped: CapabilitySkippedRung[];
  /** Cost classes of the providers skipped so far (registered ones only). */
  skippedClasses: Array<{ providerId: string; rung: CapabilityRung; costClass: CapabilityCostClass }>;
}

/** Collaborators a resolution may be given; the defaults are the installed ones. */
export interface CapabilityResolveDeps {
  rows?: CapabilitySwarmRowReader;
}

/** The swarm default as the operator route reports it: the row, else the seed. */
export interface CapabilitySwarmDefaultView {
  capability: CapabilityAdapter['capability'];
  providerId: string | null;
  voice: string | null;
  model: string | null;
  /** 'row' when the operator wrote one, else where the seed came from (the file, the selector). */
  source: string;
  row: CapabilitySwarmRow | null;
  /** Why there is no swarm default, when there is none. */
  reason: string | null;
  rowsLoaded: boolean;
}

/**
 * @description A refusal, logged as the rung-5 answer.
 * @returns The refusal.
 */
function refuse(
  capability: CapabilityRefused['capability'],
  missing: CapabilityMissingPiece,
  detail: string,
  skipped: CapabilitySkippedRung[],
): CapabilityRefused {
  return { ok: false, capability, rung: 'refused', missing, detail, skipped };
}

/**
 * @description The declarations of one adapter, keyed by provider id.
 * @param adapter - The capability adapter.
 * @returns A map from provider id to its declaration.
 */
function declarationMap(adapter: CapabilityAdapter): Map<string, CapabilityProviderDeclaration> {
  return new Map(adapter.declarations().map((declaration) => [declaration.providerId, declaration]));
}

/**
 * @description The swarm-default candidate: the operator's row, else the seed — or the refusal
 * when the installed rows have never loaded or nothing names a default.
 * @param adapter - The capability adapter.
 * @param rows - The swarm row reader.
 * @returns The candidate, or why there is none.
 */
async function swarmDefaultCandidate(
  adapter: CapabilityAdapter,
  rows: CapabilitySwarmRowReader,
): Promise<{ candidate: Candidate } | { missing: CapabilityMissingPiece; detail: string }> {
  const state = rows.state();
  if (state.installed && !state.loaded) {
    return { missing: 'rows-not-loaded', detail: `The swarm ${adapter.capability} rows have not been read since the api started; retry shortly.` };
  }
  const row = rows.rowFor(CAPABILITY_FLEET_SCOPE, adapter.capability);
  if (row) {
    return { candidate: { rung: 'swarm-default', source: 'row', required: false,
      choice: { providerId: row.providerId, voice: row.options.voice ?? null, model: row.options.model ?? null } } };
  }
  const seed = await adapter.seedSwarmDefault();
  if (!seed.choice) return { missing: 'no-swarm-default', detail: seed.reason };
  return { candidate: { rung: 'swarm-default', source: seed.source, required: false, choice: seed.choice } };
}

/** @description A voice id as a trimmed string, or null. */
function cleanVoice(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * @description The voice to send with the landing provider (D9). In order: the voice the caller
 * asked for without naming a provider, the landing rung's own voice, then the provider's default
 * voice — the first one the landing provider lists. A provider that cannot enumerate voices on the
 * server (the browser engine) takes the first voice asked for. Never a voice the provider did not
 * list, and never a voice that belonged to a provider the walk skipped.
 * @param adapter - The capability adapter.
 * @param declaration - The landing provider's declaration.
 * @param choice - The landing rung's own choice.
 * @param voiceHint - A voice the caller asked for without naming a provider, or null.
 * @returns The voice id, or null.
 */
async function voiceFor(
  adapter: CapabilityAdapter,
  declaration: CapabilityProviderDeclaration,
  choice: CapabilityChoice,
  voiceHint: string | null,
): Promise<string | null> {
  if (adapter.capability !== 'tts') return null;
  const asked = [cleanVoice(voiceHint), cleanVoice(choice.voice)].filter((voice): voice is string => voice !== null);
  const listed = adapter.listVoiceIds ? await adapter.listVoiceIds(declaration.providerId) : null;
  if (listed === null) return asked[0] ?? cleanVoice(declaration.defaultVoice);
  const usable = [...asked, cleanVoice(declaration.defaultVoice)].find((voice) => voice !== null && listed.includes(voice));
  if (asked.length && usable !== asked[0]) {
    logger.warn({ providerId: declaration.providerId, dropped: asked.filter((voice) => voice !== usable) },
      'A voice the landing provider does not list was dropped (ADR-173 D9)');
  }
  return usable ?? null;
}

/**
 * @description D5: the provider a skip lands on must be free, or bill the same payer as every
 * provider skipped on the way down. Returns the conflict, or null when the landing is allowed.
 * @param landing - The landing provider's id and class.
 * @param state - The walk so far.
 * @returns A sentence naming the conflict, or null.
 */
function payerConflict(landing: { providerId: string; costClass: CapabilityCostClass }, state: WalkState): string | null {
  if (landing.costClass === 'free') return null;
  const conflict = state.skippedClasses.find((skipped) => skipped.costClass !== landing.costClass);
  if (!conflict) return null;
  return `${landing.providerId} is ${landing.costClass}, but ${conflict.providerId} on the ${conflict.rung} rung was `
    + `${conflict.costClass}; a skip never lands on a different payer (ADR-173 D5)`;
}

/**
 * @description Try one candidate: resolved, skipped, or (for a required one, or a payer change) refused.
 * @returns The resolution when this candidate settles the call; null to try the next rung.
 */
async function tryCandidate(
  adapter: CapabilityAdapter,
  declarations: Map<string, CapabilityProviderDeclaration>,
  candidate: Candidate,
  request: CapabilityResolveRequest,
  state: WalkState,
): Promise<CapabilityResolution | null> {
  const availability = await adapter.availability(candidate.choice.providerId, request.principal, request.credentials);
  const declaration = declarations.get(candidate.choice.providerId);
  if (availability.available && declaration?.costClass) {
    const conflict = payerConflict({ providerId: declaration.providerId, costClass: declaration.costClass }, state);
    if (conflict) return refuse(adapter.capability, 'payer-changes', conflict, state.skipped);
    return {
      ok: true, capability: adapter.capability, providerId: declaration.providerId, rung: candidate.rung,
      source: candidate.source, costClass: declaration.costClass,
      voice: await voiceFor(adapter, declaration, candidate.choice, request.voiceHint ?? null),
      model: candidate.choice.model ?? null,
      skipped: state.skipped,
    };
  }
  const missing = availability.available ? 'no-cost-class' : availability.missing ?? 'not-registered';
  const detail = availability.available ? `${candidate.choice.providerId} declares no cost class` : availability.detail;
  state.skipped.push({ rung: candidate.rung, providerId: candidate.choice.providerId, missing, detail });
  if (declaration?.costClass) {
    state.skippedClasses.push({ providerId: declaration.providerId, rung: candidate.rung, costClass: declaration.costClass });
  }
  if (candidate.required) return refuse(adapter.capability, missing, detail, state.skipped);
  return null;
}

/**
 * @description Write the one log line a resolution produces (the live proof reads it).
 * @param request - The request.
 * @param resolution - Its answer.
 * @param durationMs - How long it took.
 * @returns void
 */
function logResolution(request: CapabilityResolveRequest, resolution: CapabilityResolution, durationMs: number): void {
  const fields = {
    capability: request.capability, appId: request.appId, agentId: request.agentId,
    ...describeCapabilityPrincipal(request.principal),
    skipped: resolution.skipped.map((s) => `${s.rung}:${s.providerId}:${s.missing}`), durationMs,
  };
  if (resolution.ok) {
    logger.info({ ...fields, providerId: resolution.providerId, rung: resolution.rung, source: resolution.source,
      costClass: resolution.costClass, voice: resolution.voice }, 'capability provider resolved');
  } else {
    logger.warn({ ...fields, rung: 'refused', missing: resolution.missing, detail: resolution.detail }, 'capability provider refused');
  }
}

/**
 * @description The rungs above the swarm default that this request carries: an explicit provider
 * (required, and then the only rung), else the caller's own default for a signed-in person.
 * @param request - The request.
 * @returns The candidates, top first.
 */
function upperCandidates(request: CapabilityResolveRequest): Candidate[] {
  if (request.explicit?.providerId) {
    return [{ rung: 'app', source: 'explicit', required: true, choice: request.explicit }];
  }
  if (request.principal.kind === 'user' && request.userDefault?.providerId) {
    return [{ rung: 'user-default', source: 'user', required: false, choice: request.userDefault }];
  }
  return [];
}

/**
 * @description Resolve the provider for one capability call (ADR-173 D1). Requires a principal
 * (D8): a call without one is refused before any rung is read.
 * @param adapter - The capability's adapter (declarations, availability, seed).
 * @param request - The call: capability, principal, application, bot, and any explicit or user choice.
 * @param deps - The swarm row reader (default: the installed snapshot).
 * @returns The provider with the rung that answered, or a refusal naming what is missing.
 * @throws Error when the adapter serves a different capability than the request names.
 */
export async function resolveCapabilityProvider(
  adapter: CapabilityAdapter,
  request: CapabilityResolveRequest,
  deps: CapabilityResolveDeps = {},
): Promise<CapabilityResolution> {
  if (adapter.capability !== request.capability) {
    throw new Error(`capability adapter mismatch: ${adapter.capability} adapter asked to resolve ${request.capability}`);
  }
  const startedAt = Date.now();
  if (!isCapabilityPrincipal(request.principal)) {
    logger.error({ capability: request.capability, appId: request.appId ?? null, agentId: request.agentId ?? null },
      'capability resolution called without a principal — refused (ADR-173 D8)');
    return refuse(request.capability, 'no-principal', 'This call did not say whose it is; every capability call carries its principal (ADR-173 D8).', []);
  }
  const resolution = await walkRungs(adapter, request, deps.rows ?? installedCapabilityRowReader());
  logResolution(request, resolution, Date.now() - startedAt);
  return resolution;
}

/**
 * @description The rung walk behind {@link resolveCapabilityProvider}.
 * @returns The resolution.
 */
async function walkRungs(
  adapter: CapabilityAdapter,
  request: CapabilityResolveRequest,
  rows: CapabilitySwarmRowReader,
): Promise<CapabilityResolution> {
  const declarations = declarationMap(adapter);
  const state: WalkState = { skipped: [], skippedClasses: [] };
  const upper = upperCandidates(request);
  for (const candidate of upper) {
    const settled = await tryCandidate(adapter, declarations, candidate, request, state);
    if (settled) return settled;
  }
  const swarm = await swarmDefaultCandidate(adapter, rows);
  if (!('candidate' in swarm)) return refuse(adapter.capability, swarm.missing, swarm.detail, state.skipped);
  const settled = await tryCandidate(adapter, declarations, swarm.candidate, request, state);
  if (settled) return settled;
  const last = state.skipped[state.skipped.length - 1];
  return refuse(adapter.capability, last?.missing ?? 'not-registered', last?.detail ?? 'No rung named an available provider.', state.skipped);
}

/**
 * @description The options list for one capability and caller: every registered provider with its
 * cost class and its availability, from the SAME availability function the resolver asks (D3).
 * @param adapter - The capability adapter.
 * @param principal - The caller.
 * @param credentials - Credentials the caller hands in, if any.
 * @returns The options in registration order.
 */
export async function listCapabilityOptions(
  adapter: CapabilityAdapter,
  principal: CapabilityPrincipal,
  credentials?: CapabilityCallerCredentials,
): Promise<CapabilityOption[]> {
  const options: CapabilityOption[] = [];
  for (const declaration of adapter.declarations()) {
    const availability: CapabilityAvailability = await adapter.availability(declaration.providerId, principal, credentials);
    options.push({ ...declaration, ...availability });
  }
  return options;
}

/**
 * @description The swarm default as it stands: the operator's row, else the seed, else why none.
 * @param adapter - The capability adapter.
 * @param rows - The swarm row reader (default: the installed snapshot).
 * @returns The view the operator route reports.
 */
export async function describeCapabilitySwarmDefault(
  adapter: CapabilityAdapter,
  rows: CapabilitySwarmRowReader = installedCapabilityRowReader(),
): Promise<CapabilitySwarmDefaultView> {
  const rowsLoaded = !rows.state().installed || rows.state().loaded;
  const row = rows.rowFor(CAPABILITY_FLEET_SCOPE, adapter.capability);
  if (row) {
    return { capability: adapter.capability, providerId: row.providerId, voice: row.options.voice ?? null,
      model: row.options.model ?? null, source: 'row', row, reason: null, rowsLoaded };
  }
  const seed = await adapter.seedSwarmDefault();
  if (!seed.choice) {
    return { capability: adapter.capability, providerId: null, voice: null, model: null, source: seed.source,
      row: null, reason: seed.reason, rowsLoaded };
  }
  return { capability: adapter.capability, providerId: seed.choice.providerId, voice: seed.choice.voice ?? null,
    model: seed.choice.model ?? null, source: seed.source, row: null, reason: null, rowsLoaded };
}
