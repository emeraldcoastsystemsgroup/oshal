/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | SmartThings connector tools for the home bot (ADR-025 dynamic tools + ADR-042 multi-account).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: retire the credential-bearing SmartThings subprocess behind the canonical broker denial until an audited server-side connector broker exists; model input can no longer select OSHAL_USER_SUB or inherit controller secrets.
 */
'use strict';

const { runBrokeredCli } = require('../brokered-cli-runner');

/** Keep the stable tool contract while failing closed before any credential carrier is created. */
function runCli(verb, args, params = {}, context = {}) {
  const argv = (verb ? [verb] : []).concat(args || []);
  return runBrokeredCli({
    script: 'oshal-smartthings.js',
    args: argv,
    params,
    context,
    errorLabel: 'smartthings',
  });
}

module.exports = {
  /** List the caller's labeled SmartThings accounts. */
  'smartthings-accounts': async function (params = {}, context = {}) {
    return runCli('accounts', [], params, context);
  },

  /** Read devices and scenes for the selected account. */
  'smartthings-digest': async function (params = {}, context = {}) {
    return runCli('', [], params, context);
  },

  /** List devices for the selected account. */
  'smartthings-devices': async function (params = {}, context = {}) {
    return runCli('devices', [], params, context);
  },

  /** Read one device's detailed status. */
  'smartthings-status': async function (params = {}, context = {}) {
    if (!params.deviceId) return { ok: false, error: 'deviceId required' };
    return runCli('status', [String(params.deviceId)], params, context);
  },

  /** Control a device only through the future audited provider broker. */
  'smartthings-control': async function (params = {}, context = {}) {
    if (!params.deviceId || !params.command) return { ok: false, error: 'deviceId and command required' };
    const command = String(params.command);
    if (command === 'on' || command === 'off') {
      return runCli('control', [String(params.deviceId), command], params, context);
    }
    if (command === 'set') {
      if (!params.capability) return { ok: false, error: 'capability required for set' };
      const args = [
        String(params.deviceId),
        'set',
        String(params.capability),
        String(params.cmdName || params.capability),
      ];
      if (params.arg !== undefined) args.push(String(params.arg));
      return runCli('control', args, params, context);
    }
    return { ok: false, error: "command must be 'on', 'off', or 'set'" };
  },

  /** List scenes for the selected account. */
  'smartthings-scenes': async function (params = {}, context = {}) {
    return runCli('scenes', [], params, context);
  },

  /** Run a scene only through the future audited provider broker. */
  'smartthings-run-scene': async function (params = {}, context = {}) {
    if (!params.sceneId) return { ok: false, error: 'sceneId required' };
    return runCli('scene', [String(params.sceneId)], params, context);
  },
};
