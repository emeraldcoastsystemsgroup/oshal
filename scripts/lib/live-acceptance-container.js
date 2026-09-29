#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the in-container half of the host live-acceptance runner. scripts/operations/live-acceptance.js stages this file (with live-acceptance-common.js and live-acceptance-sql.js) into the api container once per run and executes one operation per call, the request forwarded BY NAME in OSHAL_LIVE_ACCEPTANCE_REQUEST. Every operation runs under the owner's own request identity through the image's compiled pool, ticket service and workspace root: a NAMED statement from the closed set (never SQL text), a ticket read or delete, and the ask-workspace state or removal for a fixture-tagged id. It prints one RESULT line.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | A `file-state` op: whether the file a NAMED probe from the closed set (live-acceptance-common.js FILE_PROBES) resolves exists in this container, for an id the probe validates. It needs no pool and never takes a path. The vids-publish case uses it to prove the attached MP4 is on disk after attach and gone after cleanup.
 */

'use strict';

const path = require('node:path');
const common = require('./live-acceptance-common.js');
const { statementText } = require('./live-acceptance-sql.js');

const REQUEST_ENV = 'OSHAL_LIVE_ACCEPTANCE_REQUEST';
const RESULT_PREFIX = 'RESULT ';
const OPS = Object.freeze(['sql', 'ticket-get', 'ticket-delete', 'workspace-state', 'workspace-remove', 'file-state']);
/** Operations that read the container's filesystem only, so they open no database pool. */
const POOL_FREE_OPS = Object.freeze(['workspace-state', 'workspace-remove', 'file-state']);

/**
 * @description Parse and validate one request.
 * @param {unknown} raw - The JSON text from the environment.
 * @returns {{op: string, sub: string, name?: string, params?: unknown[], id?: string}} The request.
 * @throws {Error} On any malformed request.
 */
function parseRequest(raw) {
  const request = JSON.parse(String(raw || ''));
  if (!request || typeof request !== 'object' || !OPS.includes(request.op)) throw new Error('unknown or missing op');
  if (typeof request.sub !== 'string' || !request.sub.trim()) throw new Error('an owner subject is required');
  if (request.op === 'sql') {
    statementText(request.name);
    if (!Array.isArray(request.params)) throw new Error('params must be an array');
  } else if (request.op === 'file-state') {
    common.fileProbePath(request.name, request.id);
  } else if (typeof request.id !== 'string' || !request.id) throw new Error('an id is required');
  return request;
}

/**
 * @description The image's compiled modules this helper runs on.
 * @param {string} dist - The compiled tree (default /app/dist).
 * @returns {object} Pool factory, identity scope, ticket classes and workspace root resolver.
 */
function loadDist(dist) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  return {
    createOptionalPostgresPool: require(path.join(dist, 'shared/services/database/optional-postgres-pool.js')).createOptionalPostgresPool,
    runWithRequestIdentity: require(path.join(dist, 'shared/services/database/request-identity.js')).runWithRequestIdentity,
    TicketService: require(path.join(dist, 'features/ticketing/services/ticket-service.js')).TicketService,
    PostgresTicketStore: require(path.join(dist, 'features/ticketing/services/ticket-store-postgres.js')).PostgresTicketStore,
    resolveSharedWorkspaceRoot: require(path.join(dist, 'shared/workspace-root.js')).resolveSharedWorkspaceRoot,
  };
  /* eslint-enable @typescript-eslint/no-require-imports */
}

/**
 * @description The public projection of a ticket (what a case revalidates before deleting).
 * @param {object|null} ticket - The ticket service's record.
 * @returns {object|null} ticketId, ownerSub, ticketType, status, metadata.
 */
function ticketView(ticket) {
  if (!ticket) return null;
  return { ticketId: ticket.ticketId, ownerSub: ticket.ownerSub, ticketType: ticket.ticketType, status: ticket.status, metadata: ticket.metadata || {} };
}

/**
 * @description Execute one validated request under the owner's identity.
 * @param {ReturnType<typeof parseRequest>} request - The request.
 * @param {object} deps - pool, runWithRequestIdentity, tickets, workspaceRoot.
 * @returns {Promise<object>} The operation's payload.
 */
async function execute(request, deps) {
  if (request.op === 'file-state') return { state: common.fileProbeState(request.name, request.id) };
  if (request.op === 'workspace-state') return { state: common.fixtureWorkspaceState(deps.workspaceRoot, request.id) };
  if (request.op === 'workspace-remove') return { error: common.removeFixtureWorkspace(deps.workspaceRoot, request.id, request.sub) };
  return deps.runWithRequestIdentity({ sub: request.sub, isOperator: false }, async () => {
    if (request.op === 'sql') return { rows: (await deps.pool.query(statementText(request.name), request.params)).rows };
    if (request.op === 'ticket-get') return { ticket: ticketView(await deps.tickets.getTicket(request.id)) };
    await deps.tickets.deleteTicket(request.id);
    return { deleted: true };
  });
}

/**
 * @description Container entry: run the forwarded request and print one RESULT line.
 * @returns {Promise<void>} Resolves after printing; the process exit code reports success.
 */
async function main() {
  let pool = null;
  try {
    const request = parseRequest(process.env[REQUEST_ENV]);
    const dist = loadDist(process.env.OSHAL_ACCEPTANCE_DIST_DIR || path.join(process.cwd(), 'dist'));
    pool = POOL_FREE_OPS.includes(request.op) ? null : dist.createOptionalPostgresPool('live-acceptance');
    if (!pool && !POOL_FREE_OPS.includes(request.op)) throw new Error('this container has no PostgreSQL configuration');
    const payload = await execute(request, {
      pool, runWithRequestIdentity: dist.runWithRequestIdentity, workspaceRoot: dist.resolveSharedWorkspaceRoot(),
      tickets: pool ? new dist.TicketService(new dist.PostgresTicketStore(pool)) : null,
    });
    process.stdout.write(`${RESULT_PREFIX}${JSON.stringify({ ok: true, ...payload })}\n`);
  } catch (error) {
    process.stdout.write(`${RESULT_PREFIX}${JSON.stringify({ ok: false, error: common.errorText(error) })}\n`);
    process.exitCode = 1;
  } finally {
    if (pool && typeof pool.end === 'function') await pool.end().catch(() => undefined);
  }
}

if (require.main === module) main();

module.exports = { REQUEST_ENV, RESULT_PREFIX, OPS, POOL_FREE_OPS, parseRequest, ticketView, execute };
