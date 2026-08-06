/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Define the local desktop node's CLI/npm subprocess boundary so signed-in tool configuration remains available without forwarding unrelated host secrets.
 */

const LOCAL_NODE_PROCESS_ENV_KEYS = [
  'PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'SHELL',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
  'LANG', 'LC_ALL', 'TZ', 'TERM', 'COLORTERM', 'NO_COLOR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
  'NPM_CONFIG_PREFIX', 'npm_config_prefix', 'NPM_CONFIG_REGISTRY', 'npm_config_registry',
] as const;

/**
 * Build an environment for local signed-in CLI and package-manager children.
 * Provider/controller/database secrets are intentionally absent; OAuth CLIs use their own
 * owner-scoped config directories under HOME/CODEX_HOME/CLAUDE_CONFIG_DIR.
 */
export function buildLocalNodeProcessEnv(
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of LOCAL_NODE_PROCESS_ENV_KEYS) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}
