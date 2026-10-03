/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1 guard for the shared capability resolver's rules, over a scripted adapter and row reader (the adapters and the row store have their own real-boundary specs: capability-options-agree.spec.ts and capability-swarm-rows-postgres.spec.ts). Pins: a call without a principal is refused before any rung is read (D8); an explicit provider is a required preference, used or refused and never switched (D10); the caller's own default is rung 3 for a person and ignored for the system; the swarm row beats the seed, installed-but-unread rows refuse, and a seed that names nothing refuses (D6); a skip lands only on a free provider or the same payer as every provider skipped, else refuses (D5); a voice travels only with its own provider and only when the landing provider lists it, else the landing provider's default voice (D9); the options list asks the same availability function the resolver does (D3).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 D10 (round 2): a provider the request names (`requested`) is a preference: it answers at the app rung when available; unavailable or unregistered, it falls to the caller's own default and then the swarm default; its skip still never lands on a different payer (D5); a provider server code names (`explicit`) still wins and stays required.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CAPABILITY_FLEET_SCOPE,
  listCapabilityOptions,
  resolveCapabilityProvider,
  systemCapabilityPrincipal,
  userCapabilityPrincipal,
  type CapabilityAdapter,
  type CapabilityCostClass,
  type CapabilityPrincipal,
  type CapabilityResolveRequest,
  type CapabilitySeedDefault,
  type CapabilitySwarmRow,
  type CapabilitySwarmRowReader,
} from '@/shared/capability-providers';

interface FakeProvider { id: string; costClass: CapabilityCostClass | null; available: boolean; voices?: string[] | null; defaultVoice?: string }

/** A scripted adapter: availability, voices and the seed are exactly what each case says. */
function adapter(providers: FakeProvider[], seed: CapabilitySeedDefault, capability: 'tts' | 'stt' = 'tts') {
  const availability = vi.fn(async (providerId: string) => {
    const p = providers.find((candidate) => candidate.id === providerId);
    if (!p) return { providerId, available: false, missing: 'not-registered' as const, detail: `no ${providerId}` };
    return p.available
      ? { providerId, available: true, missing: null, detail: '' }
      : { providerId, available: false, missing: 'no-credential' as const, detail: `${providerId} has no key` };
  });
  const value: CapabilityAdapter = {
    capability,
    declarations: () => providers.map((p) => ({ capability, providerId: p.id, displayName: p.id, costClass: p.costClass, defaultVoice: p.defaultVoice ?? null })),
    availability,
    seedSwarmDefault: async () => seed,
    ...(capability === 'tts' ? { listVoiceIds: async (id: string) => { const p = providers.find((c) => c.id === id); return p && p.voices !== undefined ? p.voices : []; } } : {}),
  };
  return { value, availability };
}

/** A row reader holding the given fleet rows. */
function rows(fleet: Record<string, { providerId: string; voice?: string }> = {}, state = { installed: true, loaded: true }): CapabilitySwarmRowReader {
  return {
    state: () => state,
    rowFor: (scopeId, capability): CapabilitySwarmRow | null => {
      const row = scopeId === CAPABILITY_FLEET_SCOPE ? fleet[capability] : undefined;
      return row ? { scopeId, capability, providerId: row.providerId, options: row.voice ? { voice: row.voice } : {}, updatedBy: 'operator-sub', updatedAt: null } : null;
    },
  };
}

const PERSON: CapabilityPrincipal = userCapabilityPrincipal({ sub: 'person-sub', isOperator: false });
const SYSTEM: CapabilityPrincipal = systemCapabilityPrincipal('nightly narration');
const SEED_B: CapabilitySeedDefault = { choice: { providerId: 'b' }, source: 'global-config.json voice.tts.default' };

function request(extra: Partial<CapabilityResolveRequest> = {}): CapabilityResolveRequest {
  return { capability: 'tts', principal: PERSON, appId: null, agentId: 'bot-1', ...extra };
}

describe('D8: a call without a principal is refused before any rung is read', () => {
  it('refuses with no-principal and never asks availability', async () => {
    const { value, availability } = adapter([{ id: 'b', costClass: 'free', available: true }], SEED_B);
    const out = await resolveCapabilityProvider(value, { ...request(), principal: undefined as unknown as CapabilityPrincipal }, { rows: rows() });
    expect(out).toMatchObject({ ok: false, rung: 'refused', missing: 'no-principal' });
    expect(availability).not.toHaveBeenCalled();
  });

  it('refuses a malformed principal (a user with a blank subject)', async () => {
    const { value } = adapter([{ id: 'b', costClass: 'free', available: true }], SEED_B);
    const out = await resolveCapabilityProvider(value, { ...request(), principal: { kind: 'user', sub: ' ', isOperator: false, isGuest: false } }, { rows: rows() });
    expect(out).toMatchObject({ ok: false, missing: 'no-principal' });
  });
});

describe('D10: an explicit provider is required — used or refused, never switched', () => {
  it('an available explicit provider answers at the app rung', async () => {
    const { value } = adapter([{ id: 'a', costClass: 'swarm-paid', available: true, voices: ['a1'] }, { id: 'b', costClass: 'free', available: true }], SEED_B);
    expect(await resolveCapabilityProvider(value, request({ explicit: { providerId: 'a', voice: 'a1' } }), { rows: rows() }))
      .toMatchObject({ ok: true, providerId: 'a', rung: 'app', source: 'explicit', voice: 'a1' });
  });

  it('an unavailable explicit provider refuses with its own missing piece; the swarm default is never tried', async () => {
    const { value, availability } = adapter([{ id: 'a', costClass: 'swarm-paid', available: false }, { id: 'b', costClass: 'swarm-paid', available: true }], SEED_B);
    const out = await resolveCapabilityProvider(value, request({ explicit: { providerId: 'a' } }), { rows: rows() });
    expect(out).toMatchObject({ ok: false, missing: 'no-credential', detail: 'a has no key' });
    expect(availability.mock.calls.map((c) => c[0])).toEqual(['a']);
  });
});

describe('D10: a provider the REQUEST names is a preference that falls through', () => {
  it('an available requested provider answers at the app rung', async () => {
    const { value } = adapter([{ id: 'a', costClass: 'swarm-paid', available: true, voices: ['a1'] }, { id: 'b', costClass: 'swarm-paid', available: true }], SEED_B);
    expect(await resolveCapabilityProvider(value, request({ requested: { providerId: 'a', voice: 'a1' } }), { rows: rows() }))
      .toMatchObject({ ok: true, providerId: 'a', rung: 'app', source: 'request', voice: 'a1' });
  });

  it('an unavailable requested provider falls to the caller\'s own default, else the swarm default', async () => {
    const { value } = adapter([{ id: 'a', costClass: 'swarm-paid', available: false }, { id: 'b', costClass: 'swarm-paid', available: true }, { id: 'c', costClass: 'swarm-paid', available: true }], SEED_B);
    expect(await resolveCapabilityProvider(value, request({ requested: { providerId: 'a' }, userDefault: { providerId: 'c' } }), { rows: rows() }))
      .toMatchObject({ ok: true, providerId: 'c', rung: 'user-default', skipped: [{ rung: 'app', providerId: 'a', missing: 'no-credential' }] });
    expect(await resolveCapabilityProvider(value, request({ requested: { providerId: 'a' } }), { rows: rows() }))
      .toMatchObject({ ok: true, providerId: 'b', rung: 'swarm-default', skipped: [{ rung: 'app', providerId: 'a', missing: 'no-credential' }] });
  });

  it('an unregistered requested provider falls through to the swarm default', async () => {
    const { value } = adapter([{ id: 'b', costClass: 'swarm-paid', available: true }], SEED_B);
    expect(await resolveCapabilityProvider(value, request({ requested: { providerId: 'polly' } }), { rows: rows() }))
      .toMatchObject({ ok: true, providerId: 'b', rung: 'swarm-default', skipped: [{ rung: 'app', providerId: 'polly', missing: 'not-registered' }] });
  });

  it('a requested provider\'s skip never lands on a different payer (D5)', async () => {
    const { value } = adapter([{ id: 'a', costClass: 'free', available: false }, { id: 'b', costClass: 'swarm-paid', available: true }], SEED_B);
    expect(await resolveCapabilityProvider(value, request({ requested: { providerId: 'a' } }), { rows: rows() }))
      .toMatchObject({ ok: false, missing: 'payer-changes' });
  });

  it('a provider server code names (explicit) still wins and stays required', async () => {
    const { value } = adapter([{ id: 'a', costClass: 'swarm-paid', available: false }, { id: 'b', costClass: 'swarm-paid', available: true }], SEED_B);
    expect(await resolveCapabilityProvider(value, request({ explicit: { providerId: 'a' }, requested: { providerId: 'b' } }), { rows: rows() }))
      .toMatchObject({ ok: false, missing: 'no-credential' });
  });
});

describe('rungs 3 and 4: the caller\'s own default, then the swarm row, then the seed (D1, D6)', () => {
  it('a person\'s available default answers at user-default', async () => {
    const { value } = adapter([{ id: 'a', costClass: 'swarm-paid', available: true }, { id: 'b', costClass: 'swarm-paid', available: true }], SEED_B);
    expect(await resolveCapabilityProvider(value, request({ userDefault: { providerId: 'a' } }), { rows: rows() }))
      .toMatchObject({ ok: true, providerId: 'a', rung: 'user-default', source: 'user' });
  });

  it('the system principal resolves operator-written rungs only: a user default is ignored', async () => {
    const { value } = adapter([{ id: 'a', costClass: 'swarm-paid', available: true }, { id: 'b', costClass: 'swarm-paid', available: true }], SEED_B);
    expect(await resolveCapabilityProvider(value, request({ principal: SYSTEM, userDefault: { providerId: 'a' } }), { rows: rows() }))
      .toMatchObject({ ok: true, providerId: 'b', rung: 'swarm-default' });
  });

  it('the operator\'s row beats the seed; with no row the seed answers; an empty seed refuses by name', async () => {
    const { value } = adapter([{ id: 'b', costClass: 'swarm-paid', available: true }, { id: 'c', costClass: 'free', available: true }], SEED_B);
    expect(await resolveCapabilityProvider(value, request(), { rows: rows({ tts: { providerId: 'c' } }) }))
      .toMatchObject({ ok: true, providerId: 'c', rung: 'swarm-default', source: 'row' });
    expect(await resolveCapabilityProvider(value, request(), { rows: rows() }))
      .toMatchObject({ ok: true, providerId: 'b', rung: 'swarm-default', source: 'global-config.json voice.tts.default' });
    const empty = adapter([{ id: 'b', costClass: 'free', available: true }], { choice: null, source: 'none', reason: 'nothing names a default' });
    expect(await resolveCapabilityProvider(empty.value, request(), { rows: rows() }))
      .toMatchObject({ ok: false, missing: 'no-swarm-default', detail: 'nothing names a default' });
  });

  it('installed rows that have never loaded refuse instead of guessing the seed', async () => {
    const { value } = adapter([{ id: 'b', costClass: 'free', available: true }], SEED_B);
    expect(await resolveCapabilityProvider(value, request(), { rows: rows({}, { installed: true, loaded: false }) }))
      .toMatchObject({ ok: false, missing: 'rows-not-loaded' });
    expect(await resolveCapabilityProvider(value, request(), { rows: rows({}, { installed: false, loaded: false }) }))
      .toMatchObject({ ok: true, providerId: 'b' });
  });

  it('an unavailable swarm default refuses at rung 5 with its missing piece', async () => {
    const { value } = adapter([{ id: 'b', costClass: 'swarm-paid', available: false }], SEED_B);
    expect(await resolveCapabilityProvider(value, request(), { rows: rows() }))
      .toMatchObject({ ok: false, rung: 'refused', missing: 'no-credential', detail: 'b has no key', skipped: [{ rung: 'swarm-default', providerId: 'b' }] });
  });
});

describe('D5: a skip never lands on a different payer', () => {
  it.each([
    ['swarm-paid', 'swarm-paid', true],
    ['swarm-paid', 'free', true],
    ['swarm-paid', 'user-paid', false],
    ['free', 'swarm-paid', false],
    ['user-paid', 'swarm-paid', false],
  ] as const)('a %s default skipped onto a %s swarm default: allowed=%s', async (skippedClass, landingClass, allowed) => {
    const { value } = adapter([{ id: 'a', costClass: skippedClass, available: false }, { id: 'b', costClass: landingClass, available: true }], SEED_B);
    const out = await resolveCapabilityProvider(value, request({ userDefault: { providerId: 'a' } }), { rows: rows() });
    if (allowed) expect(out).toMatchObject({ ok: true, providerId: 'b', skipped: [{ rung: 'user-default', providerId: 'a', missing: 'no-credential' }] });
    else expect(out).toMatchObject({ ok: false, missing: 'payer-changes', detail: expect.stringContaining('ADR-173 D5') });
  });
});

describe('D9: a voice travels only with its own provider, and only when that provider lists it', () => {
  const voices = [
    { id: 'a', costClass: 'swarm-paid' as const, available: false, voices: ['a1', 'a2'], defaultVoice: 'a1' },
    { id: 'b', costClass: 'swarm-paid' as const, available: true, voices: ['b1', 'b2'], defaultVoice: 'b1' },
  ];

  it('an unavailable pair lands on the next provider with THAT provider\'s default voice', async () => {
    const { value } = adapter(voices, SEED_B);
    expect(await resolveCapabilityProvider(value, request({ userDefault: { providerId: 'a', voice: 'a2' } }), { rows: rows() }))
      .toMatchObject({ ok: true, providerId: 'b', voice: 'b1' });
  });

  it('a voice hint the landing provider does not list is dropped; one it lists is used', async () => {
    const { value } = adapter(voices, SEED_B);
    expect(await resolveCapabilityProvider(value, request({ voiceHint: 'a2' }), { rows: rows() })).toMatchObject({ providerId: 'b', voice: 'b1' });
    expect(await resolveCapabilityProvider(value, request({ voiceHint: 'b2' }), { rows: rows() })).toMatchObject({ providerId: 'b', voice: 'b2' });
  });

  it('the swarm row\'s own voice is used when listed, and replaced by the default voice when not', async () => {
    const { value } = adapter(voices, SEED_B);
    expect(await resolveCapabilityProvider(value, request(), { rows: rows({ tts: { providerId: 'b', voice: 'b2' } }) })).toMatchObject({ voice: 'b2' });
    expect(await resolveCapabilityProvider(value, request(), { rows: rows({ tts: { providerId: 'b', voice: 'gone' } }) })).toMatchObject({ voice: 'b1' });
  });

  it('a provider whose default voice is not listed is sent no voice at all', async () => {
    const { value } = adapter([{ id: 'b', costClass: 'free', available: true, voices: ['b2'], defaultVoice: 'b1' }], SEED_B);
    expect(await resolveCapabilityProvider(value, request(), { rows: rows() })).toMatchObject({ providerId: 'b', voice: null });
  });

  it('a provider that cannot enumerate voices server-side (the browser) takes the asked voice', async () => {
    const { value } = adapter([{ id: 'browser', costClass: 'free', available: true, voices: null }], { choice: { providerId: 'browser' }, source: 'seed' });
    expect(await resolveCapabilityProvider(value, request({ voiceHint: 'Samantha' }), { rows: rows() })).toMatchObject({ providerId: 'browser', voice: 'Samantha' });
  });

  it('speech to text never carries a voice', async () => {
    const { value } = adapter([{ id: 'b', costClass: 'free', available: true }], { choice: { providerId: 'b', voice: 'x' }, source: 'seed' }, 'stt');
    expect(await resolveCapabilityProvider(value, { ...request(), capability: 'stt' }, { rows: rows() })).toMatchObject({ providerId: 'b', voice: null });
  });
});

describe('D3: the options list asks the same availability function', () => {
  it('lists every declared provider with its class and the availability the resolver would see', async () => {
    const { value, availability } = adapter([{ id: 'a', costClass: 'swarm-paid', available: false }, { id: 'b', costClass: 'free', available: true }], SEED_B);
    const options = await listCapabilityOptions(value, PERSON);
    expect(options).toEqual([
      expect.objectContaining({ providerId: 'a', costClass: 'swarm-paid', available: false, missing: 'no-credential', detail: 'a has no key' }),
      expect.objectContaining({ providerId: 'b', costClass: 'free', available: true, missing: null, detail: '' }),
    ]);
    expect(availability).toHaveBeenCalledWith('a', PERSON, undefined);
  });

  it('a provider that declares no cost class is never resolved', async () => {
    const { value } = adapter([{ id: 'b', costClass: null, available: true }], SEED_B);
    expect(await resolveCapabilityProvider(value, request(), { rows: rows() })).toMatchObject({ ok: false, missing: 'no-cost-class' });
  });

  it('an adapter for another capability is a programming error', async () => {
    const { value } = adapter([{ id: 'b', costClass: 'free', available: true }], SEED_B, 'stt');
    await expect(resolveCapabilityProvider(value, request(), { rows: rows() })).rejects.toThrow(/adapter mismatch/);
  });
});
