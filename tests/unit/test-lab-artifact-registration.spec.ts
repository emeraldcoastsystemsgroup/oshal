/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise registered Lab scenarios through real catalog/run HTTP routes; model responses and session authentication are explicit fixtures.
 */
import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestLabRoutes } from '@/app/routes/test-lab-routes';
import { createArtifactExchangeRoutes } from '@/app/routes/artifact-exchange-routes';
import { ARTIFACT_SCENARIOS } from '@/app/routes/test-lab-artifact-scenarios';
import type { AppContext } from '@/app/composition/app-context';

let server: Server, base: string;
const oldPort = process.env.PORT;
let wrongTarget = false, noConfirmation = false;
const asks: any[] = [], emailBodies: any[] = [];
beforeAll(async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { oidc: { user: { sub: 'test-lab-owner' }, isAuthenticated: () => true } }); next(); });
  app.get('/api/swarm/apps', (_req, res) => res.json({ apps: [] }));
  app.post('/api/artifacts/builtin/email', (req, res, next) => {
    emailBodies.push(req.body);
    if (noConfirmation) res.json({ ok: true }); else next();
  });
  app.use('/api/artifacts', createArtifactExchangeRoutes({} as AppContext));
  app.post('/api/jarvis/ask', (req, res) => {
    expect(req.headers.cookie).toBe('lab-session=fixture');
    asks.push(req.body); res.status(202).json({ jobId: String(asks.length - 1) });
  });
  app.get('/api/jarvis/ask/result', (req, res) => {
    const ask = asks[Number(req.query.jobId)];
    const ambiguous = ask.message.includes('somewhere');
    res.json({ status: 'done', answer: ambiguous ? 'Email or storage?' : 'Preparing email.', dispatched: [],
      ...(!ambiguous || wrongTarget ? { artifactAction: { ref: ask.artifact.ref, app: wrongTarget ? 'kernel-storage' : 'kernel-email', id: wrongTarget ? 'save' : 'compose' } } : {}) });
  });
  app.use('/api/test-lab', createTestLabRoutes({} as AppContext));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  process.env.PORT = String((server.address() as AddressInfo).port); base = `http://127.0.0.1:${process.env.PORT}`;
});
afterAll(async () => {
  if (oldPort === undefined) delete process.env.PORT; else process.env.PORT = oldPort;
  server?.closeAllConnections(); await new Promise<void>(resolve => server?.close(() => resolve()));
});
async function run(scenarioId: string) {
  const response = await fetch(base + '/api/test-lab/run', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'lab-session=fixture' }, body: JSON.stringify({ scenarioId }) });
  expect(response.status).toBe(200);
  return (await response.json()).results[0];
}
describe('artifact features registered in AI Test Lab', () => {
  it('publishes both scenarios and all feature suites with accurate levels', async () => {
    const catalog = await (await fetch(base + '/api/test-lab/catalog')).json();
    const registered = catalog.scenarios.filter((s: any) => ARTIFACT_SCENARIOS.some(expected => expected.id === s.id));
    expect(registered.map((s: any) => s.id)).toEqual(['artifact-discovery', 'jarvis-artifact-handoff']);
    const suites = registered.flatMap((s: any) => s.regressionTests);
    expect(suites).toHaveLength(8);
    const command = JSON.parse(readFileSync('package.json', 'utf8')).scripts['test:artifacts'];
    for (const suite of suites) expect(command.split(/\s+/)).toContain(suite.path);
    expect(new Set(suites.map((s: any) => s.level))).toEqual(new Set(['unit', 'integration', 'browser']));
    for (const suite of suites) expect(existsSync(suite.path), suite.path).toBe(true);
  });
  it('runs real artifact discovery and actual YAML loading through the Lab runner', async () => {
    const output = await run('artifact-discovery');
    expect(output.state).toBe('pass'); expect(output.steps).toHaveLength(2);
  });
  it('checks named/ambiguous model proposals and the real 428 gate without dispatching', async () => {
    const output = await run('jarvis-artifact-handoff');
    expect(output.state).toBe('pass'); expect(output.steps.map((s: any) => s.state)).toEqual(['pass', 'pass', 'pass', 'pass']);
    expect(asks).toHaveLength(2);
    expect(asks[0].artifact.ref).toBe(asks[1].artifact.ref);
    expect(asks[0].sessionId).not.toBe(asks[1].sessionId);
    expect(emailBodies).toEqual([{ ref: asks[0].artifact.ref }]);
  });
  it('goes red for a wrong target, unwanted ambiguity dispatch, and a missing confirmation gate', async () => {
    wrongTarget = true; noConfirmation = true;
    try {
      const output = await run('jarvis-artifact-handoff');
      expect(output.state).toBe('fail'); expect(output.steps.map((s: any) => s.state)).toEqual(['pass', 'fail', 'fail', 'fail']);
    } finally { wrongTarget = false; noConfirmation = false; }
  });
});
