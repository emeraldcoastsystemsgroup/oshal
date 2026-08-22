/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the codex image provider's platform-realm-only credential resolution. The mounted ChatGPT-subscription OAuth token (live auth.json) must keep powering the chat harness via getSwarmApiKey, but must NEVER satisfy the image rail: /v1/images rejects subscription tokens (ADR-082, re-verified live 2026-08-21), so an OAuth-only box has to fail closed at resolve time with the paste-a-platform-key hint — not read as configured and then 401 on every generation. Real temp credential files + the real resolvers; only the logger is doubled.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logSpies = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@/shared/logger', () => ({ createChildLogger: () => logSpies }));

import {
  getSwarmApiKey,
  getSwarmPlatformApiKey,
  hasSwarmPlatformApiKey,
} from '../../src/features/llm-provider/services/swarm-credentials';
import {
  createCodexImageProvider,
  resolveStoryboardImageProvider,
} from '../../src/features/video-generation/services/storyboard-image-providers';

const FAKE_OAUTH = 'fake-codex-oauth-access-token';
const ENV_KEYS = [
  'CODEX_AUTH_SOURCE_PATH',
  'OSHAL_SEED_SECRETS_PATH',
  'OSHAL_GLOBAL_CONFIG_PATH',
  'OPENAI_API_KEY',
  'OPENAI_IMAGE_MODEL',
  'STORYBOARD_IMAGE_PROVIDER',
] as const;

describe('codex image provider — platform realm only, OAuth-only box fails closed', () => {
  let tempDir: string;
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-platform-key-'));
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

    // An OAuth-only box: a live codex auth.json with an access token, empty config + seed,
    // no OPENAI_API_KEY. This mirrors the operator box that motivated the fix.
    const authPath = path.join(tempDir, 'auth.json');
    fs.writeFileSync(authPath, JSON.stringify({ tokens: { access_token: FAKE_OAUTH } }));
    const secretsPath = path.join(tempDir, 'secrets.json');
    fs.writeFileSync(secretsPath, JSON.stringify({}));
    const globalConfigPath = path.join(tempDir, 'global-config.json');
    fs.writeFileSync(globalConfigPath, JSON.stringify({}));

    process.env.CODEX_AUTH_SOURCE_PATH = authPath;
    process.env.OSHAL_SEED_SECRETS_PATH = secretsPath;
    process.env.OSHAL_GLOBAL_CONFIG_PATH = globalConfigPath;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_IMAGE_MODEL;
    delete process.env.STORYBOARD_IMAGE_PROVIDER;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('chat resolution still hands the codex OAuth token to the harness', () => {
    expect(getSwarmApiKey('openai')).toBe(FAKE_OAUTH);
  });

  it('platform resolution never returns OAuth material', () => {
    expect(getSwarmPlatformApiKey('openai')).toBe('');
    expect(hasSwarmPlatformApiKey('openai')).toBe(false);
  });

  it('the codex image provider is unavailable on an OAuth-only box', async () => {
    await expect(createCodexImageProvider().available()).resolves.toBe(false);
  });

  it('resolution fails closed with the platform-key hint, not the ChatGPT-login suggestion', async () => {
    process.env.STORYBOARD_IMAGE_PROVIDER = 'codex';
    const err = await resolveStoryboardImageProvider().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(/PLATFORM OpenAI key/);
    expect(message).toMatch(/Refusing to fall back/);
    // The old hint said "connect the Codex/ChatGPT login" — advice that can never work for images.
    expect(message).not.toMatch(/connect the Codex\/ChatGPT login/);
  });

  it('a platform env key satisfies the DEFAULT selection (unset env resolves to codex)', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-platform-key';
    expect(getSwarmPlatformApiKey('openai')).toBe('sk-test-platform-key');
    const provider = await resolveStoryboardImageProvider();
    expect(provider.id).toBe('codex');
    expect(typeof provider.healthCheck).toBe('function');
  });

  it('a named openAiApiKey in the seed wins for the platform realm even with OAuth mounted', () => {
    fs.writeFileSync(
      process.env.OSHAL_SEED_SECRETS_PATH as string,
      JSON.stringify({ openAiApiKey: 'sk-seed-platform-key' }),
    );
    expect(getSwarmPlatformApiKey('openai')).toBe('sk-seed-platform-key');
    // And the chat rail still prefers the named platform key over OAuth, unchanged.
    expect(getSwarmApiKey('openai')).toBe('sk-seed-platform-key');
  });
});
