/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-119 P4 (A2): POST /api/self-heal/apply — the deterministic (no-LLM) remediation endpoint the controller's auto-apply engine calls on the self-healing bot node. Two actions over the SAME selfHealingTools implementations the LLM tool path uses: 'restart' (restart-container, node-side oshal-/swarm- whitelist enforced inside the tool) and 'check' (check-container-health, the verification observation). FAIL-CLOSED auth, stricter than /api/swarm-execute: no SWARM_SERVICE_SECRET configured or no matching X-Service-Secret => 401 always — a container-restarting endpoint is never open, even in local dev. Role-gated at request time: only the self-healing node (ENABLE_SELF_HEALING_SCHEDULER / BOT_NAME=self-healing-bot — the same gate the scheduler uses) serves it; every other bot 403s visibly rather than connection-refusing.
 */

'use strict';

const logger = require('../utils/logger');
const { validServiceSecret } = require('../services/codebase/swarm-execute-auth');
const selfHealingTools = require('../services/tools/selfHealingTools');

/**
 * @description Whether THIS container is the designated self-healing node — the exact
 * gate startup-swarm-runtime.js uses for the SelfHealingScheduler, so the apply endpoint
 * and the scheduler can never disagree about who holds the remediation role.
 * @returns {boolean} True on the self-healing node only.
 */
function isSelfHealingNode() {
  return (
    process.env.ENABLE_SELF_HEALING_SCHEDULER === 'true' ||
    (process.env.AGENT_ID || '') === 'self-healing-bot' ||
    (process.env.BOT_NAME || '') === 'self-healing-bot'
  );
}

/**
 * @description Registers POST /api/self-heal/apply (ADR-119 A2). Body:
 * `{ action: 'restart'|'check', container: 'oshal-local-…' }`. The response is the tool
 * result verbatim (restart: before/after states; check: status/health/uptime) so the
 * controller's verification loop reads real observations, not a summary.
 * @param {import('../app')} application - The Application instance (holds .app).
 * @returns {void}
 */
function registerSelfHealApplyRoutes(application) {
  application.app.post('/api/self-heal/apply', async (req, res) => {
    // FAIL-CLOSED: unlike the swarm-execute gate there is NO anonymous local-dev allowance
    // here — restarting containers is an outward act, so no secret means no endpoint.
    if (!validServiceSecret(req)) {
      logger.warn('[self-heal-apply] Rejected: missing/invalid X-Service-Secret (endpoint is fail-closed)');
      return res.status(401).json({ success: false, error: 'unauthorized' });
    }
    if (!isSelfHealingNode()) {
      return res.status(403).json({ success: false, error: 'self-heal apply is not enabled on this node' });
    }
    const { action, container } = req.body || {};
    if (typeof container !== 'string' || !container.trim()) {
      return res.status(400).json({ success: false, error: 'container is required' });
    }
    try {
      if (action === 'restart') {
        logger.info(`[self-heal-apply] restart requested for ${container} (controller auto-apply, ADR-119 A2)`);
        const result = await selfHealingTools['restart-container']({ container_name: container.trim() });
        return res.status(result.success ? 200 : 422).json(result);
      }
      if (action === 'check') {
        const result = await selfHealingTools['check-container-health']({ container_name: container.trim() });
        return res.status(200).json(result);
      }
      return res.status(400).json({ success: false, error: `unknown action: ${String(action)}` });
    } catch (err) {
      logger.error(`[self-heal-apply] ${action} failed for ${container}: ${err.message}`);
      return res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registerSelfHealApplyRoutes };
