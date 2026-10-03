/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1b (D4) guard for TTS and STT spend at the voice-service boundary and in the recorder's rule: a swarm-paid TTS call and a swarm-paid STT call each hand the recorder ONE event carrying the accountable bot, the caller, the units (characters; audio seconds measured from the WAV) and the offer row's unit price; a free provider (local-stt, the browser) and a failed call record nothing; the amount is units times price, an unpriced call is zero and says why; the recorder writes the caller's own row under the request identity, the swarm's own row (no owner) for the system or an unattributed caller, never names a free call, and hashes the subject out of the rollup id. The database boundary (chat_tasks, oshal_cost_events, row-level security) is capability-offers-spend-postgres.spec.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceService } from '../../src/features/voice/services/voice-service';
import { getSTTProviderRegistry, resetSTTProviderRegistryForTesting } from '../../src/features/voice-providers/services/stt-provider-registry';
import { getTTSProviderRegistry, resetTTSProviderRegistryForTesting } from '../../src/features/voice-providers/services/tts-provider-registry';
import { capabilitySpendTaskId, createCapabilitySpendRecorder } from '@/features/capability-providers';
import { getRequestIdentity } from '@/shared/services/database/request-identity';
import {
  CAPABILITY_FLEET_SCOPE,
  capabilitySpendAmount,
  systemCapabilityPrincipal,
  unattributedCapabilityPrincipal,
  userCapabilityPrincipal,
  type CapabilityCaller,
  type CapabilityOfferReader,
  type CapabilitySpendEvent,
  type CapabilitySwarmRowReader,
} from '@/shared/capability-providers';

const BOT = 'a0000000-0000-0000-0000-000000000050';
const CALLER: CapabilityCaller = { principal: userCapabilityPrincipal({ sub: 'spend-person-sub', isOperator: false }), appId: null, agentId: BOT };
const PRICES: CapabilityOfferReader = {
  offerFor: (capability, providerId) => ({ capability, providerId, offeredTo: null, unitPriceUsd: capability === 'tts' ? 0.00003 : 0.0003, quotaLabel: null, updatedBy: 'op', updatedAt: null }),
};

/** A one-second 16 kHz mono 16-bit WAV. */
function oneSecondWav(): Buffer {
  const data = Buffer.alloc(32_000);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii'); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16_000, 24); head.writeUInt32LE(32_000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii'); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** Rows naming one swarm default per capability. */
function rows(defaults: Record<string, string>): CapabilitySwarmRowReader {
  return { state: () => ({ installed: true, loaded: true }), rowFor: (scope, capability) => (scope === CAPABILITY_FLEET_SCOPE && defaults[capability]
    ? { scopeId: scope, capability, providerId: defaults[capability], options: {}, updatedBy: 'op', updatedAt: null } : null) };
}

describe('voice calls hand the recorder one spend event with the bot and the caller (ADR-173 D4)', () => {
  const events: CapabilitySpendEvent[] = [];
  const spend = async (event: CapabilitySpendEvent) => { events.push(event); };

  beforeEach(() => {
    events.length = 0;
    resetSTTProviderRegistryForTesting();
    resetTTSProviderRegistryForTesting();
    for (const id of ['gemini-stt', 'local-stt']) {
      vi.spyOn(getSTTProviderRegistry().get(id)!, 'getStatus').mockResolvedValue({ configured: true, providerId: id });
      vi.spyOn(getSTTProviderRegistry().get(id)!, 'transcribe').mockResolvedValue({ providerId: id, text: 'hello there' });
    }
    const tts = getTTSProviderRegistry().get('google-cloud-tts')!;
    vi.spyOn(tts, 'getStatus').mockResolvedValue({ configured: true, providerId: 'google-cloud-tts' });
    vi.spyOn(tts, 'listVoices').mockResolvedValue([]);
    vi.spyOn(tts, 'synthesize').mockResolvedValue({ providerId: 'google-cloud-tts', audio: Buffer.from('mp3'), audioFormat: 'audio/mpeg' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetSTTProviderRegistryForTesting();
    resetTTSProviderRegistryForTesting();
  });

  it('a swarm-paid TTS call records its characters at the offer price, with the bot and the caller', async () => {
    const service = new VoiceService({ rows: rows({ tts: 'google-cloud-tts' }), offers: PRICES, spend });
    const out = await service.synthesizeSpeech('Twelve chars', undefined, undefined, { caller: CALLER });
    expect(out.providerId).toBe('google-cloud-tts');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ capability: 'tts', providerId: 'google-cloud-tts', costClass: 'swarm-paid', units: 12, unitPriceUsd: 0.00003, agentId: BOT, principal: CALLER.principal });
  });

  it('TTS characters are code points: an emoji is one character', async () => {
    const service = new VoiceService({ rows: rows({ tts: 'google-cloud-tts' }), offers: PRICES, spend });
    await service.synthesizeSpeech('hi \u{1F44B}', undefined, undefined, { caller: CALLER });
    expect(events[0]).toMatchObject({ capability: 'tts', units: 4 });
  });

  it('a swarm-paid STT call records the clip\'s measured seconds, with the bot and the caller', async () => {
    const service = new VoiceService({ rows: rows({ stt: 'gemini-stt' }), offers: PRICES, spend });
    await service.transcribeAudio(oneSecondWav(), 'audio/wav', { caller: CALLER });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ capability: 'stt', providerId: 'gemini-stt', costClass: 'swarm-paid', units: 1, unitPriceUsd: 0.0003, agentId: BOT, principal: CALLER.principal });
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('a free provider and a failed call record nothing', async () => {
    const free = new VoiceService({ rows: rows({ stt: 'local-stt' }), offers: PRICES, spend });
    await free.transcribeAudio(oneSecondWav(), 'audio/wav', { caller: CALLER });
    vi.spyOn(getSTTProviderRegistry().get('gemini-stt')!, 'transcribe').mockRejectedValue(new Error('Gemini API returned 429'));
    const failed = new VoiceService({ rows: rows({ stt: 'gemini-stt' }), offers: PRICES, spend });
    expect((await failed.transcribeAudio(oneSecondWav(), 'audio/wav', { caller: CALLER })).fallback).toBe('failed');
    expect(events).toEqual([]);
  });

  it('with no recorder installed nothing is recorded and the call still answers', async () => {
    const out = await new VoiceService({ rows: rows({ stt: 'gemini-stt' }), offers: PRICES, spend: null }).transcribeAudio(oneSecondWav(), 'audio/wav', { caller: CALLER });
    expect(out.text).toBe('hello there');
  });
});

describe('the spend rule and the recorder', () => {
  const base = { capability: 'stt' as const, providerId: 'gemini-stt', costClass: 'swarm-paid' as const, principal: CALLER.principal, agentId: BOT, appId: null, model: null, durationMs: 10 };

  it('the amount is units times the unit price; an unknown price or unknown units is zero and says which', () => {
    expect(capabilitySpendAmount({ ...base, units: 30, unitPriceUsd: 0.0004 })).toMatchObject({ priced: true, unpricedReason: null });
    expect(capabilitySpendAmount({ ...base, units: 30, unitPriceUsd: 0.0004 }).amountUsd).toBeCloseTo(0.012, 10);
    expect(capabilitySpendAmount({ ...base, units: 30, unitPriceUsd: null })).toMatchObject({ amountUsd: 0, priced: false, unpricedReason: expect.stringContaining('no unit price') });
    expect(capabilitySpendAmount({ ...base, units: null, unitPriceUsd: 0.0004 })).toMatchObject({ amountUsd: 0, priced: false, unpricedReason: expect.stringContaining('could not be measured') });
  });

  it('writes the caller\'s own row under the request identity, and the swarm\'s own row under the system identity', async () => {
    const recorded: Array<{ ownerSub?: string; agentId: string; totalCost: number; providerId: string; estimated?: boolean; systemContext: boolean }> = [];
    const cost = { recordCost: vi.fn(async (event: Record<string, unknown>) => {
      recorded.push({ ...(event as unknown as Omit<(typeof recorded)[number], 'systemContext'>), systemContext: getRequestIdentity()?.system === true });
    }) };
    const recorder = createCapabilitySpendRecorder({} as never, { cost: cost as never, now: () => new Date('2026-10-03T12:00:00Z') });
    await recorder({ ...base, units: 10, unitPriceUsd: 0.001 });
    await recorder({ ...base, units: 10, unitPriceUsd: null, principal: systemCapabilityPrincipal('scheduled narration'), agentId: null });
    await recorder({ ...base, units: 10, unitPriceUsd: 0.001, principal: unattributedCapabilityPrincipal('store caller') });
    await recorder({ ...base, costClass: 'free', units: 10, unitPriceUsd: 1 });
    expect(recorded).toHaveLength(3);
    expect(recorded[0]).toMatchObject({ ownerSub: 'spend-person-sub', agentId: BOT, providerId: 'stt:gemini-stt', estimated: false, systemContext: false });
    expect(recorded[0].totalCost).toBeCloseTo(0.01, 10);
    expect(recorded[1]).toMatchObject({ agentId: 'unattributed', totalCost: 0, estimated: true, systemContext: true });
    expect(recorded[1].ownerSub).toBeUndefined();
    expect(recorded[2]).toMatchObject({ systemContext: true });
  });

  it('the rollup id is per capability, provider, caller, bot and UTC day, and never carries the subject', () => {
    const id = capabilitySpendTaskId(base, new Date('2026-10-03T23:59:00Z'));
    expect(id).toMatch(new RegExp(`^capability-stt-gemini-stt-[0-9a-f]{16}-${BOT}-2026-10-03$`));
    expect(id).not.toContain('spend-person-sub');
    expect(capabilitySpendTaskId({ ...base, principal: systemCapabilityPrincipal('x') })).toContain('-system-');
    // Two bots on the same day are two rollups: the cost summary groups chat_tasks by agent_id.
    expect(capabilitySpendTaskId({ ...base, agentId: 'a0000000-0000-0000-0000-000000000051' })).not.toBe(capabilitySpendTaskId(base));
    expect(capabilitySpendTaskId({ ...base, agentId: null })).toContain('-unattributed-');
  });

  it('a recorder whose store throws logs and never throws into the call', async () => {
    const recorder = createCapabilitySpendRecorder({} as never, { cost: { recordCost: async () => { throw new Error('ledger down'); } } as never });
    await expect(recorder({ ...base, units: 1, unitPriceUsd: 1 })).resolves.toBeUndefined();
  });
});
