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
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { acquireUserScoping } = require('./user-scoping');
const { buildCliDiagnosticEnv } = require('./cli-diagnostic-env');
const { assertCliToolBoundary } = require('../llm/assert-cli-tool-boundary');

const DEFAULT_IDLE_MS = 600000;
const DEFAULT_MAX_DURATION_MS = 7200000;
const MAX_DIAGNOSTIC_CHARS = 1200;
const DEFAULT_TOOLS_MCP_PATH = '/app/scripts/oshal-tools-mcp.js';

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

/** Build one private HOME because agy discovers MCP servers only from ~/.gemini/config. */
function provisionToolBridge(binding) {
  if (!binding) return { env: {}, release: () => {} };
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

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-agy-mcp-'));
  try {
    const geminiRoot = path.join(home, '.gemini');
    const cliRoot = path.join(geminiRoot, 'antigravity-cli');
    const configRoot = path.join(geminiRoot, 'config');
    fs.mkdirSync(cliRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(configRoot, { recursive: true, mode: 0o700 });
    const tokenPath = process.env.ANTIGRAVITY_OAUTH_TOKEN_PATH || '/root/.gemini/antigravity-cli/antigravity-oauth-token';
    linkCredential(tokenPath, path.join(cliRoot, 'antigravity-oauth-token'));
    linkCredential(path.join(path.dirname(tokenPath), 'installation_id'), path.join(cliRoot, 'installation_id'));
    fs.writeFileSync(path.join(configRoot, 'mcp_config.json'), JSON.stringify({
      mcpServers: {
        'oshal-tools': { command: 'node', args: [bridgePath], disabled: false },
      },
    }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return {
      env: {
        HOME: home,
        OSHAL_API_BASE: parsedBase.href.replace(/\/+$/, ''),
        SWARM_SERVICE_SECRET: secret,
        OSHAL_AGENT_ID: agentId,
        OSHAL_USER_SUB: userSub,
        OSHAL_TASK_ID: taskId,
        OSHAL_APPLICATION_EXECUTION_ID: executionId,
        OSHAL_APPLICATION_EXECUTION_TOKEN: executionToken,
      },
      release: () => {
        if (path.dirname(home) === path.resolve(os.tmpdir()) && path.basename(home).startsWith('oshal-agy-mcp-')) {
          fs.rmSync(home, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    if (path.dirname(home) === path.resolve(os.tmpdir()) && path.basename(home).startsWith('oshal-agy-mcp-')) {
      fs.rmSync(home, { recursive: true, force: true });
    }
    throw error;
  }
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
   * @param {{model?: string, effort?: string, timeout?: number, extraEnv?: object, toolBridge?: object}} [options]
   */
  async executeTask(taskDescription, workspaceDir, options = {}) {
    assertCliToolBoundary(options, 'antigravity-cli');
    fs.mkdirSync(workspaceDir, { recursive: true });
    const idleMs = positiveMs(options.timeout, this.timeoutMs);
    const args = [
      '--mode', 'accept-edits',
      '--sandbox',
      '--add-dir', workspaceDir,
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--model', options.model || this.model,
      '--print-timeout', timeoutArg(idleMs),
    ];
    const effort = options.effort || this.effort;
    if (effort) args.push('--effort', effort);

    const start = Date.now();
    const userScope = await acquireUserScoping(workspaceDir, options.extraEnv);
    let toolBridge;
    try {
      toolBridge = provisionToolBridge(options.toolBridge);
    } catch (error) {
      userScope.release();
      throw error;
    }
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
      child.on('close', (code) => {
        const parsed = this._parse(stdout);
        const diagnostic = compactDiagnostic([killReason, stderr, parsed.error].filter(Boolean).join('\n'));
        const success = code === 0 && parsed.status === 'SUCCESS' && parsed.text.length > 0;
        finish({
          success,
          text: parsed.text,
          result: parsed.text,
          costUSD: 0,
          usage: parsed.usage,
          durationMs: Date.now() - start,
          exitCode: code,
          stderr: success ? compactDiagnostic(stderr) : diagnostic || `Antigravity ended with status ${parsed.status || 'missing'}`,
        });
      });
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

  /** @description Extracts the final result event. Unknown/missing statuses fail closed. */
  _parse(stdout) {
    let final = null;
    for (const line of String(stdout || '').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const event = JSON.parse(trimmed);
        if (event && event.event === 'result' && event.result && typeof event.result === 'object') final = event.result;
      } catch { /* malformed progress cannot become a successful result */ }
    }
    const usage = final && final.usage || {};
    return {
      status: final && typeof final.status === 'string' ? final.status : null,
      text: final && typeof final.response === 'string' ? final.response.trim() : '',
      error: final && typeof final.error === 'string' ? final.error : '',
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
module.exports = AntigravityCLIWrapper;
