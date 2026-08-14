#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Setup bootstrap: install/update the agent CLIs this node runs work with (OpenAI Codex, Claude Code, Cline). Runs as the package `postinstall` (so `npx @oshal/chat` / `npm install` bootstraps them) and via `npm run setup`. Best-effort + idempotent: a global-install failure (offline, perms) never fails the OSHAL Node install — the app's Config → Accounts still lets you log in once a CLI is present.
 */

'use strict';

const { spawnSync } = require('child_process');

// The agent CLIs the worker node executes tasks with. `bin` is the command we
// probe to confirm install; `pkg` is the npm package we install/update to @latest.
const CLIS = [
  { id: 'codex', pkg: '@openai/codex', bin: 'codex' },
  { id: 'claude', pkg: '@anthropic-ai/claude-code', bin: 'claude' },
  { id: 'cline', pkg: 'cline', bin: 'cline' },
];

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** Runs a command, returning { ok, stdout, stderr } — never throws. */
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32', // resolve .cmd shims on Windows
    timeout: opts.timeoutMs || 300_000,
    ...opts,
  });
  return {
    ok: res.status === 0,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim() || (res.error ? String(res.error.message) : ''),
  };
}

/** Best-effort version probe for an installed CLI. */
function probe(bin) {
  const res = run(bin, ['--version'], { timeoutMs: 20_000 });
  return res.ok ? res.stdout.split('\n')[0] : null;
}

function main() {
  // OPT-IN, not opt-out, and the inversion matters the moment this package is public.
  // As a postinstall, this runs on every `npm install` — so opting OUT meant one install
  // globally installing three other people's CLIs, at @latest, on a stranger's machine.
  // Nobody asks for that by typing `npm i @oshal/chat`. The swarm's own installer passes
  // -WithCliTools, which sets the flag; `npm run setup` sets it too.
  const askedFor = process.env.OSHAL_INSTALL_CLI_TOOLS || process.argv.includes('--install');
  if (!askedFor) {
    console.log(
      '[oshal-setup] Skipping the agent-CLI bootstrap (codex, claude-code, cline).\n'
      + '[oshal-setup] Run `npm run setup` in this package, or install with '
      + 'OSHAL_INSTALL_CLI_TOOLS=1, to add them.',
    );
    return;
  }

  console.log('[oshal-setup] Installing/updating agent CLIs (codex, claude-code, cline)...');
  const summary = [];

  for (const cli of CLIS) {
    const before = probe(cli.bin);
    const verb = before ? 'Updating' : 'Installing';
    console.log(`[oshal-setup] ${verb} ${cli.pkg} (${cli.bin})...`);
    const install = run(npmCmd, ['install', '-g', `${cli.pkg}@latest`]);
    const after = probe(cli.bin);

    if (after) {
      summary.push(`  ok   ${cli.bin.padEnd(8)} ${after}${before && before !== after ? `  (was ${before})` : ''}`);
    } else if (install.ok) {
      summary.push(`  ok   ${cli.bin.padEnd(8)} installed (version probe unavailable)`);
    } else {
      // Non-fatal: surface the reason but keep going so the OSHAL Node install succeeds.
      const reason = (install.stderr || 'unknown error').split('\n').slice(-1)[0];
      summary.push(`  SKIP ${cli.bin.padEnd(8)} could not install — ${reason}`);
    }
  }

  console.log('[oshal-setup] Agent CLI bootstrap complete:');
  console.log(summary.join('\n'));
  console.log('[oshal-setup] Next: launch the app and use Config -> Accounts to sign each CLI in (codex login / claude /login / cline auth).');
}

try {
  main();
} catch (err) {
  // postinstall must never break the OSHAL Node install.
  console.warn('[oshal-setup] CLI bootstrap encountered an error (continuing):', err && err.message ? err.message : err);
}
