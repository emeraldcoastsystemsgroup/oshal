/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: build a minimal, credential-free environment for CLI version and authentication diagnostics.
 */

'use strict';

/**
 * Environment keys needed for local executable discovery, temporary files, locale, and
 * profile-based CLI authentication. Platform, connector, database, and model-provider
 * credentials are intentionally absent.
 */
const DIAGNOSTIC_ENV_KEYS = Object.freeze([
  'APPDATA', 'LOCALAPPDATA',
  'COMSPEC', 'ComSpec',
  'HOME', 'USERPROFILE', 'USER', 'USERNAME', 'LOGNAME',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE',
  'NO_COLOR', 'TERM', 'COLORTERM',
  'PATHEXT', 'SHELL',
  'SystemRoot', 'SYSTEMROOT', 'WINDIR',
  'TEMP', 'TMP', 'TMPDIR',
  'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
]);

/**
 * @description Build the environment for a non-model CLI diagnostic subprocess. Only the
 * operating-system/profile values required to locate and inspect a CLI are inherited. In
 * particular, arbitrary ambient variables and provider API keys never cross this boundary.
 * @param {{source?: NodeJS.ProcessEnv, path?: string}} [options] - Source environment and an
 * optional PATH override used by wrappers that prepend their local CLI installation directory.
 * @returns {Record<string, string>} Credential-free diagnostic child environment.
 */
function buildCliDiagnosticEnv(options = {}) {
  const source = options.source || process.env;
  const env = {};
  for (const key of DIAGNOSTIC_ENV_KEYS) {
    if (typeof source[key] === 'string') env[key] = source[key];
  }

  const executablePath = typeof options.path === 'string'
    ? options.path
    : (typeof source.PATH === 'string' ? source.PATH : source.Path);
  if (typeof executablePath === 'string') env.PATH = executablePath;
  return env;
}

module.exports = { buildCliDiagnosticEnv };
