/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | OSHAL Node Antigravity executor (packages/oshal-chat/src/main/antigravity-executor.ts): where agy is found (explicit, env, the Windows installer default, PATH), the headless argument vector (never --dangerously-skip-permissions), the JSON envelope rule (SUCCESS or absent, exit 0, non-empty response), and runAntigravity spawning WITHOUT a shell with the prompt as one intact argument in a throwaway directory. child_process.spawn is intercepted, so no CLI runs; the real process boundary (agy reading its -p argument, signed in) is a pending live proof on a node with agy installed (see the real-boundary audit).
 */
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawned = vi.hoisted(() => ({ calls: [] as Array<{ command: string; args: string[]; options: Record<string, unknown> }>, reply: { stdout: '', stderr: '', code: 0 as number | null } }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: Record<string, unknown>) => {
      spawned.calls.push({ command, args, options });
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { end: () => void }; kill: () => void };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end: () => undefined };
      child.kill = () => undefined;
      setTimeout(() => {
        if (spawned.reply.stdout) child.stdout.emit('data', Buffer.from(spawned.reply.stdout));
        if (spawned.reply.stderr) child.stderr.emit('data', Buffer.from(spawned.reply.stderr));
        child.emit('close', spawned.reply.code);
      }, 1);
      return child;
    },
  };
});

import {
  MAX_ANTIGRAVITY_PROMPT_CHARS,
  antigravityInstalled,
  buildAntigravityArgs,
  parseAntigravityJson,
  resolveAntigravityCommand,
  runAntigravity,
} from '../../packages/oshal-chat/src/main/antigravity-executor';

afterEach(() => { spawned.calls.length = 0; spawned.reply = { stdout: '', stderr: '', code: 0 }; });

const LOCAL = 'C:\\Users\\someone\\AppData\\Local';
const INSTALLED = join(LOCAL, 'agy', 'bin', 'agy.exe');

describe('finding agy', () => {
  it('prefers an explicit path, then ANTIGRAVITY_CLI_PATH, then the Windows installer default, then agy on PATH', () => {
    const none = () => false, installed = (p: string) => p === INSTALLED;
    expect(resolveAntigravityCommand('D:\\tools\\agy.exe', { ANTIGRAVITY_CLI_PATH: 'X' }, installed)).toBe('D:\\tools\\agy.exe');
    expect(resolveAntigravityCommand(undefined, { ANTIGRAVITY_CLI_PATH: 'E:\\agy.exe', LOCALAPPDATA: LOCAL }, installed)).toBe('E:\\agy.exe');
    expect(resolveAntigravityCommand(undefined, { LOCALAPPDATA: LOCAL }, installed)).toBe(INSTALLED);
    expect(resolveAntigravityCommand(undefined, { LOCALAPPDATA: LOCAL }, none)).toBe('agy');
  });

  it('counts as installed only when a binary is really there: the installer default or agy on PATH', () => {
    expect(antigravityInstalled({ LOCALAPPDATA: LOCAL }, (p) => p === INSTALLED)).toBe(true);
    const onPath = join('/usr/local/bin', 'agy');
    expect(antigravityInstalled({ PATH: ['/usr/bin', '/usr/local/bin'].join(process.platform === 'win32' ? ';' : ':') }, (p) => p === onPath)).toBe(true);
    expect(antigravityInstalled({ LOCALAPPDATA: LOCAL, PATH: '/usr/bin' }, () => false)).toBe(false);
  });
});

describe('the headless command line', () => {
  it('passes the prompt through -p with JSON output and an 8-minute print timeout (inside the 10-minute swarm wait), the model only when named, and never skips permissions', () => {
    expect(buildAntigravityArgs('hi')).toEqual(['-p', 'hi', '--output-format', 'json', '--print-timeout', '8m']);
    expect(buildAntigravityArgs('hi', 'gemini-3.8-flash-low')).toEqual(['-p', 'hi', '--output-format', 'json', '--print-timeout', '8m', '--model', 'gemini-3.8-flash-low']);
    expect(buildAntigravityArgs('hi', 'm').join(' ')).not.toContain('dangerously');
  });
});

describe('the JSON envelope', () => {
  const envelope = (body: Record<string, unknown>) => JSON.stringify(body);
  it('an answer is status SUCCESS (or no status) with exit 0 and a non-empty response, and its usage is read', () => {
    expect(parseAntigravityJson(envelope({ status: 'SUCCESS', response: 'ok\n', usage: { input_tokens: 25290, output_tokens: 1, total_tokens: 25291 } }), 0))
      .toEqual({ text: 'ok', usage: { inputTokens: 25290, outputTokens: 1, totalTokens: 25291 } });
    expect(parseAntigravityJson(envelope({ response: 'plain' }), 0).text).toBe('plain');
    expect(parseAntigravityJson(`banner line\n${envelope({ status: 'SUCCESS', response: 'inside' })}\ntrailer`, 0).text).toBe('inside');
  });

  it('anything else is a reason, never an answer: a failure or unknown status, a non-zero exit, an empty response, or no JSON', () => {
    expect(parseAntigravityJson(envelope({ status: 'ERROR', error: 'quota', response: 'partial' }), 0)).toMatchObject({ text: '', error: 'Antigravity reported ERROR: quota' });
    expect(parseAntigravityJson(envelope({ status: 'SUCCESSISH', response: 'x' }), 0).error).toBe('Antigravity reported SUCCESSISH');
    expect(parseAntigravityJson(envelope({ status: 'SUCCESS', response: 'x' }), 1).error).toBe('Antigravity exited with code 1');
    expect(parseAntigravityJson(envelope({ status: 'SUCCESS', response: '  ' }), 0).error).toBe('Antigravity returned an empty response');
    expect(parseAntigravityJson('Error: not signed in', 1).error).toBe('Antigravity returned no JSON answer');
  });
});

describe('runAntigravity', () => {
  it('spawns agy WITHOUT a shell, with the prompt as one intact argument, in a throwaway directory', async () => {
    spawned.reply = { stdout: JSON.stringify({ status: 'SUCCESS', response: 'done', usage: { input_tokens: 3, output_tokens: 2 } }), stderr: '', code: 0 };
    const prompt = 'Line one "quoted" & | > spaces\nline two %PATH% ^caret';
    const result = await runAntigravity(prompt, { command: 'C:\\agy\\agy.exe', model: 'gemini-3.8-flash-low' });
    expect(result).toMatchObject({ success: true, text: 'done', exitCode: 0, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } });
    expect(spawned.calls).toHaveLength(1);
    const call = spawned.calls[0];
    expect(call.command).toBe('C:\\agy\\agy.exe');
    expect(call.args[0]).toBe('-p');
    expect(call.args[1]).toBe(prompt);
    expect(call.options).toMatchObject({ shell: false, windowsHide: true });
    expect(String(call.options.cwd).startsWith(join(tmpdir(), 'oshal-node-task-'))).toBe(true);
  });

  it('a failed run carries its reason; a prompt over the command-line cap is refused without spawning', async () => {
    spawned.reply = { stdout: JSON.stringify({ status: 'ERROR', error: 'not signed in' }), stderr: 'auth needed', code: 1 };
    const failed = await runAntigravity('hello', { command: 'agy' });
    expect(failed.success).toBe(false);
    expect(failed.stderr).toContain('Antigravity reported ERROR: not signed in');
    spawned.calls.length = 0;
    const tooLong = await runAntigravity('x'.repeat(MAX_ANTIGRAVITY_PROMPT_CHARS + 1), { command: 'agy' });
    expect(tooLong.success).toBe(false);
    expect(tooLong.stderr).toContain('at most');
    expect(spawned.calls).toHaveLength(0);
  });
});
