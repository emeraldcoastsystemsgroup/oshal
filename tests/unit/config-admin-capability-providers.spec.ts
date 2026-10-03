/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1b guard for the config-admin capability card (src/pages/config-admin/config-admin-capability-providers.js), run in node against the module itself with the fetch boundary recorded: the markup offers every provider labelled with who pays and, when it cannot be used now, the API's own missing piece; the stored row is selected and its voice shown (text to speech only); Clear is disabled with no row; each provider carries its price and quota label. Saving the default is ONE PUT with the chosen provider (and voice), Clear is a DELETE, a price save is a PUT with a number (an empty box clears it to null), an API refusal is shown verbatim, and a refused listing renders the API's reason instead of controls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  capabilitySectionMarkup,
  clearCapabilityDefault,
  defaultSentence,
  loadCapabilityProviders,
  providerLabel,
  renderCapabilityProvidersPanel,
  saveCapabilityDefault,
  saveCapabilityOffer,
} from '../../src/pages/config-admin/config-admin-capability-providers.js';

const STT = {
  capability: 'stt', priceUnit: 'audio-seconds',
  swarmDefault: { providerId: 'local-stt', voice: null, source: 'row', row: { providerId: 'local-stt', updatedBy: 'operator-sub', updatedAt: '2026-10-03T12:00:00.000Z' } },
  providers: [
    { providerId: 'gemini-stt', displayName: 'Gemini STT', costClass: 'swarm-paid', available: false, missing: 'no-credential', detail: 'GOOGLE_API_KEY is empty', offer: { unitPriceUsd: 0.0004, quotaLabel: 'shared free tier' } },
    { providerId: 'local-stt', displayName: 'Local STT', costClass: 'free', available: true, missing: null, detail: '', offer: null },
  ],
};
const TTS = {
  capability: 'tts', priceUnit: 'characters',
  swarmDefault: { providerId: 'google-cloud-tts', voice: null, source: 'global-config.json voice.tts.default', row: null },
  providers: [{ providerId: 'google-cloud-tts', displayName: 'Google Cloud TTS', costClass: 'swarm-paid', available: true, missing: null, detail: '', offer: null }],
};

/** A form host that answers the selectors the card reads, with the values a case sets. */
function host(values: Record<string, Record<string, string>>) {
  const forms: Record<string, { querySelector: (s: string) => unknown }> = {};
  for (const [cap, fields] of Object.entries(values)) {
    forms[cap] = {
      querySelector: (selector: string) => {
        if (selector === '[data-capability-provider]') return { value: fields.provider ?? '' };
        if (selector === '[data-capability-voice]') return fields.voice === undefined ? null : { value: fields.voice };
        const row = /^\[data-capability-offer="(.+)"\]$/.exec(selector);
        if (row) return { querySelector: (s: string) => ({ value: s === '[data-offer-price]' ? fields.price ?? '' : fields.label ?? '' }) };
        return null;
      },
    };
  }
  return { innerHTML: '', querySelector: (selector: string) => forms[/data-capability-form="(.+)"/.exec(selector)?.[1] ?? ''] ?? null };
}

const requests: Array<{ url: string; method: string; body: unknown }> = [];
let answer: (url: string, method: string) => { status: number; body: unknown } = () => ({ status: 200, body: { success: true, capabilities: [TTS, STT] } });

beforeEach(() => {
  requests.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    requests.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const reply = answer(url, method);
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  answer = () => ({ status: 200, body: { success: true, capabilities: [TTS, STT] } });
});

const appWith = (panel: ReturnType<typeof host>) => ({ state: {} as Record<string, unknown>, elements: { capabilityProvidersPanel: panel }, setStatus: vi.fn() });

describe('the capability card markup (ADR-173 S1b)', () => {
  it('labels every provider with who pays and, when not usable, the API\'s own missing piece', () => {
    expect(providerLabel(STT.providers[0])).toBe('Gemini STT (swarm pays) — not usable now: GOOGLE_API_KEY is empty');
    expect(providerLabel(STT.providers[1])).toBe('Local STT (free)');
  });

  it('selects the stored row, enables Clear, and carries each provider\'s price and quota label', () => {
    const html = capabilitySectionMarkup(STT);
    expect(html).toContain('<option value="local-stt" selected>');
    expect(html).not.toMatch(/data-capability-clear="stt" disabled/);
    expect(html).toContain('value="0.0004"');
    expect(html).toContain('value="shared free tier"');
    expect(html).toContain('USD per audio-second');
    expect(html).not.toContain('data-capability-voice');
    expect(defaultSentence(STT)).toBe('Swarm default: local-stt (set by operator-sub at 2026-10-03T12:00:00.000Z).');
  });

  it('with no row: the "no row" entry is selected, Clear is disabled, the seed is named, and text to speech offers a voice box', () => {
    const html = capabilitySectionMarkup(TTS);
    expect(html).toContain('<option value="" selected>(no row');
    expect(html).toMatch(/data-capability-clear="tts" disabled/);
    expect(html).toContain('data-capability-voice');
    expect(defaultSentence(TTS)).toBe('Swarm default: google-cloud-tts, from global-config.json voice.tts.default (no row written).');
  });

  it('a refused listing renders the API\'s reason instead of controls', async () => {
    answer = () => ({ status: 403, body: { error: 'Operator privilege required' } });
    const panel = host({});
    const app = appWith(panel);
    await loadCapabilityProviders(app);
    renderCapabilityProvidersPanel(app);
    expect(panel.innerHTML).toContain('Capability providers unavailable: Operator privilege required');
    expect(panel.innerHTML).not.toContain('<select');
  });
});

describe('the capability card writes (ADR-173 S1b)', () => {
  it('Save is ONE PUT with the chosen provider and voice, then a re-read', async () => {
    const app = appWith(host({ tts: { provider: 'google-cloud-tts', voice: 'en-US-Chirp3-HD-Kore' } }));
    answer = (_url, method) => (method === 'PUT' ? { status: 200, body: { success: true, availability: { available: true } } } : { status: 200, body: { capabilities: [TTS, STT] } });
    await saveCapabilityDefault(app, 'tts');
    expect(requests[0]).toEqual({ url: '/api/capability-providers/swarm/tts', method: 'PUT', body: { providerId: 'google-cloud-tts', voice: 'en-US-Chirp3-HD-Kore' } });
    expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
    expect(app.setStatus).toHaveBeenCalledWith(expect.stringContaining('the next call uses it, no restart'), 'success');
  });

  it('an API refusal is shown verbatim and nothing else is sent', async () => {
    const app = appWith(host({ tts: { provider: 'google-cloud-tts', voice: 'Kore' } }));
    answer = () => ({ status: 400, body: { error: 'google-cloud-tts does not list the voice "Kore"' } });
    await saveCapabilityDefault(app, 'tts');
    expect(app.setStatus).toHaveBeenLastCalledWith('Text to speech swarm default not changed: google-cloud-tts does not list the voice "Kore"', 'error');
    expect(requests).toHaveLength(1);
  });

  it('no provider chosen sends nothing; Clear is a DELETE', async () => {
    const app = appWith(host({ stt: { provider: '' } }));
    await saveCapabilityDefault(app, 'stt');
    expect(requests).toEqual([]);
    await clearCapabilityDefault(app, 'stt');
    expect(requests[0]).toMatchObject({ url: '/api/capability-providers/swarm/stt', method: 'DELETE' });
  });

  it('a price save PUTs a number and the quota label; an empty price box clears the price to null', async () => {
    const app = appWith(host({ stt: { price: '0.0004', label: 'shared free tier' } }));
    await saveCapabilityOffer(app, 'stt', 'gemini-stt');
    expect(requests[0]).toEqual({ url: '/api/capability-providers/offers/stt/gemini-stt', method: 'PUT', body: { unitPriceUsd: 0.0004, quotaLabel: 'shared free tier' } });
    const cleared = appWith(host({ stt: { price: '', label: '' } }));
    requests.length = 0;
    await saveCapabilityOffer(cleared, 'stt', 'gemini-stt');
    expect(requests[0].body).toEqual({ unitPriceUsd: null, quotaLabel: null });
  });

  it('a price that is not a number is refused in place and nothing is sent (never cleared by accident)', async () => {
    const app = appWith(host({ stt: { price: 'abc', label: '' } }));
    await saveCapabilityOffer(app, 'stt', 'gemini-stt');
    expect(requests).toEqual([]);
    expect(app.setStatus).toHaveBeenCalledWith('gemini-stt price not saved: "abc" is not a number of USD per unit.', 'error');
  });
});
