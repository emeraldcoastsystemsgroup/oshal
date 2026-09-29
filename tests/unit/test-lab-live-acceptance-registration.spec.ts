/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the live-acceptance Test Lab cards: exactly one explicit-only card per registered case (so "Run live scenarios" never writes fixtures or spends a model turn), each naming the host command and its backlog entry, every attached suite on disk, the shared case modules shipped in the api image; the signed-in adapter binds the caller's cookie to every loopback call and the named statements to the request pool, maps an unavailable case to a gap, and the host-only cases (commerce, Jarvis cache) answer that gap without a single call.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The registry gains the trading-parity case.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The adapter's `anonymous` port reaches the same loopback base with no session cookie, while `api` keeps forwarding the caller's.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Runner inputs are host-only. A card may not name an OSHAL_VERIFY_* variable as an api-environment source unless compose forwards it; today compose forwards none. Such a variable may appear only inside the host command that supplies it. And the dev-workspace card, run with OSHAL_VERIFY_DEV_NOTES_PROBE set in this process (standing in for the api's environment), must still answer the handover ask as a host-runner gap: no anonymous query, no Jarvis call, dev mode put back. Red if the Lab adapter stops passing its empty runner environment, or if the description again sends the operator to the api's environment.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCENARIOS, scenariosForRun, type ScenarioRunContext } from '@/app/routes/test-lab-scenarios';
import { LIVE_ACCEPTANCE_SCENARIOS } from '@/app/routes/test-lab-live-acceptance-scenarios';
import { LIVE_ACCEPTANCE_CASES, labPorts, runLiveAcceptanceCase } from '@/app/routes/test-lab-live-acceptance';
import type { AppContext } from '@/app/composition/app-context';

/** Runner-input variables a card names; compose forwards none of them to the api today. */
const RUNNER_VARIABLE = /\bOSHAL_VERIFY_[A-Z0-9_]*[A-Z0-9]\b/g;
/** Wording that presents the api's own environment as where a card reads an input. */
const API_ENV_CLAIM = /environment of the api|of the api, for this card|in the api's environment|api environment/i;

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

  it('names a runner-input variable only through the host command, unless compose forwards it to the api', () => {
    const compose = readFileSync('docker-compose.oshal-local.yml', 'utf8');
    const named: string[] = [];
    for (const scenario of LIVE_ACCEPTANCE_SCENARIOS) {
      const key = scenario.id.replace(/^live-acceptance-/, '');
      for (const variable of new Set(scenario.description.match(RUNNER_VARIABLE) || [])) {
        named.push(`${key}:${variable}`);
        if (new RegExp(String.raw`^\s*${variable}:\s`, 'm').test(compose)) continue;
        expect(scenario.description, `${key} must not send the operator to the api environment for ${variable}`).not.toMatch(API_ENV_CLAIM);
        expect(scenario.description, `${key} must name the host command that supplies ${variable}`)
          .toMatch(new RegExp(String.raw`${variable}="[^"]*" node scripts/operations/live-acceptance\.js ${key}\b`));
      }
    }
    expect(named).toContain('dev-workspace:OSHAL_VERIFY_DEV_NOTES_PROBE');
  });

  it('answers the dev-workspace handover ask as a host-runner gap even when the api environment carries the words', async () => {
    const seen: string[] = [];
    let on = false;
    const realFetch = globalThis.fetch;
    const saved = process.env.OSHAL_VERIFY_DEV_NOTES_PROBE;
    process.env.OSHAL_VERIFY_DEV_NOTES_PROBE = 'fixture handover words';
    const reply = (status: number, json: unknown) => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const route = `${init.method} ${new URL(url).pathname}`;
      seen.push(route);
      if (route === 'GET /api/dev-workspace-index/dev-mode') return reply(200, { superAdmin: true, devConsoleEnabled: true, packageEnabled: true, devMode: { enabled: on } });
      if (route === 'POST /api/dev-workspace-index/dev-mode') { on = true; return reply(200, { devMode: { enabled: true } }); }
      if (route === 'DELETE /api/dev-workspace-index/dev-mode') { on = false; return reply(200, { devMode: { enabled: false } }); }
      if (route === 'GET /api/dev-workspace-index/status') return on ? reply(200, { indexPresent: true, sources: { checkout: 3, 'local-notes': 1 } }) : reply(403, {});
      return reply(404, {});
    }) as typeof fetch;
    const runtime = { ownerSub: 'fixture|lab-owner', issuer: 'https://issuer.example', apiBaseUrl: 'http://127.0.0.1:5000',
      ctx: { pool: { query: async () => ({ rows: [] }) }, ticketService: { getTicket: async () => null, deleteTicket: async () => undefined } } as unknown as AppContext } as ScenarioRunContext;
    try {
      const step = await runLiveAcceptanceCase('dev-workspace', 'sid=abc', runtime);
      expect(step.state).toBe('gap');
      expect(step.detail).toContain('run OSHAL_VERIFY_DEV_NOTES_PROBE="<its words>" node scripts/operations/live-acceptance.js dev-workspace');
      expect(seen.filter((route) => route.includes('/api/jarvis/') || route.includes('/query'))).toEqual([]);
      expect(seen).toContain('POST /api/dev-workspace-index/dev-mode');
      expect(on).toBe(false);
      expect((step.output as { cleanup: { outstanding: string[] } }).cleanup.outstanding).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
      if (saved === undefined) delete process.env.OSHAL_VERIFY_DEV_NOTES_PROBE; else process.env.OSHAL_VERIFY_DEV_NOTES_PROBE = saved;
    }
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
      const anonymous = (labPorts('sid=abc', runtime) as { anonymous: (m: string, r: string) => Promise<{ status: number }> }).anonymous;
      expect((await anonymous('GET', '/api/dev-workspace-index/query?q=ADR-077')).status).toBe(404);
      expect(seen).toEqual([{ url: 'http://127.0.0.1:5000/api/dev-workspace-index/query?q=ADR-077', cookie: null }]);
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
