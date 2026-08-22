/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the ADR-130 codex-cli storyboard image provider. Pins: (1) the demo-aware default — env unset resolves to codex-cli ONLY under DEMO_MODE (with executor + operator sub), and stays codex otherwise; (2) the SEC-shaped availability gates — no executor, no DEMO_MODE, non-operator sub, or missing userSub each read unavailable and selection fails closed with the demo-carve hint; (3) the render round-trip against the REAL shared-workspace filesystem — anchor staged for the executor, prompt carries the anchor step + output contract, PNG read back and magic-checked, non-PNG and missing-file both throw. The executor is doubled (it IS the app-boot injection seam); the filesystem and resolver are real.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logSpies = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@/shared/logger', () => ({ createChildLogger: () => logSpies }));

import {
  createCodexCliImageProvider,
  resolveStoryboardImageProvider,
} from '../../src/features/video-generation/services/storyboard-image-providers';
import {
  registerCliStoryboardImageExecutor,
  resolveCliStoryboardImageExecutor,
  type CliStoryboardRenderRequest,
} from '../../src/features/video-generation/services/storyboard-cli-image-executor';

const OPERATOR_SUB = 'operator-sub-1';
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('not-a-real-frame-but-a-real-png-signature'),
]);

const ENV_KEYS = [
  'STORYBOARD_IMAGE_PROVIDER',
  'DEMO_MODE',
  'OSHAL_OPERATOR_SUBS',
  'OSHAL_WORKSPACE_ROOT',
  'OPENAI_API_KEY',
  'CODEX_AUTH_SOURCE_PATH',
  'OSHAL_SEED_SECRETS_PATH',
  'OSHAL_GLOBAL_CONFIG_PATH',
] as const;

/** Register an executor that writes `bytes` as output.png in the task workspace. */
function registerWritingExecutor(bytes: Buffer | null, captured: CliStoryboardRenderRequest[]): void {
  registerCliStoryboardImageExecutor(async (request) => {
    captured.push(request);
    if (bytes) {
      const dir = path.join(process.env.OSHAL_WORKSPACE_ROOT as string, request.workspaceFolderId);
      await fs.promises.writeFile(path.join(dir, 'output.png'), bytes);
    }
    return { success: true, responseText: 'RENDERED output.png', model: 'gpt-5.5' };
  });
}

describe('codex-cli storyboard image provider (ADR-130)', () => {
  let tempDir: string;
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-cli-provider-'));
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.OSHAL_WORKSPACE_ROOT = tempDir;
    process.env.DEMO_MODE = 'true';
    process.env.OSHAL_OPERATOR_SUBS = OPERATOR_SUB;
    delete process.env.STORYBOARD_IMAGE_PROVIDER;
    // Keep the codex (platform) sibling deterministic: no ambient credentials.
    process.env.CODEX_AUTH_SOURCE_PATH = path.join(tempDir, 'no-auth.json');
    process.env.OSHAL_SEED_SECRETS_PATH = path.join(tempDir, 'no-secrets.json');
    process.env.OSHAL_GLOBAL_CONFIG_PATH = path.join(tempDir, 'no-config.json');
    delete process.env.OPENAI_API_KEY;
    // Reset the module-level executor seam between cases.
    registerCliStoryboardImageExecutor(null);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    registerCliStoryboardImageExecutor(null);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('env unset + DEMO_MODE resolves to codex-cli for an operator caller', async () => {
    registerWritingExecutor(PNG_BYTES, []);
    const provider = await resolveStoryboardImageProvider({ userSub: OPERATOR_SUB });
    expect(provider.id).toBe('codex-cli');
    expect(provider.costClass).toBe('free');
  });

  it('env unset WITHOUT demo mode keeps the codex default (fails closed on this box shape)', async () => {
    delete process.env.DEMO_MODE;
    process.env.OPENAI_API_KEY = 'sk-test-platform-key';
    const provider = await resolveStoryboardImageProvider({ userSub: OPERATOR_SUB });
    expect(provider.id).toBe('codex');
  });

  it('an explicit STORYBOARD_IMAGE_PROVIDER always outranks the demo default', async () => {
    registerWritingExecutor(PNG_BYTES, []);
    process.env.STORYBOARD_IMAGE_PROVIDER = 'codex';
    process.env.OPENAI_API_KEY = 'sk-test-platform-key';
    const provider = await resolveStoryboardImageProvider({ userSub: OPERATOR_SUB });
    expect(provider.id).toBe('codex');
  });

  it.each([
    ['no executor registered', (): void => { /* nothing registered */ }],
    ['DEMO_MODE off', (): void => { registerWritingExecutor(PNG_BYTES, []); delete process.env.DEMO_MODE; }],
  ])('fails closed with the demo-carve hint when %s', async (_label, arrange) => {
    arrange();
    process.env.STORYBOARD_IMAGE_PROVIDER = 'codex-cli';
    const err = await resolveStoryboardImageProvider({ userSub: OPERATOR_SUB }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/demo-mode CLI rendering needs/);
    expect((err as Error).message).toMatch(/Refusing to fall back/);
  });

  it('a non-operator or missing userSub reads unavailable', async () => {
    registerWritingExecutor(PNG_BYTES, []);
    await expect(createCodexCliImageProvider('someone-else').available()).resolves.toBe(false);
    await expect(createCodexCliImageProvider(undefined).available()).resolves.toBe(false);
    await expect(createCodexCliImageProvider(OPERATOR_SUB).available()).resolves.toBe(true);
  });

  it('renders through the executor: anchor staged, contract prompt, PNG read back', async () => {
    const captured: CliStoryboardRenderRequest[] = [];
    registerWritingExecutor(PNG_BYTES, captured);
    const provider = createCodexCliImageProvider(OPERATOR_SUB);
    const anchor = Buffer.from('anchor-photo-bytes');

    const result = await provider.generateWithMeta!('a red circle on white', anchor);

    expect(result.image.equals(PNG_BYTES)).toBe(true);
    expect(result.costUsd).toBeNull();
    expect(result.model).toBe('gpt-5.5');
    expect(captured).toHaveLength(1);
    const req = captured[0];
    expect(req.userSub).toBe(OPERATOR_SUB);
    expect(req.workspaceFolderId).toMatch(/^sbimg-[a-z0-9-]+$/);
    expect(req.prompt).toContain('./anchor.png');
    expect(req.prompt).toContain('a red circle on white');
    expect(req.prompt).toContain('Save the final rendered image as ./output.png');
    const stagedAnchor = fs.readFileSync(path.join(tempDir, req.workspaceFolderId, 'anchor.png'));
    expect(stagedAnchor.equals(anchor)).toBe(true);
  });

  it('omits the anchor step when no reference photo is given', async () => {
    const captured: CliStoryboardRenderRequest[] = [];
    registerWritingExecutor(PNG_BYTES, captured);
    await createCodexCliImageProvider(OPERATOR_SUB).generateWithMeta!('a plain backdrop', null);
    expect(captured[0].prompt).not.toContain('anchor.png');
  });

  it('throws when the task completes without writing output.png', async () => {
    registerWritingExecutor(null, []);
    await expect(createCodexCliImageProvider(OPERATOR_SUB).generateWithMeta!('x', null))
      .rejects.toThrow(/completed without writing output\.png/);
  });

  it('throws when output.png is not a real PNG', async () => {
    registerWritingExecutor(Buffer.from('plainly not a png file at all'), []);
    await expect(createCodexCliImageProvider(OPERATOR_SUB).generateWithMeta!('x', null))
      .rejects.toThrow(/not a valid PNG/);
  });

  it('surfaces the bot-side refusal text when the executor reports failure', async () => {
    registerCliStoryboardImageExecutor(async () => ({
      success: false,
      responseText: '',
      error: 'openai-codex is an unbrokered autonomous CLI; unattended execution requires a hosted provider or audited brokered sandbox',
    }));
    await expect(createCodexCliImageProvider(OPERATOR_SUB).generateWithMeta!('x', null))
      .rejects.toThrow(/unbrokered autonomous CLI/);
  });

  it('executor seam: resolve returns exactly what was registered', () => {
    expect(resolveCliStoryboardImageExecutor()).toBeNull();
    const fn = async (): Promise<never> => { throw new Error('unused'); };
    registerCliStoryboardImageExecutor(fn);
    expect(resolveCliStoryboardImageExecutor()).toBe(fn);
  });
});
