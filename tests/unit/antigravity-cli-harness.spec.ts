/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the Antigravity CLI harness (operator, 2026-09-18: add it as another supported CLI and keep gemini-cli, so both live side by side). Pins the published headless contract rather than a guess — `-p`, `--output-format json`, `--model`, `--print-timeout`, and NEVER `--dangerously-skip-permissions`, which auto-approves every tool call and contradicts the fail-closed harness posture. Pins the single-object JSON envelope (conversation_id/status/response/error/usage) and that `status` outranks the exit code, because a zero exit with status ERROR is the shape that would otherwise be handed to a user AS THE ANSWER. Also pins that the union and the factory record stay in step: adding a harness type without a factory is already a compile error, and this asserts the pair a reader can check.
 */

import { describe, it, expect, vi } from 'vitest';
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyCostUnit } from '@/features/cost-governance';
import { AntigravityCliHarnessAdapter } from '@/features/llm-provider/harness';
import { HARNESS_FACTORIES } from '@/app/composition/provider-runtime';

const ADAPTER_SOURCE = join(process.cwd(), 'src/features/llm-provider/services/antigravity-cli-harness-adapter.ts');

/** Reach one private method without widening the class's public surface for a test. */
function callPrivate<T>(adapter: AntigravityCliHarnessAdapter, method: string, ...args: unknown[]): T {
  return (adapter as unknown as Record<string, (...a: unknown[]) => T>)[method](...args);
}

describe('the Antigravity CLI is a registered harness beside gemini-cli', () => {
  it('is in the factory record, and gemini-cli is still there too', () => {
    // "keep gemini cli as a cli as well" — this is a sibling, not a replacement.
    expect(typeof HARNESS_FACTORIES['antigravity-cli']).toBe('function');
    expect(typeof HARNESS_FACTORIES['gemini-cli']).toBe('function');
  });

  it('builds the published headless argument vector, and never auto-approves tools', () => {
    const adapter = new AntigravityCliHarnessAdapter({ model: 'gemini-3.8-flash', timeoutMs: 600_000 });
    const args = callPrivate<string[]>(adapter, 'buildArgs', { prompt: 'hello', taskId: 't1' }, 'gemini-3.8-flash');

    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-3.8-flash');
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
    // The CLI's own --print-timeout defaults to five minutes, so it must always be passed:
    // otherwise the CLI kills a long run well before the adapter's own ceiling.
    expect(args).toContain('--print-timeout');
    expect(args[args.indexOf('--print-timeout') + 1]).toBe('10m');
    // -p is the headless flag and the prompt must be its value, not a positional argument
    // (a positional query routes to the interactive TUI, which never returns in a container).
    expect(args).toContain('-p');
    expect(args[args.indexOf('-p') + 1]).toContain('hello');

    expect(args, 'auto-approving every tool call contradicts the fail-closed harness posture')
      .not.toContain('--dangerously-skip-permissions');
  });

  it('parses the single JSON envelope the CLI documents, including its own token total', () => {
    const adapter = new AntigravityCliHarnessAdapter();
    const envelope = JSON.stringify({
      conversation_id: '055a398f-db14-4c5f-abbb-1bf03f8120a7',
      status: 'SUCCESS',
      response: 'a rebase rewrites history',
      duration_seconds: 7.16,
      num_turns: 1,
      usage: {
        input_tokens: 10415, output_tokens: 657, thinking_tokens: 616,
        cache_read_tokens: 8113, total_tokens: 11072,
      },
    });
    const result = callPrivate<{ text: string; usage: Record<string, number> }>(
      adapter, 'parseJsonOutput', envelope, 'gemini-3.8-flash', 0, '', 't1',
    );
    expect(result.text).toBe('a rebase rewrites history');
    expect(result.usage.inputTokens).toBe(10415);
    expect(result.usage.outputTokens).toBe(657);
    expect(result.usage.cacheReadTokens).toBe(8113);
    // The CLI's own total includes thinking tokens the two visible counts omit, so it must be
    // carried rather than recomputed — cost attribution is wrong by 616 tokens otherwise.
    expect(result.usage.totalTokens).toBe(11072);
  });

  it('treats status as authoritative over the exit code', () => {
    const adapter = new AntigravityCliHarnessAdapter();
    // The shape that matters: a ZERO exit with a failed status. Trusting the exit code here is
    // how an error banner gets handed to a user as though it were the answer.
    expect(() => callPrivate(
      adapter, 'parseJsonOutput',
      JSON.stringify({ status: 'ERROR', error: 'quota exhausted', response: '' }),
      'gemini-3.8-flash', 0, '', 't1',
    )).toThrow(/ERROR.*quota exhausted/);

    for (const status of ['CANCELED', 'INTERRUPTED', 'INVALID']) {
      expect(() => callPrivate(
        adapter, 'parseJsonOutput',
        JSON.stringify({ status, response: 'partial' }), 'gemini-3.8-flash', 0, '', 't1',
      ), `${status} is not a completed answer`).toThrow();
    }
    // The shape a denylist cannot catch: a status nobody enumerated, with a zero exit and a body.
    // Before the allowlist this was returned to the caller as the answer.
    expect(() => callPrivate(
      adapter, 'parseJsonOutput',
      JSON.stringify({ status: 'THROTTLED', response: 'here is your answer' }),
      'gemini-3.8-flash', 0, '', 't1',
    ), 'an unknown status is not a completed answer').toThrow(/unrecognised/i);

    for (const status of ['WAITING', 'RUNNING']) {
      expect(() => callPrivate(
        adapter, 'parseJsonOutput',
        JSON.stringify({ status, response: 'partial' }), 'gemini-3.8-flash', 0, '', 't1',
      ), `${status} means the run never finished`).toThrow(/did not finish/);
    }
  });

  it('refuses on musl with the MEASURED cause, and does not refuse on glibc', () => {
    // Measured 2026-09-18: manifests/linux_amd64_musl.json is 404, and the glibc artifact is a PIE
    // against /lib64/ld-linux-x86-64.so.2 that fails to relocate under gcompat on node:20-alpine.
    // The cline 3.x glibc build cost this project weeks of a dead fallback brain for exactly this
    // shape, so the reason has to be in the refusal text, not in someone's memory.
    //
    // This CALLS the method. It used to grep the adapter file for 'blockingReason' and
    // 'linux_amd64_musl.json' — both of which appear in the CHANGE LOG, so the case passed on an
    // adapter whose method had been deleted. A guard the prose satisfies is not a guard.
    const adapter = new AntigravityCliHarnessAdapter();
    const realPlatform = process.platform;
    const existsSync = vi.spyOn(fs, 'existsSync');
    try {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

      existsSync.mockImplementation((p) => String(p).includes('libc.musl'));
      const musl = adapter.blockingReason();
      expect(musl, 'a musl node must refuse').toBeTruthy();
      expect(musl, 'name the 404 manifest so the cause is findable').toContain('linux_amd64_musl.json');
      expect(musl, 'and name the confined runtime that makes it runnable on Alpine').toContain('private glibc runtime');

      existsSync.mockImplementation(() => false);
      expect(adapter.blockingReason(), 'a glibc linux node must NOT refuse').toBeNull();

      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      existsSync.mockImplementation((p) => String(p).includes('libc.musl'));
      expect(adapter.blockingReason(), 'the musl wall is a linux question only').toBeNull();
    } finally {
      existsSync.mockRestore();
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    }
  });

  it('writes the provider settings file the CLI requires, because the key alone does nothing', () => {
    // Documented: "Only setting a GEMINI_API_KEY environment variable on its own has no effect."
    // A container with a good key and no settings file fails for a reason nothing would explain.
    const root = mkdtempSync(join(tmpdir(), 'agy-settings-'));
    try {
      const settingsPath = join(root, 'nested', 'settings.json');
      const adapter = new AntigravityCliHarnessAdapter({ settingsPath });
      callPrivate(adapter, 'ensureProviderSettings');

      expect(existsSync(settingsPath), 'a declared path is created').toBe(true);
      expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ modelProvider: 'gemini' });

      // An operator's own configuration wins — the file is never rewritten.
      writeFileSync(settingsPath, '{"modelProvider":"vertex"}', 'utf8');
      callPrivate(adapter, 'ensureProviderSettings');
      expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ modelProvider: 'vertex' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never creates a config tree in a home directory nobody asked it to touch', () => {
    // The default path is the operator's REAL ~/.gemini on a host run. Writing there uninvited is
    // not the adapter's call to make, so an undeclared path with no existing directory is skipped.
    const root = mkdtempSync(join(tmpdir(), 'agy-home-'));
    const realHome = os.homedir;
    try {
      (os as { homedir: () => string }).homedir = () => root;
      const adapter = new AntigravityCliHarnessAdapter();
      callPrivate(adapter, 'ensureProviderSettings');
      expect(
        existsSync(join(root, '.gemini')),
        'an undeclared home path must be left alone, not created',
      ).toBe(false);
    } finally {
      (os as { homedir: () => string }).homedir = realHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a non-numeric timeout falls back to the default instead of becoming NaN', () => {
    // `??` catches null and undefined, not NaN, so a typo used to reach `--print-timeout NaNm`.
    const prior = process.env.ANTIGRAVITY_TIMEOUT_MS;
    try {
      process.env.ANTIGRAVITY_TIMEOUT_MS = 'not-a-number';
      const args = callPrivate<string[]>(
        new AntigravityCliHarnessAdapter(), 'buildArgs', { prompt: 'x', taskId: 't' }, 'm',
      );
      const printTimeout = args[args.indexOf('--print-timeout') + 1];
      expect(printTimeout).not.toContain('NaN');
      expect(printTimeout).toBe('60m');

      process.env.ANTIGRAVITY_TIMEOUT_MS = '-5';
      const negative = callPrivate<string[]>(
        new AntigravityCliHarnessAdapter(), 'buildArgs', { prompt: 'x', taskId: 't' }, 'm',
      );
      expect(negative[negative.indexOf('--print-timeout') + 1]).toBe('60m');
    } finally {
      if (prior === undefined) delete process.env.ANTIGRAVITY_TIMEOUT_MS;
      else process.env.ANTIGRAVITY_TIMEOUT_MS = prior;
    }
  });

  it('reports unhealthy WITH the measured cause on a node that cannot run it', async () => {
    // blockingReason() is consumed in run(), and run() is unreachable: the audited-harness guard
    // throws first for every CLI harness. So the musl diagnosis reached no surface at all, and an
    // operator saw only the generic unbrokered-CLI refusal. healthCheck is not behind that guard.
    const adapter = new AntigravityCliHarnessAdapter();
    const realPlatform = process.platform;
    const existsSync = vi.spyOn(fs, 'existsSync');
    try {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      existsSync.mockImplementation((p) => String(p).includes('libc.musl'));
      await expect(adapter.healthCheck()).resolves.toBe(false);
    } finally {
      existsSync.mockRestore();
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    }
  });

  it('refuses an oversized prompt by name instead of dying as spawn E2BIG', () => {
    // Linux caps a SINGLE argv value at MAX_ARG_STRLEN (128 KiB) regardless of the much larger
    // ARG_MAX. The Codex adapter learned this live - a positional prompt killed every Dungeon
    // Master turn once the conversation grew - and both siblings moved to stdin. This adapter
    // cannot yet, so the bound is explicit and the refusal names the cause.
    const adapter = new AntigravityCliHarnessAdapter();
    expect(() => callPrivate(adapter, 'buildArgs', { prompt: 'x'.repeat(200_000), taskId: 't' }, 'm'))
      .toThrow(/over the \d+-byte limit for a single argv value/);
    // A normal prompt is untouched.
    const ok = callPrivate<string[]>(adapter, 'buildArgs', { prompt: 'hello', taskId: 't' }, 'm');
    expect(ok[ok.indexOf('-p') + 1]).toContain('hello');
  });

  it('is metered in the same cost unit as its sibling on the identical Google credential', () => {
    // It reached the harness union, the factory record, HARNESS_BY_ID and the unattended-denial
    // set without reaching the price-equivalent sets, so one account would have read in two units.
    expect(classifyCostUnit('antigravity-cli')).toBe(classifyCostUnit('gemini-cli'));
  });
});
