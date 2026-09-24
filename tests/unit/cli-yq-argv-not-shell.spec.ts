/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — pins that cli_yq never reaches a shell. On 2026-09-22 `cli_yq` was measured as an unapproved arbitrary-command primitive: yqCommand built `yq ${args}` by concatenation and handed it to child_process.exec, and the tool is registered requiresApproval:false and was absent from NEVER_AUTO_APPROVE, so `--version & echo MARKER` returned the marker with no approval requested. These cases run a REAL child process against a real executable on PATH rather than doubling child_process, because the boundary that failed is the spawn itself: a doubled exec would pass against the very code that was broken. The demonstrated payload shape is used verbatim.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The approval cases now drive the real unattended dispatch channel (createDispatchToolExecutor over a real ToolRegistry) and assert ok:false plus an unwritten proof file, with a control tool proving the channel can execute and cli_git proving it can refuse. The first draft asserted shouldAutoApproveTool(...) === false and never called an executor: it went red under mutation while proving nothing about the boundary it named, and adversarial verification showed cli_yq still ran unattended because every consumer gates on `requiresApproval === true` before reading the policy at all. Added the approved-caller case (the gate is not a removal) and the sparse-array hole case.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Extended to cover cli_cline, cli_jq and cli_fzf. All four shell-reaching CLI tools now execute directly with an argument vector, refuse unattended calls, and require approval. Added static guard asserting all registered CLI tools require approval and no tool reaches executeCLI without approval.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * A scratch directory that doubles as the tool's workspace (executeCLIArgv resolves cwd from
 * config.filesystem.workspaceDir) and as the PATH entry holding the tool stand-ins.
 */
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-cli-guard-'));

process.env.WORKSPACE_DIR = stubDir;
process.env.PATH = `${stubDir}${path.delimiter}${process.env.PATH}`;

// Required after the env is in place: config.js reads WORKSPACE_DIR once, at load.
const { cliArgsToArgv } = require('../../any-bot/server/services/tools/cli-argv');
const {
  yqCommand,
  clineCommand,
  jqCommand,
  fzfCommand,
  registerCLITools,
} = require('../../any-bot/server/services/tools/cliTools');
const { shouldAutoApproveTool, NEVER_AUTO_APPROVE } = require('../../any-bot/server/controllers/tool-approval-policy');
const { createDispatchToolExecutor } = require('../../any-bot/server/controllers/dispatch-tool-executor');
const { captureDispatchCapabilities } = require('../../any-bot/server/utils/dispatch-capabilities');
const ToolRegistry = require('../../any-bot/server/services/ToolRegistry');

/** The exact payload that returned the marker through the authorized channel on 2026-09-22. */
const MARKER = 'OSHAL_SHELL_REACHED_WITHOUT_APPROVAL';

/** Recorder script path, used as the tool's first argument so the stand-in reports what it received. */
const recorder = path.join(stubDir, 'recorder.js').replace(/\\/g, '/');

/** Where the recorder writes what it actually got; re-pointed per case. */
const recordEnv = 'OSHAL_CLI_STUB_RECORD';

/**
 * @description Installs real executables named `yq`, `cline`, `jq`, `fzf` on PATH plus the recorder script they run.
 * The stand-ins ARE the node binary, so `<tool> <recorder.js> …` is a genuine OS-level process launch
 * with a genuine argument vector — nothing about child_process is mocked.
 * @returns {void}
 */
function installStubs(): void {
  for (const name of ['yq', 'cline', 'jq', 'fzf']) {
    const stub = path.join(stubDir, process.platform === 'win32' ? `${name}.exe` : name);
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
  }

  fs.writeFileSync(
    path.join(stubDir, 'recorder.js'),
    [
      'const fs = require("fs");',
      'let stdin = "";',
      'if (process.env.OSHAL_CLI_STUB_READ_STDIN === "1") {',
      '  try { stdin = fs.readFileSync(0, "utf8"); } catch { stdin = ""; }',
      '}',
      'fs.writeFileSync(process.env.OSHAL_CLI_STUB_RECORD, JSON.stringify({ argv: process.argv.slice(2), stdin }));',
      'process.stdout.write("CLI_STUB_RAN");',
      '',
    ].join('\n'),
  );
}

/**
 * @description Points the recorder at a fresh file and returns a reader for what it captured.
 * @param {string} name - Unique record name for the case.
 * @param {boolean} [readStdin=false] - Whether the recorder should drain stdin.
 * @returns {() => {argv: string[], stdin: string} | null} Reader; null when nothing was recorded.
 */
function record(name: string, readStdin = false): () => { argv: string[]; stdin: string } | null {
  const file = path.join(stubDir, `${name}.json`);
  fs.rmSync(file, { force: true });
  process.env[recordEnv] = file;
  process.env.OSHAL_CLI_STUB_READ_STDIN = readStdin ? '1' : '0';
  return () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);
}

beforeAll(() => {
  installStubs();
});

afterAll(() => {
  try {
    fs.rmSync(stubDir, { recursive: true, force: true });
  } catch {
    /* best effort */
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

  it('keeps a quoted expression with spaces as one argument', () => {
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
    const sparse = ['eval', , '-'] as unknown as string[];
    expect(() => cliArgsToArgv(sparse, 'yq')).toThrow(/must be a string/);
  });
});

describe('yqCommand — real child process, no shell', () => {
  it('does not execute the injected command, and passes the whole payload as arguments', async () => {
    const read = record('yq-injection');
    const result = await yqCommand({ args: `${recorder} --version & echo ${MARKER}` });

    expect(result.output).not.toContain(MARKER);
    expect(result.output).toBe('CLI_STUB_RAN');

    expect(read()).not.toBeNull();
    expect(read()!.argv).toEqual(['--version', '&', 'echo', MARKER]);
  });

  it('runs a legitimate invocation and pipes YAML through stdin, not through an echo pipe', async () => {
    const read = record('yq-legit', true);
    const yaml = "name: alpha\nnote: it's fine\nitems:\n  - active: true\n";
    const result = await yqCommand({
      args: `${recorder} eval '.items[] | select(.active)' -`,
      input: yaml,
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe('CLI_STUB_RAN');

    const got = read()!;
    expect(got.argv).toEqual(['eval', '.items[] | select(.active)', '-']);
    expect(got.stdin).toBe(yaml);
  });

  it('accepts a caller-supplied argv array unchanged', async () => {
    const read = record('yq-argv', true);
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

describe('clineCommand — real child process, no shell', () => {
  it('does not execute the injected command, and passes the whole payload as arguments', async () => {
    const read = record('cline-injection');
    const result = await clineCommand({ args: `${recorder} --version & echo ${MARKER}` });

    expect(result.output).not.toContain(MARKER);
    expect(result.output).toBe('CLI_STUB_RAN');

    expect(read()).not.toBeNull();
    expect(read()!.argv).toEqual(['--version', '&', 'echo', MARKER]);
  });

  it('accepts a caller-supplied argv array unchanged', async () => {
    const read = record('cline-argv');
    const result = await clineCommand({ argv: [recorder, 'task', 'list', '&'] });

    expect(result.success).toBe(true);
    expect(result.output).not.toContain(MARKER);
    expect(read()!.argv).toEqual(['task', 'list', '&']);
  });

  it('still requires arguments', async () => {
    await expect(clineCommand({})).rejects.toThrow(/arguments are required/);
    await expect(clineCommand({ args: '   ' })).rejects.toThrow(/arguments are required/);
  });
});

describe('jqCommand — real child process, no shell', () => {
  it('does not execute the injected command in args, and pipes JSON through stdin', async () => {
    const read = record('jq-injection', true);
    const json = '{"name":"test"}\n';
    const result = await jqCommand({
      args: `${recorder} '.name & echo ${MARKER}'`,
      input: json,
    });

    expect(result.output).not.toContain(MARKER);
    expect(result.output).toBe('CLI_STUB_RAN');

    const got = read()!;
    expect(got.argv).toEqual([`.name & echo ${MARKER}`]);
    expect(got.stdin).toBe(json);
  });

  it('accepts a caller-supplied argv array and passes arguments verbatim', async () => {
    const read = record('jq-argv', true);
    const result = await jqCommand({ argv: [recorder, '.name', '-'], input: '{"name":"alpha"}\n' });

    expect(result.success).toBe(true);
    expect(result.output).not.toContain(MARKER);
    expect(read()!.argv).toEqual(['.name', '-']);
    expect(read()!.stdin).toBe('{"name":"alpha"}\n');
  });

  it('still requires filter or arguments', async () => {
    await expect(jqCommand({})).rejects.toThrow(/filter.*required/i);
    await expect(jqCommand({ filter: '   ' })).rejects.toThrow(/filter.*required/i);
  });
});

describe('fzfCommand — real child process, no shell', () => {
  it('does not execute the injected command in args, and pipes input through stdin', async () => {
    const read = record('fzf-injection', true);
    const list = 'apple\nbanana\n';
    const result = await fzfCommand({ input: list, args: `${recorder} --reverse & echo ${MARKER}` });

    expect(result.output).not.toContain(MARKER);
    expect(result.output).toBe('CLI_STUB_RAN');

    const got = read()!;
    expect(got.argv).toEqual(['--reverse', '&', 'echo', MARKER]);
    expect(got.stdin).toBe(list);
  });

  it('accepts a caller-supplied argv array unchanged', async () => {
    const read = record('fzf-argv', true);
    const result = await fzfCommand({ input: 'item', argv: [recorder, '--multi', '&'] });

    expect(result.success).toBe(true);
    expect(result.output).not.toContain(MARKER);
    expect(read()!.argv).toEqual(['--multi', '&']);
    expect(read()!.stdin).toBe('item');
  });

  it('still requires input', async () => {
    await expect(fzfCommand({})).rejects.toThrow(/input is required/);
  });
});

/**
 * @description Builds the REAL unattended dispatch channel over the REAL registry.
 * @returns {{executeTool: Function, registry: any}} The dispatch executor and its registry.
 */
function buildUnattendedDispatch(): { executeTool: Function; registry: any } {
  const registry = new ToolRegistry();
  registerCLITools(registry);
  registry.register({
    name: 'probe_open',
    description: 'Control: a registered tool that genuinely needs no approval.',
    category: 'test',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({ ran: true }),
    requiresApproval: false,
  });

  const names = ['cli_yq', 'cli_cline', 'cli_jq', 'cli_fzf', 'cli_git', 'probe_open'];
  const capabilities = captureDispatchCapabilities(
    registry,
    new Set(names),
    new Set(names.map((n) => `tool:${n}`)),
  );
  const executeTool = createDispatchToolExecutor({
    toolRegistry: registry,
    dispatchCapabilities: capabilities,
    task: {},
    taskId: 'cli-tools-guard',
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

describe('CLI tools approval posture — observed at the real dispatch channel', () => {
  it('refuses cli_yq, cli_cline, cli_jq, and cli_fzf unattended, and no child runs', async () => {
    const { executeTool } = buildUnattendedDispatch();

    // Control: the channel does execute tools, so ok:false below is a refusal, not a broken harness.
    const open = await executeTool('probe_open', {});
    expect(open.ok).toBe(true);

    // Control: the channel's refusal shape, from a tool that has always required approval.
    const git = await executeTool('cli_git', { args: '--version' });
    expect(git.ok).toBe(false);
    expect(git.error).toMatch(/requires approval/);

    const toolsToTest = [
      { name: 'cli_yq', payload: { args: `${recorder} --version` } },
      { name: 'cli_cline', payload: { args: `${recorder} version` } },
      { name: 'cli_jq', payload: { args: `${recorder} .`, input: '{}' } },
      { name: 'cli_fzf', payload: { input: 'item', args: `${recorder}` } },
    ];

    for (const { name, payload } of toolsToTest) {
      const read = record(`unattended-${name}`);
      const res = await executeTool(name, payload);
      expect({ tool: name, refused: res.ok === false, spawned: read() !== null })
        .toEqual({ tool: name, refused: true, spawned: false });
      expect(res.error).toMatch(/requires approval/);
    }
  });

  it('still runs for an approved caller across all four tools, so the gate is not a removal', async () => {
    const registry = new ToolRegistry();
    registerCLITools(registry);

    // cli_yq
    const readYq = record('approved-yq');
    const yqRes = await registry.execute('cli_yq', { args: `${recorder} eval '.name' -` }, { approved: true });
    expect(yqRes.success).toBe(true);
    expect(readYq()!.argv).toEqual(['eval', '.name', '-']);

    // cli_cline
    const readCline = record('approved-cline');
    const clineRes = await registry.execute('cli_cline', { args: `${recorder} version` }, { approved: true });
    expect(clineRes.success).toBe(true);
    expect(readCline()!.argv).toEqual(['version']);

    // cli_jq
    const readJq = record('approved-jq', true);
    const jqRes = await registry.execute('cli_jq', { argv: [recorder, '.name'], input: '{"name":"ok"}' }, { approved: true });
    expect(jqRes.success).toBe(true);
    expect(readJq()!.argv).toEqual(['.name']);
    expect(readJq()!.stdin).toBe('{"name":"ok"}');

    // cli_fzf
    const readFzf = record('approved-fzf', true);
    const fzfRes = await registry.execute('cli_fzf', { input: 'line1', argv: [recorder, '--reverse'] }, { approved: true });
    expect(fzfRes.success).toBe(true);
    expect(readFzf()!.argv).toEqual(['--reverse']);
    expect(readFzf()!.stdin).toBe('line1');
  });

  it('carries the belt-and-braces policy entry under the names the registry registers', () => {
    const registry = new ToolRegistry();
    registerCLITools(registry);

    for (const name of ['cli_yq', 'cli_cline', 'cli_jq', 'cli_fzf']) {
      const tool = registry.get(name);
      expect(tool.requiresApproval).toBe(true);
      expect(NEVER_AUTO_APPROVE.has(tool.name)).toBe(true);
      expect(shouldAutoApproveTool({ commandExecution: true }, tool.name, false)).toBe(false);
    }
  });

  it('static guard: all 16 registered CLI tools carry requiresApproval: true and no tool reaches exec unapproved', () => {
    const registry = new ToolRegistry();
    registerCLITools(registry);

    const tools = registry.getAll();
    expect(tools.length).toBe(16);
    for (const tool of tools) {
      expect(tool.requiresApproval).toBe(true);
    }

    const src = fs.readFileSync(
      path.join(__dirname, '../../any-bot/server/services/tools/cliTools.js'),
      'utf8',
    );
    expect(src.match(/^\s*requiresApproval:\s*false/m)).toBeNull();
    expect(src).not.toMatch(/executeCLI\(`cline /);
    expect(src).not.toMatch(/executeCLI\(`echo.*\| jq /);
    expect(src).not.toMatch(/executeCLI\(`echo.*\| fzf /);
    expect(src).not.toMatch(/executeCLI\(`echo.*\| yq /);
  });
});
