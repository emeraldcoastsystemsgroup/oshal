/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Install + always-update the agent CLIs on node start, so swarm.exec/claude.exec/codex.exec never ENOENT.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY: npm receives only runtime, owner config/cache, proxy, and registry settings rather than every desktop-node credential.
 */

import { spawn } from 'child_process';
import { buildLocalNodeProcessEnv } from './process-environment';

/**
 * @description The agent CLIs the worker spawns. `@anthropic-ai/claude-code` provides `claude`,
 * `@openai/codex` provides `codex`, `@google/gemini-cli` provides `gemini`. Mirrors what the
 * in-container bots get in Dockerfile.oshal. Override via OSHAL_AGENT_CLI_PACKAGES (comma list).
 */
const DEFAULT_PACKAGES = ['@anthropic-ai/claude-code@latest', '@openai/codex@latest'];

/** Resolve the package list (env override wins). */
function resolvePackages(explicit?: string[]): string[] {
  if (explicit && explicit.length) return explicit;
  const env = process.env.OSHAL_AGENT_CLI_PACKAGES;
  if (env) return env.split(',').map((s) => s.trim()).filter(Boolean);
  return DEFAULT_PACKAGES;
}

/**
 * @description Ensure the agent CLIs are installed and updated to @latest, run on every node start.
 * `npm install -g <pkg>@latest` installs when missing AND updates when present, so the worker's
 * codex/claude/gemini tools are always there and current. Best-effort: a failure (offline, no npm)
 * is logged and swallowed — the node still runs, the worker just can't use a missing CLI until next
 * successful update. Set OSHAL_SKIP_CLI_UPDATE=true to disable.
 *
 * @param opts.packages - explicit package list (defaults to claude-code + codex, or the env override)
 * @param opts.onLog - progress sink (wire to the worker event stream so the UI shows it)
 * @returns resolves when the install/update finishes (or is skipped)
 */
export function ensureAgentClis(opts: { packages?: string[]; onLog?: (message: string) => void } = {}): Promise<void> {
  const log = opts.onLog ?? (() => {});
  if (process.env.OSHAL_SKIP_CLI_UPDATE === 'true') {
    log('Agent CLI auto-update disabled (OSHAL_SKIP_CLI_UPDATE=true)');
    return Promise.resolve();
  }
  const packages = resolvePackages(opts.packages);
  if (!packages.length) return Promise.resolve();

  return new Promise<void>((resolve) => {
    log(`Ensuring agent CLIs (install + update): ${packages.join(', ')}`);
    // npm is npm.cmd on Windows; shell:true lets the PATH-resolved launcher run there.
    const isWin = process.platform === 'win32';
    const child = spawn(isWin ? 'npm.cmd' : 'npm', ['install', '-g', ...packages], {
      stdio: 'ignore',
      shell: isWin,
      env: buildLocalNodeProcessEnv(),
    });
    child.on('error', (err) => {
      log(`Agent CLI update skipped (${err.message}) — continuing without it`);
      resolve();
    });
    child.on('close', (code) => {
      log(code === 0 ? 'Agent CLIs installed + up to date' : `Agent CLI update exited ${code} (continuing)`);
      resolve();
    });
  });
}
