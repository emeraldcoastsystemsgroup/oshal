/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * AgentPlaneUserMap - Maps agent IDs to Plane bot user UUIDs
 * 
 * These UUIDs match the deterministic IDs in plane/migrations/create-bot-users.sql.
 * 
 * ## Issue #005 Fix (2026-02-24)
 * Expanded from 11 agents to ALL 37 agents in ai-lab/bot-personas/.
 * UUID pattern: b0710001-a1ab-4000-8000-{sequential_hex padded to 12 chars}
 * 
 * When a new agent is added to the swarm:
 * 1. Add its mapping here
 * 2. Add its SQL entry to plane/migrations/create-bot-users.sql
 * 3. Run the migration: kubectl exec -n plane plane-db -- psql -U plane -d plane -f /migrations/create-bot-users.sql
 */

const logger = require('../../utils/logger');

/**
 * Static mapping: AGENT_ID → Plane user UUID
 * Must stay in sync with plane/migrations/create-bot-users.sql
 * 
 * Slots 001-00b: Original 11 agents (unchanged)
 * Slots 00c+:    New agents added in Issue #005
 */
const AGENT_TO_PLANE_USER = {
  // ── Original 11 agents (PHASE 11) ──────────────────────────────────────────
  'project-manager':          'b0710001-a1ab-4000-8000-000000000001',
  'task-manager':             'b0710001-a1ab-4000-8000-000000000002',
  'worker-general':           'b0710001-a1ab-4000-8000-000000000003',
  'code-reviewer':            'b0710001-a1ab-4000-8000-000000000004',
  'rca-specialist':           'b0710001-a1ab-4000-8000-000000000005',
  'presentation-bot':         'b0710001-a1ab-4000-8000-000000000006',
  'documentation-bot':        'b0710001-a1ab-4000-8000-000000000007',
  'research-bot':             'b0710001-a1ab-4000-8000-000000000008',
  'devops-bot':               'b0710001-a1ab-4000-8000-000000000009',
  'general-bot':              'b0710001-a1ab-4000-8000-00000000000a',
  // Orchestrator (used for QM's own comments)
  'queue-manager':            'b0710001-a1ab-4000-8000-00000000000b',

  // ── New agents added in Issue #005 (2026-02-24) ────────────────────────────
  '3d-printing-bot':          'b0710001-a1ab-4000-8000-00000000000c',
  'agent-factory-bot':        'b0710001-a1ab-4000-8000-00000000000d',
  'animatronics-bot':         'b0710001-a1ab-4000-8000-00000000000e',
  'code-reviewer-bot':        'b0710001-a1ab-4000-8000-00000000000f',
  'daily-standup-summary-bot':'b0710001-a1ab-4000-8000-000000000010',
  'data-extraction-bot':      'b0710001-a1ab-4000-8000-000000000011',
  'drives-specialist-bot':    'b0710001-a1ab-4000-8000-000000000012',
  'electrical-specialist-bot':'b0710001-a1ab-4000-8000-000000000013',
  'email-bot':                'b0710001-a1ab-4000-8000-000000000014',
  'facebook-bot':             'b0710001-a1ab-4000-8000-000000000015',
  'gcp-cli-bot':              'b0710001-a1ab-4000-8000-000000000016',
  'google-bot':               'b0710001-a1ab-4000-8000-000000000017',
  'hephaestus':               'b0710001-a1ab-4000-8000-000000000018',
  'incident-response-bot':    'b0710001-a1ab-4000-8000-000000000019',
  'log-analyzer-bot':         'b0710001-a1ab-4000-8000-00000000001a',
  'motivational-quotes-bot':  'b0710001-a1ab-4000-8000-00000000001b',
  'news-aggregator-bot':      'b0710001-a1ab-4000-8000-00000000001c',
  'personal-finance-bot':     'b0710001-a1ab-4000-8000-00000000001d',
  'physics-bot':              'b0710001-a1ab-4000-8000-00000000001e',
  'rca-specialist-bot':       'b0710001-a1ab-4000-8000-00000000001f',
  'robotics-bot':             'b0710001-a1ab-4000-8000-000000000020',
  'scheduler-bot':            'b0710001-a1ab-4000-8000-000000000021',
  'security-auditor-bot':     'b0710001-a1ab-4000-8000-000000000022',
  'self-healing-bot':         'b0710001-a1ab-4000-8000-000000000023',
  'slack-bot':                'b0710001-a1ab-4000-8000-000000000024',
  'small-motors-bot':         'b0710001-a1ab-4000-8000-000000000025',
  'video-bot':                'b0710001-a1ab-4000-8000-000000000026',
  'weather-bot':              'b0710001-a1ab-4000-8000-000000000027',
  'welding-specialist-bot':   'b0710001-a1ab-4000-8000-000000000028',

  // ── Mandatory swarm participants (Architect+Tester Sprint, 2026-02-24) ─────
  'architect-bot':            'b0710001-a1ab-4000-8000-000000000029',
  'tester-bot':               'b0710001-a1ab-4000-8000-00000000002a',
};

/**
 * Look up the Plane user UUID for an agent ID.
 * Falls back to queue-manager UUID for unknown agents, or null if even that fails.
 * @param {string} agentId - The AGENT_ID (e.g., 'research-bot')
 * @returns {string|null} Plane user UUID or null
 */
function getPlaneUserId(agentId) {
  if (!agentId) return AGENT_TO_PLANE_USER['queue-manager'] || null;
  
  const userId = AGENT_TO_PLANE_USER[agentId];
  if (userId) {
    return userId;
  }

  // Fallback: try lowercase/trimmed
  const normalized = agentId.toLowerCase().trim();
  const fallback = AGENT_TO_PLANE_USER[normalized];
  if (fallback) {
    return fallback;
  }

  logger.warn(`[AgentPlaneUserMap] No Plane user mapping for agent '${agentId}', using queue-manager fallback`);
  return AGENT_TO_PLANE_USER['queue-manager'] || null;
}

/**
 * Get the Queue Manager's own Plane user UUID (for system comments)
 * @returns {string} Queue Manager Plane user UUID
 */
function getQueueManagerUserId() {
  return AGENT_TO_PLANE_USER['queue-manager'];
}

/**
 * Check if a Plane user ID belongs to a bot
 * @param {string} planeUserId - UUID to check
 * @returns {boolean}
 */
function isBotUser(planeUserId) {
  return Object.values(AGENT_TO_PLANE_USER).includes(planeUserId);
}

/**
 * Get agent ID from Plane user UUID (reverse lookup)
 * @param {string} planeUserId - Plane user UUID
 * @returns {string|null} Agent ID or null
 */
function getAgentId(planeUserId) {
  for (const [agentId, uuid] of Object.entries(AGENT_TO_PLANE_USER)) {
    if (uuid === planeUserId) return agentId;
  }
  return null;
}

/**
 * Get all agent IDs that have Plane user mappings
 * @returns {string[]} List of agent IDs
 */
function getAllMappedAgentIds() {
  return Object.keys(AGENT_TO_PLANE_USER).filter(id => id !== 'queue-manager');
}

/**
 * Get total count of mapped agents (excluding queue-manager orchestrator)
 * @returns {number}
 */
function getMappedAgentCount() {
  return getAllMappedAgentIds().length;
}

module.exports = {
  AGENT_TO_PLANE_USER,
  getPlaneUserId,
  getQueueManagerUserId,
  isBotUser,
  getAgentId,
  getAllMappedAgentIds,
  getMappedAgentCount,
};
