/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the Antigravity CLI harness (operator, 2026-09-18: add it as another supported CLI and keep gemini-cli, so both live side by side). Pins the published headless contract rather than a guess — `-p`, `--output-format json`, `--model`, `--print-timeout`, and NEVER `--dangerously-skip-permissions`, which auto-approves every tool call and contradicts the fail-closed harness posture. Pins the single-object JSON envelope (conversation_id/status/response/error/usage) and that `status` outranks the exit code, because a zero exit with status ERROR is the shape that would otherwise be handed to a user AS THE ANSWER. Also pins that the union and the factory record stay in step: adding a harness type without a factory is already a compile error, and this asserts the pair a reader can check.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
    for (const status of ['WAITING', 'RUNNING']) {
      expect(() => callPrivate(
        adapter, 'parseJsonOutput',
        JSON.stringify({ status, response: 'partial' }), 'gemini-3.8-flash', 0, '', 't1',
      ), `${status} means the run never finished`).toThrow(/did not finish/);
    }
  });

  it('refuses with the MEASURED musl cause rather than an ENOENT on a file that exists', () => {
    // Measured 2026-09-18: manifests/linux_amd64_musl.json is 404, and the glibc artifact is a PIE
    // against /lib64/ld-linux-x86-64.so.2 that fails to relocate under gcompat on node:20-alpine.
    // The cline 3.x glibc build cost this project weeks of a dead fallback brain for exactly this
    // shape, so the reason has to be in the refusal text, not in someone's memory.
    const source = readFileSync(ADAPTER_SOURCE, 'utf8');
    expect(source).toContain('blockingReason');
    expect(source, 'the refusal must name the 404 manifest so the cause is findable')
      .toContain('linux_amd64_musl.json');
    expect(source, 'and name the working alternative on this image').toContain('gemini-cli');
  });

  it('writes the provider settings file the CLI requires, because the key alone does nothing', () => {
    // Documented: "Only setting a GEMINI_API_KEY environment variable on its own has no effect."
    // A container with a good key and no settings file fails for a reason nothing would explain.
    const source = readFileSync(ADAPTER_SOURCE, 'utf8');
    expect(source).toContain('ensureProviderSettings');
    expect(source).toContain('modelProvider');
    expect(source, 'an existing operator-written settings file is never overwritten')
      .toMatch(/existsSync\(this\.settingsPath\)\)\s*return;/);
  });
});
