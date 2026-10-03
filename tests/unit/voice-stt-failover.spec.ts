/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the STT turn-time failover (live 2026-08-11: Gemini's free tier quota-walled mid-day and every Jarvis dictation answered "Transcription failed" while the configured on-host sherpa sidecar sat idle — the registry resolved exactly one provider and VoiceService had no second try). Pins: the DEFAULT-resolved provider failing walks to the next server-kind provider and answers with a real transcript; an EXPLICITLY requested provider surfaces its own failure unswitched (caller's-choice boundary, like an explicit BYO brain); every candidate failing surfaces the ORIGINAL failure; and local-stt is REGISTERED from the default config (the provider existed but nothing declared it, so no walk could ever reach it).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | REWRITTEN to ADR-173 D5 (operator decision 2026-10-03): a provider that was available and then fails fails the call clearly; the resolver never moves to another provider, so a free-tier quota wall can no longer become a paid Cloud call (registration order tried google-cloud-stt, swarm-paid, before the free local sidecar). Entry 1's "walks to the next provider" case is inverted, not deleted: a failed gemini-stt now reaches NEITHER google-cloud-stt NOR local-stt and returns its own failure with the rung that chose it. The quota case is handled by D12 instead — the operator moves the swarm default to local-stt with one row — which the last case pins through the same path a dictation takes. Through the REAL registry from the default config and the real resolver; only the providers' network calls and status probes are doubled.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceService } from '../../src/features/voice/services/voice-service';
import {
  getSTTProviderRegistry,
  resetSTTProviderRegistryForTesting,
} from '../../src/features/voice-providers/services/stt-provider-registry';
import type { STTProvider } from '../../src/features/voice-providers';
import {
  CAPABILITY_FLEET_SCOPE,
  userCapabilityPrincipal,
  type CapabilityCaller,
  type CapabilitySwarmRowReader,
} from '../../src/shared/capability-providers';

const AUDIO = Buffer.from('not-really-audio');
const MIME = 'audio/wav';
const GEMINI_429 = new Error('Gemini API returned 429: quota exceeded for generate_content_free_tier_requests');
const CALLER: CapabilityCaller = { principal: userCapabilityPrincipal({ sub: 'dictating-user', isOperator: false }), appId: null, agentId: 'a0000000-0000-0000-0000-000000000050' };

/** No rows installed: the swarm default is the seed the config names (gemini-stt). */
const NO_ROWS: CapabilitySwarmRowReader = { state: () => ({ installed: false, loaded: false }), rowFor: () => null };

function provider(id: string): STTProvider {
  const found = getSTTProviderRegistry().get(id);
  if (!found) throw new Error(`provider ${id} is not registered — the default config must declare it`);
  return found;
}

/** Report every STT provider configured (the credential check passes), so each case is about failure, not setup. */
function allConfigured(): void {
  for (const id of ['gemini-stt', 'google-cloud-stt', 'local-stt']) {
    vi.spyOn(provider(id), 'getStatus').mockResolvedValue({ configured: true, providerId: id });
  }
}

describe('STT runtime failure under ADR-173 D5 — a failed provider never reaches another provider', () => {
  beforeEach(() => {
    resetSTTProviderRegistryForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetSTTProviderRegistryForTesting();
  });

  it('local-stt is registered from the default config (the swarm row can name it)', () => {
    const local = getSTTProviderRegistry().get('local-stt');
    expect(local).toBeDefined();
    expect(local?.kind).toBe('server');
    expect(local?.costClass).toBe('free');
  });

  it('a failed gemini-stt reaches NEITHER google-cloud-stt NOR local-stt and returns its own failure', async () => {
    allConfigured();
    const gemini = vi.spyOn(provider('gemini-stt'), 'transcribe').mockRejectedValue(GEMINI_429);
    const gcloud = vi.spyOn(provider('google-cloud-stt'), 'transcribe').mockResolvedValue({ providerId: 'google-cloud-stt', text: 'paid transcript' });
    const local = vi.spyOn(provider('local-stt'), 'transcribe').mockResolvedValue({ providerId: 'local-stt', text: 'free transcript' });

    const out = await new VoiceService({ rows: NO_ROWS }).transcribeAudio(AUDIO, MIME, { caller: CALLER });

    expect(out).toMatchObject({ providerId: 'gemini-stt', fallback: 'failed', rung: 'swarm-default' });
    expect(out.message).toContain('429');
    expect(out.text).toBeUndefined();
    expect(gemini).toHaveBeenCalledTimes(1);
    expect(gcloud).not.toHaveBeenCalled();
    expect(local).not.toHaveBeenCalled();
  });

  it('an unconfigured swarm default refuses naming the missing piece, and no provider is called', async () => {
    vi.spyOn(provider('gemini-stt'), 'getStatus').mockResolvedValue({ configured: false, providerId: 'gemini-stt', reason: 'GOOGLE_API_KEY / GEMINI_API_KEY env var is empty' });
    const calls = ['gemini-stt', 'google-cloud-stt', 'local-stt'].map((id) => vi.spyOn(provider(id), 'transcribe'));

    const out = await new VoiceService({ rows: NO_ROWS }).transcribeAudio(AUDIO, MIME, { caller: CALLER });

    expect(out).toMatchObject({ providerId: 'unavailable', fallback: 'unconfigured', rung: 'refused', missing: 'no-credential' });
    expect(out.message).toContain('GOOGLE_API_KEY');
    for (const call of calls) expect(call).not.toHaveBeenCalled();
  });

  it('an EXPLICITLY requested provider surfaces its own failure — never silently switched', async () => {
    allConfigured();
    vi.spyOn(provider('gemini-stt'), 'transcribe').mockRejectedValue(GEMINI_429);
    const local = vi.spyOn(provider('local-stt'), 'transcribe').mockResolvedValue({
      providerId: 'local-stt', text: 'should never be used', languageCode: 'en-US',
    });

    const out = await new VoiceService({ rows: NO_ROWS }).transcribeAudio(AUDIO, MIME, { providerId: 'gemini-stt', caller: CALLER });

    expect(out).toMatchObject({ fallback: 'failed', rung: 'app' });
    expect(out.message).toContain('429');
    expect(local).not.toHaveBeenCalled();
  });

  it('D12: with the operator\'s swarm row on local-stt the same dictation answers from local-stt and gemini-stt is never called', async () => {
    allConfigured();
    const gemini = vi.spyOn(provider('gemini-stt'), 'transcribe').mockRejectedValue(GEMINI_429);
    vi.spyOn(provider('local-stt'), 'transcribe').mockResolvedValue({ providerId: 'local-stt', text: 'strengthen my resume', languageCode: 'en-US' });
    const localRow: CapabilitySwarmRowReader = {
      state: () => ({ installed: true, loaded: true }),
      rowFor: (scope, capability) => (scope === CAPABILITY_FLEET_SCOPE && capability === 'stt'
        ? { scopeId: scope, capability, providerId: 'local-stt', options: {}, updatedBy: 'operator-sub', updatedAt: null } : null),
    };

    const out = await new VoiceService({ rows: localRow }).transcribeAudio(AUDIO, MIME, { caller: CALLER });

    expect(out).toMatchObject({ providerId: 'local-stt', text: 'strengthen my resume', rung: 'swarm-default' });
    expect(out.fallback).toBeUndefined();
    expect(gemini).not.toHaveBeenCalled();
  });
});
