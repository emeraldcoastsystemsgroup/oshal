/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — pins that cli_yq never reaches a shell. On 2026-09-22 `cli_yq` was measured as an unapproved arbitrary-command primitive: yqCommand built `yq ${args}` by concatenation and handed it to child_process.exec, and the tool is registered requiresApproval:false and was absent from NEVER_AUTO_APPROVE, so `--version & echo MARKER` returned the marker with no approval requested. These cases run a REAL child process against a real executable on PATH rather than doubling child_process, because the boundary that failed is the spawn itself: a doubled exec would pass against the very code that was broken. The demonstrated payload shape is used verbatim.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The approval cases now drive the real unattended dispatch channel (createDispatchToolExecutor over a real ToolRegistry) and assert ok:false plus an unwritten proof file, with a control tool proving the channel can execute and cli_git proving it can refuse. The first draft asserted shouldAutoApproveTool(...) === false and never called an executor: it went red under mutation while proving nothing about the boundary it named, and adversarial verification showed cli_yq still ran unattended because every consumer gates on `requiresApproval === true` before reading the policy at all. Added the approved-caller case (the gate is not a removal) and the sparse-array hole case.
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
const { createDispatchToolExecutor } = require('../../any-bot/server/controllers/dispatch-tool-executor');
const { captureDispatchCapabilities } = require('../../any-bot/server/utils/dispatch-capabilities');
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

  it('refuses a HOLE in a sparse array instead of spawning the string "undefined"', () => {
    // Array.prototype.map skips holes, which would have let this through unchecked.
    const sparse = ['eval', , '-'] as unknown as string[];
    expect(() => cliArgsToArgv(sparse, 'yq')).toThrow(/must be a string/);
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

/**
 * @description Builds the REAL unattended dispatch channel over the REAL registry. Asking the
 * policy function whether it would auto-approve proves nothing: every consumer refuses with
 * `requiresApproval && !approved`, so a tool declared `requiresApproval: false` is executed
 * without the policy answer ever being read. The refusal has to be observed at the channel.
 * @returns {{executeTool: Function, registry: any}} The dispatch executor and its registry.
 */
function buildUnattendedDispatch(): { executeTool: Function; registry: any } {
  const registry = new ToolRegistry();
  registerCLITools(registry);
  // A tool the channel is allowed to run, so a refusal below is about the tool and not a
  // harness that cannot execute anything.
  registry.register({
    name: 'probe_open',
    description: 'Control: a registered tool that genuinely needs no approval.',
    category: 'test',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({ ran: true }),
    requiresApproval: false,
  });

  const names = ['cli_yq', 'cli_git', 'probe_open'];
  const capabilities = captureDispatchCapabilities(
    registry,
    new Set(names),
    new Set(names.map((n) => `tool:${n}`)),
  );
  const executeTool = createDispatchToolExecutor({
    toolRegistry: registry,
    dispatchCapabilities: capabilities,
    task: {},
    taskId: 'cli-yq-guard',
    // The literal flags AgentDispatchEngine sends on the unattended ticket path, plus the legacy
    // key the policy actually reads — the most permissive payload a caller can present.
    options: {
      autoApprove: {
        commandExecution: true,
        use_mcp_tool: true,
        execute_command: true,
        write_to_file: true,
        read_file: true,
      },
    },
  });
  return { executeTool, registry };
}

describe('cli_yq approval posture — observed at the real dispatch channel', () => {
  it('refuses cli_yq unattended, and the child never runs', async () => {
    const read = record('unattended');
    const { executeTool } = buildUnattendedDispatch();

    // Control: the channel does execute tools, so ok:false below is a refusal, not a broken harness.
    const open = await executeTool('probe_open', {});
    expect(open.ok).toBe(true);

    // Control: the channel's refusal shape, from a tool that has always required approval.
    const git = await executeTool('cli_git', { args: '--version' });
    expect(git.ok).toBe(false);
    expect(git.error).toMatch(/requires approval/);

    const yq = await executeTool('cli_yq', { args: `${recorder} --version` });
    // Asserted together so a regression reads as what it is: refused, and nothing spawned.
    expect({ refused: yq.ok === false, spawned: read() !== null })
      .toEqual({ refused: true, spawned: false });
    expect(yq.error).toMatch(/requires approval/);
  });

  it('still runs for an approved caller, so the gate is not a removal', async () => {
    const read = record('approved');
    const registry = new ToolRegistry();
    registerCLITools(registry);

    const result = await registry.execute(
      'cli_yq',
      { args: `${recorder} eval '.name' -` },
      { approved: true },
    );
    expect(result.success).toBe(true);
    expect(read()!.argv).toEqual(['eval', '.name', '-']);
  });

  it('carries the belt-and-braces policy entry under the name the registry registers', () => {
    const registry = new ToolRegistry();
    registerCLITools(registry);
    const tool = registry.get('cli_yq');

    // The registration flag is the gate; the policy set only stops a future edit flipping it back
    // from also auto-approving the tool. Both are asserted, neither is described as the other.
    expect(tool.requiresApproval).toBe(true);
    expect(NEVER_AUTO_APPROVE.has(tool.name)).toBe(true);
    expect(shouldAutoApproveTool({ commandExecution: true }, tool.name, false)).toBe(false);
  });
});
