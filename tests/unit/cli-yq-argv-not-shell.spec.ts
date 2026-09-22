/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — pins that cli_yq never reaches a shell. On 2026-09-22 `cli_yq` was measured as an unapproved arbitrary-command primitive: yqCommand built `yq ${args}` by concatenation and handed it to child_process.exec, and the tool is registered requiresApproval:false and was absent from NEVER_AUTO_APPROVE, so `--version & echo MARKER` returned the marker with no approval requested. These cases run a REAL child process against a real executable on PATH rather than doubling child_process, because the boundary that failed is the spawn itself: a doubled exec would pass against the very code that was broken. The demonstrated payload shape is used verbatim.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * A scratch directory that doubles as the tool's workspace (executeCLIArgv resolves cwd from
 * config.filesystem.workspaceDir) and as the PATH entry holding the `yq` stand-in.
 */
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-yq-guard-'));

process.env.WORKSPACE_DIR = stubDir;
process.env.PATH = `${stubDir}${path.delimiter}${process.env.PATH}`;

// Required after the env is in place: config.js reads WORKSPACE_DIR once, at load.
const { cliArgsToArgv } = require('../../any-bot/server/services/tools/cli-argv');
const { yqCommand, registerCLITools } = require('../../any-bot/server/services/tools/cliTools');
const { shouldAutoApproveTool, NEVER_AUTO_APPROVE } = require('../../any-bot/server/controllers/tool-approval-policy');
const ToolRegistry = require('../../any-bot/server/services/ToolRegistry');

/** The exact payload that returned the marker through the authorized channel on 2026-09-22. */
const MARKER = 'OSHAL_SHELL_REACHED_WITHOUT_APPROVAL';

/** Recorder script path, used as yq's first argument so the stand-in reports what it received. */
const recorder = path.join(stubDir, 'recorder.js').replace(/\\/g, '/');

/** Where the recorder writes what it actually got; re-pointed per case. */
const recordEnv = 'OSHAL_YQ_STUB_RECORD';

/**
 * @description Installs a real executable named `yq` on PATH plus the recorder script it runs.
 * The stand-in IS the node binary, so `yq <recorder.js> …` is a genuine OS-level process launch
 * with a genuine argument vector — nothing about child_process is mocked.
 * @returns {void}
 */
function installStubYq(): void {
  const stub = path.join(stubDir, process.platform === 'win32' ? 'yq.exe' : 'yq');
  try {
    fs.symlinkSync(process.execPath, stub);
  } catch {
    try {
      fs.linkSync(process.execPath, stub);
    } catch {
      fs.copyFileSync(process.execPath, stub);
    }
  }
  if (process.platform !== 'win32') fs.chmodSync(stub, 0o755);

  fs.writeFileSync(
    path.join(stubDir, 'recorder.js'),
    [
      'const fs = require("fs");',
      'let stdin = "";',
      // Only the stdin case drains fd 0. A recorder that always read stdin would hang for the
      // full test timeout under the old exec form (which leaves the child's stdin open), turning
      // a clean assertion failure into a timeout and hiding what the guard is actually saying.
      'if (process.env.OSHAL_YQ_STUB_READ_STDIN === "1") {',
      '  try { stdin = fs.readFileSync(0, "utf8"); } catch { stdin = ""; }',
      '}',
      'fs.writeFileSync(process.env.OSHAL_YQ_STUB_RECORD, JSON.stringify({ argv: process.argv.slice(2), stdin }));',
      'process.stdout.write("YQ_STUB_RAN");',
      '',
    ].join('\n'),
  );
}

/**
 * @description Points the recorder at a fresh file and returns a reader for what it captured.
 * @param {string} name - Unique record name for the case.
 * @returns {() => {argv: string[], stdin: string} | null} Reader; null when nothing was recorded.
 */
function record(name: string, readStdin = false): () => { argv: string[]; stdin: string } | null {
  const file = path.join(stubDir, `${name}.json`);
  fs.rmSync(file, { force: true });
  process.env[recordEnv] = file;
  process.env.OSHAL_YQ_STUB_READ_STDIN = readStdin ? '1' : '0';
  return () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);
}

beforeAll(() => {
  installStubYq();
});

afterAll(() => {
  // Windows holds the copied executable open until every child has exited; a scratch-directory
  // cleanup failure is not a finding about the tool, so it must not be reported as one.
  try {
    fs.rmSync(stubDir, { recursive: true, force: true });
  } catch {
    /* best effort — the OS temp directory is swept independently */
  }
});

describe('cliArgsToArgv — model-supplied text is data, never syntax', () => {
  it('turns the demonstrated injection payload into four plain arguments', () => {
    expect(cliArgsToArgv(`--version & echo ${MARKER}`, 'yq')).toEqual([
      '--version',
      '&',
      'echo',
      MARKER,
    ]);
  });

  it('gives every shell metacharacter argv status instead of command status', () => {
    expect(cliArgsToArgv('a; b | c && d $(e) `f` > g', 'yq')).toEqual([
      'a;', 'b', '|', 'c', '&&', 'd', '$(e)', '`f`', '>', 'g',
    ]);
  });

  it('keeps a quoted yq expression with spaces as one argument', () => {
    expect(cliArgsToArgv(`eval '.items[] | select(.active)' -`, 'yq')).toEqual([
      'eval',
      '.items[] | select(.active)',
      '-',
    ]);
  });

  it('passes an array through verbatim, which is the lossless form', () => {
    const argv = ['eval', '.a | .b', '&', 'file with spaces.yaml'];
    expect(cliArgsToArgv(argv, 'yq')).toEqual(argv);
  });

  it('refuses an unbalanced quote rather than guessing a split', () => {
    expect(() => cliArgsToArgv(`eval '.name`, 'yq')).toThrow(/unbalanced/);
  });

  it('refuses a non-string argv entry', () => {
    expect(() => cliArgsToArgv(['eval', 7 as unknown as string], 'yq')).toThrow(/must be a string/);
  });
});

describe('yqCommand — real child process, no shell', () => {
  it('does not execute the injected command, and passes the whole payload as arguments', async () => {
    const read = record('injection');
    const result = await yqCommand({ args: `${recorder} --version & echo ${MARKER}` });

    // If a shell had parsed this, `echo` would have run and the marker would be in the output.
    expect(result.output).not.toContain(MARKER);
    expect(result.output).toBe('YQ_STUB_RAN');

    // …and every token arrived at the process as an ordinary argument.
    expect(read()).not.toBeNull();
    expect(read()!.argv).toEqual(['--version', '&', 'echo', MARKER]);
  });

  it('runs a legitimate invocation and pipes YAML through stdin, not through an echo pipe', async () => {
    const read = record('legit', true);
    const yaml = "name: alpha\nnote: it's fine\nitems:\n  - active: true\n";
    const result = await yqCommand({
      args: `${recorder} eval '.items[] | select(.active)' -`,
      input: yaml,
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe('YQ_STUB_RAN');

    const got = read()!;
    expect(got.argv).toEqual(['eval', '.items[] | select(.active)', '-']);
    // Byte-exact: the old `echo '<yaml>' | yq` form mangled quotes and appended a shell newline.
    expect(got.stdin).toBe(yaml);
  });

  it('accepts a caller-supplied argv array unchanged', async () => {
    const read = record('argv', true);
    const result = await yqCommand({ argv: [recorder, 'eval', '.a & .b', '-'], input: 'a: 1\n' });

    expect(result.success).toBe(true);
    expect(result.output).not.toContain(MARKER);
    expect(read()!.argv).toEqual(['eval', '.a & .b', '-']);
    expect(read()!.stdin).toBe('a: 1\n');
  });

  it('still requires arguments', async () => {
    await expect(yqCommand({})).rejects.toThrow(/arguments are required/);
    await expect(yqCommand({ args: '   ' })).rejects.toThrow(/arguments are required/);
  });
});

describe('cli_yq approval posture', () => {
  it('is refused on the unattended path even with the auto-approval flag set', () => {
    // cli_yq is registered requiresApproval:false, so NEVER_AUTO_APPROVE is the only refusal.
    expect(NEVER_AUTO_APPROVE.has('cli_yq')).toBe(true);
    expect(shouldAutoApproveTool({ commandExecution: true }, 'cli_yq', false)).toBe(false);
    expect(shouldAutoApproveTool({ commandExecution: true }, 'cli_yq', true)).toBe(false);
  });

  it('lists the name the registry actually registers, so a rename cannot orphan the guard', () => {
    const registry = new ToolRegistry();
    registerCLITools(registry);
    const tool = registry.get('cli_yq');
    expect(tool).toBeTruthy();
    expect(NEVER_AUTO_APPROVE.has(tool.name)).toBe(true);
  });
});
