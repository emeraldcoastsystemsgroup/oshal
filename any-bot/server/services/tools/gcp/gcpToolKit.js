/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | GCP (Google Cloud) connector TOOLS (ADR-025 dynamic tools + ADR-042 multi-account). Thin wrappers over scripts/oshal-gcp.js — each shells the per-user CLI scoped by OSHAL_USER_SUB + an optional connection SELECTOR (label/account). The API-based replacement for `gcloud` so a remote web user's bot can drive Google Cloud (the user connects via web OAuth at /utilities — cloud-platform scope — no interactive CLI login). Auto-discovered via cloud.yaml toolsDir. Pattern: exports { 'tool-name': handlerFn } (same as smartthingsToolKit.js).
 */
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

// /app/any-bot/server/services/tools/gcp → /app/scripts/oshal-gcp.js
const CLI = path.resolve(__dirname, '..', '..', '..', '..', '..', 'scripts', 'oshal-gcp.js');

/** Per-request env: caller identity + chosen connection selector. */
function envFor(params) {
  const env = { ...process.env };
  if (params.userSub) env.OSHAL_USER_SUB = String(params.userSub);
  if (params.label) env.OSHAL_CONNECTION_LABEL = String(params.label);
  if (params.account || params.email) env.OSHAL_CONNECTION_EMAIL = String(params.account || params.email);
  if (params.connection || params.connectionId) env.OSHAL_CONNECTION_ID = String(params.connection || params.connectionId);
  return env;
}

/** Run a CLI verb; return { ok, exitCode, stdout, stderr }. stdout is the CLI's JSON. */
function runCli(verb, args, params) {
  const argv = (verb ? [verb] : []).concat(args || []);
  const r = spawnSync('node', [CLI, ...argv], { env: envFor(params || {}), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return { ok: r.status === 0, exitCode: r.status, stdout: (r.stdout || '').slice(-200000), stderr: (r.stderr || '').slice(-8000) };
}

module.exports = {
  /** List the user's labeled GCP connections (the catalog to select from). */
  'gcp-accounts': async function (params = {}) { return runCli('accounts', [], params); },

  /** List the user's Google Cloud projects (Cloud Resource Manager API). */
  'gcp-projects': async function (params = {}) { return runCli('projects', [], params); },

  /** Detail for one project. */
  'gcp-project': async function (params = {}) {
    if (!params.projectId) return { ok: false, error: 'projectId required' };
    return runCli('project', [String(params.projectId)], params);
  },

  /** Enabled APIs/services on a project. */
  'gcp-services': async function (params = {}) {
    if (!params.projectId) return { ok: false, error: 'projectId required' };
    return runCli('services', [String(params.projectId)], params);
  },

  /** Compute Engine instances across all zones in a project. */
  'gcp-instances': async function (params = {}) {
    if (!params.projectId) return { ok: false, error: 'projectId required' };
    return runCli('instances', [String(params.projectId)], params);
  },
};
