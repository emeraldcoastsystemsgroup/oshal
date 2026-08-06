/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted legacy POST /api/process-ticket queue-manager dispatch.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: retire the legacy execution entrypoint because it lacked the canonical immutable capability carrier, exact owner binding, and pre-acceptance autonomous-provider check.
 */

'use strict';

/**
 * @description Register a deterministic retirement response for the legacy ticket execution
 * endpoint. Controllers must use `/api/swarm-execute`, whose service identity, owner,
 * capability snapshot, provider preflight, and workspace binding are enforced together.
 * @param {object} application - The any-bot Application instance.
 * @returns {void}
 */
function registerProcessTicketRoute(application) {
  application.app.post('/api/process-ticket', (_req, res) => {
    res.status(410).json({
      error: 'legacy_execution_route_retired',
      replacement: '/api/swarm-execute',
    });
  });
}

module.exports = { registerProcessTicketRoute };
