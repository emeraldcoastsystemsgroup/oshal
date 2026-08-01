/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for INSTALLER-GAPS G9 + G7 + G2 (readiness legs): a silent FORCE_LLM_PROVIDER=noop must FAIL the llm leg unless OSHAL_NO_AI is declared; a routing-critical bot whose harness has no credential must FAIL the credentials leg BY NAME (the "starts, heartbeats, fails on first use" trap); a missing heartbeat fails the bots leg; voice fails only when declared-but-unconfigured; and the summary line stays in the exact `leg=state` token format scripts/oshal-verify.sh greps — that summary IS the shell contract, so this spec pins it.
 */

import { describe, it, expect } from 'vitest';

import {
  buildReadinessReport,
  type ReadinessDeps,
  type VoiceSideStatus,
} from '@/app/routes/readiness-routes';

const VOICE_OFF: VoiceSideStatus = { providerId: 'gemini-tts', configured: false, declared: false, browser: false };

function deps(overrides: Partial<ReadinessDeps> = {}): ReadinessDeps {
  return {
    activeProvider: () => 'claude-code',
    forcedProvider: () => null,
    noAiDeclared: () => false,
    criticalBots: () => [
      { agentId: 'a-1', name: 'jarvis-bot', harnessType: 'codex-cli' },
      { agentId: 'a-2', name: 'general-bot', harnessType: null },
    ],
    onlineAgentIds: async () => ['a-1', 'a-2'],
    credentialPresent: () => true,
    defaultHarness: () => 'codex-cli',
    voiceStatus: async () => VOICE_OFF,
    dbOk: async () => true,
    ...overrides,
  };
}

describe('buildReadinessReport (INSTALLER-GAPS G9/G7/G2)', () => {
  it('healthy box: ready, and the summary keeps the shell-contract token format', async () => {
    const r = await buildReadinessReport(deps());
    expect(r.ready).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.summary).toBe('llm=ok bots=ok credentials=ok voice.tts=off voice.stt=off db=ok');
  });

  it('G2: FORCE_LLM_PROVIDER=noop without the OSHAL_NO_AI declaration FAILS the llm leg', async () => {
    const r = await buildReadinessReport(deps({ forcedProvider: () => 'noop', activeProvider: () => null }));
    expect(r.ready).toBe(false);
    expect(r.legs.llm.state).toBe('fail');
    expect(r.problems.join(' ')).toContain('OSHAL_NO_AI');
  });

  it('G2: the same posture WITH the declaration is off, not fail', async () => {
    const r = await buildReadinessReport(deps({
      forcedProvider: () => 'noop', activeProvider: () => null, noAiDeclared: () => true,
    }));
    expect(r.legs.llm.state).toBe('off');
    expect(r.legs.credentials.state).toBe('off');
    expect(r.ready).toBe(true);
  });

  it('no provider at all: fail undeclared, off when declared', async () => {
    const base = { forcedProvider: () => null, activeProvider: () => null };
    expect((await buildReadinessReport(deps(base))).legs.llm.state).toBe('fail');
    expect((await buildReadinessReport(deps({ ...base, noAiDeclared: () => true }))).legs.llm.state).toBe('off');
  });

  it('bots: a missing heartbeat fails the leg and names the bot', async () => {
    const r = await buildReadinessReport(deps({ onlineAgentIds: async () => ['a-2'] }));
    expect(r.ready).toBe(false);
    expect(r.legs.bots.state).toBe('fail');
    expect(r.legs.bots.detail).toContain('jarvis-bot');
  });

  it('bots: unreadable runtime registry is a failure, not a shrug', async () => {
    const r = await buildReadinessReport(deps({ onlineAgentIds: async () => null }));
    expect(r.legs.bots.state).toBe('fail');
  });

  it('bots: an absent critical list reports off (scope unknown), not a false green-fail', async () => {
    const r = await buildReadinessReport(deps({ criticalBots: () => null }));
    expect(r.legs.bots.state).toBe('off');
    expect(r.ready).toBe(true);
  });

  it('G7: a pinned harness with no credential FAILS, naming bot + harness + fix', async () => {
    const r = await buildReadinessReport(deps({
      credentialPresent: (h: string) => (h === 'codex-cli' ? false : true),
    }));
    expect(r.ready).toBe(false);
    expect(r.legs.credentials.state).toBe('fail');
    expect(r.legs.credentials.detail).toContain('jarvis-bot');
    expect(r.legs.credentials.detail).toContain('codex-cli');
    expect(r.legs.credentials.detail).toContain('fails on first use');
  });

  it('G7: the process-default harness applies to bots without a pin', async () => {
    const r = await buildReadinessReport(deps({
      defaultHarness: () => 'claude-code',
      credentialPresent: (h: string) => (h === 'claude-code' ? false : true),
    }));
    expect(r.legs.credentials.state).toBe('fail');
    expect(r.legs.credentials.detail).toContain('general-bot');
    expect(r.legs.credentials.detail).toContain('claude-code');
  });

  it('voice: declared-but-unconfigured fails; undeclared is off; configured is ok; browser is off', async () => {
    const cases: Array<[VoiceSideStatus, string]> = [
      [{ providerId: 'google-cloud-tts', configured: false, declared: true, browser: false }, 'fail'],
      [{ providerId: 'gemini-tts', configured: false, declared: false, browser: false }, 'off'],
      [{ providerId: 'google-cloud-tts', configured: true, declared: true, browser: false }, 'ok'],
      [{ providerId: 'browser-tts', configured: true, declared: false, browser: true }, 'off'],
    ];
    for (const [status, expected] of cases) {
      const r = await buildReadinessReport(deps({ voiceStatus: async () => status }));
      expect(r.legs.voiceTts.state).toBe(expected);
    }
  });

  it('db down fails the report', async () => {
    const r = await buildReadinessReport(deps({ dbOk: async () => false }));
    expect(r.ready).toBe(false);
    expect(r.legs.db.state).toBe('fail');
  });
});
