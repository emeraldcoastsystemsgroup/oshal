#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — entrypoint: config (flags > env > defaults, nothing hardcoded in the runtime path), drop-folder creation, server + mDNS boot, human-readable startup banner on stderr (stdout is reserved for JSON logs so a service wrapper can capture them cleanly), graceful SIGINT/SIGTERM shutdown that withdraws the mDNS advertisement before exit. The printer UUID is derived deterministically from hostname + printer name so clients see the same printer identity across restarts.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startIppServer } = require('../lib/ipp-server');
const { advertisePrinter } = require('../lib/advertise');
const { createLogger } = require('../lib/log');

const HELP = `oshal-print-drop - IPP virtual printer; print jobs land as files in a drop folder.

Options (flag > env > default):
  --name <text>    Printer name        OSHAL_PRINT_NAME      "Oshal Print to File Printer"
  --port <n>       TCP port            OSHAL_PRINT_PORT      631
  --bind <addr>    Bind address        OSHAL_PRINT_BIND      0.0.0.0
  --dir <path>     Drop folder         OSHAL_PRINT_DROP_DIR  <home>/oshal-print-drop
  --max-mb <n>     Max job size (MB)   OSHAL_PRINT_MAX_MB    200
  --no-mdns        Disable discovery   OSHAL_PRINT_NO_MDNS   (unset)
  --help           This text
`;

/**
 * @description Read one --flag value from argv.
 * @param {string[]} argv The process arguments.
 * @param {string} flag The flag name including dashes.
 * @returns {string|undefined} The value following the flag.
 */
function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

/**
 * @description Resolve the effective configuration: flags > env > defaults.
 * @param {string[]} argv The process arguments.
 * @returns {object} The runtime configuration.
 */
function resolveConfig(argv) {
  const env = process.env;
  const printerName = argValue(argv, '--name') || env.OSHAL_PRINT_NAME || 'Oshal Print to File Printer';
  const hostname = os.hostname();
  const uuid = deriveUuid(`${hostname}/${printerName}`);
  return {
    printerName,
    printerInfo: 'oshal print-drop - print jobs are saved as files on the host',
    printerLocation: hostname,
    hostname,
    port: Number(argValue(argv, '--port') || env.OSHAL_PRINT_PORT || 631),
    bindAddress: argValue(argv, '--bind') || env.OSHAL_PRINT_BIND || '0.0.0.0',
    dropDir: path.resolve(argValue(argv, '--dir') || env.OSHAL_PRINT_DROP_DIR || path.join(os.homedir(), 'oshal-print-drop')),
    maxBytes: Number(argValue(argv, '--max-mb') || env.OSHAL_PRINT_MAX_MB || 200) * 1024 * 1024,
    mdns: !argv.includes('--no-mdns') && !env.OSHAL_PRINT_NO_MDNS,
    uuid,
    uuidUri: `urn:uuid:${uuid}`,
  };
}

/**
 * @description Deterministic RFC 4122-shaped UUID from a seed string, so the
 * printer keeps one identity across restarts without persisting state.
 * @param {string} seed The identity seed.
 * @returns {string} A stable UUID string.
 */
function deriveUuid(seed) {
  const hash = crypto.createHash('sha1').update(`oshal-print-drop:${seed}`).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    `8${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join('-');
}

/**
 * @description Print the human startup banner to stderr (stdout carries JSON logs).
 * @param {object} config The runtime configuration.
 * @param {number} port The actual bound port.
 * @returns {void}
 */
function printBanner(config, port) {
  const lines = [
    '',
    `  ${config.printerName}`,
    `  ${'-'.repeat(config.printerName.length)}`,
    `  Drop folder : ${config.dropDir}`,
    `  Endpoint    : http://${config.hostname}:${port}/ipp/print`,
    `  Status page : http://localhost:${port}/`,
    `  Discovery   : ${config.mdns ? 'mDNS (_ipp._tcp) - clients see the printer in Add Printer' : 'DISABLED - add by URL only'}`,
    '',
    '  Windows clients: Settings > Bluetooth & devices > Printers & scanners > Add device.',
    `  Manual add URL:  http://${config.hostname}:${port}/ipp/print`,
    '',
  ];
  process.stderr.write(`${lines.join('\n')}\n`);
}

/**
 * @description Boot the printer: ensure the drop folder, start the IPP server,
 * publish mDNS, and wire graceful shutdown.
 * @returns {Promise<void>} Resolves once listening.
 */
async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write(HELP);
    return;
  }
  const config = resolveConfig(argv);
  const log = createLogger('print-drop');
  fs.mkdirSync(config.dropDir, { recursive: true });
  const { server, state } = await startIppServer(config, log);
  const advertisement = config.mdns
    ? advertisePrinter({ printerName: config.printerName, port: state.port, hostname: config.hostname, uuid: config.uuid }, log)
    : { stop: async () => {} };
  log.info('printer ready', { name: config.printerName, port: state.port, dropDir: config.dropDir, mdns: config.mdns });
  printBanner(config, state.port);
  const shutdown = async (signal) => {
    log.info('shutting down', { signal });
    await advertisement.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  process.stderr.write(`oshal-print-drop failed to start: ${err.message}\n`);
  process.exitCode = 1;
});
