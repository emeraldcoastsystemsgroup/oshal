/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Behavior tests for BaseCliHarnessAdapter + adapter parse paths (no live CLI / no docker)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-081 idle-timeout semantics: an actively-streaming child survives past timeoutMs (output refreshes the timer), a silent child still dies at timeoutMs, and maxDurationMs hard-caps a chatty runaway. Real subprocesses, no mocks.
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BaseCliHarnessAdapter, type CliExecResult } from '@/features/llm-provider/services/base-cli-harness-adapter';
import type { HarnessTask, HarnessResult, HarnessType } from '@/features/llm-provider/services/harness-adapter';

// ── Fake subclass so we can hit the protected base methods deterministically ──
class TestSubclass extends BaseCliHarnessAdapter {
  readonly harnessType: HarnessType = 'noop';

  constructor() {
    super('test-subclass', 5_000);
  }

  // Force the base default healthCheck to actually run.
  protected override healthCheckBinary(): string | null {
    return 'node';
  }

  async run(_task: HarnessTask): Promise<HarnessResult> {
    return { text: '', usage: { inputTokens: 0, outputTokens: 0 }, model: 'test', stopReason: 'end_turn' };
  }

  // Re-export protected methods for testing.
  publicExecCapturing(binary: string, args: string[], env: Record<string, string>, cwd: string, timeoutMs?: number): Promise<CliExecResult> {
    return this.execCapturing(binary, args, env, cwd, timeoutMs);
  }

  publicEstimateUsage(prompt: string, response: string) {
    return this.estimateUsage(prompt, response);
  }

  publicAcquireUserScopingLease(
    env: Record<string, string>,
    workspacePath: string,
    userSub?: string,
    creds?: Record<string, string>,
  ): Promise<() => void> {
    return this.acquireUserScopingLease(env, workspacePath, userSub, creds);
  }
}

// ── Idle-semantics subclass (ADR-081): output refreshes the timer; maxDurationMs backstops ──
class IdleTestSubclass extends BaseCliHarnessAdapter {
  readonly harnessType: HarnessType = 'noop';

  constructor(timeoutMs: number, maxDurationMs?: number) {
    super('idle-test-subclass', timeoutMs, { idleReset: true, maxDurationMs });
  }

  async run(_task: HarnessTask): Promise<HarnessResult> {
    return { text: '', usage: { inputTokens: 0, outputTokens: 0 }, model: 'test', stopReason: 'end_turn' };
  }

  publicExecCapturing(binary: string, args: string[], env: Record<string, string>, cwd: string, timeoutMs?: number): Promise<CliExecResult> {
    return this.execCapturing(binary, args, env, cwd, timeoutMs);
  }
}

test.describe('BaseCliHarnessAdapter — idle timeout semantics (ADR-081)', () => {
  test('an actively-streaming child SURVIVES past timeoutMs — output refreshes the timer', async () => {
    const sub = new IdleTestSubclass(300);
    // Emits a tick every 100ms for ~900ms then exits 0. Total runtime (900ms) is 3× the
    // 300ms timeout — under the old absolute semantics this run was killed (the 2026-07-06
    // incident shape); under idle semantics every tick resets the timer.
    const result = await sub.publicExecCapturing(
      'node',
      ['-e', 'let n=0; const t=setInterval(()=>{process.stdout.write("tick"+(n++)); if(n>=9){clearInterval(t);process.exit(0);}},100);'],
      process.env as Record<string, string>,
      process.cwd(),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('tick0');
    expect(result.stdout).toContain('tick8');
  });

  test('a SILENT child still dies at timeoutMs, with an idle-specific message', async () => {
    const sub = new IdleTestSubclass(300);
    await expect(
      sub.publicExecCapturing(
        'node',
        ['-e', 'setTimeout(() => process.exit(0), 5000);'],   // no output at all
        process.env as Record<string, string>,
        process.cwd(),
      ),
    ).rejects.toThrow(/timed out after 300ms of silence/);
  });

  test('maxDurationMs hard-caps a chatty runaway that never goes idle', async () => {
    const sub = new IdleTestSubclass(300, 700);
    const start = Date.now();
    await expect(
      sub.publicExecCapturing(
        'node',
        ['-e', 'setInterval(()=>process.stdout.write("still-going"),50);'],   // streams forever
        process.env as Record<string, string>,
        process.cwd(),
      ),
    ).rejects.toThrow(/exceeded max duration 700ms/);
    expect(Date.now() - start, 'killed near the 700ms cap, not the idle timer').toBeLessThan(3000);
  });
});

test.describe('BaseCliHarnessAdapter — subprocess plumbing', () => {
  test('execCapturing returns stdout/stderr/exitCode from a real subprocess', async () => {
    const sub = new TestSubclass();
    // Use node -e to deterministically print to stdout/stderr and exit non-zero.
    const result = await sub.publicExecCapturing(
      'node',
      ['-e', 'process.stdout.write("hello-stdout"); process.stderr.write("warn-stderr"); process.exit(7);'],
      process.env as Record<string, string>,
      process.cwd(),
    );
    expect(result.stdout).toBe('hello-stdout');
    expect(result.stderr).toBe('warn-stderr');
    expect(result.exitCode).toBe(7);
  });

  test('execCapturing rejects with timeout error when subprocess runs past timeoutMs', async () => {
    const sub = new TestSubclass();
    const start = Date.now();
    await expect(
      sub.publicExecCapturing(
        'node',
        ['-e', 'setTimeout(() => process.exit(0), 5000);'],
        process.env as Record<string, string>,
        process.cwd(),
        300, // 300ms — must trip the timeout
      ),
    ).rejects.toThrow(/timed out after 300ms/);
    const elapsed = Date.now() - start;
    expect(elapsed, 'kill happens within ~600ms of the 300ms deadline').toBeLessThan(2000);
  });

  test('execCapturing rejects with spawn error for a non-existent binary', async () => {
    const sub = new TestSubclass();
    await expect(
      sub.publicExecCapturing(
        '/nonexistent/binary/that/does/not/exist',
        [],
        process.env as Record<string, string>,
        process.cwd(),
      ),
    ).rejects.toThrow(/failed to spawn/);
  });

  test('estimateUsage uses the 4-chars-per-token heuristic', () => {
    const sub = new TestSubclass();
    // 8 chars → 2 tokens, 16 chars → 4 tokens, 8+16=24 total
    const usage = sub.publicEstimateUsage('12345678', '1234567890123456');
    expect(usage.inputTokens).toBe(2);
    expect(usage.outputTokens).toBe(4);
    expect(usage.totalTokens).toBe(6);
  });

  test('healthCheck returns true when the probed binary exists (node)', async () => {
    const sub = new TestSubclass();
    const ok = await sub.healthCheck();
    expect(ok).toBe(true);
  });
});

test.describe('BaseCliHarnessAdapter brokered credential isolation', () => {
  test('serializes a shared workspace and exposes only each invocation credential', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-ts-scope-'));
    const sub = new TestSubclass();
    try {
      const shoppingEnv: Record<string, string> = {};
      const releaseShopping = await sub.publicAcquireUserScopingLease(
        shoppingEnv, dir, 'owner-1',
        { OSHAL_CRED_WALMART: 'walmart-token', PATH: '/forbidden' },
      );
      expect(shoppingEnv.OSHAL_CRED_WALMART).toBe('walmart-token');
      expect(shoppingEnv.PATH).toBeUndefined();
      expect(fs.existsSync(path.join(dir, '.oshal-cred-walmart'))).toBe(true);
      expect(fs.existsSync(path.join(dir, '.oshal-cred-uber'))).toBe(false);

      const eatsEnv: Record<string, string> = {};
      let eatsAcquired = false;
      const releaseEatsPromise = sub.publicAcquireUserScopingLease(
        eatsEnv, dir, 'owner-1', { OSHAL_CRED_UBER: 'uber-token' },
      ).then((release) => {
        eatsAcquired = true;
        return release;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(eatsAcquired).toBe(false);

      releaseShopping();
      const releaseEats = await releaseEatsPromise;
      expect(fs.existsSync(path.join(dir, '.oshal-cred-walmart'))).toBe(false);
      expect(fs.readFileSync(path.join(dir, '.oshal-cred-uber'), 'utf8')).toBe('uber-token');
      releaseShopping();
      expect(fs.existsSync(path.join(dir, '.oshal-cred-uber'))).toBe(true);
      if (process.platform !== 'win32') {
        expect(fs.statSync(path.join(dir, '.oshal-cred-uber')).mode & 0o777).toBe(0o600);
      }
      releaseEats();
      expect(fs.existsSync(path.join(dir, '.oshal-cred-uber'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Adapter parse-path behavior — synthetic stdout fixtures ──
import { ClaudeCodeCliHarnessAdapter } from '@/features/llm-provider/services/claude-code-cli-harness-adapter';
import { GeminiCliHarnessAdapter } from '@/features/llm-provider/services/gemini-cli-harness-adapter';

test.describe('adapter JSON parsing — behavior, not regex', () => {
  test('ClaudeCodeCliHarnessAdapter parses claude --output-format json with real usage telemetry', async () => {
    const adapter = new ClaudeCodeCliHarnessAdapter({ outputFormat: 'json', model: 'claude-test' });
    // The CLI emits one or more JSON lines; the adapter picks the last
    // `{"type":"result"}` envelope.
    const fakeStdout = JSON.stringify({
      type: 'result',
      result: 'Hello from claude',
      usage: {
        input_tokens: 100,
        output_tokens: 25,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 10,
      },
      cost_usd: 0.0042,
    });
    // parseJsonOutput is private — exercise it through reflection via `as any`.
    // This is a behavior test: given canonical claude JSON, what do we return?
    const result = (adapter as any).parseJsonOutput(fakeStdout, 'claude-test', 'task-xyz') as HarnessResult;
    expect(result.text).toBe('Hello from claude');
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(25);
    expect(result.usage.cacheReadTokens).toBe(50);
    expect(result.usage.cacheWriteTokens).toBe(10);
    expect(result.usage.totalTokens).toBe(125);
  });

  test('ClaudeCodeCliHarnessAdapter throws on is_error:true with detail', async () => {
    const adapter = new ClaudeCodeCliHarnessAdapter({ outputFormat: 'json' });
    const fakeStdout = JSON.stringify({
      type: 'result',
      is_error: true,
      result: 'Invalid API key · Fix external API key',
    });
    expect(() => (adapter as any).parseJsonOutput(fakeStdout, 'm', 't'))
      .toThrow(/Invalid API key/);
  });

  test('GeminiCliHarnessAdapter accepts the result/text/response key spellings the CLI has used', () => {
    const adapter = new GeminiCliHarnessAdapter({ outputFormat: 'json' });
    const cases = [
      { stdout: JSON.stringify({ result: 'r-shape' }), want: 'r-shape' },
      { stdout: JSON.stringify({ text: 't-shape' }), want: 't-shape' },
      { stdout: JSON.stringify({ response: 'resp-shape' }), want: 'resp-shape' },
    ];
    for (const c of cases) {
      const out = (adapter as any).parseJsonOutput(c.stdout, 'gemini-2.5', 't') as HarnessResult;
      expect(out.text, `parsed ${c.stdout}`).toBe(c.want);
    }
  });

  test('GeminiCliHarnessAdapter usage parser handles all three token-count shapes', () => {
    const adapter = new GeminiCliHarnessAdapter({ outputFormat: 'json' });
    const cases = [
      // snake_case (OpenAI-style)
      { stdout: JSON.stringify({ result: 'x', usage: { input_tokens: 11, output_tokens: 7 } }), in: 11, out: 7 },
      // camelCase
      { stdout: JSON.stringify({ result: 'x', usage: { inputTokens: 13, outputTokens: 9 } }), in: 13, out: 9 },
      // Google's promptTokenCount / candidatesTokenCount
      { stdout: JSON.stringify({ result: 'x', usage: { promptTokenCount: 17, candidatesTokenCount: 5 } }), in: 17, out: 5 },
    ];
    for (const c of cases) {
      const out = (adapter as any).parseJsonOutput(c.stdout, 'gemini-2.5', 't') as HarnessResult;
      expect(out.usage.inputTokens, `inputTokens for ${c.stdout}`).toBe(c.in);
      expect(out.usage.outputTokens, `outputTokens for ${c.stdout}`).toBe(c.out);
    }
  });

  test('GeminiCliHarnessAdapter falls back to plain text when no JSON shape matches', () => {
    const adapter = new GeminiCliHarnessAdapter({ outputFormat: 'json' });
    // Not JSON, just text — adapter must return the raw text rather than throw.
    const out = (adapter as any).parseJsonOutput('just plain output', 'gemini-2.5', 't') as HarnessResult;
    expect(out.text).toBe('just plain output');
    expect(out.usage.inputTokens).toBe(0);
    expect(out.usage.outputTokens).toBe(0);
  });
});

// ── HARNESS_RUNTIME_DEFAULTS — metadata-driven resolution ──
import { HARNESS_RUNTIME_DEFAULTS } from '@/app/composition/provider-runtime';

test.describe('HARNESS_RUNTIME_DEFAULTS', () => {
  test('every HarnessType has an entry (compile-time guarantee, runtime sanity)', () => {
    // 'noop' is the union's no-LLM harness (the legacy stub name was fully retired in the de-brand pass).
    const required: HarnessType[] = ['codex-cli', 'claude-code', 'gemini-cli', 'cline', 'noop'];
    for (const h of required) {
      expect(HARNESS_RUNTIME_DEFAULTS[h], `missing entry for ${h}`).toBeDefined();
      expect(typeof HARNESS_RUNTIME_DEFAULTS[h].resolveModel, `${h}.resolveModel is a function`).toBe('function');
      expect(typeof HARNESS_RUNTIME_DEFAULTS[h].resolveBinary, `${h}.resolveBinary is a function`).toBe('function');
    }
  });

  test('resolveModel honors per-harness env override over fallback', () => {
    const prevCodex = process.env.CODEX_MODEL;
    const prevGemini = process.env.GEMINI_MODEL;
    try {
      process.env.CODEX_MODEL = 'gpt-5.99-codex-test';
      process.env.GEMINI_MODEL = 'gemini-test-1.0';
      const fallback = () => 'should-not-be-used';
      expect(HARNESS_RUNTIME_DEFAULTS['codex-cli'].resolveModel(fallback)).toBe('gpt-5.99-codex-test');
      expect(HARNESS_RUNTIME_DEFAULTS['gemini-cli'].resolveModel(fallback)).toBe('gemini-test-1.0');
    } finally {
      if (prevCodex === undefined) delete process.env.CODEX_MODEL; else process.env.CODEX_MODEL = prevCodex;
      if (prevGemini === undefined) delete process.env.GEMINI_MODEL; else process.env.GEMINI_MODEL = prevGemini;
    }
  });

  test('resolveModel falls through to fallback when env unset', () => {
    const prev = process.env.CLAUDE_CODE_MODEL;
    try {
      delete process.env.CLAUDE_CODE_MODEL;
      const fallback = () => 'system-default-model';
      expect(HARNESS_RUNTIME_DEFAULTS['claude-code'].resolveModel(fallback)).toBe('system-default-model');
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_MODEL; else process.env.CLAUDE_CODE_MODEL = prev;
    }
  });
});
