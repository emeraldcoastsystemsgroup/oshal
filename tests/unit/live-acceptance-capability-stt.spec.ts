/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Judgement and cleanup of the ADR-173 S1 live case (scripts/lib/live-acceptance-capability-stt.js) over scripted ports, so a box run can only pass for the right reasons: local-stt proven on the clip before anything moves; one PUT; the next dictation from local-stt at swarm-default; the api log line naming the rung (host runner) — the Lab's missing log leg is degraded, never pass; a paid clip voice without --allow-paid writes nothing; a mishearing or an unavailable local-stt writes nothing; a failure after the write puts the previous default back and reads it back; a box already on local-stt is not written again; an older build is unavailable.
 */

import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const testCase = require('../../scripts/lib/live-acceptance-capability-stt.js') as {
  KEY: string; PHRASE: string;
  run: (ports: Record<string, unknown>, options?: Record<string, unknown>) => Promise<{ state: string; detail: string; cleanup: { kept: string[]; removed: string[]; outstanding: string[]; errors: string[] } }>;
};

const PHRASE = testCase.PHRASE;
type Reply = { status: number; json: Record<string, unknown> };

/** A capability listing: local-stt offered or not, the STT default from a row or the seed, and the TTS default's class. */
function listing(opts: { localAvailable?: boolean; sttRow?: string | null; ttsClass?: string } = {}): Reply {
  const sttRow = opts.sttRow ?? null;
  return { status: 200, json: { success: true, capabilities: [
    { capability: 'tts', swarmDefault: { providerId: 'google-cloud-tts', source: 'global-config.json voice.tts.default' },
      providers: [{ providerId: 'google-cloud-tts', available: true, costClass: opts.ttsClass ?? 'swarm-paid', detail: '' }] },
    { capability: 'stt', swarmDefault: sttRow ? { providerId: sttRow, source: 'row', row: { providerId: sttRow } } : { providerId: 'gemini-stt', source: 'global-config.json voice.stt.default', row: null },
      providers: [{ providerId: 'local-stt', available: opts.localAvailable ?? true, costClass: 'free', detail: opts.localAvailable === false ? 'SPEAKER_SERVICE_KEY is not set' : '' }] },
  ] } };
}

/** Scripted ports that record every call and answer per route. */
function ports(script: {
  listings?: Reply[]; tryText?: string; dictation?: Record<string, unknown>; logRung?: string | null; withLogs?: boolean; status404?: boolean;
}) {
  const calls: string[] = [];
  const listings = [...(script.listings ?? [listing()])];
  const api = async (method: string, route: string, body?: Record<string, unknown>): Promise<Reply> => {
    calls.push(`${method} ${route}${body && 'providerId' in body ? ` ${String(body.providerId)}` : ''}`);
    if (script.status404) return { status: 404, json: {} };
    if (method === 'GET' && route === '/api/capability-providers') return listings.length > 1 ? listings.shift()! : listings[0];
    if (route === '/api/voice/synthesize') return { status: 200, json: { data: { providerId: 'google-cloud-tts', audioData: Buffer.from('ID3-mp3-bytes').toString('base64'), format: 'audio/mpeg' } } };
    if (route === '/api/capability-providers/swarm/stt') return { status: 200, json: { success: true, applied: true } };
    return { status: 500, json: {} };
  };
  const upload = async (route: string, _fields: unknown, file: { field: string; type: string }): Promise<Reply> => {
    calls.push(`UPLOAD ${route} ${file.field} ${file.type}`);
    if (route.endsWith('/stt/local-stt/try')) return { status: 200, json: { success: true, providerId: 'local-stt', text: script.tryText ?? `${PHRASE}.`, rung: 'app' } };
    return { status: 200, json: { success: true, data: script.dictation ?? { providerId: 'local-stt', text: `The ${PHRASE}`, rung: 'swarm-default' } } };
  };
  const apiLogs = async () => (script.logRung === null ? [] : [
    `2026-10-03T15:00:00.000Z {"level":30,"module":"capability-resolution","capability":"stt","providerId":"local-stt","rung":"${script.logRung ?? 'swarm-default'}","msg":"capability provider resolved"}`,
  ]);
  return { calls, ports: { api, upload, ...(script.withLogs === false ? {} : { apiLogs }) } };
}

describe('capability-stt live case (ADR-173 S1 live Done-when)', () => {
  it('passes on the host runner: local-stt proven, ONE write, the next dictation and its log line name local-stt at swarm-default; the row is kept', async () => {
    const { calls, ports: p } = ports({});
    const out = await testCase.run(p, { allowPaid: true });
    expect(out.state).toBe('pass');
    expect(out.detail).toContain('one operator write made local-stt the swarm STT default');
    expect(out.detail).toContain('log line: capability stt, local-stt, rung swarm-default');
    expect(calls).toEqual([
      'GET /api/capability-providers', 'POST /api/voice/synthesize', 'UPLOAD /api/capability-providers/stt/local-stt/try audio audio/mpeg',
      'PUT /api/capability-providers/swarm/stt local-stt', 'UPLOAD /api/voice/transcribe audio audio/mpeg',
    ]);
    expect(out.cleanup).toMatchObject({ outstanding: [], errors: [] });
    expect(out.cleanup.kept[0]).toContain('swarm-stt-row local-stt (ADR-173 D12');
  });

  it('from the Lab (no api log port) the log leg is a gap: degraded, never pass', async () => {
    const out = await testCase.run(ports({ withLogs: false }).ports, { allowPaid: true });
    expect(out.state).toBe('degraded');
    expect(out.detail).toContain('host runner only');
  });

  it('a paid clip voice without --allow-paid writes nothing and names the command', async () => {
    const { calls, ports: p } = ports({});
    const out = await testCase.run(p, {});
    expect(out.state).toBe('unavailable');
    expect(out.detail).toContain(`node scripts/operations/live-acceptance.js ${testCase.KEY} --allow-paid`);
    expect(calls).toEqual(['GET /api/capability-providers']);
  });

  it('a free clip voice needs no consent', async () => {
    const out = await testCase.run(ports({ listings: [listing({ ttsClass: 'free' })] }).ports, {});
    expect(out.state).toBe('pass');
  });

  it('local-stt unavailable, or mishearing the clip, fails with the default NOT moved', async () => {
    const off = ports({ listings: [listing({ localAvailable: false })] });
    expect(await testCase.run(off.ports, { allowPaid: true })).toMatchObject({ state: 'fail', detail: expect.stringContaining('SPEAKER_SERVICE_KEY') });
    expect(off.calls.some((c) => c.startsWith('PUT'))).toBe(false);
    const deaf = ports({ tryText: 'the quick brown cat' });
    const out = await testCase.run(deaf.ports, { allowPaid: true });
    expect(out).toMatchObject({ state: 'fail', detail: expect.stringContaining('was NOT moved') });
    expect(out.detail).toContain('missing fox, jumps, over, lazy, dog');
    expect(deaf.calls.some((c) => c.startsWith('PUT'))).toBe(false);
  });

  it('a dictation answered elsewhere after the write puts the previous default back and reads it back', async () => {
    const { calls, ports: p } = ports({ listings: [listing(), listing({ sttRow: null })], dictation: { providerId: 'gemini-stt', text: PHRASE, rung: 'swarm-default' } });
    const out = await testCase.run(p, { allowPaid: true });
    expect(out.state).toBe('fail');
    expect(out.detail).toContain('the next dictation was answered by gemini-stt');
    expect(calls).toContain('DELETE /api/capability-providers/swarm/stt');
    expect(out.cleanup).toMatchObject({ removed: ['swarm-stt-row local-stt'], outstanding: [], errors: [] });
  });

  it('a log line naming another rung fails and restores a previous ROW by writing it back', async () => {
    const { calls, ports: p } = ports({ listings: [listing({ sttRow: 'gemini-stt' }), listing({ sttRow: 'gemini-stt' })], logRung: 'user-default' });
    const out = await testCase.run(p, { allowPaid: true });
    expect(out.state).toBe('fail');
    expect(out.detail).toContain('names the rung user-default');
    expect(calls.filter((c) => c.startsWith('PUT'))).toEqual(['PUT /api/capability-providers/swarm/stt local-stt', 'PUT /api/capability-providers/swarm/stt gemini-stt']);
    expect(out.cleanup.outstanding).toEqual([]);
  });

  it('a box already on local-stt is proven without writing again', async () => {
    const { calls, ports: p } = ports({ listings: [listing({ sttRow: 'local-stt' })] });
    const out = await testCase.run(p, { allowPaid: true });
    expect(out.state).toBe('pass');
    expect(out.detail).toContain('the swarm STT default was already local-stt');
    expect(calls.some((c) => c.startsWith('PUT'))).toBe(false);
  });

  it('a build without the capability routes is unavailable and writes nothing', async () => {
    const { calls, ports: p } = ports({ status404: true });
    expect(await testCase.run(p, { allowPaid: true })).toMatchObject({ state: 'unavailable', detail: expect.stringContaining('ADR-173 S1 is not deployed') });
    expect(calls).toEqual(['GET /api/capability-providers']);
  });
});
