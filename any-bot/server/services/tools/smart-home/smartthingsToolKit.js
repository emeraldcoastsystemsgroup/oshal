/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | SmartThings connector TOOLS for the home-bot (ADR-025 dynamic tools + ADR-042 multi-account). Thin wrappers over scripts/oshal-smartthings.js — each shells the per-user CLI scoped by OSHAL_USER_SUB and an optional connection SELECTOR (label/account/connection) the bot fills from the user's request ("my lake house"). Auto-discovered via the home.yaml toolsDir; described to the LLM with input schemas in swarm-apps/home.yaml. Pattern: exports { 'tool-name': handlerFn } (same as careerHunterTool.js).
 */
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

// /app/any-bot/server/services/tools/smart-home → /app/scripts/oshal-smartthings.js
const CLI = path.resolve(__dirname, '..', '..', '..', '..', '..', 'scripts', 'oshal-smartthings.js');

/** Build the per-request env: the caller's identity + the chosen connection selector.
 *  `params` come from the LLM tool call; userSub is also read from the broker-set env. */
function envFor(params) {
  const env = { ...process.env };
  if (params.userSub) env.OSHAL_USER_SUB = String(params.userSub);
  // Connection selector — the bot sets these from the account the user named.
  if (params.label) env.OSHAL_CONNECTION_LABEL = String(params.label);
  if (params.account || params.email) env.OSHAL_CONNECTION_EMAIL = String(params.account || params.email);
  if (params.connection || params.connectionId) env.OSHAL_CONNECTION_ID = String(params.connection || params.connectionId);
  return env;
}

/** Run a CLI verb; return { ok, exitCode, stdout, stderr }. stdout is the CLI's JSON. */
function runCli(verb, args, params) {
  const argv = (verb ? [verb] : []).concat(args || []);
  const r = spawnSync('node', [CLI, ...argv], { env: envFor(params || {}), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return {
    ok: r.status === 0,
    exitCode: r.status,
    stdout: (r.stdout || '').slice(-200000),
    stderr: (r.stderr || '').slice(-8000),
  };
}

module.exports = {
  /** List the user's labeled SmartThings accounts (the catalog to select from). */
  'smartthings-accounts': async function (params = {}) {
    return runCli('accounts', [], params);
  },

  /** Full state: every device (with on/off) + scenes for the selected account. */
  'smartthings-digest': async function (params = {}) {
    return runCli('', [], params);
  },

  /** List devices for the selected account. */
  'smartthings-devices': async function (params = {}) {
    return runCli('devices', [], params);
  },

  /** Detailed status of one device. */
  'smartthings-status': async function (params = {}) {
    if (!params.deviceId) return { ok: false, error: 'deviceId required' };
    return runCli('status', [String(params.deviceId)], params);
  },

  /** Control a device: on/off, or set <capability> <command> [arg] (e.g. switchLevel setLevel 30). */
  'smartthings-control': async function (params = {}) {
    if (!params.deviceId || !params.command) return { ok: false, error: 'deviceId and command required' };
    const cmd = String(params.command);
    if (cmd === 'on' || cmd === 'off') return runCli('control', [String(params.deviceId), cmd], params);
    if (cmd === 'set') {
      if (!params.capability) return { ok: false, error: 'capability required for set' };
      const a = [String(params.deviceId), 'set', String(params.capability), String(params.cmdName || params.capability)];
      if (params.arg !== undefined) a.push(String(params.arg));
      return runCli('control', a, params);
    }
    return { ok: false, error: "command must be 'on', 'off', or 'set'" };
  },

  /** List runnable scenes for the selected account. */
  'smartthings-scenes': async function (params = {}) {
    return runCli('scenes', [], params);
  },

  /** Run a scene by id. */
  'smartthings-run-scene': async function (params = {}) {
    if (!params.sceneId) return { ok: false, error: 'sceneId required' };
    return runCli('scene', [String(params.sceneId)], params);
  },
};
