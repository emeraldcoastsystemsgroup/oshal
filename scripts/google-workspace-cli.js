#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR          | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added repo-native Google Workspace CLI using official OAuth and REST APIs for Gmail, Drive, Docs, Sheets, Slides, and Calendar
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Decomposed for the 1000-code-line cap: auth manager, REST client, per-service command handlers, config/usage, and shared CLI utilities extracted to scripts/lib/google-workspace/ — entry path, argv surface, and module exports unchanged
 */

const packageJson = require('../package.json');

const {
  parseArguments,
  readBooleanOption,
  formatPrettyOutput,
} = require('./lib/google-workspace/cli-utils');
const {
  DEFAULT_SCOPES,
  DEFAULT_ENDPOINTS,
  buildRuntimeConfig,
  buildUsageText,
  normalizeCommandAlias,
} = require('./lib/google-workspace/config');
const {
  GoogleWorkspaceAuthManager,
  createServiceAccountAssertion,
} = require('./lib/google-workspace/auth-manager');
const {
  GoogleWorkspaceClient,
  extractDocumentText,
  extractGmailText,
} = require('./lib/google-workspace/workspace-client');
const {
  handleAuthCommand,
  handleGmailCommand,
  handleDriveCommand,
  handleDocsCommand,
  handleSheetsCommand,
  handleSlidesCommand,
  handleCalendarCommand,
  handleApiCommand,
} = require('./lib/google-workspace/command-handlers');

/**
 * @description Runs one CLI invocation end to end: parses argv, builds the
 * runtime config from options + env, wires the auth manager and REST client,
 * dispatches to the matching command handler, and writes the rendered result
 * (JSON by default) to stdout.
 * @param {string[]} argv Argument vector without the node/script entries.
 * @param {object} [runtime] Optional overrides for tests ({ stdout, env }).
 * @returns {Promise<*>} The command result (or usage text for help).
 */
async function runCli(argv, runtime = {}) {
  const { positional, options } = parseArguments(argv);
  const stdout = runtime.stdout || process.stdout;
  const env = runtime.env || process.env;
  const config = buildRuntimeConfig(options, env);
  const auth = new GoogleWorkspaceAuthManager(config);
  const client = new GoogleWorkspaceClient({ auth, endpoints: config.endpoints });
  const jsonOutput = readBooleanOption(options.json) !== false;

  const primaryCommand = positional[0];
  const command = normalizeCommandAlias(primaryCommand);

  if (!command || command === 'help') {
    const usage = buildUsageText();
    stdout.write(`${usage}\n`);
    return usage;
  }

  let result;
  switch (command) {
    case 'version':
      result = {
        cli: 'oshal-google-workspace',
        version: packageJson.version,
      };
      break;
    case 'auth':
      result = await handleAuthCommand(auth, positional.slice(1), options);
      break;
    case 'gmail':
      result = await handleGmailCommand(client, positional.slice(1), options);
      break;
    case 'drive':
      result = await handleDriveCommand(client, positional.slice(1), options);
      break;
    case 'docs':
      result = await handleDocsCommand(client, positional.slice(1), options);
      break;
    case 'sheets':
      result = await handleSheetsCommand(client, positional.slice(1), options);
      break;
    case 'slides':
      result = await handleSlidesCommand(client, positional.slice(1), options);
      break;
    case 'calendar':
      result = await handleCalendarCommand(client, positional.slice(1), options);
      break;
    case 'api':
      result = await handleApiCommand(client, positional.slice(1), options);
      break;
    default:
      throw new Error(`Unknown command "${primaryCommand}". Run "oshal-google-workspace help" for usage.`);
  }

  const rendered = jsonOutput
    ? JSON.stringify(result, null, 2)
    : formatPrettyOutput(result);
  stdout.write(`${rendered}\n`);
  return result;
}

function main() {
  return runCli(process.argv.slice(2));
}

module.exports = {
  DEFAULT_SCOPES,
  DEFAULT_ENDPOINTS,
  GoogleWorkspaceAuthManager,
  GoogleWorkspaceClient,
  buildRuntimeConfig,
  buildUsageText,
  createServiceAccountAssertion,
  extractDocumentText,
  extractGmailText,
  normalizeCommandAlias,
  parseArguments,
  runCli,
};

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
