/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Persist owner-scoped synthetic call traces and drive mock IVR/handoff scenarios asynchronously.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Standard Change Log block; the scenario driver logs the failure that interrupts a run and a trace write that fails while recording that interruption (both were silent), and JSDoc on the exported members.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | JSDoc on the three fictional 555 numbers (caller, insurer, owner), which the voice-sim spec imports; they were the last exports without a description.
 */
/**
 * In-process Twilio-shaped simulator. Its only destinations are fictional 555 numbers; it never
 * imports the live voice transport, Twilio credentials, or an external HTTP client.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  VOICE_SIM_MANUAL, VOICE_SIM_SCENARIOS, interpretSimAudio,
  type SimAudioEvent, type SimScenario,
} from './voice-call-sim-scenarios';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'voice-call-sim-service' });

/** @description The only account id the mock Twilio-shaped routes accept. */
export const MOCK_TWILIO_ACCOUNT = 'ACSIMULATED';
/** @description Fictional 555 number the simulated assistant dials from; the only allowed From number. */
export const MOCK_CALLER = '+12025550100';
/** @description Fictional 555 number of the simulated insurer phone tree; the only allowed outbound To number. */
export const MOCK_INSURER = '+12025550101';
/** @description Fictional 555 number of the simulated account owner, bridged in when a human answers. */
export const MOCK_OWNER = '+12025550102';
const MAX_SECONDS = 1_200;
const MAX_EVENTS = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RunStatus = 'queued' | 'waiting' | 'running' | 'finishing' | 'completed' | 'interrupted';
type Outcome = 'bridged' | 'safe-stop';
/** @description One bounded, sequenced entry in a run trace. */
export interface VoiceSimTraceEvent {
  seq: number;
  at: string;
  type: string;
  data: Record<string, unknown>;
}
/** @description One owner-scoped synthetic run, persisted as JSON and assessed when it finishes. */
export interface VoiceSimRun {
  id: string;
  scenarioId: string;
  title: string;
  synthetic: true;
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  outcome?: Outcome;
  reason?: string;
  callSid?: string;
  callStatus?: 'queued' | 'ringing' | 'in-progress' | 'completed' | 'failed' | 'no-answer';
  ownerCallSid?: string;
  conferenceSid?: string;
  claimBrief?: { insurer: string; claimId: string; policyId: string; sourceMessageId: string };
  elapsedSeconds: number;
  estimatedVoiceCostUsd: number;
  assessment?: { passed: boolean | null; expected: Outcome | null; checks: Record<string, boolean> };
  events: VoiceSimTraceEvent[];
}

/** @description A refusal with a stable code and the HTTP status the router answers with. */
export class VoiceSimError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
const err = (code: string, status = 400): never => { throw new VoiceSimError(code, status); };
const copy = <T>(value: T): T => structuredClone(value);
const ownerHash = (sub: string): string => createHash('sha256').update(sub).digest('hex').slice(0, 32);
const newSid = (prefix: 'CA' | 'CF'): string => prefix + randomUUID().replace(/-/g, '');

/** @description The simulator is deliberately a separate service; the HTTP router and Jarvis CLI share it. */
export class VoiceCallSimService {
  private readonly runs = new Map<string, VoiceSimRun>();
  private readonly root: string;

  constructor(root = process.env.OSHAL_VOICE_SIM_ROOT || path.join(existsSync('/app/output') ? '/app/output' : tmpdir(), 'oshal-voice-sim')) {
    this.root = root;
  }

  /** @description The scripted scenarios plus the manual run, as id, title and expected outcome. @returns The list. */
  scenarios(): Array<{ id: string; title: string; expected: string }> {
    return [
      ...VOICE_SIM_SCENARIOS.map(({ id, title, expected }) => ({ id, title, expected })),
      { id: VOICE_SIM_MANUAL, title: 'Manual mock API and relay event feed', expected: 'operator-driven' },
    ];
  }

  private key(sub: string, id: string): string { return `${ownerHash(sub)}:${id}`; }
  private file(sub: string, id: string): string {
    if (!UUID.test(id)) err('invalid_run_id');
    return path.join(this.root, ownerHash(sub), `${id}.json`);
  }
  private async save(sub: string, run: VoiceSimRun): Promise<void> {
    const file = this.file(sub, run.id);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(run, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, file);
  }
  private async row(sub: string, id: string): Promise<VoiceSimRun> {
    const key = this.key(sub, id);
    const cached = this.runs.get(key);
    if (cached) return cached;
    try {
      const parsed = JSON.parse(await readFile(this.file(sub, id), 'utf8')) as VoiceSimRun;
      if (parsed.id !== id || parsed.synthetic !== true) err('run_not_found', 404);
      // A queued in-memory worker cannot be recovered across a controller restart.
      if (parsed.status !== 'completed') {
        parsed.status = 'interrupted';
        parsed.reason = 'controller_restarted';
      }
      this.runs.set(key, parsed);
      return parsed;
    } catch (error) {
      if (error instanceof VoiceSimError) throw error;
      return err('run_not_found', 404);
    }
  }
  /** @description A copy of one of the owner's runs. @param sub - Owner subject. @param id - Run id. @returns The run. */
  async get(sub: string, id: string): Promise<VoiceSimRun> { return copy(await this.row(sub, id)); }
  private async emit(sub: string, run: VoiceSimRun, type: string, data: Record<string, unknown>): Promise<void> {
    // The trace is intentionally bounded. It is assessable without becoming a transcript dump.
    if (run.events.length >= 256) err('trace_limit', 429);
    run.events.push({ seq: run.events.length + 1, at: new Date().toISOString(), type, data });
    run.updatedAt = new Date().toISOString();
    await this.save(sub, run);
  }

  /**
   * @description Start a scripted run in the background, or a manual run that waits for mock calls.
   * @param sub - Owner subject. @param scenarioId - A scripted scenario id or the manual id.
   * @returns A copy of the new run.
   */
  async start(sub: string, scenarioId: string): Promise<VoiceSimRun> {
    const scenario = VOICE_SIM_SCENARIOS.find((item) => item.id === scenarioId);
    if (!scenario && scenarioId !== VOICE_SIM_MANUAL) err('unknown_scenario');
    if ([...this.runs.keys()].filter((key) => key.startsWith(ownerHash(sub) + ':')).length >= 1_000) err('run_limit', 429);
    const now = new Date().toISOString();
    const run: VoiceSimRun = {
      id: randomUUID(), scenarioId, title: scenario?.title ?? 'Manual mock API and relay event feed',
      synthetic: true, createdAt: now, updatedAt: now,
      status: scenario ? 'queued' : 'waiting', elapsedSeconds: 0, estimatedVoiceCostUsd: 0, events: [],
    };
    this.runs.set(this.key(sub, run.id), run);
    await this.emit(sub, run, 'run.started', { scenarioId, synthetic: true, externalCalls: false });
    if (!scenario) await this.prepare(sub, run);
    if (scenario) setImmediate(() => { void this.drive(sub, run, scenario).catch(async (error: unknown) => {
      logger.error({ err: error, runId: run.id, scenarioId }, 'Voice simulator scenario interrupted');
      if (run.status === 'completed') return;
      run.status = 'interrupted'; run.reason = 'simulation_error';
      try {
        await this.emit(sub, run, 'run.interrupted', { reason: 'simulation_error' });
      } catch (persistError) {
        // Persistence fault: the in-memory run keeps the interrupted status.
        logger.error({ err: persistError, runId: run.id }, 'Voice simulator could not record the interruption');
      }
    }); });
    return copy(run);
  }

  /** @description Fake person lookup; the real owner comes only from the authenticated route, never this fixture. @returns The fixture response. */
  async identity(sub: string, id: string, record = true): Promise<Record<string, unknown>> {
    const run = await this.row(sub, id);
    const mismatch = VOICE_SIM_SCENARIOS.find((item) => item.id === run.scenarioId)?.preflight === 'speaker-mismatch';
    const response = { synthetic: true, speakerProfile: 'fixture-speaker-001',
      matchConfidence: mismatch ? 0.22 : 0.97, authorizationSource: 'authenticated_owner_not_voice' };
    if (record) {
      await this.emit(sub, run, 'identity.mock_request', { provider: 'synthetic-speaker-directory' });
      await this.emit(sub, run, 'identity.mock_response', response);
    }
    return response;
  }

  /** @description Fake inbox lookup; never connects to Gmail/Outlook or uses a real claim. @returns The fixture messages. */
  async mail(sub: string, id: string, record = true): Promise<Record<string, unknown>> {
    const run = await this.row(sub, id);
    const fixture = VOICE_SIM_SCENARIOS.find((item) => item.id === run.scenarioId)?.preflight;
    if (fixture === 'speaker-mismatch') err('speaker_not_matched', 403);
    const normal = { id: 'MSG-SIM-1', from: 'claims@sample-insurance.test',
      claimId: 'SIM-CLAIM-42', policyId: 'SIM-POLICY-7', insurer: 'Sample Insurance (fictional)' };
    const messages = fixture === 'no-claim' ? [] : fixture === 'ambiguous-claim'
      ? [normal, { ...normal, id: 'MSG-SIM-2', claimId: 'SIM-CLAIM-99' }] : [normal];
    const response = { synthetic: true, messages };
    if (record) {
      await this.emit(sub, run, 'mail.mock_request', { provider: 'synthetic-inbox', query: 'insurance claim' });
      await this.emit(sub, run, 'mail.mock_response', response);
    }
    return response;
  }

  private async prepare(sub: string, run: VoiceSimRun): Promise<boolean> {
    const identity = await this.identity(sub, run.id);
    if (Number(identity.matchConfidence) < 0.8) {
      await this.finish(sub, run, 'safe-stop', 'speaker_not_matched');
      return false;
    }
    const mail = await this.mail(sub, run.id) as { messages: Array<{ id: string; from: string; claimId: string; policyId: string; insurer: string }> };
    if (mail.messages.length !== 1) {
      await this.finish(sub, run, 'safe-stop', mail.messages.length ? 'claim_ambiguous' : 'claim_not_found');
      return false;
    }
    const message = mail.messages[0];
    run.claimBrief = { insurer: message.insurer, claimId: message.claimId, policyId: message.policyId, sourceMessageId: message.id };
    await this.emit(sub, run, 'claim.brief_ready', { ...run.claimBrief, synthetic: true });
    return true;
  }

  /** @description Twilio Calls API-shaped operation; both the preset worker and mock HTTP endpoint use it. Only the fictional 555 numbers are accepted. @returns The mock call resource. */
  async dial(sub: string, id: string, from: string, to: string): Promise<Record<string, unknown>> {
    const run = await this.row(sub, id);
    if (run.scenarioId !== VOICE_SIM_MANUAL && run.status !== 'queued') err('call_already_started', 409);
    if (run.scenarioId === VOICE_SIM_MANUAL && run.status !== 'waiting') err('call_already_started', 409);
    if (from !== MOCK_CALLER || to !== MOCK_INSURER) err('synthetic_numbers_only');
    const sid = newSid('CA');
    const response = { sid, account_sid: MOCK_TWILIO_ACCOUNT, status: 'queued', from, to };
    await this.emit(sub, run, 'twilio.request', { method: 'POST', path: `/Accounts/${MOCK_TWILIO_ACCOUNT}/Calls.json`, body: { From: from, To: to } });
    run.callSid = sid;
    run.callStatus = 'in-progress';
    run.status = 'running';
    await this.emit(sub, run, 'twilio.response', response);
    await this.emit(sub, run, 'twilio.callback', { CallSid: sid, CallStatus: 'in-progress' });
    return response;
  }

  /** @description Read one mock call leg of a run. @returns The mock call resource. */
  async call(sub: string, id: string, sid: string): Promise<Record<string, unknown>> {
    const run = await this.row(sub, id);
    if (sid !== run.callSid && sid !== run.ownerCallSid) err('call_not_found', 404);
    return { sid, account_sid: MOCK_TWILIO_ACCOUNT,
      status: sid === run.callSid ? run.callStatus : (run.reason === 'owner_no_answer' ? 'no-answer' : 'in-progress'),
      from: MOCK_CALLER, to: sid === run.callSid ? MOCK_INSURER : MOCK_OWNER };
  }

  /** @description Accept a synthetic Twilio status callback; duplicates/late regressions cannot rewind a call. @returns A copy of the run. */
  async callback(sub: string, id: string, input: { CallSid: string; CallStatus: string }): Promise<VoiceSimRun> {
    const run = await this.row(sub, id);
    if (run.scenarioId !== VOICE_SIM_MANUAL) err('manual_run_required', 409);
    if (!input || typeof input !== 'object' || Object.keys(input).some((key) => !['CallSid', 'CallStatus'].includes(key))
      || input.CallSid !== run.callSid || !['queued', 'ringing', 'in-progress', 'completed', 'failed', 'no-answer'].includes(input.CallStatus)) {
      err('invalid_mock_callback');
    }
    if (run.status !== 'running') return copy(run);
    await this.emit(sub, run, 'twilio.callback.received', { CallSid: input.CallSid, CallStatus: input.CallStatus });
    const order: Record<string, number> = { queued: 0, ringing: 1, 'in-progress': 2, completed: 3, failed: 3, 'no-answer': 3 };
    const previous = run.callStatus ?? 'queued';
    if (input.CallStatus === previous || order[input.CallStatus] < order[previous]) {
      await this.emit(sub, run, 'twilio.callback.ignored', { reason: input.CallStatus === previous ? 'duplicate' : 'out_of_order', previous });
      return copy(run);
    }
    run.callStatus = input.CallStatus as VoiceSimRun['callStatus'];
    await this.emit(sub, run, 'twilio.callback.accepted', { CallStatus: input.CallStatus });
    if (['completed', 'failed', 'no-answer'].includes(input.CallStatus)) {
      await this.finish(sub, run, 'safe-stop', `insurer_${input.CallStatus}`);
    }
    return copy(run);
  }

  /** @description Read the mock conference a bridged run created. @returns The mock conference resource. */
  async conference(sub: string, id: string, sid: string): Promise<Record<string, unknown>> {
    const run = await this.row(sub, id);
    if (sid !== run.conferenceSid) err('conference_not_found', 404);
    return { sid, account_sid: MOCK_TWILIO_ACCOUNT, status: 'in-progress', participants: [run.callSid, run.ownerCallSid] };
  }

  /** @description Inject one bounded mock relay/audio event. No waveform or STT inference is performed here. @returns A copy of the run. */
  async feed(sub: string, id: string, event: SimAudioEvent): Promise<VoiceSimRun> {
    const run = await this.row(sub, id);
    if (run.status !== 'running' || !run.callSid) err('call_not_running', 409);
    if (!event || typeof event !== 'object' || Array.isArray(event)
      || Object.keys(event).some((key) => !['kind', 'text', 'confidence', 'musicConfidence', 'speaker', 'durationSec', 'ownerAnswers'].includes(key))
      || Buffer.byteLength(JSON.stringify(event)) > 2_048
      || !['speech', 'music', 'silence', 'human', 'disconnect'].includes(event.kind)
      || (event.text !== undefined && (typeof event.text !== 'string' || event.text.length > 1_000))
      || (event.durationSec !== undefined && (!Number.isInteger(event.durationSec) || event.durationSec < 0 || event.durationSec > 3_600))
      || (event.confidence !== undefined && (!Number.isFinite(event.confidence) || event.confidence < 0 || event.confidence > 1))
      || (event.musicConfidence !== undefined && (!Number.isFinite(event.musicConfidence) || event.musicConfidence < 0 || event.musicConfidence > 1))
      || (event.speaker !== undefined && !['ivr', 'human', 'unknown'].includes(event.speaker))
      || (event.ownerAnswers !== undefined && typeof event.ownerAnswers !== 'boolean')) err('invalid_mock_audio_event');
    if (run.events.filter((item) => item.type === 'relay.received').length >= MAX_EVENTS) {
      await this.finish(sub, run, 'safe-stop', 'event_limit');
      return copy(run);
    }
    run.elapsedSeconds += event.durationSec ?? (event.kind === 'silence' ? 10 : 5);
    // Illustrative US voice + active relay estimate; not a Twilio invoice or account rate.
    run.estimatedVoiceCostUsd = Math.round((Math.ceil(run.elapsedSeconds / 60) * 0.084) * 100) / 100;
    await this.emit(sub, run, 'relay.received', { ...event });
    if (run.elapsedSeconds > MAX_SECONDS) {
      await this.finish(sub, run, 'safe-stop', 'time_budget_exceeded');
      return copy(run);
    }
    const decision = interpretSimAudio(event);
    await this.emit(sub, run, 'agent.interpreted', { ...decision });
    if (decision.action === 'digits') {
      await this.emit(sub, run, 'relay.send', { type: 'sendDigits', digits: decision.value });
    } else if (decision.action === 'say') {
      await this.emit(sub, run, 'relay.send', { type: 'text', token: decision.value });
    } else if (decision.action === 'bridge') {
      await this.bridge(sub, run, event.ownerAnswers !== false);
    } else if (decision.action === 'stop') {
      await this.finish(sub, run, 'safe-stop', decision.reason);
    }
    return copy(run);
  }

  /** @description Hang up the insurer leg of a running call and finish the run as a safe stop. @returns A copy of the run. */
  async hangup(sub: string, id: string, sid: string): Promise<VoiceSimRun> {
    const run = await this.row(sub, id);
    if (run.callSid !== sid) err('call_not_found', 404);
    if (run.status !== 'running') err('call_not_running', 409);
    await this.emit(sub, run, 'twilio.request', { method: 'POST', path: `/Accounts/${MOCK_TWILIO_ACCOUNT}/Calls/${sid}.json`, body: { Status: 'completed' } });
    run.callStatus = 'completed';
    await this.finish(sub, run, 'safe-stop', 'call_hung_up');
    return copy(run);
  }

  private async bridge(sub: string, run: VoiceSimRun, ownerAnswers: boolean): Promise<void> {
    // The mock is allowed to dial only the fictional owner 555 endpoint.
    const sid = newSid('CA');
    run.ownerCallSid = sid;
    await this.emit(sub, run, 'twilio.request', { method: 'POST', path: `/Accounts/${MOCK_TWILIO_ACCOUNT}/Calls.json`, body: { From: MOCK_CALLER, To: MOCK_OWNER } });
    await this.emit(sub, run, 'twilio.response', { sid, account_sid: MOCK_TWILIO_ACCOUNT, status: 'queued', from: MOCK_CALLER, to: MOCK_OWNER });
    await this.emit(sub, run, 'twilio.callback', { CallSid: sid, CallStatus: ownerAnswers ? 'in-progress' : 'no-answer' });
    if (!ownerAnswers) { await this.finish(sub, run, 'safe-stop', 'owner_no_answer'); return; }
    const conferenceSid = newSid('CF');
    run.conferenceSid = conferenceSid;
    for (const participant of [run.callSid, sid]) {
      await this.emit(sub, run, 'twilio.request', { method: 'POST', path: `/Accounts/${MOCK_TWILIO_ACCOUNT}/Conferences/${conferenceSid}/Participants.json`, body: { CallSid: participant } });
      await this.emit(sub, run, 'twilio.response', { conference_sid: conferenceSid, call_sid: participant, status: 'in-progress' });
    }
    await this.finish(sub, run, 'bridged', 'human_connected_to_owner');
  }

  private async finish(sub: string, run: VoiceSimRun, outcome: Outcome, reason: string): Promise<void> {
    if (run.status === 'completed' || run.status === 'finishing') return;
    run.status = 'finishing'; run.outcome = outcome; run.reason = reason;
    const expected = VOICE_SIM_SCENARIOS.find((item) => item.id === run.scenarioId)?.expected ?? null;
    const checks = {
      expectedOutcome: expected === null || outcome === expected,
      noRealDial: run.events.filter((item) => item.type === 'twilio.request').every((item) => {
        const body = item.data.body as Record<string, unknown> | undefined;
        return !body?.To || body.To === MOCK_INSURER || body.To === MOCK_OWNER;
      }),
      handoffOnlyAfterHuman: !run.conferenceSid || run.events.some((item) => item.type === 'agent.interpreted' && item.data.action === 'bridge'),
      claimBriefBeforeDial: !run.callSid || (() => {
        const brief = run.events.findIndex((item) => item.type === 'claim.brief_ready');
        const dial = run.events.findIndex((item) => item.type === 'twilio.request');
        return brief >= 0 && dial > brief;
      })(),
      noDigitsFromMusic: run.events.every((item, index) => {
        if (item.type !== 'relay.received' || (item.data.kind !== 'music' && Number(item.data.musicConfidence ?? 0) < 0.65)) return true;
        const tail = run.events.slice(index + 1);
        const nextInput = tail.findIndex((event) => event.type === 'relay.received');
        const response = nextInput < 0 ? tail : tail.slice(0, nextInput);
        return !response.some((event) => event.type === 'relay.send' && event.data.type === 'sendDigits');
      }),
    };
    run.assessment = { passed: expected === null ? null : Object.values(checks).every(Boolean), expected, checks };
    await this.emit(sub, run, 'run.completed', { outcome, reason, assessment: run.assessment });
    await this.save(sub, { ...run, status: 'completed' });
    run.status = 'completed';
  }

  private async drive(sub: string, run: VoiceSimRun, scenario: SimScenario): Promise<void> {
    if (!await this.prepare(sub, run)) return;
    await this.dial(sub, run.id, MOCK_CALLER, MOCK_INSURER);
    for (const event of scenario.events) {
      if (run.status === 'completed') break;
      await this.feed(sub, run.id, event);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (run.status !== 'completed') await this.finish(sub, run, 'safe-stop', 'scenario_exhausted');
  }
}
