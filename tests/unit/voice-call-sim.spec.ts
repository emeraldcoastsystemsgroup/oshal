/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove synthetic Twilio contracts, IVR interpretation, music abstention, owner fencing, durable assessment and Jarvis CLI dispatch.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Change Log brought to the standard block format.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http, { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import express, { type RequestHandler } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVoiceCallSimRoutes } from '../../src/app/routes/voice-call-sim-routes';
import {
  MOCK_CALLER, MOCK_INSURER, VoiceCallSimService,
} from '../../src/app/routes/voice-call-sim-service';
import { interpretSimAudio, VOICE_SIM_SCENARIOS } from '../../src/app/routes/voice-call-sim-scenarios';
import { buildToolsBlock } from '../../src/app/routes/jarvis-tool-catalog';

const OWNER = 'oidc|voice-sim-owner';
const OTHER = 'oidc|other-owner';
const SECRET = 'voice-sim-test-secret';
const MOUNT = '/api/voice-sim';
const execFileAsync = promisify(execFile);

async function completed(service: VoiceCallSimService, id: string) {
  let last = 'unknown';
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const run = await service.get(OWNER, id);
    if (run.status === 'completed') return run;
    if (run.status === 'interrupted') throw new Error(`simulation interrupted: ${run.reason}`);
    last = run.status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`simulation did not complete: ${last}`);
}

describe('synthetic phone-call service', () => {
  let root: string;
  let service: VoiceCallSimService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'oshal-voice-sim-spec-'));
    service = new VoiceCallSimService(root);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it.each(VOICE_SIM_SCENARIOS.map((scenario) => [scenario.id, scenario.expected] as const))(
    '%s reaches the expected assessed outcome', async (scenarioId, expected) => {
      const started = await service.start(OWNER, scenarioId);
      expect(started.synthetic).toBe(true);
      const run = await completed(service, started.id);
      expect(run.outcome).toBe(expected);
      expect(run.assessment?.passed).toBe(true);
      expect(Object.values(run.assessment?.checks ?? {})).toEqual([true, true, true, true, true]);
      expect(run.events.map((event) => event.seq)).toEqual(run.events.map((_event, index) => index + 1));
      if (['speaker-mismatch', 'missing-claim', 'ambiguous-claim'].includes(scenarioId)) {
        expect(run.callSid).toBeUndefined();
        expect(run.events.some((event) => event.type === 'twilio.request')).toBe(false);
      } else {
        expect(run.claimBrief?.claimId).toBe('SIM-CLAIM-42');
        expect(run.events.some((event) => event.type === 'twilio.request')).toBe(true);
        expect(run.events.some((event) => event.type === 'relay.received')).toBe(true);
      }
      expect(JSON.stringify(run)).not.toContain('api.twilio.com');
      const restored = await new VoiceCallSimService(root).get(OWNER, started.id);
      expect(restored).toEqual(run);
    }, 10_000,
  );

  it('selects dynamic menu digits and spoken choices from heard options', async () => {
    const standard = await completed(service, (await service.start(OWNER, 'standard-claim')).id);
    expect(standard.events.filter((event) => event.type === 'relay.send').map((event) => event.data.digits)).toEqual(['2', '1', '0']);
    const reordered = await completed(service, (await service.start(OWNER, 'reordered-menu')).id);
    expect(reordered.events.filter((event) => event.type === 'relay.send').map((event) => event.data.digits)).toEqual(['7', '0']);
    const spoken = await completed(service, (await service.start(OWNER, 'spoken-choice')).id);
    expect(spoken.events.find((event) => event.type === 'relay.send')?.data).toEqual({ type: 'text', token: 'claims' });
  });

  it('ignores songs and misleading lyric transcripts; never sends their digits', async () => {
    const run = await completed(service, (await service.start(OWNER, 'hold-music')).id);
    expect(run.events.filter((event) => event.type === 'relay.send' && event.data.type === 'sendDigits').map((event) => event.data.digits)).toEqual(['2']);
    expect(run.events.filter((event) => event.type === 'agent.interpreted' && event.data.reason === 'hold_audio_or_silence')).toHaveLength(3);
    expect(run.elapsedSeconds).toBeGreaterThan(200);
  });

  it('abstains from voicemail, ambiguous or low-confidence prompts', () => {
    expect(interpretSimAudio({ kind: 'speech', speaker: 'ivr', text: 'For claims press 2 or 3', confidence: 0.98 }).action).toBe('stop');
    expect(interpretSimAudio({ kind: 'speech', speaker: 'ivr', text: 'For claims press 2', confidence: 0.1 }).action).toBe('stop');
    expect(interpretSimAudio({ kind: 'speech', speaker: 'ivr', text: 'Please leave a message after the tone', confidence: 0.99 }).action).toBe('stop');
    expect(interpretSimAudio({ kind: 'speech', speaker: 'unknown', text: 'For claims press 7', confidence: 0.99 }).action).toBe('stop');
    expect(interpretSimAudio({ kind: 'human', speaker: 'unknown', confidence: 0.99 }).action).toBe('stop');
  });

  it('refuses real destinations and cross-owner reads in manual mode', async () => {
    const run = await service.start(OWNER, 'manual');
    await expect(service.get(OTHER, run.id)).rejects.toMatchObject({ code: 'run_not_found', status: 404 });
    await expect(service.feed(OWNER, run.id, { kind: 'speech', text: 'For claims press 2', confidence: 0.99 })).rejects.toMatchObject({ code: 'call_not_running' });
    await expect(service.dial(OWNER, run.id, MOCK_CALLER, '+18005551212')).rejects.toMatchObject({ code: 'synthetic_numbers_only' });
    const call = await service.dial(OWNER, run.id, MOCK_CALLER, MOCK_INSURER);
    expect(call.status).toBe('queued');
    await expect(service.dial(OWNER, run.id, MOCK_CALLER, MOCK_INSURER)).rejects.toMatchObject({ code: 'call_already_started' });
    await expect(service.feed(OWNER, run.id, { kind: 'speech', text: 'For claims press 2', confidence: 0.99, extra: 'injected' } as never))
      .rejects.toMatchObject({ code: 'invalid_mock_audio_event' });
    const next = await service.feed(OWNER, run.id, { kind: 'speech', speaker: 'ivr', text: 'For claims press 2', confidence: 0.99 });
    expect(next.events.some((event) => event.type === 'relay.send' && event.data.digits === '2')).toBe(true);
    const final = await service.feed(OWNER, run.id, { kind: 'human', speaker: 'human', confidence: 0.99, ownerAnswers: true });
    expect(final.outcome).toBe('bridged');
    expect(final.conferenceSid).toMatch(/^CF/);
    expect((await service.conference(OWNER, run.id, final.conferenceSid!)).participants).toEqual([final.callSid, final.ownerCallSid]);
    await expect(service.feed(OWNER, run.id, { kind: 'music' })).rejects.toMatchObject({ code: 'call_not_running' });
  });

  it('persists a report with the data received and decisions taken', async () => {
    const run = await completed(service, (await service.start(OWNER, 'hold-music')).id);
    const data = await readFile(path.join(root, createHash('sha256').update(OWNER).digest('hex').slice(0, 32), `${run.id}.json`), 'utf8');
    const report = JSON.parse(data);
    expect(report.events.some((event: { type: string; data: { text?: string } }) => event.type === 'relay.received' && event.data.text?.includes('dance all night'))).toBe(true);
    expect(report.events.some((event: { type: string }) => event.type === 'run.completed')).toBe(true);
  });

  it('does not query mock mail for a speaker mismatch or dial without one unambiguous claim', async () => {
    for (const [scenarioId, reason] of [
      ['speaker-mismatch', 'speaker_not_matched'], ['missing-claim', 'claim_not_found'], ['ambiguous-claim', 'claim_ambiguous'],
    ]) {
      const run = await completed(service, (await service.start(OWNER, scenarioId)).id);
      expect(run.reason).toBe(reason);
      expect(run.callSid).toBeUndefined();
      if (scenarioId === 'speaker-mismatch') expect(run.events.some((event) => event.type === 'mail.mock_request')).toBe(false);
    }
  });
});

describe('mock phone HTTP endpoints and Jarvis tool', () => {
  let root: string;
  let service: VoiceCallSimService;
  let server: Server;
  let base: string;
  const priorSecret = process.env.SWARM_SERVICE_SECRET;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'oshal-voice-sim-http-'));
    service = new VoiceCallSimService(root);
    process.env.SWARM_SERVICE_SECRET = SECRET;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.headers['x-test-user']) (req as any).oidc = {
        user: { sub: req.headers['x-test-user'] }, isAuthenticated: () => true,
      };
      if (req.headers['x-stale-user']) (req as any).oidc = {
        user: { sub: req.headers['x-stale-user'] }, isAuthenticated: () => false,
      };
      next();
    });
    const auth: RequestHandler = (req, res, next) => {
      if ((req as express.Request & { oidc?: { isAuthenticated?: () => boolean } }).oidc?.isAuthenticated?.()) next();
      else res.status(401).json({ error: 'auth_required' });
    };
    app.use(MOUNT, createVoiceCallSimRoutes(auth, service));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}${MOUNT}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    if (priorSecret === undefined) delete process.env.SWARM_SERVICE_SECRET;
    else process.env.SWARM_SERVICE_SECRET = priorSecret;
  });

  async function request(method: string, route: string, data?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...headers },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }
  const machine = (sub?: string) => ({ 'x-service-secret': SECRET,
    ...(sub ? { 'x-oshal-user-sub-b64': Buffer.from(sub).toString('base64url') } : {}) });

  it('requires authentication and exact owner binding on every mock surface', async () => {
    expect((await request('GET', '/scenarios')).status).toBe(401);
    expect((await request('POST', '/runs', { scenarioId: 'manual' }, machine())).status).toBe(403);
    const created = await request('POST', '/runs', { scenarioId: 'manual' }, machine(OWNER));
    expect(created.status).toBe(202);
    const id = created.body.runId;
    expect((await request('GET', `/mock-data/identity?runId=${id}`, undefined, machine(OWNER))).body.authorizationSource)
      .toBe('authenticated_owner_not_voice');
    expect((await request('GET', `/mock-data/mail?runId=${id}`, undefined, machine(OWNER))).body.messages[0].claimId)
      .toBe('SIM-CLAIM-42');
    expect((await request('GET', `/mock-data/mail?runId=${id}`, undefined, machine(OTHER))).status).toBe(404);
    expect((await request('GET', `/runs/${id}`, undefined, machine(OTHER))).status).toBe(404);
    expect((await request('GET', `/runs/${id}`, undefined, { 'x-test-user': OWNER })).status).toBe(200);
    expect((await request('GET', `/runs/${id}`, undefined, { ...machine(OWNER), 'x-stale-user': OTHER })).status).toBe(200);
    expect((await request('GET', `/runs/${id}`, undefined, { ...machine(OTHER), 'x-stale-user': OWNER })).status).toBe(404);
    expect((await request('POST', '/runs', { scenarioId: 'manual' }, { 'x-test-user': OWNER })).status).toBe(403);
    expect((await request('POST', '/runs', { scenarioId: 'manual' }, {
      'x-test-user': OWNER, origin: new URL(base).origin, 'x-oshal-voice-sim': '1',
    })).status).toBe(202);
    expect((await request('POST', '/mock-twilio/Accounts/ACSIMULATED/Calls.json',
      { runId: id, From: MOCK_CALLER, To: '+18005551212' }, machine(OWNER))).status).toBe(400);
    expect((await request('GET', '/mock-twilio/Accounts/ACWRONG/Calls/CAwrong.json?runId=' + id, undefined, machine(OWNER))).status).toBe(400);
  });

  it('returns fake Calls/Conference responses and records relay frames', async () => {
    const id = (await request('POST', '/runs', { scenarioId: 'manual' }, machine(OWNER))).body.runId;
    const dial = await request('POST', '/mock-twilio/Accounts/ACSIMULATED/Calls.json',
      { runId: id, From: MOCK_CALLER, To: MOCK_INSURER }, machine(OWNER));
    expect(dial.status).toBe(201);
    expect(dial.body.sid).toMatch(/^CA/);
    expect((await request('GET', `/mock-twilio/Accounts/ACSIMULATED/Calls/${dial.body.sid}.json?runId=${id}`, undefined, machine(OWNER))).body.status).toBe('in-progress');
    const lyric = await request('POST', `/runs/${id}/relay`, { kind: 'music', text: 'Press nine', musicConfidence: 0.99 }, machine(OWNER));
    expect(lyric.status).toBe(200);
    expect(lyric.body.events.some((event: { type: string }) => event.type === 'relay.send')).toBe(false);
    const choice = await request('POST', `/runs/${id}/relay`, { kind: 'speech', speaker: 'ivr', confidence: 0.98, text: 'For claims press 7.' }, machine(OWNER));
    expect(choice.body.events.some((event: { type: string; data: { digits?: string } }) => event.type === 'relay.send' && event.data.digits === '7')).toBe(true);
    const handoff = await request('POST', `/runs/${id}/relay`, { kind: 'human', speaker: 'human', confidence: 0.99 }, machine(OWNER));
    expect(handoff.body.outcome).toBe('bridged');
    expect((await request('GET', `/mock-twilio/Accounts/ACSIMULATED/Conferences/${handoff.body.conferenceSid}.json?runId=${id}`, undefined, machine(OWNER))).body.participants).toHaveLength(2);
  });

  it('records duplicate/out-of-order carrier callbacks without rewinding or bridging', async () => {
    const id = (await request('POST', '/runs', { scenarioId: 'manual' }, machine(OWNER))).body.runId;
    const dial = await request('POST', '/mock-twilio/Accounts/ACSIMULATED/Calls.json',
      { runId: id, From: MOCK_CALLER, To: MOCK_INSURER }, machine(OWNER));
    const callbackUrl = `/runs/${id}/callback`;
    expect((await request('POST', callbackUrl, { CallSid: 'CAwrong', CallStatus: 'completed' }, machine(OWNER))).status).toBe(400);
    const old = await request('POST', callbackUrl, { CallSid: dial.body.sid, CallStatus: 'ringing' }, machine(OWNER));
    expect(old.body.events.at(-1).data.reason).toBe('out_of_order');
    const duplicate = await request('POST', callbackUrl, { CallSid: dial.body.sid, CallStatus: 'in-progress' }, machine(OWNER));
    expect(duplicate.body.events.at(-1).data.reason).toBe('duplicate');
    const ended = await request('POST', callbackUrl, { CallSid: dial.body.sid, CallStatus: 'completed' }, machine(OWNER));
    expect(ended.body.outcome).toBe('safe-stop');
    expect(ended.body.reason).toBe('insurer_completed');
    expect(ended.body.conferenceSid).toBeUndefined();
    const repeated = await request('POST', callbackUrl, { CallSid: dial.body.sid, CallStatus: 'completed' }, machine(OWNER));
    expect(repeated.body.events).toHaveLength(ended.body.events.length);
  });

  it('advertises the simulation tool to Jarvis and the CLI starts the background service', async () => {
    expect(buildToolsBlock({ message: 'run a mock call with hold music' })).toContain('node /app/scripts/oshal-voice-sim.js');
    const script = path.resolve(__dirname, '../../scripts/oshal-voice-sim.js');
    const env = { ...process.env, SWARM_SERVICE_SECRET: SECRET, OSHAL_USER_SUB: OWNER, OSHAL_VOICE_SIM_API_BASE: base.slice(0, -MOUNT.length) };
    const output = await execFileAsync(process.execPath, [script, 'start', 'hold-music'], { cwd: path.resolve(__dirname, '../..'), env, encoding: 'utf8' });
    const result = JSON.parse(output.stdout);
    expect(result.synthetic).toBe(true);
    const run = await completed(service, result.runId);
    expect(run.assessment?.passed).toBe(true);
    const report = JSON.parse((await execFileAsync(process.execPath, [script, 'report', result.runId], { cwd: path.resolve(__dirname, '../..'), env, encoding: 'utf8' })).stdout);
    expect(report.id).toBe(result.runId);
    expect(report.events.some((event: { type: string }) => event.type === 'agent.interpreted')).toBe(true);
  });
});
