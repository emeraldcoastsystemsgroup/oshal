/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * SelfHealingScheduler — Autonomous Container Health Monitor
 * 
 * ⭐ PHASE_61 Backlog #1: Self-Healing Bot Autonomous Scheduling Loop
 * 
 * Runs on self-healing-bot only (AGENT_ID === 'self-healing-bot').
 * Proactively monitors containers and creates Plane tickets for issues found.
 * 
 * Features:
 * - Container health check every 5 minutes (configurable)
 * - Error log scanning for FATAL/ERROR patterns
 * - Auto-restart unhealthy containers (if AUTO_RESTART_ENABLED=true)
 * - Creates Plane tickets for new critical errors
 * - Deduplication: won't create duplicate tickets for same issue
 */

const logger = require('../utils/logger');

/**
 * @description Autonomous health-monitoring scheduler intended to keep the swarm
 * self-sustaining without operator babysitting. It exists so the
 * `self-healing-bot` agent can proactively detect failing containers and error
 * conditions, optionally remediate them by restarting, and surface anything it
 * cannot fix on its own as Plane tickets — turning silent failures into tracked,
 * actionable work items.
 */
class SelfHealingScheduler {
  /**
   * @description Wires up the scheduler's collaborators and runtime tuning so a
   * single instance can be constructed with sensible defaults yet still be
   * overridden for testing or alternate deployments. Reads interval and
   * auto-restart behavior from the environment so operators can tune cadence and
   * remediation aggressiveness without code changes.
   * @param {Object} [options={}] - Optional overrides for injected clients and identity.
   * @param {string} [options.agentId] - Agent identity gating this loop to the self-healing bot.
   * @param {Object} [options.dockerClient] - Docker client collaborator (optional).
   * @param {Object} [options.planeClient] - Plane API client used to file tickets for issues.
   * @param {Object} [options.redisClient] - Redis client collaborator (optional).
   */
  constructor(options = {}) {
    this.agentId = options.agentId || process.env.AGENT_ID || 'self-healing-bot';
    this.dockerClient = options.dockerClient || null;
    this.planeClient = options.planeClient || null;
    this.redisClient = options.redisClient || null;
    this.interval = parseInt(process.env.SELF_HEALING_INTERVAL_MS || '300000'); // 5 min default
    this.autoRestart = process.env.AUTO_RESTART_ENABLED === 'true';
    this._timer = null;
    this._running = false;
    this._seenIssues = new Set(); // In-memory dedup for this session
    
    logger.info(`[SelfHealingScheduler] Initialized (interval: ${this.interval}ms, autoRestart: ${this.autoRestart})`);
  }

  /**
   * Start the autonomous monitoring loop
   */
  start() {
    if (this._running) {
      logger.warn('[SelfHealingScheduler] Already running');
      return;
    }
    
    this._running = true;
    logger.info(`[SelfHealingScheduler] ✅ Starting autonomous monitoring loop (every ${this.interval / 1000}s)`);
    
    // Run immediately on start, then on interval
    this._runCycle().catch(err => logger.error(`[SelfHealingScheduler] Initial cycle error: ${err.message}`));
    
    this._timer = setInterval(async () => {
      try {
        await this._runCycle();
      } catch (err) {
        logger.error(`[SelfHealingScheduler] Cycle error: ${err.message}`);
      }
    }, this.interval);
  }

  /**
   * Stop the monitoring loop
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._running = false;
    logger.info('[SelfHealingScheduler] Stopped');
  }

  /**
   * Run one monitoring cycle
   * @private
   */
  async _runCycle() {
    logger.info('[SelfHealingScheduler] 🔍 Running health check cycle...');
    
    const results = {
      containersChecked: 0,
      unhealthyContainers: [],
      restarted: [],
      errorsFound: [],
      ticketsCreated: [],
    };

    try {
      await this.checkContainerHealth(results);
    } catch (err) {
      logger.warn(`[SelfHealingScheduler] Container health check failed: ${err.message}`);
    }

    try {
      await this.scanErrorLogs(results);
    } catch (err) {
      logger.warn(`[SelfHealingScheduler] Error log scan failed: ${err.message}`);
    }

    logger.info(`[SelfHealingScheduler] Cycle complete: ${results.containersChecked} containers checked, ${results.unhealthyContainers.length} unhealthy, ${results.ticketsCreated.length} tickets created`);
    return results;
  }

  /**
   * Check container health via docker ps
   * @param {Object} results - Results accumulator
   */
  async checkContainerHealth(results) {
    const { execSync } = require('child_process');
    
    try {
      // Get all swarm containers
      const output = execSync(
        'docker ps -a --filter "name=swarm-" --format "{{.Names}}\\t{{.Status}}\\t{{.State}}"',
        { timeout: 15000, encoding: 'utf8' }
      );
      
      const lines = output.trim().split('\n').filter(Boolean);
      results.containersChecked = lines.length;
      
      for (const line of lines) {
        const [name, status, state] = line.split('\t');
        if (!name) continue;
        
        const isUnhealthy = state === 'exited' || 
                           (status && status.toLowerCase().includes('unhealthy')) ||
                           (status && status.toLowerCase().includes('restarting'));
        
        if (isUnhealthy) {
          results.unhealthyContainers.push({ name, status, state });
          logger.warn(`[SelfHealingScheduler] ⚠️ Unhealthy container: ${name} (${state}: ${status})`);
          
          // Auto-restart if enabled
          if (this.autoRestart && state === 'exited') {
            try {
              execSync(`docker restart ${name}`, { timeout: 30000 });
              results.restarted.push(name);
              logger.info(`[SelfHealingScheduler] ✅ Auto-restarted: ${name}`);
            } catch (restartErr) {
              logger.error(`[SelfHealingScheduler] Failed to restart ${name}: ${restartErr.message}`);
            }
          }
          
          // Create Plane ticket for unhealthy container
          const issueKey = `container-unhealthy:${name}`;
          if (!this._seenIssues.has(issueKey)) {
            this._seenIssues.add(issueKey);
            await this._createPlaneTicket(
              `🚨 Container Unhealthy: ${name}`,
              `Container **${name}** is in state: **${state}**\n\nStatus: ${status}\n\n${this.autoRestart ? '✅ Auto-restart attempted.' : '⚠️ Auto-restart disabled. Manual intervention required.'}`,
              'urgent',
              results
            );
          }
        }
      }
    } catch (err) {
      // Docker not available (e.g., running in container without socket)
      logger.debug(`[SelfHealingScheduler] Docker check skipped: ${err.message}`);
    }
  }

  /**
   * Scan recent container logs for FATAL/ERROR patterns
   * @param {Object} results - Results accumulator
   */
  async scanErrorLogs(results) {
    const { execSync } = require('child_process');
    
    // Swarm containers to scan
    const containers = [
      'swarm-project-manager', 'swarm-task-manager', 'swarm-worker-general',
      'swarm-code-reviewer', 'swarm-rca-specialist', 'swarm-presentation-bot',
      'swarm-documentation-bot', 'swarm-research-bot', 'swarm-devops-bot',
      'swarm-general-bot', 'swarm-agent-factory-bot', 'swarm-security-auditor-bot',
    ];
    
    const errorPatterns = [
      /FATAL/i,
      /CrashLoopBackOff/i,
      /OOMKilled/i,
      /panic:/i,
      /Segmentation fault/i,
      /ECONNREFUSED.*redis/i,
      /Cannot connect to database/i,
    ];
    
    for (const container of containers) {
      try {
        // Get last 50 lines of logs from the past 5 minutes
        const logs = execSync(
          `docker logs --since 5m --tail 50 ${container} 2>&1`,
          { timeout: 10000, encoding: 'utf8' }
        );
        
        for (const pattern of errorPatterns) {
          if (pattern.test(logs)) {
            const matchedLine = logs.split('\n').find(l => pattern.test(l)) || '';
            const issueKey = `log-error:${container}:${pattern.source}`;
            
            if (!this._seenIssues.has(issueKey)) {
              this._seenIssues.add(issueKey);
              results.errorsFound.push({ container, pattern: pattern.source, line: matchedLine });
              
              logger.warn(`[SelfHealingScheduler] 🔴 Error pattern found in ${container}: ${matchedLine.substring(0, 100)}`);
              
              await this._createPlaneTicket(
                `🔴 Error Pattern in ${container}: ${pattern.source}`,
                `Container **${container}** has critical error pattern in logs:\n\n\`\`\`\n${matchedLine.substring(0, 500)}\n\`\`\`\n\nPattern: \`${pattern.source}\`\n\nPlease investigate and remediate.`,
                'high',
                results
              );
            }
          }
        }
      } catch (err) {
        // Container not running or docker not available
        logger.debug(`[SelfHealingScheduler] Log scan skipped for ${container}: ${err.message}`);
      }
    }
  }

  /**
   * Create a Plane ticket for an issue
   * @private
   */
  async _createPlaneTicket(title, description, priority, results) {
    try {
      if (!this.planeClient) {
        logger.info(`[SelfHealingScheduler] Would create ticket: "${title}" (Plane client not configured)`);
        return;
      }
      
      // Use Plane API to create ticket
      const ticket = await this.planeClient.createIssue({
        name: title,
        description_html: `<p>${description.replace(/\n/g, '<br>')}</p>`,
        priority: priority || 'high',
        label_ids: [],
      });
      
      results.ticketsCreated.push({ title, ticketId: ticket.id });
      logger.info(`[SelfHealingScheduler] ✅ Created Plane ticket: ${ticket.id} — "${title}"`);
    } catch (err) {
      logger.warn(`[SelfHealingScheduler] Failed to create Plane ticket: ${err.message}`);
    }
  }

  /**
   * Get current scheduler status
   */
  getStatus() {
    return {
      running: this._running,
      interval: this.interval,
      autoRestart: this.autoRestart,
      seenIssues: this._seenIssues.size,
    };
  }
}

module.exports = SelfHealingScheduler;
