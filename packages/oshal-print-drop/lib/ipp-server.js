/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the IPP endpoint: an HTTP server that speaks enough IPP 1.1/2.0 for driverless clients (Microsoft IPP Class Driver, macOS, CUPS) to install the queue and print. Supported operations: Get-Printer-Attributes, Validate-Job, Print-Job, Create-Job + Send-Document, Cancel-Job, Get-Job-Attributes, Get-Jobs; everything else answers server-error-operation-not-supported. The request body is parsed incrementally: attribute section decoded from the first chunks (capped at 256KB), document bytes streamed to the spooler without buffering. GET / serves a small human status page for manual verification. Jobs live in a bounded in-memory table (Windows' queue UI polls Get-Jobs).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | extraRoutes hook: startIppServer's ctx now carries a mutable extraRoutes array checked before IPP dispatch, so sibling protocols (the WSD HTTP endpoints at /wsd/*) share this one port and its one firewall rule instead of opening another listener.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Malformed-request capture: a rejected request now logs its method, URL, content-type, byte count, and the first 64 bytes (hex + printable ASCII). Operator-demanded after "rejected malformed IPP request" fired during a Windows install with zero forensic detail — the log line must carry enough of the message to see WHERE it is incomplete without a wire capture.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Pass the sidecar's provenance fields (document-name, transport, receiving printer) to the spooler so an IPP job and a WSD job produce the same record shape — a downstream consumer should not have to infer which transport delivered a document from which fields happen to be empty.
 */
'use strict';

const http = require('http');
const { PassThrough } = require('stream');
const codec = require('./ipp-codec');
const { buildPrinterAttributes, filterRequested } = require('./printer-attributes');
const { spoolDocument } = require('./spooler');

const { DELIMITER, VALUE, OPERATION, STATUS } = codec;
const MAX_ATTRIBUTE_BYTES = 256 * 1024;
const MAX_RETAINED_JOBS = 200;
const JOB_STATE = { PENDING: 3, PROCESSING: 5, CANCELED: 7, ABORTED: 8, COMPLETED: 9 };
const FINISHED_STATES = new Set([JOB_STATE.CANCELED, JOB_STATE.ABORTED, JOB_STATE.COMPLETED]);

/**
 * @description Accumulate a request until the IPP attribute section is complete,
 * then hand back the decoded message plus a PassThrough carrying the document
 * bytes (already-buffered remainder first, then the rest of the request piped
 * live). Errors on malformed or oversized attribute sections.
 * @param {import('http').IncomingMessage} req The HTTP request.
 * @param {(err:Error|null, msg?:object, doc?:import('stream').PassThrough)=>void} callback Completion callback (called once).
 * @returns {void}
 */
function collectMessage(req, callback) {
  let buf = Buffer.alloc(0);
  let settled = false;
  const finish = (err, msg, doc) => {
    if (settled) return;
    settled = true;
    req.removeListener('data', onData);
    req.removeListener('end', onEnd);
    if (err) err.capturedBytes = buf;
    callback(err, msg, doc);
  };
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > MAX_ATTRIBUTE_BYTES && !codec.decodeMessage(buf)) {
      req.destroy();
      return finish(new Error('IPP attribute section exceeds 256KB'));
    }
    const msg = codec.decodeMessage(buf);
    if (!msg) return undefined;
    const doc = new PassThrough();
    if (msg.dataOffset < buf.length) doc.write(buf.slice(msg.dataOffset));
    req.pipe(doc);
    return finish(null, msg, doc);
  };
  const onEnd = () => {
    const msg = codec.decodeMessage(buf);
    if (!msg) return finish(new Error('incomplete IPP message'));
    const doc = new PassThrough();
    if (msg.dataOffset < buf.length) doc.write(buf.slice(msg.dataOffset));
    doc.end();
    return finish(null, msg, doc);
  };
  req.on('data', onData);
  req.on('end', onEnd);
  req.on('error', (err) => finish(err));
}

/**
 * @description The mandatory first response group: charset + natural language.
 * @returns {{tag:number,attributes:Array}} The operation-attributes group.
 */
function operationGroup() {
  return {
    tag: DELIMITER.OPERATION_ATTRIBUTES,
    attributes: [
      { tag: VALUE.CHARSET, name: 'attributes-charset', values: ['utf-8'] },
      { tag: VALUE.NATURAL_LANGUAGE, name: 'attributes-natural-language', values: ['en'] },
    ],
  };
}

/**
 * @description Encode a full IPP response for a request, echoing a version the
 * client understands (2.0 for 2.x requests, 1.1 otherwise).
 * @param {object} msg The decoded request.
 * @param {number} statusCode The IPP status code.
 * @param {Array} [extraGroups] Job/printer attribute groups to append.
 * @returns {Buffer} The encoded response.
 */
function buildResponse(msg, statusCode, extraGroups) {
  const modern = msg.versionMajor >= 2;
  return codec.encodeMessage({
    versionMajor: modern ? 2 : 1,
    versionMinor: modern ? 0 : 1,
    statusCode,
    requestId: msg.requestId,
    groups: [operationGroup(), ...(extraGroups || [])],
  });
}

/**
 * @description Build the job-attributes response group for one job.
 * @param {object} job The job entry.
 * @param {string} baseUri The printer URI.
 * @returns {{tag:number,attributes:Array}} The job-attributes group.
 */
function jobGroup(job, baseUri) {
  return {
    tag: DELIMITER.JOB_ATTRIBUTES,
    attributes: [
      { tag: VALUE.INTEGER, name: 'job-id', values: [job.id] },
      { tag: VALUE.URI, name: 'job-uri', values: [`${baseUri}/job-${job.id}`] },
      { tag: VALUE.ENUM, name: 'job-state', values: [job.state] },
      { tag: VALUE.KEYWORD, name: 'job-state-reasons', values: [job.reason] },
      { tag: VALUE.NAME, name: 'job-name', values: [job.name] },
      { tag: VALUE.NAME, name: 'job-originating-user-name', values: [job.user] },
    ],
  };
}

/**
 * @description Register a new job from a Print-Job or Create-Job request.
 * @param {{state:object}} ctx The request context.
 * @param {object} msg The decoded request.
 * @param {number} initialState The starting job-state enum.
 * @returns {object} The job entry.
 */
function createJobEntry(ctx, msg, initialState) {
  const job = {
    id: ctx.state.nextJobId,
    name: String(codec.attributeValue(msg, DELIMITER.OPERATION_ATTRIBUTES, 'job-name', 'untitled')),
    user: String(codec.attributeValue(msg, DELIMITER.OPERATION_ATTRIBUTES, 'requesting-user-name', 'anonymous')),
    state: initialState,
    reason: 'none',
    createdAt: Date.now(),
    files: [],
  };
  ctx.state.nextJobId += 1;
  ctx.state.jobs.set(job.id, job);
  pruneJobs(ctx.state);
  return job;
}

/**
 * @description Bound the in-memory job table: drop oldest finished jobs beyond the cap.
 * @param {{jobs:Map}} state The server state.
 * @returns {void}
 */
function pruneJobs(state) {
  if (state.jobs.size <= MAX_RETAINED_JOBS) return;
  for (const [id, job] of state.jobs) {
    if (state.jobs.size <= MAX_RETAINED_JOBS) break;
    if (FINISHED_STATES.has(job.state)) state.jobs.delete(id);
  }
}

/**
 * @description Spool a document stream for a job and settle the job's terminal state.
 * @param {object} ctx The request context.
 * @param {object} job The job entry.
 * @param {object} msg The decoded request (for document-format).
 * @param {import('stream').Readable} doc The document stream.
 * @returns {Promise<number>} The IPP status code to answer with.
 */
async function spoolForJob(ctx, job, msg, doc) {
  const format = String(codec.attributeValue(msg, DELIMITER.OPERATION_ATTRIBUTES, 'document-format', ''));
  job.state = JOB_STATE.PROCESSING;
  try {
    const result = await spoolDocument(
      doc,
      {
        jobId: job.id,
        jobName: job.name,
        documentName: String(codec.attributeValue(msg, DELIMITER.OPERATION_ATTRIBUTES, 'document-name', '') || ''),
        userName: job.user,
        clientIp: ctx.clientIp,
        format,
        source: 'ipp',
        printerName: ctx.config.printerName,
      },
      { dropDir: ctx.config.dropDir, maxBytes: ctx.config.maxBytes },
    );
    if (result.filePath) {
      job.files.push(result.filePath);
      ctx.state.saved += 1;
      ctx.log.info('print job saved', { jobId: job.id, file: result.filePath, bytes: result.bytes, client: ctx.clientIp, user: job.user });
    }
    return STATUS.OK;
  } catch (err) {
    job.state = JOB_STATE.ABORTED;
    job.reason = 'aborted-by-system';
    ctx.log.error('print job failed', { jobId: job.id, client: ctx.clientIp, error: err.message, stack: err.stack });
    return err.code === 'TOO_LARGE' ? STATUS.REQUEST_ENTITY_TOO_LARGE : STATUS.INTERNAL_ERROR;
  }
}

/**
 * @description Print-Job: one round trip carrying attributes + document.
 * @param {object} ctx The request context.
 * @param {object} msg The decoded request.
 * @param {import('stream').Readable} doc The document stream.
 * @returns {Promise<{statusCode:number,groups?:Array}>} The response parts.
 */
async function handlePrintJob(ctx, msg, doc) {
  const job = createJobEntry(ctx, msg, JOB_STATE.PROCESSING);
  const statusCode = await spoolForJob(ctx, job, msg, doc);
  if (statusCode === STATUS.OK) {
    job.state = JOB_STATE.COMPLETED;
    job.reason = 'job-completed-successfully';
  }
  return { statusCode, groups: [jobGroup(job, ctx.baseUri)] };
}

/**
 * @description Send-Document: attach document data to a job made by Create-Job.
 * @param {object} ctx The request context.
 * @param {object} msg The decoded request.
 * @param {import('stream').Readable} doc The document stream.
 * @returns {Promise<{statusCode:number,groups?:Array}>} The response parts.
 */
async function handleSendDocument(ctx, msg, doc) {
  const jobId = codec.attributeValue(msg, DELIMITER.OPERATION_ATTRIBUTES, 'job-id', -1);
  const job = ctx.state.jobs.get(jobId);
  if (!job) {
    doc.resume();
    return { statusCode: STATUS.NOT_FOUND };
  }
  if (FINISHED_STATES.has(job.state)) {
    doc.resume();
    return { statusCode: STATUS.NOT_POSSIBLE, groups: [jobGroup(job, ctx.baseUri)] };
  }
  const lastDocument = codec.attributeValue(msg, DELIMITER.OPERATION_ATTRIBUTES, 'last-document', true);
  const statusCode = await spoolForJob(ctx, job, msg, doc);
  if (statusCode === STATUS.OK && lastDocument) {
    job.state = JOB_STATE.COMPLETED;
    job.reason = 'job-completed-successfully';
  } else if (statusCode === STATUS.OK) {
    job.state = JOB_STATE.PENDING;
  }
  return { statusCode, groups: [jobGroup(job, ctx.baseUri)] };
}

/**
 * @description Get-Printer-Attributes: the capability handshake that makes
 * driverless install work, honoring requested-attributes.
 * @param {object} ctx The request context.
 * @param {object} msg The decoded request.
 * @returns {{statusCode:number,groups:Array}} The response parts.
 */
function handleGetPrinterAttributes(ctx, msg) {
  const requested = codec.attributeValues(msg, DELIMITER.OPERATION_ATTRIBUTES, 'requested-attributes').map(String);
  const pending = [...ctx.state.jobs.values()].filter((j) => !FINISHED_STATES.has(j.state)).length;
  const attributes = buildPrinterAttributes({
    name: ctx.config.printerName,
    info: ctx.config.printerInfo,
    location: ctx.config.printerLocation,
    uris: [ctx.baseUri],
    uuidUri: ctx.config.uuidUri,
    upTimeSeconds: Math.max(1, Math.floor((Date.now() - ctx.state.startedAt) / 1000)),
    queuedJobCount: pending,
  });
  return { statusCode: STATUS.OK, groups: [{ tag: DELIMITER.PRINTER_ATTRIBUTES, attributes: filterRequested(attributes, requested) }] };
}

/**
 * @description Get-Jobs: list jobs filtered by which-jobs (default not-completed).
 * @param {object} ctx The request context.
 * @param {object} msg The decoded request.
 * @returns {{statusCode:number,groups:Array}} The response parts.
 */
function handleGetJobs(ctx, msg) {
  const which = String(codec.attributeValue(msg, DELIMITER.OPERATION_ATTRIBUTES, 'which-jobs', 'not-completed'));
  const limit = codec.attributeValue(msg, DELIMITER.OPERATION_ATTRIBUTES, 'limit', 0) || Number.MAX_SAFE_INTEGER;
  const wantCompleted = which === 'completed';
  const jobs = [...ctx.state.jobs.values()]
    .filter((job) => FINISHED_STATES.has(job.state) === wantCompleted)
    .sort((a, b) => b.id - a.id)
    .slice(0, limit);
  return { statusCode: STATUS.OK, groups: jobs.map((job) => jobGroup(job, ctx.baseUri)) };
}

/**
 * @description Get-Job-Attributes / Cancel-Job shared lookup, then act.
 * @param {object} ctx The request context.
 * @param {object} msg The decoded request.
 * @param {boolean} cancel True to cancel instead of read.
 * @returns {{statusCode:number,groups?:Array}} The response parts.
 */
function handleJobById(ctx, msg, cancel) {
  const jobId = codec.attributeValue(msg, DELIMITER.OPERATION_ATTRIBUTES, 'job-id', -1);
  const job = ctx.state.jobs.get(jobId);
  if (!job) return { statusCode: STATUS.NOT_FOUND };
  if (cancel) {
    if (FINISHED_STATES.has(job.state)) return { statusCode: STATUS.NOT_POSSIBLE, groups: [jobGroup(job, ctx.baseUri)] };
    job.state = JOB_STATE.CANCELED;
    job.reason = 'job-canceled-by-user';
  }
  return { statusCode: STATUS.OK, groups: [jobGroup(job, ctx.baseUri)] };
}

/**
 * @description Route one decoded IPP request to its handler. Handlers that take
 * no document drain the (normally empty) stream so the request can finish.
 * @param {object} ctx The request context.
 * @param {object} msg The decoded request.
 * @param {import('stream').PassThrough} doc The document stream.
 * @returns {Promise<{statusCode:number,groups?:Array}>} The response parts.
 */
async function dispatchOperation(ctx, msg, doc) {
  const drained = (result) => {
    doc.resume();
    return result;
  };
  switch (msg.operationId) {
    case OPERATION.GET_PRINTER_ATTRIBUTES: return drained(handleGetPrinterAttributes(ctx, msg));
    case OPERATION.VALIDATE_JOB: return drained({ statusCode: STATUS.OK });
    case OPERATION.PRINT_JOB: return handlePrintJob(ctx, msg, doc);
    case OPERATION.CREATE_JOB: return drained({ statusCode: STATUS.OK, groups: [jobGroup(createJobEntry(ctx, msg, JOB_STATE.PENDING), ctx.baseUri)] });
    case OPERATION.SEND_DOCUMENT: return handleSendDocument(ctx, msg, doc);
    case OPERATION.CANCEL_JOB: return drained(handleJobById(ctx, msg, true));
    case OPERATION.GET_JOB_ATTRIBUTES: return drained(handleJobById(ctx, msg, false));
    case OPERATION.GET_JOBS: return drained(handleGetJobs(ctx, msg));
    default: return drained({ statusCode: STATUS.OPERATION_NOT_SUPPORTED });
  }
}

/**
 * @description Serve the human status page (GET /) for manual verification.
 * @param {object} ctx The server context.
 * @param {import('http').ServerResponse} res The HTTP response.
 * @returns {void}
 */
function respondStatusPage(ctx, res) {
  const uri = `ipp://${ctx.config.hostname}:${ctx.state.port}/ipp/print`;
  const html = `<!doctype html><meta charset="utf-8"><title>${ctx.config.printerName}</title>
<body style="font-family:system-ui;max-width:40em;margin:3em auto;line-height:1.5">
<h1>${ctx.config.printerName}</h1>
<p>Virtual IPP printer — jobs are saved to disk, nothing is printed on paper.</p>
<ul>
<li>Status: idle, accepting jobs</li>
<li>Jobs saved since start: ${ctx.state.saved}</li>
<li>Drop folder (on the host): <code>${ctx.config.dropDir}</code></li>
<li>Printer URI: <code>${uri}</code></li>
</ul>
<p>To add manually on Windows: Add printer &rarr; "The printer that I want isn't listed" &rarr;
"Select a shared printer by name" &rarr; <code>http://${ctx.config.hostname}:${ctx.state.port}/ipp/print</code></p>
</body>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

/**
 * @description Handle one HTTP request: status page on GET, IPP on POST.
 * @param {object} ctx The server context.
 * @param {import('http').IncomingMessage} req The HTTP request.
 * @param {import('http').ServerResponse} res The HTTP response.
 * @returns {void}
 */
function handleHttpRequest(ctx, req, res) {
  const route = (ctx.extraRoutes || []).find((r) => req.url && req.url.startsWith(r.prefix));
  if (route) return route.handler(req, res);
  if (req.method === 'GET') return respondStatusPage(ctx, res);
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return undefined;
  }
  collectMessage(req, (err, msg, doc) => {
    if (err) {
      const head = (err.capturedBytes || Buffer.alloc(0)).slice(0, 64);
      ctx.log.warn('rejected malformed IPP request', {
        client: clientAddress(req),
        error: err.message,
        method: req.method,
        url: req.url,
        contentType: req.headers['content-type'] || '(none)',
        contentLength: req.headers['content-length'] || '(none)',
        totalBytes: (err.capturedBytes || Buffer.alloc(0)).length,
        headHex: head.toString('hex'),
        headAscii: head.toString('latin1').replace(/[^\x20-\x7e]/g, '.'),
      });
      res.writeHead(400).end();
      return;
    }
    const requestCtx = { ...ctx, clientIp: clientAddress(req), baseUri: `ipp://${ctx.config.hostname}:${ctx.state.port}/ipp/print` };
    dispatchOperation(requestCtx, msg, doc)
      .then((result) => sendIppResponse(res, msg, result))
      .catch((dispatchErr) => {
        ctx.log.error('IPP dispatch failed', { operation: msg.operationId, error: dispatchErr.message, stack: dispatchErr.stack });
        sendIppResponse(res, msg, { statusCode: STATUS.INTERNAL_ERROR });
      });
  });
  return undefined;
}

/**
 * @description Write an encoded IPP response; tolerates a connection already torn
 * down (e.g. after hard-aborting an oversized job).
 * @param {import('http').ServerResponse} res The HTTP response.
 * @param {object} msg The decoded request.
 * @param {{statusCode:number,groups?:Array}} result The handler result.
 * @returns {void}
 */
function sendIppResponse(res, msg, result) {
  try {
    const body = buildResponse(msg, result.statusCode, result.groups);
    res.writeHead(200, { 'content-type': 'application/ipp', 'content-length': body.length });
    res.end(body);
  } catch (_err) {
    res.destroy();
  }
}

/**
 * @description Normalize a socket address (strip the IPv6-mapped-IPv4 prefix).
 * @param {import('http').IncomingMessage} req The HTTP request.
 * @returns {string} The client address.
 */
function clientAddress(req) {
  return String((req.socket && req.socket.remoteAddress) || 'unknown').replace(/^::ffff:/, '');
}

/**
 * @description Create and start the IPP HTTP server.
 * @param {{printerName:string,printerInfo:string,printerLocation:string,hostname:string,port:number,bindAddress:string,dropDir:string,maxBytes:number,uuidUri:string}} config Server configuration.
 * @param {{info:Function,warn:Function,error:Function}} log Structured logger.
 * @returns {Promise<{server:import('http').Server,state:object,ctx:object}>} The running server; state.port carries the bound port.
 */
function startIppServer(config, log) {
  const state = { startedAt: Date.now(), jobs: new Map(), nextJobId: 1, saved: 0, port: config.port };
  const ctx = { config, state, log, extraRoutes: [] };
  const server = http.createServer((req, res) => handleHttpRequest(ctx, req, res));
  server.on('checkContinue', (req, res) => {
    res.writeContinue();
    handleHttpRequest(ctx, req, res);
  });
  server.requestTimeout = 30 * 60 * 1000;
  server.headersTimeout = 60 * 1000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.bindAddress, () => {
      state.port = server.address().port;
      resolve({ server, state, ctx });
    });
  });
}

module.exports = { startIppServer, JOB_STATE };
