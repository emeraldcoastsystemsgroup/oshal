/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Backfilled the missing change-log header. Compose alignment check updated for the security-audit port de-publish: weather-bot's 5000 is now expose-only (internal Docker network), no longer host-published as 127.0.0.1:3032:5000 — the test now asserts the INTERNAL-ONLY posture so a re-published port fails loudly.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Extended the internal-only posture guard to the alternate swarm stacks (docker-compose.swarm-local.yml + docker-compose.incident-lab.yml): the security-audit de-publish only covered oshal-local.yml, leaving those variants publishing bot 5000s on the host; the new case fails loudly if any bot service in them host-publishes :5000 again.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import yaml from 'js-yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_BOT_REGISTRY } from '../../src/app/extensions/swarm/swarm-bot-registry-local';
import { summarizeGmailMetadata } from '../../src/app/routes/email-routes';

const requireModule = createRequire(import.meta.url);
const gmailScript = requireModule('../../scripts/oshal-gmail.js') as {
  gmailDigest: (token: string) => Promise<Array<Record<string, unknown>>>;
  summarizeGmailMessage: (message: Record<string, unknown>) => Record<string, unknown>;
};
const weatherTools = requireModule('../../any-bot/server/services/tools/weatherTools.js') as {
  'format-weather': (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

describe('live weather and email data-path wiring', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('routes forecast weather and communications work to their own Codex nodes', () => {
    const weather = LOCAL_BOT_REGISTRY.find((bot) => bot.name === 'weather-bot');
    expect(weather).toMatchObject({
      agentId: 'a0000000-0000-0000-0000-000000000036',
      port: 3032,
      container: 'weather-bot',
      requiresOwnNode: true,
      harnessType: 'codex-cli',
      apiType: 'openai-codex',
    });
    expect(weather?.capabilities).toContain('weather-forecast');

    const communications = LOCAL_BOT_REGISTRY.find((bot) => bot.name === 'communications-bot');
    expect(communications).toMatchObject({
      container: 'email-bot',
      requiresOwnNode: true,
      harnessType: 'codex-cli',
      apiType: 'openai-codex',
    });
  });

  it('keeps compose identity, provider, persona, and port aligned with the registry', () => {
    const compose = yaml.load(fs.readFileSync('docker-compose.oshal-local.yml', 'utf8')) as {
      services: Record<string, { ports?: string[]; expose?: Array<string | number>; environment?: Record<string, string> }>;
    };
    const service = compose.services['weather-bot'];
    // Security audit 2026-06-16: the bot-node execution port must be INTERNAL-ONLY —
    // exposed on the Docker network for the controller (service DNS), never host-published.
    expect(service.ports).toBeUndefined();
    expect((service.expose ?? []).map(String)).toContain('5000');
    expect(service.environment).toMatchObject({
      BOT_NAME: 'weather-bot',
      AGENT_ID: 'a0000000-0000-0000-0000-000000000036',
      BOT_PERSONA_FILE: '/app/ai-lab/bot-personas/weather-bot.yaml',
      FORCE_LLM_PROVIDER: 'openai-codex',
    });
  });

  it('keeps bot-node execution ports internal-only across the alternate swarm stacks', () => {
    // Security audit follow-up 2026-07-15: the same de-publish that fixed
    // docker-compose.oshal-local.yml must hold for the alternate stacks, or booting
    // them re-opens the unauthenticated /api/swarm-execute exposure on the host.
    for (const file of ['docker-compose.swarm-local.yml', 'docker-compose.incident-lab.yml']) {
      const compose = yaml.load(fs.readFileSync(file, 'utf8')) as {
        services: Record<string, { ports?: string[]; image?: string; environment?: Record<string, string> }>;
      };
      for (const [name, service] of Object.entries(compose.services ?? {})) {
        // Only bot-node services (BOT_NAME env) run the execute endpoint on 5000.
        if (!service.environment?.BOT_NAME) continue;
        // The controller ("oshal-api") is the swarm runtime, not a bot-node — it
        // legitimately host-publishes its API on 5000 (via OSHAL_API_PORT).
        if (name === 'oshal-api') continue;
        const hostPublishes5000 = (service.ports ?? []).some((p) => String(p).endsWith(':5000'));
        expect(hostPublishes5000, `${file} service "${name}" must not host-publish :5000`).toBe(false);
      }
    }
  });

  it('keeps the deterministic weather handler validation on the CLI/tool path', async () => {
    await expect(weatherTools['format-weather']({ format: 'json' })).resolves.toMatchObject({
      error: 'location parameter is required',
    });
    await expect(weatherTools['format-weather']({ location: 'Chicago, IL', format: 'pdf' })).resolves.toMatchObject({
      error: expect.stringContaining('Invalid format'),
    });
  });

  it('threads caller identity and per-request LLM config while rejecting generic credentials', () => {
    const appSource = fs.readFileSync('any-bot/server/app.js', 'utf8');
    const agenticSource = fs.readFileSync('any-bot/server/controllers/AgenticController.js', 'utf8');
    const codexProviderSource = fs.readFileSync('any-bot/server/services/llm/CodexProvider.js', 'utf8');
    expect(appSource).toContain('{ forceTaskId: effectiveTaskId, userSub: scopedUserSub }');
    expect(appSource).toContain('byoLlmConnection: requestedByo');
    expect(appSource).toContain('extraEnv,');
    expect(appSource).toContain("Object.prototype.hasOwnProperty.call(req.body, 'creds')");
    expect(appSource).not.toContain('sanitizeBrokeredCreds');
    expect(codexProviderSource).toContain("providerRecordCapture: 'codex-command-events-v1'");
    expect(agenticSource).toContain("response.providerRecordCapture === 'codex-command-events-v1'");
    expect(appSource).toContain('providerRecords: Array.isArray(result.providerRecords) ? result.providerRecords : []');
  });

  it('starts the canonical hardened any-bot server for the optional any-bot runtime', () => {
    const entrypoint = fs.readFileSync('scripts/bot-entrypoint.sh', 'utf8');
    const anyBotBranch = entrypoint.slice(
      entrypoint.indexOf('if [ "$BOT_RUNTIME" = "any-bot" ]'),
      entrypoint.indexOf('elif [ "$BOT_RUNTIME" = "bot-node" ]'),
    );
    expect(anyBotBranch).toContain('exec node any-bot/server/app.js');
    expect(anyBotBranch).not.toContain('exec node any-bot/server/swarm-node.js');
    const legacySource = fs.readFileSync('any-bot/server/swarm-node.js', 'utf8');
    expect(legacySource).toContain('owner-scoped execution is unsupported by the legacy swarm-node runtime');
  });

  it('preserves Gmail IDs, receive time, and provider priority flags without adding a body', () => {
    const message = {
      id: '18f-message-id',
      internalDate: '1710000000000',
      labelIds: ['INBOX', 'UNREAD', 'IMPORTANT', 'STARRED'],
      snippet: 'Short provider snippet',
      payload: {
        headers: [
          { name: 'From', value: 'Ada <ada@example.com>' },
          { name: 'Subject', value: 'Decision needed' },
          { name: 'Date', value: 'Sat, 9 Mar 2024 16:00:00 +0000' },
        ],
      },
    };

    const routeSummary = summarizeGmailMetadata('fallback-id', message);
    const scriptSummary = gmailScript.summarizeGmailMessage(message);

    for (const summary of [routeSummary, scriptSummary]) {
      expect(summary).toMatchObject({
        id: '18f-message-id',
        internalDate: '1710000000000',
        receivedAt: '2024-03-09T16:00:00.000Z',
        unread: true,
        important: true,
        starred: true,
        providerFlags: { unread: true, important: true, starred: true },
      });
      expect(summary).not.toHaveProperty('body');
    }
  });

  it('fails closed instead of turning a Gmail API failure into an empty mailbox record', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'invalid credentials',
    }));

    await expect(gmailScript.gmailDigest('redacted-token'))
      .rejects.toThrow('Gmail API 401');
  });

  it('fails the digest when any listed Gmail message cannot be read', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ messages: [{ id: 'message-1' }] }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => 'temporarily unavailable',
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(gmailScript.gmailDigest('redacted-token'))
      .rejects.toThrow('Gmail API 503');
  });
});
