/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — `npm run diagnose`: one command that runs every health check this project's live debugging needed by hand, in order of the actual failure chain: config/interface detection, the IPP endpoint answering a real Get-Printer-Attributes on loopback, the three firewall rules, the active network profile (Public silently kills the Private-scoped rules), whether WINDOWS' own mDNS listener is alive (svchost on 5353 — browsers/Bonjour steal it, which blocks THIS machine's ability to discover mDNS printers), a real _print-subtype mDNS browse for our advertisement, and a real WSD multicast probe answered by our responder. Read-only; PowerShell is spawned only for firewall/socket queries.
 */
'use strict';

const dgram = require('dgram');
const { execFile } = require('child_process');
const codec = require('../lib/ipp-codec');

const PORT = Number(process.env.OSHAL_PRINT_PORT || 631);
const NAME = process.env.OSHAL_PRINT_NAME || 'Oshal Print to File Printer';
const results = [];

/**
 * @description Record and print one check result.
 * @param {string} status PASS | WARN | FAIL.
 * @param {string} name The check name.
 * @param {string} detail Human explanation.
 * @returns {void}
 */
function report(status, name, detail) {
  results.push({ status, name, detail });
  const pad = status.padEnd(4);
  process.stdout.write(`  [${pad}] ${name}: ${detail}\n`);
}

/**
 * @description Run a PowerShell one-liner and resolve its stdout ('' on failure).
 * @param {string} command The PowerShell command.
 * @returns {Promise<string>} Trimmed stdout.
 */
function powershell(command) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', command], { timeout: 20000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout).trim());
    });
  });
}

/**
 * @description Detect the default-route IPv4 via a connected UDP socket (no packet sent).
 * @returns {Promise<string>} The address or ''.
 */
function detectLanAddress() {
  return new Promise((resolve) => {
    const probe = dgram.createSocket('udp4');
    const finish = (address) => {
      try { probe.close(); } catch (_e) { /* closed */ }
      resolve(address);
    };
    probe.on('error', () => finish(''));
    setTimeout(() => finish(''), 1500).unref();
    try {
      probe.connect(53, '8.8.8.8', () => {
        try { finish(probe.address().address); } catch (_e) { finish(''); }
      });
    } catch (_e) { finish(''); }
  });
}

/**
 * @description Check the IPP endpoint with a real Get-Printer-Attributes round trip.
 * @returns {Promise<void>} Resolves when reported.
 */
async function checkIppEndpoint() {
  const body = codec.encodeMessage({
    versionMajor: 2, versionMinor: 0, operationId: codec.OPERATION.GET_PRINTER_ATTRIBUTES, requestId: 1,
    groups: [{ tag: codec.DELIMITER.OPERATION_ATTRIBUTES, attributes: [
      { tag: codec.VALUE.CHARSET, name: 'attributes-charset', values: ['utf-8'] },
      { tag: codec.VALUE.NATURAL_LANGUAGE, name: 'attributes-natural-language', values: ['en'] },
      { tag: codec.VALUE.URI, name: 'printer-uri', values: [`ipp://127.0.0.1:${PORT}/ipp/print`] },
    ] }],
  });
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/ipp/print`, {
      method: 'POST', headers: { 'content-type': 'application/ipp' }, body, signal: AbortSignal.timeout(5000),
    });
    const msg = codec.decodeMessage(Buffer.from(await res.arrayBuffer()));
    const printerName = msg && codec.attributeValue(msg, codec.DELIMITER.PRINTER_ATTRIBUTES, 'printer-name', '');
    if (msg && msg.operationId === codec.STATUS.OK && printerName) {
      report('PASS', 'IPP endpoint', `answering on :${PORT} as "${printerName}"`);
    } else {
      report('FAIL', 'IPP endpoint', `unexpected IPP answer (status 0x${msg ? msg.operationId.toString(16) : '????'})`);
    }
  } catch (err) {
    report('FAIL', 'IPP endpoint', `no server on 127.0.0.1:${PORT} (${err.message}) - is print-drop running?`);
  }
}

/**
 * @description Check the three inbound firewall rules exist and are enabled.
 * @returns {Promise<void>} Resolves when reported.
 */
async function checkFirewall() {
  const out = await powershell("Get-NetFirewallRule -DisplayName 'oshal print-drop*' -ErrorAction SilentlyContinue | ForEach-Object { $_.DisplayName + '|' + $_.Enabled }");
  const rules = out ? out.split(/\r?\n/).filter(Boolean) : [];
  const enabled = rules.filter((r) => r.endsWith('|True')).length;
  if (enabled >= 3) report('PASS', 'firewall rules', `${enabled} oshal print-drop rules enabled (IPP/mDNS/WSD)`);
  else if (rules.length) report('WARN', 'firewall rules', `only ${enabled} enabled of: ${rules.join(', ')} - see README firewall section`);
  else report('FAIL', 'firewall rules', 'no "oshal print-drop" inbound rules found - clients cannot reach this machine (README: Windows host setup)');
}

/**
 * @description Check the active network profile: Private is required for the rules to apply.
 * @returns {Promise<void>} Resolves when reported.
 */
async function checkNetworkProfile() {
  const out = await powershell('Get-NetConnectionProfile | ForEach-Object { $_.Name + "|" + $_.NetworkCategory }');
  if (!out) return report('WARN', 'network profile', 'could not query profiles');
  const rows = out.split(/\r?\n/).filter(Boolean);
  const publicRows = rows.filter((r) => r.endsWith('|Public'));
  if (publicRows.length) report('WARN', 'network profile', `${publicRows.join(', ')} is PUBLIC - Private-scoped rules are inert there; set the LAN to Private`);
  else report('PASS', 'network profile', rows.join(', '));
  return undefined;
}

/**
 * @description Check whether Windows' own mDNS listener holds UDP 5353 (svchost).
 * Its absence means THIS machine cannot discover mDNS printers in Settings.
 * @returns {Promise<void>} Resolves when reported.
 */
async function checkWindowsMdns() {
  const out = await powershell("Get-NetUDPEndpoint -LocalPort 5353 -ErrorAction SilentlyContinue | ForEach-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName } | Sort-Object -Unique");
  const owners = out ? out.split(/\r?\n/).filter(Boolean) : [];
  if (owners.includes('svchost')) report('PASS', 'Windows mDNS listener', `alive (5353 held by: ${owners.join(', ')})`);
  else if (owners.length) report('WARN', 'Windows mDNS listener', `DEAD - 5353 squatted by ${owners.join(', ')} (Chrome/Apple steal it): this machine cannot discover mDNS printers itself; a REBOOT restores it. Other machines are unaffected.`);
  else report('WARN', 'Windows mDNS listener', 'nothing bound on 5353 - Windows mDNS appears inactive');
}

/**
 * @description Browse the _print subtype of _ipp._tcp for our advertisement.
 * @param {string} iface The pinned interface address ('' = unpinned).
 * @returns {Promise<void>} Resolves when reported.
 */
function checkMdnsAdvertisement(iface) {
  return new Promise((resolve) => {
    let Bonjour;
    try { ({ Bonjour } = require('bonjour-service')); } catch (err) {
      report('WARN', 'mDNS advertisement', `bonjour-service unavailable (${err.message})`);
      return resolve();
    }
    const browser = new Bonjour(iface ? { interface: iface, bind: '0.0.0.0' } : undefined, () => {});
    const timer = setTimeout(() => {
      browser.destroy();
      report('WARN', 'mDNS advertisement', `"${NAME}" not seen on _print._sub._ipp._tcp within 6s (server down, --no-mdns, or multicast blocked)`);
      resolve();
    }, 6000);
    browser.find({ type: 'ipp', subtypes: ['print'] }, (svc) => {
      if (svc.name !== NAME) return;
      clearTimeout(timer);
      browser.destroy();
      report('PASS', 'mDNS advertisement', `"${NAME}" answers the subtype browse (port ${svc.port})`);
      resolve();
    });
    return undefined;
  });
}

/**
 * @description Send a real WSD multicast Probe and expect our responder's answer.
 * @param {string} iface The egress interface address ('' = default).
 * @returns {Promise<void>} Resolves when reported.
 */
function checkWsdAdvertisement(iface) {
  return new Promise((resolve) => {
    const probe = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:wsd="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:wprt="http://schemas.microsoft.com/windows/2006/08/wdp/print"><soap:Header><wsa:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</wsa:To><wsa:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</wsa:Action><wsa:MessageID>urn:uuid:diagnose-probe</wsa:MessageID></soap:Header><soap:Body><wsd:Probe><wsd:Types>wprt:PrintDeviceType</wsd:Types></wsd:Probe></soap:Body></soap:Envelope>`;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;
    const finish = (status, detail) => {
      if (done) return;
      done = true;
      try { sock.close(); } catch (_e) { /* closed */ }
      report(status, 'WSD advertisement', detail);
      resolve();
    };
    setTimeout(() => finish('WARN', `no ProbeMatch for :${PORT}/wsd/device within 6s (server down, --no-wsd, or multicast blocked)`), 6000);
    sock.on('error', (err) => finish('WARN', `probe socket error: ${err.message}`));
    sock.on('message', (msg) => {
      const text = msg.toString('utf8');
      if (text.includes('ProbeMatches') && text.includes(`:${PORT}/wsd/device`)) {
        finish('PASS', `responder answers print-typed probes (XAddrs :${PORT}/wsd/device)`);
      }
    });
    sock.bind(0, iface || undefined, () => {
      try { if (iface) sock.setMulticastInterface(iface); } catch (_e) { /* best effort */ }
      const buf = Buffer.from(probe);
      sock.send(buf, 0, buf.length, 3702, '239.255.255.250');
    });
  });
}

/**
 * @description Run all checks in failure-chain order and exit non-zero on FAIL.
 * @returns {Promise<void>} Resolves when done.
 */
async function main() {
  process.stdout.write(`oshal print-drop doctor - checking "${NAME}" on port ${PORT}\n\n`);
  const iface = await detectLanAddress();
  if (iface) report('PASS', 'LAN interface', `default route via ${iface}`);
  else report('WARN', 'LAN interface', 'no default-route address detected (offline? VPN?) - advertisements may pick a wrong adapter');
  await checkIppEndpoint();
  await checkFirewall();
  await checkNetworkProfile();
  await checkWindowsMdns();
  await checkMdnsAdvertisement(iface);
  await checkWsdAdvertisement(iface);
  const fails = results.filter((r) => r.status === 'FAIL').length;
  const warns = results.filter((r) => r.status === 'WARN').length;
  process.stdout.write(`\n${fails} failure(s), ${warns} warning(s). Full setup guide: README.md\n`);
  process.exitCode = fails ? 1 : 0;
}

main().catch((err) => {
  process.stderr.write(`diagnose crashed: ${err.stack}\n`);
  process.exitCode = 1;
});
