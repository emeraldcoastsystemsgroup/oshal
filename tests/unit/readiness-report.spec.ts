/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for INSTALLER-GAPS G9 + G7 + G2 (readiness legs): a silent FORCE_LLM_PROVIDER=noop must FAIL the llm leg unless OSHAL_NO_AI is declared; a routing-critical bot whose harness has no credential must FAIL the credentials leg BY NAME (the "starts, heartbeats, fails on first use" trap); a missing heartbeat fails the bots leg; voice fails only when declared-but-unconfigured; and the summary line stays in the exact `leg=state` token format scripts/oshal-verify.sh greps — that summary IS the shell contract, so this spec pins it.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Moved with the `catalogs` leg instead of being left behind by it. The leg shipped and this spec did not: ReadinessDeps grew catalogLoads/degradedCatalogLoads, the fixture did not, and all 11 cases died on `deps.catalogLoads is not a function` — the feature landing without its guard, which is the thing guard-per-fix exists to stop. The fixture now wires the REAL @/shared/observability registry (reset per test, seeded through the real recordCatalogLoad) rather than stubbing the leg away, so these cases exercise the same code path production does; the shell-contract summary assertion carries the new token; and a catalog-less boot is asserted RED here too, not only in catalog-load-readiness.spec.ts.
 */

import { beforeEach, describe, it, expect } from 'vitest';

import {
  buildReadinessReport,
  type ReadinessDeps,
  type VoiceSideStatus,
} from '@/app/routes/readiness-routes';
import {
  degradedCatalogs,
  listCatalogLoads,
  recordCatalogLoad,
  resetCatalogLoads,
} from '@/shared/observability';

const VOICE_OFF: VoiceSideStatus = { providerId: 'gemini-tts', configured: false, declared: false, browser: false };

/**
 * A healthy connector catalog, recorded through the REAL registry the loader writes to —
 * the leg is exercised, not stubbed out. Every test starts from an empty registry so
 * "nothing loaded yet" and "loaded fine" are both reachable states.
 */
function seedHealthyCatalog(): void {
  recordCatalogLoad({
    catalog: 'connector-specs',
    source: '/app/swarm-apps/connectors',
    state: 'ok',
    discovered: 306,
    loaded: 306,
    attempts: 1,
  });
}

beforeEach(() => {
  resetCatalogLoads();
  seedHealthyCatalog();
});

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
    catalogLoads: listCatalogLoads,
    degradedCatalogLoads: degradedCatalogs,
    ...overrides,
  };
}

describe('buildReadinessReport (INSTALLER-GAPS G9/G7/G2)', () => {
  it('healthy box: ready, and the summary keeps the shell-contract token format', async () => {
    const r = await buildReadinessReport(deps());
    expect(r.ready).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.summary).toBe('llm=ok bots=ok credentials=ok catalogs=ok voice.tts=off voice.stt=off db=ok');
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

  it('catalogs: an ENOMEM-emptied connector catalog reds the report on an otherwise perfect box', async () => {
    // Everything else in this fixture is green. This is the 2026-08-01 boot: the api came
    // up with `ENOMEM: scandir '/app/swarm-apps/connectors'`, registered zero connector
    // tools, and reported ready:true. It must not any more.
    resetCatalogLoads();
    recordCatalogLoad({
      catalog: 'connector-specs',
      source: '/app/swarm-apps/connectors',
      state: 'unreadable',
      discovered: 0,
      loaded: 0,
      attempts: 3,
      detail: "ENOMEM: not enough memory, scandir '/app/swarm-apps/connectors'",
    });
    const r = await buildReadinessReport(deps());
    expect(r.ready).toBe(false);
    expect(r.legs.catalogs.state).toBe('fail');
    expect(r.summary).toContain('catalogs=fail');
    expect(r.problems.join(' ')).toContain('ENOMEM');
  });

  it('catalogs: nothing recorded is off (a build with no catalog-backed subsystem stays ready)', async () => {
    resetCatalogLoads();
    const r = await buildReadinessReport(deps());
    expect(r.legs.catalogs.state).toBe('off');
    expect(r.ready).toBe(true);
  });
});
