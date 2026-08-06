/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | GCP connector tools for the cloud bot (ADR-025 dynamic tools + ADR-042 multi-account).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: retire the credential-bearing GCP subprocess behind the canonical broker denial until an audited server-side connector broker exists; model input can no longer select OSHAL_USER_SUB or inherit controller secrets.
 */
'use strict';

const { runBrokeredCli } = require('../brokered-cli-runner');

/** Keep the stable tool contract while failing closed before any credential carrier is created. */
function runCli(verb, args, params = {}, context = {}) {
  const argv = (verb ? [verb] : []).concat(args || []);
  return runBrokeredCli({
    script: 'oshal-gcp.js',
    args: argv,
    params,
    context,
    errorLabel: 'gcp',
  });
}

module.exports = {
  /** List the caller's labeled GCP connections. */
  'gcp-accounts': async function (params = {}, context = {}) {
    return runCli('accounts', [], params, context);
  },

  /** List the caller's Google Cloud projects. */
  'gcp-projects': async function (params = {}, context = {}) {
    return runCli('projects', [], params, context);
  },

  /** Read one project. */
  'gcp-project': async function (params = {}, context = {}) {
    if (!params.projectId) return { ok: false, error: 'projectId required' };
    return runCli('project', [String(params.projectId)], params, context);
  },

  /** List enabled APIs for one project. */
  'gcp-services': async function (params = {}, context = {}) {
    if (!params.projectId) return { ok: false, error: 'projectId required' };
    return runCli('services', [String(params.projectId)], params, context);
  },

  /** List Compute Engine instances for one project. */
  'gcp-instances': async function (params = {}, context = {}) {
    if (!params.projectId) return { ok: false, error: 'projectId required' };
    return runCli('instances', [String(params.projectId)], params, context);
  },
};
