/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Bot-node Antigravity wrapper. Uses the vendor's documented stream-json stdin protocol, so prompts never hit Linux MAX_ARG_STRLEN; accepts only a terminal SUCCESS result; refreshes the idle timer on either output stream; and never passes --dangerously-skip-permissions. The ADR-127 boundary is the first executable statement.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Declare the exact per-task working directory through agy's --add-dir flag. Headless agy does not infer the project permission scope from cwd alone: without this flag it soft-denies even read_file on the persona context inside cwd. The task folder is now the CLI workspace boundary, matching the shared-workspace contract without a global allow rule or permission bypass.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Run agy's terminal tools in its vendor sandbox. Request-review cannot prompt in headless mode and soft-denied every command after the workspace read was fixed; --sandbox lets autonomous commands proceed inside the --add-dir task boundary without --dangerously-skip-permissions or a global command(*) grant.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Select agy's accept-edits mode for autonomous task execution. Headless request-review cannot prompt for write_file, so it soft-denied task deliverables after reads and commands were fixed; accept-edits permits edits within the declared task workspace without --dangerously-skip-permissions.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Provision the existing oshal-tools MCP bridge in an invocation-only Antigravity HOME. The bridge is bound to the exact bot, protected execution, task and user supplied by the verified worker context; only the OAuth token and installation id are linked from the shared login, and the temporary config is removed after the turn.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Auto-approve only the invocation-local oshal-tools MCP server. Headless mode cannot answer Antigravity's default MCP confirmation; the controller still lists and executes only exact AUTO grants and revalidates protected actions per call.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Give every invocation a private Antigravity HOME and approve terminal commands only there. agy's --sandbox restricts terminal access but does not answer headless confirmations, so command execution was still soft-denied; the ephemeral command(regex:.*) grant now operates only with --sandbox and the exact --add-dir task boundary, never through the persistent host config or --dangerously-skip-permissions.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Host-tools-only turns. A Jarvis ask on the Antigravity brain ran 10 min 45 s and died with `jetski: no output produced - a tool required the "read_file" permission`. The recall tools reach a CLI turn only through the host loop's XML contract (AgenticController parses the reply and runs the bot-node tool), but agy answered that prompt with its OWN tools - a local repro with this wrapper's argv showed its first step was a native run_command, and a native view_file outside --add-dir produces exactly the live error. hostToolsOnly now runs agy as an invocation-local custom agent (`--agent oshal-host-tools`, excludeDefaultComponents) that holds no native tools, with an empty permission allow list and no --mode accept-edits; --sandbox and the single --add-dir stay. It narrows the grant: nothing outside the host's brokered tools is callable. Also: a failed turn's diagnostic now names each denied tool and its target from the stream-json events, which the wrapper used to discard, so the next denial is not a guess.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Image turns (ADR-130 amendment 2026-10-02: storyboard images follow the swarm default). An imageTurn runs exactly the proven shape - the unbridged workspace task turn (accept-edits, --sandbox, one --add-dir, private HOME) - and refuses to combine with hostToolsOnly or a tool bridge. When the turn succeeds, the image agy's generate_image wrote into the private HOME is collected into the task workspace (agy-image-turn.js: output.png or output.jpg by its real bytes, plus a receipt) BEFORE the HOME is removed; Guard A refuses the turn unless the stream shows a generate_image tool step that reached DONE and that tool's own file is found. The result reports the collected image (file, real mime type, bytes, sha256, locator).
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { acquireUserScoping } = require('./user-scoping');
const { buildCliDiagnosticEnv } = require('./cli-diagnostic-env');
const { assertCliToolBoundary } = require('../llm/assert-cli-tool-boundary');
const { collectImageTurnOutput } = require('./agy-image-turn');

const DEFAULT_IDLE_MS = 600000;
const DEFAULT_MAX_DURATION_MS = 7200000;
const MAX_DIAGNOSTIC_CHARS = 1200;
const DEFAULT_TOOLS_MCP_PATH = '/app/scripts/oshal-tools-mcp.js';
const MAX_DENIAL_NOTES = 3;
const MAX_DENIAL_CHARS = 240;
/** Invocation-local custom agent for host-tools-only turns; it lives only in the private HOME. */
const HOST_TOOLS_AGENT = 'oshal-host-tools';
// excludeDefaultComponents drops agy's built-in prompt sections and native tools (file, command,
// browser, web); inheritCustomizations:false keeps ambient skills/rules/MCP out. The host loop in
// AgenticController is then the only way a tool runs.
const HOST_TOOLS_AGENT_MD = [
  '---',
  `name: ${HOST_TOOLS_AGENT}`,
  'description: Reasoning step of an oshal host-run tool loop; it holds no tools of its own.',
  'excludeDefaultComponents: true',
  'inheritCustomizations: false',
  'subagent: false',
  '---',
  '# Host tool loop',
  '',
  'You are the reasoning step inside a host application\'s tool loop, running unattended. You have no',
  'tools of your own in this session: you cannot read files, run commands, browse, or search the web.',
  '',
  'The request describes host tools and the XML format for calling them. The host, not you, runs them:',
  'to call one, reply with only that tool\'s XML block and nothing else. The host runs it for the',
  'signed-in user and sends you the result in its next request. When you can answer, reply with the',
  'answer itself. Never claim a tool ran unless its result is in the request.',
  '',
].join('\n');

function requiredBridgeText(value, name, maxLength = 16384) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Antigravity tool bridge ${name} is invalid`);
  }
  return value;
}

function linkCredential(source, destination) {
  if (!fs.existsSync(source)) throw new Error(`Antigravity credential file is unavailable: ${path.basename(source)}`);
  try {
    fs.symlinkSync(source, destination, 'file');
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error && error.code)) throw error;
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, 0o600);
  }
}

/** Validate the verified protected-execution binding into the bridge's spawn configuration. */
function resolveBridge(binding) {
  const agentId = requiredBridgeText(binding.agentId, 'agentId', 512);
  const taskId = requiredBridgeText(binding.taskId, 'taskId', 512);
  const userSub = requiredBridgeText(binding.userSub, 'userSub', 2048);
  const executionId = requiredBridgeText(binding.applicationExecutionId, 'applicationExecutionId', 128);
  const executionToken = requiredBridgeText(binding.applicationExecutionToken, 'applicationExecutionToken');
  const secret = requiredBridgeText(process.env.SWARM_SERVICE_SECRET, 'service credential');
  const bridgePath = process.env.OSHAL_TOOLS_MCP_PATH || DEFAULT_TOOLS_MCP_PATH;
  if (!path.isAbsolute(bridgePath) || !fs.existsSync(bridgePath)) {
    throw new Error('Antigravity tool bridge executable is unavailable');
  }
  const apiBase = process.env.SWARM_CONTROLLER_URL || process.env.OSHAL_API_BASE || 'http://oshal-api:5000';
  let parsedBase;
  try { parsedBase = new URL(apiBase); } catch { throw new Error('Antigravity tool bridge controller URL is invalid'); }
  if (!['http:', 'https:'].includes(parsedBase.protocol) || parsedBase.username || parsedBase.password) {
    throw new Error('Antigravity tool bridge controller URL is invalid');
  }
  return { agentId, taskId, userSub, executionId, executionToken, secret, bridgePath, apiBase: parsedBase.href.replace(/\/+$/, '') };
}

/**
 * @description The complete invocation-local permission allow list. A host-tools-only turn gets
 * none: its agent holds no native tool a rule could approve. A workspace task turn keeps the
 * sandboxed command grant, plus the one MCP server when a protected bridge is bound. No rule ever
 * names read_file, write_file or a URL: file access stays the single --add-dir task folder.
 * @param {{bridged: boolean, hostToolsOnly: boolean}} mode - The invocation's shape.
 * @returns {string[]} The allow rules written to the private settings.json.
 */
function permissionAllowList({ bridged, hostToolsOnly }) {
  if (hostToolsOnly) return [];
  return ['command(regex:.*)', ...(bridged ? ['mcp(oshal-tools/*)'] : [])];
}

function writePrivate(file, content) {
  fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

/** Populate the private HOME: adopted login files, settings, and the bridge or the host agent. */
function writeInvocationHome(home, bridge, hostToolsOnly) {
  const cliRoot = path.join(home, '.gemini', 'antigravity-cli');
  const configRoot = path.join(home, '.gemini', 'config');
  fs.mkdirSync(cliRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(configRoot, { recursive: true, mode: 0o700 });
  const tokenPath = process.env.ANTIGRAVITY_OAUTH_TOKEN_PATH || '/root/.gemini/antigravity-cli/antigravity-oauth-token';
  linkCredential(tokenPath, path.join(cliRoot, 'antigravity-oauth-token'));
  linkCredential(path.join(path.dirname(tokenPath), 'installation_id'), path.join(cliRoot, 'installation_id'));
  writePrivate(path.join(cliRoot, 'settings.json'), JSON.stringify({
    permissions: { allow: permissionAllowList({ bridged: Boolean(bridge), hostToolsOnly }) },
  }));
  if (bridge) {
    writePrivate(path.join(configRoot, 'mcp_config.json'), JSON.stringify({
      mcpServers: { 'oshal-tools': { command: 'node', args: [bridge.bridgePath], disabled: false } },
    }));
  }
  if (hostToolsOnly) {
    // agy reads global custom agents from ~/.gemini/config/agents/<name>/agent.md. Inside the private
    // HOME, never the task workspace: a workspace .agents/ folder is model-writable and outlives the turn.
    const agentDir = path.join(configRoot, 'agents', HOST_TOOLS_AGENT);
    fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    writePrivate(path.join(agentDir, 'agent.md'), HOST_TOOLS_AGENT_MD);
  }
}

function bridgeEnv(bridge) {
  return {
    OSHAL_API_BASE: bridge.apiBase,
    SWARM_SERVICE_SECRET: bridge.secret,
    OSHAL_AGENT_ID: bridge.agentId,
    OSHAL_USER_SUB: bridge.userSub,
    OSHAL_TASK_ID: bridge.taskId,
    OSHAL_APPLICATION_EXECUTION_ID: bridge.executionId,
    OSHAL_APPLICATION_EXECUTION_TOKEN: bridge.executionToken,
  };
}

/**
 * @description Build one private HOME for a single agy invocation (agy discovers MCP servers and
 * custom agents only under ~/.gemini/config). A protected-execution binding provisions the
 * oshal-tools MCP bridge; hostToolsOnly provisions the tool-less host agent instead. The two are
 * exclusive: a host-tools-only turn's tools are brokered by the host loop, never by a bridge.
 * @param {object} [binding] - Verified protected-execution binding, or undefined.
 * @param {{hostToolsOnly?: boolean}} [options] - Invocation shape.
 * @returns {{env: object, agent: string|null, release: Function}} Spawn env, agent name, cleanup.
 */
function provisionToolBridge(binding, options = {}) {
  const hostToolsOnly = options.hostToolsOnly === true;
  if (hostToolsOnly && binding) {
    throw new Error('Antigravity host-tools-only turns cannot carry a protected tool bridge');
  }
  const bridge = binding ? resolveBridge(binding) : null;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-agy-mcp-'));
  const release = () => {
    if (path.dirname(home) === path.resolve(os.tmpdir()) && path.basename(home).startsWith('oshal-agy-mcp-')) {
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
  try {
    writeInvocationHome(home, bridge, hostToolsOnly);
  } catch (error) {
    release();
    throw error;
  }
  return {
    env: { HOME: home, ...(bridge ? bridgeEnv(bridge) : {}) },
    agent: hostToolsOnly ? HOST_TOOLS_AGENT : null,
    release,
  };
}

/**
 * @description The agy argument vector. Every turn is scoped to exactly one --add-dir (the task
 * workspace), runs --sandbox, reads its prompt from stdin, and never passes
 * --dangerously-skip-permissions. A host-tools-only turn selects the tool-less host agent and
 * drops accept-edits, because it has nothing to edit with; a workspace task turn keeps it.
 * @param {string} workspaceDir - The exact task workspace.
 * @param {{model: string, idleMs: number, effort?: string, agent?: string|null}} options - Turn settings.
 * @returns {string[]} Arguments for the agy executable.
 */
function buildAgyArgs(workspaceDir, { model, idleMs, effort, agent }) {
  const args = [
    ...(agent ? ['--agent', agent] : ['--mode', 'accept-edits']),
    '--sandbox',
    '--add-dir', workspaceDir,
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--model', model,
    '--print-timeout', timeoutArg(idleMs),
  ];
  if (effort) args.push('--effort', effort);
  return args;
}

function positiveMs(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function timeoutArg(ms) {
  return `${Math.max(1, Math.ceil(ms / 60000))}m`;
}

function compactDiagnostic(value) {
  return String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(-MAX_DIAGNOSTIC_CHARS);
}

/** One stream-json tool step refused by agy's permission check, as "tool: first line of the refusal". */
function deniedStepNote(event) {
  const step = event && event.event === 'step_update' ? event.step_update : null;
  const info = step && step.step_type === 'tool' ? step.tool_info : null;
  const message = info && info.error && typeof info.error.message === 'string' ? info.error.message : '';
  if (!/permission check failed/i.test(message)) return null;
  const tool = typeof step.tool_name === 'string' ? step.tool_name : 'tool';
  return compactDiagnostic(`${tool}: ${message.split('\n')[0]}`).slice(0, MAX_DENIAL_CHARS);
}

/**
 * @description An image turn runs only as the shape proven headless on 2026-10-02: the unbridged
 * workspace task turn. The host-tools-only agent holds no generate_image, and a protected tool
 * bridge has no business in a render, so either combination is refused before anything spawns.
 * @param {{imageTurn?: boolean, hostToolsOnly?: boolean, toolBridge?: object}} options - The turn options.
 * @returns {boolean} True for an image turn.
 */
function assertImageTurnShape(options) {
  if (options.imageTurn !== true) return false;
  if (options.hostToolsOnly === true || options.toolBridge) {
    throw new Error('Antigravity image turns run only as an unbridged workspace task turn');
  }
  return true;
}

class AntigravityCLIWrapper {
  /**
   * @param {{agyCommand?: string, model?: string, effort?: string, timeoutMs?: number, maxDurationMs?: number, spawnImpl?: Function}} options
   */
  constructor(options = {}) {
    this.agyCommand = options.agyCommand || process.env.ANTIGRAVITY_CLI_PATH || 'agy';
    this.model = options.model || process.env.ANTIGRAVITY_MODEL || 'gemini-3.8-flash-low';
    this.effort = options.effort || process.env.ANTIGRAVITY_EFFORT || '';
    this.timeoutMs = positiveMs(options.timeoutMs || process.env.ANTIGRAVITY_INACTIVITY_TIMEOUT_MS || process.env.ANTIGRAVITY_TIMEOUT_MS, DEFAULT_IDLE_MS);
    this.maxDurationMs = positiveMs(options.maxDurationMs || process.env.ANTIGRAVITY_MAX_DURATION_MS, DEFAULT_MAX_DURATION_MS);
    this.spawnImpl = options.spawnImpl || spawn;
  }

  /**
   * @description Executes one stateless headless turn through the documented stream-json stdin protocol.
   * @param {string} taskDescription
   * @param {string} workspaceDir
   * @param {{model?: string, effort?: string, timeout?: number, extraEnv?: object, toolBridge?: object, hostToolsOnly?: boolean, imageTurn?: boolean}} [options]
   *   hostToolsOnly: the caller's own loop brokers every tool, so agy runs with no native tools.
   *   imageTurn: collect the image generate_image wrote into the task workspace before the HOME is removed.
   */
  async executeTask(taskDescription, workspaceDir, options = {}) {
    assertCliToolBoundary(options, 'antigravity-cli');
    const imageTurn = assertImageTurnShape(options);
    fs.mkdirSync(workspaceDir, { recursive: true });
    const idleMs = positiveMs(options.timeout, this.timeoutMs);
    const start = Date.now();
    const userScope = await acquireUserScoping(workspaceDir, options.extraEnv);
    let toolBridge;
    try {
      toolBridge = provisionToolBridge(options.toolBridge, { hostToolsOnly: options.hostToolsOnly === true });
    } catch (error) {
      userScope.release();
      throw error;
    }
    const args = buildAgyArgs(workspaceDir, {
      model: options.model || this.model, idleMs, effort: options.effort || this.effort, agent: toolBridge.agent,
    });
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let killReason = '';
      let settled = false;
      const child = this.spawnImpl(this.agyCommand, args, {
        cwd: workspaceDir,
        env: { ...process.env, ...userScope.env, ...toolBridge.env },
      });
      const idleTimer = setTimeout(() => {
        killReason = `idle timeout: no output for ${idleMs}ms`;
        try { child.kill('SIGKILL'); } catch { /* noop */ }
      }, idleMs);
      const durationTimer = setTimeout(() => {
        killReason = `exceeded max duration ${this.maxDurationMs}ms`;
        try { child.kill('SIGKILL'); } catch { /* noop */ }
      }, this.maxDurationMs);
      child.stdout.on('data', (data) => { stdout += data.toString(); idleTimer.refresh(); });
      child.stderr.on('data', (data) => { stderr += data.toString(); idleTimer.refresh(); });
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(idleTimer);
        clearTimeout(durationTimer);
        resolve(result);
      };
      // The close handler runs before the promise settles, so an image turn's collection reads the
      // private HOME before the .finally() below removes it.
      child.on('close', (code) => finish(this._closeResult({
        code, stdout, stderr, killReason, start, imageTurn, home: toolBridge.env.HOME, workspaceDir,
      })));
      child.on('error', (error) => finish({
        success: false, text: '', result: '', costUSD: 0, usage: {},
        durationMs: Date.now() - start, exitCode: -1, stderr: compactDiagnostic(error && error.message || error),
      }));
      // Register terminal listeners before writing. A failed executable can emit `error` immediately,
      // and a test double (or future implementation) may close synchronously from stdin.end().
      const input = JSON.stringify({ event: 'user', message: { content: String(taskDescription) } });
      try { child.stdin.end(`${input}\n`); } catch (error) {
        finish({
          success: false, text: '', result: '', costUSD: 0, usage: {},
          durationMs: Date.now() - start, exitCode: -1, stderr: compactDiagnostic(error && error.message || error),
        });
      }
    }).finally(() => { toolBridge.release(); userScope.release(); });
  }

  /**
   * @description The turn's result once agy has exited. A successful image turn also collects the
   * generate_image output (Guard A); a refused collection fails the turn with its reason.
   * @param {{code: number, stdout: string, stderr: string, killReason: string, start: number, imageTurn: boolean, home: string, workspaceDir: string}} turn - The finished turn.
   * @returns {object} The wrapper result.
   */
  _closeResult({ code, stdout, stderr, killReason, start, imageTurn, home, workspaceDir }) {
    const parsed = this._parse(stdout);
    const denials = parsed.denials.length ? `denied tool calls: ${parsed.denials.join('; ')}` : '';
    // Denials last: compactDiagnostic keeps the tail, and the target is the part a reader needs.
    const diagnostic = compactDiagnostic([killReason, stderr, parsed.error, denials].filter(Boolean).join('\n'));
    let success = code === 0 && parsed.status === 'SUCCESS' && parsed.text.length > 0;
    let image;
    let refusal = '';
    if (success && imageTurn) {
      const collected = collectImageTurnOutput({ home, workspaceDir, stdout, startedAtMs: start });
      if (collected.ok) image = { file: collected.file, mimeType: collected.mimeType, bytes: collected.bytes, sha256: collected.sha256, locator: collected.locator };
      else { success = false; refusal = collected.reason; }
    }
    return {
      success,
      text: parsed.text,
      result: parsed.text,
      costUSD: 0,
      usage: parsed.usage,
      durationMs: Date.now() - start,
      exitCode: code,
      ...(image ? { image } : {}),
      stderr: refusal || (success ? compactDiagnostic(stderr) : diagnostic || `Antigravity ended with status ${parsed.status || 'missing'}`),
    };
  }

  /**
   * @description Extracts the final result event (unknown/missing statuses fail closed) and every
   * permission-denied tool call. agy's own "no output produced" line names only the permission
   * kind; the denied step event carries the tool and its target, so a failure says what was asked.
   */
  _parse(stdout) {
    let final = null;
    const denials = [];
    for (const line of String(stdout || '').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const event = JSON.parse(trimmed);
        if (event && event.event === 'result' && event.result && typeof event.result === 'object') final = event.result;
        const note = deniedStepNote(event);
        if (note && denials.length < MAX_DENIAL_NOTES) denials.push(note);
      } catch { /* malformed progress cannot become a successful result */ }
    }
    if (!denials.length && final && Array.isArray(final.denied_actions)) {
      for (const denied of final.denied_actions.slice(0, MAX_DENIAL_NOTES)) {
        denials.push(compactDiagnostic(`${denied && denied.action} (${denied && denied.display_name})`).slice(0, MAX_DENIAL_CHARS));
      }
    }
    const usage = final && final.usage || {};
    return {
      status: final && typeof final.status === 'string' ? final.status : null,
      text: final && typeof final.response === 'string' ? final.response.trim() : '',
      error: final && typeof final.error === 'string' ? final.error : '',
      denials,
      usage: {
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        totalTokens: usage.total_tokens || 0,
        cacheReadTokens: usage.cache_read_tokens || 0,
        cacheCreationTokens: 0,
      },
    };
  }

  async isAvailable() {
    return new Promise((resolve) => {
      try {
        const child = this.spawnImpl(this.agyCommand, ['--version'], { env: buildCliDiagnosticEnv() });
        child.on('close', (code) => resolve(code === 0));
        child.on('error', () => resolve(false));
      } catch { resolve(false); }
    });
  }

  async testConnection() {
    return this.isAvailable();
  }
}

AntigravityCLIWrapper.provisionToolBridge = provisionToolBridge;
AntigravityCLIWrapper.buildAgyArgs = buildAgyArgs;
AntigravityCLIWrapper.permissionAllowList = permissionAllowList;
AntigravityCLIWrapper.assertImageTurnShape = assertImageTurnShape;
AntigravityCLIWrapper.HOST_TOOLS_AGENT = HOST_TOOLS_AGENT;
module.exports = AntigravityCLIWrapper;
