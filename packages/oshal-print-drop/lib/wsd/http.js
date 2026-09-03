/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the HTTP half of WSD, mounted at /wsd/* on the existing port-631 server (one port, one firewall rule): WS-Transfer Get serves the device metadata (FriendlyName is what Windows lists), WS-Eventing Subscribe/Renew/Unsubscribe are accepted with canned grants (no events are ever pushed — a print-to-file target has none worth pushing), and the WS-Print (wprt) service implements GetPrinterElements, CreatePrintJob and SendDocument. SendDocument arrives as MTOM (multipart/related) with the document (typically XPS) as a binary part — it is buffered under the existing byte cap, extracted by boundary split, and handed to the same spooler as IPP jobs. XML handling is the package's regex extraction: values are compared against constants, never interpreted.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Log every WSD HTTP action with its client — the first client-visible field trip (probes answered, nothing listed) was undiagnosable partly because the metadata exchange left no trace; now the log shows exactly how far a Windows client walks the install chain (Get -> Subscribe -> GetPrinterElements -> CreatePrintJob -> SendDocument).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Metadata conformance, diffed live against the operator's HP Smart Tank GetResponse after Windows looped on Transfer Get (fetch-retry-fetch, never listing): (1) responses now send Content-Length + charset and Connection: close — Node defaulted to chunked, which WSDAPI's gSOAP-era HTTP client mishandles; (2) ServiceId was a malformed URN (urn:uuid:xxx/print — URNs take no path) and is now the http://<uuid>/PrintService shape real devices use; (3) added PNPX:HardwareId beside CompatibleId, xml:lang on the human-readable names, and PresentationUrl.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Install-chain completion: the live Add-device walk (Get -> GetPrinterElements -> Subscribe) died on unimplemented SetEventRate, sending WSDMon into an endless Resolve/Get retry loop. SetEventRate, GetActiveJobs and GetJobHistory now answer with their proper wprt response elements (an empty soap:Body from the generic fallback was not accepted as success).
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | CID:MS_IPP_PREF in the DeviceId — the driver-binding key. Post-reboot the Add-device flow created the queue but left it "Driver is unavailable": Windows derives the queue's PnP hardware id from the CID: field of this DeviceId (1284_CID_<value>), and the inbox Microsoft IPP Class Driver INF (prnms012.inf) matches 1284_CID_MS_IPP / 1284_CID_MS_IPP_PREF — read directly off the operator's working HP queue (hardware id 1284_CID_MS_IPP_PREF) and C:\Windows\INF. With the CID declared, a WSD-discovered queue binds the IPP class driver on any Windows box with no mDNS pairing involved.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Carry the job ticket through to the sidecar. WS-Print splits a job across two messages: CreatePrintJob carries JobDescription (JobName — the document title — plus originating user and computer) and SendDocument carries only JobId, DocumentDescription/Format and the bytes. Reading only SendDocument meant every remote job landed as "wsd-print-job" with an empty format, while the IPP path kept its real title; the first live cross-machine job proved it. CreatePrintJob's ticket is now retained in a bounded per-job map (network input — capped at MAX_TRACKED_JOBS, evicted oldest-first, and consumed on use) and merged with the DocumentDescription at SendDocument time, so the declared MIME type drives the file extension and the sidecar records the real title. SendDocument now also honours the JobId it is given instead of incrementing its own counter, which previously left the two messages disagreeing about the job number.
 */
'use strict';

const { Readable } = require('stream');
const { extractTag, escapeXml, messageId } = require('./xml');
const { spoolDocument } = require('../spooler');

const SOAP_CT = 'application/soap+xml';
const ANON = 'http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous';
// A client can open jobs it never sends; the ticket map is client-driven, so it
// is bounded and evicted oldest-first rather than allowed to grow.
const MAX_TRACKED_JOBS = 32;
const ACTIONS = {
  GET: 'http://schemas.xmlsoap.org/ws/2004/09/transfer/Get',
  SUBSCRIBE: 'http://schemas.xmlsoap.org/ws/2004/08/eventing/Subscribe',
  RENEW: 'http://schemas.xmlsoap.org/ws/2004/08/eventing/Renew',
  UNSUBSCRIBE: 'http://schemas.xmlsoap.org/ws/2004/08/eventing/Unsubscribe',
  GET_STATUS: 'http://schemas.xmlsoap.org/ws/2004/08/eventing/GetStatus',
  GET_PRINTER_ELEMENTS: 'http://schemas.microsoft.com/windows/2006/08/wdp/print/GetPrinterElements',
  CREATE_PRINT_JOB: 'http://schemas.microsoft.com/windows/2006/08/wdp/print/CreatePrintJob',
  SEND_DOCUMENT: 'http://schemas.microsoft.com/windows/2006/08/wdp/print/SendDocument',
  SET_EVENT_RATE: 'http://schemas.microsoft.com/windows/2006/08/wdp/print/SetEventRate',
  GET_ACTIVE_JOBS: 'http://schemas.microsoft.com/windows/2006/08/wdp/print/GetActiveJobs',
  GET_JOB_HISTORY: 'http://schemas.microsoft.com/windows/2006/08/wdp/print/GetJobHistory',
};

/**
 * @description Wrap a body in a SOAP response envelope with WSD's namespace set.
 * @param {string} action The response wsa:Action URI.
 * @param {string} relatesTo The request MessageID.
 * @param {string} body The body XML.
 * @returns {string} The envelope XML.
 */
function respondEnvelope(action, relatesTo, body) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:wsx="http://schemas.xmlsoap.org/ws/2004/09/mex" xmlns:wsdp="http://schemas.xmlsoap.org/ws/2006/02/devprof" xmlns:wse="http://schemas.xmlsoap.org/ws/2004/08/eventing" xmlns:wprt="http://schemas.microsoft.com/windows/2006/08/wdp/print" xmlns:pnpx="http://schemas.microsoft.com/windows/pnpx/2005/10">
<soap:Header>
<wsa:To>${ANON}</wsa:To>
<wsa:Action>${action}</wsa:Action>
<wsa:MessageID>${messageId()}</wsa:MessageID>
${relatesTo ? `<wsa:RelatesTo>${relatesTo}</wsa:RelatesTo>` : ''}
</soap:Header>
<soap:Body>${body}</soap:Body>
</soap:Envelope>`;
}

/**
 * @description The WS-Transfer Get metadata: device identity, model, and the
 * hosted wprt print service. FriendlyName is the string Windows displays.
 * @param {object} options The handler options.
 * @returns {string} The Metadata body XML.
 */
function metadataBody(options) {
  const name = escapeXml(options.friendlyName);
  const bareUuid = options.uuidUri.replace(/^urn:uuid:/, '');
  return `<wsx:Metadata>
<wsx:MetadataSection Dialect="http://schemas.xmlsoap.org/ws/2006/02/devprof/ThisDevice">
<wsdp:ThisDevice><wsdp:FriendlyName xml:lang="en">${name}</wsdp:FriendlyName><wsdp:FirmwareVersion>1.0</wsdp:FirmwareVersion><wsdp:SerialNumber>OSHAL-PRINT-DROP</wsdp:SerialNumber></wsdp:ThisDevice>
</wsx:MetadataSection>
<wsx:MetadataSection Dialect="http://schemas.xmlsoap.org/ws/2006/02/devprof/ThisModel">
<wsdp:ThisModel><wsdp:Manufacturer xml:lang="en">oshal</wsdp:Manufacturer><wsdp:ManufacturerUrl>https://oswarm.ai/</wsdp:ManufacturerUrl><wsdp:ModelName xml:lang="en">${name}</wsdp:ModelName><wsdp:ModelNumber>1</wsdp:ModelNumber><wsdp:PresentationUrl>${options.baseUrl}/</wsdp:PresentationUrl><pnpx:DeviceCategory>Printers</pnpx:DeviceCategory></wsdp:ThisModel>
</wsx:MetadataSection>
<wsx:MetadataSection Dialect="http://schemas.xmlsoap.org/ws/2006/02/devprof/Relationship">
<wsdp:Relationship Type="http://schemas.xmlsoap.org/ws/2006/02/devprof/host">
<wsdp:Hosted>
<wsa:EndpointReference><wsa:Address>${options.baseUrl}/wsd/print</wsa:Address></wsa:EndpointReference>
<wsdp:Types>wprt:PrinterServiceType</wsdp:Types>
<wsdp:ServiceId>http://${bareUuid}/PrintService</wsdp:ServiceId>
<pnpx:HardwareId>VEN_OSHAL&amp;DEV_PrintDrop&amp;SUBSYS_0001</pnpx:HardwareId>
<pnpx:CompatibleId>http://schemas.microsoft.com/windows/2006/08/wdp/print/PrinterServiceType</pnpx:CompatibleId>
</wsdp:Hosted>
</wsdp:Relationship>
</wsx:MetadataSection>
</wsx:Metadata>`;
}

/**
 * @description The canned GetPrinterElements answer: description, configuration,
 * status, and an empty default PrintTicket. Cosmetic for a print-to-file target
 * but required by the Windows WSD print class driver at install time.
 * @param {object} options The handler options.
 * @returns {string} The response body XML.
 */
function printerElementsBody(options) {
  const name = escapeXml(options.friendlyName);
  return `<wprt:GetPrinterElementsResponse><wprt:PrinterElements>
<wprt:ElementData Name="wprt:PrinterDescription" Valid="true"><wprt:PrinterDescription>
<wprt:ColorSupported>true</wprt:ColorSupported>
<wprt:DeviceId>MFG:oshal;MDL:Print to File;CLS:PRINTER;CMD:PDF,XPS;CID:MS_IPP_PREF;</wprt:DeviceId>
<wprt:MultipleDocumentJobsSupported>false</wprt:MultipleDocumentJobsSupported>
<wprt:PagesPerMinute>30</wprt:PagesPerMinute>
<wprt:PagesPerMinuteColor>30</wprt:PagesPerMinuteColor>
<wprt:PrinterName>${name}</wprt:PrinterName>
<wprt:PrinterInfo>Saves print jobs as files on the host</wprt:PrinterInfo>
<wprt:PrinterLocation>${escapeXml(options.location)}</wprt:PrinterLocation>
</wprt:PrinterDescription></wprt:ElementData>
<wprt:ElementData Name="wprt:PrinterConfiguration" Valid="true"><wprt:PrinterConfiguration>
<wprt:PrinterEventRate>10</wprt:PrinterEventRate>
</wprt:PrinterConfiguration></wprt:ElementData>
<wprt:ElementData Name="wprt:PrinterStatus" Valid="true"><wprt:PrinterStatus>
<wprt:PrinterCurrentTime>${new Date().toISOString()}</wprt:PrinterCurrentTime>
<wprt:PrinterState>Idle</wprt:PrinterState>
<wprt:PrinterPrimaryStateReason>None</wprt:PrinterPrimaryStateReason>
<wprt:QueuedJobCount>0</wprt:QueuedJobCount>
</wprt:PrinterStatus></wprt:ElementData>
<wprt:ElementData Name="wprt:DefaultPrintTicket" Valid="true">
<pt:PrintTicket xmlns:pt="http://schemas.microsoft.com/windows/2003/08/printing/printschemaframework" version="1"/>
</wprt:ElementData>
</wprt:PrinterElements></wprt:GetPrinterElementsResponse>`;
}

/**
 * @description Split a multipart/related (MTOM) body into parts.
 * @param {Buffer} body The raw request body.
 * @param {string} contentType The Content-Type header.
 * @returns {Array<{headers:string,content:Buffer}>|null} The parts, null when not multipart.
 */
function splitMultipart(body, contentType) {
  const match = /boundary="?([^";]+)"?/i.exec(contentType || '');
  if (!match) return null;
  const boundary = Buffer.from(`--${match[1]}`);
  const parts = [];
  let index = body.indexOf(boundary);
  while (index !== -1) {
    const next = body.indexOf(boundary, index + boundary.length);
    if (next === -1) break;
    const segment = body.slice(index + boundary.length, next);
    const headerEnd = segment.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      let content = segment.slice(headerEnd + 4);
      if (content.length >= 2 && content.slice(-2).toString('latin1') === '\r\n') content = content.slice(0, -2);
      parts.push({ headers: segment.slice(0, headerEnd).toString('utf8').toLowerCase(), content });
    }
    index = next;
  }
  return parts.length ? parts : null;
}

/**
 * @description Pull the SOAP XML and the (optional) binary document out of a
 * request body, MTOM or plain.
 * @param {Buffer} body The raw body.
 * @param {string} contentType The Content-Type header.
 * @returns {{xml:string,document:Buffer|null}} The pieces.
 */
function extractPayload(body, contentType) {
  const parts = splitMultipart(body, contentType);
  if (!parts) return { xml: body.toString('utf8'), document: null };
  let xml = '';
  let document = null;
  for (const part of parts) {
    if (part.headers.includes('xop+xml') || part.headers.includes('soap+xml')) {
      if (!xml) xml = part.content.toString('utf8');
    } else if (!document) {
      document = part.content;
    }
  }
  return { xml, document };
}

/**
 * @description Record the CreatePrintJob ticket so SendDocument — which carries
 * only the JobId, the format and the bytes — can be attributed to the document
 * the user actually printed.
 * @param {object} state The wsd job state.
 * @param {string} xml The CreatePrintJob request XML.
 * @returns {number} The assigned job id.
 */
function trackPrintJob(state, xml) {
  state.jobId += 1;
  state.tickets.set(state.jobId, {
    jobName: extractTag(xml, 'JobName'),
    userName: extractTag(xml, 'JobOriginatingUserName'),
    computerName: extractTag(xml, 'JobOriginatingComputerName'),
  });
  while (state.tickets.size > MAX_TRACKED_JOBS) {
    state.tickets.delete(state.tickets.keys().next().value);
  }
  return state.jobId;
}

/**
 * @description Merge a SendDocument's DocumentDescription with the ticket its
 * CreatePrintJob left behind. Title preference is the job name (the document
 * title Windows shows in the queue), then the document name.
 * @param {object} state The wsd job state.
 * @param {string} xml The SendDocument request XML.
 * @returns {{jobId:number,jobName:string,documentName:string,userName:string,computerName:string,format:string}} The merged job metadata.
 */
function resolveJobMetadata(state, xml) {
  const requestedId = Number.parseInt(extractTag(xml, 'JobId'), 10);
  const jobId = Number.isInteger(requestedId) && requestedId > 0 ? requestedId : state.jobId;
  const ticket = state.tickets.get(jobId) || {};
  state.tickets.delete(jobId);
  const documentName = extractTag(xml, 'DocumentName');
  return {
    jobId,
    jobName: ticket.jobName || documentName || 'wsd-print-job',
    documentName,
    userName: ticket.userName || 'wsd-client',
    computerName: ticket.computerName || '',
    format: extractTag(xml, 'Format'),
  };
}

/**
 * @description Handle SendDocument: spool the MTOM binary through the shared
 * spooler and confirm.
 * @param {object} options The handler options.
 * @param {object} state The wsd job state.
 * @param {{xml:string,document:Buffer|null}} payload The request pieces.
 * @param {string} clientIp The sender address.
 * @returns {Promise<string>} The response body XML.
 */
async function handleSendDocument(options, state, payload, clientIp) {
  if (!payload.document || !payload.document.length) {
    options.log.warn('WSD SendDocument without a document part', { client: clientIp });
    return '<wprt:SendDocumentResponse/>';
  }
  const job = resolveJobMetadata(state, payload.xml);
  const result = await spoolDocument(
    Readable.from([payload.document]),
    {
      jobId: 100000 + job.jobId,
      jobName: job.jobName,
      documentName: job.documentName,
      userName: job.userName,
      computerName: job.computerName,
      clientIp,
      format: job.format,
      source: 'wsd',
      printerName: options.friendlyName,
    },
    { dropDir: options.dropDir, maxBytes: options.maxBytes },
  );
  options.log.info('WSD print job saved', {
    file: result.filePath, bytes: result.bytes, client: clientIp, jobName: job.jobName, format: job.format || '(undeclared)',
  });
  return '<wprt:SendDocumentResponse/>';
}

/**
 * @description Dispatch one decoded WSD SOAP request to its response body.
 * @param {object} options The handler options.
 * @param {object} state The wsd job state.
 * @param {string} action The wsa:Action URI.
 * @param {{xml:string,document:Buffer|null}} payload The request pieces.
 * @param {string} clientIp The sender address.
 * @returns {Promise<{action:string,body:string}>} The response action + body.
 */
async function dispatchAction(options, state, action, payload, clientIp) {
  switch (action) {
    case ACTIONS.GET:
      return { action: 'http://schemas.xmlsoap.org/ws/2004/09/transfer/GetResponse', body: metadataBody(options) };
    case ACTIONS.SUBSCRIBE:
      state.subId += 1;
      return {
        action: 'http://schemas.xmlsoap.org/ws/2004/08/eventing/SubscribeResponse',
        body: `<wse:SubscribeResponse><wse:SubscriptionManager><wsa:Address>${options.baseUrl}/wsd/subscriptions/${state.subId}</wsa:Address><wsa:ReferenceParameters><wse:Identifier>urn:uuid:sub-${state.subId}</wse:Identifier></wsa:ReferenceParameters></wse:SubscriptionManager><wse:Expires>PT1H</wse:Expires></wse:SubscribeResponse>`,
      };
    case ACTIONS.RENEW:
    case ACTIONS.GET_STATUS:
      return { action: `${action}Response`, body: '<wse:RenewResponse><wse:Expires>PT1H</wse:Expires></wse:RenewResponse>' };
    case ACTIONS.UNSUBSCRIBE:
      return { action: `${action}Response`, body: '' };
    case ACTIONS.GET_PRINTER_ELEMENTS:
      return { action: `${ACTIONS.GET_PRINTER_ELEMENTS}Response`, body: printerElementsBody(options) };
    case ACTIONS.SET_EVENT_RATE:
      return { action: `${ACTIONS.SET_EVENT_RATE}Response`, body: '<wprt:SetEventRateResponse/>' };
    case ACTIONS.GET_ACTIVE_JOBS:
      return { action: `${ACTIONS.GET_ACTIVE_JOBS}Response`, body: '<wprt:GetActiveJobsResponse><wprt:ActiveJobs/></wprt:GetActiveJobsResponse>' };
    case ACTIONS.GET_JOB_HISTORY:
      return { action: `${ACTIONS.GET_JOB_HISTORY}Response`, body: '<wprt:GetJobHistoryResponse><wprt:JobHistory/></wprt:GetJobHistoryResponse>' };
    case ACTIONS.CREATE_PRINT_JOB:
      return {
        action: `${ACTIONS.CREATE_PRINT_JOB}Response`,
        body: `<wprt:CreatePrintJobResponse><wprt:JobId>${trackPrintJob(state, payload.xml)}</wprt:JobId></wprt:CreatePrintJobResponse>`,
      };
    case ACTIONS.SEND_DOCUMENT:
      return { action: `${ACTIONS.SEND_DOCUMENT}Response`, body: await handleSendDocument(options, state, payload, clientIp) };
    default:
      options.log.warn('WSD action not implemented', { action, client: clientIp });
      return { action: `${action}Response`, body: '' };
  }
}

/**
 * @description Create the HTTP handler for /wsd/* requests, suitable as an
 * extraRoutes entry on the IPP server.
 * @param {{friendlyName:string,location:string,uuidUri:string,baseUrl:string,dropDir:string,maxBytes:number,log:object}} options Identity + spool config.
 * @returns {(req:import('http').IncomingMessage,res:import('http').ServerResponse)=>void} The route handler.
 */
function createWsdHttpHandler(options) {
  const state = { jobId: 0, subId: 0, tickets: new Map() };
  return (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > options.maxBytes * 1.4) {
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', async () => {
      try {
        const payload = extractPayload(Buffer.concat(chunks), req.headers['content-type']);
        const action = extractTag(payload.xml, 'Action');
        const relatesTo = extractTag(payload.xml, 'MessageID');
        const clientIp = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        options.log.info('WSD request', { action: action.split('/').pop() || '(none)', client: clientIp });
        const result = await dispatchAction(options, state, action, payload, clientIp);
        const xml = respondEnvelope(result.action, relatesTo, result.body);
        res.writeHead(200, {
          'content-type': `${SOAP_CT}; charset=utf-8`,
          'content-length': Buffer.byteLength(xml),
          connection: 'close',
        });
        res.end(xml);
      } catch (err) {
        options.log.error('WSD request failed', { error: err.message, stack: err.stack });
        res.writeHead(500).end();
      }
    });
    req.on('error', () => res.destroy());
  };
}

module.exports = { createWsdHttpHandler, ACTIONS };
