/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1 Test Lab registration guard: the read-only capability-provider card is registered once in the Lab, runs in a run-all (it writes nothing), lists its regression suites (all on disk), and its step judges the REAL route shape over a real loopback listener — a complete listing passes, a non-operator is degraded, and a provider with no cost class, an unexplained unavailable provider or a missing capability fails.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1b: the card reports how many paid providers carry a unit price; a price on a free provider is not counted.
 */

import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SCENARIOS, scenariosForRun, type ScenarioRunContext } from '@/app/routes/test-lab-scenarios';
import { CAPABILITY_PROVIDER_SCENARIOS } from '@/app/routes/test-lab-capability-provider-scenarios';
import type { AppContext } from '@/app/composition/app-context';

const provider = (providerId: string, costClass: string | null, available: boolean, missing: string | null = null, detail = '') => ({ providerId, costClass, available, missing, detail });
const GOOD = {
  success: true,
  capabilities: [
    { capability: 'tts', swarmDefault: { providerId: 'google-cloud-tts', source: 'global-config.json voice.tts.default' }, providers: [provider('browser', 'free', true), provider('google-cloud-tts', 'swarm-paid', true)] },
    { capability: 'stt', swarmDefault: { providerId: 'local-stt', source: 'row' }, providers: [provider('local-stt', 'free', true), provider('gemini-stt', 'swarm-paid', false, 'no-credential', 'GOOGLE_API_KEY is empty')] },
    { capability: 'image', swarmDefault: { providerId: 'antigravity-cli', source: 'storyboard selection (render-bot)' }, providers: [provider('antigravity-cli', 'free', true)] },
    { capability: 'video', swarmDefault: { providerId: null, source: 'none (no video selector exists)', reason: 'No swarm video default is set' }, providers: [provider('veo', 'user-paid', false, 'no-credential', 'no caller token')] },
  ],
};

let reply: { status: number; body: unknown } = { status: 200, body: GOOD };
let server: Server;
let runtime: ScenarioRunContext;

beforeAll(async () => {
  server = createServer((_req, res) => { res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  runtime = { ownerSub: 'lab-operator', issuer: null, apiBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ctx: {} as AppContext };
});

afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

const step = () => CAPABILITY_PROVIDER_SCENARIOS[0].steps[0].run('sid=lab', {}, runtime);

describe('capability-provider Test Lab card (ADR-173 S1)', () => {
  it('is registered once, runs in a run-all (read-only), and lists suites that exist', () => {
    const scenario = SCENARIOS.filter((s) => s.id === 'capability-providers-swarm-defaults');
    expect(scenario).toHaveLength(1);
    expect(scenario[0].explicitOnly).toBeFalsy();
    expect(scenariosForRun('all').map((s) => s.id)).toContain('capability-providers-swarm-defaults');
    for (const test of scenario[0].regressionTests ?? []) expect(existsSync(test.path), test.path).toBe(true);
  });

  it('passes a complete listing and summarises each swarm default with its source', async () => {
    reply = { status: 200, body: GOOD };
    const out = await step();
    expect(out.state).toBe('pass');
    expect(out.detail).toContain('stt: local-stt (row)');
    expect(out.detail).toContain('video: none (none (no video selector exists))');
  });

  it('reports how many paid providers carry a unit price (ADR-173 S1b)', async () => {
    reply = { status: 200, body: GOOD };
    expect((await step()).detail).toContain('0 of 3 paid providers carry a unit price');
    const priced = structuredClone(GOOD);
    Object.assign(priced.capabilities[0].providers[1], { offer: { unitPriceUsd: 0.00003, quotaLabel: null } });
    Object.assign(priced.capabilities[1].providers[0], { offer: { unitPriceUsd: 0, quotaLabel: null } });
    reply = { status: 200, body: priced };
    const out = await step();
    expect(out.state).toBe('pass');
    expect(out.detail).toContain('1 of 3 paid providers carry a unit price');
  });

  it('is degraded for a non-operator', async () => {
    reply = { status: 403, body: { error: 'Operator privilege required' } };
    expect(await step()).toMatchObject({ state: 'degraded', status: 403 });
  });

  it.each([
    ['a provider with no cost class', (b: typeof GOOD) => { b.capabilities[0].providers[1].costClass = null; }],
    ['an unavailable provider that names nothing missing', (b: typeof GOOD) => { b.capabilities[1].providers[1].missing = null; }],
    ['a missing capability', (b: typeof GOOD) => { b.capabilities.pop(); }],
    ['a default with no source', (b: typeof GOOD) => { (b.capabilities[2].swarmDefault as { source?: string }).source = ''; }],
  ])('fails %s', async (_label, mutate) => {
    const body = structuredClone(GOOD);
    mutate(body);
    reply = { status: 200, body };
    expect((await step()).state).toBe('fail');
  });
});
