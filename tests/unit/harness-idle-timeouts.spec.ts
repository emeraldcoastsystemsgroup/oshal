/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard-per-fix for the 2026-07-24 idle-timeout directive (extends ADR-081): harnesses must never hard-stop an actively-working run at a short wall clock — "stuck" is 10 min of full SILENCE (measurable because claude output now streams), bounded by a 60-min runaway ceiling. Covers the TS ClaudeCodeCliHarnessAdapter (stream-json default → idleReset + ceiling; explicit batch → absolute with the raised ceiling; --verbose present exactly when streaming) AND the JS ClaudeCodeCLIWrapper twin (streaming default in executeTask args, --verbose, raised constructor defaults) so the two launch paths cannot drift apart silently. Also guards the BotNodeClient dispatch timeout outliving the bot-side ceiling.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCodeCliHarnessAdapter } from '../../src/features/llm-provider/services/claude-code-cli-harness-adapter';
import { BotNodeClient } from '../../src/features/agent-management/services/bot-node-client';
// The JS bot-node twin — same directive, second launch path.
import ClaudeCodeCLIWrapper from '../../any-bot/server/services/codebase/ClaudeCodeCLIWrapper';

const ENV_KEYS = [
  'CLAUDE_CODE_OUTPUT_FORMAT',
  'CLAUDE_CODE_TIMEOUT_MS',
  'CLAUDE_CODE_INACTIVITY_TIMEOUT_MS',
  'CLAUDE_CODE_MAX_DURATION_MS',
  'BOT_NODE_DISPATCH_TIMEOUT_MS',
];
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function adapterInternals(adapter: ClaudeCodeCliHarnessAdapter): {
  idleReset: boolean; maxDurationMs: number | undefined; defaultTimeoutMs: number; outputFormat: string;
} {
  return adapter as unknown as {
    idleReset: boolean; maxDurationMs: number | undefined; defaultTimeoutMs: number; outputFormat: string;
  };
}

describe('ClaudeCodeCliHarnessAdapter timeout semantics (TS launch path)', () => {
  it('defaults to stream-json with idleReset: 10-min silence bound + 60-min ceiling', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const a = adapterInternals(new ClaudeCodeCliHarnessAdapter());
    expect(a.outputFormat).toBe('stream-json');
    expect(a.idleReset).toBe(true);
    expect(a.defaultTimeoutMs).toBe(600_000);      // silence bound
    expect(a.maxDurationMs).toBe(3_600_000);       // runaway ceiling
  });

  it('explicit batch json keeps absolute semantics with the RAISED 60-min default — never the old 10-min kill', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const a = adapterInternals(new ClaudeCodeCliHarnessAdapter({ outputFormat: 'json' }));
    expect(a.idleReset).toBe(false);
    expect(a.maxDurationMs).toBeUndefined();
    expect(a.defaultTimeoutMs).toBe(3_600_000);    // the raised absolute bound
  });

  it('honors the env knobs: inactivity, ceiling, and output format', () => {
    process.env.CLAUDE_CODE_INACTIVITY_TIMEOUT_MS = '120000';
    process.env.CLAUDE_CODE_MAX_DURATION_MS = '7200000';
    delete process.env.CLAUDE_CODE_OUTPUT_FORMAT;
    const a = adapterInternals(new ClaudeCodeCliHarnessAdapter());
    expect(a.defaultTimeoutMs).toBe(120_000);
    expect(a.maxDurationMs).toBe(7_200_000);

    process.env.CLAUDE_CODE_OUTPUT_FORMAT = 'json';
    process.env.CLAUDE_CODE_TIMEOUT_MS = '1800000';
    const b = adapterInternals(new ClaudeCodeCliHarnessAdapter());
    expect(b.outputFormat).toBe('json');
    expect(b.idleReset).toBe(false);
    expect(b.defaultTimeoutMs).toBe(1_800_000);
  });

  it('passes --verbose exactly when streaming (stream-json in print mode requires it)', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const stream = new ClaudeCodeCliHarnessAdapter() as unknown as {
      buildArgs: (task: unknown, ws: string, model: string, bridge: { mcpConfigPath: string; allowedTools: string }) => string[];
    };
    const bridge = { mcpConfigPath: '', allowedTools: 'Read' };
    const streamArgs = stream.buildArgs({}, '/tmp/ws', 'claude-opus-4-6', bridge);
    expect(streamArgs).toContain('--verbose');
    expect(streamArgs.join(' ')).toContain('--output-format stream-json');

    const batch = new ClaudeCodeCliHarnessAdapter({ outputFormat: 'json' }) as unknown as {
      buildArgs: (task: unknown, ws: string, model: string, bridge: { mcpConfigPath: string; allowedTools: string }) => string[];
    };
    const batchArgs = batch.buildArgs({}, '/tmp/ws', 'claude-opus-4-6', bridge);
    expect(batchArgs).not.toContain('--verbose');
    expect(batchArgs.join(' ')).toContain('--output-format json');
  });
});

describe('ClaudeCodeCLIWrapper timeout semantics (JS bot-node twin)', () => {
  it('constructor defaults: 60-min ceiling + 10-min silence threshold', () => {
    const w = new ClaudeCodeCLIWrapper({});
    expect(w.defaultTimeout).toBe(3600);
    expect(w.defaultInactivityTimeout).toBe(600);
  });

  it('_buildArgs defaults to stream-json with --verbose; batch opt-out omits both', () => {
    const w = new ClaudeCodeCLIWrapper({});
    const streaming = w._buildArgs('task', { streaming: true });
    expect(streaming.join(' ')).toContain('--output-format stream-json');
    expect(streaming).toContain('--verbose');

    const batch = w._buildArgs('task', { streaming: false });
    expect(batch.join(' ')).toContain('--output-format json');
    expect(batch).not.toContain('--verbose');
  });

  it('disarms the inactivity KILL for explicit batch runs even when killOnInactivity is configured ON', async () => {
    // Idle-kill requires measurable idleness: batch json is silent until the final
    // object, so a batch run must never die at the silence threshold — the hard
    // ceiling owns termination there (ADR-081 honesty rule, preserved through the
    // 2026-07-24 kill-default flip).
    const fsm = await import('fs');
    const osm = await import('os');
    const pathm = await import('path');
    const tmpDir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'oshal-claude-batch-disarm-'));
    const fakeCli = pathm.join(tmpDir, 'silent-success.cjs');
    fsm.writeFileSync(fakeCli, `
process.stdin.resume();
process.stdin.on('end', () => {
  setTimeout(() => {
    process.stdout.write(JSON.stringify({
      type: 'result', subtype: 'success', result: 'batch survived silence',
      total_cost_usd: 0, duration_ms: 150, num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 2 }
    }));
  }, 150);
});
`);
    try {
      const w = new ClaudeCodeCLIWrapper({ claudeCommand: process.execPath, model: 'fake-model' });
      w._buildArgs = () => [fakeCli];
      const result = await w.executeTask('stay alive while silent', tmpDir, {
        streaming: false,           // explicit batch opt-out
        killOnInactivity: true,     // configured ON — must be disarmed by the batch coupling
        timeout: 5,
        inactivityTimeout: 0.05,
        inactivityCheckIntervalMs: 25,
      });
      expect(result.success).toBe(true);
      expect(result.text).toBe('batch survived silence');
      expect(result.inactivityObserved).toBe(true);
    } finally {
      fsm.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('REJECTS a streaming run that ends without a final result event (crash guard, not silent garbage)', async () => {
    const fsm = await import('fs');
    const osm = await import('os');
    const pathm = await import('path');
    const tmpDir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'oshal-claude-crash-'));
    // A CLI that emits partial NDJSON (assistant events) then exits nonzero WITHOUT a
    // type:"result" event — i.e. crashed/killed mid-stream.
    const fakeCli = pathm.join(tmpDir, 'crash-midstream.cjs');
    fsm.writeFileSync(fakeCli, `
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }) + '\\n');
  process.exit(1); // died before the final result event
});
`);
    try {
      const w = new ClaudeCodeCLIWrapper({ claudeCommand: process.execPath, model: 'fake-model' });
      w._buildArgs = () => [fakeCli];
      await expect(
        w.executeTask('do work', tmpDir, { streaming: true, timeout: 5, inactivityTimeout: 5, inactivityCheckIntervalMs: 25 }),
      ).rejects.toThrow(/without a final result event/);
    } finally {
      fsm.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('_parseJsonResult extracts the final result event from an NDJSON stream (streaming output shape)', () => {
    const w = new ClaudeCodeCLIWrapper({});
    const ndjson = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working…' }] } }),
      JSON.stringify({
        type: 'result', subtype: 'success', result: 'final answer', total_cost_usd: 0.42,
        usage: { input_tokens: 100, output_tokens: 50 }, num_turns: 3,
      }),
    ].join('\n');
    const parsed = w._parseJsonResult(ndjson);
    expect(parsed.success).toBe(true);
    expect(parsed.result).toBe('final answer');
    expect(parsed.costUSD).toBeCloseTo(0.42);
    expect(parsed.usage.inputTokens).toBe(100);
  });
});

describe('BotNodeClient dispatch timeout', () => {
  it('default outlives the 60-min bot-side ceiling (was 15 min — would abort working bots)', () => {
    delete process.env.BOT_NODE_DISPATCH_TIMEOUT_MS;
    const client = new BotNodeClient(() => null) as unknown as { timeoutMs: number };
    expect(client.timeoutMs).toBeGreaterThanOrEqual(3_600_000 + 60_000);
  });

  it('honors BOT_NODE_DISPATCH_TIMEOUT_MS', () => {
    process.env.BOT_NODE_DISPATCH_TIMEOUT_MS = '1234567';
    const client = new BotNodeClient(() => null) as unknown as { timeoutMs: number };
    expect(client.timeoutMs).toBe(1_234_567);
  });
});
