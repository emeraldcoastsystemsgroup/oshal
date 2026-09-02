#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — entrypoint: config (flags > env > defaults, nothing hardcoded in the runtime path), drop-folder creation, server + mDNS boot, human-readable startup banner on stderr (stdout is reserved for JSON logs so a service wrapper can capture them cleanly), graceful SIGINT/SIGTERM shutdown that withdraws the mDNS advertisement before exit. The printer UUID is derived deterministically from hostname + printer name so clients see the same printer identity across restarts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | LAN-interface pinning for the advertisement (--iface / OSHAL_PRINT_IFACE, else auto-detected via the UDP-connect route trick — no packet is sent). On multi-homed hosts (Wi-Fi + WSL/Docker vEthernet + hotspot) the mDNS library's default egress picked the virtual adapter, so responses never reached the physical LAN. The chosen address is logged and shown in the banner; detection failure falls back to the old all-interfaces behavior with a warning. A VPN holding the default route will be auto-picked — that is the --iface escape hatch.
 */
'use strict';

const crypto = require('crypto');
const dgram = require('dgram');
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
  --iface <ip>     LAN IPv4 for mDNS   OSHAL_PRINT_IFACE     auto (default-route address)
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
    interfaceAddress: argValue(argv, '--iface') || env.OSHAL_PRINT_IFACE || '',
    uuid,
    uuidUri: `urn:uuid:${uuid}`,
  };
}

/**
 * @description Detect the local IPv4 the OS would use for outbound traffic (the
 * default-route interface) via a connected UDP socket — no packet is sent.
 * Multi-homed hosts (WSL/Docker vEthernet, hotspot, link-local adapters) need
 * this so the mDNS advertisement egresses the real LAN, not a virtual switch.
 * @returns {Promise<string>} The address, or '' when no route is resolvable.
 */
function detectLanAddress() {
  return new Promise((resolve) => {
    const probe = dgram.createSocket('udp4');
    const finish = (address) => {
      try { probe.close(); } catch (_err) { /* already closed */ }
      resolve(address);
    };
    probe.on('error', () => finish(''));
    setTimeout(() => finish(''), 1000).unref();
    try {
      probe.connect(53, '8.8.8.8', () => {
        try { finish(probe.address().address); } catch (_err) { finish(''); }
      });
    } catch (_err) {
      finish('');
    }
  });
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
    `  Discovery   : ${config.mdns ? `mDNS (_ipp._tcp + _print subtype) via ${config.interfaceAddress || 'ALL interfaces (unpinned)'}` : 'DISABLED - add by URL only'}`,
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
  if (config.mdns && !config.interfaceAddress) {
    config.interfaceAddress = await detectLanAddress();
    if (!config.interfaceAddress) log.warn('could not detect the default-route address - advertising on all interfaces (multi-homed hosts may egress the wrong one; use --iface)');
  }
  const advertisement = config.mdns
    ? advertisePrinter(
        { printerName: config.printerName, port: state.port, hostname: config.hostname, uuid: config.uuid, interfaceAddress: config.interfaceAddress },
        log,
      )
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
