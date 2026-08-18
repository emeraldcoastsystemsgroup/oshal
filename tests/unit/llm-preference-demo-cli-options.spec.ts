/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | Codex                                      | Guard the Codex-only OSHAL_DEMO_CLI_SUBS contract at the real settings HTTP route: options and PUT authorization must agree with runtime resolution, while operators retain explicit Claude access.
 */

import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getUserLlmConnection = vi.fn();
const listFreeTierConnections = vi.fn();
const getUserLlmPreference = vi.fn();
const saveUserLlmPreference = vi.fn();

vi.mock('../../src/app/routes/byo-llm-routes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/app/routes/byo-llm-routes')>();
  return { ...actual, getUserLlmConnection: (...args: unknown[]) => getUserLlmConnection(...args) };
});

vi.mock('../../src/app/routes/free-tier-rotation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/app/routes/free-tier-rotation')>();
  return { ...actual, listFreeTierConnections: (...args: unknown[]) => listFreeTierConnections(...args) };
});

vi.mock('../../src/app/routes/user-brain-resolution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/app/routes/user-brain-resolution')>();
  return {
    ...actual,
    getUserLlmPreference: (...args: unknown[]) => getUserLlmPreference(...args),
    saveUserLlmPreference: (...args: unknown[]) => saveUserLlmPreference(...args),
  };
});

import { createLlmPreferenceRoutes } from '../../src/app/routes/llm-preference-routes';

const OPERATOR = 'operator-sub-1';
const DEMO_USER = 'demo-user-sub-2';
const ENV_KEYS = ['DEMO_MODE', 'OSHAL_OPERATOR_SUBS', 'OSHAL_DEMO_CLI_SUBS'] as const;
let savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

function appFor(sub: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).oidc = { isAuthenticated: () => true, user: { sub } };
    next();
  });
  app.use('/preference', createLlmPreferenceRoutes({ pool: {} } as never));
  return app;
}

function option(body: any, id: string): { available: boolean } | undefined {
  return body.options.find((entry: { id: string }) => entry.id === id);
}

async function withApp<T>(sub: string, run: (origin: string) => Promise<T>): Promise<T> {
  const app = appFor(sub);
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await run(origin);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function jsonRequest(
  origin: string,
  method: 'GET' | 'PUT',
  body?: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin}/preference`, {
    method,
    ...(body ? {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    } : {}),
  });
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as typeof savedEnv;
  process.env.DEMO_MODE = 'true';
  process.env.OSHAL_OPERATOR_SUBS = OPERATOR;
  process.env.OSHAL_DEMO_CLI_SUBS = DEMO_USER;
  getUserLlmConnection.mockReset().mockResolvedValue(null);
  listFreeTierConnections.mockReset().mockResolvedValue([]);
  getUserLlmPreference.mockReset().mockResolvedValue({ preferred: 'auto' });
  saveUserLlmPreference.mockReset().mockImplementation(
    async (_pool, _sub, preferred: string, model?: string) => ({ preferred, ...(model ? { model } : {}) }),
  );
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('LLM preference route — Codex-only customer demo entitlement', () => {
  it('shows Codex but not Claude to a demo user', async () => {
    await withApp(DEMO_USER, async (origin) => {
      const response = await jsonRequest(origin, 'GET');
      expect(response.status).toBe(200);
      expect(option(response.body, 'openai-codex')?.available).toBe(true);
      expect(option(response.body, 'claude-code')?.available).toBe(false);
    });
  });

  it('rejects saving Claude and accepts saving Codex for a demo user', async () => {
    await withApp(DEMO_USER, async (origin) => {
      const claudeResponse = await jsonRequest(origin, 'PUT', { preferred: 'claude-code' });
      expect(claudeResponse.status).toBe(409);
      expect(saveUserLlmPreference).not.toHaveBeenCalled();

      const codexResponse = await jsonRequest(origin, 'PUT', {
        preferred: 'openai-codex', model: 'gpt-5.5',
      });
      expect(codexResponse.status).toBe(200);
      expect(codexResponse.body.preference).toEqual({ preferred: 'openai-codex', model: 'gpt-5.5' });
      expect(saveUserLlmPreference).toHaveBeenCalledWith({}, DEMO_USER, 'openai-codex', 'gpt-5.5');
    });
  });

  it('preserves both explicit CLI choices for the deployment operator', async () => {
    await withApp(OPERATOR, async (origin) => {
      const optionsResponse = await jsonRequest(origin, 'GET');
      expect(optionsResponse.status).toBe(200);
      expect(option(optionsResponse.body, 'openai-codex')?.available).toBe(true);
      expect(option(optionsResponse.body, 'claude-code')?.available).toBe(true);
      expect((await jsonRequest(origin, 'PUT', { preferred: 'claude-code' })).status).toBe(200);
      expect((await jsonRequest(origin, 'PUT', { preferred: 'openai-codex' })).status).toBe(200);
    });
  });
});
