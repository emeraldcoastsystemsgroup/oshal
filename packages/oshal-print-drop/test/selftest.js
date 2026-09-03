/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — protocol-level self-test against a REAL server instance over loopback HTTP (no mocked boundary): boots the IPP server on an ephemeral port with a temp drop folder and drives it with wire-encoded IPP requests the way a client driver would. Covers the driverless-install handshake (Get-Printer-Attributes + requested-attributes filtering), Print-Job and Create-Job/Send-Document round trips landing real files with sidecar metadata, hostile job-name sanitization staying inside the drop folder, Get-Jobs/Get-Job-Attributes/Cancel-Job, the unsupported-operation answer, the oversized-job byte cap, and malformed-body rejection. Run with `npm test`; exits non-zero on any failure. mDNS discovery is NOT covered here — it needs a second machine on the LAN (see README).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the Windows-discovery fix: a REAL mDNS round trip — publish via advertisePrinter under a unique test name, then browse _print._sub._ipp._tcp (the subtype IPP Everywhere requires and Windows actually queries) and require the advertisement to answer. Would go red if the subtype ever regressed to a bare _ipp._tcp advertisement. Fails loudly (never skips) when mDNS itself is unavailable — a VPN or isolated network is exactly the condition the operator needs to hear about.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | WSD guard (suite 8): a Windows-shaped Probe over real UDP must come back as ProbeMatches carrying our endpoint urn and XAddrs (on an alternate port — 3702 is shared with the OS WSD service, and unicast test probes would race it); WS-Transfer Get must serve metadata with the FriendlyName; an MTOM SendDocument with a binary part must land a real file through the shared spooler.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the metadata-conformance fixes (Windows looped on Transfer Get): the Get response must carry Content-Length (never chunked — WSDAPI's HTTP client mishandles it), a well-formed http-shaped ServiceId ending /PrintService (the previous urn:uuid/path was invalid), and a PNPX HardwareId.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Install-chain guard: SetEventRate (the call the live Add-device walk died on) must answer with its wprt response element, not the generic empty envelope.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Driver-binding guard: GetPrinterElements' DeviceId must carry CID:MS_IPP_PREF — the field Windows turns into the 1284_CID_MS_IPP_PREF hardware id that binds the inbox Microsoft IPP Class Driver (prnms012.inf) to a WSD-discovered queue. Without it the queue installs as "Driver is unavailable".
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const codec = require('../lib/ipp-codec');
const { startIppServer } = require('../lib/ipp-server');
const { createLogger } = require('../lib/log');

const { DELIMITER, VALUE, OPERATION, STATUS } = codec;
const quietLog = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * @description Build the base configuration for a test server instance.
 * @param {string} dropDir The temp drop folder.
 * @param {number} maxBytes The job byte cap.
 * @returns {object} A server configuration.
 */
function testConfig(dropDir, maxBytes) {
  return {
    printerName: 'Oshal Print to File Printer',
    printerInfo: 'test instance',
    printerLocation: 'selftest',
    hostname: '127.0.0.1',
    port: 0,
    bindAddress: '127.0.0.1',
    dropDir,
    maxBytes,
    uuidUri: 'urn:uuid:00000000-0000-5000-8000-000000000001',
  };
}

/**
 * @description Send one wire-encoded IPP request and decode the response.
 * @param {number} port The server port.
 * @param {number} operationId The IPP operation.
 * @param {Array} extraOperationAttributes Attributes after charset/language.
 * @param {Buffer} [data] Document bytes for Print-Job / Send-Document.
 * @returns {Promise<object>} The decoded response message.
 */
async function ipp(port, operationId, extraOperationAttributes, data) {
  const body = codec.encodeMessage({
    versionMajor: 2,
    versionMinor: 0,
    operationId,
    requestId: 42,
    groups: [
      {
        tag: DELIMITER.OPERATION_ATTRIBUTES,
        attributes: [
          { tag: VALUE.CHARSET, name: 'attributes-charset', values: ['utf-8'] },
          { tag: VALUE.NATURAL_LANGUAGE, name: 'attributes-natural-language', values: ['en'] },
          { tag: VALUE.URI, name: 'printer-uri', values: [`ipp://127.0.0.1:${port}/ipp/print`] },
          ...extraOperationAttributes,
        ],
      },
    ],
    data,
  });
  const res = await fetch(`http://127.0.0.1:${port}/ipp/print`, {
    method: 'POST',
    headers: { 'content-type': 'application/ipp' },
    body,
  });
  assert.strictEqual(res.status, 200, 'IPP endpoint must answer HTTP 200');
  const msg = codec.decodeMessage(Buffer.from(await res.arrayBuffer()));
  assert.ok(msg, 'response must decode');
  return msg;
}

/**
 * @description The driverless-install handshake: capabilities and the filter.
 * @param {number} port The server port.
 * @returns {Promise<void>} Resolves when asserted.
 */
async function testGetPrinterAttributes(port) {
  const full = await ipp(port, OPERATION.GET_PRINTER_ATTRIBUTES, []);
  assert.strictEqual(full.operationId, STATUS.OK);
  assert.strictEqual(codec.attributeValue(full, DELIMITER.PRINTER_ATTRIBUTES, 'printer-name'), 'Oshal Print to File Printer');
  const formats = codec.attributeValues(full, DELIMITER.PRINTER_ATTRIBUTES, 'document-format-supported');
  assert.ok(formats.includes('application/pdf'), 'must advertise PDF so clients transcode');
  const ops = codec.attributeValues(full, DELIMITER.PRINTER_ATTRIBUTES, 'operations-supported');
  assert.ok(ops.includes(OPERATION.PRINT_JOB) && ops.includes(OPERATION.GET_PRINTER_ATTRIBUTES));
  assert.strictEqual(codec.attributeValue(full, DELIMITER.PRINTER_ATTRIBUTES, 'printer-is-accepting-jobs'), true);
  const filtered = await ipp(port, OPERATION.GET_PRINTER_ATTRIBUTES, [
    { tag: VALUE.KEYWORD, name: 'requested-attributes', values: ['printer-name'] },
  ]);
  assert.ok(codec.findAttribute(filtered, DELIMITER.PRINTER_ATTRIBUTES, 'printer-name'), 'requested attribute present');
  assert.strictEqual(codec.findAttribute(filtered, DELIMITER.PRINTER_ATTRIBUTES, 'media-supported'), null, 'unrequested attribute filtered out');
}

/**
 * @description Print-Job with a hostile job name lands a real PDF + sidecar in the drop folder.
 * @param {number} port The server port.
 * @param {string} dropDir The drop folder.
 * @returns {Promise<void>} Resolves when asserted.
 */
async function testPrintJob(port, dropDir) {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  const msg = await ipp(
    port,
    OPERATION.PRINT_JOB,
    [
      { tag: VALUE.NAME, name: 'job-name', values: ['Quarterly: ../../evil<script>name'] },
      { tag: VALUE.NAME, name: 'requesting-user-name', values: ['selftest-user'] },
      { tag: VALUE.MIME_MEDIA_TYPE, name: 'document-format', values: ['application/pdf'] },
    ],
    pdf,
  );
  assert.strictEqual(msg.operationId, STATUS.OK, 'Print-Job must succeed');
  assert.ok(codec.attributeValue(msg, DELIMITER.JOB_ATTRIBUTES, 'job-id') >= 1);
  assert.strictEqual(codec.attributeValue(msg, DELIMITER.JOB_ATTRIBUTES, 'job-state'), 9, 'job completed');
  const saved = fs.readdirSync(dropDir).filter((f) => f.endsWith('.pdf'));
  assert.strictEqual(saved.length, 1, 'exactly one PDF saved');
  assert.strictEqual(path.dirname(path.resolve(dropDir, saved[0])), path.resolve(dropDir), 'file stays inside the drop folder');
  assert.ok(!saved[0].includes('..'), 'no traversal fragments in the filename');
  assert.deepStrictEqual(fs.readFileSync(path.join(dropDir, saved[0])), pdf, 'bytes intact');
  const sidecar = JSON.parse(fs.readFileSync(path.join(dropDir, `${saved[0]}.json`), 'utf8'));
  assert.strictEqual(sidecar.requestingUser, 'selftest-user');
  assert.strictEqual(sidecar.bytes, pdf.length);
}

/**
 * @description Create-Job + Send-Document round trip; extension comes from sniffing.
 * @param {number} port The server port.
 * @param {string} dropDir The drop folder.
 * @returns {Promise<void>} Resolves when asserted.
 */
async function testCreateSendDocument(port, dropDir) {
  const created = await ipp(port, OPERATION.CREATE_JOB, [
    { tag: VALUE.NAME, name: 'job-name', values: ['two-phase job'] },
  ]);
  assert.strictEqual(created.operationId, STATUS.OK);
  const jobId = codec.attributeValue(created, DELIMITER.JOB_ATTRIBUTES, 'job-id');
  assert.strictEqual(codec.attributeValue(created, DELIMITER.JOB_ATTRIBUTES, 'job-state'), 3, 'pending until data arrives');
  const ps = Buffer.from('%!PS-Adobe-3.0\nshowpage\n');
  const sent = await ipp(
    port,
    OPERATION.SEND_DOCUMENT,
    [
      { tag: VALUE.INTEGER, name: 'job-id', values: [jobId] },
      { tag: VALUE.BOOLEAN, name: 'last-document', values: [true] },
    ],
    ps,
  );
  assert.strictEqual(sent.operationId, STATUS.OK);
  assert.strictEqual(codec.attributeValue(sent, DELIMITER.JOB_ATTRIBUTES, 'job-state'), 9);
  const saved = fs.readdirSync(dropDir).filter((f) => f.endsWith('.ps'));
  assert.strictEqual(saved.length, 1, 'PostScript sniffed to .ps');
  return jobId;
}

/**
 * @description Job queries and the cancel-after-completion refusal.
 * @param {number} port The server port.
 * @returns {Promise<void>} Resolves when asserted.
 */
async function testJobQueries(port) {
  const completed = await ipp(port, OPERATION.GET_JOBS, [
    { tag: VALUE.KEYWORD, name: 'which-jobs', values: ['completed'] },
  ]);
  assert.strictEqual(completed.operationId, STATUS.OK);
  const jobGroups = completed.groups.filter((g) => g.tag === DELIMITER.JOB_ATTRIBUTES);
  assert.ok(jobGroups.length >= 2, 'both finished jobs listed');
  const one = await ipp(port, OPERATION.GET_JOB_ATTRIBUTES, [{ tag: VALUE.INTEGER, name: 'job-id', values: [1] }]);
  assert.strictEqual(one.operationId, STATUS.OK);
  assert.strictEqual(codec.attributeValue(one, DELIMITER.JOB_ATTRIBUTES, 'job-state'), 9);
  const cancel = await ipp(port, OPERATION.CANCEL_JOB, [{ tag: VALUE.INTEGER, name: 'job-id', values: [1] }]);
  assert.strictEqual(cancel.operationId, STATUS.NOT_POSSIBLE, 'completed jobs refuse cancel');
  const missing = await ipp(port, OPERATION.GET_JOB_ATTRIBUTES, [{ tag: VALUE.INTEGER, name: 'job-id', values: [9999] }]);
  assert.strictEqual(missing.operationId, STATUS.NOT_FOUND);
}

/**
 * @description Unsupported operations answer 0x0501; garbage answers HTTP 400.
 * @param {number} port The server port.
 * @returns {Promise<void>} Resolves when asserted.
 */
async function testRejections(port) {
  const unknown = await ipp(port, 0x0010, []);
  assert.strictEqual(unknown.operationId, STATUS.OPERATION_NOT_SUPPORTED);
  const garbage = await fetch(`http://127.0.0.1:${port}/ipp/print`, {
    method: 'POST',
    headers: { 'content-type': 'application/ipp' },
    body: Buffer.from([0x02, 0x00]),
  });
  assert.strictEqual(garbage.status, 400, 'malformed body rejected at HTTP level');
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.strictEqual(page.status, 200);
  assert.ok((await page.text()).includes('Oshal Print to File Printer'), 'status page names the printer');
}

/**
 * @description A job over the byte cap is refused with request-entity-too-large
 * and leaves nothing (not even a .part) in the drop folder.
 * @returns {Promise<void>} Resolves when asserted.
 */
async function testByteCap() {
  const dropDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-print-cap-'));
  const { server, state } = await startIppServer(testConfig(dropDir, 1024), quietLog);
  try {
    const big = Buffer.alloc(8 * 1024, 0x41);
    const msg = await ipp(state.port, OPERATION.PRINT_JOB, [
      { tag: VALUE.NAME, name: 'job-name', values: ['too big'] },
    ], big);
    assert.strictEqual(msg.operationId, STATUS.REQUEST_ENTITY_TOO_LARGE);
    assert.deepStrictEqual(fs.readdirSync(dropDir), [], 'nothing left behind');
  } finally {
    server.close();
    fs.rmSync(dropDir, { recursive: true, force: true });
  }
}

/**
 * @description The advertisement must answer a browse for the _print subtype of
 * _ipp._tcp — the query Windows' Add-Printer discovery actually sends. Real
 * multicast round trip on this host; fails loudly when mDNS is unavailable.
 * @returns {Promise<void>} Resolves when the subtype browse finds the printer.
 */
async function testSubtypeAdvertisement() {
  const { advertisePrinter } = require('../lib/advertise');
  const { Bonjour } = require('bonjour-service');
  const name = `Oshal Print Drop Selftest ${process.pid}`;
  const advertisement = advertisePrinter(
    { printerName: name, port: 63631, hostname: '127.0.0.1', uuid: '00000000-0000-5000-8000-000000000002' },
    quietLog,
  );
  try {
    await new Promise((resolve, reject) => {
      const browserInstance = new Bonjour();
      const timer = setTimeout(() => {
        browserInstance.destroy();
        reject(new Error(`_print._sub._ipp._tcp browse did not find "${name}" within 10s - mDNS blocked (VPN / isolated network / 5353 contention)?`));
      }, 10000);
      browserInstance.find({ type: 'ipp', subtypes: ['print'] }, (svc) => {
        if (svc.name !== name) return;
        clearTimeout(timer);
        browserInstance.destroy();
        resolve();
      });
    });
  } finally {
    await advertisement.stop();
  }
}

/**
 * @description WSD guards: Probe → ProbeMatches over real UDP, Transfer Get →
 * metadata with FriendlyName, MTOM SendDocument → real file via the spooler.
 * @returns {Promise<void>} Resolves when asserted.
 */
async function testWsd() {
  const dgram = require('dgram');
  const { startWsdDiscovery } = require('../lib/wsd/discovery');
  const { createWsdHttpHandler } = require('../lib/wsd/http');
  const uuidUri = 'urn:uuid:00000000-0000-5000-8000-00000000wsd1';
  const wsd = await startWsdDiscovery({ uuidUri, xaddrs: 'http://127.0.0.1:9999/wsd/device' }, quietLog, 13702);
  try {
    const reply = await new Promise((resolve, reject) => {
      const probe = `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:wsd="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:wprt="http://schemas.microsoft.com/windows/2006/08/wdp/print"><soap:Header><wsa:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</wsa:To><wsa:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</wsa:Action><wsa:MessageID>urn:uuid:selftest-probe</wsa:MessageID></soap:Header><soap:Body><wsd:Probe><wsd:Types>wprt:PrintDeviceType</wsd:Types></wsd:Probe></soap:Body></soap:Envelope>`;
      const sock = dgram.createSocket('udp4');
      const timer = setTimeout(() => { sock.close(); reject(new Error('no ProbeMatches within 5s')); }, 5000);
      sock.on('message', (msg) => { clearTimeout(timer); sock.close(); resolve(msg.toString('utf8')); });
      sock.send(Buffer.from(probe), 13702, '127.0.0.1');
    });
    assert.ok(reply.includes('ProbeMatches'), 'print-typed Probe answered with ProbeMatches');
    assert.ok(reply.includes('wprt:PrintDeviceType'), 'ProbeMatches declares the print device type Windows filters on');
    assert.ok(reply.includes(uuidUri), 'ProbeMatches carries our endpoint urn');
    assert.ok(reply.includes('http://127.0.0.1:9999/wsd/device'), 'ProbeMatches carries XAddrs');
    assert.ok(reply.includes('urn:uuid:selftest-probe'), 'RelatesTo echoes the probe MessageID');
  } finally {
    await wsd.stop();
  }
  const dropDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-wsd-'));
  const { server, state, ctx } = await startIppServer(testConfig(dropDir, 10 * 1024 * 1024), quietLog);
  ctx.extraRoutes.push({
    prefix: '/wsd/',
    handler: createWsdHttpHandler({ friendlyName: 'Oshal Print to File Printer', location: 'selftest', uuidUri, baseUrl: `http://127.0.0.1:${state.port}`, dropDir, maxBytes: 10 * 1024 * 1024, log: quietLog }),
  });
  try {
    const soap = (action, body) => `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:wprt="http://schemas.microsoft.com/windows/2006/08/wdp/print"><soap:Header><wsa:Action>${action}</wsa:Action><wsa:MessageID>urn:uuid:selftest-http</wsa:MessageID></soap:Header><soap:Body>${body}</soap:Body></soap:Envelope>`;
    const post = async (payload, contentType) => {
      const res = await fetch(`http://127.0.0.1:${state.port}/wsd/device`, { method: 'POST', headers: { 'content-type': contentType }, body: payload });
      assert.strictEqual(res.status, 200, 'WSD endpoint answers 200');
      assert.ok(res.headers.get('content-length'), 'WSD responses carry Content-Length (WSDAPI mishandles chunked)');
      return res.text();
    };
    const meta = await post(soap('http://schemas.xmlsoap.org/ws/2004/09/transfer/Get', ''), 'application/soap+xml');
    assert.ok(meta.includes('Oshal Print to File Printer'), 'metadata carries the FriendlyName');
    assert.ok(meta.includes('PrinterServiceType'), 'metadata declares the print service');
    assert.ok(/ServiceId>http:\/\/[^<]+\/PrintService</.test(meta), 'ServiceId is the http-shaped form, not a urn with a path');
    assert.ok(meta.includes('HardwareId'), 'metadata carries a PNPX HardwareId');
    const eventRate = await post(soap('http://schemas.microsoft.com/windows/2006/08/wdp/print/SetEventRate', '<wprt:SetEventRate><wprt:EventRate>10</wprt:EventRate></wprt:SetEventRate>'), 'application/soap+xml');
    assert.ok(eventRate.includes('SetEventRateResponse/>') || eventRate.includes('SetEventRateResponse>'), 'SetEventRate answers with its wprt response element');
    const elements = await post(soap('http://schemas.microsoft.com/windows/2006/08/wdp/print/GetPrinterElements', '<wprt:GetPrinterElements><wprt:RequestedElements><wprt:Name>wprt:PrinterDescription</wprt:Name></wprt:RequestedElements></wprt:GetPrinterElements>'), 'application/soap+xml');
    assert.ok(elements.includes('CID:MS_IPP_PREF'), 'DeviceId carries CID:MS_IPP_PREF - the id that binds the inbox IPP class driver to a WSD queue');
    const boundary = 'selftestboundary';
    const docBytes = Buffer.from('%PDF-1.4 wsd doc %%EOF');
    const sendXml = soap('http://schemas.microsoft.com/windows/2006/08/wdp/print/SendDocument', '<wprt:SendDocument><wprt:JobId>1</wprt:JobId></wprt:SendDocument>');
    const mtom = Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-type: application/xop+xml\r\n\r\n${sendXml}\r\n`),
      Buffer.from(`--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`),
      docBytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const sent = await post(mtom, `multipart/related; type="application/xop+xml"; boundary="${boundary}"`);
    assert.ok(sent.includes('SendDocumentResponse'), 'SendDocument acknowledged');
    const saved = fs.readdirSync(dropDir).filter((f) => f.endsWith('.pdf'));
    assert.strictEqual(saved.length, 1, 'WSD document landed via the spooler');
    assert.deepStrictEqual(fs.readFileSync(path.join(dropDir, saved[0])), docBytes, 'bytes intact');
  } finally {
    server.close();
    fs.rmSync(dropDir, { recursive: true, force: true });
  }
}

/**
 * @description Run every test against one shared server instance, then the cap test.
 * @returns {Promise<void>} Resolves on full success.
 */
async function main() {
  const dropDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-print-drop-'));
  const { server, state } = await startIppServer(testConfig(dropDir, 10 * 1024 * 1024), quietLog);
  const log = createLogger('selftest');
  try {
    await testGetPrinterAttributes(state.port);
    await testPrintJob(state.port, dropDir);
    await testCreateSendDocument(state.port, dropDir);
    await testJobQueries(state.port);
    await testRejections(state.port);
  } finally {
    server.close();
    fs.rmSync(dropDir, { recursive: true, force: true });
  }
  await testByteCap();
  await testSubtypeAdvertisement();
  await testWsd();
  log.info('selftest passed', { suites: 8 });
}

main().catch((err) => {
  process.stderr.write(`SELFTEST FAILED: ${err.stack}\n`);
  process.exitCode = 1;
});
