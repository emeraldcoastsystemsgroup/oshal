/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the live-acceptance Test Lab cards: exactly one explicit-only card per registered case (so "Run live scenarios" never writes fixtures or spends a model turn), each naming the host command and its backlog entry, every attached suite on disk, the shared case modules shipped in the api image; the signed-in adapter binds the caller's cookie to every loopback call and the named statements to the request pool, maps an unavailable case to a gap, and the host-only cases (commerce, Jarvis cache) answer that gap without a single call.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The registry gains the trading-parity case.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCENARIOS, scenariosForRun, type ScenarioRunContext } from '@/app/routes/test-lab-scenarios';
import { LIVE_ACCEPTANCE_SCENARIOS } from '@/app/routes/test-lab-live-acceptance-scenarios';
import { LIVE_ACCEPTANCE_CASES, labPorts, runLiveAcceptanceCase } from '@/app/routes/test-lab-live-acceptance';
import type { AppContext } from '@/app/composition/app-context';

describe('live-acceptance Test Lab cards', () => {
  it('registers one explicit-only card per case, with its host command and suites on disk', () => {
    expect(LIVE_ACCEPTANCE_SCENARIOS).toHaveLength(LIVE_ACCEPTANCE_CASES.length);
    expect(LIVE_ACCEPTANCE_CASES.map((c) => c.module.KEY)).toEqual(['response-renderer', 'congress', 'dev-workspace', 'floater', 'linkedin', 'commerce', 'lm-class-material', 'jarvis-cache', 'trading-parity']);
    for (const scenario of LIVE_ACCEPTANCE_SCENARIOS) {
      const key = scenario.id.replace(/^live-acceptance-/, '');
      expect(SCENARIOS.filter((s) => s.id === scenario.id)).toEqual([scenario]);
      expect(scenario.explicitOnly).toBe(true);
      expect(scenario.steps).toHaveLength(1);
      expect(scenario.description).toContain(`node scripts/operations/live-acceptance.js ${key}`);
      expect(scenario.description).toContain('Backlog: "');
      for (const test of scenario.regressionTests!) expect(existsSync(test.path), test.path).toBe(true);
    }
    const all = scenariosForRun('all').map((s) => s.id);
    expect(all.filter((id) => id.startsWith('live-acceptance-'))).toEqual([]);
    expect(scenariosForRun('live-acceptance-floater').map((s) => s.id)).toEqual(['live-acceptance-floater']);
  });

  it('ships every shared case module in the api image', () => {
    expect(readFileSync('Dockerfile.oshal', 'utf8')).toMatch(/^COPY scripts\/lib\/\*\.js \.\/scripts\/lib\/$/m);
    expect(readFileSync('.dockerignore', 'utf8')).toMatch(/^!scripts\/lib\/\*\.js$/m);
    for (const entry of LIVE_ACCEPTANCE_CASES) expect(existsSync(`scripts/lib/live-acceptance-${entry.module.KEY}.js`), entry.module.KEY).toBe(true);
  });

  it('binds the caller cookie and the request pool, and maps unavailable to a gap', async () => {
    const seen: Array<{ url: string; cookie: string | null }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, cookie: new Headers(init.headers).get('cookie') });
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const queries: string[] = [];
    const runtime = { ownerSub: 'fixture|lab-owner', issuer: 'https://issuer.example', apiBaseUrl: 'http://127.0.0.1:5000',
      ctx: { pool: { query: async (text: string) => { queries.push(text); return { rows: [] }; } }, ticketService: { getTicket: async () => null, deleteTicket: async () => undefined } } as unknown as AppContext } as ScenarioRunContext;
    try {
      const ports = labPorts('sid=abc', runtime) as { sql: (n: string, p: unknown[]) => Promise<unknown>; browser?: unknown; logs?: unknown };
      await ports.sql('linkedin.draft-residue', ['fixture|lab-owner', 't']);
      expect(queries[0]).toContain('FROM social_content_drafts WHERE user_sub = $1');
      expect(ports.browser).toBeUndefined();
      expect(ports.logs).toBeUndefined();
      const step = await runLiveAcceptanceCase('floater', 'sid=abc', runtime);
      expect(step.state).toBe('gap');
      expect(step.detail).toContain('aero-lab with the ADR-160 vehicle record');
      expect(seen.every((s) => s.cookie === 'sid=abc' && s.url.startsWith('http://127.0.0.1:5000/'))).toBe(true);
      seen.length = 0;
      for (const key of ['commerce', 'jarvis-cache']) {
        const hostOnly = await runLiveAcceptanceCase(key, 'sid=abc', runtime);
        expect(hostOnly.state).toBe('gap');
        expect(hostOnly.detail).toContain(`run node scripts/operations/live-acceptance.js ${key}`);
      }
      expect(seen).toEqual([]);
      expect((await runLiveAcceptanceCase('congress', '', runtime)).state).toBe('degraded');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
