/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Allowlisted local tool registry: the node exposes these as MCP tools the swarm invokes via `mcp.call-tool`. NOT arbitrary shell — only the named tools below can run, so a confused/compromised swarm can't run anything it likes on the user's machine. `swarm.exec` auto-picks whichever local CLI is signed in.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added GATED system-control tools (screen.capture / shell.exec / desktop.control / app.open). These refuse unless config.allowSystemControl is on (off by default); the gate is threaded through runLocalTool + localCapabilities.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Coordinate-space contract: screen.capture now reports physicalWidth/physicalHeight/scaleFactor alongside the (downscaled) width/height, and desktop.control threads an optional coordinateSpace arg ('screenshot' default | 'physical') through to controlInput so screenshot-derived clicks are rescaled to physical pixels.
 */

import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { runCodex, runClaude, type ExecResult } from './executors';
import { captureScreen, runShell, controlInput, type InputAction } from './system-tools';

/** Outcome the worker turns into an A2A task result. */
export interface ToolOutcome {
  success: boolean;
  /** Human/agent-readable output text. */
  text: string;
  /** Structured detail mirrored into the task result `output`. */
  output: Record<string, unknown>;
  error?: string;
}

/** A local capability the node advertises and can execute. */
interface LocalTool {
  name: string;
  description: string;
  run: (args: Record<string, unknown>, gate: ToolGate) => Promise<ToolOutcome>;
}

/** Pulls the prompt out of tool arguments under any of the common keys. */
function readPrompt(args: Record<string, unknown>): string {
  const v = args.prompt ?? args.text ?? args.task ?? args.message ?? args.input;
  return typeof v === 'string' ? v : '';
}

/** Shapes an ExecResult into a ToolOutcome. */
function toOutcome(r: ExecResult, provider: string): ToolOutcome {
  return {
    success: r.success,
    text: r.text,
    output: { response: r.text, provider, usage: r.usage, cost: r.costUSD, durationMs: r.durationMs, exitCode: r.exitCode },
    error: r.success ? undefined : (r.stderr || 'CLI returned no output'),
  };
}

const home = homedir();
const codexAuthed = (): boolean => existsSync(join(home, '.codex', 'auth.json'));
const claudeAuthed = (): boolean => existsSync(join(home, '.claude', '.credentials.json'));

const TOOLS: LocalTool[] = [
  {
    name: 'codex.exec',
    description: 'Run a prompt through the OpenAI Codex CLI on this machine.',
    run: async (args, gate) => {
      const prompt = readPrompt(args);
      if (!prompt) return { success: false, text: '', output: {}, error: 'codex.exec requires a prompt' };
      return toOutcome(await runCodex(prompt, { model: typeof args.model === 'string' ? args.model : undefined, sandbox: typeof args.sandbox === 'string' ? args.sandbox : undefined, cwd: gate.workspaceDir }), 'openai-codex');
    },
  },
  {
    name: 'claude.exec',
    description: 'Run a prompt through the Claude Code CLI on this machine.',
    run: async (args, gate) => {
      const prompt = readPrompt(args);
      if (!prompt) return { success: false, text: '', output: {}, error: 'claude.exec requires a prompt' };
      return toOutcome(await runClaude(prompt, { model: typeof args.model === 'string' ? args.model : undefined, cwd: gate.workspaceDir }), 'claude-code');
    },
  },
  {
    name: 'swarm.exec',
    description: 'Run a prompt with whichever local CLI is signed in (codex preferred, else claude).',
    run: async (args, gate) => {
      const prompt = readPrompt(args);
      if (!prompt) return { success: false, text: '', output: {}, error: 'swarm.exec requires a prompt' };
      if (codexAuthed()) return toOutcome(await runCodex(prompt, { cwd: gate.workspaceDir }), 'openai-codex');
      if (claudeAuthed()) return toOutcome(await runClaude(prompt, { cwd: gate.workspaceDir }), 'claude-code');
      return { success: false, text: '', output: {}, error: 'No local CLI is signed in (codex/claude). Open Config → Accounts to log in.' };
    },
  },
];

// GATED system-control tools — only usable when config.allowSystemControl is on.
// These let the swarm see + drive this machine (screenshot, shell, mouse/keyboard,
// launch apps), e.g. "open Outlook and screenshot it" or "search My Documents for PDFs".
const SYSTEM_TOOLS: LocalTool[] = [
  {
    name: 'screen.capture',
    description: 'Take a screenshot of this machine and return it as a PNG data URL.',
    run: async (args) => {
      const shot = await captureScreen(typeof args.maxWidth === 'number' ? args.maxWidth : undefined);
      return {
        success: shot.success,
        text: shot.success ? `[screenshot ${shot.width}x${shot.height}]` : '',
        output: {
          dataUrl: shot.dataUrl,
          width: shot.width,
          height: shot.height,
          physicalWidth: shot.physicalWidth,
          physicalHeight: shot.physicalHeight,
          scaleFactor: shot.scaleFactor,
        },
        error: shot.success ? undefined : shot.error,
      };
    },
  },
  {
    name: 'shell.exec',
    description: 'Run a PowerShell command on this machine and return its output.',
    run: async (args, gate) => {
      const command = typeof args.command === 'string' ? args.command : typeof args.cmd === 'string' ? args.cmd : '';
      if (!command) return { success: false, text: '', output: {}, error: 'shell.exec requires a command' };
      const r = await runShell(command, 120_000, gate.workspaceDir);
      return { success: r.success, text: r.stdout || r.stderr, output: { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode } };
    },
  },
  {
    name: 'desktop.control',
    description: 'Move/click the mouse or type on this machine. args: { kind: move|click|doubleclick|rightclick|type, x, y, text, coordinateSpace? }. x/y default to the screen.capture screenshot space (rescaled to physical pixels); pass coordinateSpace:"physical" to send raw device pixels.',
    run: async (args) => {
      const coordinateSpace = args.coordinateSpace === 'physical' ? 'physical' : undefined;
      const action = { kind: args.kind, x: args.x, y: args.y, text: args.text, coordinateSpace } as InputAction;
      const r = await controlInput(action);
      return { success: r.success, text: r.success ? `${action.kind} ok (${r.via})` : '', output: { via: r.via }, error: r.error };
    },
  },
  {
    name: 'app.open',
    description: 'Launch a desktop application by name (e.g. "outlook", "notepad").',
    run: async (args) => {
      const app = typeof args.app === 'string' ? args.app : typeof args.name === 'string' ? args.name : '';
      if (!app) return { success: false, text: '', output: {}, error: 'app.open requires an app name' };
      const r = await controlInput({ kind: 'launch', app });
      return { success: r.success, text: r.success ? `launched ${app}` : '', output: { app, via: r.via }, error: r.error };
    },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
const SYSTEM_BY_NAME = new Map(SYSTEM_TOOLS.map((t) => [t.name, t]));

/** Options that scope what tools may run. */
export interface ToolGate {
  /** When true, the gated system-control tools are usable. */
  allowSystemControl?: boolean;
  /** When set, CLI/shell tools run IN this mapped task workspace (the shared folder). */
  workspaceDir?: string;
}

/** Capability ids this node advertises (base tools + system tools when allowed). */
export function localCapabilities(gate: ToolGate = {}): string[] {
  const base = TOOLS.map((t) => t.name);
  return gate.allowSystemControl ? [...base, ...SYSTEM_TOOLS.map((t) => t.name)] : base;
}

/** Tool descriptors — for `mcp.list-tools` and the config screen. */
export function localToolList(gate: ToolGate = {}): Array<{ name: string; description: string }> {
  const list = TOOLS.map((t) => ({ name: t.name, description: t.description }));
  return gate.allowSystemControl ? [...list, ...SYSTEM_TOOLS.map((t) => ({ name: t.name, description: t.description }))] : list;
}

/**
 * @description Executes one named tool against the allowlisted registry.
 * System-control tools require the gate; an unknown name is a hard failure
 * (never falls through to a shell).
 */
export async function runLocalTool(name: string, args: Record<string, unknown>, gate: ToolGate = {}): Promise<ToolOutcome> {
  const base = BY_NAME.get(name);
  const system = SYSTEM_BY_NAME.get(name);
  if (system && !gate.allowSystemControl) {
    return { success: false, text: '', output: { name }, error: `Tool "${name}" needs system control, which is OFF. Enable it in Config → "Allow this machine to be controlled".` };
  }
  const tool = base || system;
  if (!tool) return { success: false, text: '', output: { name }, error: `No local tool named "${name}"` };
  try {
    return await tool.run(args || {}, gate);
  } catch (err) {
    return { success: false, text: '', output: { name }, error: err instanceof Error ? err.message : String(err) };
  }
}
