/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * MeshChannelStore — Redis-Backed Storage for Private Mesh Channels
 *
 * Thin wrapper around Redis Hash + List operations for mesh channel state
 * and message history persistence. Each mesh channel is stored as:
 *   - Redis Hash  `mesh:channel:{mesh_id}` → channel state (members, topic, etc.)
 *   - Redis List  `mesh:messages:{mesh_id}` → ordered message history
 *   - Redis Set   `mesh:agent:{agent_id}`   → set of mesh IDs this agent belongs to
 * 
 * Created: 2026-02-19 — Issue #018, PHASE_24
 */

const logger = require('../../utils/logger');
const { REDIS_KEYS, MESH_STATUS } = require('./MeshProtocol');

/**
 * @description Persistence layer that maps the lifecycle of a private mesh
 * channel onto Redis primitives, keeping volatile collaboration state out of
 * application memory so it survives process restarts and can be shared across
 * workers. Channel metadata lives in a Hash, ordered message history in a List,
 * and per-agent membership in a Set; TTLs let abandoned meshes expire on their
 * own. Every method degrades to a safe no-op when no Redis client is supplied,
 * so the surrounding system can run (in a reduced mode) without Redis.
 */
class MeshChannelStore {
  /**
   * @param {Object} redis - ioredis client (command client, NOT the subscriber)
   */
  constructor(redis) {
    this.redis = redis;
    if (!redis) {
      logger.warn('[MeshStore] No Redis client — mesh storage will be no-op');
    }
  }

  // ═══════════════════════════════════════════
  // Channel State (Redis Hash)
  // ═══════════════════════════════════════════

  /**
   * Create a new mesh channel in Redis
   * @param {Object} channel - MeshChannel state object
   * @returns {Promise<boolean>}
   */
  async createChannel(channel) {
    if (!this.redis) return false;
    const key = REDIS_KEYS.CHANNEL + channel.mesh_id;
    try {
      // Flatten for Redis Hash (arrays → JSON strings)
      const flat = {
        mesh_id:        channel.mesh_id,
        topic:          channel.topic,
        owner_agent_id: channel.owner_agent_id,
        members:        JSON.stringify(channel.members || []),
        ticket_id:      channel.ticket_id || '',
        task_id:        channel.task_id || '',
        scope:          channel.scope,
        status:         channel.status,
        created_at:     channel.created_at,
        ttl_seconds:    String(channel.ttl_seconds),
        message_count:  '0',
      };
      await this.redis.hmset(key, flat);
      await this.redis.expire(key, channel.ttl_seconds);

      // Track membership for each member
      for (const memberId of (channel.members || [])) {
        await this._addAgentMesh(memberId, channel.mesh_id);
      }

      logger.info(`[MeshStore] Channel created: ${channel.mesh_id} (scope=${channel.scope}, ttl=${channel.ttl_seconds}s)`);
      return true;
    } catch (err) {
      logger.error(`[MeshStore] createChannel failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Get mesh channel state
   * @param {string} meshId
   * @returns {Promise<Object|null>}
   */
  async getChannel(meshId) {
    if (!this.redis) return null;
    const key = REDIS_KEYS.CHANNEL + meshId;
    try {
      const raw = await this.redis.hgetall(key);
      if (!raw || !raw.mesh_id) return null;
      // Return a copy to avoid mutating Redis-stored data
      const data = { ...raw };
      // Parse arrays back from JSON (members may be a JSON string or already an array)
      if (typeof data.members === 'string') {
        try { data.members = JSON.parse(data.members); } catch { data.members = []; }
      } else if (!Array.isArray(data.members)) {
        data.members = [];
      }
      data.ttl_seconds = parseInt(data.ttl_seconds) || 1800;
      data.message_count = parseInt(data.message_count) || 0;
      return data;
    } catch (err) {
      logger.error(`[MeshStore] getChannel failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Update specific fields on a mesh channel
   * @param {string} meshId
   * @param {Object} updates - Key-value pairs to update
   * @returns {Promise<boolean>}
   */
  async updateChannel(meshId, updates) {
    if (!this.redis) return false;
    const key = REDIS_KEYS.CHANNEL + meshId;
    try {
      const flat = {};
      for (const [k, v] of Object.entries(updates)) {
        flat[k] = Array.isArray(v) ? JSON.stringify(v) : String(v);
      }
      await this.redis.hmset(key, flat);
      return true;
    } catch (err) {
      logger.error(`[MeshStore] updateChannel failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Add a member to a mesh channel
   * @param {string} meshId
   * @param {string} agentId
   * @returns {Promise<boolean>}
   */
  async addMember(meshId, agentId) {
    if (!this.redis) return false;
    try {
      const channel = await this.getChannel(meshId);
      if (!channel) return false;
      if (!channel.members.includes(agentId)) {
        channel.members.push(agentId);
        await this.updateChannel(meshId, { members: channel.members });
        await this._addAgentMesh(agentId, meshId);
      }
      return true;
    } catch (err) {
      logger.error(`[MeshStore] addMember failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Remove a member from a mesh channel
   * @param {string} meshId
   * @param {string} agentId
   * @returns {Promise<boolean>}
   */
  async removeMember(meshId, agentId) {
    if (!this.redis) return false;
    try {
      const channel = await this.getChannel(meshId);
      if (!channel) return false;
      channel.members = channel.members.filter(m => m !== agentId);
      await this.updateChannel(meshId, { members: channel.members });
      await this._removeAgentMesh(agentId, meshId);
      return true;
    } catch (err) {
      logger.error(`[MeshStore] removeMember failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Check if an agent is a member of a mesh
   * @param {string} meshId
   * @param {string} agentId
   * @returns {Promise<boolean>}
   */
  async isMember(meshId, agentId) {
    if (!this.redis) return false;
    try {
      const channel = await this.getChannel(meshId);
      if (!channel) return false;
      return channel.members.includes(agentId);
    } catch {
      return false;
    }
  }

  // ═══════════════════════════════════════════
  // Message History (Redis List)
  // ═══════════════════════════════════════════

  /**
   * Append a message to the mesh's message history
   * @param {string} meshId
   * @param {Object} message - MeshMessage object
   * @returns {Promise<boolean>}
   */
  async appendMessage(meshId, message) {
    if (!this.redis) return false;
    const listKey = REDIS_KEYS.MESSAGES + meshId;
    const channelKey = REDIS_KEYS.CHANNEL + meshId;
    try {
      await this.redis.rpush(listKey, JSON.stringify(message));
      // Sync TTL with channel
      const ttl = await this.redis.ttl(channelKey);
      if (ttl > 0) {
        await this.redis.expire(listKey, ttl);
      }
      // Increment message count
      await this.redis.hincrby(channelKey, 'message_count', 1);
      return true;
    } catch (err) {
      logger.error(`[MeshStore] appendMessage failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Get message history for a mesh
   * @param {string} meshId
   * @param {number} [start=0]
   * @param {number} [end=-1] - -1 for all
   * @returns {Promise<Object[]>}
   */
  async getMessages(meshId, start = 0, end = -1) {
    if (!this.redis) return [];
    const key = REDIS_KEYS.MESSAGES + meshId;
    try {
      const raw = await this.redis.lrange(key, start, end);
      return raw.map(r => {
        try { return JSON.parse(r); } catch { return { raw: r }; }
      });
    } catch (err) {
      logger.error(`[MeshStore] getMessages failed: ${err.message}`);
      return [];
    }
  }

  /**
   * ⭐ PHASE_32 Issue #030: Get message count for a mesh
   * @param {string} meshId
   * @returns {Promise<number>}
   */
  async getMessageCount(meshId) {
    if (!this.redis) return 0;
    const key = REDIS_KEYS.MESSAGES + meshId;
    try {
      const count = await this.redis.llen(key);
      return count || 0;
    } catch (err) {
      logger.error(`[MeshStore] getMessageCount failed: ${err.message}`);
      return 0;
    }
  }

  // ═══════════════════════════════════════════
  // Agent Membership Tracking (Redis Set)
  // ═══════════════════════════════════════════

  /**
   * List all meshes an agent is currently a member of
   * @param {string} agentId
   * @returns {Promise<string[]>} Array of mesh IDs
   */
  async listMeshesForAgent(agentId) {
    if (!this.redis) return [];
    const key = REDIS_KEYS.AGENT_MESHES + agentId;
    try {
      const meshIds = await this.redis.smembers(key);
      // Filter out dissolved/expired meshes
      const active = [];
      for (const meshId of meshIds) {
        const channel = await this.getChannel(meshId);
        if (channel && channel.status !== MESH_STATUS.DISSOLVED) {
          active.push(meshId);
        } else {
          // Stale reference — clean up
          await this.redis.srem(key, meshId);
        }
      }
      return active;
    } catch (err) {
      logger.error(`[MeshStore] listMeshesForAgent failed: ${err.message}`);
      return [];
    }
  }

  // ═══════════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════════

  /**
   * Delete all data for a mesh channel
   * @param {string} meshId
   * @returns {Promise<boolean>}
   */
  async deleteChannel(meshId) {
    if (!this.redis) return false;
    try {
      // Get members before deletion to clean up their sets
      const channel = await this.getChannel(meshId);
      if (channel && channel.members) {
        for (const memberId of channel.members) {
          await this._removeAgentMesh(memberId, meshId);
        }
      }
      // Delete channel hash + message list
      await this.redis.del(REDIS_KEYS.CHANNEL + meshId);
      await this.redis.del(REDIS_KEYS.MESSAGES + meshId);
      logger.info(`[MeshStore] Channel deleted: ${meshId}`);
      return true;
    } catch (err) {
      logger.error(`[MeshStore] deleteChannel failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Reset TTL on a mesh channel (heartbeat)
   * @param {string} meshId
   * @param {number} ttlSeconds
   * @returns {Promise<boolean>}
   */
  async refreshTTL(meshId, ttlSeconds) {
    if (!this.redis) return false;
    try {
      await this.redis.expire(REDIS_KEYS.CHANNEL + meshId, ttlSeconds);
      await this.redis.expire(REDIS_KEYS.MESSAGES + meshId, ttlSeconds);
      return true;
    } catch (err) {
      logger.error(`[MeshStore] refreshTTL failed: ${err.message}`);
      return false;
    }
  }

  // ═══════════════════════════════════════════
  // Internal Helpers
  // ═══════════════════════════════════════════

  async _addAgentMesh(agentId, meshId) {
    const key = REDIS_KEYS.AGENT_MESHES + agentId;
    await this.redis.sadd(key, meshId);
    await this.redis.expire(key, 7200); // 2h TTL on agent mesh sets
  }

  async _removeAgentMesh(agentId, meshId) {
    const key = REDIS_KEYS.AGENT_MESHES + agentId;
    await this.redis.srem(key, meshId);
  }
}

module.exports = MeshChannelStore;
