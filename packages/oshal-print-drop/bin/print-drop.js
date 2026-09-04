#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — entrypoint: config (flags > env > defaults, nothing hardcoded in the runtime path), drop-folder creation, server + mDNS boot, human-readable startup banner on stderr (stdout is reserved for JSON logs so a service wrapper can capture them cleanly), graceful SIGINT/SIGTERM shutdown that withdraws the mDNS advertisement before exit. The printer UUID is derived deterministically from hostname + printer name so clients see the same printer identity across restarts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | LAN-interface pinning for the advertisement (--iface / OSHAL_PRINT_IFACE, else auto-detected via the UDP-connect route trick — no packet is sent). On multi-homed hosts (Wi-Fi + WSL/Docker vEthernet + hotspot) the mDNS library's default egress picked the virtual adapter, so responses never reached the physical LAN. The chosen address is logged and shown in the banner; detection failure falls back to the old all-interfaces behavior with a warning. A VPN holding the default route will be auto-picked — that is the --iface escape hatch.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Banner prints the manual-add URL in IP form first (hostname second): a bare machine name only resolves on the remote side via NetBIOS/LLMNR/mDNS, all of which are unreliable cross-machine, and the operator hit exactly that. The IP is the detected LAN address the advertisement is pinned to, so the two always agree.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Second discovery rail: WSD (WS-Discovery on UDP 3702, IPv4+IPv6, plus /wsd/* SOAP endpoints on the existing HTTP port). This is how hardware printers stay discoverable on Windows machines whose native mDNS is dead (browser/Bonjour port theft on 5353 — both operator machines had it); Windows' WSD stack lives in svchost and keeps working. Disable with --no-wsd / OSHAL_PRINT_NO_WSD. Requires inbound UDP 3702 in the firewall (documented in README next to the existing rules).
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | --wsd-announce-sec / OSHAL_PRINT_WSD_ANNOUNCE_SEC (default 90, 0 disables): period of the WSD Hello re-announcement, the mechanism that lets client machines list the printer WITHOUT any client-side settings change — parity with hardware printers, which announce continuously rather than once at startup.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Deployment configuration file + explicit device identity. Precedence is now flag > env > print-drop.config.json (beside package.json, untracked) > default: flags and env only reach a process someone launches by hand, and the shipped startup task runs `node bin/print-drop.js` with no arguments, so a per-deployment setting such as the printer's display name had nowhere to live. The identity UUID also becomes a settable key: it is derived from hostname + printer name, so RENAMING THE PRINTER MINTS A NEW DEVICE and already-installed client queues point at an identity that no longer answers. Pinning `uuid` to the previous value keeps existing clients working across a rename. The shipped default name stays vendor-neutral — a deployment-specific name belongs in the deployment's config, never in the package default.
 */
'use strict';

const crypto = require('crypto');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startIppServer } = require('../lib/ipp-server');
const { DEFAULT_FORMATS } = require('../lib/printer-attributes');
const { deliverToSwarm, swarmTargetReady } = require('../lib/swarm-target');
const { advertisePrinter } = require('../lib/advertise');
const { startWsdDiscovery } = require('../lib/wsd/discovery');
const { createWsdHttpHandler } = require('../lib/wsd/http');
const { createLogger } = require('../lib/log');

const CONFIG_FILE = 'print-drop.config.json';
const DEFAULT_PRINTER_NAME = 'Oshal Print to File Printer';

const HELP = `oshal-print-drop - IPP virtual printer; print jobs land as files in a drop folder.

Settings resolve flag > env > ${CONFIG_FILE} (beside package.json) > default.
The config file is how the startup task picks up deployment settings.

Options:
  --name <text>    Printer name        OSHAL_PRINT_NAME      "Oshal Print to File Printer"
  --port <n>       TCP port            OSHAL_PRINT_PORT      631
  --bind <addr>    Bind address        OSHAL_PRINT_BIND      0.0.0.0
  --dir <path>     Drop folder         OSHAL_PRINT_DROP_DIR  <home>/oshal-print-drop
  --max-mb <n>     Max job size (MB)   OSHAL_PRINT_MAX_MB    200
  --iface <ip>     LAN IPv4 for mDNS   OSHAL_PRINT_IFACE     auto (default-route address)
  --no-mdns        Disable mDNS        OSHAL_PRINT_NO_MDNS   (unset)
  --no-wsd         Disable WSD         OSHAL_PRINT_NO_WSD    (unset)
  --wsd-announce-sec <n>  WSD Hello re-announce period, 0 = off
                                       OSHAL_PRINT_WSD_ANNOUNCE_SEC  90
  --target <what>  folder | swarm      OSHAL_PRINT_TARGET    folder
                   'swarm' makes this a PRINT-TO-RAG printer: the document goes
                   straight to the swarm's print inbox. The printing machine needs
                   no credential and no software - this process holds the token.
  --intake-url <u> Swarm print intake  OSHAL_PRINT_INTAKE_URL
                   e.g. http://<swarm>:35457/api/print-ingest/documents
                   Credential comes from OSHAL_PRINT_INTAKE_TOKEN (env only).
  --uuid <uuid>    Device identity     OSHAL_PRINT_UUID      derived from host + name
                   Pin this when renaming the printer, or installed client
                   queues will point at an identity that no longer answers.
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
 * @description Read the optional deployment config file that sits beside
 * package.json. It is how a machine-specific setting (the display name, a
 * pinned identity) reaches the shipped startup task, which runs the entrypoint
 * with no arguments. Absent file = no settings; malformed file warns and is
 * ignored rather than blocking the printer from starting.
 * @returns {object} The parsed settings, {} when absent or unreadable.
 */
function loadFileConfig() {
  const configPath = path.join(__dirname, '..', CONFIG_FILE);
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) || {};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write(`  WARNING: ignoring ${CONFIG_FILE} - ${err.message}\n`);
    }
    return {};
  }
}

/**
 * @description Normalize the advertised document formats from a comma-separated
 * string (flag/env) or an array (config file). The first entry becomes the
 * advertised default, which is the one clients actually honour.
 * @param {string|string[]} value The configured value.
 * @returns {string[]} A non-empty list of MIME types.
 */
function parseFormats(value) {
  const list = (Array.isArray(value) ? value : String(value).split(','))
    .map((f) => String(f).trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : DEFAULT_FORMATS;
}

/**
 * @description Resolve one setting by the project's precedence rule:
 * command-line flag, then environment variable, then config file, then default.
 * @param {string[]} argv The process arguments.
 * @param {object} file The parsed config file.
 * @param {{flag:string,env:string,key:string,fallback:*}} spec Where to look.
 * @returns {*} The effective value.
 */
function setting(argv, file, spec) {
  const fromFlag = argValue(argv, spec.flag);
  if (fromFlag !== undefined) return fromFlag;
  if (process.env[spec.env] !== undefined && process.env[spec.env] !== '') return process.env[spec.env];
  if (file[spec.key] !== undefined && file[spec.key] !== '') return file[spec.key];
  return spec.fallback;
}

/**
 * @description Resolve the effective configuration: flags > env > defaults.
 * @param {string[]} argv The process arguments.
 * @returns {object} The runtime configuration.
 */
function resolveConfig(argv) {
  const env = process.env;
  const file = loadFileConfig();
  const pick = (flag, envName, key, fallback) => setting(argv, file, { flag, env: envName, key, fallback });
  const printerName = pick('--name', 'OSHAL_PRINT_NAME', 'name', DEFAULT_PRINTER_NAME);
  // Only a flag or env names THIS instance. A name in the config file is the
  // deployment's default for the file printer, and a second printer started from
  // the same directory must not silently inherit its name - or, worse, its pinned
  // identity, which would put two printers on one UUID.
  const chosenHere = (flag, envName) => argValue(argv, flag) !== undefined
    || (env[envName] !== undefined && env[envName] !== '');
  const nameWasExplicit = chosenHere('--name', 'OSHAL_PRINT_NAME');
  const uuidWasExplicit = chosenHere('--uuid', 'OSHAL_PRINT_UUID');
  const hostname = os.hostname();
  // Identity follows the name unless pinned - see the header note on renames.
  const uuid = String(pick('--uuid', 'OSHAL_PRINT_UUID', 'uuid', deriveUuid(`${hostname}/${printerName}`))).toLowerCase();
  return {
    printerName,
    nameWasExplicit,
    uuidWasExplicit,
    printerInfo: 'oshal print-drop - print jobs are saved as files on the host',
    printerLocation: hostname,
    hostname,
    port: Number(pick('--port', 'OSHAL_PRINT_PORT', 'port', 631)),
    bindAddress: pick('--bind', 'OSHAL_PRINT_BIND', 'bind', '0.0.0.0'),
    dropDir: path.resolve(pick('--dir', 'OSHAL_PRINT_DROP_DIR', 'dropDir', path.join(os.homedir(), 'oshal-print-drop'))),
    maxBytes: Number(pick('--max-mb', 'OSHAL_PRINT_MAX_MB', 'maxMb', 200)) * 1024 * 1024,
    mdns: !argv.includes('--no-mdns') && !env.OSHAL_PRINT_NO_MDNS && file.mdns !== false,
    wsd: !argv.includes('--no-wsd') && !env.OSHAL_PRINT_NO_WSD && file.wsd !== false,
    wsdAnnounceSec: Number(pick('--wsd-announce-sec', 'OSHAL_PRINT_WSD_ANNOUNCE_SEC', 'wsdAnnounceSec', 90)),
    formats: parseFormats(pick('--formats', 'OSHAL_PRINT_FORMATS', 'formats', DEFAULT_FORMATS)),
    target: String(pick('--target', 'OSHAL_PRINT_TARGET', 'target', 'folder')).trim().toLowerCase(),
    intakeUrl: String(pick('--intake-url', 'OSHAL_PRINT_INTAKE_URL', 'intakeUrl', '')).trim(),
    // Credential: env first. A token in a config file is a token in a backup.
    intakeToken: String(env.OSHAL_PRINT_INTAKE_TOKEN || file.intakeToken || '').trim(),
    deleteAfterDelivery: file.deleteAfterDelivery !== false,
    interfaceAddress: pick('--iface', 'OSHAL_PRINT_IFACE', 'iface', ''),
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
  const host = config.interfaceAddress || config.hostname;
  const lines = [
    '',
    `  ${config.printerName}`,
    `  ${'-'.repeat(config.printerName.length)}`,
    `  Drop folder : ${config.dropDir}`,
    `  Endpoint    : http://${host}:${port}/ipp/print`,
    `  Status page : http://localhost:${port}/`,
    `  Discovery   : ${[config.mdns ? `mDNS via ${config.interfaceAddress || 'ALL interfaces'}` : null, config.wsd ? 'WSD (the protocol hardware printers use)' : null].filter(Boolean).join(' + ') || 'DISABLED - add by URL only'}`,
    '',
    '  Windows clients: Settings > Bluetooth & devices > Printers & scanners > Add device.',
    `  Manual add URL:  http://${host}:${port}/ipp/print${config.interfaceAddress ? `  (or http://${config.hostname}:${port}/ipp/print)` : ''}`,
    '',
  ];
  process.stderr.write(`${lines.join('\n')}\n`);
}


/**
 * @description Finish configuring a print-to-rag printer. The name carries the
 * address on purpose (operator's shape: "oshal print to rag - <ip>"): discovery
 * does not cross networks, so a machine reaching this over an overlay adds it by
 * address, and the name is where that address is written down. A swarm target
 * that is not fully configured REFUSES TO START rather than quietly behaving as
 * a folder printer - a printer that keeps documents locally while the operator
 * believes they reach the swarm is the failure worth being loud about.
 * @param {object} config The resolved configuration (mutated in place).
 * @param {object} log The logger.
 * @returns {void}
 */
function applySwarmTarget(config, log) {
  if (config.target !== 'swarm') return;
  const ready = swarmTargetReady(config);
  if (!ready.ok) {
    throw new Error(`--target swarm needs a complete destination: ${ready.reason}`);
  }
  if (!config.nameWasExplicit) {
    const where = config.interfaceAddress || config.hostname;
    config.printerName = `oshal print to rag - ${where}`;
  }
  // A renamed printer is a DIFFERENT device. Re-derive unless this instance was
  // given an identity of its own, so it can never collide with the file printer's.
  if (!config.uuidWasExplicit) {
    config.uuid = deriveUuid(`${config.hostname}/${config.printerName}`);
    config.uuidUri = `urn:uuid:${config.uuid}`;
  }
  config.printerInfo = 'oshal print to rag - printed documents go to the swarm inbox for approval';
  log.info('print-to-rag target', { name: config.printerName, intakeUrl: config.intakeUrl });
}

/**
 * @description Build the post-spool delivery hook, or null for a folder printer.
 * Delivery sends the RECOVERED TEXT, never the binary, so the swarm never parses
 * an untrusted document. A delivered document's local copy is removed; a failed
 * one is KEPT and logged, because losing a document to a swarm outage would be
 * the one unrecoverable outcome here.
 * @param {object} config The resolved configuration.
 * @param {object} log The logger.
 * @returns {((result:object)=>Promise<void>)|null} The hook, or null.
 */
function buildDeliver(config, log) {
  if (config.target !== 'swarm') return null;
  return async (result) => {
    const sidecarPath = `${result.filePath}.json`;
    let sidecar = {};
    try { sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')); } catch (err) { /* bounded below */ }
    const textPath = sidecar.textFile ? path.join(path.dirname(result.filePath), sidecar.textFile) : null;
    let text = '';
    if (textPath && fs.existsSync(textPath)) text = fs.readFileSync(textPath, 'utf8');
    if (!text.trim()) {
      log.warn('not delivered - no recoverable text in this document', {
        file: result.filePath, reason: sidecar.textError || 'the format carries no text layer',
      });
      return;
    }
    const outcome = await deliverToSwarm(config, { text, sidecar });
    if (!outcome.ok) {
      log.error('swarm delivery failed - the document is kept locally for retry', {
        file: result.filePath, reason: outcome.reason,
      });
      return;
    }
    log.info('delivered to the swarm print inbox', {
      intakeId: outcome.intakeId, duplicate: outcome.duplicate, chars: text.length,
    });
    if (!config.deleteAfterDelivery) return;
    for (const p of [result.filePath, sidecarPath, textPath]) {
      if (p) { try { fs.rmSync(p, { force: true }); } catch (err) { /* keeping it is harmless */ } }
    }
  };
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
  if ((config.mdns || config.wsd) && !config.interfaceAddress) {
    config.interfaceAddress = await detectLanAddress();
    if (!config.interfaceAddress) log.warn('could not detect the default-route address - advertising on all interfaces (multi-homed hosts may egress the wrong one; use --iface)');
  }
  applySwarmTarget(config, log);
  const { server, state, ctx } = await startIppServer(config, log);
  ctx.deliver = buildDeliver(config, log);
  const advertisement = config.mdns
    ? advertisePrinter(
        { printerName: config.printerName, port: state.port, hostname: config.hostname, uuid: config.uuid, interfaceAddress: config.interfaceAddress },
        log,
      )
    : { stop: async () => {} };
  let wsdDiscovery = { stop: async () => {} };
  if (config.wsd) {
    const baseUrl = `http://${config.interfaceAddress || config.hostname}:${state.port}`;
    ctx.extraRoutes.push({
      prefix: '/wsd/',
      handler: createWsdHttpHandler({
        friendlyName: config.printerName,
        location: config.printerLocation,
        uuidUri: config.uuidUri,
        baseUrl,
        dropDir: config.dropDir,
        maxBytes: config.maxBytes,
        deliver: ctx.deliver,
        log,
      }),
    });
    wsdDiscovery = await startWsdDiscovery(
      { uuidUri: config.uuidUri, xaddrs: `${baseUrl}/wsd/device`, interfaceAddress: config.interfaceAddress },
      log,
      undefined,
      config.wsdAnnounceSec * 1000,
    );
  }
  log.info('printer ready', { name: config.printerName, port: state.port, dropDir: config.dropDir, mdns: config.mdns, wsd: config.wsd });
  printBanner(config, state.port);
  const shutdown = async (signal) => {
    log.info('shutting down', { signal });
    await advertisement.stop();
    await wsdDiscovery.stop();
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
