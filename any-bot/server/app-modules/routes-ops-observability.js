/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from app.js (1000-line cap decomposition): docker service map + proxy-health, swarm logs, PHASE_15 redis visibility, QM activity, bot restart, dynamic dashboard nodes, dashboard test runner
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | /api/qm/activity stops lying about three maps it had the data for: agentTicketMappings was a hardcoded {} behind a "TODO: implement if needed", and cooldowns/locks scanned `qm:cooldown:*` / `qm:lock:*` — prefixes NOTHING in this codebase writes (the real keys are `qm:processed:*` and `qm:task_lock:*`), so the endpoint fetched key lists that were always empty and returned empty objects for live state. The dashboards render those maps, so an operator read "no agent owns any ticket / nothing is in cooldown / no task is locked" while the queue manager was holding all three. Now built from the keyspace: agent -> tickets from the ticket_phase/dispatch records, cooldowns with their real remaining window, locks with their holding agent, and the ticket->task mappings that were fetched and discarded.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Decomposed the /api/qm/activity handler (87 lines, three near-identical hand-rolled KEYS/GET/TTL loops) onto one readQmKeyspace reader plus named builders, so the handler is back under the function-size cap and every parse rule is unit-testable in isolation instead of only through a live Redis.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY: retire the unauthenticated dashboard test runner; its prefix-only path check allowed traversal to arbitrary JavaScript and the child inherited every bot/controller credential.
 */

const path = require('path');
const logger = require('../utils/logger');

// The original code lived in any-bot/server/ — keep filesystem anchors identical.
const SERVER_ROOT = path.join(__dirname, '..');

// ─── /api/qm/activity keyspace readers ──────────────────────────────────────
// The queue manager's live state is Redis keys, written elsewhere in this tree. These read them
// back for the ops surfaces. The prefixes are the ONES THAT ARE WRITTEN — see
// services/queue-manager/QueuePollingCoordinator.js (setProcessed -> qm:processed:<ticketId>,
// acquireTaskLock -> qm:task_lock:<taskId>) and PlaneTicketIO.js (qm:ticket_task:<ticketId>).
// Changing one of those writers without changing these constants makes the dashboards go blank
// while the system is busy, which is exactly the failure this replaced.
const QM_KEY_PREFIXES = {
  agent: 'queue-manager:agent:',
  ticketPhase: 'qm:ticket_phase:',
  dispatching: 'qm:dispatching:',
  ticketTask: 'qm:ticket_task:',
  cooldown: 'qm:processed:',
  taskLock: 'qm:task_lock:',
};

// Complexity -> cooldown window, mirroring QueuePollingCoordinator.getDynamicCooldown so the
// surface shows the SAME window the poller enforces. Unknown complexity falls back to the poller's
// configured default (QUEUE_MANAGER_COOLDOWN), read per call so a container env change is picked up.
const COOLDOWN_MS_BY_COMPLEXITY = { low: 60000, medium: 180000, high: 300000 };

// A hard ceiling on how many keys of one namespace we materialize per request. An ops endpoint must
// not turn into an unbounded fan-out of GET/TTL round-trips on a busy queue.
const QM_KEY_SCAN_LIMIT = 500;

/**
 * @description Read one `prefix:*` keyspace into `[{ id, value, ttl }]`, where `id` is the key with
 * the prefix stripped. Keys that expire between the KEYS scan and the GET are skipped rather than
 * reported as null entries — a TTL'd namespace is racy by construction and a half-read key is worse
 * than a missing one. Bounded by `limit` so one busy namespace cannot stall the endpoint.
 * @param {object} redis - Connected ioredis client.
 * @param {string} prefix - Full key prefix, including the trailing colon.
 * @param {number} [limit] - Maximum keys to materialize (default QM_KEY_SCAN_LIMIT).
 * @returns {Promise<Array<{id: string, value: string, ttl: number}>>} The live entries.
 */
async function readQmKeyspace(redis, prefix, limit = QM_KEY_SCAN_LIMIT) {
  const keys = await redis.keys(`${prefix}*`);
  const entries = [];
  for (const key of keys.slice(0, limit)) {
    const value = await redis.get(key);
    if (value === null || value === undefined) continue; // expired between KEYS and GET
    const ttl = await redis.ttl(key);
    entries.push({ id: key.slice(prefix.length), value: String(value), ttl: Number.isFinite(ttl) ? ttl : -1 });
  }
  return entries;
}

/**
 * @description Build the agent map keyed by agent id from `queue-manager:agent:*` entries. The
 * registry stores each agent as a JSON STRING (not a hash), and an unparseable payload is logged and
 * skipped rather than crashing the whole ops response — one corrupt agent key must not blank the
 * dashboard for every other agent.
 * @param {Array<{id: string, value: string, ttl: number}>} entries - Raw keyspace entries.
 * @returns {Object<string, object>} Agent id to its registry record, with ttl/status normalized.
 */
function buildAgentRegistry(entries) {
  const agents = {};
  for (const entry of entries || []) {
    let parsed = null;
    try { parsed = JSON.parse(entry.value); } catch (e) {
      logger.warn(`Failed to parse agent data for ${QM_KEY_PREFIXES.agent}${entry.id}: ${e.message}`);
      continue;
    }
    const agentId = parsed.agent_id || entry.id;
    agents[agentId] = {
      ...parsed,
      ttl: entry.ttl,
      lastHeartbeat: parsed.last_heartbeat,
      status: parsed.status || 'unknown',
      port: parsed.port || null,
    };
  }
  return agents;
}

/**
 * @description Parse a ticket-keyed keyspace (`qm:ticket_phase:*`, `qm:dispatching:*`) into records
 * carrying their ticket id and TTL. An unparseable payload is kept as `{ ticketId, raw, ttl }` — an
 * operator debugging a stuck ticket needs to SEE the malformed value, not have it silently vanish.
 * @param {Array<{id: string, value: string, ttl: number}>} entries - Raw keyspace entries.
 * @returns {Array<object>} One record per live key.
 */
function buildTicketRecords(entries) {
  return (entries || []).map((entry) => {
    try {
      return { ticketId: entry.id, ...JSON.parse(entry.value), ttl: entry.ttl };
    } catch (e) {
      return { ticketId: entry.id, raw: entry.value, ttl: entry.ttl };
    }
  });
}

/**
 * @description Build `agentId -> [ticketId]` from the ticket-phase and dispatch records already
 * read for this response. This is the map the ops dashboards count per agent ("N tickets"), and it
 * is derivable with no extra Redis traffic: a phase record names the agent executing (or assigned
 * to) the ticket, and a dispatch record names both sides directly.
 * @param {Array<object>} phases - Parsed `qm:ticket_phase:*` records (each carries `ticketId`).
 * @param {Array<object>} dispatches - Parsed `qm:dispatching:*` records (each carries `ticketId`).
 * @returns {Object<string, string[]>} Agent id to the ticket ids it currently owns, sorted.
 */
function buildAgentTicketMappings(phases, dispatches) {
  const mappings = new Map();
  const add = (agentId, ticketId) => {
    if (!agentId || !ticketId) return;
    const key = String(agentId);
    if (!mappings.has(key)) mappings.set(key, new Set());
    mappings.get(key).add(String(ticketId));
  };
  for (const phase of phases || []) add(phase.executingAgent || phase.assignedAgent, phase.ticketId);
  for (const dispatch of dispatches || []) {
    add(dispatch.agentId || dispatch.executingAgent || dispatch.assignedAgent, dispatch.ticketId);
  }
  return Object.fromEntries([...mappings.entries()].map(([agentId, tickets]) => [agentId, [...tickets].sort()]));
}

/**
 * @description Turn `qm:ticket_task:*` entries into `ticketId -> { taskId, ttl }`. These keys were
 * being scanned and thrown away; they are how the dispatcher re-finds the workspace task bound to a
 * ticket, so an operator debugging "which task is this ticket running as" needs exactly this map.
 * @param {Array<{id: string, value: string, ttl: number}>} entries - Raw keyspace entries.
 * @returns {Object<string, {taskId: string, ttl: number}>} Ticket id to its bound task.
 */
function buildTicketTaskMappings(entries) {
  const out = {};
  for (const entry of entries || []) out[entry.id] = { taskId: entry.value, ttl: entry.ttl };
  return out;
}

/**
 * @description Turn `qm:processed:*` entries into the cooldown map the queue manager is actually
 * enforcing: who processed the ticket, when, the window its complexity earns, and how much of that
 * window is left. `active:false` means the key still exists (1h TTL) but the ticket is re-eligible —
 * the distinction an operator needs when a ticket "isn't being picked up".
 * @param {Array<{id: string, value: string, ttl: number}>} entries - Raw keyspace entries.
 * @param {number} [now] - Clock override for deterministic tests.
 * @returns {Object<string, object>} Ticket id to its cooldown state.
 */
function buildCooldowns(entries, now = Date.now()) {
  const fallbackMs = parseInt(process.env.QUEUE_MANAGER_COOLDOWN || '300000', 10);
  const out = {};
  for (const entry of entries || []) {
    let parsed = null;
    try { parsed = JSON.parse(entry.value); } catch (e) { parsed = null; }
    if (!parsed || typeof parsed !== 'object') {
      out[entry.id] = { ticketId: entry.id, raw: entry.value, ttl: entry.ttl };
      continue;
    }
    const complexity = parsed.complexity || 'medium';
    const windowMs = COOLDOWN_MS_BY_COMPLEXITY[complexity] || fallbackMs;
    const processedAt = Number(parsed.processed_at) || 0;
    const elapsedMs = processedAt ? Math.max(0, now - processedAt) : Number.MAX_SAFE_INTEGER;
    out[entry.id] = {
      ticketId: entry.id,
      agentId: parsed.agent_id || null,
      complexity,
      processedAt,
      windowMs,
      remainingMs: Math.max(0, windowMs - elapsedMs),
      active: elapsedMs < windowMs,
      ttl: entry.ttl,
    };
  }
  return out;
}

/**
 * @description Turn `qm:task_lock:*` entries into `taskId -> { agentId, ttl }`. The lock value IS
 * the holding agent id (acquireTaskLock SETs it NX), so a held lock names the bot to look at when a
 * task is stuck — which is the whole reason the dashboard has a locks panel.
 * @param {Array<{id: string, value: string, ttl: number}>} entries - Raw keyspace entries.
 * @returns {Object<string, {taskId: string, agentId: string, ttl: number}>} Task id to lock holder.
 */
function buildTaskLocks(entries) {
  const out = {};
  for (const entry of entries || []) out[entry.id] = { taskId: entry.id, agentId: entry.value, ttl: entry.ttl };
  return out;
}

/**
 * @description DOCKER_SERVICE_MAP (mutable, exposed on application._dockerServiceMap), swarm log aggregator, PHASE_15 Redis visibility API, QM activity API, whitelisted bot restart, health proxy, service-map registration, dynamic health-dashboard node registration/listing, and the dashboard test-runner endpoints.
 * @param {object} application - The Application instance (owns the express app, stores, controllers, and services).
 * @returns {void}
 */
function registerOpsObservabilityRoutes(application) {
    // ═══════════════════════════════════════════
    // Health Proxy: Server-side health check proxy
    // Solves CORS issue — browser fetches from same origin, backend fetches target
    // ═══════════════════════════════════════════
    // Port→Docker service name mapping (inside Docker, localhost != host)
    // Port→Docker host mapping. Swarm agents are in a separate compose network,
    // so we use host.docker.internal. MCP servers share our network.
    // NOTE: This object is mutable — dynamically-deployed bots register via POST /api/service-map/register
    const DOCKER_SERVICE_MAP = application._dockerServiceMap || {
      3000: 'localhost',
      // Swarm agents — different compose network, access via host port-forward
      3010: 'host.docker.internal', 3011: 'host.docker.internal', 3012: 'host.docker.internal',
      3013: 'host.docker.internal', 3014: 'host.docker.internal', 3015: 'host.docker.internal',
      3016: 'host.docker.internal', 3017: 'host.docker.internal', 3018: 'host.docker.internal',
      3019: 'host.docker.internal',
      3020: 'host.docker.internal', 3021: 'host.docker.internal',
      3022: 'host.docker.internal', 3023: 'host.docker.internal', 3024: 'host.docker.internal',
      3025: 'host.docker.internal', 3026: 'host.docker.internal',
      3027: 'host.docker.internal', 3028: 'host.docker.internal', 3029: 'host.docker.internal',
      3030: 'host.docker.internal', 3031: 'host.docker.internal', 3032: 'host.docker.internal',
      // Dynamic bots use AGENT_EXTERNAL_PORT — no hardcoding needed (proxy defaults to host.docker.internal)



      // MCP servers — same compose network
      8080: 'google-search-mcp', 8081: 'presentron-mcp', 8091: 'chroma-mcp',
      // Shared
      6379: 'redis',
      // Plane infra — different compose network
      3001: 'host.docker.internal', 80: 'host.docker.internal', 8000: 'host.docker.internal',
    };

    // ═══ SWARM LOG AGGREGATOR ═══
    // Reads this node's own log file + provides structured log entries
    application.app.get('/api/swarm-logs', async (req, res) => {
      try {
        const fs = require('fs');
        const path = require('path');
        const tail = parseInt(req.query.tail || '200');
        const level = req.query.level || 'all'; // all, error, warn, info
        const search = req.query.search || '';
        // Try multiple log file paths (Winston writes to combined.log, not app.log)
        const logPaths = [
          path.join(SERVER_ROOT, '..', 'logs', 'combined.log'),
          path.join(SERVER_ROOT, '..', 'logs', 'app.log'),
          path.join(SERVER_ROOT, '..', 'logs', 'error.log'),
        ];
        let lines = [];
        
        for (const logPath of logPaths) {
          if (fs.existsSync(logPath)) {
            try {
              const content = fs.readFileSync(logPath, 'utf8');
              const fileLines = content.split('\n').filter(l => l.trim()).slice(-tail);
              if (fileLines.length > lines.length) {
                lines = fileLines; // Use the file with the most entries
              }
            } catch (e) { /* skip unreadable */ }
          }
        }
        
        // If no log files found, return helpful message
        if (lines.length === 0) {
          lines = ['No log files found. Winston writes to logs/combined.log. Use docker logs for container stdout.'];
        }

        // Filter by level
        if (level !== 'all') {
          lines = lines.filter(l => l.toLowerCase().includes(level));
        }

        // Filter by search term
        if (search) {
          const searchLower = search.toLowerCase();
          lines = lines.filter(l => l.toLowerCase().includes(searchLower));
        }

        // Parse into structured entries — handle BOTH Winston JSON and plain text formats
        const entries = lines.map((line, i) => {
          // Try JSON parse first (Winston file transport writes JSON)
          try {
            const parsed = JSON.parse(line);
            if (parsed.level && parsed.message) {
              return {
                id: i,
                timestamp: parsed.timestamp || '',
                level: parsed.level,
                message: parsed.message,
                raw: line
              };
            }
          } catch (e) { /* not JSON, fall through to plain text */ }
          
          // Plain text fallback (console format with ANSI codes)
          const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
          const levelMatch = line.match(/\[(info|warn|error|debug)\]/i);
          return {
            id: i,
            timestamp: tsMatch ? tsMatch[1] : '',
            level: levelMatch ? levelMatch[1].toLowerCase() : 'info',
            message: line.replace(/\x1b\[\d+m/g, ''), // Strip ANSI color codes
            raw: line
          };
        });

        res.json({ 
          success: true, 
          node: process.env.AGENT_ID || 'unknown',
          count: entries.length,
          entries 
        });
      } catch (err) {
        res.json({ success: false, error: err.message, entries: [] });
      }
    });

    // ════════════════════════════════════════════════════════════
    // PHASE_15: Redis Visibility API
    // GET /api/redis-visibility — Comprehensive Redis state for the Redis tab
    // Returns: agent registry, scheduled jobs, routing decisions, queue metrics
    // ════════════════════════════════════════════════════════════
    application.app.get('/api/redis-visibility', async (req, res) => {
      let redis = null;
      try {
        const Redis = require('ioredis');
        redis = new Redis({
          host: process.env.REDIS_HOST || 'oshal-redis',
          port: parseInt(process.env.REDIS_PORT || '6379'),
          password: process.env.REDIS_PASSWORD,
          maxRetriesPerRequest: 2,
          connectTimeout: 3000,
        });

        const result = {
          timestamp: new Date().toISOString(),
          redisInsightUrl: 'http://localhost:5540',
          agentRegistry: [],
          scheduledJobs: [],
          routingDecisions: [],
          queueMetrics: {},
          rawKeyStats: {},
        };

        // ── 1. Agent Registry ──────────────────────────────────
        try {
          // Known host-port mapping for all swarm bots (from docker-compose.swarm-local.yml)
          // Used as fallback when agent.port is null (dynamic bots, worker bots without AGENT_EXTERNAL_PORT)
          const KNOWN_AGENT_PORTS = {
            'project-manager': 3010, 'task-manager': 3011, 'worker-general': 3012,
            'code-reviewer': 3013, 'rca-specialist': 3014, 'presentation-bot': 3015,
            'documentation-bot': 3016, 'research-bot': 3017, 'devops-bot': 3018,
            'general-bot': 3019, 'agent-factory-bot': 3020, 'security-auditor-bot': 3021,
            'motivational-quotes-bot': 3022, 'daily-standup-summary-bot': 3023,
            'incident-response-bot': 3024, 'data-extraction-bot': 3025, 'email-bot': 3026,
            'video-bot': 3027, 'gcp-cli-bot': 3028, 'google-bot': 3029,
            'log-analyzer-bot': 3030, 'self-healing-bot': 3031, 'weather-bot': 3032,
            'facebook-bot': 3033, 'slack-bot': 3034, 'hephaestus': 3035,
            'news-aggregator-bot': 3036,
            // Dynamic bots self-register via AGENT_EXTERNAL_PORT — no hardcoding needed
          };

          const agentKeys = await redis.keys('queue-manager:agent:*');
          result.rawKeyStats.agentKeys = agentKeys.length;
          for (const key of agentKeys) {
            const data = await redis.get(key);
            const ttl = await redis.ttl(key);
            if (data) {
              try {
                const agent = JSON.parse(data);
                const agentId = agent.agent_id || key.replace('queue-manager:agent:', '');
                const caps = Array.isArray(agent.capabilities)
                  ? agent.capabilities
                  : (agent.capabilities ? JSON.parse(agent.capabilities) : []);
                // Port fallback: stored port → known map → extract from endpoint URL
                let port = agent.port ? parseInt(agent.port) : null;
                if (!port) port = KNOWN_AGENT_PORTS[agentId] || null;
                if (!port && agent.endpoint) {
                  // Try to extract from endpoint like "http://swarm-code-reviewer:5000"
                  // Map internal port 5000 to known external port via agent name
                  const nameMatch = agent.endpoint.match(/swarm-([^:]+):/);
                  if (nameMatch) port = KNOWN_AGENT_PORTS[nameMatch[1]] || null;
                }
                result.agentRegistry.push({
                  agent_id: agentId,
                  status: agent.status || 'unknown',
                  capabilities: caps,
                  current_load: agent.current_load || 0,
                  max_concurrent: agent.max_concurrent || 3,
                  port: port,
                  endpoint: agent.endpoint || null,
                  last_heartbeat: agent.last_heartbeat || null,
                  ttl_seconds: ttl,
                  enabled: agent.enabled !== false,
                  routing_keywords: agent.routing_keywords || [],
                  selector_descriptor: agent.selector_descriptor || null,
                });
              } catch (e) { /* skip unparseable */ }
            }
          }
          // Sort: idle first, then by agent_id
          result.agentRegistry.sort((a, b) => {
            if (a.status === 'idle' && b.status !== 'idle') return -1;
            if (a.status !== 'idle' && b.status === 'idle') return 1;
            return (a.agent_id || '').localeCompare(b.agent_id || '');
          });
        } catch (e) {
          result.agentRegistry = [];
          result.errors = result.errors || [];
          result.errors.push(`agentRegistry: ${e.message}`);
        }

        // ── 2. Scheduled Jobs ─────────────────────────────────
        // Schedules stored as agent-scheduler:schedule:{id} STRING keys (JSON)
        // BullMQ queue uses prefix agent-scheduler:agent-scheduler:*
        try {
          const scheduleKeys = await redis.keys('agent-scheduler:schedule:*');
          result.rawKeyStats.scheduleKeys = scheduleKeys.length;

          for (const key of scheduleKeys) {
            try {
              const data = await redis.get(key);
              if (!data) continue;
              const s = JSON.parse(data);
              // Build a short description from available fields
              const desc = s.description ||
                (s.taskData?.action ? `Action: ${s.taskData.action}` : null) ||
                (s.taskData?.prompt ? s.taskData.prompt.substring(0, 120) + '...' : null) ||
                null;
              result.scheduledJobs.push({
                id: s.scheduleId || key,
                name: s.name || s.taskType || s.scheduleId || 'unknown',
                description: desc,
                taskType: s.taskType || null,
                targetAgent: s.taskData?.targetAgent || null,
                queue: 'agent-scheduler',
                cron: s.pattern || s.cron || s.schedule || null,
                status: s.status || 'unknown',
                enabled: s.enabled !== false,
                createdAt: s.createdAt || null,
                lastExecution: s.lastExecution || null,
                nextExecution: s.nextExecution || null,
                executionCount: s.executionCount || 0,
              });
            } catch (e) { /* skip unparseable */ }
          }

          // Sort: active first, then by name
          result.scheduledJobs.sort((a, b) => {
            if (a.status === 'active' && b.status !== 'active') return -1;
            if (a.status !== 'active' && b.status === 'active') return 1;
            return (a.name || '').localeCompare(b.name || '');
          });

          // BullMQ queue counts — agent-scheduler uses prefix agent-scheduler:agent-scheduler:*
          const bullPrefixes = new Set();
          const allSchedulerKeys = await redis.keys('agent-scheduler:*');
          result.rawKeyStats.schedulerKeys = allSchedulerKeys.length;

          // Detect queue names from key patterns: {prefix}:{queueName}:{state}
          for (const k of allSchedulerKeys) {
            const parts = k.split(':');
            if (parts.length >= 3 && ['wait','active','completed','failed','delayed','repeat'].includes(parts[parts.length - 1])) {
              // queue name is everything between prefix and state
              const queueName = parts.slice(0, parts.length - 1).join(':');
              bullPrefixes.add(queueName);
            }
          }

          // Also scan bull:* keys for other queues
          const allBullKeys = await redis.keys('bull:*');
          const bullQueueNames = new Set();
          for (const k of allBullKeys) {
            const parts = k.split(':');
            if (parts.length >= 2) bullQueueNames.add(parts[1]);
          }

          // Get counts for agent-scheduler queue
          try {
            const waiting = await redis.llen('agent-scheduler:agent-scheduler:wait');
            const active = await redis.llen('agent-scheduler:agent-scheduler:active');
            const completed = await redis.zcard('agent-scheduler:agent-scheduler:completed');
            const failed = await redis.zcard('agent-scheduler:agent-scheduler:failed');
            const delayed = await redis.zcard('agent-scheduler:agent-scheduler:delayed');
            const repeatCount = (await redis.keys('agent-scheduler:agent-scheduler:repeat:*')).length;
            result.queueMetrics['agent-scheduler'] = { waiting, active, completed, failed, delayed, repeatJobs: repeatCount };
          } catch (e) { /* skip */ }

          // Get counts for health-checks queue
          try {
            const waiting = await redis.llen('health-checks:health-checks:wait');
            const active = await redis.llen('health-checks:health-checks:active');
            const completed = await redis.zcard('health-checks:health-checks:completed');
            const failed = await redis.zcard('health-checks:health-checks:failed');
            const delayed = await redis.zcard('health-checks:health-checks:delayed');
            const repeatCount = (await redis.keys('health-checks:health-checks:repeat:*')).length;
            result.queueMetrics['health-checks'] = { waiting, active, completed, failed, delayed, repeatJobs: repeatCount };
          } catch (e) { /* skip */ }

          // Get counts for standard bull:* queues
          for (const queueName of bullQueueNames) {
            try {
              const waiting = await redis.llen(`bull:${queueName}:wait`);
              const active = await redis.llen(`bull:${queueName}:active`);
              const completed = await redis.zcard(`bull:${queueName}:completed`);
              const failed = await redis.zcard(`bull:${queueName}:failed`);
              const delayed = await redis.zcard(`bull:${queueName}:delayed`);
              result.queueMetrics[queueName] = { waiting, active, completed, failed, delayed };
            } catch (e) { /* skip */ }
          }
        } catch (e) {
          result.errors = result.errors || [];
          result.errors.push(`scheduledJobs: ${e.message}`);
        }

        // ── 3. Routing Decisions (PHASE_14 ring buffer) ───────
        try {
          const routingData = await redis.lrange('qm:routing_decisions', 0, 49); // last 50
          result.rawKeyStats.routingDecisions = routingData.length;
          for (const item of routingData) {
            try {
              result.routingDecisions.push(JSON.parse(item));
            } catch (e) {
              result.routingDecisions.push({ raw: item });
            }
          }
        } catch (e) {
          result.errors = result.errors || [];
          result.errors.push(`routingDecisions: ${e.message}`);
        }

        // ── 4. Key namespace summary ───────────────────────────
        try {
          const allKeys = await redis.keys('*');
          const namespaces = {};
          for (const k of allKeys) {
            const ns = k.split(':')[0];
            namespaces[ns] = (namespaces[ns] || 0) + 1;
          }
          result.rawKeyStats.totalKeys = allKeys.length;
          result.rawKeyStats.namespaces = namespaces;
        } catch (e) { /* non-fatal */ }

        // ── 5. Active dispatches & ticket phases ──────────────
        try {
          const dispatchKeys = await redis.keys('qm:dispatching:*');
          const phaseKeys = await redis.keys('qm:ticket_phase:*');
          result.rawKeyStats.activeDispatches = dispatchKeys.length;
          result.rawKeyStats.ticketPhases = phaseKeys.length;
        } catch (e) { /* non-fatal */ }

        await redis.quit();
        res.json({ success: true, ...result });
      } catch (err) {
        res.status(500).json({ success: false, error: err.message });
      } finally {
        // Leak guard (2026-07-05): a thrown Redis command skipped the in-try quit() and the
        // abandoned client reconnected forever. disconnect() is a no-op after a clean quit.
        try { if (redis) redis.disconnect(); } catch (_) { /* already closed */ }
      }
    });

    // GET /api/qm/activity — Real-time Queue Manager activity from Redis (replaces Bull Board)
    application.app.get('/api/qm/activity', async (req, res) => {
      let redis = null;
      try {
        const Redis = require('ioredis');
        redis = new Redis({
          host: process.env.REDIS_HOST || 'oshal-redis',
          port: parseInt(process.env.REDIS_PORT || '6379'),
          password: process.env.REDIS_PASSWORD,
          maxRetriesPerRequest: 2,
        });

        // 1. Agent Registry — all registered agents with status
        const agents = buildAgentRegistry(await readQmKeyspace(redis, QM_KEY_PREFIXES.agent));

        // 2. Ticket Phases — all active ticket lifecycle states
        const phases = buildTicketRecords(await readQmKeyspace(redis, QM_KEY_PREFIXES.ticketPhase));

        // 3. Active Dispatches — tickets currently being processed
        const dispatches = buildTicketRecords(await readQmKeyspace(redis, QM_KEY_PREFIXES.dispatching));

        // 4. Ticket -> workspace-task bindings (qm:ticket_task:<ticketId> = taskId)
        const ticketTaskEntries = await readQmKeyspace(redis, QM_KEY_PREFIXES.ticketTask);

        // 5. Cooldowns (qm:processed:<ticketId>) and task locks (qm:task_lock:<taskId>)
        const cooldownEntries = await readQmKeyspace(redis, QM_KEY_PREFIXES.cooldown);
        const lockEntries = await readQmKeyspace(redis, QM_KEY_PREFIXES.taskLock);

        await redis.quit();

        const agentTicketMappings = buildAgentTicketMappings(phases, dispatches);
        logger.info(`[QM activity] agents=${Object.keys(agents).length} phases=${phases.length} dispatches=${dispatches.length} mappedAgents=${Object.keys(agentTicketMappings).length} cooldowns=${cooldownEntries.length} locks=${lockEntries.length}`);

        res.json({
          success: true,
          timestamp: new Date().toISOString(),
          agents, // Object with agentId as keys (matches health-dashboard.html expectations)
          ticketPhases: phases.reduce((acc, p) => { acc[p.ticketId] = p; return acc; }, {}),
          dispatches: dispatches.reduce((acc, d) => { acc[d.ticketId] = d; return acc; }, {}),
          agentTicketMappings,
          ticketTaskMappings: buildTicketTaskMappings(ticketTaskEntries),
          cooldowns: buildCooldowns(cooldownEntries),
          locks: buildTaskLocks(lockEntries),
        });
      } catch (err) {
        res.status(500).json({ success: false, error: err.message });
      } finally {
        // Leak guard (2026-07-05): same error-path client leak as /api/redis-visibility.
        try { if (redis) redis.disconnect(); } catch (_) { /* already closed */ }
      }
    });

    // POST /api/bot/restart — Restart a Docker container by name (for ops-dashboard)
    application.app.post('/api/bot/restart', async (req, res) => {
      const { container } = req.body;
      if (!container) {
        return res.status(400).json({ success: false, error: 'Missing container name' });
      }
      // Whitelist: only allow swarm containers to be restarted
      const allowed = ['swarm-project-manager', 'swarm-task-manager', 'swarm-worker-general',
        'swarm-code-reviewer', 'swarm-rca-specialist', 'swarm-presentation-bot',
        'swarm-documentation-bot', 'swarm-research-bot', 'swarm-devops-bot', 'swarm-general-bot',
        'oshal-any-bot'];
      if (!allowed.includes(container)) {
        return res.status(403).json({ success: false, error: 'Container not in allowed list' });
      }
      try {
        const { execSync } = require('child_process');
        execSync(`docker restart ${container}`, { timeout: 30000 });
        logger.info(`🔄 Container ${container} restarted via ops-dashboard`);
        res.json({ success: true, container, message: `${container} restarted` });
      } catch (err) {
        logger.error(`❌ Failed to restart ${container}: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
      }
    });

    application.app.get('/api/proxy-health', async (req, res) => {
      const targetUrl = req.query.url;
      if (!targetUrl) {
        return res.status(400).json({ error: 'url query parameter required' });
      }
      // Security: only allow localhost targets
      let resolvedUrl = targetUrl;
      try {
        const parsed = new URL(targetUrl);
        if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
          return res.status(403).json({ error: 'Only localhost targets allowed' });
        }
        // Inside Docker: translate localhost ports to Docker service names
        // Dynamic: if port not in map, default to host.docker.internal so
        // newly provisioned bots work without hardcoding every port
        const port = parseInt(parsed.port);
        const dockerHost = DOCKER_SERVICE_MAP[port] || 'host.docker.internal';
        if (dockerHost !== 'localhost') {
          parsed.hostname = dockerHost;
          resolvedUrl = parsed.toString();
        }
      } catch {
        return res.status(400).json({ error: 'Invalid URL' });
      }
      try {
        const http = require('http');
        const data = await new Promise((resolve, reject) => {
          const request = http.get(resolvedUrl, { timeout: 5000 }, (response) => {
            let body = '';
            response.on('data', chunk => body += chunk);
            response.on('end', () => {
              try {
                resolve({ status: response.statusCode, data: JSON.parse(body) });
              } catch {
                resolve({ status: response.statusCode, data: body });
              }
            });
          });
          request.on('error', reject);
          request.on('timeout', () => { request.destroy(); reject(new Error('timeout')); });
        });
        res.json({ success: true, ...data });
      } catch (err) {
        res.json({ success: false, error: err.message });
      }
    });

    // ════════════════════════════════════════════════════════
    // Dynamic Service Map & Health Dashboard Node Registration
    // Allows ComposeGenerator / agent-factory-bot to register newly deployed bots
    // so proxy-health and the health dashboard pick them up automatically.
    // ════════════════════════════════════════════════════════

    // Store reference so loadDynamicServiceMap can mutate it
    application._dockerServiceMap = DOCKER_SERVICE_MAP;

    // POST /api/service-map/register — Add a port→hostname entry at runtime
    application.app.post('/api/service-map/register', async (req, res) => {
      try {
        const { port, hostname } = req.body;
        if (!port || !hostname) {
          return res.status(400).json({ error: 'port and hostname are required' });
        }
        const portNum = parseInt(port);
        if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
          return res.status(400).json({ error: 'port must be a valid port number (1-65535)' });
        }
        // Update in-memory map
        DOCKER_SERVICE_MAP[portNum] = hostname;
        // Persist to Redis (if available)
        if (application.redisClient) {
          try {
            await application.redisClient.hset('docker-service-map:custom', String(portNum), hostname);
          } catch (redisErr) {
            logger.warn(`[ServiceMap] Redis persist failed: ${redisErr.message}`);
          }
        }
        logger.info(`[ServiceMap] Registered port ${portNum} → ${hostname}`);
        res.json({ success: true, port: portNum, hostname, totalEntries: Object.keys(DOCKER_SERVICE_MAP).length });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // GET /api/service-map — Return the current DOCKER_SERVICE_MAP
    application.app.get('/api/service-map', (req, res) => {
      res.json({ success: true, serviceMap: DOCKER_SERVICE_MAP, count: Object.keys(DOCKER_SERVICE_MAP).length });
    });

    // POST /api/health-dashboard/nodes — Register a new node for the health dashboard
    application.app.post('/api/health-dashboard/nodes', async (req, res) => {
      try {
        const { name, port, emoji, type, category } = req.body;
        if (!name || !port) {
          return res.status(400).json({ error: 'name and port are required' });
        }
        const node = {
          name: name,
          port: parseInt(port),
          emoji: emoji || '🤖',
          type: type || 'agent',
          category: category || 'Factory-Deployed',
          registeredAt: new Date().toISOString(),
        };
        if (application.redisClient) {
          try {
            const existing = await application.redisClient.get('health-dashboard:dynamic-nodes');
            let nodes = existing ? JSON.parse(existing) : [];
            // Deduplicate by port AND by name (re-deploys get new ports but same name)
            nodes = nodes.filter(n => n.port !== node.port && n.name !== node.name);
            nodes.push(node);
            // ⭐ PHASE_61 Defect #2: Add 24h TTL so stale entries auto-expire
            await application.redisClient.set('health-dashboard:dynamic-nodes', JSON.stringify(nodes), 'EX', 86400);
            logger.info(`[HealthDashboard] Registered dynamic node: ${name} (port ${node.port})`);
            res.json({ success: true, node, totalNodes: nodes.length });
          } catch (redisErr) {
            logger.warn(`[HealthDashboard] Redis error: ${redisErr.message}`);
            res.status(500).json({ error: redisErr.message });
          }
        } else {
          // No Redis — store in memory as fallback
          if (!application._dynamicDashboardNodes) application._dynamicDashboardNodes = [];
          application._dynamicDashboardNodes = application._dynamicDashboardNodes.filter(n => n.port !== node.port);
          application._dynamicDashboardNodes.push(node);
          logger.info(`[HealthDashboard] Registered dynamic node (in-memory): ${name} (port ${node.port})`);
          res.json({ success: true, node, totalNodes: application._dynamicDashboardNodes.length });
        }
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // GET /api/health-dashboard/nodes — List dynamically registered dashboard nodes
    // ⭐ FIX: Deduplicate by agent name — keep only the latest port per agent
    application.app.get('/api/health-dashboard/nodes', async (req, res) => {
      try {
        let nodes = [];
        if (application.redisClient) {
          try {
            // 1. Read manually registered dynamic nodes
            const existing = await application.redisClient.get('health-dashboard:dynamic-nodes');
            const dynamicNodes = existing ? JSON.parse(existing) : [];
            
            // 2. Scan AgentRegistry keys — every bot auto-registers here via AgentBootstrap
            const registryKeys = await application.redisClient.keys('queue-manager:agent:*');
            
            for (const key of registryKeys) {
              try {
                // AgentRegistry may use string OR hash type depending on registration path
                const keyType = await application.redisClient.type(key);
                let agent = null;
                
                if (keyType === 'hash') {
                  agent = await application.redisClient.hgetall(key);
                } else if (keyType === 'string') {
                  const raw = await application.redisClient.get(key);
                  if (raw) agent = JSON.parse(raw);
                }
                
                if (!agent || !agent.agent_id) continue;
                
                // Extract port from endpoint URL (e.g., "http://swarm-bot:5000" → need external port)
                const agentCaps = Array.isArray(agent.capabilities) 
                  ? agent.capabilities 
                  : (agent.capabilities ? JSON.parse(agent.capabilities) : []);
                
                // Use the port from the agent's external endpoint if available
                const agentPort = agent.port ? parseInt(agent.port) : null;
                
                if (agentPort) {
                  dynamicNodes.push({
                    name: `swarm-${agent.agent_id}`,
                    port: agentPort,
                    emoji: '🤖',
                    type: 'agent',
                    category: 'agent',
                    capabilities: agentCaps,
                    source: 'agent-registry',
                    links: [
                      { label: '🏠 UI', url: `http://localhost:${agentPort}` },
                      { label: '📊 Dashboard', url: `http://localhost:${agentPort}/dashboard` },
                    ],
                  });
                }
              } catch (parseErr) {
                // Skip unparseable entries
              }
            }
            
            // ⭐ DEDUP: Keep only the LATEST entry per agent name (highest port or most recent)
            const deduped = new Map();
            for (const node of dynamicNodes) {
              const existing = deduped.get(node.name);
              if (!existing || (node.registeredAt && (!existing.registeredAt || node.registeredAt > existing.registeredAt))) {
                deduped.set(node.name, node);
              }
            }
            nodes = Array.from(deduped.values());
            
          } catch (redisErr) {
            logger.warn(`[HealthDashboard] Redis read error: ${redisErr.message}`);
          }
        } else if (application._dynamicDashboardNodes) {
          nodes = application._dynamicDashboardNodes;
        }
        res.json({ success: true, nodes, count: nodes.length });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Runtime test execution is deliberately unavailable on a deployed bot. Tests run in the
    // protected CI workflow, where the checkout, environment, and actor are independently gated.
    application.app.post('/api/run-tests', (_req, res) => {
      res.status(410).json({ error: 'runtime_test_execution_retired', use: 'protected_ci' });
    });
    application.app.get('/api/test-files', (_req, res) => {
      res.status(410).json({ error: 'runtime_test_execution_retired', use: 'protected_ci' });
    });
}

module.exports = {
  registerOpsObservabilityRoutes,
  // Exported for the regression guard (tests/unit/qm-activity-maps.spec.ts): these are the
  // functions that turn live Redis state into the three maps /api/qm/activity used to hardcode
  // as empty objects, so the guard exercises the real mapping logic, not a substring of it.
  readQmKeyspace,
  buildAgentRegistry,
  buildTicketRecords,
  buildAgentTicketMappings,
  buildTicketTaskMappings,
  buildCooldowns,
  buildTaskLocks,
  QM_KEY_PREFIXES,
};
