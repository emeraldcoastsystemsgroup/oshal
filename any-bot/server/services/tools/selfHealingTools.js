/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * Self-Healing Bot Tools — Infrastructure remediation tool implementations
 * 
 * Provides Docker container health checking, restart, and log scanning capabilities.
 * These tools are registered via AGENT_MCP_TOOLS in the provision manifest and
 * auto-discovered by the dynamic tool scanner in app.js (PHASE_16).
 * 
 * Date: 2026-02-18
 */

const { execSync } = require('child_process');
const logger = require('../../utils/logger');

/**
 * Check Docker container health status.
 * Returns container state, health status, uptime, and recent restart count.
 * 
 * @param {Object} params - { container_name?: string, all?: boolean }
 * @returns {Object} Health check results
 */
async function checkContainerHealth(params = {}) {
  const { container_name, all } = params;

  try {
    if (container_name) {
      // Check specific container
      const result = _inspectContainer(container_name);
      return {
        success: true,
        container: container_name,
        ...result,
      };
    }

    if (all) {
      // Check all swarm containers
      const containers = _listSwarmContainers();
      const results = containers.map(name => ({
        container: name,
        ..._inspectContainer(name),
      }));

      const healthy = results.filter(r => r.status === 'running' && r.health === 'healthy').length;
      const unhealthy = results.filter(r => r.health === 'unhealthy' || r.status !== 'running').length;

      return {
        success: true,
        summary: {
          total: results.length,
          healthy,
          unhealthy,
          degraded: results.length - healthy - unhealthy,
        },
        containers: results,
      };
    }

    // Default: check all swarm containers
    return await checkContainerHealth({ all: true });

  } catch (error) {
    return {
      success: false,
      error: error.message,
      container: container_name || 'all',
    };
  }
}

/**
 * Restart a Docker container.
 * Only allows restarting containers in the swarm whitelist.
 * 
 * @param {Object} params - { container_name: string, force?: boolean }
 * @returns {Object} Restart result
 */
async function restartContainer(params = {}) {
  const { container_name, force } = params;

  if (!container_name) {
    return { success: false, error: 'container_name is required' };
  }

  // Security: only allow swarm containers
  const ALLOWED_PREFIXES = ['swarm-', 'oshal-'];
  const isAllowed = ALLOWED_PREFIXES.some(p => container_name.startsWith(p));
  if (!isAllowed) {
    return {
      success: false,
      error: `Container ${container_name} is not in the allowed restart list. Only swarm-* and oshal-* containers can be restarted.`,
    };
  }

  try {
    // Check current state before restart
    const beforeState = _inspectContainer(container_name);
    logger.info(`[SelfHealing] Restarting ${container_name} (current state: ${beforeState.status}, health: ${beforeState.health})`);

    // Perform restart
    const cmd = force
      ? `docker restart -t 5 ${container_name}`
      : `docker restart ${container_name}`;

    execSync(cmd, { encoding: 'utf8', timeout: 30000 });

    // Wait for container to come back
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Check state after restart
    const afterState = _inspectContainer(container_name);

    logger.info(`[SelfHealing] ✅ ${container_name} restarted (new state: ${afterState.status}, health: ${afterState.health})`);

    return {
      success: true,
      container: container_name,
      before: beforeState,
      after: afterState,
      action: force ? 'force-restart' : 'restart',
      timestamp: new Date().toISOString(),
    };

  } catch (error) {
    logger.error(`[SelfHealing] ❌ Failed to restart ${container_name}: ${error.message}`);
    return {
      success: false,
      container: container_name,
      error: error.message,
    };
  }
}

/**
 * Scan Docker logs for recent errors and categorize them.
 * Analyzes the last N lines of container logs for known error patterns.
 * 
 * @param {Object} params - { container_name?: string, tail?: number, since?: string }
 * @returns {Object} Log scan results with categorized errors
 */
async function scanErrorLogs(params = {}) {
  const { container_name, tail = 200, since } = params;

  try {
    const containers = container_name
      ? [container_name]
      : _listSwarmContainers();

    const results = [];

    for (const name of containers) {
      try {
        let cmd = `docker logs --tail ${tail}`;
        if (since) cmd += ` --since ${since}`;
        cmd += ` ${name} 2>&1`;

        const logs = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
        const lines = logs.split('\n').filter(l => l.trim());

        // Categorize errors
        const errors = [];
        const warnings = [];
        const criticals = [];

        const ERROR_PATTERNS = [
          { pattern: /ECONNREFUSED/i, category: 'connection', severity: 'high', description: 'Service connection refused' },
          { pattern: /ETIMEDOUT/i, category: 'timeout', severity: 'high', description: 'Connection timed out' },
          { pattern: /MCP.*timeout/i, category: 'mcp-timeout', severity: 'medium', description: 'MCP server initialization timeout' },
          { pattern: /AgentMemory.*failed/i, category: 'chromadb', severity: 'medium', description: 'AgentMemory/ChromaDB initialization failure' },
          { pattern: /fetch failed/i, category: 'network', severity: 'high', description: 'Network fetch failure' },
          { pattern: /redis.*error/i, category: 'redis', severity: 'critical', description: 'Redis connection error' },
          { pattern: /database.*error|postgres.*error/i, category: 'database', severity: 'critical', description: 'Database connection error' },
          { pattern: /OOMKilled|out of memory/i, category: 'memory', severity: 'critical', description: 'Out of memory' },
          { pattern: /SIGKILL|SIGTERM/i, category: 'signal', severity: 'high', description: 'Process killed by signal' },
          { pattern: /CrashLoopBackOff/i, category: 'crash-loop', severity: 'critical', description: 'Container in crash loop' },
          { pattern: /permission denied/i, category: 'permissions', severity: 'medium', description: 'Permission denied' },
          { pattern: /healthcheck.*failed|unhealthy/i, category: 'health', severity: 'high', description: 'Health check failure' },
        ];

        for (const line of lines) {
          for (const { pattern, category, severity, description } of ERROR_PATTERNS) {
            if (pattern.test(line)) {
              const entry = {
                category,
                severity,
                description,
                line: line.substring(0, 300),
                container: name,
              };

              if (severity === 'critical') criticals.push(entry);
              else if (severity === 'high') errors.push(entry);
              else warnings.push(entry);

              break; // Only match first pattern per line
            }
          }
        }

        results.push({
          container: name,
          totalLines: lines.length,
          criticals: criticals.filter(e => e.container === name),
          errors: errors.filter(e => e.container === name),
          warnings: warnings.filter(e => e.container === name),
        });

      } catch (logErr) {
        results.push({
          container: name,
          error: logErr.message,
          totalLines: 0,
          criticals: [],
          errors: [],
          warnings: [],
        });
      }
    }

    // Build summary
    const totalCriticals = results.reduce((sum, r) => sum + r.criticals.length, 0);
    const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);
    const totalWarnings = results.reduce((sum, r) => sum + r.warnings.length, 0);

    return {
      success: true,
      summary: {
        containersScanned: results.length,
        criticals: totalCriticals,
        errors: totalErrors,
        warnings: totalWarnings,
        overallHealth: totalCriticals > 0 ? 'CRITICAL' : totalErrors > 0 ? 'DEGRADED' : 'HEALTHY',
      },
      containers: results,
      timestamp: new Date().toISOString(),
    };

  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}

// ──────────────────────────────────────────────────────────────
// Private helpers
// ──────────────────────────────────────────────────────────────

/**
 * Inspect a single Docker container and return structured status.
 */
function _inspectContainer(name) {
  try {
    const format = '{{.State.Status}}|{{.State.Health.Status}}|{{.State.StartedAt}}|{{.State.RestartCount}}|{{.Config.Image}}';
    const output = execSync(
      `docker inspect --format '${format}' ${name} 2>/dev/null`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();

    const [status, health, startedAt, restartCount, image] = output.split('|');

    // Calculate uptime
    const startTime = new Date(startedAt);
    const uptimeMs = Date.now() - startTime.getTime();
    const uptimeMinutes = Math.floor(uptimeMs / 60000);

    return {
      status: status || 'unknown',
      health: health || 'none',
      startedAt: startedAt || 'unknown',
      uptimeMinutes,
      restartCount: parseInt(restartCount) || 0,
      image: image || 'unknown',
    };
  } catch (error) {
    return {
      status: 'not-found',
      health: 'unknown',
      error: error.message,
      uptimeMinutes: 0,
      restartCount: 0,
    };
  }
}

/**
 * List all swarm-related Docker containers.
 */
function _listSwarmContainers() {
  try {
    const output = execSync(
      'docker ps -a --format "{{.Names}}" --filter "name=swarm-" --filter "name=oshal-" 2>/dev/null',
      { encoding: 'utf8', timeout: 5000 }
    ).trim();

    return output.split('\n').filter(name => name.trim());
  } catch (error) {
    return [];
  }
}

// Export tool handlers with names matching the MCP tool definitions
/**
 * @description Public tool-handler surface for the self-healing bot. Keyed by the
 * exact MCP tool names so the dynamic tool scanner can bind each invocation to its
 * implementation; intended as the sole entry point consumed by the provision manifest.
 */
module.exports = {
  'check-container-health': checkContainerHealth,
  'restart-container': restartContainer,
  'scan-error-logs': scanErrorLogs,
};
