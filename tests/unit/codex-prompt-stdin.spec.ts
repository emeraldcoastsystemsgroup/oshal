/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the codex E2BIG fix: the prompt must ride STDIN, never a positional argv (a large prompt as an argument overflows OS ARG_MAX → `spawn E2BIG`, which killed every Dungeon Master turn live). Proves (1) buildArgs emits only bounded flags — no prompt embedded — and (2) execCodexLenient forwards its `input` to execCapturing as stdin. A reintroduced `args.push(prompt)` fails both.
 */

import { describe, expect, it } from 'vitest';
import { CodexCliHarnessAdapter } from '../../src/features/llm-provider/services/codex-cli-harness-adapter';

/** Test seam: exposes the private buildArgs/execCodexLenient and captures execCapturing calls. */
class ProbeCodex extends CodexCliHarnessAdapter {
  public captured?: { args: string[]; input?: string };
  public buildArgsPublic(ws: string, model: string): string[] {
    return (this as unknown as { buildArgs: (w: string, m: string) => string[] }).buildArgs(ws, model);
  }
  public execCodexLenientPublic(input: string): Promise<unknown> {
    return (this as unknown as {
      execCodexLenient: (b: string, a: string[], e: Record<string, string>, c: string, t?: number, i?: string) => Promise<unknown>;
    }).execCodexLenient('codex', ['exec', '--json'], {}, '/tmp/ws', undefined, input);
  }
  // Override the base subprocess plumbing so no real codex is spawned.
  protected override execCapturing(
    _binary: string,
    args: string[],
    _env: Record<string, string>,
    _cwd: string,
    _timeoutMs?: number,
    input?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.captured = { args, input };
    return Promise.resolve({ stdout: '{"type":"item.completed"}', stderr: '', exitCode: 0 });
  }
}

describe('CodexCliHarnessAdapter prompt delivery (E2BIG guard)', () => {
  it('buildArgs emits only bounded flags — the prompt is NOT a positional argv', () => {
    const adapter = new ProbeCodex();
    const args = adapter.buildArgsPublic('/tmp/ws', 'gpt-5');
    // Every arg is a short flag/path — nothing prompt-sized. A reintroduced args.push(prompt)
    // would put a large string here and re-open the E2BIG failure.
    for (const a of args) {
      expect(a.length).toBeLessThan(256);
    }
    expect(args).toContain('exec');
    expect(args).toContain('--json');
    // No positional prompt slot: args end on a flag/value pair, not free text.
    expect(args.join(' ')).not.toMatch(/DUNGEON|conversation|You are/i);
  });

  it('a huge prompt passes through as STDIN input, never as an argv element', async () => {
    const adapter = new ProbeCodex();
    const bigPrompt = 'You are the Dungeon Master.\n' + 'X'.repeat(400_000); // > typical ARG_MAX
    await adapter.execCodexLenientPublic(bigPrompt);
    expect(adapter.captured?.input).toBe(bigPrompt);
    // The giant prompt must appear in NO argv element (that is exactly the E2BIG trigger).
    for (const a of adapter.captured?.args ?? []) {
      expect(a.includes('X'.repeat(400_000))).toBe(false);
      expect(a.length).toBeLessThan(1024);
    }
  });
});
