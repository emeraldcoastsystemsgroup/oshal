/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the storyboard image selection by the bot-level rule (ADR-130 amendment 2026-10-02): the RENDER BOT's own effective provider picks the rail. Through the REAL resolver: antigravity-cli -> antigravity-cli, openai-codex/codex-cli -> codex-cli; a harness with no image rail (claude-code, cline, gemini-cli, a Cline-backed id) fails closed naming the bot and the harness and never reaches a paid provider; no provider record, and a reader that cannot answer, fail closed; an explicit STORYBOARD_IMAGE_PROVIDER always wins; the non-demo default stays codex; no reader registered keeps codex-cli; a non-operator caller is refused as not configured with no fallback. The chain cases use the REAL boot reader (createStoryboardRenderBotReader) over the canonical runtime-params resolver the swarm extension builds, the REAL ProviderSwitchSnapshot and the REAL registry readers (tests/fixtures/storyboard-render-bot-switch.ts): the bot's own row overrides the fleet default in both directions, the registry declaration answers when there are no rows, an unread snapshot refuses, and a row write moves the rail at the next refresh with no restart.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  registerStoryboardRenderBotReader,
  selectStoryboardImageProvider,
  type StoryboardRenderBot,
} from '../../src/features/video-generation/services/storyboard-image-default';
import { resolveStoryboardImageProvider } from '../../src/features/video-generation/services/storyboard-image-providers';
import { registerCliStoryboardImageExecutor } from '../../src/features/video-generation/services/storyboard-cli-image-executor';
import { createStoryboardRenderBotReader } from '../../src/app/storyboard-cli-image-wiring';
import { clearRenderBotSwitch, installRenderBotSwitch, RENDER_BOT, switchRow } from '../fixtures/storyboard-render-bot-switch';

const OPERATOR = 'operator-sub-1';
const ENV_KEYS = ['STORYBOARD_IMAGE_PROVIDER', 'DEMO_MODE', 'OSHAL_OPERATOR_SUBS'] as const;

const bot = (harness: string | null, name = 'general-bot'): void => {
  registerStoryboardRenderBotReader(async (): Promise<StoryboardRenderBot> => ({ name, harness }));
};
const refusal = (promise: Promise<unknown>): Promise<Error | null> => promise.then(() => null, (e: Error) => e);

/** The real boot reader over the canonical resolver for the default render bot. */
async function realReader(...args: Parameters<typeof installRenderBotSwitch>) {
  const installed = await installRenderBotSwitch(...args);
  registerStoryboardRenderBotReader(createStoryboardRenderBotReader(RENDER_BOT, { runtimeParamsResolver: () => installed.resolver }));
  return installed;
}

describe('storyboard image selection: the render bot\'s own harness picks the rail (ADR-130, 2026-10-02)', () => {
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    delete process.env.STORYBOARD_IMAGE_PROVIDER;
    process.env.DEMO_MODE = 'true';
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR;
    registerStoryboardRenderBotReader(null);
    registerCliStoryboardImageExecutor(async () => ({ success: false, responseText: '', error: 'never called here' }));
    clearRenderBotSwitch();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    registerStoryboardRenderBotReader(null);
    registerCliStoryboardImageExecutor(null);
    clearRenderBotSwitch();
  });

  it('a render bot on antigravity-cli resolves the antigravity-cli rail for the operator', async () => {
    bot('antigravity-cli');
    expect(await selectStoryboardImageProvider()).toEqual({ ok: true, id: 'antigravity-cli', source: 'render-bot', renderBot: 'general-bot', harness: 'antigravity-cli' });
    const provider = await resolveStoryboardImageProvider({ userSub: OPERATOR });
    expect(provider.id).toBe('antigravity-cli');
    expect(provider.costClass).toBe('free');
  });

  it.each(['openai-codex', 'codex-cli', 'OpenAI-Codex'])('a render bot on %s resolves codex-cli', async (harness) => {
    bot(harness);
    expect((await resolveStoryboardImageProvider({ userSub: OPERATOR })).id).toBe('codex-cli');
  });

  it.each(['claude-code', 'cline', 'gemini-cli', 'gemini'])('a render bot on %s fails closed naming the bot and the harness', async (harness) => {
    bot(harness);
    const err = await refusal(resolveStoryboardImageProvider({ userSub: OPERATOR }));
    expect(err?.message).toContain(`general-bot runs ${harness}, which cannot make images; give that bot an image-capable harness, or set STORYBOARD_IMAGE_PROVIDER to an image API`);
    expect(err?.message).toContain('Refusing to fall back to a paid provider');
  });

  it('a render bot with no provider record, and a reader that cannot answer, fail closed', async () => {
    bot(null);
    expect((await refusal(resolveStoryboardImageProvider({ userSub: OPERATOR })))?.message).toMatch(/general-bot has no provider record .*set STORYBOARD_IMAGE_PROVIDER/);
    registerStoryboardRenderBotReader(async () => { throw new Error('snapshot exploded'); });
    expect(await selectStoryboardImageProvider()).toMatchObject({ ok: false, reason: expect.stringContaining('snapshot exploded') });
  });

  it('an explicit STORYBOARD_IMAGE_PROVIDER wins over every render bot, including one that cannot make images', async () => {
    bot('claude-code');
    process.env.STORYBOARD_IMAGE_PROVIDER = 'comfyui';
    expect(await selectStoryboardImageProvider()).toEqual({ ok: true, id: 'comfyui', source: 'explicit', renderBot: null, harness: null });
    bot('antigravity-cli');
    process.env.STORYBOARD_IMAGE_PROVIDER = 'codex-cli';
    expect(await selectStoryboardImageProvider()).toMatchObject({ ok: true, id: 'codex-cli', source: 'explicit' });
  });

  it('outside demo mode the default stays codex whatever the render bot runs', async () => {
    delete process.env.DEMO_MODE;
    bot('antigravity-cli');
    expect(await selectStoryboardImageProvider()).toEqual({ ok: true, id: 'codex', source: 'platform-default', renderBot: null, harness: null });
  });

  it('with no reader registered (no boot wiring in this process) the demo default stays codex-cli', async () => {
    expect(await selectStoryboardImageProvider()).toMatchObject({ ok: true, id: 'codex-cli', source: 'demo-default' });
  });

  it('a non-operator caller of the antigravity rail is refused as not configured, with no fallback', async () => {
    bot('antigravity-cli');
    const err = await refusal(resolveStoryboardImageProvider({ userSub: 'someone-else' }));
    expect(err?.message).toMatch(/storyboard image provider 'antigravity-cli' is not configured/);
    expect(err?.message).toMatch(/Refusing to fall back/);
  });
});

describe('the boot reader over the canonical record: bot row, then fleet default, then registry', () => {
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.DEMO_MODE = 'true';
    delete process.env.STORYBOARD_IMAGE_PROVIDER;
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    registerStoryboardRenderBotReader(null);
    clearRenderBotSwitch();
  });

  it('the fleet default antigravity-cli reaches a render bot with no row of its own', async () => {
    await realReader([switchRow('fleet-default', 'antigravity-cli', { modelId: 'gemini-3.8-flash-low' })]);
    expect(await selectStoryboardImageProvider()).toEqual({ ok: true, id: 'antigravity-cli', source: 'render-bot', renderBot: 'general-bot', harness: 'antigravity-cli' });
  });

  it('the render bot\'s own row overrides the fleet default: a bot on codex renders on codex-cli while the fleet is antigravity', async () => {
    await realReader([switchRow('fleet-default', 'antigravity-cli'), switchRow(RENDER_BOT, 'openai-codex')]);
    expect(await selectStoryboardImageProvider()).toMatchObject({ ok: true, id: 'codex-cli', harness: 'openai-codex' });
  });

  it('the bot row wins in the other direction too: a bot on claude-code is refused although the fleet default could make images', async () => {
    await realReader([switchRow('fleet-default', 'antigravity-cli'), switchRow(RENDER_BOT, 'claude-code')]);
    expect(await selectStoryboardImageProvider()).toMatchObject({ ok: false, harness: 'claude-code',
      reason: 'general-bot runs claude-code, which cannot make images; give that bot an image-capable harness, or set STORYBOARD_IMAGE_PROVIDER to an image API' });
  });

  it('a fleet default of claude-code is refused for a bot with no row, never a paid fallback', async () => {
    await realReader([switchRow('fleet-default', 'claude-code')]);
    const selection = await selectStoryboardImageProvider();
    expect(selection).toMatchObject({ ok: false, renderBot: 'general-bot', harness: 'claude-code' });
  });

  it('with no rows the registry declaration answers (general-bot declares openai-codex)', async () => {
    await realReader([]);
    expect(await selectStoryboardImageProvider()).toMatchObject({ ok: true, id: 'codex-cli', harness: 'openai-codex' });
  });

  it('a snapshot that has not completed its first read refuses instead of guessing', async () => {
    await realReader([switchRow('fleet-default', 'antigravity-cli')], { loaded: false });
    expect(await selectStoryboardImageProvider()).toMatchObject({ ok: false, reason: expect.stringMatching(/provider could not be read.*first successful read/) });
  });

  it('a row write moves the rail at the next refresh, with no re-registration and no restart', async () => {
    const installed = await realReader([switchRow('fleet-default', 'antigravity-cli')]);
    expect(await selectStoryboardImageProvider()).toMatchObject({ id: 'antigravity-cli' });
    installed.rows.set(RENDER_BOT, switchRow(RENDER_BOT, 'codex-cli'));
    expect(await selectStoryboardImageProvider(), 'before the refresh the last read stands').toMatchObject({ id: 'antigravity-cli' });
    await installed.refresh();
    expect(await selectStoryboardImageProvider()).toMatchObject({ ok: true, id: 'codex-cli', harness: 'codex-cli' });
    installed.rows.delete(RENDER_BOT);
    installed.rows.set('fleet-default', switchRow('fleet-default', 'cline'));
    await installed.refresh();
    expect(await selectStoryboardImageProvider()).toMatchObject({ ok: false, harness: 'cline' });
  });
});
