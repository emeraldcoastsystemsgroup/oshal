/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * MeshProtocol — Protocol Constants, Signal Types & Validation
 *
 * Foundation module for the Private Mesh Protocol. Defines all signal types,
 * mesh scopes, status enums, and provides factory/validation utilities for
 * mesh signal envelopes.
 * 
 * Created: 2026-02-19 — Issue #018, PHASE_24
 */

const crypto = require('crypto');

// ═══ Mesh Signal Types ═══
/**
 * @description Canonical set of control-plane signal types that drive the
 * private mesh lifecycle (invite/accept, messaging, delegation, teardown).
 * Used as the authoritative allow-list so signals are validated against a
 * single source of truth across producers and consumers.
 */
const MESH_SIGNAL_TYPES = {
  MESH_INVITE:     'MESH_INVITE',      // Invite agent(s) to join a private mesh
  MESH_ACCEPT:     'MESH_ACCEPT',      // Accept invitation
  MESH_DECLINE:    'MESH_DECLINE',     // Decline invitation
  MESH_MESSAGE:    'MESH_MESSAGE',     // Send message within private mesh
  MESH_DELEGATE:   'MESH_DELEGATE',    // Delegate sub-task to mesh member
  MESH_RESULT:     'MESH_RESULT',      // Return result from delegation
  MESH_LEAVE:      'MESH_LEAVE',       // Leave a private mesh
  MESH_DISSOLVE:   'MESH_DISSOLVE',    // Dissolve entire mesh (owner only)
  MESH_HEARTBEAT:  'MESH_HEARTBEAT',   // Keep mesh alive (reset TTL)
};

// ═══ Mesh Scopes ═══
/**
 * @description Origin/intent categories for a mesh. Scope governs default TTL
 * and how a mesh is created (auto for ticket processing vs. ad-hoc vs. dashboard
 * delegation), keeping lifecycle policy keyed off a stable enum.
 */
const MESH_SCOPES = {
  TICKET:    'ticket',     // Auto-created for multi-agent ticket processing
  ADHOC:     'adhoc',      // Created ad-hoc by any agent
  DASHBOARD: 'dashboard',  // Created from dashboard chat for specialist delegation
};

// ═══ Mesh Status ═══
/**
 * @description Lifecycle states a mesh channel transitions through, from
 * forming through active to dissolved. Centralized so state-machine checks
 * and persistence stay consistent.
 */
const MESH_STATUS = {
  FORMING:    'forming',
  ACTIVE:     'active',
  DISSOLVING: 'dissolving',
  DISSOLVED:  'dissolved',
};

// ═══ Message Types ═══
/**
 * @description Classification of payloads exchanged inside a mesh so consumers
 * can route/render them appropriately (plain text vs. delegation vs. result vs.
 * system notices).
 */
const MESSAGE_TYPES = {
  TEXT:       'text',
  DELEGATION: 'delegation',
  RESULT:    'result',
  SYSTEM:    'system',
};

// ═══ TTL Defaults (seconds) ═══
/**
 * @description Per-scope default time-to-live (in seconds) applied when a mesh
 * is created without an explicit TTL, bounding how long idle meshes survive
 * before expiry.
 */
const DEFAULT_TTL = {
  ticket:    3600,  // 1 hour for ticket-scoped meshes
  adhoc:     1800,  // 30 min for ad-hoc meshes
  dashboard: 1800,  // 30 min for dashboard-scoped meshes
};

// ═══ Redis Key Prefixes ═══
/**
 * @description Namespacing prefixes for the Redis structures backing the mesh
 * (channel state, message history, agent membership, pub/sub channels). Kept in
 * one place to avoid drift between readers and writers of these keys.
 */
const REDIS_KEYS = {
  CHANNEL:       'mesh:channel:',       // Hash — mesh channel state
  MESSAGES:      'mesh:messages:',      // List — message history
  AGENT_MESHES:  'mesh:agent:',         // Set — meshes an agent belongs to
  PUBSUB:        'mesh:pubsub:',        // Pub/sub channel name prefix
};

/**
 * Generate a unique mesh ID
 * @param {string} scope - 'ticket', 'adhoc', or 'dashboard'
 * @param {string} [ticketId] - Plane ticket ID (for ticket scope)
 * @returns {string} Mesh ID
 */
function generateMeshId(scope, ticketId) {
  const ts = Date.now();
  const rand = crypto.randomBytes(4).toString('hex');
  if (scope === 'ticket' && ticketId) {
    const shortTicket = ticketId.substring(0, 8);
    return `mesh:${shortTicket}:${ts}`;
  }
  return `mesh:${scope}:${rand}:${ts}`;
}

/**
 * Create a mesh signal envelope with UUID and timestamp
 * @param {string} type - One of MESH_SIGNAL_TYPES
 * @param {string} meshId - Target mesh channel ID
 * @param {string} source - Sender agent_id
 * @param {Object} payload - Signal-specific payload
 * @param {string} [target] - Specific target agent_id (optional)
 * @returns {Object} Complete mesh signal envelope
 */
function createSignal(type, meshId, source, payload = {}, target = null) {
  if (!MESH_SIGNAL_TYPES[type]) {
    throw new Error(`Invalid mesh signal type: ${type}. Valid types: ${Object.keys(MESH_SIGNAL_TYPES).join(', ')}`);
  }
  return {
    type,
    mesh_id: meshId,
    source,
    target: target || null,
    payload,
    timestamp: new Date().toISOString(),
    signal_id: `msig_${crypto.randomBytes(8).toString('hex')}`,
  };
}

/**
 * Validate a mesh signal structure
 * @param {Object} signal - Signal to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateSignal(signal) {
  const errors = [];

  if (!signal || typeof signal !== 'object') {
    return { valid: false, errors: ['Signal must be an object'] };
  }
  if (!signal.type || !MESH_SIGNAL_TYPES[signal.type]) {
    errors.push(`Invalid or missing signal type: ${signal.type}`);
  }
  if (!signal.mesh_id || typeof signal.mesh_id !== 'string') {
    errors.push('Missing or invalid mesh_id');
  }
  if (!signal.source || typeof signal.source !== 'string') {
    errors.push('Missing or invalid source agent_id');
  }
  if (!signal.signal_id || typeof signal.signal_id !== 'string') {
    errors.push('Missing or invalid signal_id');
  }
  if (!signal.timestamp) {
    errors.push('Missing timestamp');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Create a MeshChannel state object
 * @param {Object} opts
 * @returns {Object} MeshChannel
 */
function createChannelState(opts = {}) {
  const scope = opts.scope || MESH_SCOPES.ADHOC;
  return {
    mesh_id:         opts.mesh_id || generateMeshId(scope, opts.ticket_id),
    topic:           opts.topic || 'Untitled mesh',
    owner_agent_id:  opts.owner_agent_id || 'unknown',
    members:         opts.members || [opts.owner_agent_id],
    ticket_id:       opts.ticket_id || null,
    task_id:         opts.task_id || null,
    scope,
    status:          MESH_STATUS.FORMING,
    created_at:      new Date().toISOString(),
    ttl_seconds:     opts.ttl_seconds || DEFAULT_TTL[scope] || 1800,
    message_count:   0,
  };
}

module.exports = {
  MESH_SIGNAL_TYPES,
  MESH_SCOPES,
  MESH_STATUS,
  MESSAGE_TYPES,
  DEFAULT_TTL,
  REDIS_KEYS,
  generateMeshId,
  createSignal,
  validateSignal,
  createChannelState,
};
