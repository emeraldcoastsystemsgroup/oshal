/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted standalone chat MCP server summary helpers from the oversized chat config modal controller
 */

/**
 * @description Summarizes an MCP server config into a short human-readable label.
 * @param {Record<string, unknown>} config MCP server config object.
 * @param {(value: unknown) => string} readNonEmptyString String normalization helper.
 * @returns {string} Short server summary.
 */
export function summarizeMcpServer(config, readNonEmptyString) {
  const url = readNonEmptyString(config?.url);
  if (url) {
    return `Remote endpoint ${url}`;
  }

  const command = readNonEmptyString(config?.command);
  const args = Array.isArray(config?.args) ? config.args.filter((value) => typeof value === 'string') : [];
  if (command) {
    return `${command}${args.length > 0 ? ` ${args.join(' ')}` : ''}`;
  }

  return 'Configured runtime server';
}
