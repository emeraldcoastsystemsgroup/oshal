/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Named guards for the two breaks the 2026-08-02 ADR-119 A2 drill found on the LIVE box, both of which every existing P4 guard passed straight over because they stubbed the RemediationExecutor. (1) apply-seam-mounted-on-bot-node: POST /api/self-heal/apply existed only on any-bot/server/app.js (BOT_RUNTIME=any-bot, which nothing in compose runs) so the real self-healing node answered an HTML 404 — asserted by booting a REAL express app through the real registrar and by pinning that bot-node-server.ts actually CALLS it (the "importers landed, module didn't" shape). (2) inspect-template-valid: _inspectContainer's docker Go template referenced .State.RestartCount (not a field — hard parse error on EVERY container) and dereferenced .State.Health.Status unguarded (errors on health-less containers), so every observation returned status:'not-found' while reporting success:true and the A2 verify loop could never observe health. Asserted on the template's field paths AND on real behaviour through an injected execSync, including that a failed inspect is success:false rather than a clean-looking 'not-found'.
 */

import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerBotNodeSelfHealRoute } from '../../src/app/bot-node-self-heal-route';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** The self-healing tool surface, as the dynamic import hands it back. */
type ToolSurface = Record<string, (params: unknown) => Promise<Record<string, unknown>>>;

/** Boots a throwaway express app with the seam mounted and returns a POST helper. */
async function bootSeam(): Promise<{
  post: (body: unknown, headers?: Record<string, string>) => Promise<{ status: number; contentType: string; text: string }>;
  mounted: boolean;
  close: () => Promise<void>;
}> {
  const app = express();
  app.use(express.json());
  const mounted = registerBotNodeSelfHealRoute(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    mounted,
    post: async (body, headers = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/self-heal/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      return { status: res.status, contentType: res.headers.get('content-type') ?? '', text: await res.text() };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('ADR-119 A2 remediation seam — the apply endpoint the drill found missing', () => {
  const saved = new Map<string, string | undefined>();
  const setEnv = (key: string, value: string | undefined): void => {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  afterEach(() => {
    for (const [key, value] of saved.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
    vi.restoreAllMocks();
  });

  it('apply-seam-mounted-on-bot-node: the route EXISTS on a bot-node express app (it 404d on the live self-healing node)', async () => {
    setEnv('SWARM_SERVICE_SECRET', 'seam-guard-secret');
    setEnv('ENABLE_SELF_HEALING_SCHEDULER', 'true');
    const seam = await bootSeam();
    try {
      expect(seam.mounted).toBe(true);
      const res = await seam.post({ action: 'check' }, { 'X-Service-Secret': 'seam-guard-secret' });
      // The break was an express default 404 serving text/html. ANY JSON answer from the
      // handler proves the route is mounted; 400 here is the handler rejecting a missing
      // container, which is the handler running.
      expect(res.status).not.toBe(404);
      expect(res.contentType).toContain('application/json');
      expect(JSON.parse(res.text)).toMatchObject({ success: false, error: 'container is required' });
    } finally {
      await seam.close();
    }
  });

  it('apply-seam-fail-closed: a missing or wrong service secret is 401, and it is JSON not an HTML 404', async () => {
    setEnv('SWARM_SERVICE_SECRET', 'seam-guard-secret');
    setEnv('ENABLE_SELF_HEALING_SCHEDULER', 'true');
    const seam = await bootSeam();
    try {
      const anonymous = await seam.post({ action: 'restart', container: 'oshal-local-research-bot' });
      expect(anonymous.status).toBe(401);
      const wrong = await seam.post(
        { action: 'restart', container: 'oshal-local-research-bot' },
        { 'X-Service-Secret': 'not-the-secret' },
      );
      expect(wrong.status).toBe(401);
    } finally {
      await seam.close();
    }
  });

  it('apply-seam-role-gated: a bot that is NOT the self-healing node answers 403, never a restart', async () => {
    setEnv('SWARM_SERVICE_SECRET', 'seam-guard-secret');
    setEnv('ENABLE_SELF_HEALING_SCHEDULER', undefined);
    setEnv('BOT_NAME', 'research-bot');
    setEnv('AGENT_ID', 'a0000000-0000-0000-0000-000000000010');
    const seam = await bootSeam();
    try {
      const res = await seam.post(
        { action: 'restart', container: 'oshal-local-research-bot' },
        { 'X-Service-Secret': 'seam-guard-secret' },
      );
      expect(res.status).toBe(403);
    } finally {
      await seam.close();
    }
  });

  it('apply-seam-registered-by-the-server: bot-node-server.ts CALLS the registrar (an unused module ships as a 404)', () => {
    // Comment lines are stripped first: a commented-out call is exactly the shape this
    // guard has to catch, and a naive substring match passes straight through one.
    const live = readFileSync(path.join(REPO_ROOT, 'src/app/bot-node-server.ts'), 'utf8')
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(live).toContain("from './bot-node-self-heal-route'");
    // The import alone is what an "importers landed, module didn't" defect looks like in
    // reverse: assert the CALL, with its app argument.
    expect(/registerBotNodeSelfHealRoute\s*\(\s*app\s*\)/.test(live)).toBe(true);
  });

  it('apply-seam-degrades-loudly: an unloadable registrar returns false instead of throwing the bot node down', async () => {
    const app = express();
    const mounted = registerBotNodeSelfHealRoute(app, () => {
      throw new Error('module missing');
    });
    expect(mounted).toBe(false);
  });
});

describe('ADR-119 A2 verification — the docker inspect template that broke every observation', () => {

  it('inspect-template-valid: RestartCount is TOP-LEVEL and Health is guarded (both were wrong, so every inspect threw)', async () => {
    const tools = (await import('../../any-bot/server/services/tools/selfHealingTools.js')) as unknown as { INSPECT_FORMAT: string };
    // `.State.RestartCount` is not a field on any docker API version this stack runs:
    // docker answers "map has no entry for key RestartCount" and produces NO output.
    expect(tools.INSPECT_FORMAT).not.toContain('.State.RestartCount');
    expect(tools.INSPECT_FORMAT).toContain('{{.RestartCount}}');
    // `.State.Health` is absent on containers without a healthcheck (prometheus,
    // alertmanager, cadvisor) — an unguarded deref errors there too.
    expect(tools.INSPECT_FORMAT).toContain('{{if .State.Health}}');
    expect(/\{\{\.State\.Health\.Status\}\}(?!.*\{\{else\}\})/.test(tools.INSPECT_FORMAT)).toBe(false);
  });

  it('inspect-parses-a-real-docker-answer: running/healthy is observed, not reported as not-found', async () => {
    const tools = (await import('../../any-bot/server/services/tools/selfHealingTools.js')) as unknown as ToolSurface;
    // Verbatim output of the corrected template against a real running bot container.
    const exec = (): string => `running|healthy|2026-08-02T03:54:05.744Z|0|oshal-bot:latest
`;
    const result = await tools['check-container-health']({ container_name: 'oshal-local-research-bot', exec });
    expect(result).toMatchObject({ success: true, status: 'running', health: 'healthy', inspectOk: true });
  });

  it('inspect-reads-a-health-less-container: no healthcheck is "none" and still an OBSERVATION', async () => {
    const tools = (await import('../../any-bot/server/services/tools/selfHealingTools.js')) as unknown as ToolSurface;
    // Verbatim output for oshal-local-prometheus, which declares no healthcheck. Under the
    // shipped unguarded {{.State.Health.Status}} docker errored here instead of answering.
    const exec = (): string => `running|none|2026-08-01T22:01:31.666Z|0|prom/prometheus:v2.53.1
`;
    const result = await tools['check-container-health']({ container_name: 'oshal-local-prometheus', exec });
    expect(result).toMatchObject({ success: true, status: 'running', health: 'none', inspectOk: true });
  });

  it('inspect-failure-is-not-an-observation: a template/socket error is success:false, NOT a clean not-found', async () => {
    const tools = (await import('../../any-bot/server/services/tools/selfHealingTools.js')) as unknown as ToolSurface;
    // This is what the shipped template actually produced on EVERY container:
    // "template parsing error: ... executing at <.State.RestartCount>: map has no
    // entry for key RestartCount" -> execSync throws -> no output at all.
    const exec = (): string => {
      throw new Error("Command failed: docker inspect --format '<template>' oshal-local-research-bot");
    };
    const result = await tools['check-container-health']({ container_name: 'oshal-local-research-bot', exec });
    // The shipped version answered { success: true, status: 'not-found' } — the A2 verify
    // loop then polled a lie until the window elapsed and escalated a healthy container.
    expect(result.success).toBe(false);
    expect(result.inspectOk).toBe(false);
    expect(result.status).not.toBe('not-found');
  });
});
